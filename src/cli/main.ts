import { VERSION } from '../version.js';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadConfig, paths, ttl } from '../config.js';
import { BridgeError, safeError } from '../errors.js';
import { CodexRPC } from '../codex/rpc.js';
import { CodexAuth } from '../codex/auth.js';
import { CodexClient } from '../codex/client.js';
import { discoverModels, chooseDefault } from '../codex/catalog.js';
import { Router } from '../routing/router.js';
import { startGateway } from '../gateway/server.js';
import { startEgressGuard } from '../claude/egress.js';
import { prepareClaude } from '../claude/config.js';
import { launchEnvironment, runClaude, validateClaudeArgs } from '../claude/launcher.js';
const help = `clasp — Claude Code through your Codex account

Usage:
  clasp [--model ID] [--effort LEVEL] [--trace] [-- CLAUDE_ARGS...]
  clasp models [--refresh] [--json]
  clasp doctor [--refresh]
  clasp auth login|status|logout

Options:
  --config FILE   TOML configuration (default ~/.config/claude-codex/config.toml)
  --model ID      Main model; validated against the live/cached account catalog
  --effort LEVEL  Main reasoning effort; validated against the selected model
  --trace         Metadata-only request routing diagnostics
  --refresh       Refresh the account-scoped catalog cache
  --help          Show this help
  --version       Show bridge version

Without --model, uses default_model from config, then the catalog's first visible model.
Claude's permissions remain active. See README.md for compatibility limits.
`;
export function parseArgs(args: string[]) {
  const options: {
    model?: string;
    effort?: string;
    config?: string;
    trace: boolean;
    refresh: boolean;
    json: boolean;
    command: string;
    rest: string[];
  } = { trace: false, refresh: false, json: false, command: 'launch', rest: [] };
  if (['models', 'doctor', 'auth'].includes(args[0] ?? '')) options.command = args.shift()!;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--') {
      options.rest.push(...args.slice(i + 1));
      break;
    }
    if (a === '--help' || a === '-h') {
      options.command = 'help';
      continue;
    }
    if (a === '--version') {
      options.command = 'version';
      continue;
    }
    if (['--trace', '--refresh', '--json'].includes(a)) {
      options[a.slice(2) as 'trace' | 'refresh' | 'json'] = true;
      continue;
    }
    const key = a.split('=')[0]!;
    if (['--model', '--effort', '--config'].includes(key)) {
      const value = a.includes('=') ? a.slice(a.indexOf('=') + 1) : args[++i];
      if (!value || value.startsWith('--')) throw new BridgeError(`Missing value for ${key}.`);
      options[key.slice(2) as 'model' | 'effort' | 'config'] = value;
      continue;
    }
    options.rest.push(a);
  }
  return options;
}
function version(exe: string) {
  try {
    return execFileSync(exe, ['--version'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 10000,
    }).trim();
  } catch {
    return null;
  }
}
async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.command === 'help') {
    console.log(help);
    return;
  }
  if (opts.command === 'version') {
    console.log(`clasp ${VERSION}`);
    return;
  }
  if (opts.command === 'auth') {
    const sub = opts.rest[0];
    if (!['login', 'logout', 'status'].includes(sub ?? '') || opts.rest.length !== 1)
      throw new BridgeError('Usage: clasp auth login|status|logout');
    const result = spawnSync(
      'codex',
      sub === 'status' ? ['login', 'status'] : [sub === 'logout' ? 'logout' : 'login'],
      { stdio: 'inherit' },
    );
    if (result.error) throw new BridgeError('Cannot run Codex. Install the Codex CLI.');
    process.exitCode = result.status ?? 1;
    return;
  }
  if (opts.command === 'launch') validateClaudeArgs(opts.rest);
  else if (opts.rest.length) throw new BridgeError('Unexpected arguments. Run clasp --help.');
  const config = await loadConfig(opts.config);
  if (opts.effort) {
    const allowed = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
    if (!allowed.includes(opts.effort)) throw new BridgeError('Invalid reasoning effort.');
    config.reasoning.main = opts.effort as typeof config.reasoning.main;
  }
  const rpc = new CodexRPC();
  const auth = new CodexAuth(rpc);
  const client = new CodexClient(auth);
  const cleanup: Array<() => Promise<void>> = [() => rpc.close()];
  let interrupted = false;
  const checkInterrupted = () => {
    if (interrupted) throw new BridgeError('Startup interrupted.');
  };
  const stop = () => {
    interrupted = true;
    process.exitCode = 130;
    void rpc.close();
  };
  let disposing: Promise<void> | undefined;
  const dispose = () =>
    (disposing ??= (async () => {
      for (const close of cleanup.reverse()) await close().catch(() => {});
    })());
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    const credential = await auth.get();
    checkInterrupted();
    const models = await discoverModels(
      client,
      paths().cache,
      credential.identity,
      ttl(config.models.refresh_interval),
      opts.refresh,
    );
    checkInterrupted();
    if (opts.command === 'models') {
      if (opts.json) console.log(JSON.stringify(models, null, 2));
      else {
        console.log('MODEL                        CONTEXT   OUTPUT   CATALOG');
        for (const m of models)
          console.log(
            `${m.id.padEnd(29)}${String(m.contextWindow).padEnd(10)}${String(m.maxOutputTokens ?? 'unknown').padEnd(9)}${m.available ? 'listed' : 'unavailable'}${m.hidden ? ' (hidden)' : ''}`,
          );
        console.log(
          '\nCatalog presence is not an inference entitlement guarantee; backend rejections are surfaced.',
        );
      }
      return;
    }
    const model = chooseDefault(models, opts.model ?? config.default_model);
    const router = new Router(config, models, model, (line) => console.error('[clasp] ' + line));
    router.validate();
    if (opts.command === 'doctor') {
      const claude = version('claude');
      console.log('Clasp Doctor\n');
      console.log(`Claude Code: ${claude ?? 'NOT INSTALLED'}`);
      console.log(`Codex: ${version('codex') ?? 'NOT INSTALLED'}`);
      console.log('Authentication: Codex ChatGPT credential available');
      console.log(
        `Models: ${models.filter((m) => m.available && !m.hidden).length} visible catalog entries`,
      );
      for (const role of ['main', 'subagent', 'classifier', 'compact', 'background']) {
        const route = router.route({
          model,
          max_tokens: 1,
          messages: [{ role: 'user', content: 'check' }],
          stream: false,
          metadata: { request_type: role },
        });
        console.log(`${role.padEnd(12)} → ${route.model.id} / ${route.effort ?? 'default'}`);
      }
      const gateway = await startGateway({ router, upstream: client, config });
      cleanup.push(() => gateway.close());
      checkInterrupted();
      const probe = await fetch(gateway.url + '/health', {
        headers: { Authorization: 'Bearer ' + gateway.token },
      });
      if (!probe.ok) throw new BridgeError('Local gateway health check failed.');
      console.log('Gateway: authenticated localhost bind passed');
      try {
        const state = JSON.parse(await readFile(join(paths().claude, '.claude.json'), 'utf8'));
        console.log(
          `Onboarding: ${state.hasCompletedOnboarding ? 'ready' : 'will be initialized on launch'}`,
        );
      } catch {
        console.log('Onboarding: will be initialized on launch');
      }
      console.log(
        '\nCompatibility limits: classifier failure blocks the current call and asks on later calls; context budget stays conservatively at 200K; sampling temperature is backend-controlled; output cap covers visible tokens only.',
      );
      console.log(
        'This check does not run paid inference or certify interactive Auto Mode. See docs/COMPATIBILITY.md.',
      );
      if (!claude) process.exitCode = 1;
      return;
    }
    const selected = router.resolve(model).model;
    const state = await prepareClaude(
      paths().claude,
      models,
      config,
      fileURLToPath(new URL('../../scripts/permission-hook.mjs', import.meta.url)),
    );
    cleanup.push(() => state.close());
    checkInterrupted();
    const gateway = await startGateway({
      router,
      upstream: client,
      config,
      trace: (line) => {
        if (opts.trace || !line.startsWith('{')) console.error('[clasp] ' + line);
      },
      onClassifierFailure: () => state.markClassifierFailure(),
    });
    cleanup.push(() => gateway.close());
    checkInterrupted();
    const guard = await startEgressGuard();
    cleanup.push(() => guard.close());
    checkInterrupted();
    const env = launchEnvironment(process.env, {
      url: gateway.url,
      token: gateway.token,
      directory: paths().claude,
      proxy: guard.url,
      contextWindow: selected.contextWindow,
      model: selected.id,
    });
    console.error(`[clasp] ${selected.id} · localhost gateway · isolated Claude profile`);
    // runClaude owns terminal signals after launch.
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
    process.exitCode = await runClaude(opts.rest, env, state.settingsFile);
  } finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
    await dispose();
  }
}
main().catch((error) => {
  console.error('clasp: ' + safeError(error).message);
  process.exitCode = 1;
});
