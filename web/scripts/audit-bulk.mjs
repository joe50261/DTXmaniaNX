#!/usr/bin/env node
/**
 * Dependency audit against npm's bulk advisory endpoint.
 *
 * `pnpm audit` (all released versions as of 2026-07) still calls
 * registry.npmjs.org/-/npm/v1/security/audits, which the registry
 * retired with HTTP 410 ("Use the bulk advisory endpoint instead") —
 * that broke both the CI audit gate and the pre-push hook overnight.
 * This script POSTs the exact installed versions from pnpm-lock.yaml
 * to the documented replacement endpoint; the SERVER matches versions
 * against advisory ranges, so no semver logic lives here. Swap back to
 * `pnpm audit` once pnpm targets the new endpoint.
 *
 * Usage: node scripts/audit-bulk.mjs [--audit-level=low|moderate|high|critical]
 * Exit codes: 0 = no advisories at/above the level, 1 = advisories
 * found, 2 = infrastructure failure (endpoint/parse), matching the
 * spirit of `pnpm audit --audit-level`.
 *
 * Network goes through `curl` (child process) rather than fetch() so
 * HTTPS_PROXY / CA-bundle env vars work in sandboxed dev environments
 * without undici agent plumbing.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const BULK_URL = 'https://registry.npmjs.org/-/npm/v1/security/advisories/bulk';
const SEVERITY_RANK = { low: 0, moderate: 1, high: 2, critical: 3 };

const levelArg = process.argv
  .find((a) => a.startsWith('--audit-level='))
  ?.split('=')[1] ?? 'moderate';
if (!(levelArg in SEVERITY_RANK)) {
  console.error(`unknown --audit-level=${levelArg}`);
  process.exit(2);
}
const threshold = SEVERITY_RANK[levelArg];

// ---- 1. Installed (name, version) pairs from pnpm-lock.yaml ----
// lockfileVersion 9: the `packages:` section keys look like
//   '@scope/name@1.2.3':   |   name@1.2.3:   |   name@1.2.3(peer@x):
const lockPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'pnpm-lock.yaml');
const lock = readFileSync(lockPath, 'utf8');
const versionsByName = new Map();
let inPackages = false;
for (const line of lock.split('\n')) {
  if (/^packages:\s*$/.test(line)) {
    inPackages = true;
    continue;
  }
  if (inPackages && /^\S/.test(line)) inPackages = false; // next top-level key
  if (!inPackages) continue;
  const m = /^ {2}'?(.+?)'?:\s*$/.exec(line);
  if (!m) continue;
  const key = m[1].split('(')[0]; // drop peer-dep suffix
  const at = key.lastIndexOf('@');
  if (at <= 0) continue; // no version, or leading @ of a scope
  const name = key.slice(0, at);
  const version = key.slice(at + 1);
  if (!/^\d/.test(version)) continue; // git / tarball deps have no semver
  if (!versionsByName.has(name)) versionsByName.set(name, new Set());
  versionsByName.get(name).add(version);
}
if (versionsByName.size === 0) {
  console.error('audit-bulk: parsed 0 packages from pnpm-lock.yaml — parser broken?');
  process.exit(2);
}

// ---- 2. Ask the registry which submitted versions are advised ----
const body = JSON.stringify(
  Object.fromEntries([...versionsByName].map(([n, vs]) => [n, [...vs]]))
);
let response;
try {
  response = execFileSync(
    'curl',
    ['-sS', '--fail-with-body', '-X', 'POST', '-H', 'content-type: application/json',
     '--data-binary', '@-', BULK_URL],
    { input: body, maxBuffer: 64 * 1024 * 1024, encoding: 'utf8' }
  );
} catch (e) {
  console.error('audit-bulk: bulk advisory request failed:', e.stdout || e.message);
  process.exit(2);
}
let advisories;
try {
  advisories = JSON.parse(response);
} catch {
  console.error('audit-bulk: endpoint returned non-JSON:', response.slice(0, 400));
  process.exit(2);
}

// ---- 3. Threshold + report ----
let failures = 0;
let belowThreshold = 0;
for (const [name, list] of Object.entries(advisories)) {
  for (const adv of list) {
    if ((SEVERITY_RANK[adv.severity] ?? 3) < threshold) {
      belowThreshold++;
      continue;
    }
    failures++;
    const installed = [...(versionsByName.get(name) ?? [])].join(', ');
    console.error(
      `[${adv.severity}] ${name} (installed: ${installed}) — ${adv.title}\n` +
      `  vulnerable: ${adv.vulnerable_versions}  ${adv.url}`
    );
  }
}
console.error(
  `audit-bulk: ${versionsByName.size} packages checked — ` +
  `${failures} advisories at/above '${levelArg}'` +
  (belowThreshold ? `, ${belowThreshold} below threshold` : '')
);
process.exit(failures > 0 ? 1 : 0);
