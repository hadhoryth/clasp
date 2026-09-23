#!/usr/bin/env node
import { access } from 'node:fs/promises';
// Never approves a tool. Once a classifier fails, keep asking for the rest of this launch.
let input = '';
for await (const chunk of process.stdin) {
  input += chunk;
  if (input.length > 1024 * 1024) process.exit(1);
}
try {
  const event = JSON.parse(input);
  await access(process.argv[2]);
  if (event.hook_event_name === 'PermissionDenied' && event.reason === 'Classifier unavailable')
    process.stdout.write(
      JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionDenied', retry: true } }),
    );
  if (event.hook_event_name === 'PreToolUse')
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'ask',
          permissionDecisionReason:
            'Codex classifier unavailable. This action requires your manual approval.',
        },
      }),
    );
} catch {
  /* No failure latch: leave Claude's existing permission policy untouched. */
}
