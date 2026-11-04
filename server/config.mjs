// Where the bridge keeps its state, the pairing token, and which extension origins may connect.

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_PORT } from "./protocol.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));

export function dataDir() {
  if (process.env.CLAUDE_BRIDGE_DIR) return process.env.CLAUDE_BRIDGE_DIR;
  if (process.platform === "win32" && process.env.APPDATA) return path.join(process.env.APPDATA, "claude-bridge");
  if (process.platform === "darwin") return path.join(os.homedir(), "Library", "Application Support", "claude-bridge");
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "claude-bridge");
}

export function hubPort() {
  const p = Number(process.env.CLAUDE_BRIDGE_PORT);
  return Number.isInteger(p) && p > 0 && p < 65536 ? p : DEFAULT_PORT;
}

/** Read the pairing token, creating it on first run. Safe if several processes race. */
export function ensureToken(dir = dataDir()) {
  const file = path.join(dir, "token");
  try {
    const t = fs.readFileSync(file, "utf8").trim();
    if (t) return t;
  } catch {
    // fall through and create it
  }
  fs.mkdirSync(dir, { recursive: true });
  const token = crypto.randomBytes(24).toString("base64url");
  try {
    fs.writeFileSync(file, token + "\n", { flag: "wx", mode: 0o600 });
    return token;
  } catch (e) {
    if (e.code === "EEXIST") return fs.readFileSync(file, "utf8").trim();
    throw e;
  }
}

export function tokenPath(dir = dataDir()) {
  return path.join(dir, "token");
}

/** Chrome derives an extension id from the manifest `key`: sha256 of the DER key, first 32 hex digits mapped 0-f → a-p. */
export function extensionIdFromKey(base64Key) {
  const hex = crypto.createHash("sha256").update(Buffer.from(base64Key, "base64")).digest("hex").slice(0, 32);
  return [...hex].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join("");
}

/** Origins allowed to open a socket: the pinned unpacked id, plus any in CLAUDE_BRIDGE_EXTENSION_IDS (e.g. a Web Store id). */
export function allowedOrigins() {
  const ids = new Set();
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(here, "..", "extension", "manifest.json"), "utf8"));
    if (manifest.key) ids.add(extensionIdFromKey(manifest.key));
  } catch {
    // running without the extension folder next to us
  }
  for (const id of (process.env.CLAUDE_BRIDGE_EXTENSION_IDS || "").split(",")) {
    if (id.trim()) ids.add(id.trim());
  }
  return [...ids].map((id) => `chrome-extension://${id}`);
}
