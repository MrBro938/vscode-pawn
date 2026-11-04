const assert = require("node:assert/strict");
const {
  createSemanticTokensProjectDependencySnapshot,
  getSemanticTokensDependencyInvalidationReason,
  resolveSemanticTokenSymbolKind,
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
assert.equal(
  getSemanticTokensDependencyInvalidationReason(
    snapshot, 12,
    (uri) => versions.get(uri) || 0,
    (uri) => analyses.get(uri)
  ),
  undefined,
  "valid snapshots should not report an invalidation reason"
);
versions.set("unrelated.inc", 2);
analyses.set("unrelated.inc", { name: "unrelated-v2" });
assert.equal(validate(), true, "unrelated file changes must not invalidate the context");

versions.set("helpers.inc", 8);
assert.equal(validate(), false, "an included source edit must invalidate the context");
assert.equal(
  getSemanticTokensDependencyInvalidationReason(
    snapshot, 12,
    (uri) => versions.get(uri) || 0,
    (uri) => analyses.get(uri)
  ),
  "sourceVersionChanged",
  "included source edits should report the source version reason"
);
versions.set("helpers.inc", 7);
analyses.set("helpers.inc", { name: "reparsed-include" });
assert.equal(validate(), false, "a replaced cached analysis must invalidate the context");
assert.equal(
  getSemanticTokensDependencyInvalidationReason(
    snapshot, 12,
    (uri) => versions.get(uri) || 0,
    (uri) => analyses.get(uri)
  ),
  "analysisChanged",
  "replaced analyses should report the analysis reason"
);
analyses.set("helpers.inc", includeAnalysis);
assert.equal(validate(snapshot, 13), false, "an include graph change must invalidate the context");
assert.equal(
  getSemanticTokensDependencyInvalidationReason(
    snapshot, 13,
    (uri) => versions.get(uri) || 0,
    (uri) => analyses.get(uri)
  ),
  "graphChanged",
  "include graph changes should report the graph version reason"
);

console.log("Semantic token dependency cache tests passed.");


const projectSnapshot = createSemanticTokensProjectDependencySnapshot(
  "main.pwn",
  12,
  ["main.pwn", "helpers.inc"],
  (uri) => versions.get(uri) || 0,
  (uri) => analyses.get(uri)
);
assert.deepEqual(
  Array.from(projectSnapshot.sourceVersions.keys()),
  ["helpers.inc"],
  "the active document must not be part of the reusable project symbol snapshot"
);
versions.set("main.pwn", 4);
analyses.set("main.pwn", { name: "main-v2" });
assert.equal(
  getSemanticTokensDependencyInvalidationReason(
    projectSnapshot,
    12,
    (uri) => versions.get(uri) || 0,
    (uri) => analyses.get(uri)
  ),
  undefined,
  "editing the active document must not invalidate its included-project symbol index"
);


assert.equal(
  resolveSemanticTokenSymbolKind("function", "global"),
  "function",
  "included function declarations retain their overriding priority"
);
assert.equal(
  resolveSemanticTokenSymbolKind("global", "enum"),
  "enum",
  "the active document keeps priority over non-overriding included symbols"
);
assert.equal(
  resolveSemanticTokenSymbolKind(undefined, "macro"),
  "macro",
  "the active document's own symbols remain visible in semantic highlighting"
);
