#!/usr/bin/env node
import { runCli } from "../src/cli.js";

runCli(process.argv.slice(2)).catch((error) => {
  const code = Number.isInteger(error?.exitCode) ? error.exitCode : 1;
  const payload = {
    error: {
      code: error?.code || "unexpected_error",
      message: error?.message || String(error),
    },
  };
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  process.exit(code);
});
