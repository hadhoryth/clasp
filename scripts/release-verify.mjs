import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkRelease, pkg, root } from './release-check.mjs';

const version = checkRelease();
const name = `${pkg.name}-${version}`;
const output = join(root, 'release');
const temporary = mkdtempSync(join(tmpdir(), 'clasp-install-'));
const run = (exe, args, cwd = temporary) => execFileSync(exe, args, { cwd, encoding: 'utf8' });
const smoke = (command, packageRoot) => {
  assert.equal(run(command, ['--version']).trim(), `clasp ${version}`);
  assert.match(run(command, ['--help']), /Usage:/);
  for (const path of [
    'assets/logo.png',
    '.codex-plugin/plugin.json',
    'skills/clasp/SKILL.md',
    'scripts/permission-hook.mjs',
    'LICENSE',
  ]) {
    assert.ok(existsSync(join(packageRoot, path)), `Missing packaged file: ${path}`);
  }
  const manifest = JSON.parse(readFileSync(join(packageRoot, '.codex-plugin/plugin.json')));
  assert.equal(manifest.version, version);
  assert.ok(!existsSync(join(packageRoot, 'node_modules/typescript')), 'Do not ship build tools');
};
try {
  const checksums = readFileSync(join(output, 'SHA256SUMS.txt'), 'utf8').trim().split('\n');
  assert.equal(checksums.length, 2);
  for (const [index, extension] of ['tgz', 'zip'].entries()) {
    const filename = `${name}.${extension}`;
    const hash = createHash('sha256')
      .update(readFileSync(join(output, filename)))
      .digest('hex');
    assert.equal(checksums[index], `${hash}  ${filename}`);
  }
  const prefix = join(temporary, 'installed');
  // Empty cache + offline install proves the tarball includes its dependency tree.
  run('npm', [
    'install',
    '--global',
    '--prefix',
    prefix,
    '--cache',
    join(temporary, 'empty-cache'),
    '--offline',
    '--ignore-scripts',
    '--no-audit',
    '--no-fund',
    join(output, `${name}.tgz`),
  ]);
  smoke(join(prefix, 'bin/clasp'), join(prefix, 'lib/node_modules', pkg.name));
  const extracted = join(temporary, 'extracted');
  mkdirSync(extracted);
  run('unzip', ['-q', join(output, `${name}.zip`), '-d', extracted]);
  smoke(join(extracted, name, 'clasp'), join(extracted, name));
  console.log(
    'PASS: checksums, offline package installation, portable ZIP, CLI, and plugin assets.',
  );
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
