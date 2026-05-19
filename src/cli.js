import { existsSync } from "node:fs";
import { runMeetingBrowser } from "./browser.js";
import { configPath, defaultBridgePath, ensureConfigFile, getConfigValue, loadConfig, readUserConfig, setConfigValue, supportedPlatform, writeUserConfig } from "./config.js";
import { CLI_VERSION, runDoctorChecks } from "./doctor.js";
import { extractToolResult, McpClient } from "./mcp-client.js";
import { printData, structuredError, truncateText, withHelp } from "./format.js";
import { buildArgs, findTool } from "./tool-router.js";

const ACTIONS_PROMPT = "Extract action items from this meeting. Return only concrete tasks. For each item include owner if mentioned, due date if mentioned, status or uncertainty, and brief source context. If there are no clear action items, say so explicitly.";
const FOLLOWUP_PROMPT = "Draft a concise follow-up note for this meeting. Include a short recap, decisions, open questions, action items, and a friendly next-step section. Keep it practical and ready to send.";

export async function runCli(argv) {
  const config = loadConfig();
  const options = parseGlobalOptions(argv, config);
  const args = normalizeCommandArgs(options.args);
  const command = args[0];

  if (options.help || command === "help") {
    printHelp(command === "help" ? args[1] : args[0]);
    return;
  }

  if (options.version) {
    printData({ version: CLI_VERSION }, options);
    return;
  }

  if (command === "completion") {
    printCompletion(args[1] || "zsh");
    return;
  }

  if (command === "init") {
    await runInit(options, config);
    return;
  }

  if (command === "doctor") {
    await runDoctor(options, config);
    return;
  }

  if (!command) {
    await runHome(options, config);
    return;
  }

  if (command === "config") {
    await runConfig(args.slice(1), options, config);
    return;
  }

  validateBeforeMcp(args, options);

  const client = new McpClient(config.mcp);
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

async function runHome(options, config) {
  const bridge = config.mcp.args[0];
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

async function runConfig(args, options, config) {
  const command = args[0] || "show";
  if (command === "path") {
    printData({ config_path: configPath() }, options);
    return;
  }
  if (command === "init") {
    const result = ensureConfigFile();
    printData({
      config_path: result.path,
      created: result.created,
    }, options);
    return;
  }
  if (command === "show") {
    printData({
      config_path: configPath(),
      config,
    }, options);
    return;
  }
  if (command === "get") {
    const key = args[1];
    if (!key) throw cliError("missing_config_key", "Usage: quill config get <key>");
    printData({
      key,
      value: getConfigValue(config, key),
    }, options);
    return;
  }
  if (command === "set") {
    const key = args[1];
    const value = args.slice(2).join(" ");
    if (!key || value === "") throw cliError("missing_config_set_args", "Usage: quill config set <key> <value>");
    const userConfig = readUserConfig();
    setConfigValue(userConfig, key, value);
    writeUserConfig(userConfig);
    printData({
      config_path: configPath(),
      key,
      value: getConfigValue(loadConfig(), key),
    }, options);
    return;
  }
  throw cliError("unknown_config_command", `Unknown config command: ${command}`);
}

async function runInit(options, config) {
  const result = ensureConfigFile();
  const doctor = await runDoctorChecks(loadConfig());
  const setup = withHelp({
    config_path: result.path,
    config_created: result.created,
    platform: doctor.platform,
    mcp_bridge: doctor.configured_bridge || defaultBridgePath(),
    mcp_bridge_found: existsSync(doctor.configured_bridge || defaultBridgePath()),
    doctor: doctor.all_good ? "pass" : `${doctor.issue_count} issue${doctor.issue_count === 1 ? "" : "s"}`,
    next: doctor.all_good
      ? "Run `quill mcp tools` to verify MCP, then `quill browse`."
      : `Run \`quill doctor\`. Start with: ${doctor.start_with}`,
  }, [
    "Run `quill doctor` to diagnose Quill desktop and MCP setup",
    "Run `quill browse` to open the meeting picker",
  ]);

  printData(setup, options);
  if (!doctor.all_good) {
    process.exitCode = 1;
  }
}

async function runDoctor(options, config) {
  const doctor = await runDoctorChecks(config);
  printData({ result: doctor }, options);
  if (!doctor.all_good) process.exitCode = 1;
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
      limit: flags.limit || browseDefaultLimit(options),
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

  if (domain === "note") {
    if (actionOrValue === "create") {
      const id = await resolveMeetingId(client, tools, maybeValue, options);
      await createGeneratedNote(client, tools, {
        meetingId: id,
        prompt: flags.prompt || parseFlags(args.slice(3)).positionals.join(" "),
        instruction: flags.instruction,
        templateId: flags.template,
        includePrivateNotes: parseOptionalBoolean(flags.includePrivateNotes),
        data: flags.data,
      }, options);
      return;
    }
  }

  if (domain === "actions" || domain === "action-items") {
    const id = await resolveMeetingId(client, tools, actionOrValue, options);
    await createGeneratedNote(client, tools, {
      meetingId: id,
      prompt: ACTIONS_PROMPT,
      instruction: flags.instruction,
    }, options);
    return;
  }

  if (domain === "followup" || domain === "follow-up") {
    const id = await resolveMeetingId(client, tools, actionOrValue, options);
    await createGeneratedNote(client, tools, {
      meetingId: id,
      prompt: FOLLOWUP_PROMPT,
      instruction: flags.instruction,
    }, options);
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

async function createGeneratedNote(client, tools, values, options) {
  if (!values.prompt && !values.templateId) {
    throw cliError("missing_prompt", "Provide --prompt, a prompt argument, or --template.");
  }
  const tool = findTool(tools, "createNote");
  if (!tool) throw cliError("tool_route_unavailable", "Could not find Quill MCP create_note tool.");
  const result = extractToolResult(await client.callTool(tool.name, buildArgs(tool, values)));
  printData(withHelp({
    tool: tool.name,
    result,
  }, [
    "Run `quill notes <id>` to read notes for this meeting",
    "Run `quill browse` to continue from the meeting picker",
  ]), options);
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

  const searchMeetings = async (query) => {
    const result = extractToolResult(await client.callTool(tool.name, buildSearchMeetingsArgs({
      ...values,
      query,
    })));
    return result.meetings || [];
  };

  const meetings = await searchMeetings(values.query);
  if (meetings.length === 0) throw cliError("no_meetings", "No recent meetings found.");

  return runMeetingBrowser(client, tools, meetings, options, pickerOptions, { searchMeetings });
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

function parseGlobalOptions(argv, config) {
  const args = [];
  const options = {
    format: config.output.format || "human",
    limit: config.output.limit || 20,
    truncate: config.output.truncate || 1200,
    browseLimit: config.browse?.limit || config.output.limit || 20,
    browsePanelTruncate: config.browse?.panel_truncate || 5000,
    limitExplicit: false,
    help: false,
    version: false,
    agent: Boolean(config.agent?.enabled) || process.env.QUILL_AGENT_MODE === "1",
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
    else if (arg === "--no-agent") options.agent = false;
    else if (arg === "--human" || arg === "--table") options.forceHuman = true;
    else if (arg === "--full") options.full = true;
    else if (arg === "--fields") options.fields = splitCsv(argv[++index] || "");
    else if (arg === "--truncate") options.truncate = Number.parseInt(argv[++index] || "1200", 10);
    else if (arg === "--format" || arg === "-o") {
      options.format = argv[++index] || "human";
      if (options.format === "json") options.agent = true;
    }
    else if (arg === "--limit" || arg === "-l") {
      options.limit = Number.parseInt(argv[++index] || "20", 10);
      options.limitExplicit = true;
    }
    else args.push(arg);
  }

  if (options.format === "json") options.agent = true;
  if (options.forceHuman) options.format = "human";
  if (options.agent && options.format === "human" && !options.forceHuman) options.format = "toon";
  options.args = args;
  options.human = !options.agent && options.format === "human";
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

function browseDefaultLimit(options) {
  return options.limitExplicit ? options.limit : options.browseLimit || options.limit;
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
  quill init
  quill doctor
  quill meetings list [--limit 20] [--since 7d] [--search text]
  quill browse [--limit 20] [--search text]
  quill meetings browse [--limit 20] [--search text]
  quill meetings view <id>
  quill ls
  quill v <id>
  quill <id>
  quill notes <id>
  quill summarize <id>
  quill note create <id> --prompt "..."
  quill actions <id>
  quill followup <id>
  quill transcript <id> [--full]
  quill search "<query>" [--limit 20] [--since "last week"] [--today]
  quill contacts list [--search text]
  quill threads list [--include-meetings]
  quill events list [--limit 20]
  quill templates list [--kind minutes]
  quill config show|get|set|init|path
  quill mcp tools
  quill mcp schema <tool>
  quill mcp call <tool> --input '{"key":"value"}'
  quill completion zsh|bash|fish

Global options:
  --json                  Print JSON instead of human output
  --agent                 Disable interactive prompts and human formatting
  --no-agent              Override agent.enabled from config for one command
  --human, --table        Force human table output when not using --json
  --fields <a,b,c>        Select list fields
  --full                  Disable large text truncation
  --truncate <chars>      Large text truncation limit
  -o, --format <format>   Output format: human, toon, or json
  -l, --limit <n>         Default result limit
  -h, --help              Show help
  -v, --version           Show version

Environment:
  QUILL_CONFIG            Config file path, defaults to ~/.config/quill-cli/config.json
  QUILL_AGENT_MODE=1      Agent mode by default
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
    init: `Usage:
  quill init

Notes:
  Writes the default JSON config if it does not exist, then runs the same setup checks as \`quill doctor\`.
`,
    doctor: `Usage:
  quill doctor

Notes:
  Checks Quill desktop install state, MCP bridge path, CLI config, app/CLI version info, and a short MCP handshake.
`,
    browse: `Usage:
  quill browse [--limit 20] [--search text] [--since 7d]

Keys:
  Enter=view, n=notes, t=transcript, a=actions, f=follow-up
  c=copy current panel, y=confirm note generation, b=back
  /=search, ?=help, q=quit

Agent mode:
  Browse is interactive and disabled with \`--json\`, \`--agent\`, or QUILL_AGENT_MODE=1.
`,
    notes: `Usage:
  quill notes <id> [--full]
  quill notes

Notes:
  Without an id in a TTY, opens the meeting picker.
`,
    note: `Usage:
  quill note create <id> --prompt "Generate a customer-ready recap"
  quill note create <id> "Summarize risks and blockers"
  quill note create <id> --template <template-id> [--instruction "..."]

Notes:
  Creates a generated Quill note attached to the meeting.
`,
    actions: `Usage:
  quill actions <id> [--instruction "..."]
  quill action-items <id>

Notes:
  Creates a generated action-item note attached to the meeting.
`,
    followup: `Usage:
  quill followup <id> [--instruction "..."]

Notes:
  Creates a generated follow-up note attached to the meeting.
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
    config: `Usage:
  quill config path
  quill config init
  quill config show
  quill config get <key>
  quill config set <key> <value>

Examples:
  quill config set mcp.mutation_timeout_ms 180000
  quill config set mcp.args '["/path/to/mcp-stdio-bridge.js"]'
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
  if (!supportedPlatform()) {
    throw cliError("unsupported_platform", "Quill CLI currently supports macOS and Windows. Linux support is not available yet.");
  }
  if (!options.agent) return;
  const [domain, actionOrValue, maybeValue] = args;
  if (domain === "browse" || ((domain === "meetings" || domain === "meeting") && actionOrValue === "browse")) {
    throw cliError("interactive_unavailable", "Interactive browsing is disabled in agent mode. Use `quill meetings list --json`.");
  }
  if (domain === "notes" || domain === "summary" || domain === "summarize" || domain === "transcript") {
    if (!actionOrValue) throw cliError("missing_meeting_id", `Missing meeting id. Usage: quill ${domain} <id>.`);
  }
  if (domain === "actions" || domain === "action-items" || domain === "followup" || domain === "follow-up") {
    if (!actionOrValue) throw cliError("missing_meeting_id", `Missing meeting id. Usage: quill ${domain} <id>.`);
  }
  if (domain === "note" && actionOrValue === "create" && !maybeValue) {
    throw cliError("missing_meeting_id", "Missing meeting id. Usage: quill note create <id> --prompt \"...\".");
  }
  if ((domain === "meetings" || domain === "meeting") && actionOrValue === "view" && !maybeValue) {
    throw cliError("missing_meeting_id", "Missing meeting id. Usage: quill meetings view <id>.");
  }
}

function looksLikeId(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

function printCompletion(shell) {
  const commands = "doctor init browse meetings meeting ls v view notes note n actions action-items followup follow-up transcript t search contacts threads events templates mcp config completion help";
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

function parseOptionalBoolean(value) {
  if (value === undefined) return undefined;
  if (value === true || value === "true") return true;
  if (value === false || value === "false") return false;
  return Boolean(value);
}
