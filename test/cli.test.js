import { test } from "node:test";
import assert from "node:assert/strict";
import {
  addPagination,
  applyTimeFlags,
  buildSearchMeetingsArgs,
  normalizeCommandArgs,
  parseDateCutoff,
  parseFlags,
  parseGlobalOptions,
} from "../src/cli.js";

const DAY_MS = 24 * 60 * 60 * 1000;

function baseConfig() {
  return { output: {}, browse: {}, agent: {} };
}

function localMidnight(offsetDays = 0) {
  const date = new Date();
  date.setHours(0, 0, 0, 0);
  date.setDate(date.getDate() + offsetDays);
  return date.toISOString();
}

test("parseGlobalOptions: defaults to human format with limit 20", () => {
  const options = parseGlobalOptions([], baseConfig());
  assert.equal(options.format, "human");
  assert.equal(options.limit, 20);
  assert.equal(options.agent, false);
  assert.equal(options.human, true);
});

test("parseGlobalOptions: --json implies agent mode", () => {
  const options = parseGlobalOptions(["--json"], baseConfig());
  assert.equal(options.format, "json");
  assert.equal(options.agent, true);
});

test("parseGlobalOptions: --agent switches human format to toon", () => {
  const options = parseGlobalOptions(["--agent"], baseConfig());
  assert.equal(options.agent, true);
  assert.equal(options.format, "toon");
});

test("parseGlobalOptions: --no-agent overrides agent.enabled from config", () => {
  const options = parseGlobalOptions(["--no-agent"], { ...baseConfig(), agent: { enabled: true } });
  assert.equal(options.agent, false);
});

test("parseGlobalOptions: --limit accepts a positive integer and marks it explicit", () => {
  const options = parseGlobalOptions(["--limit", "5"], baseConfig());
  assert.equal(options.limit, 5);
  assert.equal(options.limitExplicit, true);
});

test("parseGlobalOptions: --limit rejects non-positive and non-numeric values", () => {
  assert.throws(() => parseGlobalOptions(["--limit", "0"], baseConfig()), (error) => error.code === "invalid_limit");
  assert.throws(() => parseGlobalOptions(["--limit", "abc"], baseConfig()), (error) => error.code === "invalid_limit");
});

test("parseGlobalOptions: --format rejects unknown formats", () => {
  assert.throws(() => parseGlobalOptions(["--format", "yaml"], baseConfig()), (error) => error.code === "invalid_format");
});

test("parseGlobalOptions: --fields splits and trims a csv list", () => {
  const options = parseGlobalOptions(["--fields", "id, title ,date"], baseConfig());
  assert.deepEqual(options.fields, ["id", "title", "date"]);
});

test("parseGlobalOptions: non-option arguments pass through as command args", () => {
  const options = parseGlobalOptions(["meetings", "list", "--limit", "3", "--search", "roadmap"], baseConfig());
  assert.deepEqual(options.args, ["meetings", "list", "--search", "roadmap"]);
});

test("parseFlags: separates flags from positionals", () => {
  const { flags, positionals } = parseFlags(["roadmap", "--since", "7d", "review"]);
  assert.equal(flags.since, "7d");
  assert.deepEqual(positionals, ["roadmap", "review"]);
});

test("parseFlags: flag with no value becomes boolean true", () => {
  const { flags } = parseFlags(["--today"]);
  assert.equal(flags.today, true);
});

test("parseFlags: flag followed by another flag stays boolean", () => {
  const { flags } = parseFlags(["--today", "--limit", "5"]);
  assert.equal(flags.today, true);
  assert.equal(flags.limit, "5");
});

test("parseFlags: kebab-case flags convert to camelCase keys", () => {
  const { flags } = parseFlags(["--include-meetings", "--meetings-limit", "3"]);
  assert.equal(flags.includeMeetings, true);
  assert.equal(flags.meetingsLimit, "3");
});

test("parseFlags: consumes two-word phrases 'last week' and 'last month'", () => {
  const since = parseFlags(["--since", "last", "week"]);
  assert.equal(since.flags.since, "last week");
  assert.deepEqual(since.positionals, []);

  const until = parseFlags(["--until", "last", "month", "extra"]);
  assert.equal(until.flags.until, "last month");
  assert.deepEqual(until.positionals, ["extra"]);
});

test("parseDateCutoff: relative units map to days, weeks, months, years", () => {
  const tolerance = 5000;
  for (const [input, days] of [["7d", 7], ["2w", 14], ["1m", 30], ["1y", 365]]) {
    const expected = Date.now() - days * DAY_MS;
    const actual = new Date(parseDateCutoff(input)).getTime();
    assert.ok(Math.abs(actual - expected) < tolerance, `${input} should be ~${days} days ago`);
  }
});

test("parseDateCutoff: full ISO datetime passes through unchanged", () => {
  assert.equal(parseDateCutoff("2026-06-01T12:30:00Z"), "2026-06-01T12:30:00Z");
});

test("parseDateCutoff: bare date means local midnight, not UTC", () => {
  const expected = new Date(2026, 5, 10).toISOString();
  assert.equal(parseDateCutoff("2026-06-10"), expected);
});

test("parseDateCutoff: today and yesterday use local day boundaries", () => {
  assert.equal(parseDateCutoff("today"), localMidnight(0));
  assert.equal(parseDateCutoff("yesterday"), localMidnight(-1));
});

test("parseDateCutoff: unrecognized values pass through unchanged", () => {
  assert.equal(parseDateCutoff("not-a-date"), "not-a-date");
});

test("applyTimeFlags: --today spans local midnight to local midnight tomorrow", () => {
  const values = applyTimeFlags({ today: true });
  assert.equal(values.since, localMidnight(0));
  assert.equal(values.until, localMidnight(1));
});

test("applyTimeFlags: --yesterday spans the previous local day", () => {
  const values = applyTimeFlags({ yesterday: true });
  assert.equal(values.since, localMidnight(-1));
  assert.equal(values.until, localMidnight(0));
});

test("normalizeCommandArgs: short aliases expand to curated commands", () => {
  assert.deepEqual(normalizeCommandArgs(["ls", "--limit", "5"]), ["meetings", "list", "--limit", "5"]);
  assert.deepEqual(normalizeCommandArgs(["v", "abc"]), ["meetings", "view", "abc"]);
  assert.deepEqual(normalizeCommandArgs(["n", "abc"]), ["notes", "abc"]);
  assert.deepEqual(normalizeCommandArgs(["t", "abc"]), ["transcript", "abc"]);
});

test("normalizeCommandArgs: a bare UUID becomes meetings view", () => {
  const id = "36dc7a64-2ae3-4f86-9d3c-6a1b2c3d4e5f";
  assert.deepEqual(normalizeCommandArgs([id]), ["meetings", "view", id]);
});

test("normalizeCommandArgs: non-UUID commands pass through unchanged", () => {
  assert.deepEqual(normalizeCommandArgs(["search", "roadmap"]), ["search", "roadmap"]);
});

test("addPagination: full page yields next_offset of offset + limit", () => {
  const result = { meetings: [{ id: "a" }, { id: "b" }] };
  addPagination(result, { limit: "2", offset: "4" }, 2);
  assert.equal(result.next_offset, 6);
});

test("addPagination: partial page yields no next_offset", () => {
  const result = { meetings: [{ id: "a" }] };
  addPagination(result, { limit: "2" }, 2);
  assert.equal(result.next_offset, undefined);
});

test("addPagination: uses the limit actually sent, not the raw user limit", () => {
  // search_meetings caps limit at 30; a full capped page should still paginate.
  const result = { meetings: Array.from({ length: 30 }, (_, index) => ({ id: String(index) })) };
  addPagination(result, { limit: "50" }, 30);
  assert.equal(result.next_offset, 30);
});

test("buildSearchMeetingsArgs: caps limit at 30", () => {
  const args = buildSearchMeetingsArgs({ query: "roadmap", limit: "100" });
  assert.equal(args.limit, 30);
});

test("buildSearchMeetingsArgs: forwards a positive offset", () => {
  const args = buildSearchMeetingsArgs({ query: "roadmap", limit: "10", offset: "10" });
  assert.equal(args.offset, 10);
});

test("buildSearchMeetingsArgs: drops missing or non-positive offsets", () => {
  assert.equal(buildSearchMeetingsArgs({ query: "x" }).offset, undefined);
  assert.equal(buildSearchMeetingsArgs({ query: "x", offset: "0" }).offset, undefined);
  assert.equal(buildSearchMeetingsArgs({ query: "x", offset: "abc" }).offset, undefined);
});

test("buildSearchMeetingsArgs: since maps to filter.after with strong freshness", () => {
  const args = buildSearchMeetingsArgs({ query: "roadmap", since: "2026-06-01T00:00:00Z" });
  assert.equal(args.filter.after, "2026-06-01T00:00:00Z");
  assert.equal(args.ranking.freshness, "strong");
});
