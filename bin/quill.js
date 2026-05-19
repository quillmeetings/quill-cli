#!/usr/bin/env node
const major = Number.parseInt(process.versions.node.split(".")[0], 10);
if (major < 20) {
  process.stderr.write(`Quill CLI needs Node 20+. You have ${process.versions.node}.\n`);
  process.exit(1);
}

const { runCli } = await import("../src/cli.js");

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
