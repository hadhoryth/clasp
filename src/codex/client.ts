import { execFileSync } from 'node:child_process';
import { BridgeError } from '../errors.js';
import type { CodexAuth } from './auth.js';
const ORIGIN = 'https://chatgpt.com';
export class CodexClient {
  private version?: string;
  constructor(
    private auth: CodexAuth,
    private transport: typeof fetch = fetch,
    private readVersion = installedVersion,
  ) {}
  async request(
    path: '/models' | '/responses',
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<Response> {
    let version = this.version ?? '';
    try {
      if (!version) version = this.readVersion();
      this.version = version;
    } catch {
      throw new BridgeError('Cannot determine Codex version.');
    }
    for (let attempt = 0; attempt < 2; attempt++) {
      const credential = await this.auth.get(attempt === 1);
      let response: Response;
      try {
        response = await this.transport(
          `${ORIGIN}/backend-api/codex${path}${path === '/models' ? '?client_version=' + encodeURIComponent(version) : ''}`,
          {
            method: body ? 'POST' : 'GET',
            redirect: 'error',
            signal: signal ?? AbortSignal.timeout(30000),
            headers: {
              Authorization: `Bearer ${credential.token}`,
              'ChatGPT-Account-Id': credential.accountId,
              originator: 'codex_cli_rs',
              'User-Agent': `codex_cli_rs/${version}`,
              'Content-Type': 'application/json',
              Accept: body ? 'text/event-stream' : 'application/json',
            },
            ...(body ? { body: JSON.stringify(body) } : {}),
          },
        );
      } catch {
        if (signal?.aborted) throw signal.reason;
        throw new BridgeError('Cannot reach the Codex backend.', 502, 'api_error');
      }
      if (response.status === 401 && attempt === 0) {
        await response.body?.cancel();
        continue;
      }
      if (response.ok) return response;
      let code = '';
      let context = false;
      try {
        const e: any = await response.json();
        code = typeof e.error?.code === 'string' ? e.error.code : '';
        context = /context.*(length|window)|too many tokens|maximum context/i.test(
          String(e.error?.message ?? e.detail ?? ''),
        );
      } catch {}
      if (context)
        throw new BridgeError(
          'prompt is too long: Codex context window exceeded. Use /compact.',
          400,
        );
      if (response.status === 401)
        throw new BridgeError(
          'Codex authentication expired. Run clasp auth login.',
          401,
          'authentication_error',
        );
      if (response.status === 429)
        throw new BridgeError(
          'Codex rate limit reached. Retry when your account limit resets.',
          429,
          'rate_limit_error',
          response.headers.get('retry-after') ?? undefined,
        );
      if (response.status === 403 || response.status === 404 || code === 'model_not_found')
        throw new BridgeError(
          'The selected model is unavailable through this Codex account. Run clasp models --refresh.',
          code === 'model_not_found' ? 404 : response.status,
          'permission_error',
        );
      throw new BridgeError(
        `Codex rejected the request (HTTP ${response.status}${/^[a-z0-9_]{1,80}$/.test(code) ? ', ' + code : ''}). Run clasp doctor.`,
        response.status === 503 ? 503 : response.status >= 500 ? 502 : 400,
        'api_error',
      );
    }
    throw new BridgeError('Codex authentication failed.', 401, 'authentication_error');
  }
}

function installedVersion(): string {
  return (
    execFileSync('codex', ['--version'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 10000,
    })
      .trim()
      .split(' ')
      .at(-1) ?? ''
  );
}
