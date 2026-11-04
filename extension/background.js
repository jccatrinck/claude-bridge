// claude-bridge service worker: one WebSocket to the local hub, chrome.debugger per tab, tool router.

import { keyEvents, parseKeys, MODIFIER_BITS } from "./lib/keys.js";
import { blockedBy } from "./lib/match.js";
import { RefMap, findInAXTree, renderAXTree } from "./lib/snapshot.js";

const VERSION = chrome.runtime.getManifest().version;
const GROUP_TITLE = "Claude";
const DEFAULT_PORT = 47811;
const KEEPALIVE_MS = 20_000;
const IDLE_DETACH_MS = 5 * 60_000;
const LOAD_TIMEOUT_MS = 30_000;
const BUFFER_MAX = 1000;
const DEFAULTS = { profileName: "", token: "", port: DEFAULT_PORT, blockedSites: [], uploadRoots: [] };

// ───────────────────────── errors ─────────────────────────

class ToolError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}
const fail = (code, message) => {
  throw new ToolError(code, message);
};

// ───────────────────────── settings & status ─────────────────────────

async function loadSettings() {
  const s = await chrome.storage.local.get(null);
  if (!s.profileId) {
    s.profileId = crypto.randomUUID();
    await chrome.storage.local.set({ profileId: s.profileId });
  }
  return { ...DEFAULTS, ...s };
}

async function setStatus(state, detail = "") {
  await chrome.storage.session.set({ status: { state, detail, at: Date.now() } }).catch(() => {});
  const badge = { connected: "", connecting: "…", setup: "?", refused: "!", offline: "×" }[state] ?? "";
  chrome.action.setBadgeText({ text: badge }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ color: state === "connected" ? "#2e7d32" : "#c62828" }).catch(() => {});
  chrome.action.setTitle({ title: `claude-bridge: ${state}${detail ? " — " + detail : ""}` }).catch(() => {});
}

// ───────────────────────── socket ─────────────────────────

let ws = null;
let backoff = 500;
let reconnectTimer = null;
let keepaliveTimer = null;
let settings = null;
let connecting = false;

async function connect() {
  if (connecting || (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING))) return;
  connecting = true;
  try {
    settings = await loadSettings();
    if (!settings.profileName || !settings.token) {
      await setStatus("setup", "set a profile name and the pairing token in the options");
      return;
    }
    const port = Number(settings.port) || DEFAULT_PORT;
    await setStatus("connecting", `ws://127.0.0.1:${port}`);
    const sock = new WebSocket(`ws://127.0.0.1:${port}`);
    ws = sock;
    sock.onopen = () => {
      sock.send(
        JSON.stringify({
          type: "hello",
          role: "extension",
          profileId: settings.profileId,
          profileName: settings.profileName,
          version: VERSION,
          token: settings.token,
          settings: { uploadRoots: settings.uploadRoots, blockedSites: settings.blockedSites },
        }),
      );
    };
    sock.onmessage = (ev) => onMessage(sock, ev.data);
    sock.onclose = () => {
      if (ws === sock) ws = null;
      clearInterval(keepaliveTimer);
      if (sock._refused) return; // wait for a settings change or the alarm
      setStatus("offline", "hub not reachable; retrying");
      scheduleReconnect();
    };
    sock.onerror = () => {};
  } finally {
    connecting = false;
  }
}

function scheduleReconnect() {
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(connect, backoff);
  backoff = Math.min(backoff * 2, 5000);
}

function reconnectNow() {
  clearTimeout(reconnectTimer);
  backoff = 500;
  const old = ws;
  ws = null;
  if (old) {
    old._refused = true; // suppress its own reconnect
    old.close();
  }
  connect();
}

function sendMsg(sock, msg) {
  if (sock.readyState === WebSocket.OPEN) sock.send(JSON.stringify(msg));
}

async function onMessage(sock, raw) {
  let msg;
  try {
    msg = JSON.parse(raw);
  } catch {
    return;
  }
  switch (msg.type) {
    case "welcome":
      backoff = 500;
      setStatus("connected", `as "${settings.profileName}"`);
      clearInterval(keepaliveTimer);
      keepaliveTimer = setInterval(() => sendMsg(sock, { type: "ping" }), KEEPALIVE_MS);
      return;
    case "refused":
      sock._refused = true;
      setStatus("refused", msg.reason);
      return;
    case "ping":
      return sendMsg(sock, { type: "pong" });
    case "request": {
      try {
        const result = await runTool(msg.tool, msg.args ?? {});
        sendMsg(sock, { type: "response", id: msg.id, ok: true, result: result ?? null });
      } catch (e) {
        sendMsg(sock, { type: "response", id: msg.id, ok: false, error: { code: e.code ?? "error", message: e.message ?? String(e) } });
      }
    }
  }
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (["profileName", "token", "port", "blockedSites", "uploadRoots"].some((k) => k in changes)) reconnectNow();
});

chrome.alarms.create("keepalive", { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name !== "keepalive") return;
  if (!ws) {
    backoff = 500;
    connect();
  }
  detachIdle();
});
chrome.runtime.onStartup.addListener(connect);
chrome.runtime.onInstalled.addListener(async (d) => {
  await loadSettings();
  if (d.reason === "install") chrome.runtime.openOptionsPage();
  connect();
});
chrome.action.onClicked.addListener(() => chrome.runtime.openOptionsPage());
chrome.runtime.onMessage.addListener((m, _s, reply) => {
  if (m?.type === "reconnect") {
    reconnectNow();
    reply({ ok: true });
  }
});

// ───────────────────────── debugger ─────────────────────────

/** Per-tab state while the debugger is attached. */
const tabs = new Map();

function tabState(tabId) {
  let s = tabs.get(tabId);
  if (!s) {
    s = {
      attached: false,
      attaching: null,
      refs: new RefMap(),
      console: [],
      network: new Map(),
      dialog: null,
      lastUsed: Date.now(),
      listeners: new Set(), // (method, params) => void
      armedUpload: null,
    };
    tabs.set(tabId, s);
  }
  return s;
}

async function attach(tabId) {
  const s = tabState(tabId);
  s.lastUsed = Date.now();
  if (s.attached) return s;
  if (s.attaching) {
    await s.attaching;
    return s;
  }
  s.attaching = (async () => {
    try {
      await chrome.debugger.attach({ tabId }, "1.3");
    } catch (e) {
      const m = String(e.message ?? e);
      if (/already attached/i.test(m)) {
        // Probably our own session from before a service-worker restart.
        try {
          await chrome.debugger.detach({ tabId });
          await chrome.debugger.attach({ tabId }, "1.3");
        } catch (e2) {
          fail("attach_failed", `Cannot attach to tab ${tabId}: ${e2.message}. Is DevTools or another debugger extension attached to it?`);
        }
      } else if (/cannot access|chrome:\/\/|chrome-extension:\/\/|webstore/i.test(m)) {
        fail("attach_failed", `Chrome does not let extensions debug this page (${m}). Navigate the tab to a normal web page first.`);
      } else fail("attach_failed", `Cannot attach to tab ${tabId}: ${m}`);
    }
    s.attached = true;
    await Promise.all([cdp(tabId, "Page.enable"), cdp(tabId, "Runtime.enable"), cdp(tabId, "Network.enable"), cdp(tabId, "Log.enable")]);
  })();
  try {
    await s.attaching;
  } finally {
    s.attaching = null;
  }
  return s;
}

async function detach(tabId) {
  const s = tabs.get(tabId);
  tabs.delete(tabId);
  if (s?.attached) await chrome.debugger.detach({ tabId }).catch(() => {});
}

function detachIdle() {
  const now = Date.now();
  for (const [tabId, s] of tabs) if (s.attached && now - s.lastUsed > IDLE_DETACH_MS && !s.armedUpload) detach(tabId);
}

chrome.debugger.onDetach.addListener(({ tabId }) => {
  if (tabId !== undefined) tabs.delete(tabId);
});
chrome.tabs.onRemoved.addListener((tabId) => tabs.delete(tabId));

async function cdp(tabId, method, params = {}) {
  try {
    return await chrome.debugger.sendCommand({ tabId }, method, params);
  } catch (e) {
    const m = String(e.message ?? e);
    if (/No node with given id|Could not find node|Node with given id does not belong/i.test(m)) fail("stale_ref", "That element is gone from the page; take a new snapshot.");
    if (/not allowed/i.test(m) && method === "DOM.setFileInputFiles") {
      fail("not_allowed", "Chrome refused to hand local files to the page (DOM.setFileInputFiles: Not allowed).");
    }
    if (/not attached|Detached/i.test(m)) {
      tabs.delete(tabId);
      fail("detached", `The debugger was detached from tab ${tabId} (the debugging banner was closed?). Call the tool again to re-attach.`);
    }
    fail("cdp_error", `${method}: ${m}`);
  }
}

chrome.debugger.onEvent.addListener(({ tabId }, method, params) => {
  const s = tabs.get(tabId);
  if (!s) return;
  switch (method) {
    case "Runtime.consoleAPICalled":
      pushConsole(s, {
        level: params.type,
        text: (params.args ?? []).map(remoteToText).join(" "),
        url: params.stackTrace?.callFrames?.[0]?.url,
      });
      break;
    case "Runtime.exceptionThrown": {
      const d = params.exceptionDetails ?? {};
      pushConsole(s, { level: "exception", text: d.exception?.description ?? d.text ?? "exception", url: d.url });
      break;
    }
    case "Log.entryAdded":
      pushConsole(s, { level: params.entry.level, text: params.entry.text, url: params.entry.url, source: params.entry.source });
      break;
    case "Network.requestWillBeSent":
      s.network.set(params.requestId, { method: params.request.method, url: params.request.url, type: params.type, ts: Date.now() });
      if (s.network.size > BUFFER_MAX) s.network.delete(s.network.keys().next().value);
      break;
    case "Network.responseReceived": {
      const r = s.network.get(params.requestId);
      if (r) Object.assign(r, { status: params.response.status, mimeType: params.response.mimeType });
      break;
    }
    case "Network.loadingFailed": {
      const r = s.network.get(params.requestId);
      if (r) Object.assign(r, { failed: params.errorText, canceled: params.canceled || undefined });
      break;
    }
    case "Page.frameNavigated":
      if (!params.frame.parentId) s.refs.clear();
      break;
    case "Page.javascriptDialogOpening":
      s.dialog = { type: params.type, message: params.message, defaultPrompt: params.defaultPrompt, url: params.url };
      break;
    case "Page.javascriptDialogClosed":
      s.dialog = null;
      break;
    case "Page.fileChooserOpened":
      if (s.armedUpload && !s.armedUpload.waiter) {
        const paths = s.armedUpload.paths;
        s.armedUpload = null;
        answerChooser(tabId, params.backendNodeId, paths).catch(() => {});
      }
      break;
  }
  for (const l of s.listeners) l(method, params);
});

function pushConsole(s, entry) {
  s.console.push({ ts: Date.now(), ...entry });
  if (s.console.length > BUFFER_MAX) s.console.splice(0, s.console.length - BUFFER_MAX);
}

function remoteToText(o) {
  if (!o) return "";
  if (o.type === "string") return o.value;
  if (o.value !== undefined) return typeof o.value === "object" ? JSON.stringify(o.value) : String(o.value);
  return o.unserializableValue ?? o.description ?? o.type;
}

/** Wait for a CDP event on a tab. Returns { promise, cancel }. */
function waitEvent(tabId, method, pred = () => true, ms = LOAD_TIMEOUT_MS) {
  const s = tabState(tabId);
  let listener, timer;
  const promise = new Promise((resolve) => {
    listener = (m, p) => {
      if (m === method && pred(p)) {
        cleanup();
        resolve(p);
      }
    };
    timer = setTimeout(() => {
      cleanup();
      resolve(null);
    }, ms);
    s.listeners.add(listener);
  });
  const cleanup = () => {
    clearTimeout(timer);
    s.listeners.delete(listener);
  };
  return { promise, cancel: cleanup };
}

// ───────────────────────── tab group ─────────────────────────

async function claudeGroupIds() {
  const groups = await chrome.tabGroups.query({ title: GROUP_TITLE });
  return new Set(groups.map((g) => g.id));
}

async function addToGroup(tab) {
  const groups = await chrome.tabGroups.query({ title: GROUP_TITLE, windowId: tab.windowId });
  if (groups.length) {
    await chrome.tabs.group({ tabIds: [tab.id], groupId: groups[0].id });
  } else {
    const groupId = await chrome.tabs.group({ tabIds: [tab.id], createProperties: { windowId: tab.windowId } });
    await chrome.tabGroups.update(groupId, { title: GROUP_TITLE, color: "orange", collapsed: false });
  }
}

async function getTab(tabId) {
  if (!Number.isInteger(tabId)) fail("bad_args", "tabId must be an integer (from tab_open or tabs_list).");
  try {
    return await chrome.tabs.get(tabId);
  } catch {
    fail("no_tab", `Tab ${tabId} does not exist in this profile. Call tabs_list.`);
  }
}

function assertAllowed(url) {
  const hit = blockedBy(url, settings?.blockedSites);
  if (hit) fail("blocked_site", `The bridge is not allowed to act on ${new URL(url).origin} (blocked by "${hit}" in the extension options).`);
}

// ───────────────────────── tools ─────────────────────────

// Tools that still work while a JavaScript dialog is open.
const DIALOG_SAFE = new Set(["dialog", "tab_close", "tabs_list", "console", "network", "_info", "tab_open"]);

async function runTool(tool, args) {
  const fn = TOOLS[tool];
  if (!fn) fail("unknown_tool", `This extension version (${VERSION}) has no tool "${tool}".`);
  if (!settings) settings = await loadSettings();
  if (args.tabId === undefined) return fn(args);

  const tab = await getTab(args.tabId);
  assertAllowed(tab.pendingUrl || tab.url);
  const s = tool === "tab_close" ? tabState(args.tabId) : await attach(args.tabId);
  s.lastUsed = Date.now();
  if (s.dialog && !DIALOG_SAFE.has(tool)) {
    fail("dialog_open", `A JavaScript ${s.dialog.type} is open in tab ${args.tabId}: ${JSON.stringify(s.dialog.message)}. Answer it with the dialog tool first.`);
  }
  // A dialog opened by the action itself would block the CDP call; return as soon as one appears.
  const dialogWait = DIALOG_SAFE.has(tool) ? null : waitEvent(args.tabId, "Page.javascriptDialogOpening", () => true, 10 * 60_000);
  try {
    const race = [fn(args, tab, s)];
    if (dialogWait)
      race.push(
        dialogWait.promise.then((d) =>
          d ? { dialogOpened: { type: d.type, message: d.message }, note: "A JavaScript dialog opened; answer it with the dialog tool." } : new Promise(() => {}),
        ),
      );
    return await Promise.race(race);
  } finally {
    dialogWait?.cancel();
  }
}

async function resolveBackendId(s, ref) {
  if (typeof ref !== "string" || !ref) fail("bad_args", 'ref must be a string like "e12".');
  const id = s.refs.backendFor(ref);
  if (!id) fail("stale_ref", `Unknown ref "${ref}" (refs reset when the page navigates). Take a new snapshot or use find.`);
  return id;
}

async function elementCenter(tabId, backendNodeId) {
  await cdp(tabId, "DOM.scrollIntoViewIfNeeded", { backendNodeId }).catch(() => {});
  let quads;
  try {
    quads = (await cdp(tabId, "DOM.getContentQuads", { backendNodeId })).quads;
  } catch (e) {
    if (e.code === "stale_ref") throw e;
  }
  if (!quads?.length) {
    const box = await cdp(tabId, "DOM.getBoxModel", { backendNodeId }).catch(() => null);
    quads = box ? [box.model.content] : [];
  }
  const q = quads.find((q) => Math.abs((q[2] - q[0]) * (q[5] - q[1])) > 0) ?? quads[0];
  if (!q) fail("not_visible", "The element has no box on screen (hidden or zero-size).");
  return { x: (q[0] + q[2] + q[4] + q[6]) / 4, y: (q[1] + q[3] + q[5] + q[7]) / 4 };
}

async function objectIdFor(tabId, backendNodeId) {
  const { object } = await cdp(tabId, "DOM.resolveNode", { backendNodeId });
  return object.objectId;
}

async function callOn(tabId, backendNodeId, fnDecl, args = []) {
  const objectId = await objectIdFor(tabId, backendNodeId);
  const r = await cdp(tabId, "Runtime.callFunctionOn", {
    objectId,
    functionDeclaration: fnDecl,
    arguments: args.map((value) => ({ value })),
    returnByValue: true,
    awaitPromise: true,
  });
  if (r.exceptionDetails) fail("page_error", r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  return r.result.value;
}

async function viewport(tabId) {
  const m = await cdp(tabId, "Page.getLayoutMetrics");
  const vv = m.cssVisualViewport ?? m.visualViewport;
  const content = m.cssContentSize ?? m.contentSize;
  return { width: vv.clientWidth, height: vv.clientHeight, pageX: vv.pageX, pageY: vv.pageY, content };
}

async function mouseClick(tabId, x, y, { button = "left", clickCount = 1, modifiers = 0 } = {}) {
  await cdp(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", x, y, modifiers });
  for (let i = 1; i <= clickCount; i++) {
    await cdp(tabId, "Input.dispatchMouseEvent", { type: "mousePressed", x, y, button, clickCount: i, modifiers });
    await cdp(tabId, "Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button, clickCount: i, modifiers });
  }
}

async function waitForLoad(tabId, start) {
  const ev = waitEvent(tabId, "Page.loadEventFired");
  let r;
  try {
    r = await start();
  } catch (e) {
    ev.cancel();
    throw e;
  }
  if (r?.errorText) {
    ev.cancel();
    fail("navigation_failed", `Navigation failed: ${r.errorText}`);
  }
  if (r && "loaderId" in r && !r.loaderId) {
    ev.cancel(); // same-document navigation: no load event
    return { loaded: true, sameDocument: true };
  }
  const fired = await ev.promise;
  return fired ? { loaded: true } : { loaded: false, note: `The load event did not fire within ${LOAD_TIMEOUT_MS / 1000} s; the page may still be loading.` };
}

async function pageInfo(tabId) {
  const t = await chrome.tabs.get(tabId);
  return { tabId, url: t.url, title: t.title };
}

const FILL_FN = `function (value) {
  const el = this;
  const fire = () => { el.dispatchEvent(new Event("input", { bubbles: true })); el.dispatchEvent(new Event("change", { bubbles: true })); };
  if (el instanceof HTMLSelectElement) {
    const v = String(value);
    const opt = [...el.options].find((o) => o.value === v) || [...el.options].find((o) => o.label.trim() === v || o.text.trim() === v);
    if (!opt) throw new Error("No option " + JSON.stringify(v) + ". Options: " + [...el.options].map((o) => o.value).join(", "));
    el.value = opt.value; fire(); return { value: el.value };
  }
  if (el instanceof HTMLInputElement && (el.type === "checkbox" || el.type === "radio")) {
    const want = value === true || value === "true" || value === "on" || value === 1 || value === "1";
    if (el.checked !== want) el.click();
    return { checked: el.checked };
  }
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    if (el.type === "file") throw new Error("Use the upload tool for file inputs.");
    el.focus();
    const proto = el instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value").set.call(el, String(value));
    fire(); return { value: el.value };
  }
  if (el.isContentEditable) {
    el.focus(); el.textContent = String(value);
    el.dispatchEvent(new InputEvent("input", { bubbles: true })); return { text: el.textContent };
  }
  throw new Error("Element <" + el.tagName.toLowerCase() + "> cannot be filled; use click/type.");
}`;

const FILES_FN = `function () { return Array.from(this.files || []).map((f) => ({ name: f.name, size: f.size })); }`;

async function answerChooser(tabId, backendNodeId, paths) {
  await cdp(tabId, "DOM.setFileInputFiles", { files: paths, backendNodeId });
  await cdp(tabId, "Page.setInterceptFileChooserDialog", { enabled: false }).catch(() => {});
  return callOn(tabId, backendNodeId, FILES_FN).catch(() => null);
}

async function isFileInput(tabId, backendNodeId) {
  const { node } = await cdp(tabId, "DOM.describeNode", { backendNodeId });
  if (node.nodeName !== "INPUT") return false;
  const attrs = node.attributes ?? [];
  for (let i = 0; i < attrs.length; i += 2) if (attrs[i] === "type") return attrs[i + 1].toLowerCase() === "file";
  return false;
}

const TOOLS = {
  async _info() {
    const all = await chrome.tabs.query({});
    const groups = await claudeGroupIds();
    return { tabCount: all.length, claudeTabs: all.filter((t) => groups.has(t.groupId)).length, attached: [...tabs.keys()] };
  },

  async tabs_list({ all = false }) {
    const groups = await claudeGroupIds();
    const list = (await chrome.tabs.query({})).filter((t) => all || groups.has(t.groupId));
    return list.map((t) => ({ tabId: t.id, title: t.title, url: t.url || t.pendingUrl, active: t.active, windowId: t.windowId, claude: groups.has(t.groupId) }));
  },

  async tab_open({ url, active = false }) {
    if (url) assertAllowed(url);
    let tab;
    try {
      tab = await chrome.tabs.create({ url: "about:blank", active });
    } catch {
      const win = await chrome.windows.create({ url: "about:blank", focused: active });
      tab = win.tabs[0];
    }
    await addToGroup(tab).catch(() => {});
    await attach(tab.id);
    let load = {};
    if (url && url !== "about:blank") load = await waitForLoad(tab.id, () => cdp(tab.id, "Page.navigate", { url }));
    return { ...(await pageInfo(tab.id)), ...load };
  },

  async tab_close({ tabId }) {
    await detach(tabId);
    await chrome.tabs.remove(tabId);
    return { closed: tabId };
  },

  async navigate({ tabId, url }) {
    if (typeof url !== "string" || !url) fail("bad_args", 'url is required (a URL, or "back", "forward", "reload").');
    let load;
    if (url === "reload") load = await waitForLoad(tabId, () => cdp(tabId, "Page.reload"));
    else if (url === "back" || url === "forward") {
      const h = await cdp(tabId, "Page.getNavigationHistory");
      const entry = h.entries[h.currentIndex + (url === "back" ? -1 : 1)];
      if (!entry) fail("no_history", `There is no page to go ${url} to.`);
      assertAllowed(entry.url);
      load = await waitForLoad(tabId, () => cdp(tabId, "Page.navigateToHistoryEntry", { entryId: entry.id }));
    } else {
      assertAllowed(url);
      load = await waitForLoad(tabId, () => cdp(tabId, "Page.navigate", { url }));
    }
    return { ...(await pageInfo(tabId)), ...load };
  },

  async screenshot({ tabId, scale = 1, quality = 70, region, fullPage = false }, tab) {
    const vp = await viewport(tabId);
    let clip;
    if (fullPage) clip = { x: 0, y: 0, width: vp.content.width, height: vp.content.height, scale };
    else if (region) clip = { x: vp.pageX + region.x, y: vp.pageY + region.y, width: region.width, height: region.height, scale };
    else clip = { x: vp.pageX, y: vp.pageY, width: vp.width, height: vp.height, scale };
    const params = { format: "jpeg", quality, clip, captureBeyondViewport: fullPage };
    const capture = () =>
      Promise.race([cdp(tabId, "Page.captureScreenshot", params), new Promise((r) => setTimeout(() => r(null), 8000))]);
    let shot = await capture();
    let note;
    if (!shot && !tab.active) {
      // Some pages don't paint while hidden; show the tab briefly and retry.
      await chrome.tabs.update(tabId, { active: true });
      shot = await capture();
      note = "The tab was brought to the front to capture it.";
    }
    if (!shot) fail("timeout", "Page.captureScreenshot did not return.");
    return { data: shot.data, mimeType: "image/jpeg", width: Math.round(clip.width * scale), height: Math.round(clip.height * scale), note };
  },

  async snapshot({ tabId, interactiveOnly = false, maxChars = 40000 }, _tab, s) {
    const { nodes } = await cdp(tabId, "Accessibility.getFullAXTree");
    const r = renderAXTree(nodes, s.refs, { interactiveOnly, maxChars });
    const info = await pageInfo(tabId);
    return { text: `# ${info.title}\n# ${info.url}\n${r.text}` };
  },

  async find({ tabId, text, limit = 25 }, _tab, s) {
    if (typeof text !== "string" || !text.trim()) fail("bad_args", "text is required.");
    const { nodes } = await cdp(tabId, "Accessibility.getFullAXTree");
    const hits = findInAXTree(nodes, s.refs, text, limit);
    return hits.length ? hits : { matches: 0, note: `Nothing matches ${JSON.stringify(text)}. Try snapshot.` };
  },

  async click({ tabId, ref, x, y, button = "left", clickCount = 1, modifiers = [] }, _tab, s) {
    let pt;
    if (ref) pt = await elementCenter(tabId, await resolveBackendId(s, ref));
    else if (Number.isFinite(x) && Number.isFinite(y)) pt = { x, y };
    else fail("bad_args", "click needs ref, or x and y.");
    const bits = modifiers.reduce((b, m) => b | (MODIFIER_BITS[m] ?? 0), 0);
    await mouseClick(tabId, pt.x, pt.y, { button, clickCount, modifiers: bits });
    return { clicked: ref ?? null, x: Math.round(pt.x), y: Math.round(pt.y) };
  },

  async type({ tabId, text, ref }, _tab, s) {
    if (typeof text !== "string") fail("bad_args", "text is required.");
    if (ref) await cdp(tabId, "DOM.focus", { backendNodeId: await resolveBackendId(s, ref) });
    await cdp(tabId, "Input.insertText", { text });
    return { typed: text.length };
  },

  async key({ tabId, keys, repeat = 1 }) {
    let chords;
    try {
      chords = parseKeys(keys);
    } catch (e) {
      fail("bad_args", e.message);
    }
    for (let i = 0; i < repeat; i++) for (const c of chords) for (const ev of keyEvents(c)) await cdp(tabId, "Input.dispatchKeyEvent", ev);
    return { pressed: keys, repeat };
  },

  async scroll({ tabId, ref, x, y, dx = 0, dy = 0 }, _tab, s) {
    if (ref) {
      await cdp(tabId, "DOM.scrollIntoViewIfNeeded", { backendNodeId: await resolveBackendId(s, ref) });
    } else {
      const vp = await viewport(tabId);
      await cdp(tabId, "Input.dispatchMouseEvent", {
        type: "mouseWheel",
        x: Number.isFinite(x) ? x : vp.width / 2,
        y: Number.isFinite(y) ? y : vp.height / 2,
        deltaX: dx,
        deltaY: dy,
      });
      await new Promise((r) => setTimeout(r, 150)); // let smooth scrolling settle
    }
    const vp = await viewport(tabId);
    return { scrollX: Math.round(vp.pageX), scrollY: Math.round(vp.pageY) };
  },

  async fill({ tabId, ref, value }, _tab, s) {
    return callOn(tabId, await resolveBackendId(s, ref), FILL_FN, [value]);
  },

  async upload({ tabId, ref, selector, paths }, _tab, s) {
    if (!Array.isArray(paths) || !paths.length) fail("bad_args", "paths is required.");
    let backendNodeId;
    if (ref) backendNodeId = await resolveBackendId(s, ref);
    else if (selector) {
      const r = await cdp(tabId, "Runtime.evaluate", { expression: `document.querySelector(${JSON.stringify(selector)})` });
      if (r.exceptionDetails) fail("bad_args", `Bad selector ${JSON.stringify(selector)}.`);
      if (!r.result.objectId) fail("not_found", `No element matches ${JSON.stringify(selector)}.`);
      backendNodeId = (await cdp(tabId, "DOM.describeNode", { objectId: r.result.objectId })).node.backendNodeId;
    }

    if (backendNodeId && (await isFileInput(tabId, backendNodeId))) {
      const reported = await answerChooser(tabId, backendNodeId, paths);
      return { mode: "input", reported };
    }

    await cdp(tabId, "Page.setInterceptFileChooserDialog", { enabled: true });
    if (!backendNodeId) {
      s.armedUpload = { paths };
      return { mode: "armed", note: "The next file chooser this tab opens will receive the files. Click the page's upload button now." };
    }
    // The target is a button that opens a chooser: click it and answer the chooser.
    s.armedUpload = { paths, waiter: true };
    const chooser = waitEvent(tabId, "Page.fileChooserOpened", () => true, 10_000);
    try {
      const pt = await elementCenter(tabId, backendNodeId);
      await mouseClick(tabId, pt.x, pt.y);
    } catch (e) {
      chooser.cancel();
      s.armedUpload = null;
      await cdp(tabId, "Page.setInterceptFileChooserDialog", { enabled: false }).catch(() => {});
      throw e;
    }
    const ev = await chooser.promise;
    s.armedUpload = null;
    if (!ev) {
      await cdp(tabId, "Page.setInterceptFileChooserDialog", { enabled: false }).catch(() => {});
      fail("no_file_chooser", "Clicking the element did not open a file chooser within 10 s. Point ref at the <input type=file> or the real upload button.");
    }
    const reported = await answerChooser(tabId, ev.backendNodeId, paths);
    return { mode: "chooser", reported };
  },

  async eval({ tabId, js }) {
    if (typeof js !== "string") fail("bad_args", "js is required.");
    const r = await cdp(tabId, "Runtime.evaluate", { expression: js, awaitPromise: true, returnByValue: true, userGesture: true, replMode: true });
    if (r.exceptionDetails) fail("page_error", r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    const v = r.result;
    if (v.type === "undefined") return { value: null, type: "undefined" };
    if ("value" in v) return { value: v.value };
    return { value: v.unserializableValue ?? v.description ?? null, type: v.type };
  },

  async console({ tabId, pattern, clear = false, limit = 200 }, _tab, s) {
    const re = pattern ? safeRegex(pattern) : null;
    const list = s.console.filter((e) => !re || re.test(e.text)).slice(-limit);
    if (clear) s.console = [];
    return list.map((e) => ({ ...e, ts: new Date(e.ts).toISOString() }));
  },

  async network({ tabId, pattern, clear = false, limit = 200 }, _tab, s) {
    const re = pattern ? safeRegex(pattern) : null;
    const list = [...s.network.values()].filter((e) => !re || re.test(e.url)).slice(-limit);
    if (clear) s.network.clear();
    return list.map((e) => ({ ...e, ts: new Date(e.ts).toISOString() }));
  },

  async dialog({ tabId, accept, text }, _tab, s) {
    if (!s.dialog) fail("no_dialog", `No JavaScript dialog is open in tab ${tabId}.`);
    const d = s.dialog;
    await cdp(tabId, "Page.handleJavaScriptDialog", { accept: !!accept, promptText: text });
    s.dialog = null;
    return { answered: d.type, message: d.message, accepted: !!accept };
  },
};

function safeRegex(p) {
  try {
    return new RegExp(p, "i");
  } catch {
    fail("bad_args", `Bad regex ${JSON.stringify(p)}.`);
  }
}

connect();
