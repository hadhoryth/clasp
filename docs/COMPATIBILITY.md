# Compatibility and release gates

This is a working experimental launcher/gateway. **The full specification's release gate is not yet met.** Do not describe it as a transparent replacement for every Anthropic feature.

| Requirement | Implementation and limits |
|---|---|
| Codex OAuth | Reuses Codex-managed ChatGPT credentials; refresh delegated through local app-server. No bridge token files. |
| Dynamic model discovery | Authenticated Codex endpoint, per-account cache, one-hour TTL, explicit refresh. Catalog listing is not proof of inference entitlement. |
| Main and family routing | Every gateway request is routed; Opus/Sonnet/Haiku/Fable versions map to configured targets. Unknown IDs fail. |
| Agent routing | Agent headers, request metadata and narrow system fingerprints. Undistinguished requests keep main routing. |
| Classifier routing | Metadata and system fingerprints; no user-message scanning. Live Plan → classifier → Explore tested with the installed clients. Native classifier formats may evolve. |
| Compaction/background routing | Explicit metadata and narrow compactor system detection. Claude's cache-sharing compaction can reuse the main system prompt and is not reliably distinguishable on the wire. |
| Reasoning effort | Catalog-validated per role and `--effort` for main. No fabricated thinking. |
| Messages fields | System/messages, tools, tool_choice, streaming, images, metadata for routing and local stop sequences. Cache hints do not become false cache claims. Unsupported semantic fields fail explicitly. |
| `max_tokens` | Codex backend rejects `max_output_tokens`; gateway caps visible output using an approximate tokenizer. Hidden reasoning and upstream token spending are not bounded by it. Tool JSON is never partially emitted. |
| Temperature | Not supported by the account Responses backend. Not forwarded; announced once per launch. No claim of exact sampling parity. |
| Tool round-trips | Client functions and MCP function names; no model tool executes inside the gateway. Eager tool definitions; tool search/deferred loading disabled. |
| Images | Image URLs/base64 and image tool outputs translate; per-model modality validation. No gateway fetch of image URLs. |
| Streaming | Incremental text, complete tool blocks, keepalives, usage accounting, stop reasons, cancellation and explicit errors. |
| Context metadata | Discovered real context is listed and supplied as metadata. `behavesAs` removes unknown-model handling but makes Claude inherit a known client profile. This release preserves compaction and budgets conservatively at min(200K, advertised context). It does not claim exact larger-window integration. |
| Auto classifier failure | Original call is denied. A session failure latch makes later calls ask for manual approval. An unavailable-classifier denial can carry a retry hint; Claude decides whether it will retry. Refusal/parse-error denials are never converted to approvals. Same-call interactive recovery is not certified. |
| Model picker | Generated from catalog, main changes independent of configured role targets. Runtime interactive picker/resume still require release checks. |
| Auth/isolation | Random local token, ephemeral loopback ports, isolated profile/onboarding, attached process lifecycle. |
| No Anthropic inference | Gateway has only the Codex upstream; conflicting launch providers cleared. Proxy denies provider domains. Arbitrary tools or clients that ignore proxy variables are outside this guarantee; use an OS firewall for an absolute network invariant. |
| Diagnostics | Real auth/catalog/local bind checks; limitations always disclosed. Doctor does not claim UI tests ran. |
| Fallback | None implicit; explicit fallback is announced and happens before streaming only. Authentication/network/schema failures never select an arbitrary model. |

## Release matrix still requiring interactive verification

Use a disposable repository. Keep normal permission checks active. Enable `--trace` and confirm role/model metadata; do not enable raw request logging.

- Repeat the passed Plan Mode → Explore agent → classifier path with distinct main/subagent/classifier targets and in an interactive terminal.
- Parallel Explore/Plan agents and their cancellations.
- Interactive classifier outage → current action denied → manual approval on retry, with no approval synthesized by the bridge.
- Read, Write, Edit, Glob, Grep, images and an MCP server.
- `/model`, `/compact`, automatic compaction, context-boundary recovery and session resume.
- Ctrl+C during generation versus exiting the interactive client, plus terminal closure.
- Real rate-limit, account switch and expired-token recovery.
- External network observation showing no provider egress from the tested Claude build. Proxy tests alone do not establish an OS-level invariant.

A successful mock test or a simple live response does not certify those scenarios.
