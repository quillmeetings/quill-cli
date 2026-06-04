import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

// Single source of truth for the CLI version: read it from package.json at
// runtime so `--version`, `quill doctor`, and the MCP handshake never drift
// from the published package after `npm version`.
const packageJsonPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "package.json");

function readVersion() {
  try {
    return JSON.parse(readFileSync(packageJsonPath, "utf8")).version || "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export const CLI_VERSION = readVersion();
