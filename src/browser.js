import { emitKeypressEvents } from "node:readline";
import { extractToolResult } from "./mcp-client.js";
import { buildArgs, findTool } from "./tool-router.js";

export function runMeetingBrowser(client, tools, meetings, options, pickerOptions = {}, helpers = {}) {
  return new Promise((resolve) => {
    const initialMeetings = meetings;
    let currentMeetings = meetings;
    let selected = 0;
    let query = "";
    let serverQuery = "";
    let mode = "list";
    let showHelp = false;
    let panel = null;
    let filtered = currentMeetings;
    let searching = false;
    let searchError = "";
    const stdin = process.stdin;
    const wasRaw = stdin.isRaw;

    emitKeypressEvents(stdin);
    stdin.setRawMode(true);
    stdin.resume();

    const cleanup = () => {
      stdin.off("keypress", onKeypress);
      stdin.setRawMode(Boolean(wasRaw));
      if (!wasRaw) stdin.pause();
      process.stdout.write("\x1b[?25h\x1b[2J\x1b[H");
    };

    const finish = (value) => {
      cleanup();
      resolve(value);
    };

    const refreshFilter = () => {
      const normalized = query.trim().toLowerCase();
      filtered = normalized
        ? currentMeetings.filter((meeting) => [
          meeting.title,
          meeting.date,
          meeting.duration,
          meeting.participants,
          meeting.tags,
        ].filter(Boolean).join(" ").toLowerCase().includes(normalized))
        : currentMeetings;
      selected = Math.min(selected, Math.max(filtered.length - 1, 0));
    };

    const runServerSearch = async (q) => {
      if (!helpers.searchMeetings) {
        searchError = "Server search is not available in this context.";
        render();
        return;
      }
      searching = true;
      searchError = "";
      render();
      try {
        const results = await helpers.searchMeetings(q);
        currentMeetings = Array.isArray(results) ? results : [];
        serverQuery = q;
        query = "";
        selected = 0;
        refreshFilter();
      } catch (error) {
        searchError = `${error.code || "search_failed"}: ${error.message || String(error)}`;
      } finally {
        searching = false;
        render();
      }
    };

    const loadPanel = async (action) => {
      const meeting = filtered[selected];
      if (!meeting) return;
      if (pickerOptions.selectOnly) return finish({ meeting, action });

      panel = {
        title: `${actionLabel(action)}: ${meeting.title || "(untitled)"}`,
        body: "Loading...",
      };
      mode = "panel";
      render();

      const route = action === "notes" ? "getNotes" : action === "transcript" ? "getTranscript" : "getMeeting";
      try {
        const tool = findTool(tools, route);
        if (!tool) throw browserError("tool_route_unavailable", `Could not find a Quill MCP tool for ${route}`);
        const args = buildArgs(tool, { id: meeting.id });
        const result = extractToolResult(await client.callTool(tool.name, args));
        panel = {
          title: `${actionLabel(action)}: ${meeting.title || "(untitled)"}`,
          body: formatBrowsePanel(action, meeting, result),
        };
      } catch (error) {
        panel = {
          title: "Error",
          body: `${error.code || "error"}: ${error.message}`,
        };
      }
      render();
    };

    const render = () => {
      process.stdout.write("\x1b[?25l\x1b[2J\x1b[H");
      process.stdout.write("Quill meetings\n");
      if (mode === "panel") {
        process.stdout.write("b/Esc=list  n=notes  t=transcript  Enter=view  ? help  q=quit\n\n");
        if (showHelp) renderHelp();
        process.stdout.write(`${panel?.title || "Meeting"}\n`);
        process.stdout.write(`${"-".repeat(Math.min((panel?.title || "Meeting").length, 80))}\n`);
        process.stdout.write(`${truncatePanel(panel?.body || "")}\n`);
        return;
      }

      if (mode === "filter") {
        process.stdout.write("type=filter live  Enter=server search  Esc=cancel\n");
        process.stdout.write(`search: ${query}█\n`);
      } else {
        process.stdout.write("Enter=view  n=notes  t=transcript  /=search  ? help  q=quit\n");
        if (searching) process.stdout.write("\n");
        else if (serverQuery) process.stdout.write(`server results for "${serverQuery}"  (Esc to clear)\n`);
        else process.stdout.write("\n");
      }
      if (searchError) process.stdout.write(`${searchError}\n`);
      process.stdout.write("\n");

      if (showHelp) renderHelp();

      if (searching) {
        process.stdout.write(`Searching for "${query || serverQuery}"...\n`);
        return;
      }

      if (filtered.length === 0) {
        const highlight = (query || serverQuery) ? ` for "${query || serverQuery}"` : "";
        process.stdout.write(`No meetings${highlight}.\n`);
        return;
      }

      for (const [index, meeting] of filtered.entries()) {
        const marker = index === selected ? ">" : " ";
        const title = highlightMatch(truncateInline(meeting.title || "(untitled)", 44), query);
        const date = formatShortDate(meeting.date).padEnd(12);
        const duration = String(meeting.duration || "").padEnd(6);
        const tags = highlightMatch(truncateInline(meeting.tags || "", 28), query);
        process.stdout.write(`${marker} ${padAnsi(title, 46)} ${date} ${duration} ${tags}\n`);
      }
    };

    const renderHelp = () => {
      process.stdout.write("Browse keys\n");
      process.stdout.write("  up/down, j/k   Move selection\n");
      process.stdout.write("  Enter          View selected meeting without leaving browse\n");
      process.stdout.write("  n              Open notes/minutes\n");
      process.stdout.write("  t              Open transcript\n");
      process.stdout.write("  b              Back to list from a detail panel\n");
      process.stdout.write("  /              Search (live filter while typing, Enter fetches from server)\n");
      process.stdout.write("  Esc            Clear search/help/panel, then quit\n");
      process.stdout.write("  q              Quit\n");
      process.stdout.write("  ?              Toggle this help\n\n");
    };

    const onKeypress = (str, key = {}) => {
      if (key.ctrl && key.name === "c") return finish(null);
      if (searching) return;
      if (mode === "filter") {
        if (key.name === "return") {
          mode = "list";
          const trimmed = query.trim();
          if (trimmed.length === 0) {
            if (serverQuery) {
              currentMeetings = initialMeetings;
              serverQuery = "";
              selected = 0;
              refreshFilter();
            }
            render();
            return;
          }
          runServerSearch(trimmed);
          return;
        }
        if (key.name === "escape") {
          mode = "list";
          refreshFilter();
          render();
          return;
        }
        if (key.name === "backspace") query = query.slice(0, -1);
        else if (str && !key.ctrl && !key.meta && str >= " ") query += str;
        refreshFilter();
        render();
        return;
      }

      if (mode === "panel") {
        if (str === "q") return finish(null);
        if (str === "?") showHelp = !showHelp;
        else if (str === "b" || key.name === "escape") {
          mode = "list";
          showHelp = false;
          panel = null;
        } else if (str === "n") {
          loadPanel("notes");
          return;
        } else if (str === "t") {
          loadPanel("transcript");
          return;
        } else if (key.name === "return" || str === "\r") {
          loadPanel("view");
          return;
        }
        render();
        return;
      }

      if (key.name === "down" || str === "j") selected = Math.min(selected + 1, filtered.length - 1);
      else if (key.name === "up" || str === "k") selected = Math.max(selected - 1, 0);
      else if (str === "/") {
        mode = "filter";
        showHelp = false;
        searchError = "";
      } else if (str === "?") showHelp = !showHelp;
      else if (key.name === "escape" && (showHelp || query || serverQuery || searchError)) {
        if (query) {
          query = "";
          refreshFilter();
        } else if (serverQuery) {
          currentMeetings = initialMeetings;
          serverQuery = "";
          selected = 0;
          refreshFilter();
        } else {
          showHelp = false;
          searchError = "";
        }
      } else if (str === "q" || key.name === "escape") return finish(null);
      else if ((key.name === "return" || str === "\r") && filtered[selected]) {
        loadPanel("view");
        return;
      } else if (str === "n" && filtered[selected]) {
        loadPanel("notes");
        return;
      } else if (str === "t" && filtered[selected]) {
        loadPanel("transcript");
        return;
      }
      render();
    };

    stdin.on("keypress", onKeypress);
    render();
  });
}

function actionLabel(action) {
  if (action === "notes") return "Notes";
  if (action === "transcript") return "Transcript";
  return "Meeting";
}

function formatBrowsePanel(action, meeting, result) {
  if (action === "view") return formatMeetingPanel(result, meeting);
  if (action === "notes") return formatTextPanel(result, "No notes found for this meeting.");
  if (action === "transcript") return formatTextPanel(result, "No transcript found for this meeting.");
  return formatTextPanel(result, "");
}

function formatMeetingPanel(result, fallbackMeeting) {
  const meeting = result?.meetings?.[0] || fallbackMeeting || {};
  const rows = [
    ["Title", meeting.title || "(untitled)"],
    ["Date", formatLongDate(meeting.date)],
    ["Duration", meeting.duration],
    ["Participants", splitList(meeting.participants).join(", ")],
    ["Tags", splitList(meeting.tags).join(", ")],
    ["ID", meeting.id],
    ["URL", meeting.url],
  ].filter(([, value]) => value);

  return rows.map(([label, value]) => `${label.padEnd(12)} ${value}`).join("\n");
}

function formatTextPanel(result, emptyMessage) {
  if (!result) return emptyMessage;
  if (typeof result === "string") return cleanText(result) || emptyMessage;
  if (typeof result.message === "string") return cleanText(result.message) || emptyMessage;
  if (typeof result.text === "string") return cleanText(result.text) || emptyMessage;

  for (const key of ["notes", "transcripts", "items"]) {
    if (Array.isArray(result[key])) {
      const rendered = result[key].map((item) => renderRecord(item)).filter(Boolean).join("\n\n");
      return rendered || emptyMessage;
    }
  }

  return renderRecord(result) || emptyMessage;
}

function renderRecord(record) {
  if (!record || typeof record !== "object") return cleanText(String(record || ""));
  const body = record.body || record.text || record.content || record.markdown || record.message;
  const title = record.title || record.name;
  if (body) return [title, cleanText(body)].filter(Boolean).join("\n\n");
  return Object.entries(record)
    .filter(([, value]) => value !== undefined && value !== null && value !== "")
    .map(([key, value]) => `${humanLabel(key).padEnd(12)} ${Array.isArray(value) ? value.join(", ") : value}`)
    .join("\n");
}

function cleanText(value) {
  return String(value)
    .replace(/^<ToolResponse>\s*/s, "")
    .replace(/\s*<\/ToolResponse>$/s, "")
    .replace(/<system-instruction>[\s\S]*?<\/system-instruction>/g, "")
    .replace(/<[^>]+>/g, "")
    .replace(/\\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function truncatePanel(value, limit = 5000) {
  if (value.length <= limit) return value;
  return `${value.slice(0, limit)}\n... (truncated in browse view; use command with --full for complete output)`;
}

function truncateInline(value, max) {
  const text = String(value).replace(/\s+/g, " ");
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

function highlightMatch(value, query) {
  const needle = query.trim();
  if (!needle) return value;
  const index = value.toLowerCase().indexOf(needle.toLowerCase());
  if (index === -1) return value;
  const before = value.slice(0, index);
  const match = value.slice(index, index + needle.length);
  const after = value.slice(index + needle.length);
  return `${before}\x1b[7m${match}\x1b[0m${after}`;
}

function padAnsi(value, width) {
  const visible = value.replace(/\x1b\[[0-9;]*m/g, "").length;
  return `${value}${" ".repeat(Math.max(width - visible, 0))}`;
}

function formatShortDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

function formatLongDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value || "";
  return date.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function splitList(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  return String(value).split(",").map((item) => item.trim()).filter(Boolean);
}

function humanLabel(value) {
  return String(value).replace(/_/g, " ").replace(/\b\w/g, (char) => char.toUpperCase());
}

function browserError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}
