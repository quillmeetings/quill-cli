# Quill CLI

Quill CLI is a command-line companion for Quill Meetings that lets developers, operators, and LLM agents search, inspect, and act on meeting context from the terminal. It connects to the local Quill desktop MCP bridge, so meeting data stays routed through the Quill app on your machine instead of a separate hosted service. Use it to list recent meetings, open notes and transcripts, search across meeting history, generate action items or follow-up drafts, and automate common workflows with JSON output.

## Positioning answers

### Who is this for?

Quill CLI is for developers, founders, operators, and AI-agent power users who live in the terminal and want their Quill meeting context available without opening another app. It is especially useful for people using tools like Claude Code, Codex, local agent runners, shell scripts, or internal automation that need structured access to notes, transcripts, action items, and meeting search.

### Why is this exciting?

- It brings meeting memory into the terminal, where technical teams already work.
- It gives LLM agents a JSON-first way to use Quill context without scraping the UI or asking users to copy-paste transcripts.
- It keeps the workflow local-first by connecting through the Quill desktop MCP bridge on the user's machine.
- It turns meetings into automatable building blocks: search, summarize, extract action items, draft follow-ups, and pipe results into scripts.

## Before you start

You need:

- Quill desktop installed and signed in.
- The Quill MCP server enabled in Quill Settings -> MCP / Integrations.
- Node.js 20 or newer.
- macOS or Windows.
- Terminal access to run `npx`, `npm`, or the globally installed `quill` command.

You can run Quill CLI without installing it globally:

```bash
npx @quillmeetings/cli doctor
```

Or install it:

```bash
npm i -g @quillmeetings/cli
quill doctor
```

## How it works

Quill desktop ships a local MCP stdio bridge. Quill CLI finds that bridge at the default platform path, starts it locally, and sends MCP requests to retrieve or create Quill meeting content.

The first command to run is:

```bash
quill doctor
```

`quill doctor` checks whether Quill desktop is installed, whether the bridge file exists, whether the CLI config points at the expected bridge, which Quill app version is present, and whether a short MCP handshake succeeds.

After setup passes, use curated commands for common meeting workflows:

```bash
quill meetings list --limit 10
quill search "customer renewal"
quill notes <meeting-id>
quill transcript <meeting-id> --full
quill actions <meeting-id>
quill followup <meeting-id>
```

For humans, `quill browse` opens an interactive terminal picker. For scripts and LLM agents, every command supports structured output:

```bash
quill meetings list --json --limit 10
quill search "roadmap risk" --json
```

## What you can do with it

- Find recent meetings without opening the Quill app.
- Search meeting history from the terminal.
- Pull notes or full transcripts into local workflows.
- Generate action-item notes grouped by owner.
- Draft meeting follow-ups with custom instructions.
- Build shell scripts that process meeting IDs, notes, or transcripts with `jq`.
- Give LLM agents a non-interactive, JSON-first way to use Quill meeting context.
- Inspect raw MCP tools when a workflow is not covered by the curated commands.

Example automation:

```bash
quill meetings list --json --today \
  | jq -r '.result.meetings[]?.id' \
  | while read -r id; do
      quill notes "$id" --json
    done
```

## Workflow examples

### Turn a customer call into follow-up work

After a customer call, a founder or customer success lead can find the meeting, review the notes, and generate a follow-up draft without leaving the terminal:

```bash
quill search "Acme renewal" --json --limit 3
quill notes <meeting-id>
quill actions <meeting-id> --instruction "Group by owner and include uncertainty"
quill followup <meeting-id> --instruction "Tone: concise, warm, and ready to send"
```

This turns the meeting into an actionable checklist and a draft email while the context is still fresh.

### Give an LLM agent meeting context for a task

When an engineer asks an agent to work on a feature, the agent can pull the relevant meeting context directly instead of asking for copied notes:

```bash
quill search "pricing dashboard" --json --limit 5
quill transcript <meeting-id> --json --full
quill notes <meeting-id> --json
```

The agent gets structured meeting context it can cite and summarize, while Quill still routes access through the local desktop bridge.

## Troubleshooting

### `quill: command not found`

Run with `npx`:

```bash
npx @quillmeetings/cli --help
```

Or install globally:

```bash
npm i -g @quillmeetings/cli
```

### Bridge not found

Run:

```bash
quill doctor
```

Make sure Quill desktop is installed, launched at least once, and updated. If your bridge lives somewhere custom, set it explicitly:

```bash
quill config set mcp.args '["/path/to/mcp-stdio-bridge.js"]'
```

### MCP handshake times out

Open Quill desktop and enable the MCP server in Settings -> MCP / Integrations, then run:

```bash
quill doctor
```

### Interactive commands fail in scripts

Use JSON mode instead of the interactive browser:

```bash
quill meetings list --json --limit 10
```

Do not use `quill browse` from CI, cron, or an LLM agent.

### Node version error

Quill CLI requires Node.js 20 or newer. Check your version:

```bash
node --version
```
