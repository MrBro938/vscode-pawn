const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  appendCrashLog,
  createRuntimeSnapshot,
  writeRuntimeSnapshot,
} = require("../out/crashDiagnostics");

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pawn-crash-log-"));
const logPath = path.join(directory, "crash.log");
const snapshotPath = path.join(directory, "runtime-state.json");

try {
  const error = new Error("diagnostic test failure");
  appendCrashLog(logPath, "Test", error, "extra diagnostic details");

  const log = fs.readFileSync(logPath, "utf8");
  assert.ok(log.includes("[Test]"), "log should include the source label");
  assert.ok(log.includes("diagnostic test failure"), "log should include the error message");
  assert.ok(log.includes(error.stack), "log should include the complete stack trace");
  assert.ok(log.includes("extra diagnostic details"), "log should include additional details");

  const firstSnapshot = createRuntimeSnapshot("Test Process", {
    lastActivity: "testing diagnostics",
  });
  assert.strictEqual(firstSnapshot.source, "Test Process");
  assert.strictEqual(firstSnapshot.process.pid, process.pid);
  assert.ok(firstSnapshot.memoryBytes.rss > 0);
  assert.ok(firstSnapshot.systemMemoryBytes.total > 0);

  writeRuntimeSnapshot(snapshotPath, firstSnapshot);
  const savedFirst = JSON.parse(fs.readFileSync(snapshotPath, "utf8"));
  assert.strictEqual(savedFirst.details.lastActivity, "testing diagnostics");

  const secondSnapshot = createRuntimeSnapshot("Test Process", {
    lastActivity: "checkpoint overwritten successfully",
  });
  writeRuntimeSnapshot(snapshotPath, secondSnapshot);
  const savedSecond = JSON.parse(fs.readFileSync(snapshotPath, "utf8"));
  assert.strictEqual(
    savedSecond.details.lastActivity,
    "checkpoint overwritten successfully",
    "runtime snapshots should be atomically replaceable"
  );

  appendCrashLog(undefined, "Test", "ignored");
  writeRuntimeSnapshot(undefined, firstSnapshot);
  console.log("Crash diagnostics tests passed.");
} finally {
  fs.rmSync(directory, { recursive: true, force: true });
}
