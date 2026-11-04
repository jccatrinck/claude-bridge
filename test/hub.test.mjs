import assert from "node:assert/strict";
import { after, test } from "node:test";
import { WebSocket } from "ws";
import { Bridge } from "../server/hub.mjs";
import { EXT_ORIGIN, FakeExtension, delay, freePort, until } from "./helpers.mjs";

const TOKEN = "test-token-123";
const cleanup = [];
after(async () => {
  for (const c of cleanup.reverse()) await c();
});

async function hub(port, opts = {}) {
  const b = new Bridge({ port, token: TOKEN, allowedOrigins: [EXT_ORIGIN], ...opts });
  cleanup.push(() => b.close());
  await b.start();
  return b;
}

function ext(opts) {
  const e = new FakeExtension({ token: TOKEN, ...opts });
  cleanup.push(() => e.stop());
  return e;
}

test("first bridge is hub, second is relay", async () => {
  const port = await freePort();
  const a = await hub(port);
  const b = await hub(port);
  assert.equal(a.role, "hub");
  assert.equal(b.role, "relay");
});

test("routing by profile with two extensions", async () => {
  const port = await freePort();
  const h = await hub(port);
  const a = ext({ port, name: "a" });
  const b = ext({ port, name: "b" });
  await until(() => a.connected && b.connected);

  const ra = await h.call("tabs_list", {}, "a");
  const rb = await h.call("tabs_list", {}, "b");
  assert.equal(ra.profile, "a");
  assert.equal(rb.profile, "b");
  assert.equal(a.calls.length, 1);
  assert.equal(b.calls.length, 1);

  const list = await h.call("list_profiles");
  assert.deepEqual(list.map((p) => p.name).sort(), ["a", "b"]);
  assert.equal(list[0].tabCount, 2);
});

test("missing or ambiguous profile errors list the names", async () => {
  const port = await freePort();
  const h = await hub(port);
  await assert.rejects(h.call("tabs_list"), { code: "no_profiles" });
  const a = ext({ port, name: "a" });
  await until(() => a.connected);
  assert.equal((await h.call("tabs_list")).profile, "a", "single profile is the default");
  const b = ext({ port, name: "b" });
  await until(() => b.connected);
  await assert.rejects(h.call("tabs_list"), (e) => e.code === "ambiguous_profile" && e.message.includes("a, b"));
  await assert.rejects(h.call("tabs_list", {}, "zzz"), (e) => e.code === "unknown_profile" && e.message.includes("a, b"));
});

test("relay calls are routed through the hub", async () => {
  const port = await freePort();
  await hub(port);
  const relay = await hub(port);
  assert.equal(relay.role, "relay");
  const a = ext({ port, name: "a" });
  await until(() => a.connected);
  const r = await relay.call("navigate", { tabId: 1, url: "about:blank" });
  assert.deepEqual(r, { profile: "a", tool: "navigate", args: { tabId: 1, url: "about:blank" } });
  const list = await relay.call("list_profiles");
  assert.equal(list.length, 1);
});

test("extension errors come back with their code", async () => {
  const port = await freePort();
  const h = await hub(port);
  const a = ext({
    port,
    name: "a",
    handler: () => {
      throw Object.assign(new Error("tab 9 does not exist"), { code: "no_tab" });
    },
  });
  await until(() => a.connected);
  await assert.rejects(h.call("tab_close", { tabId: 9 }), { code: "no_tab", message: "tab 9 does not exist" });
});

test("request timeout", async () => {
  const port = await freePort();
  const h = await hub(port, { timeoutMs: 200 });
  const a = ext({ port, name: "a", handler: () => new Promise(() => {}) });
  await until(() => a.connected);
  await assert.rejects(h.call("eval", { tabId: 1, js: "1" }), { code: "timeout" });
});

test("bad token is refused", async () => {
  const port = await freePort();
  const h = await hub(port);
  const bad = ext({ port, name: "bad", token: "wrong" });
  await until(() => bad.refused);
  assert.match(bad.refused, /token/);
  assert.equal(h.profiles.size, 0);
});

test("foreign browser origin is refused at the handshake", async () => {
  const port = await freePort();
  await hub(port);
  const ws = new WebSocket(`ws://127.0.0.1:${port}`, { origin: "https://evil.example" });
  const code = await new Promise((resolve) => {
    ws.on("unexpected-response", (_req, res) => resolve(res.statusCode));
    ws.on("open", () => resolve("open"));
    ws.on("error", () => {});
  });
  assert.equal(code, 403);
});

test("a second Chrome profile cannot steal a taken name", async () => {
  const port = await freePort();
  const h = await hub(port);
  const a1 = ext({ port, name: "a", id: "one" });
  await until(() => a1.connected);
  const a2 = ext({ port, name: "a", id: "two" });
  await until(() => a2.refused);
  assert.match(a2.refused, /already used/);
  assert.equal(h.profiles.get("a").profileId, "one");
});

test("hub takeover: relay becomes hub and extensions reconnect", async () => {
  const port = await freePort();
  const first = new Bridge({ port, token: TOKEN, allowedOrigins: [EXT_ORIGIN] });
  await first.start();
  const second = await hub(port);
  assert.equal(second.role, "relay");
  const a = ext({ port, name: "a" });
  const b = ext({ port, name: "b" });
  await until(() => a.connected && b.connected);

  await first.close();
  await until(() => second.role === "hub", 5000);
  await until(() => a.connected && b.connected && second.profiles.size === 2, 5000);
  const r = await second.call("tabs_list", {}, "b");
  assert.equal(r.profile, "b");
});

test("upload paths are checked by the hub before the extension sees them", async () => {
  const fs = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cb-up-"));
  const file = path.join(root, "clip.bin");
  await fs.writeFile(file, Buffer.alloc(1234));
  cleanup.push(() => fs.rm(root, { recursive: true, force: true }));

  const port = await freePort();
  const h = await hub(port);
  const a = ext({ port, name: "a", settings: { uploadRoots: [root] }, handler: (tool, args) => ({ set: args.paths.length }) });
  await until(() => a.connected);
  const r = await h.call("upload", { tabId: 1, ref: "e1", paths: [file] });
  assert.equal(r.set, 1);
  assert.equal(r.files[0].size, 1234);
  assert.equal(r.files[0].name, "clip.bin");
  await assert.rejects(h.call("upload", { tabId: 1, ref: "e1", paths: [path.join(os.tmpdir(), "..", "x.bin")] }), /not found|outside/);
  assert.equal(a.calls.length, 1, "rejected uploads never reach the extension");
  await delay(10);
});
