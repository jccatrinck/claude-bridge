import net from "node:net";
import { WebSocket } from "ws";

export const EXT_ORIGIN = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";

export function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
    s.on("error", reject);
  });
}

export const delay = (ms) => new Promise((r) => setTimeout(r, ms));

export async function until(fn, ms = 5000, step = 20) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error("until: condition not met in time");
    await delay(step);
  }
}

/**
 * A fake extension: connects, says hello, answers requests with `handler(tool, args)`,
 * and reconnects with a short backoff when the socket drops (like the real one).
 */
export class FakeExtension {
  constructor({ port, token, name, id = `id-${name}`, origin = EXT_ORIGIN, settings, handler, reconnect = true }) {
    Object.assign(this, { port, token, name, id, origin, settings, reconnect });
    this.handler = handler ?? ((tool, args) => ({ profile: name, tool, args }));
    this.calls = [];
    this.connected = false;
    this.refused = null;
    this.stopped = false;
    this.connect();
  }

  connect() {
    if (this.stopped) return;
    const ws = new WebSocket(`ws://127.0.0.1:${this.port}`, { origin: this.origin });
    this.ws = ws;
    ws.on("open", () =>
      ws.send(
        JSON.stringify({
          type: "hello",
          role: "extension",
          profileId: this.id,
          profileName: this.name,
          version: "0.0.0-test",
          token: this.token,
          settings: this.settings,
        }),
      ),
    );
    ws.on("message", async (raw) => {
      const msg = JSON.parse(raw);
      if (msg.type === "welcome") this.connected = true;
      else if (msg.type === "refused") this.refused = msg.reason;
      else if (msg.type === "request") {
        this.calls.push(msg);
        try {
          const result = msg.tool === "_info" ? { tabCount: 2 } : await this.handler(msg.tool, msg.args);
          ws.send(JSON.stringify({ type: "response", id: msg.id, ok: true, result }));
        } catch (e) {
          ws.send(JSON.stringify({ type: "response", id: msg.id, ok: false, error: { code: e.code ?? "error", message: e.message } }));
        }
      }
    });
    ws.on("error", () => {});
    ws.on("close", () => {
      this.connected = false;
      if (this.reconnect && !this.stopped && !this.refused) setTimeout(() => this.connect(), 50);
    });
  }

  stop() {
    this.stopped = true;
    this.ws?.terminate();
  }
}
