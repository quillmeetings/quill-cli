import { spawn } from "node:child_process";

const DEFAULT_MAX_BUFFER_BYTES = 10 * 1024 * 1024;

export class McpClient {
  constructor(config) {
    this.config = config;
    this.maxBufferBytes = Number.parseInt(config.max_buffer_bytes || String(DEFAULT_MAX_BUFFER_BYTES), 10);
    this.nextId = 1;
    this.pending = new Map();
    this.buffer = Buffer.alloc(0);
    this.textBuffer = "";
    this.child = null;
  }

  async connect() {
    this.child = spawn(this.config.command, this.config.args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: mcpEnvironment(),
    });

    this.child.stdout.on("data", (chunk) => this.#onData(chunk));
    this.child.stderr.on("data", (chunk) => {
      if (process.env.QUILL_DEBUG) process.stderr.write(chunk);
    });
    this.child.on("exit", (code, signal) => {
      const error = new Error(`Quill MCP server exited with ${signal || code}`);
      error.code = "mcp_server_exited";
      for (const { reject, timeout } of this.pending.values()) {
        clearTimeout(timeout);
        reject(error);
      }
      this.pending.clear();
    });

    await this.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: {
        name: "quill-cli",
        version: "0.1.0",
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

  async callTool(name, args = {}) {
    const timeoutMs = name === "create_note"
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
      this.#handleMessage(JSON.parse(body));
    }
  }

  #onLineData(chunk) {
    this.textBuffer += chunk.toString("utf8");
    if (this.#failIfBufferLimitExceeded(Buffer.byteLength(this.textBuffer, "utf8"))) return;
    while (true) {
      const lineEnd = this.textBuffer.indexOf("\n");
      if (lineEnd === -1) return;
      const line = this.textBuffer.slice(0, lineEnd).trim();
      this.textBuffer = this.textBuffer.slice(lineEnd + 1);
      if (!line) continue;
      this.#handleMessage(JSON.parse(line));
    }
  }

  #failIfBufferLimitExceeded(size) {
    if (size <= this.maxBufferBytes) return false;
    const error = new Error(`MCP response buffer exceeded ${this.maxBufferBytes} bytes`);
    error.code = "mcp_buffer_limit_exceeded";
    for (const { reject, timeout } of this.pending.values()) {
      clearTimeout(timeout);
      reject(error);
    }
    this.pending.clear();
    this.close();
    return true;
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
  try {
    return JSON.parse(text);
  } catch {
    return parseQuillToolResponse(text);
  }
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
  const meetingPattern = /<meeting\s+([^>]*)>\s*<title>([\s\S]*?)<\/title>\s*<\/meeting>/g;
  let match;
  while ((match = meetingPattern.exec(text)) !== null) {
    const attrs = parseAttributes(match[1]);
    meetings.push({
      id: attrs.id,
      title: decodeXml(match[2].trim()),
      date: attrs.date,
      duration: attrs.duration,
      participants: attrs.participants,
      tags: attrs.tags,
      url: attrs.url,
    });
  }
  return meetings;
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
