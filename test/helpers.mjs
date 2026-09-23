export const model = (id = 'gpt-test', extra = {}) => ({
  id,
  name: id,
  contextWindow: 272000,
  maxOutputTokens: null,
  efforts: ['low', 'medium', 'high', 'xhigh'],
  defaultEffort: 'medium',
  images: true,
  tools: true,
  hidden: false,
  available: true,
  priority: 1,
  ...extra,
});
export const request = (extra = {}) => ({
  model: 'gpt-test',
  max_tokens: 1000,
  messages: [{ role: 'user', content: 'hello' }],
  stream: false,
  ...extra,
});
export const completed = (extra = {}) => ({
  type: 'response.completed',
  response: {
    status: 'completed',
    usage: { input_tokens: 20, output_tokens: 4, input_tokens_details: { cached_tokens: 5 } },
    ...extra,
  },
});
export const textEvents = (text = 'Hello') => [
  { type: 'response.output_item.added', output_index: 0, item: { id: 'msg1', type: 'message' } },
  { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: text },
  { type: 'response.output_item.done', output_index: 0, item: { id: 'msg1', type: 'message' } },
  completed(),
];
export const toolEvents = (args = '{"command":"pwd"}') => [
  {
    type: 'response.output_item.added',
    output_index: 0,
    item: { id: 'fc1', type: 'function_call', call_id: 'call1', name: 'Bash', arguments: '' },
  },
  { type: 'response.function_call_arguments.delta', item_id: 'fc1', delta: args },
  {
    type: 'response.output_item.done',
    item: { id: 'fc1', type: 'function_call', call_id: 'call1', name: 'Bash', arguments: args },
  },
  completed(),
];
export function response(events, chunkSize = 23) {
  const bytes = new TextEncoder().encode(
    events.map((e) => `data: ${JSON.stringify(e)}\r\n\r\n`).join(''),
  );
  return new Response(
    new ReadableStream({
      start(c) {
        for (let i = 0; i < bytes.length; i += chunkSize) c.enqueue(bytes.slice(i, i + chunkSize));
        c.close();
      },
    }),
    { headers: { 'content-type': 'text/event-stream' } },
  );
}
