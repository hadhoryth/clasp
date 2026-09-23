import { mkdir, readFile, writeFile, rename, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Model } from '../codex/catalog.js';
import type { Config } from '../config.js';
import { BridgeError } from '../errors.js';
export function modelSettings(models: Model[], config: Config) {
  return {
    modelPicker: {
      replaceBuiltInOptions: true,
      options: models
        .filter((m) => !m.hidden && m.available)
        .map((m) => ({
          model: m.id,
          label: m.name,
          description: `Codex · ${m.contextWindow.toLocaleString('en-US')} token context`,
          behavesAs: config.claude.behaves_as,
        })),
    },
    env: { ENABLE_TOOL_SEARCH: 'false' },
    autoMode: { classifyAllShell: config.claude.classify_all_shell },
    autoUpdatesChannel: 'stable',
  };
}
export const shellQuote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";
export async function prepareClaude(
  directory: string,
  models: Model[],
  config: Config,
  hookPath: string,
) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const onboarding = join(directory, '.claude.json');
  let previous: Record<string, unknown> = {};
  try {
    previous = JSON.parse(await readFile(onboarding, 'utf8'));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT')
      throw new BridgeError(
        'Isolated Claude onboarding file is not valid JSON. Repair ' + onboarding + '.',
      );
  }
  const tmp = onboarding + '.' + randomUUID();
  await writeFile(tmp, JSON.stringify({ ...previous, hasCompletedOnboarding: true }, null, 2), {
    mode: 0o600,
  });
  await rename(tmp, onboarding);
  const session = await mkdtemp(join(directory, 'bridge-'));
  const failureFile = join(session, 'manual-approval');
  const settingsFile = join(session, 'settings.json');
  const command = [process.execPath, hookPath, failureFile].map(shellQuote).join(' ');
  const hook = [{ matcher: '*', hooks: [{ type: 'command', command, timeout: 5 }] }];
  const settings = {
    ...modelSettings(models, config),
    hooks: { PreToolUse: hook, PermissionDenied: hook },
  };
  await writeFile(settingsFile, JSON.stringify(settings, null, 2), { mode: 0o600 });
  return {
    settingsFile,
    failureFile,
    async markClassifierFailure() {
      await writeFile(failureFile, 'Classifier unavailable. Manual approval is required.\n', {
        mode: 0o600,
      });
    },
    async close() {
      await rm(session, { recursive: true, force: true });
    },
  };
}
