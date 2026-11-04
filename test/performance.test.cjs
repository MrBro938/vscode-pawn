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

console.log("Performance monitor tests passed.");
