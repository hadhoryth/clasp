import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRequest } from '../dist/gateway/anthropic.js';
import { translate } from '../dist/gateway/translate.js';
import { consumeResponse, StopFilter } from '../dist/gateway/stream.js';
import { readSSE } from '../dist/gateway/sse.js';
import { model, request, response, textEvents, toolEvents, completed } from './helpers.mjs';
const route = { role: 'main', model: model(), requested: 'gpt-test', effort: 'high' };
test('Messages validates input and rejects unknown content blocks', () => {
  assert.throws(
    () =>
      parseRequest(
        request({ messages: [{ role: 'user', content: [{ type: 'audio', data: 'x' }] }] }),
      ),
    /Unsupported/,
  );
  assert.throws(() => parseRequest(request({ max_tokens: 0 })));
  assert.throws(() => parseRequest(request({ context_management: {} })), /context_management/);
});
test('tool use and tool result round trip preserves IDs, JSON and order', () => {
  const req = request({
    tools: [{ name: 'Bash', input_schema: { type: 'object' } }],
    messages: [
      { role: 'user', content: 'run pwd' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Checking' },
          { type: 'tool_use', id: 'call1', name: 'Bash', input: { command: 'pwd' } },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'call1', content: '/tmp' },
          { type: 'text', text: 'Explain' },
        ],
      },
    ],
  });
  const { body } = translate(req, route);
  assert.deepEqual(
    body.input.map((i) => i.type ?? i.role),
    ['user', 'assistant', 'function_call', 'function_call_output', 'user'],
  );
  assert.equal(body.input[2].arguments, '{"command":"pwd"}');
  assert.equal(body.input[3].call_id, 'call1');
  assert.equal(body.store, false);
  assert.equal(body.model, 'gpt-test');
});
test('long MCP tool names are reversible and function choice matches', () => {
  const name = 'mcp__' + 'x'.repeat(80);
  const x = translate(
    request({
      tools: [{ name, input_schema: { type: 'object' } }],
      tool_choice: { type: 'tool', name, disable_parallel_tool_use: true },
    }),
    route,
  );
  assert.ok(x.body.tools[0].name.length <= 64);
  assert.equal(x.names.get(x.body.tools[0].name), name);
  assert.equal(x.body.tool_choice.name, x.body.tools[0].name);
  assert.equal(x.body.parallel_tool_calls, false);
});
test('images are forwarded without gateway fetching them', () => {
  const x = translate(
    request({
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
          ],
        },
      ],
    }),
    route,
  );
  assert.equal(x.body.input[0].content[0].image_url, 'data:image/png;base64,AAAA');
  assert.throws(
    () =>
      translate(
        request({
          messages: [
            {
              role: 'user',
              content: [
                { type: 'image', source: { type: 'url', url: 'https://example.com/a.png' } },
              ],
            },
          ],
        }),
        { ...route, model: model('gpt-test', { images: false }) },
      ),
    /images/,
  );
});
test('foreign thinking blocks are not fabricated into responses reasoning', () => {
  const x = translate(
    request({
      messages: [
        {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'private', signature: 'x' },
            { type: 'text', text: 'Answer' },
          ],
        },
        { role: 'user', content: 'next' },
      ],
    }),
    route,
  );
  assert.ok(!JSON.stringify(x.body).includes('private'));
});
test('orphan and duplicate tool results fail early', () => {
  assert.throws(
    () =>
      translate(
        request({
          messages: [
            {
              role: 'user',
              content: [{ type: 'tool_result', tool_use_id: 'unknown', content: 'x' }],
            },
          ],
        }),
        route,
      ),
    /preceding/,
  );
});
test('SSE handles byte-split unicode and CRLF', async () => {
  const values = [];
  for await (const v of readSSE(response(textEvents('Hello 🌍'), 1).body)) values.push(v);
  assert.equal(values[1].delta, 'Hello 🌍');
});
test('text streaming emits correct Anthropic lifecycle and usage', async () => {
  const events = [];
  const m = await consumeResponse(response(textEvents()), request(), new Map(), async (t, v) =>
    events.push([t, v]),
  );
  assert.equal(m.content[0].text, 'Hello');
  assert.equal(m.usage.input_tokens, 15);
  assert.equal(m.usage.cache_read_input_tokens, 5);
  assert.equal(m.stop_reason, 'end_turn');
  assert.deepEqual(
    events.map((e) => e[0]),
    [
      'message_start',
      'content_block_start',
      'content_block_delta',
      'content_block_stop',
      'message_delta',
      'message_stop',
    ],
  );
});
test('tool calls only emitted with complete valid JSON', async () => {
  const r = request({ tools: [{ name: 'Bash', input_schema: { type: 'object' } }] });
  const m = await consumeResponse(response(toolEvents()), r, new Map([['Bash', 'Bash']]));
  assert.equal(m.stop_reason, 'tool_use');
  assert.deepEqual(m.content[0], {
    type: 'tool_use',
    id: 'call1',
    name: 'Bash',
    input: { command: 'pwd' },
  });
  const events = [];
  await assert.rejects(
    consumeResponse(response(toolEvents('{bad')), r, new Map([['Bash', 'Bash']]), async (t) =>
      events.push(t),
    ),
    /invalid tool JSON/,
  );
  assert.ok(!events.includes('content_block_start'));
});
test('refusals remain refusals', async () => {
  const m = await consumeResponse(
    response([
      {
        type: 'response.refusal.delta',
        delta: 'Cannot do that',
        output_index: 0,
        content_index: 0,
      },
      completed(),
    ]),
    request(),
    new Map(),
  );
  assert.equal(m.stop_reason, 'refusal');
});
test('never silently succeeds on truncated, failed or unknown streams', async () => {
  for (const events of [
    textEvents().slice(0, -1),
    [{ type: 'response.failed' }],
    [{ type: 'response.future_event' }],
  ])
    await assert.rejects(consumeResponse(response(events), request(), new Map()));
});
test('hidden reasoning events never become thinking blocks', async () => {
  const m = await consumeResponse(
    response([
      { type: 'response.reasoning_summary_text.delta', delta: 'private summary' },
      ...textEvents(),
    ]),
    request(),
    new Map(),
  );
  assert.deepEqual(m.content, [{ type: 'text', text: 'Hello' }]);
});
test('stop sequences across chunk boundaries are removed', async () => {
  const events = ['Hello ST', 'OP secret'].map((delta) => ({
    type: 'response.output_text.delta',
    delta,
    output_index: 0,
    content_index: 0,
  }));
  const m = await consumeResponse(
    response(events),
    request({ stop_sequences: ['STOP'] }),
    new Map(),
  );
  assert.equal(m.content[0].text, 'Hello ');
  assert.equal(m.stop_reason, 'stop_sequence');
  assert.equal(m.stop_sequence, 'STOP');
});
test('unmatched delimiter suffix flushes on completion', async () => {
  const m = await consumeResponse(
    response(textEvents('Hello ST')),
    request({ stop_sequences: ['STOP'] }),
    new Map(),
  );
  assert.equal(m.content[0].text, 'Hello ST');
});
test('max tokens truncates visible text and never incomplete tool JSON', async () => {
  const m = await consumeResponse(
    response(textEvents('A long response with several words')),
    request({ max_tokens: 2 }),
    new Map(),
  );
  assert.equal(m.stop_reason, 'max_tokens');
  const tool = await consumeResponse(
    response(toolEvents()),
    request({ max_tokens: 1, tools: [{ name: 'Bash', input_schema: {} }] }),
    new Map([['Bash', 'Bash']]),
  );
  assert.equal(tool.stop_reason, 'max_tokens');
  assert.equal(tool.content.length, 0);
});
test('interleaved parallel function deltas produce separate valid tool blocks', async () => {
  const events = [
    {
      type: 'response.output_item.added',
      item: { id: 'a', type: 'function_call', call_id: 'call-a', name: 'Bash', arguments: '' },
    },
    {
      type: 'response.output_item.added',
      item: { id: 'b', type: 'function_call', call_id: 'call-b', name: 'Bash', arguments: '' },
    },
    { type: 'response.function_call_arguments.delta', item_id: 'a', delta: '{"command":' },
    { type: 'response.function_call_arguments.delta', item_id: 'b', delta: '{"command":"ls"}' },
    { type: 'response.function_call_arguments.delta', item_id: 'a', delta: '"pwd"}' },
    { type: 'response.output_item.done', item: { id: 'b', type: 'function_call' } },
    { type: 'response.output_item.done', item: { id: 'a', type: 'function_call' } },
    completed(),
  ];
  const m = await consumeResponse(
    response(events),
    request({ tools: [{ name: 'Bash', input_schema: {} }] }),
    new Map([['Bash', 'Bash']]),
  );
  assert.deepEqual(
    m.content.map((b) => [b.id, b.input.command]),
    [
      ['call-b', 'ls'],
      ['call-a', 'pwd'],
    ],
  );
});
test('incomplete content-filter output is a refusal, not a token limit', async () => {
  const m = await consumeResponse(
    response([
      {
        type: 'response.incomplete',
        response: { status: 'incomplete', incomplete_details: { reason: 'content_filter' } },
      },
    ]),
    request(),
    new Map(),
  );
  assert.equal(m.stop_reason, 'refusal');
});
test('completion with unfinished tool calls is an error', async () => {
  await assert.rejects(
    consumeResponse(response([toolEvents()[0], completed()]), request(), new Map()),
    /finishing its tool calls/,
  );
});
