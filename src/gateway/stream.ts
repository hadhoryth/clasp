import { randomUUID } from 'node:crypto';
import { getEncoding } from 'js-tiktoken';
import { BridgeError } from '../errors.js';
import type { AnthropicRequest, AnthropicMessage } from './anthropic.js';
import { readSSE } from './sse.js';
const encoding = getEncoding('o200k_base');
export function estimateTokens(text: string) {
  return encoding.encode(text, [], []).length;
}
export type Emit = (type: string, data: Record<string, unknown>) => Promise<void>;
// Retain the longest possible delimiter prefix so split stop sequences never leak.
export class StopFilter {
  private pending = '';
  stopped?: string;
  constructor(private sequences: string[]) {}
  push(text: string, final = false) {
    if (this.stopped) return '';
    this.pending += text;
    let first = -1;
    let stop = '';
    for (const s of this.sequences) {
      const i = this.pending.indexOf(s);
      if (i >= 0 && (first < 0 || i < first)) {
        first = i;
        stop = s;
      }
    }
    if (first >= 0) {
      const out = this.pending.slice(0, first);
      this.pending = '';
      this.stopped = stop;
      return out;
    }
    let keep = 0;
    if (!final)
      for (const s of this.sequences)
        for (let n = 1; n < s.length; n++)
          if (this.pending.endsWith(s.slice(0, n))) keep = Math.max(keep, n);
    const out = this.pending.slice(0, this.pending.length - keep);
    this.pending = this.pending.slice(this.pending.length - keep);
    return out;
  }
}
export async function consumeResponse(
  response: Response,
  request: AnthropicRequest,
  names: Map<string, string>,
  emit: Emit = async () => {},
): Promise<AnthropicMessage> {
  if (!response.body) throw new BridgeError('Codex response has no body.', 502, 'api_error');
  const message: AnthropicMessage = {
    id: 'msg_' + randomUUID().replaceAll('-', ''),
    type: 'message',
    role: 'assistant',
    model: request.model,
    content: [],
    stop_reason: null,
    stop_sequence: null,
    usage: {
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
  };
  await emit('message_start', { type: 'message_start', message: { ...message, content: [] } });
  let active: { key: string; index: number; text: string } | undefined;
  let completed = false;
  let limited = false;
  let spent = 0;
  let refusal = false;
  const filter = new StopFilter(request.stop_sequences ?? []);
  const calls = new Map<string, { name: string; id: string; args: string }>();
  const doneCalls = new Set<string>();
  async function closeText() {
    if (active) {
      await emit('content_block_stop', { type: 'content_block_stop', index: active.index });
      active = undefined;
    }
  }
  async function textDelta(key: string, delta: string) {
    if (!delta || limited || filter.stopped) return;
    if (active?.key !== key) {
      await closeText();
      active = { key, index: message.content.length, text: '' };
      message.content.push({ type: 'text', text: '' });
      await emit('content_block_start', {
        type: 'content_block_start',
        index: active.index,
        content_block: { type: 'text', text: '' },
      });
    }
    const tokens = encoding.encode(active.text + delta, [], []);
    const previous = estimateTokens(active.text);
    const available = request.max_tokens - (spent - previous);
    if (tokens.length > available) {
      const clipped = encoding.decode(tokens.slice(0, Math.max(0, available)));
      delta = clipped.startsWith(active.text) ? clipped.slice(active.text.length) : '';
      limited = true;
    }
    active.text += delta;
    spent = spent - previous + estimateTokens(active.text);
    message.content[active.index]!.text = active.text;
    if (delta)
      await emit('content_block_delta', {
        type: 'content_block_delta',
        index: active.index,
        delta: { type: 'text_delta', text: delta },
      });
  }
  for await (const event of readSSE(response.body)) {
    if (typeof event.type !== 'string')
      throw new BridgeError('Codex SSE event is missing its type.', 502, 'api_error');
    switch (event.type) {
      case 'response.output_text.delta':
      case 'response.refusal.delta': {
        if (typeof event.delta !== 'string')
          throw new BridgeError('Codex text delta schema changed.', 502, 'api_error');
        refusal ||= event.type === 'response.refusal.delta';
        const delta = filter.push(event.delta);
        const stopped = filter.stopped;
        filter.stopped = undefined;
        await textDelta(`${event.output_index}:${event.content_index}`, delta);
        filter.stopped = stopped;
        break;
      }
      case 'response.output_item.added': {
        const item = event.item;
        if (item?.type === 'function_call') {
          if (
            typeof item.id !== 'string' ||
            typeof item.call_id !== 'string' ||
            typeof item.name !== 'string' ||
            calls.has(item.id)
          )
            throw new BridgeError('Invalid Codex tool call identity.', 502, 'api_error');
          calls.set(item.id, { name: item.name, id: item.call_id, args: item.arguments ?? '' });
        } else if (item?.type && !['message', 'reasoning'].includes(item.type))
          throw new BridgeError('Unsupported Codex output item type.', 502, 'api_error');
        break;
      }
      case 'response.function_call_arguments.delta': {
        const call = calls.get(event.item_id);
        if (!call || typeof event.delta !== 'string')
          throw new BridgeError('Codex tool delta arrived without a tool call.', 502, 'api_error');
        call.args += event.delta;
        if (call.args.length > 16 * 1024 * 1024)
          throw new BridgeError('Codex tool arguments exceeded the size limit.', 502, 'api_error');
        break;
      }
      case 'response.output_item.done': {
        const item = event.item;
        if (item?.type !== 'function_call') break;
        if (doneCalls.has(item.id))
          throw new BridgeError('Codex returned a duplicate tool call.', 502, 'api_error');
        doneCalls.add(item.id);
        const call = calls.get(item.id);
        if (!call) throw new BridgeError('Codex completed an unknown tool call.', 502, 'api_error');
        const args = typeof item.arguments === 'string' ? item.arguments : call.args;
        let input: unknown;
        try {
          input = JSON.parse(args);
        } catch {
          throw new BridgeError(
            'Codex returned invalid tool JSON; no tool call was delivered.',
            502,
            'api_error',
          );
        }
        if (!input || typeof input !== 'object' || Array.isArray(input))
          throw new BridgeError('Codex tool input must be an object.', 502, 'api_error');
        const name = names.get(call.name);
        if (!name || !request.tools?.some((t) => t.name === name))
          throw new BridgeError('Codex requested an undeclared tool.', 502, 'api_error');
        await textDelta(active?.key ?? 'text', filter.push('', true));
        if (limited) break;
        const cost = estimateTokens(args + name);
        if (spent + cost > request.max_tokens) {
          limited = true;
          break;
        }
        await closeText();
        spent += cost;
        const index = message.content.length;
        const block = { type: 'tool_use', id: call.id, name, input };
        message.content.push(block);
        await emit('content_block_start', {
          type: 'content_block_start',
          index,
          content_block: { ...block, input: {} },
        });
        await emit('content_block_delta', {
          type: 'content_block_delta',
          index,
          delta: { type: 'input_json_delta', partial_json: args },
        });
        await emit('content_block_stop', { type: 'content_block_stop', index });
        break;
      }
      case 'response.completed':
      case 'response.incomplete': {
        completed = true;
        const r = event.response;
        if (!r || !['completed', 'incomplete'].includes(r.status))
          throw new BridgeError('Invalid Codex completion state.', 502, 'api_error');
        const usage = r.usage ?? {};
        const cached = Number(usage.input_tokens_details?.cached_tokens ?? 0);
        if (
          ![cached, usage.input_tokens ?? 0, usage.output_tokens ?? spent].every(
            (value) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0,
          )
        )
          throw new BridgeError('Codex token usage schema changed.', 502, 'api_error');
        message.usage = {
          input_tokens: Math.max(0, Number(usage.input_tokens ?? 0) - cached),
          output_tokens: Number(usage.output_tokens ?? spent),
          cache_read_input_tokens: cached,
          cache_creation_input_tokens: 0,
        };
        if (r.status === 'incomplete') {
          if (r.incomplete_details?.reason === 'max_output_tokens') limited = true;
          else if (r.incomplete_details?.reason === 'content_filter') refusal = true;
          else
            throw new BridgeError(
              'Codex response was incomplete for an unsupported reason.',
              502,
              'api_error',
            );
        }
        if (!limited && calls.size !== doneCalls.size)
          throw new BridgeError(
            'Codex completed before finishing its tool calls.',
            502,
            'api_error',
          );
        break;
      }
      case 'response.failed':
      case 'error':
        throw new BridgeError(
          'Codex generation failed; no successful completion was received.',
          502,
          'api_error',
        );
      default:
        if (
          ![
            'response.created',
            'response.in_progress',
            'response.queued',
            'response.content_part.added',
            'response.content_part.done',
            'response.output_text.done',
            'response.refusal.done',
            'response.function_call_arguments.done',
          ].includes(event.type) &&
          !event.type.startsWith('response.reasoning') &&
          event.type !== 'ping'
        )
          throw new BridgeError(
            `Unsupported Codex SSE event: ${/^[a-z_.]{1,100}$/.test(event.type) ? event.type : 'unknown'}.`,
            502,
            'api_error',
          );
    }
    if (filter.stopped || limited || completed) break;
  }
  if (!completed && !filter.stopped && !limited)
    throw new BridgeError('Codex stream ended before response.completed.', 502, 'api_error');
  await textDelta(active?.key ?? 'text', filter.push('', true));
  await closeText();
  message.stop_reason = filter.stopped
    ? 'stop_sequence'
    : limited
      ? 'max_tokens'
      : refusal
        ? 'refusal'
        : message.content.some((b) => b.type === 'tool_use')
          ? 'tool_use'
          : 'end_turn';
  message.stop_sequence = filter.stopped ?? null;
  if (!completed) message.usage.output_tokens = spent;
  await emit('message_delta', {
    type: 'message_delta',
    delta: { stop_reason: message.stop_reason, stop_sequence: message.stop_sequence },
    usage: message.usage,
  });
  await emit('message_stop', { type: 'message_stop' });
  return message;
}
