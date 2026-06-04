import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";
import { DOWNLOAD_URL } from "./config.js";
import { CLI_VERSION } from "./version.js";

const DEFAULT_MAX_BUFFER_BYTES = 10 * 1024 * 1024;

// Tools that generate content can take much longer than a read, so they use
// mcp.mutation_timeout_ms. Keyed on every name `findTool` may resolve to (not
// just "create_note") so the long timeout is not silently lost on a server
// that names the tool differently.
const MUTATION_TOOL_NAMES = new Set(["create_note", "note_create", "create_meeting_note"]);

export class McpClient {
  constructor(config) {
    this.config = config;
    this.maxBufferBytes = Number.parseInt(config.max_buffer_bytes || String(DEFAULT_MAX_BUFFER_BYTES), 10);
    this.nextId = 1;
    this.pending = new Map();
    this.buffer = Buffer.alloc(0);
    this.textBuffer = "";
    this.decoder = new StringDecoder("utf8");
    this.child = null;
  }

  async connect() {
    if (this.config.command === "node" && this.config.args?.[0] && !existsSync(this.config.args[0])) {
      throw bridgeNotFoundError(this.config);
    }

    try {
      this.child = spawn(this.config.command, this.config.args, {
        stdio: ["pipe", "pipe", "pipe"],
        env: mcpEnvironment(),
      });
    } catch (error) {
      throw normalizeSpawnError(error, this.config);
    }

    this.child.stdout.on("data", (chunk) => this.#onData(chunk));
    this.child.stderr.on("data", (chunk) => {
      if (process.env.QUILL_DEBUG) process.stderr.write(chunk);
    });
    // Writing to a dead bridge emits an 'error' on stdin; without a listener
    // Node throws it as an uncaught exception and crashes the CLI. The pending
    // requests are already rejected via the 'exit'/'error' handlers below.
    this.child.stdin.on("error", () => {});
    this.child.on("exit", (code, signal) => {
      const error = new Error(`Quill MCP server exited with ${signal || code}`);
      error.code = "mcp_server_exited";
      for (const { reject, timeout } of this.pending.values()) {
        clearTimeout(timeout);
        reject(error);
      }
      this.pending.clear();
    });
    this.child.on("error", (error) => {
      const normalized = normalizeSpawnError(error, this.config);
      for (const { reject, timeout } of this.pending.values()) {
        clearTimeout(timeout);
        reject(normalized);
      }
      this.pending.clear();
    });

    await this.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: {
        name: "quill-cli",
        version: CLI_VERSION,
      },
    });
    this.notify("notifications/initialized", {});
  }

  async close() {
    if (!this.child) return;
    this.child.stdin.end();
    this.child.kill();
  }

  async listTools() {
    const result = await this.request("tools/list", {});
    return result.tools || [];
  }

  async callTool(name, args = {}, options = {}) {
    const isMutation = options.mutation || MUTATION_TOOL_NAMES.has(name);
    const timeoutMs = isMutation
      ? Number.parseInt(this.config.mutation_timeout_ms || "120000", 10)
      : undefined;
    return this.request("tools/call", { name, arguments: args }, { timeoutMs });
  }

  request(method, params, options = {}) {
    const id = this.nextId++;
    const message = { jsonrpc: "2.0", id, method, params };
    const promise = new Promise((resolve, reject) => {
      const timeoutMs = options.timeoutMs || Number.parseInt(this.config.timeout_ms || "15000", 10);
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        const error = new Error(`Timed out waiting for MCP response to ${method}`);
        error.code = "mcp_timeout";
        reject(error);
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timeout });
    });
    this.#send(message);
    return promise;
  }

  notify(method, params) {
    this.#send({ jsonrpc: "2.0", method, params });
  }

  #send(message) {
    const body = JSON.stringify(message);
    if (this.config.framing === "newline") {
      this.child.stdin.write(`${body}\n`);
      return;
    }
    this.child.stdin.write(`Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`);
  }

  #onData(chunk) {
    if (this.config.framing === "newline") {
      this.#onLineData(chunk);
      return;
    }

    this.buffer = Buffer.concat([this.buffer, chunk]);
    if (this.#failIfBufferLimitExceeded(this.buffer.length)) return;
    while (true) {
      const headerEnd = this.buffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) return;

      const header = this.buffer.slice(0, headerEnd).toString("utf8");
      const match = header.match(/Content-Length:\s*(\d+)/i);
      if (!match) {
        this.buffer = this.buffer.slice(headerEnd + 4);
        continue;
      }

      const length = Number.parseInt(match[1], 10);
      const bodyStart = headerEnd + 4;
      const bodyEnd = bodyStart + length;
      if (this.buffer.length < bodyEnd) return;

      const body = this.buffer.slice(bodyStart, bodyEnd).toString("utf8");
      this.buffer = this.buffer.slice(bodyEnd);
      // A bad body means the byte stream is desynced; we cannot trust the
      // remaining buffer, so fail loudly instead of throwing uncaught.
      let message;
      try {
        message = JSON.parse(body);
      } catch {
        this.#failAllPending(parseError());
        this.close();
        return;
      }
      this.#handleMessage(message);
    }
  }

  #onLineData(chunk) {
    // StringDecoder holds incomplete multibyte UTF-8 sequences across chunk
    // boundaries so emoji/CJK/accented characters are never corrupted.
    this.textBuffer += this.decoder.write(chunk);
    if (this.#failIfBufferLimitExceeded(Buffer.byteLength(this.textBuffer, "utf8"))) return;
    while (true) {
      const lineEnd = this.textBuffer.indexOf("\n");
      if (lineEnd === -1) return;
      const line = this.textBuffer.slice(0, lineEnd).trim();
      this.textBuffer = this.textBuffer.slice(lineEnd + 1);
      if (!line) continue;
      // Bridges may emit non-JSON lines (logs, warnings) on stdout; skip them
      // rather than crashing the process on an uncaught parse error.
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      this.#handleMessage(message);
    }
  }

  #failIfBufferLimitExceeded(size) {
    if (size <= this.maxBufferBytes) return false;
    const error = new Error(`MCP response buffer exceeded ${this.maxBufferBytes} bytes`);
    error.code = "mcp_buffer_limit_exceeded";
    this.#failAllPending(error);
    this.close();
    return true;
  }

  #failAllPending(error) {
    for (const { reject, timeout } of this.pending.values()) {
      clearTimeout(timeout);
      reject(error);
    }
    this.pending.clear();
  }

  #handleMessage(message) {
    if (!Object.hasOwn(message, "id")) return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    clearTimeout(pending.timeout);
    if (message.error) {
      const error = new Error(message.error.message || "MCP request failed");
      error.code = message.error.code || "mcp_error";
      error.details = message.error.data;
      pending.reject(error);
    } else {
      pending.resolve(message.result);
    }
  }
}

function normalizeSpawnError(error, config) {
  if (error?.code === "ENOENT") {
    return bridgeNotFoundError(config);
  }
  return error;
}

function parseError() {
  const error = new Error("Received malformed (non-JSON) data from the Quill MCP bridge.");
  error.code = "mcp_parse_error";
  return error;
}

function bridgeNotFoundError(config) {
  const bridgePath = config.args?.[0];
  const error = new Error(
    `Quill MCP bridge not found${bridgePath ? ` at ${bridgePath}` : ""}. ` +
    "Install Quill desktop and enable the MCP server (Settings -> MCP / Integrations), " +
    `then run \`quill doctor\`. Get Quill: ${DOWNLOAD_URL}`
  );
  error.code = "mcp_bridge_not_found";
  error.exitCode = 1;
  error.details = {
    command: config.command,
    args: config.args,
    download_url: DOWNLOAD_URL,
  };
  return error;
}

function mcpEnvironment() {
  const env = { ...process.env };
  delete env.QUILL_CONFIG;
  delete env.QUILL_AGENT_MODE;
  return env;
}

export function extractToolResult(result) {
  if (!result?.content) return result;
  const textParts = result.content
    .filter((item) => item.type === "text" && typeof item.text === "string")
    .map((item) => item.text);
  if (textParts.length === 0) return result;

  const text = textParts.join("\n");
  // MCP signals tool-execution failures with isError; surface them as the
  // stable { error: { code, message } } envelope so agents (and shell
  // fail-fast) can detect failure instead of treating it as success.
  if (result.isError) return toErrorResult(text);
  try {
    return JSON.parse(text);
  } catch {
    return parseQuillToolResponse(text);
  }
}

function toErrorResult(text) {
  const stripped = String(text).replace(/^Error:\s*/i, "").trim();
  let payload = null;
  try {
    payload = JSON.parse(stripped);
  } catch {
    payload = null;
  }
  if (payload && typeof payload === "object") {
    return {
      error: {
        code: payload.code || "tool_error",
        message: payload.message || stripped,
        ...(payload.details ?? payload.data ? { details: payload.details ?? payload.data } : {}),
      },
    };
  }
  return { error: { code: "tool_error", message: stripped || "The Quill MCP tool returned an error." } };
}

// True when extractToolResult produced a normalized error envelope.
export function isErrorResult(result) {
  return Boolean(result && typeof result === "object" && result.error && typeof result.error === "object");
}

function parseQuillToolResponse(text) {
  if (!text.includes("<ToolResponse>")) return { text };

  const inner = text
    .replace(/^<ToolResponse>\s*/s, "")
    .replace(/\s*<\/ToolResponse>$/s, "")
    .trim();

  const meetings = parseMeetings(inner);
  if (meetings.length > 0) {
    const result = { count: meetings.length, meetings };
    const query = inner.match(/<results[^>]*query="([^"]*)"/)?.[1];
    if (query) result.query = decodeXml(query);
    return result;
  }

  for (const spec of [
    { container: "contacts", item: "contact", key: "contacts" },
    { container: "events", item: "event", key: "events" },
    { container: "templates", item: "template", key: "templates", childFields: ["description"] },
    { container: "threads", item: "thread", key: "threads" },
    { container: "notes", item: "note", key: "notes" },
  ]) {
    const parsed = parseElementList(inner, spec);
    if (parsed) return parsed;
  }

  const message = inner.replace(/<[^>]+>/g, "").trim();
  return message ? { message } : { text: inner };
}

function parseMeetings(text) {
  const meetings = [];
  const meetingPattern = /<meeting\s+([^>]*?)(?:\/>|>([\s\S]*?)<\/meeting>)/g;
  let match;
  while ((match = meetingPattern.exec(text)) !== null) {
    const attrs = parseAttributes(match[1]);
    const body = match[2] || "";
    meetings.push({
      id: attrs.id,
      title: childText(body, "title") || attrs.title,
      blurb: childText(body, "blurb") || attrs.blurb,
      summary: childText(body, "summary") || attrs.summary,
      date: attrs.date,
      duration: attrs.duration,
      participants: attrs.participants,
      tags: attrs.tags,
      url: attrs.url,
    });
  }
  return meetings;
}

function childText(text, tag) {
  const match = text.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`));
  return match ? decodeXml(match[1].trim()) : undefined;
}

function parseAttributes(text) {
  const attrs = {};
  const attrPattern = /([A-Za-z_:][A-Za-z0-9_:.-]*)="([^"]*)"/g;
  let match;
  while ((match = attrPattern.exec(text)) !== null) {
    attrs[match[1]] = decodeXml(match[2]);
  }
  return attrs;
}

function parseElementList(text, spec) {
  const containerMatch = text.match(new RegExp(`<${spec.container}\\s+([^>]*)>`));
  if (!containerMatch) return null;

  const container = parseAttributes(containerMatch[1]);
  const items = [];
  const itemPattern = new RegExp(`<${spec.item}\\s+([^>]*?)(?:\\/>|>([\\s\\S]*?)<\\/${spec.item}>)`, "g");
  let match;
  while ((match = itemPattern.exec(text)) !== null) {
    const item = parseAttributes(match[1]);
    const body = match[2] || "";
    for (const field of spec.childFields || []) {
      const child = body.match(new RegExp(`<${field}>([\\s\\S]*?)<\\/${field}>`));
      if (child) item[field] = decodeXml(child[1].trim());
    }
    items.push(item);
  }

  return {
    count: Number.parseInt(container.count || String(items.length), 10),
    offset: container.offset ? Number.parseInt(container.offset, 10) : undefined,
    limit: container.limit ? Number.parseInt(container.limit, 10) : undefined,
    [spec.key]: items,
  };
}

function decodeXml(value) {
  return String(value)
    .replaceAll("&quot;", "\"")
    .replaceAll("&apos;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}
