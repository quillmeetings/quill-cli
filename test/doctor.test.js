import { test } from "node:test";
import assert from "node:assert/strict";
import { runDoctorChecks } from "../src/doctor.js";

test("runDoctorChecks: returns structured checks and skips handshake when bridge is missing", async () => {
  const result = await runDoctorChecks({
    mcp: {
      command: "node",
      args: ["/definitely/missing/quill/mcp-stdio-bridge.js"],
      timeout_ms: 10,
    },
  });

  assert.equal(result.title, "Quill doctor");
  assert.ok(Array.isArray(result.checks));
  assert.ok(result.checks.some((check) => check.name === "MCP handshake" && check.status === "WARN"));
  assert.equal(result.all_good, false);
  assert.ok(result.issue_count > 0);
  assert.ok(result.versions.cli);
});
