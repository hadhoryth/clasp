<p align="center">
  <img src="assets/logo.png" alt="Clasp logo" width="96" height="96">
</p>
<h1 align="center">Clasp</h1>
<p align="center">Claude Code’s workflow. Your Codex account.</p>

Clasp lets you use Claude Code with the models available through your Codex account. It runs locally and keeps Claude’s tools and permission checks.

**Experimental.** Some Claude features have limitations. See [compatibility](docs/COMPATIBILITY.md).

## Get started

You’ll need **Node.js 22+**, **Claude Code**, and **Codex CLI** on macOS or Linux.

Download `clasp-0.1.0.tgz` from [Releases](https://github.com/hadhoryth/clasp/releases), then install it:

```sh
npm install --global ./clasp-0.1.0.tgz
```

Clasp uses your existing Codex login. If you haven’t signed in, run `clasp auth login`.

From your project folder:

```sh
clasp doctor
clasp
```

Prefer a ZIP or building from source? See the [installation guide](docs/USAGE.md#install).

## Choose a model

```sh
clasp models
clasp --model MODEL_ID
```

Replace `MODEL_ID` with a model from the list. Without a selection, Clasp uses your configured default or the first available model.

## Learn more

- [Usage and configuration](docs/USAGE.md)
- [Compatibility and known limitations](docs/COMPATIBILITY.md)
- [Contributing](CONTRIBUTING.md) · [Changelog](CHANGELOG.md) · [Releasing](docs/RELEASING.md)

[MIT license](LICENSE). Independent project, not affiliated with Anthropic or OpenAI.
