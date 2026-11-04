// Accessibility-tree rendering and ref ↔ backendNodeId mapping. Pure: no chrome.* here,
// so it can be tested in Node with a mocked Accessibility.getFullAXTree result.

export const INTERACTIVE_ROLES = new Set([
  "button",
  "checkbox",
  "combobox",
  "link",
  "listbox",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "option",
  "radio",
  "scrollbar",
  "searchbox",
  "slider",
  "spinbutton",
  "switch",
  "tab",
  "textbox",
  "treeitem",
]);

// Roles that only add noise: their children are rendered in their place.
const TRANSPARENT_ROLES = new Set(["generic", "none", "presentation", "ignored", "LineBreak"]);
const SKIP_ROLES = new Set(["InlineTextBox"]);
const STATE_PROPS = ["focused", "checked", "pressed", "selected", "expanded", "disabled", "required", "invalid", "readonly", "level"];

/** Per-tab ref registry. Refs only ever increase, so a ref from before a navigation never aliases a new node. */
export class RefMap {
  constructor() {
    this.next = 1;
    this.byBackend = new Map();
    this.byRef = new Map();
  }
  refFor(backendNodeId) {
    let ref = this.byBackend.get(backendNodeId);
    if (!ref) {
      ref = `e${this.next++}`;
      this.byBackend.set(backendNodeId, ref);
      this.byRef.set(ref, backendNodeId);
    }
    return ref;
  }
  backendFor(ref) {
    return this.byRef.get(ref);
  }
  /** Forget every node (after a navigation). The counter keeps going. */
  clear() {
    this.byBackend.clear();
    this.byRef.clear();
  }
}

const val = (x) => (x && x.value !== undefined && x.value !== null ? x.value : undefined);
const clip = (s, n = 200) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
const quote = (s) => JSON.stringify(clip(String(s).replace(/\s+/g, " ").trim()));

function nodeInfo(n) {
  const role = val(n.role) ?? "";
  const name = val(n.name);
  const value = val(n.value);
  const props = {};
  for (const p of n.properties ?? []) props[p.name] = val(p.value);
  return { role: String(role), name: name === undefined ? "" : String(name), value, props };
}

function states(props) {
  const out = [];
  for (const k of STATE_PROPS) {
    const v = props[k];
    if (v === undefined || v === false || v === "false") continue;
    out.push(v === true || v === "true" ? k : `${k}=${v}`);
  }
  return out;
}

function isInteractive(info) {
  if (INTERACTIVE_ROLES.has(info.role)) return true;
  return info.props.editable !== undefined && info.props.editable !== "inherit" && info.role !== "StaticText";
}

function index(nodes) {
  const byId = new Map(nodes.map((n) => [n.nodeId, n]));
  const root = nodes.find((n) => !n.parentId || !byId.has(n.parentId)) ?? nodes[0];
  return { byId, root };
}

function line(n, info, refs, depth) {
  let s = `${"  ".repeat(depth)}- ${info.role || "node"}`;
  if (info.name) s += ` ${quote(info.name)}`;
  if (info.value !== undefined && info.value !== "" && String(info.value) !== info.name) s += ` value=${quote(info.value)}`;
  const st = states(info.props);
  if (st.length) s += ` [${st.join(", ")}]`;
  if (n.backendDOMNodeId && info.role !== "StaticText") s += ` [ref=${refs.refFor(n.backendDOMNodeId)}]`;
  return s;
}

/**
 * @param {object[]} nodes   result.nodes of Accessibility.getFullAXTree
 * @param {RefMap} refs
 * @returns {{ text: string, nodes: number, truncated: boolean }}
 */
export function renderAXTree(nodes, refs, { interactiveOnly = false, maxChars = 40000 } = {}) {
  if (!nodes?.length) return { text: "(empty page)", nodes: 0, truncated: false };
  const { byId, root } = index(nodes);
  const lines = [];
  let size = 0;
  let truncated = false;
  const push = (s) => {
    if (truncated) return;
    if (size + s.length + 1 > maxChars) {
      truncated = true;
      return;
    }
    lines.push(s);
    size += s.length + 1;
  };

  const seen = new Set();
  const walk = (id, depth, parentName) => {
    if (truncated || seen.has(id)) return;
    seen.add(id);
    const n = byId.get(id);
    if (!n) return;
    const info = nodeInfo(n);
    if (SKIP_ROLES.has(info.role)) return;
    let childDepth = depth;
    let nameForChildren = parentName;
    const transparent = n.ignored || TRANSPARENT_ROLES.has(info.role) || (info.role === "StaticText" && info.name === parentName);
    if (!transparent && !(info.role === "StaticText" && !info.name.trim())) {
      if (!interactiveOnly) {
        push(line(n, info, refs, depth));
        childDepth = depth + 1;
        nameForChildren = info.name;
      } else if (isInteractive(info)) {
        push(line(n, info, refs, 0));
        nameForChildren = info.name;
      }
    }
    for (const c of n.childIds ?? []) walk(c, childDepth, nameForChildren);
  };
  walk(root.nodeId, 0, undefined);
  if (truncated) lines.push(`… (truncated at ${maxChars} chars; use interactiveOnly or find)`);
  return { text: lines.join("\n") || "(no visible nodes)", nodes: lines.length, truncated };
}

/** Nodes whose role, name or value contains `text` (case-insensitive). */
export function findInAXTree(nodes, refs, text, limit = 25) {
  const needle = String(text).toLowerCase().trim();
  if (!needle) return [];
  const out = [];
  const { byId } = index(nodes);
  for (const n of nodes) {
    if (out.length >= limit) break;
    if (n.ignored || !n.backendDOMNodeId) continue;
    const info = nodeInfo(n);
    if (SKIP_ROLES.has(info.role)) continue;
    const hay = [info.role, info.name, info.value === undefined ? "" : String(info.value)].join(" ").toLowerCase();
    if (!hay.includes(needle)) continue;
    // Prefer the element over its own text child: report a StaticText's nearest named ancestor.
    let target = n;
    let tinfo = info;
    if (info.role === "StaticText") {
      let p = byId.get(n.parentId);
      while (p && (p.ignored || TRANSPARENT_ROLES.has(nodeInfo(p).role) || !p.backendDOMNodeId)) p = byId.get(p.parentId);
      if (p) {
        target = p;
        tinfo = nodeInfo(p);
      }
    }
    const ref = refs.refFor(target.backendDOMNodeId);
    if (out.some((o) => o.ref === ref)) continue;
    const hit = { ref, role: tinfo.role, name: clip(tinfo.name) };
    if (tinfo.value !== undefined && tinfo.value !== "") hit.value = clip(String(tinfo.value));
    if (target !== n) hit.text = clip(info.name);
    out.push(hit);
  }
  return out;
}
