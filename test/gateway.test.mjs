import test from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { ConfigSchema } from '../dist/config.js';
import { Router } from '../dist/routing/router.js';
import { startGateway } from '../dist/gateway/server.js';
import { BridgeError } from '../dist/errors.js';
import { startEgressGuard, blockedHost } from '../dist/claude/egress.js';
import { request, model, response, textEvents, toolEvents } from './helpers.mjs';
const config = ConfigSchema.parse({});
async function setup(fn, upstream = { request: async () => response(textEvents()) }, extra = {}) {
  const g = await startGateway({
    router: new Router(config, [model()], 'gpt-test'),
    config,
    upstream,
    ...extra,
  });
  try {
    await fn(g);
  } finally {
    await g.close();
  }
}
const post = (g, body, token = g.token) =>
  fetch(g.url + '/v1/messages?beta=true', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
test('loopback, unique ports/tokens and authentication', async () => {
  await setup(async (a) => {
    await setup(async (b) => {
      assert.notEqual(a.url, b.url);
      assert.notEqual(a.token, b.token);
      assert.match(a.url, /127.0.0.1/);
      assert.equal((await post(a, request(), 'wrong')).status, 401);
      assert.equal((await fetch(a.url + '/v1/models')).status, 401);
    });
  });
});
test('normal Messages request and discoverable catalog', async () => {
  await setup(async (g) => {
    const r = await post(g, request());
    assert.equal(r.status, 200);
    assert.equal((await r.json()).content[0].text, 'Hello');
    const m = await fetch(g.url + '/v1/models?limit=1000', { headers: { 'x-api-key': g.token } });
    assert.equal((await m.json()).data[0].id, 'gpt-test');
  });
});
test('stream is Anthropic SSE, unknown endpoints never forward', async () => {
  let calls = 0;
  await setup(
    async (g) => {
      const r = await post(g, request({ stream: true }));
      assert.match(r.headers.get('content-type'), /text\/event-stream/);
      const text = await r.text();
      assert.match(text, /event: message_start/);
      assert.match(text, /event: message_stop/);
      assert.ok(!text.includes('response.completed'));
      const bad = await fetch(g.url + '/v1/unknown', {
        headers: { Authorization: 'Bearer ' + g.token },
      });
      assert.equal(bad.status, 404);
      assert.equal(calls, 1);
    },
    {
      request: async () => {
        calls++;
        return response(textEvents());
      },
    },
  );
});
test('classifier error latches manual approval without fake successful verdict', async () => {
  let failed = false;
  await setup(
    async (g) => {
      const r = await post(g, request({ metadata: { request_type: 'classifier' } }));
      assert.equal(r.status, 429);
      const v = await r.json();
      assert.equal(v.type, 'error');
      assert.ok(failed);
      assert.equal(r.headers.get('retry-after'), '10');
    },
    {
      request: async () => {
        throw new BridgeError('Rate limited', 429, 'rate_limit_error', '10');
      },
    },
    {
      onClassifierFailure: async () => {
        failed = true;
      },
    },
  );
});
test('metadata tracing never logs prompt, tool output, token or image', async () => {
  const logs = [];
  await setup(
    async (g) => {
      await post(g, request({ messages: [{ role: 'user', content: 'SECRET_PROMPT' }] }));
      const text = logs.join('');
      assert.ok(!text.includes('SECRET_PROMPT'));
      assert.ok(!text.includes(g.token));
      assert.match(text, /gpt-test/);
    },
    undefined,
    { trace: (s) => logs.push(s) },
  );
});
test('unknown models are rejected before contacting upstream', async () => {
  let calls = 0;
  await setup(
    async (g) => {
      assert.equal((await post(g, request({ model: 'unknown' }))).status, 400);
      assert.equal(calls, 0);
    },
    {
      request: async () => {
        calls++;
        return response(textEvents());
      },
    },
  );
});
test('gateway shutdown aborts pending inference', async () => {
  let cancelled = false;
  let start;
  const started = new Promise((r) => (start = r));
  const g = await startGateway({
    router: new Router(config, [model()], 'gpt-test'),
    config,
    upstream: {
      request: async (p, b, signal) =>
        new Promise((resolve, reject) => {
          start();
          signal.addEventListener('abort', () => {
            cancelled = true;
            reject(new Error('aborted'));
          });
        }),
    },
  });
  const pending = post(g, request()).catch(() => {});
  await started;
  await g.close();
  await pending;
  assert.equal(cancelled, true);
});
test('egress guard denies Anthropic HTTP and CONNECT without DNS/upstream', async () => {
  assert.equal(blockedHost('api.anthropic.com.'), true);
  assert.equal(blockedHost('api.anthropic.com.evil.example'), false);
  const g = await startEgressGuard();
  try {
    const status = await new Promise((resolve, reject) => {
      const r = httpRequest(g.url, { path: 'http://api.anthropic.com/v1/messages' }, (res) => {
        res.resume();
        resolve(res.statusCode);
      });
      r.on('error', reject);
      r.end();
    });
    assert.equal(status, 403);
    const connect = await new Promise((resolve, reject) => {
      const r = httpRequest(g.url, { method: 'CONNECT', path: 'api.anthropic.com:443' });
      r.on('connect', (res, socket) => {
        socket.destroy();
        resolve(res.statusCode);
      });
      r.on('error', reject);
      r.end();
    });
    assert.equal(connect, 403);
  } finally {
    await g.close();
  }
});
test('configured fallback is explicit and attempted only before response output', async () => {
  const c = ConfigSchema.parse({ fallback: { 'gpt-test': ['gpt-backup'] } });
  const calls = [];
  const logs = [];
  const g = await startGateway({
    config: c,
    router: new Router(c, [model(), model('gpt-backup')], 'gpt-test'),
    trace: (s) => logs.push(s),
    upstream: {
      request: async (p, body) => {
        calls.push(body.model);
        if (calls.length === 1) throw new BridgeError('Unavailable', 503, 'api_error');
        return response(textEvents());
      },
    },
  });
  try {
    const r = await post(g, request());
    assert.equal(r.status, 200);
    assert.deepEqual(calls, ['gpt-test', 'gpt-backup']);
    assert.ok(logs.some((l) => l.includes('Configured fallback')));
  } finally {
    await g.close();
  }
});
test('upstream streaming errors emit error and never message_stop', async () => {
  await setup(
    async (g) => {
      const r = await post(g, request({ stream: true }));
      const body = await r.text();
      assert.match(body, /event: error/);
      assert.ok(!body.includes('event: message_stop'));
    },
    { request: async () => response([{ type: 'response.failed' }]) },
  );
});
