#!/usr/bin/env node
// Fails when any installed npm dependency uses a copyleft license (GPL, AGPL, LGPL, SSPL, EUPL).
import { execFileSync } from "node:child_process";

const DENY = /\b(A?GPL|LGPL|SSPL|EUPL)\b/i;
const raw = execFileSync("pnpm", ["licenses", "list", "--json", "--prod"], { encoding: "utf8" });
const byLicense = JSON.parse(raw);
const bad = [];
for (const [license, pkgs] of Object.entries(byLicense)) {
  if (!DENY.test(license)) continue;
  for (const p of pkgs) bad.push(`${p.name}@${(p.versions ?? [p.version]).join(",")} (${license})`);
}
if (bad.length) {
  console.error(`Copyleft dependencies are not allowed:\n  ${bad.join("\n  ")}`);
  process.exit(1);
}
console.log(`licenses ok (${Object.keys(byLicense).length} license kinds checked)`);
