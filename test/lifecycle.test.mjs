import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, chmod, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { CodexRPC } from '../dist/codex/rpc.js';
test('missing Codex rejects startup and close does not hang', async () => {
  const rpc = new CodexRPC('/definitely/missing/codex');
  await assert.rejects(rpc.start(), /Cannot start/);
  await rpc.close();
});
test(
  'SIGTERM terminates the owned Claude child and preserves exit status',
  { timeout: 8000 },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cc-process-'));
    let runner, childPid;
    try {
      const executable = join(dir, 'claude');
      await writeFile(
        executable,
        `#!${process.execPath}\nconsole.log('CHILD '+process.pid);setInterval(()=>{},1000);\n`,
      );
      await chmod(executable, 0o700);
      const url = pathToFileURL(resolve('dist/claude/launcher.js')).href;
      runner = spawn(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          `import {runClaude} from ${JSON.stringify(url)};process.exitCode=await runClaude([],process.env,'unused');`,
        ],
        {
          env: { ...process.env, PATH: dir + ':' + process.env.PATH },
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      const closed = once(runner, 'exit');
      let text = '';
      for await (const chunk of runner.stdout) {
        text += chunk;
        const m = text.match(/CHILD (\d+)/);
        if (m) {
          childPid = Number(m[1]);
          break;
        }
      }
      assert.ok(childPid);
      runner.kill('SIGTERM');
      const [code] = await closed;
      assert.equal(code, 143);
      assert.throws(() => process.kill(childPid, 0), { code: 'ESRCH' });
    } finally {
      runner?.kill('SIGKILL');
      await rm(dir, { recursive: true, force: true });
    }
  },
);
