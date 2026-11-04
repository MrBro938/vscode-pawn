const assert = require("node:assert/strict");
const {
  isSemanticTokensDependencySnapshotCurrent
} = require("../out/server/semanticTokensCache.js");

const mainAnalysis = { name: "main" };
const includeAnalysis = { name: "include" };
const unrelatedAnalysis = { name: "unrelated" };
const versions = new Map([
  ["main.pwn", 3],
  ["helpers.inc", 7],
  ["unrelated.inc", 1]
]);
const analyses = new Map([
  ["main.pwn", mainAnalysis],
  ["helpers.inc", includeAnalysis],
  ["unrelated.inc", unrelatedAnalysis]
]);
const snapshot = {
  graphGeneration: 12,
  sourceVersions: new Map([
    ["main.pwn", 3],
    ["helpers.inc", 7]
  ]),
  sourceAnalyses: new Map([
    ["main.pwn", mainAnalysis],
    ["helpers.inc", includeAnalysis]
  ])
};
const validate = (value = snapshot, graph = 12) =>
  isSemanticTokensDependencySnapshotCurrent(
    value,
    graph,
    (uri) => versions.get(uri) || 0,
    (uri) => analyses.get(uri)
  );

assert.equal(validate(), true, "unchanged dependencies should keep the context valid");
versions.set("unrelated.inc", 2);
analyses.set("unrelated.inc", { name: "unrelated-v2" });
assert.equal(validate(), true, "unrelated file changes must not invalidate the context");

versions.set("helpers.inc", 8);
assert.equal(validate(), false, "an included source edit must invalidate the context");
versions.set("helpers.inc", 7);
analyses.set("helpers.inc", { name: "reparsed-include" });
assert.equal(validate(), false, "a replaced cached analysis must invalidate the context");
analyses.set("helpers.inc", includeAnalysis);
assert.equal(validate(snapshot, 13), false, "an include graph change must invalidate the context");

console.log("Semantic token dependency cache tests passed.");
