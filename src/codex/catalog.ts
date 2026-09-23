import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { BridgeError } from '../errors.js';
import type { CodexClient } from './client.js';
export const ModelSchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,150}$/),
  name: z.string(),
  contextWindow: z.number().int().positive(),
  maxOutputTokens: z.number().int().positive().nullable(),
  efforts: z.array(z.string()),
  defaultEffort: z.string().optional(),
  images: z.boolean(),
  tools: z.boolean(),
  hidden: z.boolean(),
  available: z.boolean(),
  priority: z.number(),
});
export type Model = z.infer<typeof ModelSchema>;
export function normalizeCatalog(raw: unknown): Model[] {
  const envelope = z
    .object({
      models: z.array(
        z.object({
          slug: z.string(),
          display_name: z.string().optional(),
          context_window: z.number().int().positive(),
          max_output_tokens: z.number().int().positive().optional(),
          supported_reasoning_levels: z.array(z.object({ effort: z.string() })).default([]),
          default_reasoning_level: z.string().optional(),
          input_modalities: z.array(z.string()).default([]),
          visibility: z.string().optional(),
          supported_in_api: z.boolean().optional(),
          priority: z.number().default(100),
          available: z.boolean().optional(),
        }),
      ),
    })
    .safeParse(raw);
  if (!envelope.success)
    throw new BridgeError(
      'Codex model catalog schema changed. Required model identifiers or context metadata are missing.',
      502,
      'api_error',
    );
  const models = envelope.data.models.map((m) =>
    ModelSchema.parse({
      id: m.slug,
      name: m.display_name ?? m.slug,
      contextWindow: m.context_window,
      maxOutputTokens: m.max_output_tokens ?? null,
      efforts: m.supported_reasoning_levels.map((e) => e.effort),
      defaultEffort: m.default_reasoning_level,
      images: m.input_modalities.includes('image'),
      tools: true,
      hidden: m.visibility === 'hide',
      available: m.available !== false,
      priority: m.priority,
    }),
  );
  if (!models.length)
    throw new BridgeError('Codex returned an empty model catalog.', 502, 'api_error');
  return models.sort((a, b) => a.priority - b.priority);
}
export async function discoverModels(
  client: CodexClient,
  file: string,
  identity: string,
  ttlMs: number,
  refresh = false,
): Promise<Model[]> {
  if (!refresh) {
    try {
      const cache = JSON.parse(await readFile(file, 'utf8'));
      if (
        cache.version === 1 &&
        cache.identity === identity &&
        typeof cache.fetchedAt === 'number' &&
        Date.now() - cache.fetchedAt >= 0 &&
        Date.now() - cache.fetchedAt < ttlMs
      ) {
        const parsed = z.array(ModelSchema).min(1).safeParse(cache.models);
        if (parsed.success) return parsed.data;
      }
    } catch {}
  }
  const response = await client.request('/models');
  let raw;
  try {
    raw = await response.json();
  } catch {
    throw new BridgeError('Codex returned an invalid model catalog.', 502, 'api_error');
  }
  const models = normalizeCatalog(raw);
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = file + '.' + randomUUID() + '.tmp';
  await writeFile(
    tmp,
    JSON.stringify({ version: 1, identity, fetchedAt: Date.now(), models }, null, 2),
    { mode: 0o600 },
  );
  await rename(tmp, file);
  return models;
}
export function chooseDefault(models: Model[], requested?: string) {
  const m = requested ?? models.find((m) => !m.hidden && m.available)?.id;
  if (!m) throw new BridgeError('No available models were discovered. Run clasp models --refresh.');
  return m;
}
