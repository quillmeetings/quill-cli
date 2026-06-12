# Contributing to Quill CLI

Thanks for helping improve Quill CLI. This guide covers the local workflow and what we look for in changes.

## Setup

Requirements: Node 20+ and npm.

```bash
git clone https://github.com/quillmeetings/quill-cli.git
cd quill-cli
npm ci
node bin/quill.js --help
```

Most commands need the Quill desktop app and its MCP bridge (macOS or Windows). You can still work on parsing, formatting, and routing without it — that's what the unit tests cover.

## Development workflow

```bash
npm run check   # syntax-check every entry point
npm run lint    # ESLint
npm test        # node --test test/*.test.js
npm run smoke   # quill --help exits cleanly
```

All four must pass before a PR; CI runs them on Node 20 and 22.

## Project layout

- `bin/quill.js` — entrypoint, Node version gate, top-level error handling.
- `src/cli.js` — argument parsing, command routing, curated commands.
- `src/mcp-client.js` — JSON-RPC over stdio to the Quill MCP bridge, result parsing.
- `src/tool-router.js` — maps curated routes to MCP tool names and arg shapes.
- `src/browser.js` — the interactive Ink TUI (`quill browse`).
- `src/format.js` — human tables, TOON, JSON shaping, truncation.
- `src/config.js`, `src/doctor.js` — config file handling and setup diagnostics.

## Guidelines

- **Keep the agent contract stable.** Error envelopes (`{error: {code, message}}`), error `code` strings, exit codes, and `--json` output shapes are relied on by scripts and agents. Changing or removing them is a breaking change; additions are fine.
- **Add tests with behavior changes.** Pure helpers are exported from their modules so they can be unit tested; follow the existing style in `test/`.
- **No new runtime dependencies without discussion.** The CLI deliberately ships with only `ink` and `react`. Dev dependencies are less strict.
- **Comments explain *why*, not *what*.** Match the existing style: comments mark constraints and non-obvious decisions only.
- Update `CHANGELOG.md` under `Unreleased` for user-visible changes.

## Reporting issues

Use the issue templates. For bugs, include `quill doctor --json` output (redact anything sensitive) and your OS, Node version, and CLI version (`quill --version`).

## Releases

Maintainers only — see [RELEASING.md](RELEASING.md).
