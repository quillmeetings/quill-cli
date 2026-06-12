import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildPanelCall,
  cleanText,
  formatBrowsePanel,
  formatTextPanel,
  listColumns,
  renderRecord,
  splitList,
  truncatePanel,
  windowRows,
} from "../src/browser.js";

function tool(name, properties = undefined) {
  const inputSchema = properties ? { properties } : undefined;
  return { name, inputSchema };
}

test("cleanText: strips ToolResponse wrapper, tags, and decodes entities", () => {
  const input = "<ToolResponse><notes>Budget &amp; roadmap &quot;Q3&quot;</notes></ToolResponse>";
  assert.equal(cleanText(input), "Budget & roadmap \"Q3\"");
});

test("cleanText: removes embedded system-instruction blocks entirely", () => {
  const input = "before <system-instruction>do something sneaky</system-instruction> after";
  assert.equal(cleanText(input), "before  after");
});

test("cleanText: converts literal \\n sequences and collapses blank runs", () => {
  assert.equal(cleanText("a\\nb\n\n\n\nc"), "a\nb\n\nc");
});

test("formatTextPanel: prefers message, then text, then empty fallback", () => {
  assert.equal(formatTextPanel({ message: "hello" }, "empty"), "hello");
  assert.equal(formatTextPanel({ text: "world" }, "empty"), "world");
  assert.equal(formatTextPanel(null, "empty"), "empty");
  assert.equal(formatTextPanel({ message: "" }, "empty"), "empty");
});

test("formatTextPanel: renders a notes array as records", () => {
  const result = {
    notes: [
      { title: "Standup", body: "Discussed blockers" },
      { title: "Retro", body: "Went well" },
    ],
  };
  const rendered = formatTextPanel(result, "empty");
  assert.match(rendered, /Standup\n\nDiscussed blockers/);
  assert.match(rendered, /Retro\n\nWent well/);
});

test("renderRecord: joins title and body when a body field exists", () => {
  assert.equal(renderRecord({ title: "T", content: "C" }), "T\n\nC");
});

test("renderRecord: falls back to labeled key/value lines without a body", () => {
  const rendered = renderRecord({ meeting_id: "abc", duration: "30min", empty: "" });
  assert.match(rendered, /Meeting Id\s+abc/);
  assert.match(rendered, /Duration\s+30min/);
  assert.doesNotMatch(rendered, /Empty/);
});

test("truncatePanel: passes short content through and truncates long content", () => {
  assert.equal(truncatePanel("short", 100), "short");
  const truncated = truncatePanel("x".repeat(200), 100);
  assert.match(truncated, /truncated in browse view/);
  assert.ok(truncated.startsWith("x".repeat(100)));
});

test("windowRows: returns all rows when they fit", () => {
  const rows = ["a", "b", "c"];
  const result = windowRows(rows, 1, 10);
  assert.equal(result.start, 0);
  assert.equal(result.end, 3);
  assert.deepEqual(result.rows.map((row) => row.index), [0, 1, 2]);
});

test("windowRows: centers the selection and clamps at both ends", () => {
  const rows = Array.from({ length: 20 }, (_, index) => index);
  const middle = windowRows(rows, 10, 5);
  assert.equal(middle.start, 8);
  assert.equal(middle.end, 13);

  const top = windowRows(rows, 0, 5);
  assert.equal(top.start, 0);

  const bottom = windowRows(rows, 19, 5);
  assert.equal(bottom.end, 20);
  assert.equal(bottom.start, 15);
});

test("listColumns: keeps fixed date/duration widths and floors usable width at 60", () => {
  const narrow = listColumns(40);
  assert.equal(narrow.date, 9);
  assert.equal(narrow.duration, 7);
  // usable floors at 60, so title = min(44, floor(60 * 0.52)) = 31 and tags fill the rest
  assert.equal(narrow.title, 31);
  assert.equal(narrow.tags, 60 - 2 - 31 - 9 - 7);

  const wide = listColumns(120);
  assert.ok(wide.title >= 24 && wide.title <= 44);
  assert.ok(wide.tags > narrow.tags);
});

test("buildPanelCall: notes action routes to a notes tool with the meeting id mapped", () => {
  const tools = [tool("get_minutes", { meeting_id: {} })];
  const { tool: picked, args } = buildPanelCall(tools, "notes", { id: "abc" });
  assert.equal(picked.name, "get_minutes");
  assert.deepEqual(args, { meeting_id: "abc" });
});

test("buildPanelCall: actions routes to create_note with the action-items prompt", () => {
  const tools = [tool("create_note", { meeting_id: {}, prompt: {} })];
  const { tool: picked, args } = buildPanelCall(tools, "actions", { id: "abc" });
  assert.equal(picked.name, "create_note");
  assert.equal(args.meeting_id, "abc");
  assert.match(args.prompt, /action items/i);
});

test("buildPanelCall: followup routes to create_note with the follow-up prompt", () => {
  const tools = [tool("create_note", { meeting_id: {}, prompt: {} })];
  const { args } = buildPanelCall(tools, "followup", { id: "abc" });
  assert.match(args.prompt, /follow-up/i);
});

test("buildPanelCall: default action routes to getMeeting", () => {
  const tools = [tool("get_meeting", { id: {} })];
  const { tool: picked, args } = buildPanelCall(tools, "view", { id: "abc" });
  assert.equal(picked.name, "get_meeting");
  assert.deepEqual(args, { id: "abc" });
});

test("buildPanelCall: throws a coded error when no tool matches the route", () => {
  assert.throws(
    () => buildPanelCall([tool("unrelated_tool")], "notes", { id: "abc" }),
    (error) => error.code === "tool_route_unavailable",
  );
});

test("formatBrowsePanel: per-action empty fallbacks", () => {
  const meeting = { id: "abc" };
  assert.equal(formatBrowsePanel("notes", meeting, null), "No notes found for this meeting.");
  assert.equal(formatBrowsePanel("transcript", meeting, null), "No transcript found for this meeting.");
  assert.equal(formatBrowsePanel("actions", meeting, null), "Action-item note generation completed.");
});

test("formatBrowsePanel: view combines metadata and summary sections", () => {
  const meeting = { id: "abc", title: "Roadmap", date: "2026-06-01T10:00:00Z", summary: "Existing blurb" };
  const rendered = formatBrowsePanel("view", meeting, { meeting: null, minutes: null });
  assert.match(rendered, /Title\s+Roadmap/);
  assert.match(rendered, /Summary/);
  assert.match(rendered, /Existing blurb/);
});

test("splitList: handles strings, arrays, and falsy values", () => {
  assert.deepEqual(splitList("a, b , c"), ["a", "b", "c"]);
  assert.deepEqual(splitList(["a", "b"]), ["a", "b"]);
  assert.deepEqual(splitList(""), []);
  assert.deepEqual(splitList(null), []);
});
