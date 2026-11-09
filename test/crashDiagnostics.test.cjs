const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { appendCrashLog } = require("../out/crashDiagnostics");

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pawn-crash-log-"));
const logPath = path.join(directory, "crash.log");

try {
  const error = new Error("diagnostic test failure");
  appendCrashLog(logPath, "Test", error, "extra diagnostic details");

  const log = fs.readFileSync(logPath, "utf8");
  assert.ok(log.includes("[Test]"), "log should include the source label");
  assert.ok(log.includes("diagnostic test failure"), "log should include the error message");
  assert.ok(log.includes(error.stack), "log should include the complete stack trace");
  assert.ok(log.includes("extra diagnostic details"), "log should include additional details");

  appendCrashLog(undefined, "Test", "ignored");
  console.log("Crash diagnostics tests passed.");
} finally {
  fs.rmSync(directory, { recursive: true, force: true });
}
