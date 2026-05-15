import { existsSync } from "node:fs";
import { runMeetingBrowser } from "./browser.js";
import { defaultConfig, configPath } from "./config.js";
import { extractToolResult, McpClient } from "./mcp-client.js";
import { printData, structuredError, truncateText, withHelp } from "./format.js";
import { buildArgs, findTool } from "./tool-router.js";

export async function runCli(argv) {
  const options = parseGlobalOptions(argv);
  const args = normalizeCommandArgs(options.args);
  const command = args[0];

  if (options.help || command === "help") {
    printHelp(command === "help" ? args[1] : args[0]);
    return;
  }

  if (options.version) {
    printData({ version: "0.1.0" }, options);
    return;
  }

  if (command === "completion") {
    printCompletion(args[1] || "zsh");
    return;
  }

  if (!command) {
    await runHome(options);
    return;
  }

  if (command === "config") {
    printData({ config_path: configPath(), config: defaultConfig() }, options);
    return;
  }

  validateBeforeMcp(args, options);

  const client = new McpClient(defaultConfig().mcp);
  await client.connect();
  try {
    if (command === "mcp") {
      await runMcp(client, args.slice(1), options);
      return;
    }

    await runCurated(client, args, options);
  } finally {
    await client.close();
  }
}

async function runHome(options) {
  const bridge = defaultConfig().mcp.args[0];
  printData(withHelp({
    bin: "quill",
    description: "Browse and search Quill Meetings through the local Quill MCP server",
    mcp_bridge: bridge,
    mcp_bridge_found: existsSync(bridge),
  }, [
    "Run `quill mcp tools` to inspect available Quill MCP tools",
    "Run `quill meetings list --limit 10` to list recent meetings",
    "Run `quill search \"<query>\"` to search meeting content",
  ]), options);
}

async function runMcp(client, args, options) {
  const command = args[0];
  if (command === "tools" || !command) {
    const tools = await client.listTools();
    printData(withHelp({
      count: tools.length,
      tools: tools.map((tool) => ({
        name: tool.name,
        description: truncateText(tool.description || "", 180),
      })),
    }, [
      "Run `quill mcp schema <tool>` to inspect an input schema",
      "Run `quill mcp call <tool> --input '{...}'` to call a raw MCP tool",
    ]), options);
    return;
  }

  if (command === "schema") {
    const name = args[1];
    if (!name) throw cliError("missing_tool", "Usage: quill mcp schema <tool>");
    const tools = await client.listTools();
    const tool = tools.find((candidate) => candidate.name === name);
    if (!tool) throw cliError("tool_not_found", `No MCP tool named ${name}`);
    printData(tool, options);
    return;
  }

  if (command === "call") {
    const name = args[1];
    if (!name) throw cliError("missing_tool", "Usage: quill mcp call <tool> --input '{...}'");
    const input = readOption(args.slice(2), "--input") || "{}";
    const parsed = JSON.parse(input);
    printData(extractToolResult(await client.callTool(name, parsed)), options);
    return;
  }

  throw cliError("unknown_command", `Unknown mcp command: ${command}`);
}

async function runCurated(client, args, options) {
  const [domain, actionOrValue, maybeValue] = args;
  const parsed = parseFlags(args.slice(1));
  const flags = parsed.flags;
  const tools = await client.listTools();

  if (domain === "browse" || ((domain === "meetings" || domain === "meeting") && actionOrValue === "browse")) {
    await browseMeetings(client, tools, options, {
      limit: flags.limit || options.limit,
      since: flags.since,
      until: flags.until,
      today: flags.today,
      yesterday: flags.yesterday,
      query: flags.search,
    });
    return;
  }

  if (domain === "meetings" || domain === "meeting") {
    if (!actionOrValue || actionOrValue === "list") {
      await callRoute(client, tools, "listMeetings", {
        limit: flags.limit || options.limit,
        since: flags.since,
        until: flags.until,
        today: flags.today,
        yesterday: flags.yesterday,
        query: flags.search,
      }, options, [
        "Run `quill meetings view <id>`",
        "Run `quill transcript <id> --full`",
        "Run `quill search \"<query>\"`",
      ]);
      return;
    }

    if (actionOrValue === "view") {
      const id = await resolveMeetingId(client, tools, maybeValue, options);
      await callRoute(client, tools, "getMeeting", { id }, options, [
        "Run `quill notes <id>`",
        "Run `quill transcript <id>`",
      ]);
      return;
    }
  }

  if (domain === "transcript") {
    const id = await resolveMeetingId(client, tools, actionOrValue, options);
    await callRoute(client, tools, "getTranscript", { id }, options, [
      "Run `quill notes <id>`",
      "Run `quill export <id> --format json`",
    ]);
    return;
  }

  if (domain === "notes" || domain === "summary" || domain === "summarize") {
    const id = await resolveMeetingId(client, tools, actionOrValue, options);
    await callRoute(client, tools, "getNotes", { id }, options, [
      "Run `quill transcript <id> --full`",
      "Run `quill search \"<query>\"`",
    ]);
    return;
  }

  if (domain === "search") {
    await callRoute(client, tools, "search", {
      query: parsed.positionals.join(" "),
      limit: flags.limit || options.limit,
      since: flags.since,
      until: flags.until,
      today: flags.today,
      yesterday: flags.yesterday,
    }, options, [
      "Run `quill meetings view <id>`",
      "Run `quill transcript <id> --full`",
    ]);
    return;
  }

  if (domain === "contacts") {
    if (!actionOrValue || actionOrValue === "list" || actionOrValue === "search") {
      await callRoute(client, tools, "listContacts", {
        query: actionOrValue === "search" ? parseFlags(args.slice(2)).positionals.join(" ") : flags.search,
        limit: flags.limit || options.limit,
        offset: flags.offset,
      }, options, [
        "Run `quill contacts get <id>`",
        "Run `quill search \"<person or topic>\"`",
      ]);
      return;
    }
    if (actionOrValue === "get") {
      await callRoute(client, tools, "getContact", { id: maybeValue }, options, [
        "Run `quill contacts search \"<name>\"`",
      ]);
      return;
    }
  }

  if (domain === "threads") {
    if (!actionOrValue || actionOrValue === "list") {
      await callRoute(client, tools, "listThreads", {
        includeMeetings: Boolean(flags.includeMeetings),
        meetingsLimit: flags.meetingsLimit,
      }, options, [
        "Run `quill threads get <id>`",
        "Run `quill meetings list --search \"<topic>\"`",
      ]);
      return;
    }
    if (actionOrValue === "get") {
      await callRoute(client, tools, "getThread", { id: maybeValue }, options, [
        "Run `quill threads list --include-meetings`",
      ]);
      return;
    }
  }

  if (domain === "events") {
    if (!actionOrValue || actionOrValue === "list") {
      await callRoute(client, tools, "listEvents", {
        limit: flags.limit || options.limit,
        offset: flags.offset,
        since: flags.after || flags.since,
        until: flags.before || flags.until,
      }, options, [
        "Run `quill events get <id>`",
        "Run `quill meetings list --since 7d`",
      ]);
      return;
    }
    if (actionOrValue === "get") {
      await callRoute(client, tools, "getEvent", { id: maybeValue }, options, [
        "Run `quill events list`",
      ]);
      return;
    }
  }

  if (domain === "templates") {
    if (!actionOrValue || actionOrValue === "list") {
      await callRoute(client, tools, "listTemplates", {
        limit: flags.limit || options.limit,
        offset: flags.offset,
        kind: flags.kind,
        includeDisabled: Boolean(flags.includeDisabled),
      }, options, [
        "Run `quill templates get <id>`",
        "Run `quill mcp tools` for template mutation tools",
      ]);
      return;
    }
    if (actionOrValue === "get") {
      await callRoute(client, tools, "getTemplate", { id: maybeValue }, options, [
        "Run `quill templates list`",
      ]);
      return;
    }
  }

  throw cliError("unknown_command", `Unknown command: ${domain}. Run quill --help.`);
}

async function callRoute(client, tools, route, values, options, help) {
  const tool = findTool(tools, route);
  if (!tool) {
    printData(structuredError("tool_route_unavailable", `Could not find a Quill MCP tool for ${route}`, {
      available_tools: tools.map((candidate) => candidate.name),
      next: "Run `quill mcp tools` and `quill mcp schema <tool>` to inspect the server.",
    }), options);
    process.exitCode = 1;
    return;
  }

  const args = tool.name === "search_meetings" ? buildSearchMeetingsArgs(values) : buildArgs(tool, normalizeValues(values));
  const result = extractToolResult(await client.callTool(tool.name, args));
  addPagination(result, values);
  printData(withHelp({ tool: tool.name, result }, help), options);
}

function addPagination(result, values) {
  if (!result || typeof result !== "object") return;
  const limit = Number.parseInt(values.limit, 10);
  if (!Number.isInteger(limit) || limit <= 0) return;
  const offset = Number.parseInt(values.offset || result.offset || 0, 10);
  const collection = ["meetings", "events", "contacts", "templates", "threads", "notes"]
    .map((key) => result[key])
    .find(Array.isArray);
  if (collection && collection.length >= limit) result.next_offset = offset + limit;
}

function normalizeValues(values) {
  const normalized = applyTimeFlags({ ...values });
  if (normalized.since) normalized.since = parseDateCutoff(normalized.since);
  if (normalized.until) normalized.until = parseDateCutoff(normalized.until);
  return normalized;
}

function buildSearchMeetingsArgs(values) {
  values = applyTimeFlags(values);
  const args = {};
  if (values.query) args.query = values.query;
  if (values.limit) args.limit = Math.min(Number.parseInt(values.limit, 10) || 10, 30);

  const filter = {};
  if (values.since) filter.after = parseDateCutoff(values.since);
  if (values.until) filter.before = parseDateCutoff(values.until);
  if (Object.keys(filter).length > 0) args.filter = filter;

  if (values.query) {
    args.ranking = {
      freshness: values.since ? "strong" : "default",
      scope: "default",
    };
  }

  return args;
}

async function resolveMeetingId(client, tools, id, options) {
  if (id) return id;
  if (options.agent || !process.stdin.isTTY || !process.stdout.isTTY) {
    throw cliError("missing_meeting_id", "Missing meeting id. Usage: quill meetings view <id>, quill notes <id>, or quill transcript <id>.");
  }

  const selection = await pickRecentMeeting(client, tools, options, { limit: 10 });
  if (!selection) throw cliError("no_selection", "No meeting selected.");
  return selection.meeting.id;
}

async function pickRecentMeeting(client, tools, options, values) {
  const selection = await browseMeetings(client, tools, options, values, { selectOnly: true });
  return selection;
}

async function browseMeetings(client, tools, options, values, pickerOptions = {}) {
  if (options.agent || !process.stdin.isTTY || !process.stdout.isTTY) {
    throw cliError("interactive_unavailable", "Interactive browsing requires a terminal. Use `quill meetings list --json` in agent mode.");
  }

  const tool = findTool(tools, "listMeetings");
  if (!tool) throw cliError("tool_route_unavailable", "Cannot list recent meetings to choose an id.");
  const result = extractToolResult(await client.callTool(tool.name, buildSearchMeetingsArgs(values)));
  const meetings = result.meetings || [];
  if (meetings.length === 0) throw cliError("no_meetings", "No recent meetings found.");

  return runMeetingBrowser(client, tools, meetings, options, pickerOptions);
}

function applyTimeFlags(values) {
  const normalized = { ...values };
  if (normalized.today) {
    normalized.since = startOfDay(0);
    normalized.until = startOfDay(1);
  } else if (normalized.yesterday) {
    normalized.since = startOfDay(-1);
    normalized.until = startOfDay(0);
  }
  return normalized;
}

function parseDateCutoff(value) {
  const phrase = String(value).trim().toLowerCase();
  if (phrase === "today") return startOfDay(0);
  if (phrase === "yesterday") return startOfDay(-1);
  if (phrase === "last week") return new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  if (phrase === "last month") return new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  if (/^\d{4}-\d{2}-\d{2}T/.test(value)) return value;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return `${value}T00:00:00Z`;

  const match = String(value).match(/^(\d+)([dwmy])$/);
  if (!match) return value;

  const amount = Number.parseInt(match[1], 10);
  const unit = match[2];
  const days = unit === "d" ? amount : unit === "w" ? amount * 7 : unit === "m" ? amount * 30 : amount * 365;
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

function startOfDay(offsetDays) {
  const date = new Date();
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCDate(date.getUTCDate() + offsetDays);
  return date.toISOString();
}

function parseGlobalOptions(argv) {
  const args = [];
  const options = {
    format: "toon",
    limit: defaultConfig().output.limit,
    help: false,
    version: false,
    agent: process.env.QUILL_AGENT_MODE === "1",
  };

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--version" || arg === "-v") options.version = true;
    else if (arg === "--json") {
      options.format = "json";
      options.agent = true;
    }
    else if (arg === "--agent") options.agent = true;
    else if (arg === "--human" || arg === "--table") options.forceHuman = true;
    else if (arg === "--full") options.full = true;
    else if (arg === "--fields") options.fields = splitCsv(argv[++index] || "");
    else if (arg === "--truncate") options.truncate = Number.parseInt(argv[++index] || "1200", 10);
    else if (arg === "--format" || arg === "-o") {
      options.format = argv[++index] || "toon";
      if (options.format === "json") options.agent = true;
    }
    else if (arg === "--limit" || arg === "-l") options.limit = Number.parseInt(argv[++index] || "20", 10);
    else args.push(arg);
  }

  options.args = args;
  options.human = !options.agent && options.format !== "json" && (process.stdout.isTTY || options.forceHuman);
  return options;
}

function parseFlags(args) {
  const flags = {};
  const positionals = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }
    const key = arg.slice(2).replace(/-([a-z])/g, (_, char) => char.toUpperCase());
    if (!args[index + 1] || args[index + 1].startsWith("--")) {
      flags[key] = true;
    } else {
      const value = args[++index];
      const phrase = `${value} ${args[index + 1] || ""}`.trim().toLowerCase();
      if (["last week", "last month"].includes(phrase)) {
        flags[key] = phrase;
        index++;
      } else {
        flags[key] = value;
      }
    }
  }
  return { flags, positionals };
}

function readOption(args, name) {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

function printHelp(topic) {
  if (topic && topic !== "help") {
    const text = subcommandHelp(topic);
    if (text) {
      process.stdout.write(text);
      return;
    }
  }

  process.stdout.write(`Quill CLI - agent-friendly Quill Meetings from the terminal

Usage:
  quill
  quill meetings list [--limit 20] [--since 7d] [--search text]
  quill browse [--limit 20] [--search text]
  quill meetings browse [--limit 20] [--search text]
  quill meetings view <id>
  quill ls
  quill v <id>
  quill <id>
  quill notes <id>
  quill summarize <id>
  quill transcript <id> [--full]
  quill search "<query>" [--limit 20] [--since "last week"] [--today]
  quill contacts list [--search text]
  quill threads list [--include-meetings]
  quill events list [--limit 20]
  quill templates list [--kind minutes]
  quill mcp tools
  quill mcp schema <tool>
  quill mcp call <tool> --input '{"key":"value"}'
  quill completion zsh|bash|fish

Global options:
  --json                  Print JSON instead of TOON-style output
  --agent                 Disable interactive prompts and human formatting
  --human, --table        Force human table output when not using --json
  --fields <a,b,c>        Select list fields
  --full                  Disable large text truncation
  --truncate <chars>      Large text truncation limit
  -o, --format <format>   Output format: toon or json
  -l, --limit <n>         Default result limit
  -h, --help              Show help
  -v, --version           Show version

Environment:
  QUILL_MCP_BRIDGE        Path to Quill mcp-stdio-bridge.js
  QUILL_MCP_COMMAND       MCP command, defaults to node
  QUILL_MCP_ARGS          MCP args, overrides bridge path
  QUILL_AGENT_MODE=1      Agent mode by default
  QUILL_MCP_MAX_BUFFER_BYTES
                          Maximum MCP response buffer, default 10485760
  QUILL_DEBUG=1           Forward MCP stderr
`);
}

function subcommandHelp(topic) {
  const help = {
    meetings: `Usage:
  quill meetings list [--limit 20] [--since 7d] [--today] [--fields id,title,date,duration]
  quill meetings browse [--limit 20] [--search text]
  quill meetings view <id>

Hints:
  Use \`quill browse\` to avoid copying meeting UUIDs.
  Use \`--json\` for agent/script output.
`,
    browse: `Usage:
  quill browse [--limit 20] [--search text] [--since 7d]

Keys:
  Enter=view, n=notes, t=transcript, b=back, /=filter, ?=help, q=quit

Agent mode:
  Browse is interactive and disabled with \`--json\`, \`--agent\`, or QUILL_AGENT_MODE=1.
`,
    notes: `Usage:
  quill notes <id> [--full]
  quill notes

Notes:
  Without an id in a TTY, opens the meeting picker.
`,
    transcript: `Usage:
  quill transcript <id> [--full]
  quill transcript

Notes:
  Transcripts can be long. Default output is truncated; use \`--full\` when needed.
`,
    search: `Usage:
  quill search "<query>" [--limit 20] [--since 7d] [--today] [--fields id,title,date,duration]
`,
    mcp: `Usage:
  quill mcp tools
  quill mcp schema <tool>
  quill mcp call <tool> --input '{"key":"value"}'
`,
  };
  return help[topic];
}

function normalizeCommandArgs(args) {
  if (args[0] === "ls") return ["meetings", "list", ...args.slice(1)];
  if (args[0] === "v" || args[0] === "view") return ["meetings", "view", ...args.slice(1)];
  if (args[0] === "n") return ["notes", ...args.slice(1)];
  if (args[0] === "t") return ["transcript", ...args.slice(1)];
  if (args[0] && looksLikeId(args[0])) return ["meetings", "view", args[0], ...args.slice(1)];
  return args;
}

function validateBeforeMcp(args, options) {
  if (!options.agent) return;
  const [domain, actionOrValue, maybeValue] = args;
  if (domain === "browse" || ((domain === "meetings" || domain === "meeting") && actionOrValue === "browse")) {
    throw cliError("interactive_unavailable", "Interactive browsing is disabled in agent mode. Use `quill meetings list --json`.");
  }
  if (domain === "notes" || domain === "summary" || domain === "summarize" || domain === "transcript") {
    if (!actionOrValue) throw cliError("missing_meeting_id", `Missing meeting id. Usage: quill ${domain} <id>.`);
  }
  if ((domain === "meetings" || domain === "meeting") && actionOrValue === "view" && !maybeValue) {
    throw cliError("missing_meeting_id", "Missing meeting id. Usage: quill meetings view <id>.");
  }
}

function looksLikeId(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

function printCompletion(shell) {
  const commands = "browse meetings meeting ls v view notes n transcript t search contacts threads events templates mcp config completion help";
  if (shell === "bash") {
    process.stdout.write(`_quill_complete(){ COMPREPLY=( $(compgen -W "${commands}" -- "\${COMP_WORDS[COMP_CWORD]}") ); }\ncomplete -F _quill_complete quill\n`);
    return;
  }
  if (shell === "fish") {
    process.stdout.write(commands.split(" ").map((command) => `complete -c quill -f -a ${command}`).join("\n") + "\n");
    return;
  }
  process.stdout.write(`#compdef quill\n_arguments '1:command:(${commands})'\n`);
}

function cliError(code, message) {
  const error = new Error(message);
  error.code = code;
  error.exitCode = 1;
  return error;
}

function splitCsv(value) {
  return value.split(",").map((field) => field.trim()).filter(Boolean);
}
