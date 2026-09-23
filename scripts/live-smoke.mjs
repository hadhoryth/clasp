#!/usr/bin/env node
// Explicit opt-in: uses the installed Codex account and consumes model usage.
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
const cli = fileURLToPath(new URL('../bin/clasp.js', import.meta.url));
const directory = await mkdtemp(join(tmpdir(), 'clasp-smoke-'));
let child;
const kill = () => child?.kill('SIGTERM');
process.on('SIGINT', kill);
process.on('SIGTERM', kill);
try {
  await writeFile(join(directory, 'fixture.txt'), 'bridge fixture\n');
  await writeFile(
    join(directory, 'config.toml'),
    '[reasoning]\nmain="low"\nsubagent="low"\nclassifier="low"\n',
  );
  child = spawn(
    process.execPath,
    [
      cli,
      '--config',
      join(directory, 'config.toml'),
      '--trace',
      '--',
      '-p',
      'Use an Explore agent to read fixture.txt in this directory. Do not use shell commands or modify files. Report AGENT_OK followed by the file text.',
      '--tools',
      'Agent,Read,Glob',
      '--permission-mode',
      'plan',
      '--no-session-persistence',
    ],
    {
      cwd: directory,
      env: { ...process.env, CLAUDE_CODEX_CONFIG_DIR: join(directory, 'profile') },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let output = '',
    trace = '';
  child.stdout.on('data', (data) => {
    output += data;
  });
  child.stderr.on('data', (data) => {
    trace += data;
  });
  const timer = setTimeout(() => child.kill('SIGTERM'), 120000);
  let code;
  try {
    code = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', resolve);
    });
  } finally {
    clearTimeout(timer);
  }
  assert.equal(code, 0, 'Claude smoke test failed: ' + trace);
  assert.match(output, /AGENT_OK/);
  assert.match(output, /bridge fixture/);
  for (const role of ['main', 'classifier', 'subagent'])
    assert.ok(
      trace.includes(`"role":"${role}"`),
      `Missing ${role} request; this run does not prove its compatibility.\n${trace}`,
    );
  console.log('PASS: Plan → classifier → Explore → Read round-trip through Codex.');
} finally {
  process.off('SIGINT', kill);
  process.off('SIGTERM', kill);
  await rm(directory, { recursive: true, force: true });
}
