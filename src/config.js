import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Where to send users who don't have Quill desktop / the MCP bridge yet.
// Defined here (no internal imports) so every layer can surface it without
// risking a circular import.
export const DOWNLOAD_URL = "https://www.quillmeetings.com/download";

export function defaultConfig() {
  return {
    mcp: {
      command: "node",
      args: [defaultBridgePath()],
      framing: "newline",
      timeout_ms: 15000,
      mutation_timeout_ms: 120000,
      max_buffer_bytes: 10 * 1024 * 1024,
    },
    output: {
      format: "human",
      limit: 20,
      truncate: 1200,
    },
    browse: {
      limit: 20,
      panel_truncate: 5000,
    },
    agent: {
      enabled: false,
    },
  };
}

export function defaultBridgePath() {
  const home = os.homedir();
  if (process.platform === "darwin") {
    return path.join(home, "Library", "Application Support", "Quill", "mcp-stdio-bridge.js");
  }
  if (process.platform === "win32") {
    const appData = process.env.APPDATA || path.join(home, "AppData", "Roaming");
    return path.join(appData, "Quill", "mcp-stdio-bridge.js");
  }
  const xdgDataHome = process.env.XDG_DATA_HOME || path.join(home, ".local", "share");
  return path.join(xdgDataHome, "Quill", "mcp-stdio-bridge.js");
}

export function defaultQuillDataDir() {
  const home = os.homedir();
  if (process.platform === "darwin") return path.join(home, "Library", "Application Support", "Quill");
  if (process.platform === "win32") {
    const appData = process.env.APPDATA || path.join(home, "AppData", "Roaming");
    return path.join(appData, "Quill");
  }
  const xdgDataHome = process.env.XDG_DATA_HOME || path.join(home, ".local", "share");
  return path.join(xdgDataHome, "Quill");
}

export function supportedPlatform() {
  return process.platform === "darwin" || process.platform === "win32";
}

export function loadConfig() {
  return mergeConfig(defaultConfig(), readUserConfig());
}

export function configPath() {
  if (process.env.QUILL_CONFIG) return path.resolve(process.env.QUILL_CONFIG);
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(base, "quill-cli", "config.json");
}

export function ensureConfigFile() {
  const target = configPath();
  if (fs.existsSync(target)) return { path: target, created: false };
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${JSON.stringify(defaultConfig(), null, 2)}\n`);
  return { path: target, created: true };
}

export function readUserConfig() {
  const target = configPath();
  if (!fs.existsSync(target)) return {};
  try {
    return JSON.parse(fs.readFileSync(target, "utf8"));
  } catch (error) {
    error.code = "config_parse_error";
    error.message = `Failed to parse config ${target}: ${error.message}`;
    throw error;
  }
}

export function writeUserConfig(config) {
  const target = configPath();
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${JSON.stringify(config, null, 2)}\n`);
}

export function getConfigValue(config, key) {
  return key.split(".").reduce((value, part) => value?.[part], config);
}

export function setConfigValue(config, key, rawValue) {
  const parts = key.split(".");
  let cursor = config;
  for (const part of parts.slice(0, -1)) {
    if (!cursor[part] || typeof cursor[part] !== "object" || Array.isArray(cursor[part])) cursor[part] = {};
    cursor = cursor[part];
  }
  cursor[parts.at(-1)] = parseConfigValue(rawValue);
  return config;
}

function parseConfigValue(value) {
  if (value === "true") return true;
  if (value === "false") return false;
  if (value === "null") return null;
  if (/^-?\d+$/.test(value)) return Number.parseInt(value, 10);
  if (/^-?\d+\.\d+$/.test(value)) return Number.parseFloat(value);
  if ((value.startsWith("[") && value.endsWith("]")) || (value.startsWith("{") && value.endsWith("}"))) {
    return JSON.parse(value);
  }
  return value;
}

function mergeConfig(base, override) {
  const result = { ...base };
  for (const [key, value] of Object.entries(override || {})) {
    if (isPlainObject(value) && isPlainObject(base[key])) result[key] = mergeConfig(base[key], value);
    else result[key] = value;
  }
  return result;
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
