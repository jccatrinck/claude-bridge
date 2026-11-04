// End-to-end check against a real Chrome with the unpacked extension loaded.
//
//   CHROME=path\to\chrome.exe node test/e2e.mjs
//
// Branded Chrome ignores --load-extension, so use Chrome for Testing or Chromium
// (`npx @puppeteer/browsers install chrome@stable`). The run uses a throwaway profile,
// a throwaway bridge dir and random ports, so it does not touch your real setup.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { WebSocket } from "ws";
import { allowedOrigins, ensureToken } from "../server/config.mjs";
import { makeBigFile, serve } from "./fixtures/serve.mjs";
import { freePort, until } from "./helpers.mjs";

const repo = path.resolve(fileURLToPath(import.meta.url), "..", "..");
const chrome = process.env.CHROME;
if (!chrome || !fs.existsSync(chrome)) {
  console.error("Set CHROME to a Chrome for Testing / Chromium executable.");
  process.exit(2);
}

const work = fs.mkdtempSync(path.join(os.tmpdir(), "cb-e2e-"));
const bridgeDir = path.join(work, "bridge");
const userData = path.join(work, "chrome");
const uploads = path.join(work, "uploads");
const bigFile = makeBigFile(uploads, 50);
const port = await freePort();
const env = { ...process.env, CLAUDE_BRIDGE_DIR: bridgeDir, CLAUDE_BRIDGE_PORT: String(port) };
const token = ensureToken(bridgeDir);
const extId = allowedOrigins()[0].replace("chrome-extension://", "");
const fixture = await serve(0);
const fixtureUrl = `http://127.0.0.1:${fixture.address().port}/upload.html`;

const browser = spawn(
  chrome,
  [
    `--user-data-dir=${userData}`,
    `--load-extension=${path.join(repo, "extension")}`,
    `--disable-extensions-except=${path.join(repo, "extension")}`,
    ...(process.env.E2E_NO_FILE_ACCESS ? [] : ["--disable-extensions-file-access-check"]), // stands in for "Allow access to file URLs"
    "--remote-debugging-port=0",
    "--no-first-run",
    "--no-default-browser-check",
    "--window-size=1200,900",
    "about:blank",
  ],
  { stdio: "ignore" },
);

const clients = [];
let failed = false;
const step = async (name, fn) => {
  const t = Date.now();
  try {
    const r = await fn();
    console.log(`ok   ${name} (${Date.now() - t} ms)${r ? " — " + r : ""}`);
  } catch (e) {
    failed = true;
    console.log(`FAIL ${name}: ${e.message}`);
  }
};

try {
  // Configure the extension through the browser's own DevTools endpoint (only for this test).
  const portFile = path.join(userData, "DevToolsActivePort");
  await until(() => fs.existsSync(portFile) && fs.readFileSync(portFile, "utf8").includes("\n"), 20000);
  const [devPort, devPath] = fs.readFileSync(portFile, "utf8").trim().split("\n");
  const cdp = new WebSocket(`ws://127.0.0.1:${devPort}${devPath}`);
  await new Promise((r, j) => (cdp.once("open", r), cdp.once("error", j)));
  let seq = 0;
  const pending = new Map();
  cdp.on("message", (raw) => {
    const m = JSON.parse(raw);
    if (m.id && pending.has(m.id)) pending.get(m.id)(m), pending.delete(m.id);
  });
  const send = (method, params = {}, sessionId) =>
    new Promise((r) => {
      const id = ++seq;
      pending.set(id, r);
      cdp.send(JSON.stringify({ id, method, params, sessionId }));
    });
  // Write the settings from the extension's own options page (it has chrome.storage).
  const { result: created } = await send("Target.createTarget", { url: `chrome-extension://${extId}/options.html` });
  const { result: att } = await send("Target.attachToTarget", { targetId: created.targetId, flatten: true });
  await until(async () => {
    const r = await send("Runtime.evaluate", { expression: "typeof chrome !== 'undefined' && !!chrome.storage && document.readyState === 'complete'", returnByValue: true }, att.sessionId);
    return r.result?.result?.value === true;
  }, 20000);
  const settings = { profileName: "e2e", token, port, uploadRoots: [uploads], blockedSites: ["blocked.invalid"] };
  const setRes = await send("Runtime.evaluate", { expression: `chrome.storage.local.set(${JSON.stringify(settings)}).then(() => "ok")`, awaitPromise: true }, att.sessionId);
  assert.equal(setRes.result?.result?.value, "ok", JSON.stringify(setRes));
  await send("Target.closeTarget", { targetId: created.targetId });
  cdp.close();

  const mk = async () => {
    const c = new Client({ name: "e2e", version: "0" });
    await c.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(repo, "server", "index.mjs")], env, stderr: "inherit" }));
    clients.push(c);
    return c;
  };
  const c = await mk();
  const call = async (name, args = {}) => {
    const r = await c.callTool({ name, arguments: args });
    const text = r.content.find((x) => x.type === "text")?.text;
    if (r.isError) throw new Error(text);
    return { r, text, json: (() => { try { return JSON.parse(text); } catch { return null; } })() };
  };

  await step("extension connects and list_profiles shows it", async () => {
    const list = await until(async () => {
      const { json } = await call("list_profiles");
      return json?.length ? json : null;
    }, 20000);
    assert.equal(list[0].name, "e2e");
    return JSON.stringify(list);
  });

  await step("a second MCP client (relay) sees the same profile", async () => {
    const c2 = await mk();
    const r = await c2.callTool({ name: "list_profiles", arguments: {} });
    assert.equal(JSON.parse(r.content[0].text)[0].name, "e2e");
  });

  let tabId;
  await step("tab_open the fixture", async () => {
    const { json } = await call("tab_open", { url: fixtureUrl });
    tabId = json.tabId;
    assert.equal(json.loaded, true);
    return `tab ${tabId}`;
  });

  let snap;
  await step("snapshot", async () => {
    snap = (await call("snapshot", { tabId })).text;
    assert.match(snap, /heading "Upload test"/);
    return `${snap.split("\n").length} lines`;
  });
  const refOf = (re) => snap.split("\n").find((l) => re.test(l))?.match(/ref=(e\d+)/)?.[1];

  await step("find + click + type", async () => {
    const { json } = await call("find", { tabId, text: "Caption" });
    const box = json.find((h) => h.role === "textbox");
    await call("click", { tabId, ref: box.ref });
    await call("type", { tabId, text: "hello bridge" });
    const { json: v } = await call("eval", { tabId, js: "document.getElementById('caption').value" });
    assert.equal(v.value, "hello bridge");
  });

  await step("key shift+Enter and ctrl+a Backspace", async () => {
    await call("key", { tabId, keys: "shift+Enter" });
    const { json: k } = await call("eval", { tabId, js: "document.getElementById('keyOut').textContent" });
    assert.equal(k.value, "shift+Enter");
    await call("key", { tabId, keys: "ctrl+a Backspace" });
    const { json: v } = await call("eval", { tabId, js: "document.getElementById('caption').value" });
    assert.equal(v.value, "");
  });

  await step("fill select, checkbox, textarea and click Send", async () => {
    snap = (await call("snapshot", { tabId, interactiveOnly: true })).text;
    await call("fill", { tabId, ref: refOf(/combobox "Privacy"/), value: "Private" });
    await call("fill", { tabId, ref: refOf(/checkbox "I agree"/), value: true });
    await call("fill", { tabId, ref: refOf(/textbox "Notes"/), value: "multi\nline" });
    await call("click", { tabId, ref: refOf(/button "Send"/) });
    const { json } = await call("eval", { tabId, js: "JSON.parse(document.getElementById('formOut').textContent)" });
    assert.deepEqual(json.value, { caption: "", notes: "multi\nline", privacy: "private", agree: true });
  });

  await step("upload 50 MB into the direct input (selector)", async () => {
    const { json } = await call("upload", { tabId, selector: "#direct", paths: [bigFile] });
    assert.equal(json.files[0].size, 50 * 1024 * 1024);
    assert.equal(json.reported[0].size, 50 * 1024 * 1024);
    const { json: out } = await call("eval", { tabId, js: "document.getElementById('directOut').textContent" });
    assert.equal(out.value, `big-50mb.bin ${50 * 1024 * 1024}`);
    return out.value;
  });

  await step("upload 50 MB through a button that creates the input on click", async () => {
    const { json: f } = await call("find", { tabId, text: "Choose video" });
    const { json } = await call("upload", { tabId, ref: f[0].ref, paths: [bigFile] });
    assert.equal(json.mode, "chooser");
    const { json: out } = await call("eval", { tabId, js: "document.getElementById('lazyOut').textContent" });
    assert.equal(out.value, `big-50mb.bin ${50 * 1024 * 1024}`);
    return out.value;
  });

  await step("upload outside the roots is refused", async () => {
    await assert.rejects(call("upload", { tabId, selector: "#direct", paths: [path.join(repo, "package.json")] }), /outside the upload roots/);
  });

  await step("screenshot", async () => {
    const { r } = await call("screenshot", { tabId, scale: 0.5, quality: 60 });
    assert.equal(r.content[0].type, "image");
    return `${Math.round((r.content[0].data.length * 3) / 4 / 1024)} KB`;
  });

  await step("alert opened by a click is reported, then answered", async () => {
    const { json } = await call("click", { tabId, ref: (await call("find", { tabId, text: "Alert" })).json[0].ref });
    assert.equal(json.dialogOpened?.type, "alert");
    await assert.rejects(call("eval", { tabId, js: "1" }), /dialog/);
    await call("dialog", { tabId, accept: true });
    const { json: out } = await call("eval", { tabId, js: "document.getElementById('dialogOut').textContent" });
    assert.equal(out.value, "alert closed");
  });

  await step("prompt answered with text", async () => {
    await call("click", { tabId, ref: (await call("find", { tabId, text: "Prompt" })).json[0].ref });
    await call("dialog", { tabId, accept: true, text: "Ada" });
    const { json: out } = await call("eval", { tabId, js: "document.getElementById('dialogOut').textContent" });
    assert.equal(out.value, "prompt: Ada");
  });

  await step("scroll by wheel and to a ref", async () => {
    const { json } = await call("scroll", { tabId, dy: 800 });
    assert.ok(json.scrollY > 0, JSON.stringify(json));
    const { json: f } = await call("find", { tabId, text: "Upload test" });
    const { json: back } = await call("scroll", { tabId, ref: f[0].ref });
    return `wheel → ${json.scrollY}, ref → ${back.scrollY}`;
  });

  await step("console and network buffers", async () => {
    const { json: logs } = await call("console", { tabId, pattern: "fixture loaded|sent" });
    assert.ok(logs.length >= 1, JSON.stringify(logs));
    const { json: net } = await call("network", { tabId, pattern: "upload\\.html" });
    assert.equal(net[0].status, 200);
  });

  await step("navigate reload / blocked site", async () => {
    const { json } = await call("navigate", { tabId, url: "reload" });
    assert.equal(json.loaded, true);
    await assert.rejects(call("navigate", { tabId, url: "https://blocked.invalid/" }), /not allowed/);
  });

  await step("tabs_list and tab_close", async () => {
    const { json } = await call("tabs_list");
    assert.ok(json.some((t) => t.tabId === tabId && t.claude));
    await call("tab_close", { tabId });
    const { json: after } = await call("tabs_list");
    assert.ok(!after.some((t) => t.tabId === tabId));
  });
} catch (e) {
  failed = true;
  console.error(e);
} finally {
  for (const c of clients) await c.close().catch(() => {});
  browser.kill();
  fixture.close();
  await new Promise((r) => setTimeout(r, 1000));
  fs.rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
}
console.log(failed ? "\nE2E FAILED" : "\nE2E passed");
process.exit(failed ? 1 : 0);
