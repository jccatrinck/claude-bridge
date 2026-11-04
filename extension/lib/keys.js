// Parse key chords like "ctrl+a", "shift+Enter", "ArrowDown" into CDP Input.dispatchKeyEvent params.

export const MODIFIER_BITS = { alt: 1, ctrl: 2, meta: 4, shift: 8 };
const MODIFIER_ALIASES = {
  alt: "alt",
  option: "alt",
  ctrl: "ctrl",
  control: "ctrl",
  meta: "meta",
  cmd: "meta",
  command: "meta",
  win: "meta",
  super: "meta",
  shift: "shift",
};
export const MODIFIER_KEYS = {
  alt: { key: "Alt", code: "AltLeft", keyCode: 18 },
  ctrl: { key: "Control", code: "ControlLeft", keyCode: 17 },
  meta: { key: "Meta", code: "MetaLeft", keyCode: 91 },
  shift: { key: "Shift", code: "ShiftLeft", keyCode: 16 },
};

const NAMED = {
  enter: { key: "Enter", code: "Enter", keyCode: 13, text: "\r" },
  return: { key: "Enter", code: "Enter", keyCode: 13, text: "\r" },
  tab: { key: "Tab", code: "Tab", keyCode: 9 },
  backspace: { key: "Backspace", code: "Backspace", keyCode: 8 },
  delete: { key: "Delete", code: "Delete", keyCode: 46 },
  del: { key: "Delete", code: "Delete", keyCode: 46 },
  escape: { key: "Escape", code: "Escape", keyCode: 27 },
  esc: { key: "Escape", code: "Escape", keyCode: 27 },
  space: { key: " ", code: "Space", keyCode: 32, text: " " },
  arrowup: { key: "ArrowUp", code: "ArrowUp", keyCode: 38 },
  arrowdown: { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
  arrowleft: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 },
  arrowright: { key: "ArrowRight", code: "ArrowRight", keyCode: 39 },
  up: { key: "ArrowUp", code: "ArrowUp", keyCode: 38 },
  down: { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
  left: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 },
  right: { key: "ArrowRight", code: "ArrowRight", keyCode: 39 },
  home: { key: "Home", code: "Home", keyCode: 36 },
  end: { key: "End", code: "End", keyCode: 35 },
  pageup: { key: "PageUp", code: "PageUp", keyCode: 33 },
  pagedown: { key: "PageDown", code: "PageDown", keyCode: 34 },
  insert: { key: "Insert", code: "Insert", keyCode: 45 },
};
for (let i = 1; i <= 12; i++) NAMED[`f${i}`] = { key: `F${i}`, code: `F${i}`, keyCode: 111 + i };

const PUNCT = {
  "-": ["Minus", 189],
  "=": ["Equal", 187],
  "[": ["BracketLeft", 219],
  "]": ["BracketRight", 221],
  "\\": ["Backslash", 220],
  ";": ["Semicolon", 186],
  "'": ["Quote", 222],
  ",": ["Comma", 188],
  ".": ["Period", 190],
  "/": ["Slash", 191],
  "`": ["Backquote", 192],
};

function single(ch) {
  if (/^[a-z]$/i.test(ch)) return { key: ch, code: `Key${ch.toUpperCase()}`, keyCode: ch.toUpperCase().charCodeAt(0), text: ch };
  if (/^[0-9]$/.test(ch)) return { key: ch, code: `Digit${ch}`, keyCode: ch.charCodeAt(0), text: ch };
  if (PUNCT[ch]) return { key: ch, code: PUNCT[ch][0], keyCode: PUNCT[ch][1], text: ch };
  return { key: ch, code: "", keyCode: 0, text: ch };
}

/** "ctrl+shift+a" → { modifiers: ["ctrl","shift"], modifierBits: 10, key, code, keyCode, text? } */
export function parseChord(chord) {
  const parts = chord.split("+");
  // "ctrl++" means ctrl and the plus key
  if (chord.endsWith("++")) parts.splice(parts.length - 2, 2, "+");
  const keyPart = parts.pop();
  if (!keyPart) throw new Error(`Bad key chord "${chord}"`);
  const modifiers = [];
  for (const m of parts) {
    const mod = MODIFIER_ALIASES[m.toLowerCase()];
    if (!mod) throw new Error(`Unknown modifier "${m}" in "${chord}". Use alt, ctrl, meta or shift.`);
    if (!modifiers.includes(mod)) modifiers.push(mod);
  }
  let def;
  const lower = keyPart.toLowerCase();
  if (NAMED[lower]) def = { ...NAMED[lower] };
  else if (MODIFIER_ALIASES[lower]) def = { ...MODIFIER_KEYS[MODIFIER_ALIASES[lower]] };
  else if ([...keyPart].length === 1) def = single(keyPart);
  else throw new Error(`Unknown key "${keyPart}" in "${chord}".`);

  if (modifiers.includes("shift") && def.text && /^[a-z]$/.test(def.text)) {
    def.key = def.text.toUpperCase();
    def.text = def.key;
  }
  // With ctrl/alt/meta held, a key produces a command, not text.
  if (modifiers.some((m) => m !== "shift")) delete def.text;
  const modifierBits = modifiers.reduce((b, m) => b | MODIFIER_BITS[m], 0);
  return { modifiers, modifierBits, ...def };
}

/** "ctrl+a Backspace" → array of chords */
export function parseKeys(keys) {
  const list = String(keys).trim().split(/\s+/).filter(Boolean);
  if (!list.length) throw new Error("No keys given.");
  return list.map(parseChord);
}

/** Expand a parsed chord into the sequence of Input.dispatchKeyEvent params. */
export function keyEvents(chord) {
  const events = [];
  let bits = 0;
  for (const m of chord.modifiers) {
    bits |= MODIFIER_BITS[m];
    const k = MODIFIER_KEYS[m];
    events.push({ type: "rawKeyDown", modifiers: bits, key: k.key, code: k.code, windowsVirtualKeyCode: k.keyCode });
  }
  const base = { modifiers: bits, key: chord.key, code: chord.code, windowsVirtualKeyCode: chord.keyCode };
  if (chord.text) events.push({ type: "keyDown", ...base, text: chord.text, unmodifiedText: chord.text });
  else events.push({ type: "rawKeyDown", ...base });
  events.push({ type: "keyUp", ...base });
  for (const m of [...chord.modifiers].reverse()) {
    bits &= ~MODIFIER_BITS[m];
    const k = MODIFIER_KEYS[m];
    events.push({ type: "keyUp", modifiers: bits, key: k.key, code: k.code, windowsVirtualKeyCode: k.keyCode });
  }
  return events;
}
