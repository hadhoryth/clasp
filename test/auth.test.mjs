import test from 'node:test';
import assert from 'node:assert/strict';
import { CodexAuth } from '../dist/codex/auth.js';
import { CodexClient } from '../dist/codex/client.js';
const token = (exp = Date.now() / 1000 + 3600) =>
  'header.' +
  Buffer.from(
    JSON.stringify({
      exp,
      sub: 'test-user',
      'https://api.openai.com/auth': { chatgpt_account_id: 'test-account' },
    }),
  ).toString('base64url') +
  '.signature';
test('auth remains in memory, refreshes expired credential through Codex and coalesces concurrent calls', async () => {
  let calls = 0;
  const rpc = {
    start: async () => {},
    call: async (method, p) => {
      calls++;
      assert.equal(method, 'getAuthStatus');
      assert.equal(p.includeToken, true);
      return {
        authMethod: 'chatgpt',
        authToken: token(p.refreshToken ? Date.now() / 1000 + 3600 : 1),
      };
    },
  };
  const a = new CodexAuth(rpc);
  const [x, y] = await Promise.all([a.get(), a.get()]);
  assert.equal(calls, 2);
  assert.equal(x.token, y.token);
  assert.equal(x.accountId, 'test-account');
  assert.ok(!x.identity.includes('test-account'));
  await a.get();
  assert.equal(calls, 2);
});
test('API key and malformed credentials fail without token disclosure', async () => {
  for (const result of [
    { authMethod: 'apikey', authToken: 'DO_NOT_LOG' },
    { authMethod: 'chatgpt', authToken: 'DO_NOT_LOG' },
  ]) {
    const a = new CodexAuth({ start: async () => {}, call: async () => result });
    await assert.rejects(a.get(), (e) => !e.message.includes('DO_NOT_LOG'));
  }
});
test('client retries authentication once, fixes upstream origin and rejects redirects', async () => {
  const refreshes = [];
  const requests = [];
  const auth = {
    get: async (refresh) => {
      refreshes.push(refresh);
      return { token: 'SECRET', accountId: 'ACCOUNT' };
    },
  };
  const client = new CodexClient(
    auth,
    async (url, options) => {
      requests.push({ url, options });
      return requests.length === 1 ? new Response('', { status: 401 }) : new Response('ok');
    },
    () => 'test-version',
  );
  const r = await client.request('/responses', { model: 'gpt-test' }, AbortSignal.timeout(1000));
  assert.equal(r.status, 200);
  assert.deepEqual(refreshes, [false, true]);
  assert.ok(
    requests.every(
      (r) =>
        r.url === 'https://chatgpt.com/backend-api/codex/responses' &&
        r.options.redirect === 'error',
    ),
  );
});
test('upstream error content is sanitized and context errors retain recovery signal', async () => {
  const auth = { get: async () => ({ token: 'SECRET', accountId: 'ACCOUNT' }) };
  const client = new CodexClient(
    auth,
    async () =>
      Response.json({ error: { message: 'PRIVATE PROMPT', code: 'invalid' } }, { status: 400 }),
    () => 'test-version',
  );
  await assert.rejects(client.request('/responses', {}), (e) => !e.message.includes('PRIVATE'));
  const context = new CodexClient(
    auth,
    async () =>
      Response.json(
        { error: { message: 'maximum context length exceeded PRIVATE' } },
        { status: 400 },
      ),
    () => 'test-version',
  );
  await assert.rejects(context.request('/responses', {}), /prompt is too long/);
});
