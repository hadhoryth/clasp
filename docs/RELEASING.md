# Releasing

GitHub Actions checks pull requests and branch pushes on macOS and Ubuntu using Node.js 22 and 24. Each job checks formatting and metadata, runs the offline tests, builds the downloads, installs the package offline with an empty npm cache, and tests the extracted ZIP. No account credentials or live model requests are needed.

Pushing a version tag starts the same checks, then builds and publishes an **experimental GitHub prerelease**. Both downloads include compiled JavaScript, production dependencies, the logo, documentation, and Codex plugin files. Users still need Node.js 22+, Codex CLI, and Claude Code. These are JavaScript packages, not standalone native executables. Windows is not covered by this release pipeline.

## Connect the repository once

Create a GitHub repository and push this project to it, including `.github/workflows`. Enable Actions if the repository or organization has disabled them. No npm publishing token or account secrets are required; the release job uses GitHub's repository-scoped token with `contents: write` permission. Organization policies can still restrict that token or the use of Actions.

Action dependencies are pinned to commit SHAs; Dependabot proposes updates. The publishing job does not use the dependency cache. The release remains experimental until its compatibility requirements have been met and the workflow is deliberately changed.

## Publish a version

1. Update `package.json`, the root and package entries in `package-lock.json`, and `.codex-plugin/plugin.json` to the same version. `npm version 0.1.1 --no-git-tag-version` can update the npm files; update the plugin manifest separately.
2. Update `CHANGELOG.md` and compatibility/validation notes. For version 0.1.0, the metadata is already aligned.
3. Run the checks below, commit the changes, and push your branch.
4. Create and push the matching tag. For the initial version:

   ```sh
   git tag -a v0.1.0 -m "Clasp 0.1.0"
   git push origin v0.1.0
   ```

5. Follow the **Release** workflow in GitHub's **Actions** tab. When it passes, the **Releases** page contains:

   - `clasp-0.1.0.tgz` — install with `npm install --global ./clasp-0.1.0.tgz`.
   - `clasp-0.1.0.zip` — extract and run `./clasp-0.1.0/clasp`.
   - `SHA256SUMS.txt` — checksums for both archives.

GitHub also adds source archives automatically. Those source archives require a build; the named `.tgz` and `.zip` downloads are ready to run. Nothing is published to the npm registry by this workflow.

## Check downloads locally

```sh
npm ci
npm run format:check
npm test
npm run release:check
npm run release:build
npm run release:verify
```

Artifacts appear in the ignored `release/` directory. Packaging requires `tar`, `zip`, and `unzip`, available on the hosted runners and standard macOS installations. `RELEASE_TAG=v0.1.0 npm run release:check` also checks tag/version agreement.

Publication starts as a draft, uploads the verified assets, then makes the prerelease visible. If an upload fails, rerun the failed workflow to finish the draft. Published assets are never replaced by rerunning the workflow; release a new version for changes. Do not move or reuse a published tag.

See the [GitHub CLI release documentation](https://cli.github.com/manual/gh_release_create) for the publishing command.
