import { createHash } from 'node:crypto';
import { BridgeError } from '../errors.js';
import { systemText, type AnthropicRequest } from './anthropic.js';
import type { Route } from '../routing/router.js';
const hash = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 40);
function toolName(name: string) {
  return /^[a-zA-Z0-9_-]{1,64}$/.test(name) ? name : 'tool_' + hash(name);
}
export const callId = (id: string) => (/^[a-zA-Z0-9_-]{1,64}$/.test(id) ? id : 'call_' + hash(id));
export function translate(request: AnthropicRequest, route: Route) {
  const names = new Map<string, string>();
  const input: Array<Record<string, unknown>> = [];
  const tools = (request.tools ?? []).map((tool) => {
    if (tool.type && tool.type !== 'custom')
      throw new BridgeError('Unsupported server-side tool type. Use Claude client tools or MCP.');
    const name = toolName(tool.name);
    names.set(name, tool.name);
    return {
      type: 'function',
      name,
      description: tool.description ?? '',
      parameters: tool.input_schema,
      strict: false,
    };
  });
  const image = (block: any) => {
    if (!route.model.images) throw new BridgeError(`${route.model.id} does not support images.`);
    return {
      type: 'input_image',
      image_url:
        block.source.type === 'url'
          ? block.source.url
          : `data:${block.source.media_type};base64,${block.source.data}`,
    };
  };
  const calls = new Set<string>();
  const results = new Set<string>();
  for (const message of request.messages) {
    const blocks =
      typeof message.content === 'string'
        ? [{ type: 'text' as const, text: message.content }]
        : message.content;
    let content: Array<Record<string, unknown>> = [];
    const flush = () => {
      if (content.length) {
        input.push({ role: message.role, content });
        content = [];
      }
    };
    for (const block of blocks) {
      switch (block.type) {
        case 'text':
          content.push({
            type: message.role === 'assistant' ? 'output_text' : 'input_text',
            text: block.text,
            ...(message.role === 'assistant' ? { annotations: [] } : {}),
          });
          break;
        case 'image':
          if (message.role !== 'user')
            throw new BridgeError('Images in assistant history are unsupported.');
          content.push(image(block));
          break;
        case 'thinking':
        case 'redacted_thinking':
          break; // Foreign private reasoning is never invented or replayed as GPT reasoning.
        case 'tool_use': {
          if (message.role !== 'assistant' || calls.has(block.id))
            throw new BridgeError('Invalid or duplicate tool_use in message history.');
          flush();
          calls.add(block.id);
          const name = toolName(block.name);
          names.set(name, block.name);
          input.push({
            type: 'function_call',
            call_id: callId(block.id),
            name,
            arguments: JSON.stringify(block.input),
          });
          break;
        }
        case 'tool_result': {
          if (
            message.role !== 'user' ||
            !calls.has(block.tool_use_id) ||
            results.has(block.tool_use_id)
          )
            throw new BridgeError('tool_result does not match a unique preceding tool_use.');
          flush();
          results.add(block.tool_use_id);
          const output =
            typeof block.content === 'string'
              ? block.content
              : (block.content ?? []).map((part) =>
                  part.type === 'text' ? { type: 'input_text', text: part.text } : image(part),
                );
          input.push({
            type: 'function_call_output',
            call_id: callId(block.tool_use_id),
            output: block.is_error
              ? typeof output === 'string'
                ? 'Tool execution failed:\n' + output
                : [{ type: 'input_text', text: 'Tool execution failed:' }, ...output]
              : output,
          });
          break;
        }
      }
    }
    flush();
  }
  let choice: unknown = 'auto';
  if (request.tool_choice) {
    const c = request.tool_choice;
    if (c.type === 'tool') {
      if (!c.name || !request.tools?.some((t) => t.name === c.name))
        throw new BridgeError('tool_choice.name is not a declared tool.');
      choice = { type: 'function', name: toolName(c.name) };
    } else choice = c.type === 'any' ? 'required' : c.type;
  }
  if (!tools.length && request.tool_choice && ['any', 'tool'].includes(request.tool_choice.type))
    throw new BridgeError('tool_choice requires at least one tool.');
  return {
    names,
    body: {
      model: route.model.id,
      instructions: systemText(request),
      input,
      tools,
      tool_choice: choice,
      parallel_tool_calls: !request.tool_choice?.disable_parallel_tool_use,
      store: false,
      stream: true,
      ...(route.effort ? { reasoning: { effort: route.effort } } : {}),
    },
  };
}
