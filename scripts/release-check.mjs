import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

export const root = fileURLToPath(new URL('../', import.meta.url));
export const readJSON = (path) => JSON.parse(readFileSync(resolve(root, path), 'utf8'));
export const pkg = readJSON('package.json');

export function checkRelease(tag = process.env.RELEASE_TAG) {
  assert.match(pkg.version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/);
  const lock = readJSON('package-lock.json');
  const plugin = readJSON('.codex-plugin/plugin.json');
  for (const [name, version] of Object.entries({
    lockfile: lock.version,
    'lockfile package': lock.packages[''].version,
    plugin: plugin.version,
  }))
    assert.equal(version, pkg.version, `${name} version must match package.json`);
  assert.equal(plugin.name, pkg.name);
  assert.deepEqual([...pkg.bundleDependencies].sort(), Object.keys(pkg.dependencies).sort());
  for (const key of ['composerIcon', 'logo', 'logoDark']) {
    assert.ok(existsSync(resolve(root, plugin.interface[key])), `Missing plugin ${key}`);
  }
  if (tag !== undefined) assert.equal(tag, `v${pkg.version}`, 'Tag must match package version');
  return pkg.version;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(`Release metadata OK: ${checkRelease()}`);
}
