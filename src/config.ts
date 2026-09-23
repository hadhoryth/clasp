import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'smol-toml';
import { z } from 'zod';
import { BridgeError } from './errors.js';
const id = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,150}$/);
const effort = z.enum(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
const roles = z
  .object({
    main: effort.optional(),
    subagent: effort.optional(),
    classifier: effort.optional(),
    compact: effort.optional(),
    background: effort.optional(),
  })
  .strict();
const routes = z
  .object({
    opus: id.optional(),
    sonnet: id.optional(),
    haiku: id.optional(),
    fable: id.optional(),
    subagent: id.optional(),
    classifier: id.optional(),
    compact: id.optional(),
    background: id.optional(),
  })
  .strict();
export const ConfigSchema = z
  .object({
    default_model: id.optional(),
    reasoning: roles.default({}),
    routing: routes.default({}),
    fallback: z.record(id, z.array(id).min(1)).default({}),
    gateway: z
      .object({
        host: z.literal('127.0.0.1').default('127.0.0.1'),
        timeout_ms: z.number().int().min(1000).max(3600000).default(600000),
        max_body_bytes: z
          .number()
          .int()
          .min(1024)
          .max(128 * 1024 * 1024)
          .default(32 * 1024 * 1024),
      })
      .strict()
      .default({}),
    models: z
      .object({
        refresh_interval: z
          .string()
          .regex(/^\d+[smh]$/)
          .default('1h'),
      })
      .strict()
      .default({}),
    claude: z
      .object({
        behaves_as: z.string().default('claude-sonnet-4-6'),
        classify_all_shell: z.boolean().default(false),
      })
      .strict()
      .default({}),
  })
  .strict();
export type Config = z.infer<typeof ConfigSchema>;
export function paths(env: NodeJS.ProcessEnv = process.env) {
  return {
    config: join(env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'claude-codex', 'config.toml'),
    cache: join(env.XDG_CACHE_HOME ?? join(homedir(), '.cache'), 'claude-codex', 'models.json'),
    claude: env.CLAUDE_CODEX_CONFIG_DIR ?? join(homedir(), '.claude-codex'),
  };
}
export async function loadConfig(file = paths().config): Promise<Config> {
  let content = '';
  try {
    content = await readFile(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT')
      throw new BridgeError('Cannot read bridge configuration.');
  }
  try {
    return ConfigSchema.parse(content ? parse(content) : {});
  } catch (e) {
    if (e instanceof z.ZodError)
      throw new BridgeError(
        `Invalid configuration fields: ${e.issues.map((i) => i.path.join('.') || 'root').join(', ')}.`,
      );
    throw new BridgeError('Invalid TOML configuration. Check syntax in ' + file + '.');
  }
}
export function ttl(value: string) {
  return Number(value.slice(0, -1)) * ({ s: 1000, m: 60000, h: 3600000 }[value.slice(-1)] ?? 0);
}
