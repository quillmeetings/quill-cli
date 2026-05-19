import { test } from "node:test";
import assert from "node:assert/strict";
import { shapeForOutput, toHuman, toToon, structuredError, withHelp, truncateText } from "../src/format.js";

test("truncateText: short strings pass through", () => {
  assert.equal(truncateText("short", 100), "short");
});

test("truncateText: non-strings pass through", () => {
  assert.equal(truncateText(42, 100), 42);
  assert.equal(truncateText(null, 100), null);
  assert.equal(truncateText(undefined, 100), undefined);
});

test("truncateText: long strings get sliced and annotated", () => {
  const out = truncateText("a".repeat(200), 50);
  assert.ok(out.startsWith("a".repeat(50)));
  assert.ok(out.includes("truncated"));
  assert.ok(out.includes("200 chars total"));
});

test("shapeForOutput: clones input — original not mutated", () => {
  const input = { result: { meetings: [{ id: "a", title: "t", date: "d", duration: "30min", extra: "keep" }] } };
  shapeForOutput(input, {});
  assert.equal(input.result.meetings[0].extra, "keep");
});

test("shapeForOutput: applies default meeting fields and drops extras", () => {
  const input = { result: { meetings: [{ id: "a", title: "t", date: "d", duration: "30min", extra: "drop me" }] } };
  const out = shapeForOutput(input, {});
  assert.deepEqual(out.result.meetings[0], { id: "a", title: "t", date: "d", duration: "30min" });
});

test("shapeForOutput: honors explicit --fields over defaults", () => {
  const input = { result: { meetings: [{ id: "a", title: "t", date: "d", duration: "30min", url: "u" }] } };
  const out = shapeForOutput(input, { fields: ["id", "url"] });
  assert.deepEqual(out.result.meetings[0], { id: "a", url: "u" });
});

test("shapeForOutput: truncates long strings when --full not set", () => {
  const long = "x".repeat(2000);
  const out = shapeForOutput({ result: { text: long } }, { truncate: 100 });
  assert.ok(out.result.text.length < long.length);
  assert.ok(out.result.text.includes("truncated"));
});

test("shapeForOutput: --full preserves long strings", () => {
  const long = "x".repeat(2000);
  const out = shapeForOutput({ result: { text: long } }, { full: true, truncate: 100 });
  assert.equal(out.result.text, long);
});

test("shapeForOutput: truncation walks nested objects without destroying structure", () => {
  const long = "x".repeat(1500);
  const out = shapeForOutput({ result: { deep: { also: { value: long, short: "ok" } } } }, { truncate: 100 });
  assert.ok(out.result.deep.also.value.includes("truncated"));
  assert.equal(out.result.deep.also.short, "ok");
});

test("toHuman: renders meetings table with title and count", () => {
  const data = { result: { meetings: [{ id: "abc", title: "Standup", date: "2026-01-01T10:00:00Z", duration: "30min" }] } };
  const out = toHuman(data);
  assert.ok(out.startsWith("Meetings (1)"));
  assert.ok(out.includes("abc"));
  assert.ok(out.includes("Standup"));
});

test("toHuman: empty list renders (none) body", () => {
  const out = toHuman({ result: { meetings: [] } });
  assert.ok(out.startsWith("Meetings (0)"));
  assert.ok(out.includes("(none)"));
});

test("toHuman: contacts get their own title", () => {
  const out = toHuman({ result: { contacts: [{ id: "c1", name: "Alice", email: "a@x.com" }] } });
  assert.ok(out.startsWith("Contacts (1)"));
});

test("toHuman: appends help lines", () => {
  const out = toHuman({
    result: { meetings: [{ id: "a", title: "t", date: "2026-01-01T10:00:00Z", duration: "30min" }] },
    help: ["Run `quill meetings view <id>`", "Run `quill transcript <id>`"],
  });
  assert.ok(out.endsWith("Run `quill transcript <id>`"));
});

test("toHuman: status screen when bin + description present", () => {
  const out = toHuman({ bin: "quill", description: "Quill CLI" });
  assert.ok(out.includes("quill"));
  assert.ok(out.includes("Quill CLI"));
});

test("toHuman: result.message returns just the message", () => {
  assert.equal(toHuman({ result: { message: "Hello" } }), "Hello");
});

test("toHuman: renders doctor checks and summary", () => {
  const out = toHuman({
    result: {
      title: "Quill doctor",
      checks: [
        { name: "Platform support", status: "PASS", message: "macOS is supported." },
        { name: "MCP handshake", status: "FAIL", message: "Timed out.", remediation: "Enable MCP." },
      ],
      issue_count: 1,
      all_good: false,
      start_with: "Enable MCP.",
    },
  });
  assert.ok(out.includes("PASS Platform support: macOS is supported."));
  assert.ok(out.includes("FAIL MCP handshake: Timed out."));
  assert.ok(out.includes("1 issue - start with: Enable MCP."));
});

test("toHuman: returns null for scalars and nullish", () => {
  assert.equal(toHuman("nothing"), null);
  assert.equal(toHuman(42), null);
  assert.equal(toHuman(null), null);
  assert.equal(toHuman(undefined), null);
});

test("toHuman: returns null when no recognized shape", () => {
  assert.equal(toHuman({ result: { random: "value" } }), null);
});

test("toHuman: respects explicit count over rows.length", () => {
  const out = toHuman({ result: { count: 99, meetings: [{ id: "a", title: "t", date: "2026-01-01T10:00:00Z", duration: "30min" }] } });
  assert.ok(out.startsWith("Meetings (99)"));
});

test("toToon: array of flat objects renders header + comma-joined rows", () => {
  const out = toToon({ meetings: [{ id: "a", title: "x", date: "d", duration: "30min" }] });
  assert.ok(out.includes("meetings[1]{id,title,date,duration}:"));
  assert.ok(out.includes("a,x,d,30min"));
});

test("toToon: empty array renders [0]", () => {
  const out = toToon({ meetings: [] });
  assert.ok(out.includes("meetings[0]:"));
});

test("toToon: values containing commas get JSON-quoted", () => {
  const out = toToon({ items: [{ id: "a", text: "hello, world" }] });
  assert.ok(out.includes('"hello, world"'));
});

test("toToon: newlines in values are escaped as \\n", () => {
  const out = toToon({ items: [{ id: "a", text: "line one\nline two" }] });
  assert.ok(out.includes("line one\\nline two"));
});

test("toToon: null and undefined render as empty cells", () => {
  const out = toToon({ items: [{ id: "a", note: null, foo: undefined }] });
  assert.ok(/a,,/.test(out));
});

test("toToon: nested objects render as indented blocks", () => {
  const out = toToon({ result: { inner: { a: 1, b: 2 } } });
  assert.ok(out.includes("result:"));
  assert.ok(out.includes("inner:"));
  assert.ok(out.includes("a: 1"));
  assert.ok(out.includes("b: 2"));
});

test("toToon: booleans render as 'true' / 'false'", () => {
  const out = toToon({ config: { enabled: true, debug: false } });
  assert.ok(out.includes("enabled: true"));
  assert.ok(out.includes("debug: false"));
});

test("structuredError: produces { error: { code, message } }", () => {
  assert.deepEqual(structuredError("oops", "something failed"), {
    error: { code: "oops", message: "something failed" },
  });
});

test("structuredError: includes details when provided", () => {
  assert.deepEqual(structuredError("oops", "failed", { hint: "try X" }), {
    error: { code: "oops", message: "failed", details: { hint: "try X" } },
  });
});

test("withHelp: appends help array onto data", () => {
  assert.deepEqual(withHelp({ count: 0 }, ["do X", "do Y"]), { count: 0, help: ["do X", "do Y"] });
});
