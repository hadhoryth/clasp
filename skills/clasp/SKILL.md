---
name: clasp
description: Run, configure, or diagnose the Claude Code to Codex compatibility launcher in this plugin when the user explicitly wants Claude Code to use their Codex account.
---

# Clasp

The CLI lives two directories above this skill at `bin/clasp.js`.

Read `../../README.md` and `../../docs/COMPATIBILITY.md` before changing configuration or claiming feature support. Run `node <plugin-root>/bin/clasp.js doctor` for current authentication, model catalog, and local gateway diagnostics. Use `models --refresh` for exact account model IDs; never invent or silently substitute model IDs.

To launch an interactive Claude session, show the user the CLI command or open a terminal in the intended working directory. Preserve Claude's permission policy. Do not disable permission checks, fabricate classifier approvals, edit Anthropic login state, or print credentials. Login and logout delegate to Codex and affect its shared CLI account.

The bridge is experimental. Distinguish offline tests, live inference, and unverified interactive features. Do not certify the full release gate based on `doctor` alone.
