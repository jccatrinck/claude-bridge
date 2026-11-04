// Hub / relay election, WebSocket routing by profile, request ids and timeouts.
//
// The first bridge process to bind 127.0.0.1:<port> is the hub: extensions and other
// bridge processes ("relays") connect to it. A relay forwards its tool calls to the hub.
// When the hub goes away, every relay races to bind the port; the winner becomes the new hub
// and the others reconnect to it. Extensions reconnect on their own with backoff.

import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import http from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import { checkUploadPaths } from "./upload.mjs";
import {
  BridgeError,
  DEFAULT_PORT,
  HELLO_TIMEOUT_MS,
  PROTOCOL_VERSION,
  errorResponse,
  normaliseSettings,
  okResponse,
  parseMessage,
  resolveProfile,
} from "./protocol.mjs";

const HEARTBEAT_MS = 30_000;
const DEFAULT_TIMEOUT_MS = 45_000;
// Tools whose extension side can legitimately run long.
const TOOL_TIMEOUT_MS = { navigate: 40_000, upload: 120_000, screenshot: 30_000 };

function sameToken(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

const send = (ws, msg) => {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
};

export class Bridge extends EventEmitter {
  /**
   * @param {object} o
   * @param {number} [o.port]
   * @param {string} [o.host]
   * @param {string} o.token            pairing token
   * @param {string[]} [o.allowedOrigins] browser origins allowed to connect (non-browser clients send none)
   * @param {number} [o.timeoutMs]      default per-request timeout
   * @param {(msg: string) => void} [o.log]
   */
  constructor({ port = DEFAULT_PORT, host = "127.0.0.1", token, allowedOrigins = [], timeoutMs, log } = {}) {
    super();
    if (!token) throw new Error("Bridge needs a pairing token");
    this.port = port;
    this.host = host;
    this.token = token;
    this.allowedOrigins = allowedOrigins;
    this.timeoutMs = timeoutMs;
    this.log = log ?? (() => {});
    this.role = null; // "hub" | "relay" | null while electing
    this.closed = false;
    this._seq = 0;
    this._ready = null;
    this._markReady = null;
    this._resetReady();
    // hub state
    this.server = null;
    this.wss = null;
    this.profiles = new Map(); // profileName → { ws, profileId, profileName, version, settings, pending: Map }
    this.relays = new Set();
    // relay state
    this.upstream = null;
    this.upstreamPending = new Map();
  }

  _resetReady() {
    this._ready = new Promise((resolve) => (this._markReady = resolve));
  }

  _id() {
    return `${process.pid}-${++this._seq}`;
  }

  _timeoutFor(tool) {
    return this.timeoutMs ?? TOOL_TIMEOUT_MS[tool] ?? DEFAULT_TIMEOUT_MS;
  }

  async start() {
    this._elect();
    await this._ready;
    return this;
  }

  /** Wait until this process is hub or relay (or give up). */
  async ready(ms = 10_000) {
    let t;
    const timeout = new Promise((_, reject) => {
      t = setTimeout(() => reject(new BridgeError("hub_unavailable", `Could not reach or become the hub on ${this.host}:${this.port}.`)), ms);
    });
    try {
      await Promise.race([this._ready, timeout]);
    } finally {
      clearTimeout(t);
    }
  }

  async _elect() {
    let attempt = 0;
    while (!this.closed && !this.role) {
      try {
        await this._listen();
        this.role = "hub";
        this.log(`hub listening on ${this.host}:${this.port}`);
        this.emit("role", "hub");
        this._markReady();
        return;
      } catch (e) {
        if (e.code !== "EADDRINUSE") this.log(`listen failed: ${e.message}`);
      }
      if (this.closed) return;
      try {
        await this._connectUpstream();
        this.role = "relay";
        this.log(`relay connected to hub ${this.host}:${this.port}`);
        this.emit("role", "relay");
        this._markReady();
        return;
      } catch (e) {
        if (e instanceof BridgeError && e.code === "refused") {
          this.log(`hub refused this relay: ${e.message}`);
        }
      }
      attempt++;
      // Jitter so racing relays don't collide forever.
      await new Promise((r) => setTimeout(r, Math.min(2000, 50 * attempt) + Math.random() * 200));
    }
  }

  // ───────────────────────── hub side ─────────────────────────

  _listen() {
    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => {
        res.writeHead(426, { "content-type": "text/plain" });
        res.end("claude-bridge hub: WebSocket only\n");
      });
      const onError = (e) => {
        server.close();
        reject(e);
      };
      server.once("error", onError);
      server.listen(this.port, this.host, () => {
        server.off("error", onError);
        server.on("error", (e) => this.log(`hub server error: ${e.message}`));
        const wss = new WebSocketServer({
          server,
          maxPayload: 64 * 1024 * 1024,
          verifyClient: (info, cb) => {
            const origin = info.origin || info.req.headers.origin;
            // Browsers always send Origin. Only our extension's origin may connect; random pages may not.
            if (origin && !this.allowedOrigins.includes(origin)) {
              this.log(`refused socket from origin ${origin}`);
              return cb(false, 403, "Origin not allowed");
            }
            cb(true);
          },
        });
        this.server = server;
        this.wss = wss;
        wss.on("connection", (ws) => this._onPeer(ws));
        wss.on("error", (e) => this.log(`hub socket error: ${e.message}`));
        this._heartbeat = setInterval(() => this._beat(), HEARTBEAT_MS);
        this._heartbeat.unref?.();
        resolve();
      });
    });
  }

  _beat() {
    for (const ws of this.wss?.clients ?? []) {
      if (ws._alive === false) {
        ws.terminate();
        continue;
      }
      ws._alive = false;
      ws.ping();
    }
  }

  _onPeer(ws) {
    ws._alive = true;
    ws.on("pong", () => (ws._alive = true));
    let peer = null; // { kind: "extension", entry } | { kind: "relay" }
    const helloTimer = setTimeout(() => {
      if (!peer) {
        send(ws, { type: "refused", reason: "no hello received" });
        ws.close(4000, "no hello");
      }
    }, HELLO_TIMEOUT_MS);

    ws.on("message", (raw) => {
      ws._alive = true;
      let msg;
      try {
        msg = parseMessage(raw);
      } catch (e) {
        this.log(`bad message from peer: ${e.message}`);
        if (!peer) ws.close(4002, "bad message");
        return;
      }
      if (!peer) {
        if (msg.type !== "hello") {
          send(ws, { type: "refused", reason: "expected hello" });
          return ws.close(4002, "expected hello");
        }
        clearTimeout(helloTimer);
        if (!sameToken(msg.token, this.token)) {
          send(ws, { type: "refused", reason: "bad pairing token" });
          return ws.close(4001, "bad token");
        }
        if (msg.role === "relay") {
          peer = { kind: "relay" };
          this.relays.add(ws);
          send(ws, { type: "welcome", role: "hub", version: PROTOCOL_VERSION });
          return;
        }
        const existing = this.profiles.get(msg.profileName);
        if (existing && existing.profileId !== msg.profileId) {
          send(ws, {
            type: "refused",
            reason: `profile name "${msg.profileName}" is already used by another connected Chrome profile; pick a different name in the extension options`,
          });
          return ws.close(4003, "name taken");
        }
        if (existing) this._dropExtension(existing, "replaced by a newer connection");
        const entry = {
          ws,
          profileId: msg.profileId,
          profileName: msg.profileName,
          version: msg.version,
          settings: normaliseSettings(msg.settings),
          pending: new Map(),
        };
        this.profiles.set(entry.profileName, entry);
        peer = { kind: "extension", entry };
        send(ws, { type: "welcome", role: "hub", version: PROTOCOL_VERSION });
        this.log(`profile "${entry.profileName}" connected`);
        this.emit("profile", entry.profileName);
        return;
      }

      if (msg.type === "ping") return send(ws, { type: "pong" });
      if (msg.type === "pong") return;

      if (peer.kind === "extension" && msg.type === "response") {
        const p = peer.entry.pending.get(msg.id);
        if (!p) return;
        peer.entry.pending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.ok) p.resolve(msg.result);
        else p.reject(new BridgeError(msg.error.code ?? "error", msg.error.message));
        return;
      }
      if (peer.kind === "relay" && msg.type === "request") {
        this._dispatch(msg.tool, msg.args ?? {}, msg.profile ?? undefined).then(
          (result) => send(ws, okResponse(msg.id, result)),
          (err) => send(ws, errorResponse(msg.id, err)),
        );
      }
    });

    ws.on("close", () => {
      clearTimeout(helloTimer);
      if (!peer) return;
      if (peer.kind === "relay") this.relays.delete(ws);
      else if (this.profiles.get(peer.entry.profileName) === peer.entry) this._dropExtension(peer.entry, "disconnected");
    });
    ws.on("error", () => {});
  }

  _dropExtension(entry, why) {
    if (this.profiles.get(entry.profileName) === entry) this.profiles.delete(entry.profileName);
    for (const p of entry.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new BridgeError("profile_disconnected", `Chrome profile "${entry.profileName}" ${why} before answering.`));
    }
    entry.pending.clear();
    if (entry.ws.readyState === WebSocket.OPEN) entry.ws.close(4004, why);
    this.log(`profile "${entry.profileName}" ${why}`);
  }

  _ask(entry, tool, args, timeoutMs = this._timeoutFor(tool)) {
    return new Promise((resolve, reject) => {
      const id = this._id();
      const timer = setTimeout(() => {
        entry.pending.delete(id);
        reject(new BridgeError("timeout", `"${tool}" got no answer from profile "${entry.profileName}" within ${Math.round(timeoutMs / 1000)} s.`));
      }, timeoutMs);
      entry.pending.set(id, { resolve, reject, timer });
      send(entry.ws, { type: "request", id, tool, args });
    });
  }

  async _dispatch(tool, args, profile) {
    if (tool === "list_profiles") {
      const entries = [...this.profiles.values()];
      return Promise.all(
        entries.map(async (e) => {
          let tabCount = null;
          try {
            tabCount = (await this._ask(e, "_info", {}, 3000)).tabCount ?? null;
          } catch {
            // report the profile even if it is slow to answer
          }
          return { name: e.profileName, id: e.profileId, version: e.version, tabCount };
        }),
      );
    }
    const entry = resolveProfile([...this.profiles.values()], profile);
    if (tool === "upload") {
      const files = await checkUploadPaths(args.paths, entry.settings.uploadRoots);
      const result = await this._ask(entry, tool, { ...args, paths: files.map((f) => f.path) });
      return { ...(result ?? {}), files };
    }
    return this._ask(entry, tool, args);
  }

  // ───────────────────────── relay side ─────────────────────────

  _connectUpstream() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://${this.host}:${this.port}`, { handshakeTimeout: 3000, maxPayload: 64 * 1024 * 1024 });
      let welcomed = false;
      const fail = (e) => {
        if (welcomed) return;
        welcomed = true; // settle once
        try {
          ws.terminate();
        } catch {}
        reject(e);
      };
      const helloTimer = setTimeout(() => fail(new BridgeError("timeout", "hub did not welcome us")), HELLO_TIMEOUT_MS);
      ws.on("open", () => send(ws, { type: "hello", role: "relay", token: this.token }));
      ws.on("error", (e) => {
        clearTimeout(helloTimer);
        fail(e);
      });
      ws.on("message", (raw) => {
        let msg;
        try {
          msg = parseMessage(raw);
        } catch {
          return;
        }
        if (!welcomed) {
          clearTimeout(helloTimer);
          if (msg.type === "welcome") {
            welcomed = true;
            this.upstream = ws;
            this._upstreamPing = setInterval(() => send(ws, { type: "ping" }), 20_000);
            this._upstreamPing.unref?.();
            return resolve();
          }
          return fail(new BridgeError("refused", msg.reason ?? "hub refused the connection"));
        }
        if (msg.type === "ping") return send(ws, { type: "pong" });
        if (msg.type === "response") {
          const p = this.upstreamPending.get(msg.id);
          if (!p) return;
          this.upstreamPending.delete(msg.id);
          clearTimeout(p.timer);
          if (msg.ok) p.resolve(msg.result);
          else p.reject(new BridgeError(msg.error.code ?? "error", msg.error.message));
        }
      });
      ws.on("close", () => {
        clearTimeout(helloTimer);
        if (this.upstream !== ws) return fail(new BridgeError("hub_gone", "hub closed the connection"));
        this.upstream = null;
        clearInterval(this._upstreamPing);
        for (const p of this.upstreamPending.values()) {
          clearTimeout(p.timer);
          p.reject(new BridgeError("hub_gone", "The hub process exited while the call was running; retry it."));
        }
        this.upstreamPending.clear();
        if (this.closed) return;
        this.role = null;
        this._resetReady();
        this.log("hub went away; re-electing");
        this.emit("role", null);
        this._elect();
      });
    });
  }

  _forward(tool, args, profile) {
    return new Promise((resolve, reject) => {
      const id = this._id();
      // Give the hub a little longer than its own extension timeout so its error wins.
      const ms = this._timeoutFor(tool) + 5000;
      const timer = setTimeout(() => {
        this.upstreamPending.delete(id);
        reject(new BridgeError("timeout", `"${tool}" got no answer from the hub within ${Math.round(ms / 1000)} s.`));
      }, ms);
      this.upstreamPending.set(id, { resolve, reject, timer });
      send(this.upstream, { type: "request", id, tool, args, profile });
    });
  }

  // ───────────────────────── public ─────────────────────────

  /** Run a tool on a profile (via the hub if this process is a relay). */
  async call(tool, args = {}, profile) {
    if (this.closed) throw new BridgeError("closed", "bridge is shut down");
    await this.ready();
    if (this.role === "hub") return this._dispatch(tool, args, profile);
    return this._forward(tool, args, profile);
  }

  async close() {
    this.closed = true;
    clearInterval(this._heartbeat);
    clearInterval(this._upstreamPing);
    if (this.upstream) {
      const ws = this.upstream;
      this.upstream = null;
      ws.terminate();
    }
    for (const entry of [...this.profiles.values()]) this._dropExtension(entry, "hub shutting down");
    for (const ws of this.relays) ws.terminate();
    this.relays.clear();
    if (this.wss) {
      for (const ws of this.wss.clients) ws.terminate();
      this.wss.close();
    }
    if (this.server) await new Promise((r) => this.server.close(() => r()));
    this.server = null;
    this.wss = null;
    this.role = null;
  }
}
