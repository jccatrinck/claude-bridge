// Tiny static server for the fixture pages: node test/fixtures/serve.mjs [port]
// Also writes a 50 MB test file (big.bin) next to the system temp dir on request: --make-big
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".json": "application/json" };

export function makeBigFile(dir = path.join(os.tmpdir(), "claude-bridge-fixture"), mb = 50) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `big-${mb}mb.bin`);
  if (!fs.existsSync(file) || fs.statSync(file).size !== mb * 1024 * 1024) {
    const fd = fs.openSync(file, "w");
    const chunk = Buffer.alloc(1024 * 1024, 0x61);
    for (let i = 0; i < mb; i++) fs.writeSync(fd, chunk);
    fs.closeSync(fd);
  }
  return file;
}

export function serve(port = 0) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    const rel = url.pathname === "/" ? "upload.html" : decodeURIComponent(url.pathname).replace(/^\/+/, "");
    const file = path.resolve(root, rel);
    if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404).end("not found");
      return;
    }
    res.writeHead(200, { "content-type": types[path.extname(file)] ?? "application/octet-stream" });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve(server)));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes("--make-big")) console.log(`50 MB file: ${makeBigFile()}`);
  const port = Number(process.argv.find((a) => /^\d+$/.test(a))) || 47900;
  serve(port).then(() => console.log(`fixture: http://127.0.0.1:${port}/upload.html`));
}
