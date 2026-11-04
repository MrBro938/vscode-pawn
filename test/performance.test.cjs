const assert = require("node:assert/strict");
const {
  PerformanceMonitor,
  formatPerformanceSnapshot
} = require("../out/performance.js");

const monitor = new PerformanceMonitor();
monitor.count("ignored");
monitor.record("ignored", 10);
assert.equal(Object.keys(monitor.snapshot().counters).length, 0);
assert.equal(Object.keys(monitor.snapshot().timings).length, 0);

monitor.setEnabled(true);
monitor.count("files", 3);
monitor.record("parse", 2);
monitor.record("parse", 4);
monitor.record("parse", 6);

const snapshot = monitor.snapshot();
assert.equal(snapshot.enabled, true);
assert.equal(snapshot.counters.files, 3);
assert.equal(snapshot.timings.parse.count, 3);
assert.equal(snapshot.timings.parse.totalMs, 12);
assert.equal(snapshot.timings.parse.averageMs, 4);
assert.equal(snapshot.timings.parse.maxMs, 6);
assert.equal(snapshot.timings.parse.p95Ms, 6);
assert.match(formatPerformanceSnapshot("Test", snapshot), /parse/);

monitor.reset();
assert.equal(Object.keys(monitor.snapshot().counters).length, 0);
assert.equal(Object.keys(monitor.snapshot().timings).length, 0);

const percentileMonitor = new PerformanceMonitor();
percentileMonitor.setEnabled(true);
// More than the previous 256-sample window: older observations must remain
// part of the percentile even after the most recent values become very small.
for (let index = 0; index < 744; index++) {
  percentileMonitor.record("distribution", 100);
}
for (let index = 0; index < 256; index++) {
  percentileMonitor.record("distribution", 1);
}
const distribution = percentileMonitor.snapshot().timings.distribution;
assert.equal(distribution.count, 1000);
assert.ok(
  distribution.p95Ms > 90,
  `P95 should include older observations, got ${distribution.p95Ms}`
);

percentileMonitor.recordFileAnalysis("/workspace/gamemodes/slow.pwn", 4096, 1000, 100, 2800);
percentileMonitor.recordFileAnalysis("/workspace/gamemodes/fast.inc", 2048, 400, 50, 12);
const slowFiles = percentileMonitor.snapshot().slowFiles;
assert.equal(slowFiles[0].name, "slow.pwn");
assert.equal(slowFiles[0].tokens, 1000);
assert.match(formatPerformanceSnapshot("Test", percentileMonitor.snapshot()), /slow\\.pwn/);

percentileMonitor.reset();
assert.equal(percentileMonitor.snapshot().slowFiles.length, 0);

console.log("Performance monitor tests passed.");
