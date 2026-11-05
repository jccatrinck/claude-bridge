#!/usr/bin/env node
// Keeps extension/manifest.json in step with package.json.
//   node scripts/sync-version.mjs              copy package.json "version" into the manifest
//   node scripts/sync-version.mjs --check v1.2.3   fail unless the tag, package.json and manifest agree
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const pkgPath = `${root}package.json`;
const manifestPath = `${root}extension/manifest.json`;

const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
const manifestText = readFileSync(manifestPath, "utf8");
const manifest = JSON.parse(manifestText);

// Chrome only accepts 1–4 dot-separated integers, so no "-beta" suffixes.
if (!/^\d+(\.\d+){0,3}$/.test(pkg.version)) {
  console.error(`package.json version "${pkg.version}" is not a valid Chrome extension version (use e.g. 1.2.3).`);
  process.exit(1);
}

const checkIndex = process.argv.indexOf("--check");
if (checkIndex !== -1) {
  const tag = process.argv[checkIndex + 1] ?? "";
  const tagVersion = tag.replace(/^v/, "");
  const problems = [];
  if (tagVersion !== pkg.version) problems.push(`tag ${tag} != package.json ${pkg.version}`);
  if (manifest.version !== pkg.version) problems.push(`extension/manifest.json ${manifest.version} != package.json ${pkg.version}`);
  if (problems.length) {
    console.error(`Version mismatch: ${problems.join("; ")}.`);
    process.exit(1);
  }
  console.log(`Versions agree: ${pkg.version}`);
  process.exit(0);
}

if (manifest.version === pkg.version) {
  console.log(`extension/manifest.json already at ${pkg.version}`);
} else {
  // Replace only the version line so the rest of the manifest keeps its formatting.
  const updated = manifestText.replace(/("version"\s*:\s*)"[^"]*"/, `$1"${pkg.version}"`);
  writeFileSync(manifestPath, updated);
  console.log(`extension/manifest.json ${manifest.version} -> ${pkg.version}`);
}
