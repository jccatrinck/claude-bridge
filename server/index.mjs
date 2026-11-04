#!/usr/bin/env node
// claude-bridge MCP stdio server. One process per MCP client; the first one becomes the hub.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { allowedOrigins, ensureToken, hubPort, tokenPath } from "./config.mjs";
import { Bridge } from "./hub.mjs";
import { TOOLS, TOOL_NAMES } from "./tools.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(fs.readFileSync(path.join(here, "..", "package.json"), "utf8"));
const log = (m) => process.stderr.write(`[claude-bridge] ${m}\n`);

const HINTS = {
  no_profiles: `The pairing token is in ${tokenPath()}.`,
  hub_unavailable: "Another program may be using the port; set CLAUDE_BRIDGE_PORT (and the same port in the extension options).",
  not_allowed:
    'For uploads, open chrome://extensions → claude-bridge → Details and turn on "Allow access to file URLs", which Chrome requires before an extension may hand local files to a page.',
};

export const INSTRUCTIONS = [
  "claude-bridge drives the user's real Chrome (their own profiles and sign-ins) through a paired extension.",
  'Workflow: list_profiles → tab_open (returns tabId) → snapshot or find (returns refs like "e12") → click / type / fill / upload by ref → screenshot to verify.',
  "Pass `profile` on every call when more than one profile is connected; calls without it fail and list the names.",
  'Work in tabs you opened. tabs_list shows only the "Claude" tab group unless all: true.',
  "If an action reports dialogOpened, answer it with the dialog tool before anything else in that tab.",
  "upload takes absolute local file paths (no size limit) and works on a file input or on the button that opens a file chooser.",
].join("\n");

const noProfilesText = () =>
  `No Chrome profiles are connected. In Chrome, open the claude-bridge extension options, set a profile name and paste the pairing token from ${tokenPath()}. Then call list_profiles again.`;

const NEXT = {
  tab_open: () => "Call snapshot (or find) with this tabId to get element refs.",
  list_profiles: (r) => (r.length > 1 ? `Pass profile: "<name>" on every call (one of: ${r.map((p) => p.name).join(", ")}).` : undefined),
  snapshot: () => "Use the refs with click / type / fill / upload. Refs reset when the page navigates.",
};

export function formatResult(tool, result) {
  if (tool === "list_profiles" && Array.isArray(result) && result.length === 0) return { content: [{ type: "text", text: noProfilesText() }] };
  const next = NEXT[tool]?.(result);
  if (next) {
    if (Array.isArray(result)) result = { profiles: result, next };
    else if (result && typeof result.text === "string") result = { text: `${result.text}\n\n# next: ${next}` };
    else if (result && typeof result === "object") result = { ...result, next };
  }
  if (tool === "screenshot" && result?.data) {
    const { data, mimeType = "image/jpeg", ...meta } = result;
    return { content: [{ type: "image", data, mimeType }, { type: "text", text: JSON.stringify(meta) }] };
  }
  if (typeof result === "string") return { content: [{ type: "text", text: result }] };
  if (result && typeof result.text === "string" && Object.keys(result).length === 1) return { content: [{ type: "text", text: result.text }] };
  return { content: [{ type: "text", text: JSON.stringify(result ?? null, null, 2) }] };
}

export function formatError(err) {
  const code = err?.code ?? "error";
  const hint = HINTS[code] ? `\n${HINTS[code]}` : "";
  return { isError: true, content: [{ type: "text", text: `${err?.message ?? String(err)}${hint}` }] };
}

async function main() {
  const token = ensureToken();
  const bridge = new Bridge({ port: hubPort(), token, allowedOrigins: allowedOrigins(), log });
  bridge.start().catch((e) => log(`startup failed: ${e.message}`));

  const server = new Server({ name: "claude-bridge", version: pkg.version }, { capabilities: { tools: {} }, instructions: INSTRUCTIONS });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const name = req.params.name;
    const { profile, ...args } = req.params.arguments ?? {};
    if (!TOOL_NAMES.has(name)) return formatError(new Error(`Unknown tool "${name}".`));
    try {
      if (name === "wait") {
        const ms = Math.max(0, Math.min(10_000, Number(args.ms) || 0));
        await new Promise((r) => setTimeout(r, ms));
        return formatResult(name, `waited ${ms} ms`);
      }
      return formatResult(name, await bridge.call(name, args, profile));
    } catch (e) {
      return formatError(e);
    }
  });

  const transport = new StdioServerTransport();
  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    await bridge.close().catch(() => {});
    process.exit(0);
  };
  transport.onclose = shutdown;
  process.stdin.on("end", shutdown);
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  await server.connect(transport);
  log(`MCP server ready (pid ${process.pid})`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    log(e.stack ?? String(e));
    process.exit(1);
  });
}
