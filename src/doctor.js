import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { defaultBridgePath, defaultQuillDataDir, supportedPlatform } from "./config.js";
import { McpClient } from "./mcp-client.js";

export const CLI_VERSION = "0.1.0";

const DOWNLOAD_URL = "https://www.quillmeetings.com/download";
const MCP_SETTINGS_HINT = "Open Quill Settings -> MCP / Integrations and enable the MCP server.";

export async function runDoctorChecks(config, options = {}) {
  const checks = [];
  const platform = platformName();
  const supported = supportedPlatform();
  const quillDir = defaultQuillDataDir();
  const defaultBridge = defaultBridgePath();
  const configuredArgs = Array.isArray(config.mcp?.args) ? config.mcp.args : [];
  const configuredBridge = configuredArgs[0];
  const quillDirExists = fs.existsSync(quillDir);
  const defaultBridgeExists = fs.existsSync(defaultBridge);
  const configuredBridgeExists = configuredBridge ? fs.existsSync(configuredBridge) : false;

  checks.push({
    name: "Platform support",
    status: supported ? "PASS" : "FAIL",
    message: supported ? `${platform} is supported.` : `${platform} is not supported yet.`,
    remediation: supported ? undefined : "Use Quill CLI on macOS or Windows.",
  });

  checks.push({
    name: "Quill desktop data",
    status: quillDirExists ? "PASS" : "FAIL",
    message: quillDirExists ? `Found ${quillDir}.` : `Could not find ${quillDir}.`,
    remediation: quillDirExists ? undefined : `Install and launch Quill desktop: ${DOWNLOAD_URL}`,
  });

  checks.push({
    name: "Default MCP bridge",
    status: defaultBridgeExists ? "PASS" : quillDirExists ? "FAIL" : "WARN",
    message: defaultBridgeExists ? `Found ${defaultBridge}.` : `Could not find ${defaultBridge}.`,
    remediation: defaultBridgeExists ? undefined : quillDirExists ? "Update Quill desktop, then run `quill doctor` again." : "Install and launch Quill desktop first.",
  });

  checks.push(configBridgeCheck(configuredBridge, configuredBridgeExists, defaultBridge, defaultBridgeExists));

  const appVersion = findQuillAppVersion();
  checks.push({
    name: "Version info",
    status: appVersion ? "PASS" : "WARN",
    message: appVersion ? `CLI ${CLI_VERSION}, Quill app ${appVersion}.` : `CLI ${CLI_VERSION}, Quill app version not discovered.`,
    remediation: appVersion ? undefined : "If MCP calls fail, update Quill desktop and rerun `quill doctor`.",
  });

  if (supported && configuredBridgeExists) {
    checks.push(await handshakeCheck(config, options.timeoutMs));
  } else {
    checks.push({
      name: "MCP handshake",
      status: "WARN",
      message: "Skipped because the configured bridge is not available.",
      remediation: "Fix the bridge path above, then run `quill doctor` again.",
    });
  }

  const failing = checks.filter((check) => check.status === "FAIL");
  const warnings = checks.filter((check) => check.status === "WARN");
  const firstIssue = failing[0] || warnings[0];
  return {
    title: "Quill doctor",
    platform: process.platform,
    quill_dir: quillDir,
    default_bridge: defaultBridge,
    configured_bridge: configuredBridge,
    versions: {
      cli: CLI_VERSION,
      quill_app: appVersion || null,
    },
    checks,
    issue_count: failing.length + warnings.length,
    all_good: failing.length === 0 && warnings.length === 0,
    start_with: firstIssue?.remediation || "Run `quill browse`.",
  };
}

function configBridgeCheck(configuredBridge, configuredBridgeExists, defaultBridge, defaultBridgeExists) {
  if (!configuredBridge) {
    return {
      name: "CLI bridge config",
      status: "FAIL",
      message: "Config has no mcp.args bridge path.",
      remediation: resetBridgeCommand(defaultBridge),
    };
  }

  if (configuredBridge === defaultBridge) {
    return {
      name: "CLI bridge config",
      status: configuredBridgeExists ? "PASS" : "FAIL",
      message: configuredBridgeExists ? "Config points at the platform default bridge." : "Config points at the platform default bridge, but the file is missing.",
      remediation: configuredBridgeExists ? undefined : "Install or update Quill desktop.",
    };
  }

  if (configuredBridgeExists) {
    return {
      name: "CLI bridge config",
      status: "WARN",
      message: `Config points at a custom bridge: ${configuredBridge}.`,
      remediation: defaultBridgeExists ? resetBridgeCommand(defaultBridge) : "Keep this only if you intentionally use a custom Quill bridge.",
    };
  }

  return {
    name: "CLI bridge config",
    status: "FAIL",
    message: `Configured bridge is missing: ${configuredBridge}.`,
    remediation: defaultBridgeExists ? resetBridgeCommand(defaultBridge) : "Install or update Quill desktop, or set mcp.args to the correct bridge path.",
  };
}

async function handshakeCheck(config, timeoutMs = 3000) {
  const client = new McpClient({
    ...config.mcp,
    timeout_ms: timeoutMs,
  });

  try {
    await client.connect();
    const tools = await client.listTools();
    if (tools.length === 0) {
      return {
        name: "MCP handshake",
        status: "WARN",
        message: "Connected to the bridge, but no MCP tools were listed.",
        remediation: MCP_SETTINGS_HINT,
      };
    }
    return {
      name: "MCP handshake",
      status: "PASS",
      message: `Connected and found ${tools.length} MCP tools.`,
    };
  } catch (error) {
    return {
      name: "MCP handshake",
      status: "FAIL",
      message: error?.code === "mcp_timeout" ? "Timed out waiting for the Quill MCP bridge." : error?.message || String(error),
      remediation: error?.code === "mcp_timeout" ? MCP_SETTINGS_HINT : "Run `quill doctor --json` for details, then update Quill or reset the bridge path.",
    };
  } finally {
    await client.close();
  }
}

function findQuillAppVersion() {
  if (process.platform === "darwin") {
    const candidates = [
      "/Applications/Quill.app/Contents/Info.plist",
      path.join(os.homedir(), "Applications", "Quill.app", "Contents", "Info.plist"),
    ];
    for (const candidate of candidates) {
      const version = readMacPlistVersion(candidate);
      if (version) return version;
    }
  }
  return null;
}

function readMacPlistVersion(file) {
  if (!fs.existsSync(file)) return null;
  const text = fs.readFileSync(file, "utf8");
  return plistStringAfterKey(text, "CFBundleShortVersionString") || plistStringAfterKey(text, "CFBundleVersion");
}

function plistStringAfterKey(text, key) {
  const match = text.match(new RegExp(`<key>${key}<\\/key>\\s*<string>([^<]+)<\\/string>`));
  return match?.[1] || null;
}

function resetBridgeCommand(defaultBridge) {
  return `Run \`quill config set mcp.args '${JSON.stringify([defaultBridge])}'\`.`;
}

function platformName() {
  if (process.platform === "darwin") return "macOS";
  if (process.platform === "win32") return "Windows";
  if (process.platform === "linux") return "Linux";
  return process.platform;
}
