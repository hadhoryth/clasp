import { createHash } from 'node:crypto';
import { BridgeError } from '../errors.js';
import { CodexRPC } from './rpc.js';
export interface Credential {
  token: string;
  accountId: string;
  identity: string;
  expiresAt: number;
}
export class CodexAuth {
  private current?: Credential;
  private pending?: Promise<Credential>;
  constructor(readonly rpc: CodexRPC) {}
  async get(refresh = false): Promise<Credential> {
    if (!refresh && this.current && this.current.expiresAt > Date.now() + 60000)
      return this.current;
    return (this.pending ??= this.read(refresh).finally(() => {
      this.pending = undefined;
    }));
  }
  private async read(refresh: boolean): Promise<Credential> {
    await this.rpc.start();
    const result = await this.rpc.call<{ authMethod: string | null; authToken: string | null }>(
      'getAuthStatus',
      { includeToken: true, refreshToken: refresh },
    );
    if (result.authMethod !== 'chatgpt' || !result.authToken)
      throw new BridgeError(
        'A Codex ChatGPT login is required. Run clasp auth login.',
        401,
        'authentication_error',
      );
    let claims: any;
    try {
      claims = JSON.parse(
        Buffer.from(result.authToken.split('.')[1] ?? '', 'base64url').toString('utf8'),
      );
    } catch {
      throw new BridgeError(
        'Unrecognized Codex credential format. Run clasp auth login.',
        401,
        'authentication_error',
      );
    }
    const accountId = claims['https://api.openai.com/auth']?.chatgpt_account_id;
    if (typeof accountId !== 'string' || !accountId)
      throw new BridgeError(
        'Codex credential has no account identifier. Run clasp auth login.',
        401,
        'authentication_error',
      );
    if (!refresh && Number(claims.exp) * 1000 < Date.now() + 60000) return this.read(true);
    return (this.current = {
      token: result.authToken,
      accountId,
      identity: createHash('sha256')
        .update(accountId + ':' + claims.sub)
        .digest('hex'),
      expiresAt: Number(claims.exp) * 1000 || Date.now() + 60000,
    });
  }
}
