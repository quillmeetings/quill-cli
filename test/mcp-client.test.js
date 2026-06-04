import { test } from "node:test";
import assert from "node:assert/strict";
import { McpClient, extractToolResult, isErrorResult } from "../src/mcp-client.js";

function toolResult(text) {
  return { content: [{ type: "text", text }] };
}

test("extractToolResult: isError with JSON payload becomes a stable error envelope", () => {
  const out = extractToolResult({
    isError: true,
    content: [{ type: "text", text: 'Error: {"code":"validation_error","message":"id required"}' }],
  });
  assert.deepEqual(out, { error: { code: "validation_error", message: "id required" } });
  assert.equal(isErrorResult(out), true);
});

test("extractToolResult: isError with plain text falls back to tool_error code", () => {
  const out = extractToolResult({ isError: true, content: [{ type: "text", text: "something broke" }] });
  assert.equal(out.error.code, "tool_error");
  assert.equal(out.error.message, "something broke");
  assert.equal(isErrorResult(out), true);
});

test("isErrorResult: false for normal results", () => {
  assert.equal(isErrorResult({ meetings: [] }), false);
  assert.equal(isErrorResult({ error: "not an object" }), false);
  assert.equal(isErrorResult(null), false);
});

test("extractToolResult: passes through when result has no content", () => {
  const input = { foo: "bar" };
  assert.equal(extractToolResult(input), input);
});

test("McpClient.connect: missing node bridge returns doctor hint", async () => {
  const client = new McpClient({
    command: "node",
    args: ["/definitely/missing/quill/mcp-stdio-bridge.js"],
    timeout_ms: 10,
  });
  await assert.rejects(
    () => client.connect(),
    (error) => {
      assert.equal(error.code, "mcp_bridge_not_found");
      assert.match(error.message, /Quill MCP bridge not found/);
      assert.match(error.message, /quill doctor/);
      assert.match(error.message, /quillmeetings\.com\/download/);
      assert.equal(error.details.download_url, "https://www.quillmeetings.com/download");
      return true;
    }
  );
});

test("extractToolResult: passes through when content has no text items", () => {
  const input = { content: [{ type: "image", data: "..." }] };
  assert.equal(extractToolResult(input), input);
});

test("extractToolResult: parses JSON text payloads", () => {
  assert.deepEqual(extractToolResult(toolResult('{"hello":"world"}')), { hello: "world" });
});

test("extractToolResult: joins multi-part text and parses as JSON when valid", () => {
  const out = extractToolResult({
    content: [
      { type: "text", text: '{"a":' },
      { type: "text", text: "1}" },
    ],
  });
  assert.deepEqual(out, { a: 1 });
});

test("extractToolResult: plain text without <ToolResponse> returns { text }", () => {
  assert.deepEqual(extractToolResult(toolResult("just a string")), { text: "just a string" });
});

test("parses a self-closing <meeting/> inside <results> and extracts query", () => {
  const text = '<ToolResponse><results query="standup &amp; sync"><meeting id="abc" title="Morning standup" date="2026-05-15" duration="30min" url="https://app.quill/m/abc" /></results></ToolResponse>';
  const out = extractToolResult(toolResult(text));
  assert.equal(out.count, 1);
  assert.equal(out.query, "standup & sync");
  assert.equal(out.meetings.length, 1);
  assert.equal(out.meetings[0].id, "abc");
  assert.equal(out.meetings[0].title, "Morning standup");
  assert.equal(out.meetings[0].date, "2026-05-15");
  assert.equal(out.meetings[0].duration, "30min");
  assert.equal(out.meetings[0].url, "https://app.quill/m/abc");
});

test("paired <meeting>...</meeting>: child <title>/<blurb>/<summary> take priority over attributes", () => {
  const text = `<ToolResponse>
<meeting id="abc" title="attr title" blurb="attr blurb" date="2026-05-15">
<title>child title</title>
<blurb>short blurb</blurb>
<summary>longer summary</summary>
</meeting>
</ToolResponse>`;
  const out = extractToolResult(toolResult(text));
  assert.equal(out.meetings[0].title, "child title");
  assert.equal(out.meetings[0].blurb, "short blurb");
  assert.equal(out.meetings[0].summary, "longer summary");
});

test("paired <meeting> with no child elements falls back to attribute title/blurb", () => {
  const text = '<ToolResponse><meeting id="abc" title="attr title" blurb="attr blurb" date="2026-05-15"></meeting></ToolResponse>';
  const out = extractToolResult(toolResult(text));
  assert.equal(out.meetings[0].title, "attr title");
  assert.equal(out.meetings[0].blurb, "attr blurb");
  assert.equal(out.meetings[0].summary, undefined);
});

test("decodes XML entities in attributes and child text", () => {
  const text = '<ToolResponse><meeting id="abc" title="Bob &amp; Alice say &quot;hi&quot;"><blurb>1 &lt; 2 &amp;&amp; 3 &gt; 2</blurb></meeting></ToolResponse>';
  const out = extractToolResult(toolResult(text));
  assert.equal(out.meetings[0].title, 'Bob & Alice say "hi"');
  assert.equal(out.meetings[0].blurb, "1 < 2 && 3 > 2");
});

test("parses multiple meetings mixing self-closing and paired forms", () => {
  const text = `<ToolResponse>
<meeting id="a" title="first" />
<meeting id="b" date="2026-01-01"><title>second</title></meeting>
<meeting id="c" title="third" duration="15min" />
</ToolResponse>`;
  const out = extractToolResult(toolResult(text));
  assert.equal(out.count, 3);
  assert.deepEqual(out.meetings.map((m) => m.id), ["a", "b", "c"]);
  assert.equal(out.meetings[0].title, "first");
  assert.equal(out.meetings[1].title, "second");
  assert.equal(out.meetings[1].date, "2026-01-01");
  assert.equal(out.meetings[2].duration, "15min");
});

test("meetings short-circuit before other list parsers", () => {
  const text = '<ToolResponse><meeting id="m1" title="m" /><notes count="1"><note id="n1" /></notes></ToolResponse>';
  const out = extractToolResult(toolResult(text));
  assert.ok(Array.isArray(out.meetings));
  assert.equal(out.meetings.length, 1);
  assert.equal(out.notes, undefined);
});

test("parses contacts with container count/offset/limit attrs", () => {
  const text = `<ToolResponse><contacts count="42" offset="10" limit="5">
<contact id="c1" name="Alice" email="alice@example.com" />
<contact id="c2" name="Bob" email="bob@example.com" />
</contacts></ToolResponse>`;
  const out = extractToolResult(toolResult(text));
  assert.equal(out.count, 42);
  assert.equal(out.offset, 10);
  assert.equal(out.limit, 5);
  assert.equal(out.contacts.length, 2);
  assert.equal(out.contacts[0].name, "Alice");
  assert.equal(out.contacts[1].email, "bob@example.com");
});

test("parses templates and lifts <description> child into the item", () => {
  const text = `<ToolResponse><templates count="1">
<template id="t1" name="Action items" kind="actions">
<description>Generate action items grouped by owner</description>
</template>
</templates></ToolResponse>`;
  const out = extractToolResult(toolResult(text));
  assert.equal(out.templates[0].description, "Generate action items grouped by owner");
  assert.equal(out.templates[0].name, "Action items");
  assert.equal(out.templates[0].kind, "actions");
});

test("parses events, threads, and notes containers", () => {
  const events = extractToolResult(toolResult(
    '<ToolResponse><events count="1"><event id="e1" title="Sync" start="2026-05-15T10:00:00Z" /></events></ToolResponse>'
  ));
  assert.equal(events.events[0].id, "e1");
  assert.equal(events.events[0].start, "2026-05-15T10:00:00Z");

  const threads = extractToolResult(toolResult(
    '<ToolResponse><threads count="1"><thread id="th1" title="Roadmap" /></threads></ToolResponse>'
  ));
  assert.equal(threads.threads[0].id, "th1");

  const notes = extractToolResult(toolResult(
    '<ToolResponse><notes count="1"><note id="n1" title="Recap" /></notes></ToolResponse>'
  ));
  assert.equal(notes.notes[0].id, "n1");
  assert.equal(notes.notes[0].title, "Recap");
});

test("unrecognized <ToolResponse> body with text returns { message }", () => {
  const out = extractToolResult(toolResult("<ToolResponse>Just a status update from the server</ToolResponse>"));
  assert.deepEqual(out, { message: "Just a status update from the server" });
});

test("empty <ToolResponse></ToolResponse> returns { text: '' }", () => {
  const out = extractToolResult(toolResult("<ToolResponse></ToolResponse>"));
  assert.deepEqual(out, { text: "" });
});

test("container with no items still returns the parsed shape with empty array", () => {
  const text = '<ToolResponse><contacts count="0" offset="0" limit="20"></contacts></ToolResponse>';
  const out = extractToolResult(toolResult(text));
  assert.equal(out.count, 0);
  assert.deepEqual(out.contacts, []);
});
