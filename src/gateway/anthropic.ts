import { z } from 'zod';
import { BridgeError } from '../errors.js';
const text = z.object({ type: z.literal('text'), text: z.string() }).passthrough();
const image = z.object({
  type: z.literal('image'),
  source: z.discriminatedUnion('type', [
    z.object({
      type: z.literal('base64'),
      media_type: z.enum(['image/jpeg', 'image/png', 'image/gif', 'image/webp']),
      data: z.string().min(1),
    }),
    z.object({
      type: z.literal('url'),
      url: z
        .string()
        .url()
        .refine((v) => /^https?:/.test(v)),
    }),
  ]),
});
const toolUse = z
  .object({
    type: z.literal('tool_use'),
    id: z.string().min(1),
    name: z.string().min(1),
    input: z.record(z.unknown()),
  })
  .passthrough();
const result = z
  .object({
    type: z.literal('tool_result'),
    tool_use_id: z.string().min(1),
    is_error: z.boolean().optional(),
    content: z.union([z.string(), z.array(z.union([text, image]))]).optional(),
  })
  .passthrough();
const thinking = z
  .object({
    type: z.enum(['thinking', 'redacted_thinking']),
    thinking: z.string().optional(),
    signature: z.string().optional(),
    data: z.string().optional(),
  })
  .passthrough();
export const RequestSchema = z
  .object({
    model: z.string().min(1).max(200),
    max_tokens: z.number().int().positive().max(1000000),
    system: z.union([z.string(), z.array(text)]).optional(),
    messages: z
      .array(
        z.object({
          role: z.enum(['user', 'assistant']),
          content: z.union([
            z.string(),
            z.array(z.union([text, image, toolUse, result, thinking])),
          ]),
        }),
      )
      .min(1),
    tools: z
      .array(
        z
          .object({
            name: z.string().min(1),
            description: z.string().optional(),
            input_schema: z.record(z.unknown()),
          })
          .passthrough(),
      )
      .optional(),
    tool_choice: z
      .object({
        type: z.enum(['auto', 'any', 'tool', 'none']),
        name: z.string().optional(),
        disable_parallel_tool_use: z.boolean().optional(),
      })
      .optional(),
    stream: z.boolean().default(false),
    temperature: z.number().min(0).max(1).optional(),
    stop_sequences: z.array(z.string().min(1).max(1024)).max(32).optional(),
    metadata: z.record(z.unknown()).optional(),
    thinking: z.record(z.unknown()).optional(),
    output_config: z
      .object({ effort: z.string().optional(), format: z.record(z.unknown()).optional() })
      .passthrough()
      .optional(),
  })
  .passthrough();
export type AnthropicRequest = z.infer<typeof RequestSchema>;
export function parseRequest(raw: unknown): AnthropicRequest {
  const r = RequestSchema.safeParse(raw);
  if (!r.success) {
    const fields = r.error.issues.map((i) => i.path.join('.') || 'root').slice(0, 5);
    throw new BridgeError('Unsupported or invalid Messages fields: ' + fields.join(', ') + '.');
  }
  const allowed = new Set([
    'model',
    'max_tokens',
    'system',
    'messages',
    'tools',
    'tool_choice',
    'stream',
    'temperature',
    'stop_sequences',
    'metadata',
    'thinking',
    'output_config',
  ]);
  for (const key of Object.keys(r.data))
    if (!allowed.has(key))
      throw new BridgeError(
        `Unsupported Messages field: ${/^[a-z_]{1,80}$/.test(key) ? key : 'unknown'}. Disable this Claude beta feature.`,
      );
  if (r.data.output_config?.format)
    throw new BridgeError(
      'Unsupported Messages field: output_config.format. Use a tool with a JSON schema.',
    );
  return r.data;
}
export function systemText(request: AnthropicRequest) {
  return typeof request.system === 'string'
    ? request.system
    : (request.system ?? []).map((b) => b.text).join('\n\n');
}
export interface AnthropicMessage {
  id: string;
  type: 'message';
  role: 'assistant';
  model: string;
  content: Array<Record<string, unknown>>;
  stop_reason: string | null;
  stop_sequence: string | null;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens: number;
    cache_read_input_tokens: number;
  };
}
