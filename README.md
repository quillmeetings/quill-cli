# Quill CLI

High-UX command line access to Quill Meetings, backed by the local Quill MCP server.

The CLI is designed for two audiences:

- Humans get interactive browsing, short aliases, readable tables, and no UUID copy/paste for common flows.
- Agents and scripts get compact structured output, `--json`, stable errors, pagination hints, and no prompts.

## Install

From this repo:

```bash
npm link
quill --help
```

Or run without linking:

```bash
node bin/quill.js --help
```

## Quill MCP Setup

By default, the CLI uses Quill's local MCP bridge:

```json
{
  "quill": {
    "command": "node",
    "args": [
      "/Users/dawa/Library/Application Support/Quill/mcp-stdio-bridge.js"
    ]
  }
}
```

Override the bridge path when needed:

```bash
export QUILL_MCP_BRIDGE="/path/to/mcp-stdio-bridge.js"
```

## Human Workflow

Start with the interactive picker:

```bash
quill browse
quill meetings browse --limit 20
quill meetings browse --search "roadmap"
```

Keyboard controls:

```text
up/down or j/k   Move selection
Enter            View selected meeting inside browse
n                Open notes/minutes inside browse
t                Open transcript inside browse
b                Back to the meeting list from a detail panel
/                Filter the visible list
?                Toggle help
q or Esc          Quit
```

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
quill meetings list --limit 10
quill meetings list --today
quill meetings view <id>
quill notes <id>
quill summarize <id>
quill transcript <id>
quill search "roadmap risk" --since "last week"
quill contacts list --search "Jane"
quill threads list --include-meetings
quill events list --limit 10
quill templates list --kind minutes
```

## Agent Mode

Agent mode disables interactive prompts and keeps output machine-oriented.

```bash
quill meetings list --json
quill search "pricing" --json
quill notes <id> --json
```

Enable it globally:

```bash
export QUILL_AGENT_MODE=1
```

Global flags:

```bash
--json                  Print structured JSON and enable agent mode
--agent                 Disable interactive prompts and human formatting
--human, --table        Force human table output when not using --json
--fields <a,b,c>        Select list fields
--full                  Disable large text truncation
--truncate <chars>      Large text truncation limit
-o, --format toon|json  Select output format
-l, --limit <n>         Default result limit
-h, --help              Show help
-v, --version           Show version
```

Interactive browsing is rejected in agent mode:

```bash
quill browse --json
```

returns a structured error instead of prompting.

## Output

Default compact output:

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

Current completion is static command completion. Dynamic completion for recent meeting IDs should come after a local cache exists.

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
npm run check
npm run smoke
node bin/quill.js mcp tools
```

Useful debug commands:

```bash
QUILL_DEBUG=1 node bin/quill.js mcp tools
QUILL_MCP_TIMEOUT_MS=30000 node bin/quill.js meetings list --limit 5
QUILL_MCP_MAX_BUFFER_BYTES=20971520 node bin/quill.js transcript <id> --full
node bin/quill.js mcp schema search_meetings --json
```

Code layout:

```text
bin/quill.js          CLI entrypoint and top-level error handling
src/cli.js            command parsing, routing, help, and MCP command wiring
src/browser.js        interactive meeting browser
src/mcp-client.js     Quill MCP bridge client and ToolResponse parsing
src/format.js         TOON/JSON/human output shaping, truncation, field selection
src/tool-router.js    curated command to MCP tool mapping
```

Implementation notes:

- Quill's bridge currently returns newline-delimited JSON-RPC, not standard `Content-Length` stdio framing.
- Quill tool results often contain XML-like `ToolResponse` text. The CLI parses the known Quill response shapes for compact display and keeps raw MCP access available for debugging.
- MCP stdout buffers are capped by `QUILL_MCP_MAX_BUFFER_BYTES` to avoid unbounded memory growth on malformed or very large responses.
