# Architecture

```text
clasp
  ├─ Codex app-server (credential acquisition and refresh over local stdio)
  ├─ authenticated model catalog → account-scoped metadata-only cache
  ├─ localhost Messages gateway → role router → Responses translator
  │                                      └→ fixed Codex backend HTTPS endpoint
  ├─ localhost egress proxy (rejects Anthropic/Claude domains)
  └─ Claude CLI (isolated profile, generated model picker, permission hooks)
```

`src/codex/rpc.ts` owns a JSON-lines Codex app-server process with request deadlines and cleanup. `getAuthStatus` is a locally generated protocol operation in Codex 0.154.0. It provides a ChatGPT credential and can delegate refresh to Codex, including Codex's credential-store handling. This legacy protocol operation and the backend endpoint are compatibility dependencies and can change.

`src/codex/catalog.ts` reads `/backend-api/codex/models?client_version=...`, preserving advertised `context_window`, reasoning effort and input modality metadata. Missing maximum output metadata stays null. Cache files are atomic, mode 0600, and scoped to a hash of account plus subject. An expired/unavailable cache never silently replaces a failed live refresh. A running session pins its catalog snapshot; restart or `models --refresh` for new choices.

`src/routing/router.ts` classifies every Messages request before translation. Role routing takes precedence over Claude family aliases and explicit main selections. Role identification cannot be perfect if Claude omits a distinguishing envelope signal or uses the same system prompt for multiple roles. Explicit integrations can send `x-claude-codex-role` or `metadata.request_type`.

`src/gateway/translate.ts` preserves message and tool-result order. Long/invalid function names and call IDs have deterministic encodings. Tools are mapped back to their original names before delivery. Tool outputs support text and images; execution errors remain marked in their textual result. Claude thinking history is omitted rather than impersonated as OpenAI reasoning.

`src/gateway/stream.ts` consumes Responses SSE with bounded frame buffering, text streaming, complete tool argument validation and Anthropic event ordering. Tool JSON is withheld until complete to avoid issuing malformed/truncated calls. Missing terminal events, unsupported output items and failed streams fail explicitly. Stop sequences are removed even across delta boundaries. The visible token cap uses `o200k_base` as an estimate; backend reasoning usage cannot be capped. Neither reasoning text nor reasoning summaries are exposed as Claude thinking blocks.

`src/gateway/server.ts` authenticates before parsing, accepts bounded JSON/gzip Messages bodies, aborts upstream work on client disconnect/shutdown, honors backpressure for output events, and emits keepalive pings. Upstream error bodies are never echoed. HTTP errors expose useful safe categories and retry information. No automatic model retries happen after streaming begins.

`src/claude/config.ts` initializes only the isolated profile. Session settings carry the picker and hook command. No credentials are written to those settings. `PreToolUse` asks for approval after classifier failure; `PermissionDenied` offers a retry hint only for the literal unavailable-classifier outcome and only after this bridge latched failure. It never produces an `allow` verdict. Claude retains deny rules and can ignore retry hints or decline to prompt in headless contexts.

The launch is attached. Terminal Ctrl+C remains available to Claude to cancel a turn; when Claude exits, gateway listeners, egress connections, Codex app-server, and generated session settings are cleaned up. SIGTERM/HUP terminate the child with a bounded forced-kill grace period. An OS SIGKILL cannot run cleanup code; it is not claimed to be handled.

## Protocol sources checked

- [Codex app-server](https://developers.openai.com/codex/app-server): stdio protocol and initialization; local 0.154.0 generated types established `getAuthStatus`.
- [Claude gateway compatibility](https://code.claude.com/docs/en/llm-gateway-protocol): inference endpoints, optional token counting, streaming, startup probes and gateway discovery.
- [Claude model configuration](https://code.claude.com/docs/en/model-config): model picker and context limits.
- [Claude hooks](https://code.claude.com/docs/en/hooks): permission hooks and retry restrictions.
- Local Claude 2.1.272 schema: `modelPicker.options[].behavesAs`, agent headers and classifier failure outcomes.

These interfaces were inspected on 2026-09-23. Tests and this document distinguish stable bridge behavior from client/backend-dependent behavior.
