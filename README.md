# Quill CLI

High-UX command line access to Quill Meetings, backed by the local Quill MCP server.

The CLI is designed for two audiences:

- Humans get interactive browsing, short aliases, readable tables, and no UUID copy/paste for common flows.
- Agents and scripts get compact structured output, `--json`, stable errors, pagination hints, and no prompts.

## Install

Run the CLI without installing it globally:

```bash
npx @quillmeetings/cli init
npx @quillmeetings/cli doctor
```

Or install it globally:

```bash
npm i -g @quillmeetings/cli
quill init
```

For local development from this repo:

```bash
npm link
quill --help
```

Or run without linking:

```bash
node bin/quill.js --help
```

## Prerequisite: Enable Quill MCP Bridge (In Desktop App)

The CLI talks to Quill through a local MCP bridge that ships with the Quill desktop app. Install Quill desktop, sign in, and enable the MCP server in Quill Settings -> MCP / Integrations.

The default bridge path is platform-aware:

```text
macOS:   ~/Library/Application Support/Quill/mcp-stdio-bridge.js
Windows: %APPDATA%\Quill\mcp-stdio-bridge.js
```

The CLI uses built-in defaults and does not need a config file for the happy path. To write the default config and check the bridge path:

```bash
quill init
```

To diagnose setup problems without running a meeting command:

```bash
quill doctor
```

If your bridge is elsewhere, point the CLI at it:

```bash
quill config set mcp.args '["/path/to/mcp-stdio-bridge.js"]'
```

The equivalent MCP client config looks like:

```json
{
  "quill": {
    "command": "node",
    "args": ["<absolute path to mcp-stdio-bridge.js>"]
  }
}
```

## Human Workflow

Start with the interactive picker:

```bash
quill init
quill doctor
quill browse
quill meetings browse --limit 20
quill meetings browse --search "roadmap"
```

Keyboard controls:

```text
From the list
  up/down, j/k    Move selection
  Enter           View selected meeting
  n               Open notes/minutes
  t               Open transcript
  a               Generate action-item note after confirmation
  f               Generate follow-up note after confirmation
  y               Confirm note generation
  /               Search (live filter while typing, Enter fetches from server)
  ?               Toggle help
  q or Esc        Quit (Esc first clears active search/filter)

From a detail panel
  b or Esc        Back to the list
  up/down, j/k    Scroll the panel one line
  PgUp/PgDn       Scroll the panel eight lines
  c               Copy the current panel content to clipboard
  n               Switch to notes
  t               Switch to transcript
  a               Generate action-item note after confirmation
  f               Generate follow-up note after confirmation
  y               Confirm note generation
  Enter           Re-open the meeting view
  ?               Toggle help
  q               Quit
```

Browse uses an Ink-powered fullscreen terminal UI with color, keyboard navigation, viewport-aware lists, scrollable detail panels, clipboard copy, and confirmation screens for generated notes. This is intentionally separate from normal command output, which defaults to human tables and supports compact TOON/JSON for agents.

Commands that need a meeting ID also open the picker in a real terminal:

```bash
quill notes
quill transcript
```

Short aliases:

```bash
quill ls                 # meetings list
quill v <id>             # meetings view
quill <id>               # meetings view
quill n <id>             # notes
quill t <id>             # transcript
```

## Common Commands

```bash
quill doctor
quill meetings list --limit 10
quill meetings list --today
quill meetings view <id>
quill notes <id>
quill summarize <id>
quill note create <id> --prompt "Summarize risks and blockers"
quill note create <id> "Summarize risks and blockers"            # positional prompt
quill note create <id> --template <template-id> --instruction "Focus on next steps"
quill actions <id> --instruction "Group by owner"
quill followup <id> --instruction "Tone: friendly, ready to send"
quill transcript <id>
quill search "roadmap risk" --since "last week"
quill contacts list --search "Jane"
quill threads list --include-meetings
quill events list --limit 10
quill templates list --kind minutes
```

## Agent Mode

Agent mode disables interactive prompts and keeps output machine-oriented. Without `--json` or `--human`, agent mode defaults to compact TOON output.

```bash
quill meetings list --json
quill search "pricing" --json
quill notes <id> --json
quill meetings list --agent                # TOON by default
quill meetings list --agent --human        # force human tables in agent mode
```

Enable it globally:

```bash
quill config set agent.enabled true
```

Global flags:

```bash
--json                  Print structured JSON and enable agent mode
--agent                 Disable interactive prompts and human formatting
--no-agent              Override agent.enabled from config for one command
--human, --table        Force human table output when not using --json
--fields <a,b,c>        Select list fields
--full                  Disable large text truncation
--truncate <chars>      Large text truncation limit
-o, --format <fmt>      Select output format: human, toon, or json
-l, --limit <n>         Default result limit
-h, --help              Show help
-v, --version           Show version
```

Interactive browsing is disabled in agent mode. `quill browse --json` returns a structured error instead of prompting:

```json
{
  "error": {
    "code": "interactive_unavailable",
    "message": "Interactive browsing is disabled in agent mode. Use `quill meetings list --json`."
  }
}
```

## LLM Agent Usage

LLM agents should use `--json` for deterministic output and should avoid interactive commands.

Recommended preflight:

```bash
quill doctor --json
```

Common agent-safe commands:

```bash
quill meetings list --json --limit 10
quill meetings list --json --today
quill search "pricing risk" --json --limit 5
quill meetings view <meeting-id> --json
quill notes <meeting-id> --json
quill transcript <meeting-id> --json --full
quill actions <meeting-id> --json --instruction "Group by owner"
quill followup <meeting-id> --json --instruction "Tone: concise and ready to send"
```

Agent rules:

- Always pass `--json` when another program will parse the result.
- Do not call `quill browse`; it requires a real terminal.
- If setup fails, run `quill doctor --json` and follow the first remediation.
- Use `--fields` to reduce context for list commands.
- Use `--full` only when the complete transcript or note body is needed.
- Use `quill mcp tools --json` and `quill mcp schema <tool> --json` only when curated commands do not cover the task.

See [SKILL.md](SKILL.md) for a compact agent instruction file that can be copied into agent systems such as Hermes, Claude Code, or Codex.

## Shell Automation

Use `--json` with `jq` for scripts:

```bash
quill meetings list --json --limit 5 \
  | jq -r '.result.meetings[] | [.id, .title, .date] | @tsv'
```

Fetch notes for today's meetings:

```bash
quill meetings list --json --today \
  | jq -r '.result.meetings[].id' \
  | while read -r id; do
      quill notes "$id" --json
    done
```

Search meetings and print IDs:

```bash
quill search "customer renewal" --json --limit 10 \
  | jq -r '.result.meetings[].id'
```

Fail fast in CI or cron:

```bash
set -euo pipefail
quill doctor --json >/dev/null
quill meetings list --json --limit 1 >/dev/null
```

For repeatable scripts, prefer command flags over persistent config. Precedence is: command flags > environment variables > config file > built-in defaults.

## Output

Default output is human-readable. Lists render as tables in normal CLI use. Use `--format toon` for compact, YAML-like output that's cheap on LLM context, or `--json` for machine consumers.

Default human output:

```text
Meetings (1)
id                                    title    date        duration
------------------------------------  -------  ----------  --------
36dc4314-b6dc-4950-88ee-1b33556a6578  jtbd II  2 days ago  92min

Run `quill meetings view <id>`
Run `quill transcript <id> --full`
Run `quill search "<query>"`
```

Compact TOON output:

```bash
quill meetings list --limit 1 --format toon
```

```text
tool: search_meetings
result:
  count: 1
  meetings[1]{id,title,date,duration}:
    36dc...,jtbd II,2026-05-13T17:32:28.579Z,92min
  next_offset: 1
help[3]:
  Run `quill meetings view <id>`
  Run `quill transcript <id> --full`
  Run `quill search "<query>"`
```

JSON output:

```bash
quill meetings list --limit 1 --json
```

Ask for more fields only when needed:

```bash
quill meetings list --fields id,title,tags,url
```

Get concise help for a specific command:

```bash
quill meetings --help
quill browse --help
quill transcript --help
```

## Config

Persistent settings live in JSON:

```text
~/.config/quill-cli/config.json
```

Use `QUILL_CONFIG=/path/to/config.json` to point the CLI at a different config file for tests or one-off runs.
Precedence is: command flags > environment variables > config file > built-in defaults.

```bash
quill config path
quill config init
quill config show
quill config get mcp.mutation_timeout_ms
quill config set mcp.mutation_timeout_ms 180000
quill config set mcp.args '["/path/to/mcp-stdio-bridge.js"]'
```

`quill init` is the guided setup command. It creates the config only if it is missing, then runs the same setup checks as `quill doctor`.

The only Quill-specific environment overrides are:

```bash
QUILL_CONFIG=/path/to/config.json
QUILL_AGENT_MODE=1
QUILL_DEBUG=1
```

## Raw MCP Access

The curated commands cover common Quill workflows. Raw MCP remains available for discovery and debugging:

```bash
quill mcp tools
quill mcp schema <tool>
quill mcp call <tool> --input '{"key":"value"}'
```

## Shell Completion

```bash
quill completion zsh
quill completion bash
quill completion fish
```

Completion covers commands and subcommands. Meeting IDs are not currently completed.

## Design Principles

- Prefer curated meeting workflows over raw MCP tool sprawl.
- Avoid UUID copy/paste for humans.
- Keep agent output compact, structured, and prompt-free.
- Default to 3-4 list fields, with `--fields` for extra context.
- Truncate large strings by default, with `--full` as the escape hatch.
- Use `help[]` hints to make next actions discoverable.
- Keep raw MCP available as an escape hatch.

## Development

```bash
npm run check    # node --check on every source file
npm run smoke    # `quill --help` exits cleanly
npm test         # run the unit-test suite
node bin/quill.js mcp tools
```

The test suite uses Node's built-in `node:test` and `node:assert` — no external test framework. Files live in `test/` and cover the highest-leverage code:

- `test/mcp-client.test.js` — the `<ToolResponse>` XML-ish parser (`extractToolResult` / `parseQuillToolResponse`).
- `test/tool-router.test.js` — fuzzy alias matching in `findTool` and key remapping in `buildArgs`.
- `test/format.test.js` — `shapeForOutput`, `toHuman`, `toToon`, `truncateText`, etc.

To run a single file: `node --test test/mcp-client.test.js`.

Useful debug commands:

```bash
QUILL_DEBUG=1 node bin/quill.js mcp tools
node bin/quill.js config set mcp.timeout_ms 30000
node bin/quill.js config set mcp.mutation_timeout_ms 180000
node bin/quill.js config set mcp.max_buffer_bytes 20971520
node bin/quill.js mcp schema search_meetings --json
```

Code layout:

```text
bin/quill.js          CLI entrypoint and top-level error handling
src/cli.js            command parsing, routing, help, and MCP command wiring
src/browser.js        Ink-powered interactive meeting browser
src/config.js         JSON config defaults, path resolution, get/set helpers
src/doctor.js         First-run diagnostics for Quill desktop and MCP setup
src/mcp-client.js     Quill MCP bridge client and ToolResponse parsing
src/format.js         TOON/JSON/human output shaping, truncation, field selection
src/tool-router.js    curated command to MCP tool mapping
```

Implementation notes:

- Quill's bridge currently returns newline-delimited JSON-RPC, not standard `Content-Length` stdio framing.
- Quill tool results often contain XML-like `ToolResponse` text. The CLI parses the known Quill response shapes for compact display and keeps raw MCP access available for debugging.
- MCP stdout buffers are capped by `mcp.max_buffer_bytes` to avoid unbounded memory growth on malformed or very large responses.
