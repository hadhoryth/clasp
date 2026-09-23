import { VERSION } from '../version.js';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { BridgeError } from '../errors.js';
export class CodexRPC {
  private child?: ChildProcessWithoutNullStreams;
  private pending = new Map<
    number,
    { resolve: (x: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }
  >();
  private counter = 0;
  private ready?: Promise<void>;
  constructor(private readonly executable = 'codex') {}
  start(): Promise<void> {
    return (this.ready ??= this.initialize());
  }
  private async initialize() {
    const child = (this.child = spawn(this.executable, ['app-server'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, RUST_LOG: 'off' },
    }));
    // Never forward app-server diagnostics: they can contain account or request data.
    child.stderr.resume();
    const lines = createInterface({ input: child.stdout });
    lines.on('line', (line) => {
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }
      const job = this.pending.get(message.id);
      if (!job) return;
      clearTimeout(job.timer);
      this.pending.delete(message.id);
      if (message.error)
        job.reject(
          new BridgeError(
            'Installed Codex does not support the required app-server operation. Update Codex and run doctor.',
            502,
            'api_error',
          ),
        );
      else job.resolve(message.result);
    });
    child.on('error', () =>
      this.fail('Cannot start Codex. Install the Codex CLI and run codex login.'),
    );
    child.on('exit', () => this.fail('Codex app-server exited. Restart clasp.'));
    child.stdin.on('error', () => this.fail('Codex app-server input closed.'));
    await this.call('initialize', {
      clientInfo: { name: 'clasp', title: 'Clasp', version: VERSION },
      capabilities: { experimentalApi: true },
    });
    child.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n');
  }
  call<T = any>(method: string, params: unknown): Promise<T> {
    return new Promise((resolve, reject) => {
      if (!this.child || this.child.exitCode !== null)
        return reject(new BridgeError('Codex app-server is not running.', 503, 'api_error'));
      const id = ++this.counter;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new BridgeError('Codex app-server timed out. Run clasp doctor.', 504, 'api_error'));
      }, 30000);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
    });
  }
  private fail(message: string) {
    for (const item of this.pending.values()) {
      clearTimeout(item.timer);
      item.reject(new BridgeError(message, 503, 'api_error'));
    }
    this.pending.clear();
  }
  async close() {
    this.fail('Codex connection closed.');
    const p = this.child;
    if (!p || p.pid === undefined || p.exitCode !== null) return;
    const exited = new Promise<void>((resolve) => p.once('exit', () => resolve()));
    p.stdin.end();
    p.kill('SIGTERM');
    const timer = setTimeout(() => p.kill('SIGKILL'), 2000);
    await exited;
    clearTimeout(timer);
  }
}
