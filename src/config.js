import os from "node:os";
import path from "node:path";

const DEFAULT_BRIDGE = "/Users/dawa/Library/Application Support/Quill/mcp-stdio-bridge.js";

export function defaultConfig() {
  return {
    mcp: {
      command: process.env.QUILL_MCP_COMMAND || "node",
      args: process.env.QUILL_MCP_ARGS
        ? splitArgs(process.env.QUILL_MCP_ARGS)
        : [process.env.QUILL_MCP_BRIDGE || DEFAULT_BRIDGE],
      framing: process.env.QUILL_MCP_FRAMING || "newline",
    },
    output: {
      format: process.env.QUILL_OUTPUT || "toon",
      limit: Number.parseInt(process.env.QUILL_LIMIT || "20", 10),
    },
  };
}

export function configPath() {
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(base, "quill-cli", "config.json");
}

function splitArgs(value) {
  return value.match(/(?:[^\s"]+|"[^"]*")+/g)?.map((part) => part.replace(/^"|"$/g, "")) || [];
}
