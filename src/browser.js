import { spawn } from "node:child_process";
import React, { useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, render, useApp, useInput, useWindowSize } from "ink";
import { extractToolResult } from "./mcp-client.js";
import { buildArgs, findTool } from "./tool-router.js";

const h = React.createElement;

const ACTIONS_PROMPT = "Extract action items from this meeting. Return only concrete tasks. For each item include owner if mentioned, due date if mentioned, status or uncertainty, and brief source context. If there are no clear action items, say so explicitly.";
const FOLLOWUP_PROMPT = "Draft a concise follow-up note for this meeting. Include a short recap, decisions, open questions, action items, and a friendly next-step section. Keep it practical and ready to send.";

export function runMeetingBrowser(client, tools, meetings, options, pickerOptions = {}, helpers = {}) {
  return new Promise((resolve) => {
    const app = render(h(MeetingBrowser, {
      client,
      tools,
      meetings,
      options,
      pickerOptions,
      helpers,
      onDone: (value) => {
        resolve(value);
        app.unmount();
      },
    }), {
      alternateScreen: true,
      exitOnCtrlC: false,
      stdin: process.stdin,
      stdout: process.stdout,
    });
  });
}

function MeetingBrowser({ client, tools, meetings, options, pickerOptions, helpers, onDone }) {
  const { exit } = useApp();
  const { height, width } = useWindowSize();
  const screenHeight = Number.isFinite(height) && height > 0 ? height : 24;
  const screenWidth = Number.isFinite(width) && width > 0 ? width : process.stdout.columns || 100;
  const doneRef = useRef(false);
  const initialMeetings = useRef(meetings);
  const [currentMeetings, setCurrentMeetings] = useState(meetings);
  const [selected, setSelected] = useState(0);
  const [query, setQuery] = useState("");
  const [serverQuery, setServerQuery] = useState("");
  const [mode, setMode] = useState("list");
  const [showHelp, setShowHelp] = useState(false);
  const [panel, setPanel] = useState(null);
  const [pendingAction, setPendingAction] = useState(null);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState("");
  const [panelScroll, setPanelScroll] = useState(0);
  const [copyStatus, setCopyStatus] = useState("");

  const filtered = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return currentMeetings;
    return currentMeetings.filter((meeting) => [
      meeting.title,
      meeting.date,
      meeting.duration,
      meeting.participants,
      meeting.tags,
    ].filter(Boolean).join(" ").toLowerCase().includes(normalized));
  }, [currentMeetings, query]);

  useEffect(() => {
    setSelected((value) => Math.min(value, Math.max(filtered.length - 1, 0)));
  }, [filtered.length]);

  const finish = (value) => {
    if (doneRef.current) return;
    doneRef.current = true;
    exit();
    onDone(value);
  };

  const runServerSearch = async (searchText) => {
    if (!helpers.searchMeetings) {
      setSearchError("Server search is not available in this context.");
      return;
    }
    setSearching(true);
    setSearchError("");
    try {
      const results = await helpers.searchMeetings(searchText);
      setCurrentMeetings(Array.isArray(results) ? results : []);
      setServerQuery(searchText);
      setQuery("");
      setSelected(0);
    } catch (error) {
      setSearchError(`${error.code || "search_failed"}: ${error.message || String(error)}`);
    } finally {
      setSearching(false);
    }
  };

  const loadPanel = async (action) => {
    const meeting = filtered[selected];
    if (!meeting) return;
    if (pickerOptions.selectOnly) return finish({ meeting, action });

    setPanel({
      title: `${actionLabel(action)}: ${meeting.title || "(untitled)"}`,
      body: "Loading...",
      kind: "loading",
    });
    setPanelScroll(0);
    setCopyStatus("");
    setMode("panel");

    try {
      const result = action === "view"
        ? await loadMeetingOverview(client, tools, meeting)
        : await callPanelTool(client, tools, action, meeting);
      setPanel({
        title: `${actionLabel(action)}: ${meeting.title || "(untitled)"}`,
        body: formatBrowsePanel(action, meeting, result),
        kind: action,
      });
    } catch (error) {
      setPanel({
        title: "Error",
        body: `${error.code || "error"}: ${error.message}`,
        kind: "error",
      });
    }
  };

  const confirmMutation = (action) => {
    setPendingAction(action);
    setMode("confirm");
    setShowHelp(false);
  };

  const copyPanel = async () => {
    if (!panel?.body || panel.kind === "loading") {
      setCopyStatus("Nothing to copy yet.");
      return;
    }
    try {
      await copyToClipboard(panel.body);
      setCopyStatus(`Copied ${copyLabel(panel.kind)} to clipboard.`);
    } catch (error) {
      setCopyStatus(`${error.code || "copy_failed"}: ${error.message || String(error)}`);
    }
  };

  const exitPanel = () => {
    setMode("list");
    setShowHelp(false);
    setPanel(null);
    setPanelScroll(0);
    setCopyStatus("");
  };

  const exitConfirm = () => {
    setPendingAction(null);
    setMode(panel ? "panel" : "list");
    setShowHelp(false);
  };

  const exitFilter = () => {
    setQuery("");
    setMode("list");
  };

  const clearServerSearch = () => {
    setCurrentMeetings(initialMeetings.current);
    setServerQuery("");
    setSelected(0);
  };

  useInput((input, key = {}) => {
    if (key.ctrl && input === "c") return finish(null);
    if (searching) return;

    if (mode === "filter") {
      if (key.escape) return exitFilter();
      if (key.return) {
        setMode("list");
        const trimmed = query.trim();
        if (!trimmed) {
          if (serverQuery) clearServerSearch();
          return;
        }
        return runServerSearch(trimmed);
      }
      if (key.backspace || key.delete) return setQuery((value) => value.slice(0, -1));
      if (input && !key.ctrl && !key.meta && input >= " ") return setQuery((value) => value + input);
      return;
    }

    if (mode === "panel") {
      if (key.escape || input === "b") return exitPanel();
      if (input === "q") return finish(null);
      if (input === "?") return setShowHelp((value) => !value);
      if (input === "c") return copyPanel();
      if (input === "n") return loadPanel("notes");
      if (input === "t") return loadPanel("transcript");
      if (input === "a") return confirmMutation("actions");
      if (input === "f") return confirmMutation("followup");
      if (key.return) return loadPanel("view");
      if (isDownKey(input, key)) return setPanelScroll((value) => value + 1);
      if (isUpKey(input, key)) return setPanelScroll((value) => Math.max(value - 1, 0));
      if (isPageDownKey(key)) return setPanelScroll((value) => value + 8);
      if (isPageUpKey(key)) return setPanelScroll((value) => Math.max(value - 8, 0));
      return;
    }

    if (mode === "confirm") {
      if (key.escape || input === "n" || input === "b") return exitConfirm();
      if (input === "q") return finish(null);
      if (input === "?") return setShowHelp((value) => !value);
      if (input === "y") {
        const action = pendingAction;
        setPendingAction(null);
        return loadPanel(action);
      }
      return;
    }

    // List mode. ESC pops one layer at a time, then quits.
    if (key.escape) {
      if (showHelp) return setShowHelp(false);
      if (searchError) return setSearchError("");
      if (query) return setQuery("");
      if (serverQuery) return clearServerSearch();
      return finish(null);
    }

    if (input === "q") return finish(null);
    if (isDownKey(input, key)) return setSelected((value) => Math.min(value + 1, filtered.length - 1));
    if (isUpKey(input, key)) return setSelected((value) => Math.max(value - 1, 0));
    if (input === "/") {
      setMode("filter");
      setShowHelp(false);
      setSearchError("");
      return;
    }
    if (input === "?") return setShowHelp((value) => !value);
    if (key.return && filtered[selected]) return loadPanel("view");
    if (input === "n" && filtered[selected]) return loadPanel("notes");
    if (input === "t" && filtered[selected]) return loadPanel("transcript");
    if (input === "a" && filtered[selected]) return confirmMutation("actions");
    if (input === "f" && filtered[selected]) return confirmMutation("followup");
  });

  if (mode === "confirm") {
    return h(ConfirmView, {
      action: pendingAction,
      meeting: filtered[selected],
      showHelp,
      screenHeight,
    });
  }

  if (mode === "panel") {
    return h(PanelView, {
      panel,
      showHelp,
      panelScroll,
      copyStatus,
      maxBodyLines: Math.max(4, screenHeight - (showHelp ? 16 : 5)),
      truncate: options.browsePanelTruncate,
      screenHeight,
    });
  }

  return h(ListView, {
    filtered,
    selected,
    query,
    serverQuery,
    mode,
    showHelp,
    searching,
    searchError,
    maxRows: Math.max(5, screenHeight - (showHelp ? 17 : 5)),
    width: screenWidth,
    screenHeight,
  });
}

function ListView({ filtered, selected, query, serverQuery, mode, showHelp, searching, searchError, maxRows, width, screenHeight }) {
  const windowed = windowRows(filtered, selected, maxRows);
  const columns = listColumns(width);
  const countLabel = filtered.length > maxRows
    ? `${windowed.start + 1}-${windowed.end} of ${filtered.length} meetings`
    : `${filtered.length} meeting${filtered.length === 1 ? "" : "s"}`;
  return h(Box, { flexDirection: "column", height: screenHeight },
    h(Header, { title: "Quill meetings", hint: mode === "filter"
      ? "type=filter live  Enter=server search  Esc=cancel"
      : "Enter=view  n=notes  t=transcript  a=actions  f=follow-up  /=search  ? help  q=quit" }),
    mode === "filter"
      ? h(Text, null, h(Text, { color: "cyan" }, "search: "), query, h(Text, { color: "cyan" }, "█"))
      : null,
    searchError ? h(Text, { color: "red" }, searchError) : null,
    showHelp ? h(HelpView) : null,
    searching ? h(Text, { color: "cyan" }, `Searching for "${query || serverQuery}"...`) : null,
    !searching && filtered.length === 0 ? h(Text, { color: "yellow" }, `No meetings${query || serverQuery ? ` for "${query || serverQuery}"` : ""}.`) : null,
    !searching && filtered.length > 0 ? h(Box, { flexDirection: "column", marginTop: 1 },
      ...windowed.rows.map(({ meeting, index }) => h(MeetingRow, {
        key: meeting.id || index,
        meeting,
        selected: index === selected,
        query,
        columns,
      })),
    ) : null,
    h(Box, { flexGrow: 1 }),
    h(Box, { flexDirection: "column" },
      serverQuery
        ? h(Text, null, h(Text, { color: "cyan" }, `server results for "${serverQuery}"`), h(Text, { dimColor: true }, "  (Esc to clear)"))
        : null,
      mode !== "filter" && !searching ? h(Text, { dimColor: true }, countLabel) : null,
    ),
  );
}

function MeetingRow({ meeting, selected, query, columns }) {
  const marker = selected ? ">" : " ";
  const title = truncateInline(meeting.title || "(untitled)", columns.title - 1);
  const tags = truncateInline(meeting.tags || "", columns.tags);
  return h(Box, { flexDirection: "row" },
    h(Box, { width: 2 },
      h(Text, { color: selected ? "cyan" : undefined, bold: selected }, `${marker} `),
    ),
    h(Box, { width: columns.title },
      h(Text, { color: selected ? "cyan" : undefined, bold: selected }, h(HighlightedText, { text: title, query })),
    ),
    h(Box, { width: columns.date },
      h(Text, { dimColor: true }, formatShortDate(meeting.date)),
    ),
    h(Box, { width: columns.duration },
      h(Text, { dimColor: true }, String(meeting.duration || "")),
    ),
    columns.tags > 0 ? h(Box, { width: columns.tags },
      h(Text, { color: selected ? "green" : "gray" }, h(HighlightedText, { text: tags, query })),
    ) : null,
  );
}

function PanelView({ panel, showHelp, panelScroll, copyStatus, maxBodyLines, truncate, screenHeight }) {
  const body = truncatePanel(panel?.body || "", truncate);
  const lines = body.split("\n");
  const maxScroll = Math.max(lines.length - maxBodyLines, 0);
  const scroll = Math.min(panelScroll, maxScroll);
  const visibleLines = lines.slice(scroll, scroll + maxBodyLines);
  return h(Box, { flexDirection: "column", height: screenHeight },
    h(Header, {
      title: panel?.title || "Meeting",
      hint: "b/Esc=list  c=copy  n=notes  t=transcript  a=actions  f=follow-up  arrows/j/k=scroll  ? help  q=quit",
      tone: panel?.kind === "error" ? "error" : "normal",
    }),
    showHelp ? h(HelpView, { panel: true }) : null,
    h(Box, { borderStyle: "round", borderColor: panel?.kind === "error" ? "red" : "cyan", paddingX: 1, flexDirection: "column" },
      ...visibleLines.map((line, index) => h(Text, { key: `${scroll}-${index}` }, line || " ")),
    ),
    h(Box, { flexGrow: 1 }),
    copyStatus ? h(Text, { color: copyStatus.startsWith("Copied") ? "green" : "yellow" }, copyStatus) : null,
    h(PanelFooter, { scroll, maxScroll, maxBodyLines, totalLines: lines.length }),
  );
}

function ConfirmView({ action, meeting, showHelp, screenHeight }) {
  return h(Box, { flexDirection: "column", height: screenHeight },
    h(Header, { title: actionLabel(action), hint: "y=create  n/b/Esc=cancel  ? help  q=quit", tone: "warning" }),
    showHelp ? h(HelpView) : null,
    h(Box, { flexGrow: 1 }),
    h(Box, { borderStyle: "round", borderColor: "yellow", paddingX: 1, flexDirection: "column" },
      h(Text, null, "Create a generated ", actionLabel(action).toLowerCase(), " note for:"),
      h(Text, { bold: true }, meeting?.title || "(untitled)"),
      h(Text, null, " "),
      h(Text, { color: "yellow" }, "This will add a new note to the meeting in Quill."),
    ),
    h(Box, { flexGrow: 1 }),
  );
}

function Header({ title, hint, tone = "normal" }) {
  const color = tone === "warning" ? "yellow" : tone === "error" ? "red" : "cyan";
  return h(Box, { flexDirection: "column" },
    h(Text, { color, bold: true }, title),
    h(Text, { dimColor: true }, hint),
  );
}

function HelpView() {
  return h(Box, { borderStyle: "single", borderColor: "gray", paddingX: 1, flexDirection: "column", marginBottom: 1 },
    h(Text, { bold: true }, "Browse keys"),
    h(HelpLine, { keys: "↑/↓, j/k", text: "Move selection or scroll a panel" }),
    h(HelpLine, { keys: "Enter", text: "View selected meeting without leaving browse" }),
    h(HelpLine, { keys: "n", text: "Open notes/minutes" }),
    h(HelpLine, { keys: "t", text: "Open transcript" }),
    h(HelpLine, { keys: "a", text: "Generate action-item note after confirmation" }),
    h(HelpLine, { keys: "f", text: "Generate follow-up note after confirmation" }),
    h(HelpLine, { keys: "c", text: "Copy the current panel content to clipboard" }),
    h(HelpLine, { keys: "/", text: "Search locally while typing, Enter fetches from server" }),
    h(HelpLine, { keys: "b/Esc", text: "Back or clear active state" }),
    h(HelpLine, { keys: "q", text: "Quit" }),
  );
}

function PanelFooter({ scroll, maxScroll, maxBodyLines, totalLines }) {
  if (maxScroll <= 0) return h(Text, { dimColor: true }, "End of content");
  const end = Math.min(scroll + maxBodyLines, totalLines);
  const canScrollUp = scroll > 0;
  const canScrollDown = scroll < maxScroll;
  return h(Box, { flexDirection: "column", marginTop: 1 },
    h(Text, { color: "yellow" },
      canScrollUp ? "↑ more above" : "top",
      "  ",
      `lines ${scroll + 1}-${end} of ${totalLines}`,
      "  ",
      canScrollDown ? "↓ more below" : "end",
    ),
    h(Text, { dimColor: true }, "Scroll with ↑/↓ or j/k. Use PgUp/PgDn for larger jumps. Press b or Esc to return to the list."),
  );
}

function HelpLine({ keys, text }) {
  return h(Text, null, h(Text, { color: "cyan" }, keys.padEnd(13)), " ", text);
}

function HighlightedText({ text, query }) {
  const needle = query.trim();
  if (!needle) return text;
  const index = text.toLowerCase().indexOf(needle.toLowerCase());
  if (index === -1) return text;
  return h(React.Fragment, null,
    text.slice(0, index),
    h(Text, { inverse: true }, text.slice(index, index + needle.length)),
    text.slice(index + needle.length),
  );
}

export function windowRows(rows, selected, maxRows) {
  if (rows.length <= maxRows) return { start: 0, end: rows.length, rows: rows.map((meeting, index) => ({ meeting, index })) };
  const half = Math.floor(maxRows / 2);
  const start = Math.max(0, Math.min(selected - half, rows.length - maxRows));
  const end = Math.min(rows.length, start + maxRows);
  return {
    start,
    end,
    rows: rows.slice(start, end).map((meeting, offset) => ({ meeting, index: start + offset })),
  };
}

export function listColumns(width) {
  const usable = Math.max(60, width - 2);
  const date = 9;
  const duration = 7;
  const title = Math.max(24, Math.min(44, Math.floor(usable * 0.52)));
  const tags = Math.max(0, usable - 2 - title - date - duration);
  return { title, date, duration, tags };
}

function isDownKey(input, key) {
  return input === "j" || key.downArrow || key.down || key.name === "down";
}

function isUpKey(input, key) {
  return input === "k" || key.upArrow || key.up || key.name === "up";
}

function isPageDownKey(key) {
  return key.pageDown || key.name === "pagedown";
}

function isPageUpKey(key) {
  return key.pageUp || key.name === "pageup";
}

function copyLabel(kind) {
  if (kind === "notes") return "notes";
  if (kind === "transcript") return "transcript";
  if (kind === "view") return "meeting overview";
  if (kind === "actions") return "action-item note";
  if (kind === "followup") return "follow-up note";
  return "panel";
}

function copyToClipboard(text) {
  const command = clipboardCommand();
  if (!command) {
    const error = new Error("No clipboard command found. Install pbcopy, wl-copy, xclip, or xsel.");
    error.code = "clipboard_unavailable";
    return Promise.reject(error);
  }

  return new Promise((resolve, reject) => {
    const child = spawn(command.command, command.args, { stdio: ["pipe", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      error.code = "clipboard_unavailable";
      reject(error);
    });
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      const error = new Error(stderr.trim() || `Clipboard command exited with ${code}`);
      error.code = "copy_failed";
      reject(error);
    });
    child.stdin.end(text);
  });
}

function clipboardCommand() {
  if (process.platform === "darwin") return { command: "pbcopy", args: [] };
  if (process.platform === "win32") {
    return { command: "powershell.exe", args: ["-NoProfile", "-Command", "Set-Clipboard"] };
  }
  if (process.env.WAYLAND_DISPLAY) return { command: "wl-copy", args: [] };
  if (process.env.DISPLAY) return { command: "xclip", args: ["-selection", "clipboard"] };
  return { command: "xsel", args: ["--clipboard", "--input"] };
}

function actionLabel(action) {
  if (action === "notes") return "Notes";
  if (action === "transcript") return "Transcript";
  if (action === "actions") return "Action items";
  if (action === "followup") return "Follow-up";
  return "Meeting";
}

export function formatBrowsePanel(action, meeting, result) {
  if (action === "view") return formatMeetingOverviewPanel(result, meeting);
  if (action === "notes") return formatTextPanel(result, "No notes found for this meeting.");
  if (action === "transcript") return formatTextPanel(result, "No transcript found for this meeting.");
  if (action === "actions") return formatTextPanel(result, "Action-item note generation completed.");
  if (action === "followup") return formatTextPanel(result, "Follow-up note generation completed.");
  return formatTextPanel(result, "");
}

async function loadMeetingOverview(client, tools, meeting) {
  const meetingResult = await callPanelTool(client, tools, "view", meeting);
  let minutesResult;
  try {
    minutesResult = await callPanelTool(client, tools, "notes", meeting);
  } catch {
    minutesResult = null;
  }
  return { meeting: meetingResult, minutes: minutesResult };
}

async function callPanelTool(client, tools, action, meeting) {
  const { tool, args } = buildPanelCall(tools, action, meeting);
  return extractToolResult(await client.callTool(tool.name, args));
}

export function buildPanelCall(tools, action, meeting) {
  const route = action === "notes"
    ? "getNotes"
    : action === "transcript"
      ? "getTranscript"
      : action === "actions" || action === "followup"
        ? "createNote"
        : "getMeeting";
  const tool = findTool(tools, route);
  if (!tool) throw browserError("tool_route_unavailable", `Could not find a Quill MCP tool for ${route}`);
  const values = action === "actions"
    ? { meetingId: meeting.id, prompt: ACTIONS_PROMPT }
    : action === "followup"
      ? { meetingId: meeting.id, prompt: FOLLOWUP_PROMPT }
      : { id: meeting.id };
  return { tool, args: buildArgs(tool, values) };
}

function formatMeetingOverviewPanel(result, fallbackMeeting) {
  const meeting = result?.meeting?.meetings?.[0] || fallbackMeeting || {};
  const metadata = formatMeetingPanel(result?.meeting, fallbackMeeting);
  const summary = formatTextPanel(result?.minutes, "");
  const existingSummary = cleanText(meeting.summary || meeting.blurb || "");
  const sections = [
    metadata,
    summary
      ? `\nSummary\n-------\n${summary}`
      : existingSummary
        ? `\nSummary\n-------\n${existingSummary}`
        : "\nSummary\n-------\nNo minutes found. Press n for notes, t for transcript, or f to generate a follow-up note.",
    "\nActions\n-------\nn notes/minutes   t transcript   a action items   f follow-up   b back",
  ];
  return sections.filter(Boolean).join("\n");
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

export function formatTextPanel(result, emptyMessage) {
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

export function renderRecord(record) {
  if (!record || typeof record !== "object") return cleanText(String(record || ""));
  const body = record.body || record.text || record.content || record.markdown || record.message;
  const title = record.title || record.name;
  if (body) return [title, cleanText(body)].filter(Boolean).join("\n\n");
  return Object.entries(record)
    .filter(([, value]) => value !== undefined && value !== null && value !== "")
    .map(([key, value]) => `${humanLabel(key).padEnd(12)} ${Array.isArray(value) ? value.join(", ") : value}`)
    .join("\n");
}

export function cleanText(value) {
  return String(value)
    .replace(/^<ToolResponse>\s*/s, "")
    .replace(/\s*<\/ToolResponse>$/s, "")
    .replace(/<system-instruction>[\s\S]*?<\/system-instruction>/g, "")
    .replace(/<[^>]+>/g, "")
    .replace(/\\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replaceAll("&quot;", "\"")
    .replaceAll("&apos;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&")
    .trim();
}

export function truncatePanel(value, limit = 5000) {
  if (value.length <= limit) return value;
  return `${value.slice(0, limit)}\n... (truncated in browse view; use command with --full for complete output)`;
}

function truncateInline(value, max) {
  const text = String(value).replace(/\s+/g, " ");
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
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

export function splitList(value) {
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
