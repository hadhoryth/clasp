import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { ConfigSchema } from '../dist/config.js';
import { prepareClaude } from '../dist/claude/config.js';
import { launchEnvironment, validateClaudeArgs } from '../dist/claude/launcher.js';
import { model } from './helpers.mjs';
test('launch clears conflicting auth/providers and configures isolation', () => {
  const env = launchEnvironment(
    {
      PATH: '/usr/bin',
      ANTHROPIC_AUTH_TOKEN: 'old',
      CLAUDE_CODE_USE_BEDROCK: '1',
      CLAUDE_CODE_OAUTH_TOKEN: 'secret',
      ANTHROPIC_BASE_URL: 'https://api.anthropic.com',
      DISABLE_COMPACT: '1',
    },
    {
      url: 'http://127.0.0.1:123',
      token: 'random',
      directory: '/isolated',
      proxy: 'http://127.0.0.1:456',
      contextWindow: 272000,
      model: 'gpt-test',
    },
  );
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, 'random');
  assert.equal(env.CLAUDE_CODE_USE_BEDROCK, undefined);
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, undefined);
  assert.equal(env.DISABLE_COMPACT, undefined);
  assert.equal(env.CLAUDE_CONFIG_DIR, '/isolated');
  assert.equal(env.HTTPS_PROXY, 'http://127.0.0.1:456');
});
test('remote/detached and routing override arguments are rejected', () => {
  for (const flag of ['--settings=evil', '--model', '--fallback-model=x', '--bg', '--cloud'])
    assert.throws(() => validateClaudeArgs([flag]));
  assert.doesNotThrow(() => validateClaudeArgs(['--resume', '--permission-mode', 'plan']));
});
test('onboarding, model picker and permission hook never grant approval', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cc-launch-'));
  const hook = resolve('scripts/permission-hook.mjs');
  try {
    await writeFile(join(dir, '.claude.json'), JSON.stringify({ preserved: true }));
    const s = await prepareClaude(dir, [model()], ConfigSchema.parse({}), hook);
    const state = JSON.parse(await readFile(join(dir, '.claude.json'), 'utf8'));
    assert.equal(state.preserved, true);
    assert.equal(state.hasCompletedOnboarding, true);
    const settings = JSON.parse(await readFile(s.settingsFile, 'utf8'));
    assert.equal(settings.modelPicker.options[0].model, 'gpt-test');
    const invoke = () =>
      spawnSync(process.execPath, [hook, s.failureFile], {
        input: JSON.stringify({ hook_event_name: 'PreToolUse' }),
        encoding: 'utf8',
      });
    assert.equal(invoke().stdout, '');
    await s.markClassifierFailure();
    assert.equal(JSON.parse(invoke().stdout).hookSpecificOutput.permissionDecision, 'ask');
    await s.close();
    await assert.rejects(readFile(s.failureFile));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test('classifier failure retry hook only applies to unavailable outcomes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cc-hook-'));
  try {
    const marker = join(dir, 'failed');
    await writeFile(marker, 'failed');
    const invoke = (reason) =>
      spawnSync(process.execPath, [resolve('scripts/permission-hook.mjs'), marker], {
        input: JSON.stringify({ hook_event_name: 'PermissionDenied', reason }),
        encoding: 'utf8',
      }).stdout;
    assert.equal(invoke('Blocked by classifier'), '');
    assert.equal(
      invoke('Auto mode could not evaluate this action and is blocking it for safety'),
      '',
    );
    assert.equal(JSON.parse(invoke('Classifier unavailable')).hookSpecificOutput.retry, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
