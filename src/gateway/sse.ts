import { BridgeError } from '../errors.js';
export async function* readSSE(body: ReadableStream<Uint8Array>): AsyncGenerator<any> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const parse = (frame: string) => {
    const data = frame
      .split('\n')
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).trimStart())
      .join('\n');
    if (!data || data === '[DONE]') return;
    try {
      return JSON.parse(data);
    } catch {
      throw new BridgeError('Codex sent malformed SSE JSON.', 502, 'api_error');
    }
  };
  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      buffer = buffer.replace(/\r\n/g, '\n');
      if (buffer.length > 16 * 1024 * 1024)
        throw new BridgeError('Codex SSE frame exceeded the size limit.', 502, 'api_error');
      let end;
      while ((end = buffer.indexOf('\n\n')) >= 0) {
        const event = parse(buffer.slice(0, end));
        buffer = buffer.slice(end + 2);
        if (event) yield event;
      }
      if (done) {
        if (buffer.trim()) {
          const event = parse(buffer);
          if (event) yield event;
        }
        break;
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
export const sse = (type: string, value: unknown) =>
  `event: ${type}\ndata: ${JSON.stringify(value)}\n\n`;
