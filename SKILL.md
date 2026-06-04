# Quill CLI Agent Skill

Use Quill CLI to inspect and automate Quill Meetings through the local Quill desktop MCP bridge.

## Preconditions

- Quill desktop must be installed and signed in.
- The MCP server must be enabled in Quill Settings -> MCP / Integrations.
- Run this first when setup state is unknown:

```bash
quill doctor --json
```

If `quill` is not installed globally, use:

```bash
npx @quillmeetings/cli doctor --json
```

## Agent Rules

- Use `--json` for every command whose output will be parsed.
- Do not use `quill browse`; it is interactive.
- Prefer curated commands before raw MCP calls.
- Use `--fields` and `--limit` to keep output small.
- Use `--full` only when complete notes or transcripts are required.
- If a command returns a setup or bridge error, run `quill doctor --json` and follow the first remediation.
- Do not print or store transcript/notes output outside the user's requested destination.

## Common Commands

List recent meetings:

```bash
quill meetings list --json --limit 10
```

List today's meetings:

```bash
quill meetings list --json --today
```

Search meetings:

```bash
quill search "roadmap risk" --json --limit 5
```

View a meeting:

```bash
quill meetings view <meeting-id> --json
```

Read notes:

```bash
quill notes <meeting-id> --json
```

Read a full transcript:

```bash
quill transcript <meeting-id> --json --full
```

Generate action items:

```bash
quill actions <meeting-id> --json --instruction "Group by owner"
```

Generate a follow-up:

```bash
quill followup <meeting-id> --json --instruction "Tone: concise and ready to send"
```

## Raw MCP Escape Hatch

Use raw MCP only when curated commands do not cover the task:

```bash
quill mcp tools --json
quill mcp schema <tool> --json
quill mcp call <tool> --input '{"key":"value"}' --json
```

## Shell Automation

Extract meeting IDs:

```bash
quill meetings list --json --limit 10 | jq -r '.result.meetings[]?.id'
```

Loop over today's meetings:

```bash
quill meetings list --json --today \
  | jq -r '.result.meetings[]?.id' \
  | while read -r id; do
      quill notes "$id" --json
    done
```

Run a setup preflight in scripts:

```bash
set -euo pipefail
quill doctor --json >/dev/null
```
