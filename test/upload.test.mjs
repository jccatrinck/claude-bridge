import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { checkUploadPaths, isInside } from "../server/upload.mjs";

let base, root, outside;
before(async () => {
  base = await fs.mkdtemp(path.join(os.tmpdir(), "cb-upload-"));
  root = path.join(base, "root");
  outside = path.join(base, "outside");
  await fs.mkdir(path.join(root, "sub"), { recursive: true });
  await fs.mkdir(outside);
  await fs.writeFile(path.join(root, "a.txt"), "hello");
  await fs.writeFile(path.join(root, "sub", "b.bin"), Buffer.alloc(4096));
  await fs.writeFile(path.join(outside, "secret.txt"), "nope");
});
after(() => fs.rm(base, { recursive: true, force: true }));

test("isInside", () => {
  assert.ok(isInside(path.join(root, "a.txt"), root));
  assert.ok(!isInside(path.join(base, "rootish", "a"), root));
  assert.ok(!isInside(path.join(root, "..", "outside"), root));
});

test("files inside the root pass with names and sizes", async () => {
  const r = await checkUploadPaths([path.join(root, "a.txt"), path.join(root, "sub", "b.bin")], [root]);
  assert.deepEqual(
    r.map((f) => [f.name, f.size]),
    [
      ["a.txt", 5],
      ["b.bin", 4096],
    ],
  );
});

test("files outside the root are refused", async () => {
  await assert.rejects(checkUploadPaths([path.join(outside, "secret.txt")], [root]), { code: "upload_outside_roots" });
  await assert.rejects(checkUploadPaths([path.join(root, "..", "outside", "secret.txt")], [root]), { code: "upload_outside_roots" });
});

test("missing files, folders and bad args", async () => {
  await assert.rejects(checkUploadPaths([path.join(root, "nope.txt")], [root]), { code: "upload_not_found" });
  await assert.rejects(checkUploadPaths([path.join(root, "sub")], [root]), { code: "upload_not_file" });
  await assert.rejects(checkUploadPaths([], [root]), { code: "bad_args" });
  await assert.rejects(checkUploadPaths("x", [root]), { code: "bad_args" });
});

test("symlinks that point out of the root are refused", async (t) => {
  const link = path.join(root, "escape.txt");
  try {
    await fs.symlink(path.join(outside, "secret.txt"), link, "file");
  } catch (e) {
    // Windows without Developer Mode cannot create symlinks; try a junction to a folder instead.
    try {
      await fs.symlink(outside, path.join(root, "jump"), "junction");
    } catch {
      return t.skip(`cannot create links here (${e.code})`);
    }
    await assert.rejects(checkUploadPaths([path.join(root, "jump", "secret.txt")], [root]), { code: "upload_outside_roots" });
    return;
  }
  await assert.rejects(checkUploadPaths([link], [root]), { code: "upload_outside_roots" });
});
