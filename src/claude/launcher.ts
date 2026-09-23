import { spawn } from 'node:child_process';
import { BridgeError } from '../errors.js';
export function launchEnvironment(
  base: NodeJS.ProcessEnv,
  options: {
    url: string;
    token: string;
    directory: string;
    proxy: string;
    contextWindow: number;
    model: string;
  },
) {
  const env = { ...base };
  for (const key of Object.keys(env))
    if (
      key.startsWith('ANTHROPIC_') ||
      key.startsWith('CLAUDE_CODE_USE_') ||
      key.startsWith('CLAUDE_CODE_OAUTH') ||
      key.startsWith('CLAUDE_CODE_SUBAGENT') ||
      [
        'CLAUDECODE',
        'CLAUDE_CONFIG_DIR',
        'CLAUDE_CODE_API_KEY_HELPER_TTL_MS',
        'CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST',
        'CLAUDE_CODE_MAX_CONTEXT_TOKENS',
        'CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT',
        'DISABLE_COMPACT',
        'DISABLE_AUTO_COMPACT',
        'CCR_OAUTH_TOKEN_FILE',
        'CLAUDE_CODE_GATEWAY_URL',
        'CLAUDE_CODE_GATEWAY_BASE_URL',
        'NODE_OPTIONS',
      ].includes(key)
    )
      delete env[key];
  return {
    ...env,
    ANTHROPIC_AUTH_TOKEN: options.token,
    ANTHROPIC_API_KEY: options.token,
    ANTHROPIC_BASE_URL: options.url,
    ANTHROPIC_MODEL: options.model,
    ANTHROPIC_DEFAULT_OPUS_MODEL: 'claude-opus-4-6',
    ANTHROPIC_DEFAULT_SONNET_MODEL: 'claude-sonnet-4-6',
    ANTHROPIC_DEFAULT_HAIKU_MODEL: 'claude-haiku-4-5',
    ANTHROPIC_DEFAULT_FABLE_MODEL: 'claude-fable-5',
    CLAUDE_CONFIG_DIR: options.directory,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    DISABLE_TELEMETRY: '1',
    DISABLE_ERROR_REPORTING: '1',
    DISABLE_AUTOUPDATER: '1',
    CLAUDE_CODE_DISABLE_FAST_MODE: '1',
    CLAUDE_CODE_NO_MODEL_FALLBACK: '1',
    CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: '1',
    CLAUDE_CODE_DISABLE_THINKING: '1',
    DISABLE_PROMPT_CACHING: '1',
    ENABLE_TOOL_SEARCH: 'false',
    CLAUDE_CODE_MAX_CONTEXT_TOKENS: String(options.contextWindow),
    CLAUDE_CODE_AUTO_COMPACT_WINDOW: String(Math.min(options.contextWindow, 200000)),
    HTTP_PROXY: options.proxy,
    HTTPS_PROXY: options.proxy,
    ALL_PROXY: options.proxy,
    http_proxy: options.proxy,
    https_proxy: options.proxy,
    all_proxy: options.proxy,
    NO_PROXY: '127.0.0.1,localhost,::1',
    no_proxy: '127.0.0.1,localhost,::1',
  };
}
export function validateClaudeArgs(args: string[]) {
  const blocked = [
    '--settings',
    '--setting-sources',
    '--fallback-model',
    '--model',
    '--effort',
    '--cloud',
    '--teleport',
    '--remote-control',
    '--bg',
    '--background',
    '--environment',
    '--tmux',
  ];
  for (const a of args)
    if (blocked.some((b) => a === b || a.startsWith(b + '=')))
      throw new BridgeError(
        `${a.split('=')[0]} is controlled by the bridge or uses a remote process. Configure the bridge instead.`,
      );
}
export async function runClaude(args: string[], env: NodeJS.ProcessEnv, settingsFile: string) {
  validateClaudeArgs(args);
  return new Promise<number>((resolve, reject) => {
    const child = spawn(
      'claude',
      ['--setting-sources', 'user', '--settings', settingsFile, ...args],
      { env, stdio: 'inherit' },
    );
    let killTimer: NodeJS.Timeout | undefined;
    // Ctrl+C in an interactive terminal is received by both processes. Claude owns
    // it so it can cancel a turn without tearing down the session.
    const interrupt = () => {
      if (!process.stdin.isTTY) child.kill('SIGINT');
    };
    const terminate = () => {
      child.kill('SIGTERM');
      killTimer ??= setTimeout(() => child.kill('SIGKILL'), 3000);
    };
    process.on('SIGINT', interrupt);
    process.on('SIGTERM', terminate);
    process.on('SIGHUP', terminate);
    const cleanup = () => {
      if (killTimer) clearTimeout(killTimer);
      process.off('SIGINT', interrupt);
      process.off('SIGTERM', terminate);
      process.off('SIGHUP', terminate);
    };
    child.once('error', () => {
      cleanup();
      reject(new BridgeError('Cannot launch Claude Code. Install the claude CLI.'));
    });
    child.once('exit', (code, signal) => {
      cleanup();
      resolve(code ?? (signal === 'SIGINT' ? 130 : 143));
    });
  });
}
