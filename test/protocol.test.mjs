import assert from "node:assert/strict";
import { test } from "node:test";
import { BridgeError, normaliseSettings, parseMessage, resolveProfile, validateMessage } from "../server/protocol.mjs";

test("parseMessage accepts a valid extension hello", () => {
  const msg = parseMessage(
    JSON.stringify({ type: "hello", role: "extension", profileId: "u1", profileName: "personal", version: "0.1.0", token: "t" }),
  );
  assert.equal(msg.profileName, "personal");
});

test("parseMessage rejects junk", () => {
  assert.throws(() => parseMessage("{not json"), { code: "bad_message" });
  assert.throws(() => parseMessage("[]"), { code: "bad_message" });
  assert.throws(() => parseMessage(JSON.stringify({ type: "nope" })), /unknown message type/);
});

test("hello validation", () => {
  const base = { type: "hello", role: "extension", profileId: "u1", profileName: "p", version: "1", token: "t" };
  assert.doesNotThrow(() => validateMessage(base));
  assert.throws(() => validateMessage({ ...base, role: "admin" }), /role/);
  assert.throws(() => validateMessage({ ...base, profileName: "" }), /profileName/);
  assert.throws(() => validateMessage({ ...base, profileName: "has space" }), /profileName/);
  assert.throws(() => validateMessage({ ...base, token: undefined }), /token/);
  assert.doesNotThrow(() => validateMessage({ type: "hello", role: "relay", token: "t" }));
});

test("request and response validation", () => {
  assert.doesNotThrow(() => validateMessage({ type: "request", id: "1", tool: "tabs_list", args: {} }));
  assert.throws(() => validateMessage({ type: "request", id: "1" }), /tool/);
  assert.throws(() => validateMessage({ type: "request", id: "1", tool: "x", args: [] }), /args/);
  assert.doesNotThrow(() => validateMessage({ type: "response", id: "1", ok: true, result: 1 }));
  assert.throws(() => validateMessage({ type: "response", id: "1", ok: false }), /error/);
});

test("normaliseSettings keeps only string lists", () => {
  assert.deepEqual(normaliseSettings({ uploadRoots: [" D:\\x ", 3, ""], blockedSites: "x" }), { uploadRoots: ["D:\\x"], blockedSites: [] });
  assert.deepEqual(normaliseSettings(undefined), { uploadRoots: [], blockedSites: [] });
});

test("resolveProfile rules", () => {
  const a = { profileName: "a", profileId: "ida" };
  const b = { profileName: "b", profileId: "idb" };
  assert.equal(resolveProfile([a], undefined), a);
  assert.equal(resolveProfile([a, b], "b"), b);
  assert.equal(resolveProfile([a, b], "idb"), b);
  assert.throws(() => resolveProfile([], undefined), { code: "no_profiles" });
  assert.throws(() => resolveProfile([a, b], undefined), (e) => e instanceof BridgeError && e.code === "ambiguous_profile" && /a, b/.test(e.message));
  assert.throws(() => resolveProfile([a, b], "c"), { code: "unknown_profile" });
});
