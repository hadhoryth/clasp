> Historical design reference: this specification predates the **Clasp** name. The current command is `clasp`; see the README for current installation and behavior.

Yes. I’d design it as a **transparent Claude Code → Codex compatibility layer**, rather than a wrapper that merely swaps the main model.

The key requirement is:

> **Claude Code should behave as if it is talking to Anthropic, while every model request—including subagents, classifiers, compaction, and background tasks—is deliberately routed to a model available through the user's Codex account.**

That fixes exactly the problems we've hit.

## `claude-codex-next` — specification

### 1. Goals

The tool should give you:

```text
Claude Code UX / orchestration
        +
Claude Code agents / plan mode / permissions
        +
OpenAI Codex models
        +
ChatGPT/Codex authentication
```

with one command:

```bash
claude-codex
```

No Anthropic account should be required.

The user should also be able to do:

```bash
claude-codex --model gpt-6-sol
```

and have **all of Claude Code continue working**, not merely the main conversation.

---

# 2. Architecture

I would split it into four components:

```text
┌──────────────────────────────────────┐
│             Claude Code              │
│                                      │
│ main model                           │
│ Explore agents                       │
│ Plan agents                          │
│ Auto-mode classifier                 │
│ compact/summarization                │
└──────────────────┬───────────────────┘
                   │
          Anthropic Messages API
                   │
                   ▼
┌──────────────────────────────────────┐
│       claude-codex gateway           │
│                                      │
│ 1. Model router                      │
│ 2. Anthropic ↔ OpenAI translator     │
│ 3. Model catalog                     │
│ 4. Authentication                   │
└──────────────────┬───────────────────┘
                   │
             OpenAI Responses
                   │
                   ▼
┌──────────────────────────────────────┐
│            Codex backend             │
│                                      │
│   GPT Sol / Luna / Astra / etc.      │
└──────────────────────────────────────┘
```

The big difference from the current project:

**Every request goes through the router.**

Not:

```text
main model → GPT
internal model → accidentally Anthropic
```

---

# 3. Never hard-code the OpenAI model list

This is the biggest flaw in the current bridge.

On startup:

```text
claude-codex
      ↓
discover models available to this account
      ↓
build internal model catalog
```

For example:

```bash
$ claude-codex models

MODEL                    CONTEXT     AVAILABLE
gpt-6-sol                1M          yes
gpt-6-luna               256k        yes
gpt-6-astra              1M          no
gpt-5.6-sol              1M          yes
...
```

It should discover this dynamically from the same source used by Codex.

Cache it locally:

```text
~/.cache/claude-codex/models.json
```

but refresh periodically:

```text
TTL: 1 hour
```

and provide:

```bash
claude-codex models --refresh
```

### Important behavior

If the user asks for:

```bash
claude-codex --model gpt-6-sol
```

and that model isn't available:

```text
Error: gpt-6-sol is not available through your Codex account.

Available:
  gpt-5.6-sol
  gpt-5.6-terra
  gpt-5.3-codex-spark
```

Never silently fall back.

---

# 4. Role-based model routing

This is probably the most important feature.

Claude Code doesn't have just one model.

Internally, requests may target things like:

```text
claude-opus-*
claude-sonnet-*
claude-haiku-*
```

and specialized uses like the Auto Mode classifier.

The gateway needs a routing table.

For example:

```toml
[models]
default = "gpt-6-sol"

[routing]
opus = "gpt-6-sol"
sonnet = "gpt-6-sol"
haiku = "gpt-6-luna"

classifier = "gpt-6-luna"
subagent = "gpt-6-sol"
compact = "gpt-6-luna"
```

The exact model names aren't important. They are user-configurable.

Then:

```text
Claude Code asks                Router selects
───────────────────────────────────────────────
claude-opus-*              →    gpt-6-sol
claude-sonnet-*            →    gpt-6-sol
claude-haiku-*             →    gpt-6-luna

Auto classifier            →    gpt-6-luna
Explore agent              →    gpt-6-sol
Plan agent                 →    gpt-6-sol
Compact                    →    gpt-6-luna
```

This would have prevented the problem you just encountered:

```text
claude-sonnet-5 is temporarily unavailable
```

because the request would never leave for Anthropic.

---

# 5. Classifier detection

Don't rely exclusively on the requested model ID.

The router should classify the **kind of Claude Code request**.

Something like:

```text
route(request):

    if request_is_auto_mode_classifier(request):
        return config.routing.classifier

    if request_is_compaction(request):
        return config.routing.compact

    if request_is_subagent(request):
        return config.routing.subagent

    return map_requested_model(request.model)
```

Detection should use things such as:

```text
model ID
system prompt fingerprints
request metadata
tool definitions
known Claude Code request structure
```

That makes it resilient when Anthropic changes:

```text
claude-sonnet-5
```

into:

```text
claude-sonnet-5-1
```

or something else.

---

# 6. Auto Mode must work

This should be a release-blocking requirement.

Your exact scenario becomes an integration test:

```text
1. Start Claude Code.
2. Enable Auto Mode.
3. Enter Plan Mode.
4. Spawn Explore agent.
5. Agent triggers classifier.
6. Classifier gets routed to configured GPT model.
7. Explore agent runs.
```

Expected:

```text
✓ no Anthropic login
✓ no claude-sonnet request escaping gateway
✓ no interruption
```

If the classifier model itself fails, the bridge should **fail safe to manual approval**, not break the session:

```text
Auto-mode classifier unavailable.
Falling back to manual approval for this tool call.
```

That would be much better than:

```text
Interrupted · What should Claude do instead?
```

---

# 7. Full Anthropic Messages API translation

This needs to be treated as an actual compatibility layer.

It should support:

```text
POST /v1/messages

system
messages
max_tokens
temperature
stop_sequences
tools
tool_choice
stream
metadata
```

And content blocks:

```text
text
image
tool_use
tool_result
```

For streaming:

```text
Anthropic SSE             OpenAI stream
────────────────────────────────────────
message_start       ←
content_block_start ←
content_block_delta ←    output_text.delta
content_block_stop  ←
message_delta       ←
message_stop        ←
```

Tool calls are particularly important.

For example:

```json
{
  "type": "tool_use",
  "id": "tool_123",
  "name": "Bash",
  "input": {
    "command": "git status"
  }
}
```

must round-trip correctly through OpenAI's function/tool representation.

Claude Code is extremely dependent on this being exact.

---

# 8. Don't fake reasoning blocks

This deserves an explicit requirement.

If OpenAI returns hidden reasoning tokens, don't manufacture Claude-style:

```text
thinking
```

blocks.

Instead:

```text
OpenAI reasoning → remains private
OpenAI reasoning summary → optionally map if available
normal output → Anthropic text content
```

The bridge should preserve semantics rather than trying to imitate Claude's internals.

---

# 9. Context-window metadata

This warning:

```text
"gpt-6-sol" isn't described by this version's model catalog
...
auto-compact keeps this session within 200k tokens
```

should disappear.

The model catalog should contain:

```json
{
  "id": "gpt-6-sol",
  "context_window": 1000000,
  "max_output_tokens": 64000,
  "reasoning": true,
  "tools": true,
  "images": true
}
```

Then the launcher should configure Claude Code using its supported model override / `behavesAs` mechanism.

Conceptually:

```text
gpt-6-sol
    behavesAs:
        known Claude large-context model

contextWindow:
        actual GPT context size
```

The user shouldn't need:

```bash
CLAUDE_CODE_MAX_CONTEXT_TOKENS=...
```

manually.

---

# 10. Reasoning effort

This should be first-class.

```bash
claude-codex --model gpt-6-sol --effort xhigh
```

Or configuration:

```toml
[reasoning]
main = "xhigh"
subagent = "high"
classifier = "low"
compact = "low"
```

That's useful because you probably don't want:

```text
Auto classifier → xhigh
```

That's slow and wasteful.

Instead:

```text
main       gpt-6-sol   xhigh
planning   gpt-6-sol   xhigh
explore    gpt-6-sol   high
classifier gpt-6-luna  low
compact    gpt-6-luna  low
```

---

# 11. Authentication

The launcher should handle authentication itself.

Commands:

```bash
claude-codex auth login
claude-codex auth status
claude-codex auth logout
```

Ideally it delegates login to:

```bash
codex login
```

and uses the credentials Codex already manages.

It should never print tokens.

### Claude-side auth

Instead of users manually doing:

```bash
ANTHROPIC_AUTH_TOKEN=codex-local
```

the launcher generates a **random session token**:

```text
6c14d4...random...
```

and starts:

```text
ANTHROPIC_AUTH_TOKEN=<random>
ANTHROPIC_BASE_URL=http://127.0.0.1:<port>
```

The gateway verifies that token.

That's better than a permanent known dummy token.

---

# 12. Bind only to localhost

By default:

```text
127.0.0.1:<random-port>
```

not:

```text
0.0.0.0
```

For example:

```text
127.0.0.1:37421
```

This also allows several sessions simultaneously without fighting over port `3099`.

---

# 13. Process lifecycle

Running:

```bash
claude-codex
```

should internally do:

```text
discover credentials
       ↓
discover models
       ↓
choose model
       ↓
start gateway on random port
       ↓
configure isolated Claude environment
       ↓
spawn claude
       ↓
wait
       ↓
Claude exits
       ↓
terminate gateway
```

`Ctrl+C` cleans everything up.

No orphan proxy process.

---

# 14. Isolated Claude configuration

Keep:

```text
~/.claude-codex/
```

This part of the existing implementation is a good idea.

But automatically bootstrap it:

```json
{
  "hasCompletedOnboarding": true
}
```

and add the required model metadata.

No manual surgery like we had to do.

---

# 15. Configuration

One human-readable config:

```text
~/.config/claude-codex/config.toml
```

Example:

```toml
default_model = "gpt-6-sol"

[reasoning]
main = "xhigh"
subagent = "high"
classifier = "low"
compact = "low"

[routing]
opus = "gpt-6-sol"
sonnet = "gpt-6-sol"
haiku = "gpt-6-luna"

subagent = "gpt-6-sol"
classifier = "gpt-6-luna"
compact = "gpt-6-luna"

[gateway]
host = "127.0.0.1"

[models]
refresh_interval = "1h"
```

Simple enough that you could understand the whole config at a glance.

---

# 16. Excellent diagnostics

This project absolutely needs:

```bash
claude-codex doctor
```

Output:

```text
Claude Codex Doctor

Claude Code
  ✓ installed
  ✓ version 2.1.280

Codex
  ✓ installed
  ✓ authenticated

Models
  ✓ gpt-6-sol
  ✓ gpt-6-luna
  ✗ gpt-6-astra       not available for account

Routing
  main       → gpt-6-sol / xhigh
  subagent   → gpt-6-sol / high
  classifier → gpt-6-luna / low
  compact    → gpt-6-luna / low

Gateway
  ✓ Anthropic Messages translation
  ✓ streaming
  ✓ tool use
  ✓ images

Claude configuration
  ✓ onboarding complete
  ✓ model overrides installed

Ready.
```

That would have saved us quite a bit of debugging today.

---

# 17. Request tracing

Another useful option:

```bash
claude-codex --trace
```

Show **metadata only**, not prompts:

```text
10:42:01 MAIN
  requested: gpt-6-sol
  routed:    gpt-6-sol
  effort:    xhigh

10:42:04 SUBAGENT
  requested: claude-sonnet-5
  routed:    gpt-6-sol
  effort:    high

10:42:05 CLASSIFIER
  requested: claude-sonnet-5
  routed:    gpt-6-luna
  effort:    low
```

This would immediately answer questions like:

> Why is it switching to Sonnet?

You'd see that it **isn't**.

For privacy:

```text
request body logging = OFF
response body logging = OFF
tokens = REDACTED
```

by default.

---

# 18. `/model` integration

Ideally `/model` should become useful.

Instead of:

```text
Codex gpt-5.5
Codex gpt-5.4
Codex gpt-5.3...
```

hard-coded forever, the bridge should generate rows from the discovered catalog.

Something like:

```text
OpenAI / Codex

❯ GPT-6 Sol
  GPT-6 Luna
  GPT-5.6 Sol
  GPT-5.3 Codex Spark
```

And selecting one changes only:

```text
routing.main
```

unless explicitly requested otherwise.

That's important because choosing Luna shouldn't accidentally make your classifier or subagents weird.

---

# 19. No silent fallback

This should be a hard rule.

Bad:

```text
gpt-6-sol unavailable
→ secretly use gpt-5.5
```

Good:

```text
gpt-6-sol is unavailable.

Configured fallback:
  none

Run:
  claude-codex models
```

If users want fallback:

```toml
[fallback]
"gpt-6-sol" = ["gpt-5.6-sol"]
```

then log it clearly:

```text
⚠ gpt-6-sol unavailable; using configured fallback gpt-5.6-sol
```

---

# 20. Compatibility test suite

This would determine whether the project stays alive as Claude Code evolves.

Every release should test:

```text
✓ startup without Anthropic account
✓ normal conversation
✓ streaming
✓ Bash
✓ Read
✓ Write
✓ Edit
✓ Glob
✓ Grep
✓ tool result round-trip
✓ Plan Mode
✓ Explore agent
✓ parallel agents
✓ Auto Mode classifier
✓ manual permission mode
✓ images
✓ MCP
✓ /model
✓ /compact
✓ automatic context compaction
✓ resume session
✓ Ctrl+C
✓ rate limit handling
```

And especially:

```text
assert(no_request_reaches_anthropic)
```

That should literally be an invariant.

---

# 21. Failure handling

A few important rules:

### Main model unavailable

Stop:

```text
gpt-6-sol unavailable.
```

### Subagent model unavailable

Either use configured fallback or:

```text
Subagent couldn't start.
```

Don't silently change it.

### Classifier unavailable

Gracefully downgrade:

```text
Classifier unavailable.
This tool call requires manual approval.
```

### Codex token expired

Refresh automatically if possible.

Otherwise:

```text
Codex authentication expired.

Run:
  claude-codex auth login
```

### API schema changed

Say exactly what's wrong:

```text
Unsupported Claude Code Messages event:
  content_block_delta.signature_delta

Claude Code: 2.1.310
claude-codex: 0.4.1
```

rather than producing mysterious failures.

---

# 22. Implementation language

For v1, I'd actually use **TypeScript**.

Something like:

```text
src/
├── cli/
│   ├── main.ts
│   ├── doctor.ts
│   ├── models.ts
│   └── auth.ts
│
├── gateway/
│   ├── server.ts
│   ├── anthropic.ts
│   ├── openai.ts
│   ├── stream.ts
│   └── tools.ts
│
├── routing/
│   ├── router.ts
│   ├── classifier.ts
│   └── models.ts
│
├── codex/
│   ├── auth.ts
│   ├── catalog.ts
│   └── client.ts
│
├── claude/
│   ├── launcher.ts
│   ├── config.ts
│   └── models.ts
│
└── config.ts
```

Node is already there because Claude Code is installed via npm, and TypeScript is very convenient for:

- SSE
- JSON APIs
- subprocess management
- HTTP proxying
- npm distribution

Later, if the project becomes substantial, a single Rust binary could be attractive. I wouldn't start there.

---

# 23. MVP

I would **not** build all of the above initially.

Version `0.1` should solve exactly the problems we've discovered:

```text
1. Codex OAuth
2. dynamic model discovery
3. Anthropic Messages → OpenAI Responses
4. streaming
5. tools
6. main model routing
7. Claude opus/sonnet/haiku routing
8. Auto-mode classifier routing
9. context metadata
10. automatic Claude onboarding
11. ephemeral localhost proxy
12. `doctor`
```

CLI:

```bash
claude-codex
claude-codex --model gpt-6-sol
claude-codex models
claude-codex doctor
```

That's enough.

---

## The core design in ~30 lines

If I had to reduce the entire project specification to its essence:

```text
claude-codex

Purpose:
  Run Claude Code entirely against models accessible through Codex.

Requirements:

1. No Anthropic account required.
2. Discover Codex models dynamically.
3. Never hard-code GPT model IDs.
4. Translate the complete Anthropic Messages protocol.
5. Route every Claude Code model request.
6. Map Opus/Sonnet/Haiku requests to configurable GPT models.
7. Detect and route Auto Mode classifier requests.
8. Detect and route subagents.
9. Route compaction/background requests.
10. Never silently fall back to another model.
11. Populate correct context-window metadata.
12. Support configurable reasoning effort per role.
13. Automatically configure Claude Code.
14. Use Codex OAuth credentials.
15. Bind gateway to localhost only.
16. Use an ephemeral port and random local auth token.
17. Clean up gateway when Claude exits.
18. Provide live model listing.
19. Provide a `doctor` command.
20. Provide privacy-safe routing traces.
21. If the classifier fails, fall back to manual approval.
22. No request may accidentally reach Anthropic.
```

The architectural insight is really **#5**. The existing project treats this as *“replace Claude with GPT.”* A robust implementation needs to treat it as *“emulate the Anthropic backend expected by Claude Code.”* Once you frame it that way, the stale picker, Sonnet classifier, authentication gate, context-window warning, subagents, and future Claude Code changes all become parts of the same compatibility-layer problem.