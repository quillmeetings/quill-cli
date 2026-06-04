import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DOWNLOAD_URL, defaultBridgePath, defaultQuillDataDir, supportedPlatform } from "./config.js";
import { McpClient } from "./mcp-client.js";
import { CLI_VERSION } from "./version.js";

export { CLI_VERSION };
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
    remediation: defaultBridgeExists ? undefined : quillDirExists ? "Update Quill desktop, then run `quill doctor` again." : `Install and launch Quill desktop first: ${DOWNLOAD_URL}`,
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
      remediation: configuredBridgeExists ? undefined : `Install or update Quill desktop: ${DOWNLOAD_URL}`,
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
    remediation: defaultBridgeExists ? resetBridgeCommand(defaultBridge) : `Install or update Quill desktop (${DOWNLOAD_URL}), or set mcp.args to the correct bridge path.`,
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
    const { message, remediation } = describeHandshakeError(error);
    return {
      name: "MCP handshake",
      status: "FAIL",
      message,
      remediation,
    };
  } finally {
    await client.close();
  }
}

function describeHandshakeError(error) {
  switch (error?.code) {
    case "mcp_timeout":
      return { message: "Timed out waiting for the Quill MCP bridge.", remediation: MCP_SETTINGS_HINT };
    case "mcp_server_exited":
      return {
        message: "The Quill MCP bridge started but exited before completing the handshake.",
        remediation: "Restart Quill desktop and make sure the MCP server is enabled, then run `quill doctor` again.",
      };
    case "mcp_buffer_limit_exceeded":
      return {
        message: "The Quill MCP bridge sent more data than the CLI buffer allows.",
        remediation: "Increase the limit with `quill config set mcp.max_buffer_bytes 20971520`, then run `quill doctor` again.",
      };
    case "mcp_parse_error":
      return {
        message: "The Quill MCP bridge returned output the CLI could not parse.",
        remediation: "Update Quill desktop to the latest version, then run `quill doctor` again.",
      };
    case "mcp_bridge_not_found":
      return {
        message: "The Quill MCP bridge file was not found.",
        remediation: `Install or update Quill desktop: ${DOWNLOAD_URL}`,
      };
    default:
      return {
        message: error?.message || String(error),
        remediation: "Run `quill doctor --json` for details, then update Quill or reset the bridge path.",
      };
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
