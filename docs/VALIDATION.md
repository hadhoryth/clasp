# Validation record — 2026-09-23

Environment: macOS, Node 23.6.0, Claude Code 2.1.272, Codex CLI 0.154.0.

## Automated checks

- Strict TypeScript build.
- 50 Node tests: parsing, account-scoped catalog/TTL, authentication refresh, fixed upstream/redirect refusal, route selection, explicit fallback, tool/image translation, streaming, stop boundaries, incomplete responses, visible token limits, loopback auth, proxy denial, cancellation, process termination and permission hooks.
- Plugin manifest and companion skill validation.
- Consistent source formatting.
- Release `.tgz` and portable `.zip` built from a clean dependency installation.
- Both archives checked against SHA-256 checksums; tarball installed offline with an empty npm cache.
- Installed command and portable launcher exercised with `--help` and `--version`; plugin assets and manifest checked in both downloads.
- GitHub Actions workflows checked with Actionlint 1.7.12; matching version tags accepted and mismatched tags rejected.

The initial sandbox run could not bind localhost. The complete suite passed with local networking allowed. Mock tests make no paid inference requests.

## Real client/backend checks

- Codex app-server initialization and token retrieval, without printing or persisting credentials.
- Live account model catalog discovery and `doctor` authenticated localhost check.
- Actual backend rejection of `max_output_tokens`, motivating the documented visible-output limit.
- Claude `--print` conversation returned `BRIDGE_OK` using a temporary isolated profile, without an Anthropic login.
- Claude Bash `pwd` tool call and result round-trip returned `TOOL_OK` and the correct directory.
- An explicitly unavailable model request (`gpt-6-sol` in this account snapshot) failed before launching Claude and listed available choices; no fallback occurred.
- Plan Mode → real Auto Mode classifier → Explore agent → Read fixture → parent response returned `AGENT_OK` and `bridge fixture`. Routing traces showed `main`, `classifier`, and `subagent`, all routed to the selected Codex model. No unknown-Claude-model warning remained after using recognized client family IDs.
- Auto Mode's simple shell smoke tests also completed, but did not trigger a classifier request; they are not counted as classifier coverage.

## Scope

The live Plan/Explore test used one Codex model for all roles. Role separation with distinct targets is covered in mock tests, not yet certified against every model combination. Images and MCP translation are covered by protocol tests; live image/MCP sessions remain unverified.

An interactive same-call manual approval after classifier failure, all interactive picker/resume/compaction paths, and an OS-level egress invariant remain open release gates. See COMPATIBILITY.md. No full-spec or production-readiness claim is made.

Run `npm test` for offline checks. `npm run test:live` explicitly consumes Codex account usage and runs the disposable Plan/classifier/Explore fixture again.


## Release automation validation

The logo and release-pipeline changes passed all 50 offline tests on macOS with Node 23.6.0. The workflow is configured for macOS and Ubuntu with Node 22 and 24, but the hosted matrix and actual GitHub publication have not run yet: this local project has no GitHub remote. No new live model calls were made for the packaging changes. Previously recorded live checks above describe the implementation before this repository-polish pass.


## Clasp naming update

Renamed the package, CLI, plugin, companion skill, and release assets to Clasp. Existing configuration/cache/profile locations and the routing integration header are retained. The logo is unchanged; the original specification and generation prompt retain their historical wording. No new live inference was required for this naming change.
