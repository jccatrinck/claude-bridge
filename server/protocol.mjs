// Shared message shapes between the hub, relays and extensions, plus validation.
//
// extension → hub   { type: "hello", role: "extension", profileId, profileName, version, token, settings? }
// relay     → hub   { type: "hello", role: "relay", token }
// hub       → peer  { type: "welcome", role: "hub", version } | { type: "refused", reason }
// hub       → ext   { type: "request", id, tool, args }
// relay     → hub   { type: "request", id, tool, args, profile? }
// any       → any   { type: "response", id, ok: true, result } | { type: "response", id, ok: false, error: { code, message } }
// any       → any   { type: "ping" } / { type: "pong" }

export const PROTOCOL_VERSION = 1;
export const DEFAULT_PORT = 47811;
export const HELLO_TIMEOUT_MS = 5000;

export class BridgeError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
  toJSON() {
    return { code: this.code, message: this.message };
  }
}

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const isStr = (v) => typeof v === "string" && v.length > 0;

/** Parse a raw socket frame. Throws BridgeError("bad_message") on anything malformed. */
export function parseMessage(raw) {
  let msg;
  try {
    msg = JSON.parse(typeof raw === "string" ? raw : raw.toString("utf8"));
  } catch {
    throw new BridgeError("bad_message", "message is not valid JSON");
  }
  validateMessage(msg);
  return msg;
}

export function validateMessage(msg) {
  const fail = (why) => {
    throw new BridgeError("bad_message", why);
  };
  if (!isObj(msg)) fail("message must be an object");
  switch (msg.type) {
    case "hello":
      if (msg.role !== "extension" && msg.role !== "relay") fail("hello.role must be 'extension' or 'relay'");
      if (typeof msg.token !== "string") fail("hello.token must be a string");
      if (msg.role === "extension") {
        if (!isStr(msg.profileId)) fail("hello.profileId is required");
        if (!isStr(msg.profileName)) fail("hello.profileName is required");
        if (!/^[\w.-]{1,64}$/.test(msg.profileName)) fail("hello.profileName may only contain letters, digits, '.', '_' and '-'");
        if (typeof msg.version !== "string") fail("hello.version must be a string");
        if (msg.settings !== undefined && !isObj(msg.settings)) fail("hello.settings must be an object");
      }
      break;
    case "welcome":
    case "refused":
    case "ping":
    case "pong":
      break;
    case "request":
      if (!isStr(msg.id)) fail("request.id is required");
      if (!isStr(msg.tool)) fail("request.tool is required");
      if (msg.args !== undefined && !isObj(msg.args)) fail("request.args must be an object");
      if (msg.profile !== undefined && msg.profile !== null && typeof msg.profile !== "string") fail("request.profile must be a string");
      break;
    case "response":
      if (!isStr(msg.id)) fail("response.id is required");
      if (typeof msg.ok !== "boolean") fail("response.ok must be a boolean");
      if (!msg.ok && !(isObj(msg.error) && typeof msg.error.message === "string")) fail("response.error.message is required");
      break;
    default:
      fail(`unknown message type ${JSON.stringify(msg.type)}`);
  }
  return msg;
}

export function errorResponse(id, err) {
  const code = err?.code ?? "error";
  const message = err?.message ?? String(err);
  return { type: "response", id, ok: false, error: { code, message } };
}

export function okResponse(id, result) {
  return { type: "response", id, ok: true, result };
}

/** Normalise extension settings that the hub cares about. */
export function normaliseSettings(settings) {
  const s = isObj(settings) ? settings : {};
  const list = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === "string" && x.trim()).map((x) => x.trim()) : []);
  return { uploadRoots: list(s.uploadRoots), blockedSites: list(s.blockedSites) };
}

/**
 * Pick the profile a tool call goes to.
 * profiles: array of { profileName, profileId }.
 */
export function resolveProfile(profiles, requested) {
  const names = profiles.map((p) => p.profileName).sort();
  if (requested) {
    const hit = profiles.find((p) => p.profileName === requested) ?? profiles.find((p) => p.profileId === requested);
    if (hit) return hit;
    throw new BridgeError(
      "unknown_profile",
      names.length
        ? `No connected profile named "${requested}". Connected: ${names.join(", ")}.`
        : `No connected profile named "${requested}". No profiles are connected: open Chrome with the claude-bridge extension and set its profile name and pairing token.`,
    );
  }
  if (profiles.length === 1) return profiles[0];
  if (profiles.length === 0) {
    throw new BridgeError(
      "no_profiles",
      "No Chrome profiles are connected. Open Chrome with the claude-bridge extension and set its profile name and pairing token in the extension options.",
    );
  }
  throw new BridgeError("ambiguous_profile", `Several profiles are connected; pass "profile" with one of: ${names.join(", ")}.`);
}
