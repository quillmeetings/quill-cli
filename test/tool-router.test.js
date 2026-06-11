import { test } from "node:test";
import assert from "node:assert/strict";
import { findTool, buildArgs, toolSupportsOffset } from "../src/tool-router.js";

function tool(name, description = "", properties = undefined) {
  const inputSchema = properties ? { properties } : undefined;
  return { name, description, inputSchema };
}

test("findTool: exact alias match wins over fuzzy", () => {
  const tools = [
    tool("search_meetings", "fallback fuzzy candidate"),
    tool("list_meetings", "primary alias"),
  ];
  const match = findTool(tools, "listMeetings");
  assert.equal(match.name, "list_meetings");
});

test("findTool: tries aliases in declared order — first matching alias wins", () => {
  // ROUTES.listMeetings order: meetings_list, list_meetings, meeting_list, get_meetings, search_meetings
  const tools = [
    tool("search_meetings"),
    tool("get_meetings"),
    tool("meetings_list"),
  ];
  const match = findTool(tools, "listMeetings");
  assert.equal(match.name, "meetings_list");
});

test("findTool: normalizes punctuation/casing so 'Get-Meeting' matches 'get_meeting'", () => {
  const tools = [tool("Get-Meeting", "fetch one meeting")];
  const match = findTool(tools, "getMeeting");
  assert.equal(match.name, "Get-Meeting");
});

test("findTool: falls back to fuzzy match when no alias matches", () => {
  // No alias in ROUTES.listMeetings matches "fetch_recent_meetings", but the description
  // contains both "list" and "meetings", so the fuzzy fallback should hit.
  const tools = [tool("fetch_recent_meetings", "list of recent meetings for the user")];
  const match = findTool(tools, "listMeetings");
  assert.equal(match.name, "fetch_recent_meetings");
});

test("findTool: returns undefined when nothing matches by alias or fuzzy", () => {
  const tools = [tool("unrelated_tool", "does something else")];
  const match = findTool(tools, "listMeetings");
  assert.equal(match, undefined);
});

test("findTool: unknown route falls through to fuzzy on the camelCase words", () => {
  // No ROUTES.fooBar, so candidates = []. Fuzzy splits to ["foo", "bar"].
  const tools = [tool("foo_bar_tool", "does foo and bar things")];
  const match = findTool(tools, "fooBar");
  assert.equal(match.name, "foo_bar_tool");
});

test("findTool: getNotes resolves to get_minutes (first alias) when present", () => {
  const tools = [tool("get_summary"), tool("get_minutes"), tool("get_notes")];
  const match = findTool(tools, "getNotes");
  assert.equal(match.name, "get_minutes");
});

test("findTool: createNote resolves through any of its aliases", () => {
  const a = findTool([tool("create_note")], "createNote");
  const b = findTool([tool("note_create")], "createNote");
  const c = findTool([tool("create_meeting_note")], "createNote");
  assert.equal(a.name, "create_note");
  assert.equal(b.name, "note_create");
  assert.equal(c.name, "create_meeting_note");
});

test("toolSupportsOffset: true when the schema declares offset or skip", () => {
  assert.equal(toolSupportsOffset(tool("list_things", "", { offset: {} })), true);
  assert.equal(toolSupportsOffset(tool("list_things", "", { skip: {} })), true);
});

test("toolSupportsOffset: false without an offset-style property or schema", () => {
  assert.equal(toolSupportsOffset(tool("list_things", "", { limit: {} })), false);
  assert.equal(toolSupportsOffset({ name: "tool_without_schema" }), false);
});

test("buildArgs: keeps key as-is when the schema already declares it", () => {
  const t = tool("anything", "", { meeting_id: {}, limit: {} });
  const args = buildArgs(t, { meeting_id: "abc", limit: 10 });
  assert.deepEqual(args, { meeting_id: "abc", limit: 10 });
});

test("buildArgs: remaps generic id → meeting_id when schema uses meeting_id", () => {
  const t = tool("get_meeting", "", { meeting_id: {} });
  assert.deepEqual(buildArgs(t, { id: "abc" }), { meeting_id: "abc" });
});

test("buildArgs: remaps generic id → meetingId (camelCase) when schema uses meetingId", () => {
  const t = tool("get_meeting", "", { meetingId: {} });
  assert.deepEqual(buildArgs(t, { id: "abc" }), { meetingId: "abc" });
});

test("buildArgs: remaps id → document_id when only document_id exists", () => {
  const t = tool("get_doc", "", { document_id: {} });
  assert.deepEqual(buildArgs(t, { id: "abc" }), { document_id: "abc" });
});

test("buildArgs: remaps query → q when schema uses q", () => {
  const t = tool("search", "", { q: {}, limit: {} });
  const args = buildArgs(t, { query: "roadmap", limit: 5 });
  assert.deepEqual(args, { q: "roadmap", limit: 5 });
});

test("buildArgs: remaps limit → page_size when schema uses page_size", () => {
  const t = tool("list_things", "", { page_size: {} });
  assert.deepEqual(buildArgs(t, { limit: 25 }), { page_size: 25 });
});

test("buildArgs: remaps since → after when schema uses after", () => {
  const t = tool("list_things", "", { after: {} });
  assert.deepEqual(buildArgs(t, { since: "2026-01-01T00:00:00Z" }), { after: "2026-01-01T00:00:00Z" });
});

test("buildArgs: drops undefined, null, and empty-string values", () => {
  const t = tool("list_things", "", { query: {}, limit: {}, offset: {} });
  const args = buildArgs(t, { query: "x", limit: undefined, offset: null, extra: "" });
  assert.deepEqual(args, { query: "x" });
});

test("buildArgs: keeps the original key when no alias matches the schema", () => {
  const t = tool("custom_tool", "", { foo: {} });
  // `bar` has no alias entry, so it passes through unchanged
  assert.deepEqual(buildArgs(t, { bar: "value" }), { bar: "value" });
});

test("buildArgs: works when inputSchema is missing entirely", () => {
  const t = { name: "tool_without_schema" };
  assert.deepEqual(buildArgs(t, { id: "abc", limit: 5 }), { id: "abc", limit: 5 });
});

test("buildArgs: createNote-shaped tool gets meetingId, prompt, instruction routed correctly", () => {
  const t = tool("create_note", "", { meeting_id: {}, prompt: {}, instruction: {}, template_id: {} });
  const args = buildArgs(t, {
    meetingId: "abc",
    prompt: "summarize risks",
    instruction: "be concise",
    templateId: "tmpl-1",
  });
  assert.deepEqual(args, {
    meeting_id: "abc",
    prompt: "summarize risks",
    instruction: "be concise",
    template_id: "tmpl-1",
  });
});
