# Contributing

Use Node.js 22 or newer on macOS or Linux.

```sh
npm ci
npm run format:check
npm test
npm run release:check
npm run release:build
npm run release:verify
```

Tests and release verification run without a Claude or Codex account. They use local listeners, mocked upstream responses, and temporary directories. The separate `npm run test:live` command uses your signed-in Codex account and consumes model quota; run it only when you intend to exercise the real clients.

Keep changes focused. Add regression tests for behavior changes, document compatibility limits, and never include credentials, prompts, transcripts, or personal configuration in issues or fixtures. For a bug report, include the operating system, Node/Claude/Codex versions, the command that failed, and sanitized diagnostics.

See [Architecture](docs/ARCHITECTURE.md) for the code layout and [Releasing](docs/RELEASING.md) for the download pipeline.
