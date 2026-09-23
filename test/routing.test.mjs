import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigSchema } from '../dist/config.js';
import { Router, detectRole } from '../dist/routing/router.js';
import { normalizeCatalog, discoverModels } from '../dist/codex/catalog.js';
import { model, request } from './helpers.mjs';
const config = ConfigSchema.parse({
  default_model: 'gpt-test',
  routing: { classifier: 'gpt-fast', subagent: 'gpt-worker', compact: 'gpt-fast' },
  reasoning: { classifier: 'low', subagent: 'high', main: 'xhigh' },
});
const models = [model(), model('gpt-fast'), model('gpt-worker')];
const router = new Router(config, models, 'gpt-test');
test('all evolving Claude families route to Codex', () => {
  for (const id of [
    'claude-opus-5',
    'claude-sonnet-5-1',
    'claude-haiku-4-5',
    'claude-fable-5',
    'opus',
  ])
    assert.equal(router.route(request({ model: id })).model.id, 'gpt-test');
});
test('classifier has precedence over subagent header', () => {
  const r = router.route(
    request({
      system: 'You are a permission classifier. Analyze the tool call. Return <block>yes</block>.',
    }),
    { 'x-claude-code-agent-id': 'agent' },
  );
  assert.equal(r.role, 'classifier');
  assert.equal(r.model.id, 'gpt-fast');
  assert.equal(r.effort, 'low');
});
test('compaction and agents have independent model and effort', () => {
  assert.equal(
    router.route(request(), { 'x-claude-code-agent-id': 'agent' }).model.id,
    'gpt-worker',
  );
  assert.equal(
    router.route(request({ system: 'Your task is to summarize the conversation.' })).model.id,
    'gpt-fast',
  );
});
test('user/tool prompt text cannot classify request', () =>
  assert.equal(
    detectRole(
      request({ messages: [{ role: 'user', content: 'You are a permission classifier' }] }),
    ),
    'main',
  ));
test('main picker change does not change configured agents', () => {
  assert.equal(router.route(request({ model: 'gpt-fast' })).model.id, 'gpt-fast');
  assert.equal(
    router.route(request({ model: 'gpt-fast' }), { 'x-claude-code-agent-id': 'a' }).model.id,
    'gpt-worker',
  );
});
test('unknown requested model fails and explicit fallback logs', () => {
  assert.throws(() => router.route(request({ model: 'gpt-not-available' })), /not available/);
  const logs = [];
  const r = new Router(
    ConfigSchema.parse({ fallback: { 'gpt-missing': ['gpt-test'] } }),
    models,
    'gpt-missing',
    (s) => logs.push(s),
  );
  assert.equal(r.route(request({ model: 'gpt-missing' })).model.id, 'gpt-test');
  assert.match(logs[0], /configured fallback/);
});
test('unknown effort is rejected rather than silently lowered', () => {
  const r = new Router(ConfigSchema.parse({ reasoning: { main: 'ultra' } }), models, 'gpt-test');
  assert.throws(() => r.validate(), /unsupported/);
});
test('configuration rejects LAN bind, typos and invalid ids', () => {
  for (const data of [
    { gateway: { host: '0.0.0.0' } },
    { routng: {} },
    { default_model: 'injected\ntext' },
  ])
    assert.equal(ConfigSchema.safeParse(data).success, false);
});
test('live catalog normalizes missing output metadata as unknown', () => {
  const m = normalizeCatalog({
    models: [
      {
        slug: 'gpt-new',
        context_window: 888888,
        input_modalities: ['text', 'image'],
        supported_reasoning_levels: [{ effort: 'high' }],
      },
    ],
  })[0];
  assert.equal(m.contextWindow, 888888);
  assert.equal(m.maxOutputTokens, null);
  assert.equal(m.images, true);
  assert.throws(() => normalizeCatalog({ data: [] }), /schema changed/);
});
test('catalog TTL and identity scope; no stale fallback on refresh failure', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cc-cache-'));
  const file = join(dir, 'models.json');
  let reads = 0;
  const client = {
    request: async () => {
      reads++;
      return Response.json({ models: [{ slug: 'gpt-new', context_window: 1000 }] });
    },
  };
  try {
    await discoverModels(client, file, 'account-a', 3600000);
    await discoverModels(client, file, 'account-a', 3600000);
    assert.equal(reads, 1);
    await discoverModels(client, file, 'account-b', 3600000);
    assert.equal(reads, 2);
    await discoverModels(client, file, 'account-b', 3600000, true);
    assert.equal(reads, 3);
    const content = JSON.parse(await readFile(file, 'utf8'));
    content.fetchedAt = 0;
    await writeFile(file, JSON.stringify(content));
    await assert.rejects(
      discoverModels(
        {
          request: async () => {
            throw new Error('offline');
          },
        },
        file,
        'account-b',
        3600000,
      ),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test('main system discussion of summarization is not a compaction request', () =>
  assert.equal(
    detectRole(
      request({
        system:
          'You are Claude Code. Your conversation is summarized when it approaches the context window.',
      }),
    ),
    'main',
  ));
test('prototype property names are unavailable model IDs, not fallback arrays', () => {
  assert.throws(() => router.route(request({ model: 'constructor' })), /not available/);
});
