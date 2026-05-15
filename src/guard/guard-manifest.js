import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const MANIFEST_FILE = resolve(MODULE_DIR, '..', '..', 'config', 'guard-controls.json');

let cache = null;

export function loadGuardControlManifest() {
  if (!cache) cache = JSON.parse(readFileSync(MANIFEST_FILE, 'utf8'));
  return cache;
}

export function resetGuardControlManifestCache() {
  cache = null;
}

export function guardControlMeta(category) {
  return loadGuardControlManifest().categories?.[category] ?? null;
}
