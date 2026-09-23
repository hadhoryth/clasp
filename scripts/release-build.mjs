import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkRelease, pkg, root } from './release-check.mjs';

const version = checkRelease();
const name = `${pkg.name}-${version}`;
const output = join(root, 'release');
const staging = mkdtempSync(join(tmpdir(), 'clasp-release-'));
mkdirSync(output, { recursive: true });
const run = (command, args, cwd = root) => execFileSync(command, args, { cwd, stdio: 'inherit' });
try {
  // npm's prepack builds TypeScript. Only production dependencies are bundled.
  run('npm', ['pack', '--pack-destination', staging]);
  const tgz = `${name}.tgz`;
  run('tar', ['-xzf', join(staging, tgz), '-C', staging]);
  renameSync(join(staging, 'package'), join(staging, name));
  writeFileSync(
    join(staging, name, 'clasp'),
    '#!/bin/sh\nset -eu\nexec node "$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)/bin/clasp.js" "$@"\n',
    { mode: 0o755 },
  );
  run('zip', ['-q', '-r', join(staging, `${name}.zip`), name], staging);
  const files = [tgz, `${name}.zip`];
  const checksums = files.map((file) => {
    const hash = createHash('sha256')
      .update(readFileSync(join(staging, file)))
      .digest('hex');
    renameSync(join(staging, file), join(output, file));
    return `${hash}  ${file}`;
  });
  writeFileSync(join(output, 'SHA256SUMS.txt'), checksums.join('\n') + '\n');
  writeFileSync(
    join(output, 'release-notes.md'),
    `## Experimental release ${version}

Run Claude Code through a local gateway backed by your Codex ChatGPT login.

### Install

Requires Node.js 22+, Codex CLI, and Claude Code. macOS and Linux are covered by CI.

- **Installable package:** download \`${name}.tgz\`, then run \`npm install --global ./${name}.tgz\`.
- **Portable ZIP:** extract \`${name}.zip\` and run \`./${name}/clasp --help\`.
- Run \`clasp doctor\` after installation to check the local clients and account.
- Runtime dependencies are included; there is no compilation step for either download.
- Verify downloads with \`shasum -a 256 -c SHA256SUMS.txt\` (macOS) or \`sha256sum -c SHA256SUMS.txt\` (Linux). Download both archives when checking the complete checksum file.

These assets contain the Codex plugin manifest and companion skill. Installing the CLI does not automatically enable a plugin in Codex.

This is an independent, experimental project. See the bundled README and docs/COMPATIBILITY.md for context-window, classifier handoff, and isolation limits. Automated checks use mocks; they do not certify compatibility with every current client or backend.
`,
  );
  console.log(`Release assets written to ${output}`);
} finally {
  rmSync(staging, { recursive: true, force: true });
}
