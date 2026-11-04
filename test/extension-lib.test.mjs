import assert from "node:assert/strict";
import { test } from "node:test";
import { keyEvents, parseChord, parseKeys } from "../extension/lib/keys.js";
import { blockedBy } from "../extension/lib/match.js";
import { RefMap, findInAXTree, renderAXTree } from "../extension/lib/snapshot.js";

// A mocked Accessibility.getFullAXTree result.
const ax = (nodeId, role, name, extra = {}) => ({ nodeId: String(nodeId), role: { type: "role", value: role }, name: { type: "computedString", value: name }, ...extra });
const TREE = [
  ax(1, "RootWebArea", "Fixture", { childIds: ["2", "3", "8"], backendDOMNodeId: 100 }),
  ax(2, "heading", "Upload test", { parentId: "1", childIds: ["20"], backendDOMNodeId: 101, properties: [{ name: "level", value: { type: "integer", value: 1 } }] }),
  ax(20, "StaticText", "Upload test", { parentId: "2", backendDOMNodeId: 201 }),
  ax(3, "generic", "", { parentId: "1", childIds: ["4", "5", "6"], backendDOMNodeId: 102 }),
  ax(4, "textbox", "Caption", { parentId: "3", backendDOMNodeId: 103, value: { type: "string", value: "hi" }, properties: [{ name: "focused", value: { type: "boolean", value: true } }] }),
  ax(5, "button", "Send", { parentId: "3", backendDOMNodeId: 104, childIds: ["50"] }),
  ax(50, "StaticText", "Send", { parentId: "5", backendDOMNodeId: 204 }),
  ax(6, "paragraph", "", { parentId: "3", backendDOMNodeId: 105, childIds: ["60"] }),
  ax(60, "StaticText", "Pick a file to send", { parentId: "6", backendDOMNodeId: 205, childIds: ["61"] }),
  ax(61, "InlineTextBox", "Pick a file to send", { parentId: "60" }),
  ax(8, "checkbox", "Agree", { parentId: "1", backendDOMNodeId: 106, ignored: false, properties: [{ name: "checked", value: { type: "tristate", value: "false" } }] }),
];

test("renderAXTree: indented tree with refs mapped to backendNodeIds", () => {
  const refs = new RefMap();
  const { text } = renderAXTree(TREE, refs);
  const lines = text.split("\n");
  assert.equal(lines[0], '- RootWebArea "Fixture" [ref=e1]');
  assert.equal(lines[1], '  - heading "Upload test" [level=1] [ref=e2]');
  assert.ok(lines.includes('  - textbox "Caption" value="hi" [focused] [ref=e3]'), text);
  assert.ok(lines.includes('  - button "Send" [ref=e4]'));
  assert.ok(lines.includes('    - StaticText "Pick a file to send"'), "text nodes render without refs");
  assert.ok(!text.includes("InlineTextBox"));
  assert.ok(!text.includes("generic"), "generic containers are transparent");
  assert.ok(!/StaticText "Send"/.test(text), "text that repeats its parent's name is dropped");
  assert.equal(refs.backendFor("e3"), 103);
  assert.equal(refs.backendFor("e4"), 104);
});

test("refs stay stable across snapshots and die after clear()", () => {
  const refs = new RefMap();
  renderAXTree(TREE, refs);
  const before = refs.refFor(104);
  renderAXTree(TREE, refs);
  assert.equal(refs.refFor(104), before);
  refs.clear();
  assert.equal(refs.backendFor(before), undefined);
  assert.notEqual(refs.refFor(104), before, "new refs never reuse old numbers");
});

test("interactiveOnly flattens to interactive nodes", () => {
  const { text } = renderAXTree(TREE, new RefMap(), { interactiveOnly: true });
  assert.deepEqual(text.split("\n"), ['- textbox "Caption" value="hi" [focused] [ref=e1]', '- button "Send" [ref=e2]', '- checkbox "Agree" [ref=e3]']);
});

test("maxChars truncates", () => {
  const r = renderAXTree(TREE, new RefMap(), { maxChars: 60 });
  assert.ok(r.truncated);
  assert.match(r.text, /truncated/);
});

test("findInAXTree matches name, role and value; text hits resolve to their element", () => {
  const refs = new RefMap();
  const send = findInAXTree(TREE, refs, "send");
  assert.equal(send[0].role, "button");
  assert.equal(refs.backendFor(send[0].ref), 104);
  const para = send.find((h) => h.role === "paragraph");
  assert.equal(para.text, "Pick a file to send");
  assert.equal(refs.backendFor(para.ref), 105);
  assert.equal(findInAXTree(TREE, refs, "checkbox")[0].name, "Agree");
  assert.equal(findInAXTree(TREE, refs, "hi")[0].role, "textbox");
  assert.deepEqual(findInAXTree(TREE, refs, "zzz"), []);
});

test("parseChord", () => {
  assert.deepEqual(parseChord("Enter"), { modifiers: [], modifierBits: 0, key: "Enter", code: "Enter", keyCode: 13, text: "\r" });
  const ca = parseChord("ctrl+a");
  assert.equal(ca.modifierBits, 2);
  assert.equal(ca.text, undefined);
  assert.equal(ca.keyCode, 65);
  assert.equal(parseChord("shift+a").key, "A");
  assert.equal(parseChord("shift+Enter").modifierBits, 8);
  assert.equal(parseChord("ctrl++").key, "+");
  assert.throws(() => parseChord("hyper+a"), /modifier/);
  assert.throws(() => parseChord("Foo"), /Unknown key/);
  assert.equal(parseKeys("ctrl+a Backspace").length, 2);
});

test("keyEvents presses and releases modifiers around the key", () => {
  const ev = keyEvents(parseChord("ctrl+shift+k"));
  assert.deepEqual(
    ev.map((e) => [e.type, e.key, e.modifiers]),
    [
      ["rawKeyDown", "Control", 2],
      ["rawKeyDown", "Shift", 10],
      ["rawKeyDown", "K", 10],
      ["keyUp", "K", 10],
      ["keyUp", "Shift", 2],
      ["keyUp", "Control", 0],
    ],
  );
  const enter = keyEvents(parseChord("Enter"));
  assert.equal(enter[0].type, "keyDown");
  assert.equal(enter[0].text, "\r");
});

test("blockedBy", () => {
  const p = ["mybank.com", "*.corp.example", "https://mail.example.com/secret/*"];
  assert.equal(blockedBy("https://mybank.com/login", p), "mybank.com");
  assert.equal(blockedBy("https://www.mybank.com/", p), "mybank.com");
  assert.equal(blockedBy("https://notmybank.com/", p), null);
  assert.equal(blockedBy("https://a.corp.example/x", p), "*.corp.example");
  assert.equal(blockedBy("https://corp.example/x", p), null);
  assert.equal(blockedBy("https://mail.example.com/secret/inbox", p), "https://mail.example.com/secret/*");
  assert.equal(blockedBy("https://mail.example.com/public", p), null);
  assert.equal(blockedBy("https://x.com", ["https://x.com"]), "https://x.com");
  assert.equal(blockedBy("http://x.com", ["https://x.com"]), null);
  assert.equal(blockedBy("about:blank", p), null);
  assert.equal(blockedBy("https://a.com", []), null);
});
