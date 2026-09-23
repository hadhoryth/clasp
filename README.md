<p align="center">
  <img src="assets/logo.png" alt="Clasp logo" width="96" height="96">
</p>
<h1 align="center">Clasp</h1>
<p align="center">Claude Code’s workflow. Your Codex account.</p>
<p align="center"><strong>Experimental · Node.js 22+ · macOS & Linux · MIT</strong></p>

Run Claude Code through a local gateway backed by your Codex ChatGPT login. Discover your account's models, route tasks to the models you choose, and keep Claude's tool and permission workflow.

**0.1.0 is an experimental compatibility implementation, not a complete implementation of every release requirement in the spec.** Normal conversation, streaming, Bash tool round-trips, and Plan → classifier → Explore → Read have been exercised against the installed clients. Exact context-window integration, classifier failure handoff, and the broader interactive release matrix have limits described in [Compatibility](docs/COMPATIBILITY.md).

## Install

Requires **Node.js 22+**, **Codex CLI**, and **Claude Code**. The live implementation was checked with Codex 0.154.0 and Claude Code 2.1.272 on macOS. CI covers the offline suite and packages on macOS and Linux.

### Download a release

When a version has been published, open this repository's **Releases** page and download the named `.tgz` package. Install it from your downloads directory:

```sh
npm install --global ./clasp-0.1.0.tgz
clasp doctor
clasp
```

Or download the named `.zip`, extract it, and run `./clasp-0.1.0/clasp`. Both downloads include compiled code and runtime dependencies. GitHub's automatic **Source code** archives require the source installation steps below. Checksums are provided in `SHA256SUMS.txt`; see [Releasing](docs/RELEASING.md).

### From source

```sh
cd clasp
npm ci
npm run build
node bin/clasp.js doctor
node bin/clasp.js
```

To expose the `clasp` command on your PATH:

```sh
npm link
clasp
```

## Run

No Anthropic login is needed for this launch. The bridge uses the Codex account already signed in on your machine. If necessary:

```sh
clasp auth login
clasp models --refresh
clasp --model MODEL_FROM_THE_LIST --effort high
```

`auth login`, `auth status` and `auth logout` delegate to Codex. **Logout signs out the shared Codex CLI account**, not only this bridge.

Pass Claude options after `--`:

```sh
clasp --trace -- --permission-mode plan
clasp -- --resume
clasp -- --print 'Explain this project'
```

Remote/cloud and detached launches are rejected because their lifetimes cannot be owned by the local gateway. Routing/environment overrides such as Claude's own `--model`, `--settings` and `--fallback-model` must be expressed through bridge configuration. Permission options are passed through; the bridge does not disable permission checks.

## Models and routing

The authenticated Codex model endpoint is queried at startup, with a one-hour, account-scoped cache at `~/.cache/claude-codex/models.json`. The catalog contains **no hard-coded GPT list**. A model explicitly requested by the user must exist in the current catalog or an explicit configured fallback; it is never substituted silently. A listed model can still be rejected by the backend at inference time. Hidden catalog entries are shown by `models`, but omitted from Claude's picker.

Selection order is `--model`, `default_model`, then the first visible available entry in the server's priority order. With no routing configuration, all roles use that launch default. `/model` switches the main request model; agent/classifier/compact roles keep their configured targets or the launch default.

Requests are classified using envelope metadata, agent headers, and narrow system-prompt fingerprints. User messages and tool results are not scanned for routing hints. Unknown request structures can remain `main`; see the compatibility matrix. Every recognized Claude family (`opus`, `sonnet`, `haiku`, `fable`) is resolved through the router regardless of version suffix. Unknown model names fail locally.

## Configuration

Clasp retains the original `claude-codex` storage paths and `CLAUDE_CODEX_CONFIG_DIR` setting so existing configuration and Claude sessions keep working.

Copy [config.example.toml](config.example.toml) to `~/.config/claude-codex/config.toml`, then fill in IDs returned by `clasp models`. The supplied example works without edits and follows the catalog default. Use `--config /path/to/config.toml` for another file.

```toml
# Use actual IDs from your account's catalog, not these placeholders.
default_model = "YOUR_MAIN_MODEL"

[routing]
opus = "YOUR_MAIN_MODEL"
sonnet = "YOUR_MAIN_MODEL"
haiku = "YOUR_FAST_MODEL"
subagent = "YOUR_MAIN_MODEL"
classifier = "YOUR_FAST_MODEL"
compact = "YOUR_FAST_MODEL"
background = "YOUR_FAST_MODEL"

[reasoning]
main = "high"
subagent = "high"
classifier = "low"
compact = "low"

[fallback]
"YOUR_MAIN_MODEL" = ["YOUR_EXPLICIT_BACKUP"]
```

Effort values are checked against each model's catalog. Explicit fallback is announced and is attempted only before response streaming starts; partial generations are never replayed against another model.

## Privacy and isolation

- Codex credentials are obtained and refreshed via `codex app-server`. The bridge does not read, copy, or rewrite `auth.json` or Keychain entries. Tokens remain in memory.
- The gateway binds to `127.0.0.1` on an ephemeral port and requires a random per-launch token, including for model discovery and health checks.
- Prompts, responses, images and credentials are not logged by the bridge. `--trace` prints only role, model and effort metadata. Claude Code still manages its own local transcripts.
- Claude uses `~/.claude-codex/`; ordinary `~/.claude/` is not modified. Session settings and failure markers are removed on exit. `CLAUDE_CODEX_CONFIG_DIR` can select a disposable test profile.
- Project/local settings are excluded to avoid accidental provider overrides. Repository instructions still load through Claude; configure MCP explicitly using Claude's `--mcp-config` when needed.
- Nonessential provider traffic is disabled. A local HTTP(S) proxy rejects Anthropic/Claude domains for clients that honor proxy variables. It is **not an OS-level network sandbox** and is not proof that arbitrary tools can never contact those domains.
- The gateway's upstream is fixed to the Codex backend; caller headers, URLs and credentials cannot choose an upstream. Redirects are rejected.

The built-in functions returned by a model are delivered to Claude Code, which retains responsibility for permissions and execution. The gateway itself executes no model tools.

## Development

```sh
npm ci
npm run format:check
npm test
npm run release:build
npm run release:verify
```

`npm run test:live` is a separate, explicit opt-in check of Plan → classifier → Explore → Read. It creates a disposable directory and uses your Codex account quota.

Default tests use mock upstream responses and local network listeners. They require an environment that permits localhost binding, but no account or paid inference. [Validation](docs/VALIDATION.md) records the separate live checks.

The [Codex plugin manifest](.codex-plugin/plugin.json) and [companion skill](skills/clasp/SKILL.md) let this repository be packaged as a local Codex plugin. The CLI provides the actual gateway. No marketplace entry is installed automatically.

See [Architecture](docs/ARCHITECTURE.md), [Compatibility](docs/COMPATIBILITY.md), and the [original specification](docs/SPEC.md).


## Contributing and releases

See [Contributing](CONTRIBUTING.md), [Changelog](CHANGELOG.md), and [Releasing](docs/RELEASING.md). GitHub Actions checks changes on macOS and Linux. Pushing a matching `v*` tag creates a prerelease with verified downloads after those checks pass.

Released under the [MIT license](LICENSE). An independent project, not affiliated with Anthropic or OpenAI.
