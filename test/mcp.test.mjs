// End-to-end over stdio: two MCP server processes (hub + relay) sharing one fake extension.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { allowedOrigins, ensureToken } from "../server/config.mjs";
import { FakeExtension, freePort, until } from "./helpers.mjs";

const serverPath = fileURLToPath(new URL("../server/index.mjs", import.meta.url));
const cleanup = [];
after(async () => {
  for (const c of cleanup.reverse()) await c().catch(() => {});
});

async function client(env) {
  const transport = new StdioClientTransport({ command: process.execPath, args: [serverPath], env: { ...process.env, ...env }, stderr: "pipe" });
  const c = new Client({ name: "test", version: "0" });
  await c.connect(transport);
  cleanup.push(() => c.close());
  return c;
}

const text = (r) => r.content.find((c) => c.type === "text").text;

test("two MCP clients share the bridge (hub + relay)", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cb-mcp-"));
  cleanup.push(async () => fs.rmSync(dir, { recursive: true, force: true }));
  const port = await freePort();
  const env = { CLAUDE_BRIDGE_DIR: dir, CLAUDE_BRIDGE_PORT: String(port) };

  const c1 = await client(env);
  const tools = await c1.listTools();
  assert.ok(tools.tools.some((t) => t.name === "upload"));
  assert.ok(tools.tools.length === 19);
  assert.match(c1.getInstructions(), /list_profiles/);
  for (const t of tools.tools) assert.match(t.description, /Chrome/, `${t.name} description mentions Chrome`);
  const byName = Object.fromEntries(tools.tools.map((t) => [t.name, t]));
  assert.equal(byName.snapshot.annotations.readOnlyHint, true);
  assert.equal(byName.eval.annotations.destructiveHint, true);
  assert.equal(byName.tab_open.annotations.destructiveHint, false);

  const empty = await c1.callTool({ name: "list_profiles", arguments: {} });
  assert.notEqual(empty.isError, true);
  assert.match(text(empty), /No Chrome profiles are connected.*pairing token/);

  const none = await c1.callTool({ name: "tabs_list", arguments: {} });
  assert.equal(none.isError, true);
  assert.match(text(none), /No Chrome profiles are connected/);

  const token = ensureToken(dir);
  const [origin] = allowedOrigins();
  const handler = (tool, args) => (tool === "screenshot" ? { data: Buffer.from("x").toString("base64"), mimeType: "image/jpeg", width: 1 } : { tool, args });
  const a = new FakeExtension({ port, token, name: "personal", origin, handler });
  const b = new FakeExtension({ port, token, name: "work", origin, handler });
  cleanup.push(async () => (a.stop(), b.stop()));
  await until(() => a.connected && b.connected);

  const c2 = await client(env);
  const [l1, l2] = await Promise.all([c1.callTool({ name: "list_profiles", arguments: {} }), c2.callTool({ name: "list_profiles", arguments: {} })]);
  for (const l of [l1, l2]) {
    const body = JSON.parse(text(l));
    assert.deepEqual(body.profiles.map((p) => p.name).sort(), ["personal", "work"]);
    assert.match(body.next, /profile/);
  }

  const amb = await c2.callTool({ name: "tab_open", arguments: { url: "about:blank" } });
  assert.equal(amb.isError, true);
  assert.match(text(amb), /personal, work/);

  const ok = await c2.callTool({ name: "tab_open", arguments: { url: "about:blank", profile: "personal" } });
  assert.deepEqual(JSON.parse(text(ok)), { tool: "tab_open", args: { url: "about:blank" }, next: "Call snapshot (or find) with this tabId to get element refs." });
  assert.equal(a.calls.at(-1).tool, "tab_open");

  const shot = await c1.callTool({ name: "screenshot", arguments: { tabId: 1, profile: "work" } });
  assert.equal(shot.content[0].type, "image");
});
