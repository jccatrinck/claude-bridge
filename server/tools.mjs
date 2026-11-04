// MCP tool definitions (JSON Schema). Every tool that touches a browser takes an optional `profile`.

const profile = {
  type: "string",
  description: "Chrome profile name (see list_profiles). Optional when exactly one profile is connected.",
};
const tabId = { type: "integer", description: "Tab id from tab_open or tabs_list." };
const ref = { type: "string", description: 'Element ref from snapshot or find, e.g. "e12".' };

const tool = (name, description, properties = {}, required = [], { withProfile = true } = {}) => ({
  name,
  description: `Chrome (claude-bridge): ${description}`,
  inputSchema: {
    type: "object",
    properties: withProfile ? { ...properties, profile } : properties,
    required,
    additionalProperties: false,
  },
});

export const TOOLS = [
  tool("list_profiles", "List the connected Chrome profiles: name, id, extension version and tab count.", {}, [], { withProfile: false }),
  tool("tabs_list", 'List tabs in the bridge\'s "Claude" tab group (or every tab with all: true): id, title, URL.', {
    all: { type: "boolean", description: "List every tab in the profile, not just the Claude group." },
  }),
  tool("tab_open", 'Open a new tab in the "Claude" tab group and return its tabId.', {
    url: { type: "string", description: "URL to open (default about:blank). Waits for load." },
    active: { type: "boolean", description: "Focus the new tab (default false)." },
  }),
  tool("tab_close", "Close a tab.", { tabId }, ["tabId"]),
  tool(
    "navigate",
    'Navigate a tab to a URL, or "back", "forward" or "reload", and wait for the load event (30 s timeout).',
    { tabId, url: { type: "string", description: 'URL, or "back" | "forward" | "reload".' } },
    ["tabId", "url"],
  ),
  tool(
    "screenshot",
    "Capture a JPEG screenshot of the tab's viewport (works on background tabs).",
    {
      tabId,
      scale: { type: "number", minimum: 0.1, maximum: 2, description: "Scale factor (default 1; CSS pixels)." },
      quality: { type: "integer", minimum: 1, maximum: 100, description: "JPEG quality (default 70)." },
      region: {
        type: "object",
        description: "Capture only this CSS-pixel region of the viewport.",
        properties: { x: { type: "number" }, y: { type: "number" }, width: { type: "number" }, height: { type: "number" } },
        required: ["x", "y", "width", "height"],
        additionalProperties: false,
      },
      fullPage: { type: "boolean", description: "Capture the whole page, not just the viewport." },
    },
    ["tabId"],
  ),
  tool(
    "snapshot",
    'Accessibility tree of the page as indented text. Each node carries a ref like "e12" that other tools accept.',
    {
      tabId,
      interactiveOnly: { type: "boolean", description: "Only interactive elements (links, buttons, inputs …)." },
      maxChars: { type: "integer", minimum: 500, description: "Truncate the output (default 40000)." },
    },
    ["tabId"],
  ),
  tool(
    "find",
    "Find elements whose accessible name, role, value or text contains `text` (case-insensitive). Returns refs.",
    { tabId, text: { type: "string" }, limit: { type: "integer", minimum: 1, description: "Max results (default 25)." } },
    ["tabId", "text"],
  ),
  tool(
    "click",
    "Click an element (scrolled into view, clicked at its center) or a viewport point.",
    {
      tabId,
      ref,
      x: { type: "number", description: "Viewport x (CSS px), used when no ref is given." },
      y: { type: "number", description: "Viewport y (CSS px)." },
      button: { type: "string", enum: ["left", "right", "middle"] },
      clickCount: { type: "integer", minimum: 1, maximum: 3, description: "2 for double click." },
      modifiers: { type: "array", items: { type: "string", enum: ["alt", "ctrl", "meta", "shift"] } },
    },
    ["tabId"],
  ),
  tool(
    "type",
    "Insert text at the focus (focusing `ref` first, if given). Does not press Enter; use key for that.",
    { tabId, text: { type: "string" }, ref },
    ["tabId", "text"],
  ),
  tool(
    "key",
    'Press keys. Space-separated chords, e.g. "Enter", "shift+Enter", "ctrl+a Backspace", "ArrowDown ArrowDown Enter".',
    { tabId, keys: { type: "string" }, repeat: { type: "integer", minimum: 1, maximum: 100, description: "Repeat the whole sequence." } },
    ["tabId", "keys"],
  ),
  tool(
    "scroll",
    "Scroll with the mouse wheel at (x, y) by (dx, dy), or scroll `ref` into view.",
    {
      tabId,
      ref,
      x: { type: "number", description: "Viewport x for the wheel (default: center)." },
      y: { type: "number", description: "Viewport y for the wheel (default: center)." },
      dx: { type: "number", description: "Horizontal delta in px." },
      dy: { type: "number", description: "Vertical delta in px (positive scrolls down)." },
    },
    ["tabId"],
  ),
  tool(
    "fill",
    "Set the value of an input, textarea, select (by value or label), checkbox/radio (true/false) or contenteditable, firing input and change events.",
    { tabId, ref, value: { type: ["string", "number", "boolean"] } },
    ["tabId", "ref", "value"],
  ),
  tool(
    "upload",
    "Put local files into a file input. Chrome reads them from disk: no size cap. `ref`/`selector` may point at the <input type=file> " +
      "or at a button that opens a file chooser. With neither, the next file chooser the page opens is answered with these files.",
    {
      tabId,
      ref,
      selector: { type: "string", description: "CSS selector of the file input or of the button that opens the chooser." },
      paths: { type: "array", items: { type: "string" }, minItems: 1, description: "Absolute local file paths, inside the upload roots." },
    },
    ["tabId", "paths"],
  ),
  tool(
    "eval",
    "Evaluate JavaScript in the page (promises are awaited, the result is returned by value).",
    { tabId, js: { type: "string" } },
    ["tabId", "js"],
  ),
  tool(
    "console",
    "Console messages and uncaught errors buffered since the bridge attached to the tab.",
    {
      tabId,
      pattern: { type: "string", description: "Regex filter on the message text." },
      clear: { type: "boolean", description: "Empty the buffer after reading." },
      limit: { type: "integer", minimum: 1, description: "Return only the last N (default 200)." },
    },
    ["tabId"],
  ),
  tool(
    "network",
    "Network requests buffered since the bridge attached to the tab: method, URL, status, type.",
    {
      tabId,
      pattern: { type: "string", description: "Regex filter on the URL." },
      clear: { type: "boolean", description: "Empty the buffer after reading." },
      limit: { type: "integer", minimum: 1, description: "Return only the last N (default 200)." },
    },
    ["tabId"],
  ),
  tool("wait", "Sleep for up to 10 seconds.", { ms: { type: "integer", minimum: 0, maximum: 10000 } }, ["ms"], { withProfile: false }),
  tool(
    "dialog",
    "Answer the JavaScript alert/confirm/prompt open in a tab.",
    { tabId, accept: { type: "boolean" }, text: { type: "string", description: "Text for a prompt()." } },
    ["tabId", "accept"],
  ),
];

// Human titles and MCP behaviour hints. Interaction tools can submit forms, so they stay destructive.
const META = {
  list_profiles: ["Chrome: list connected profiles", { readOnlyHint: true, openWorldHint: false }],
  tabs_list: ["Chrome: list tabs", { readOnlyHint: true }],
  tab_open: ["Chrome: open tab", { destructiveHint: false }],
  tab_close: ["Chrome: close tab", { destructiveHint: true, idempotentHint: true }],
  navigate: ["Chrome: navigate tab", { destructiveHint: true }],
  screenshot: ["Chrome: screenshot tab", { readOnlyHint: true }],
  snapshot: ["Chrome: page accessibility snapshot", { readOnlyHint: true }],
  find: ["Chrome: find elements", { readOnlyHint: true }],
  click: ["Chrome: click element", { destructiveHint: true }],
  type: ["Chrome: type text", { destructiveHint: true }],
  key: ["Chrome: press keys", { destructiveHint: true }],
  scroll: ["Chrome: scroll", { destructiveHint: false }],
  fill: ["Chrome: fill form field", { destructiveHint: true }],
  upload: ["Chrome: upload local files", { destructiveHint: true }],
  eval: ["Chrome: run JavaScript in page", { destructiveHint: true }],
  console: ["Chrome: read console log", { readOnlyHint: true }],
  network: ["Chrome: read network log", { readOnlyHint: true }],
  wait: ["Wait (claude-bridge)", { readOnlyHint: true, openWorldHint: false }],
  dialog: ["Chrome: answer JavaScript dialog", { destructiveHint: true }],
};
for (const t of TOOLS) {
  const [title, hints] = META[t.name];
  t.title = title;
  t.annotations = { title, readOnlyHint: false, openWorldHint: true, ...hints };
}

export const TOOL_NAMES = new Set(TOOLS.map((t) => t.name));
