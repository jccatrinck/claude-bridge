// Path checks for the `upload` tool. Chrome reads the files itself; we only make
// sure every path is a readable regular file that really lives inside an upload root.

import fs from "node:fs/promises";
import { constants as FS } from "node:fs";
import os from "node:os";
import path from "node:path";
import { BridgeError } from "./protocol.mjs";

const caseInsensitive = process.platform === "win32" || process.platform === "darwin";

function norm(p) {
  const n = path.resolve(p);
  return caseInsensitive ? n.toLowerCase() : n;
}

export function isInside(child, root) {
  const c = norm(child);
  const r = norm(root);
  if (c === r) return true;
  const rel = path.relative(r, c);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/**
 * @param {string[]} paths  requested paths (absolute, or relative to cwd)
 * @param {string[]} roots  allowed folders; empty means the user's home folder
 * @returns {Promise<{ path: string, name: string, size: number }[]>} resolved real paths
 */
export async function checkUploadPaths(paths, roots) {
  if (!Array.isArray(paths) || paths.length === 0 || !paths.every((p) => typeof p === "string" && p)) {
    throw new BridgeError("bad_args", "upload needs `paths`: a non-empty array of file paths");
  }
  const rootList = roots && roots.length ? roots : [os.homedir()];
  const realRoots = [];
  for (const r of rootList) {
    try {
      realRoots.push(await fs.realpath(r));
    } catch {
      // A missing root simply allows nothing.
    }
  }
  const out = [];
  for (const p of paths) {
    let real;
    try {
      real = await fs.realpath(path.resolve(p));
    } catch {
      throw new BridgeError("upload_not_found", `File not found: ${p}`);
    }
    if (!realRoots.some((r) => isInside(real, r))) {
      throw new BridgeError(
        "upload_outside_roots",
        `${p} is outside the upload roots (${rootList.join("; ")}). Add its folder under "Upload roots" in the extension options.`,
      );
    }
    const st = await fs.stat(real);
    if (!st.isFile()) throw new BridgeError("upload_not_file", `Not a regular file: ${p}`);
    try {
      await fs.access(real, FS.R_OK);
    } catch {
      throw new BridgeError("upload_unreadable", `File is not readable: ${p}`);
    }
    out.push({ path: real, name: path.basename(real), size: st.size });
  }
  return out;
}
