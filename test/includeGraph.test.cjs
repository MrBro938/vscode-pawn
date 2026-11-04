const assert = require("node:assert/strict");
const path = require("node:path");

const {
  buildPawnIncludeGraph,
  extractPawnIncludes,
  getCompilationUnitUris,
  getIncludedFileUris,
  resolveIncludeUris
} = require("../out/server/includeGraph.js");

const rootA = "file:///workspace/gamemodes/mode_a.pwn";
const rootB = "file:///workspace/gamemodes/mode_b.pwn";
const apiA = "file:///workspace/sourse/modules/a/public/api.inc";
const sideA = "file:///workspace/sourse/modules/a/private/side.inc";
const apiB = "file:///workspace/sourse/modules/b/public/api.inc";
const common = "file:///workspace/sourse/shared/common.inc";

const files = new Map([
  [rootA, "/workspace/gamemodes/mode_a.pwn"],
  [rootB, "/workspace/gamemodes/mode_b.pwn"],
  [apiA, "/workspace/sourse/modules/a/public/api.inc"],
  [sideA, "/workspace/sourse/modules/a/private/side.inc"],
  [apiB, "/workspace/sourse/modules/b/public/api.inc"],
  [common, "/workspace/sourse/shared/common.inc"],
  ["file:///workspace/dependencies/YSI-Includes/YSI_Coding/y_hooks.inc", "/workspace/dependencies/YSI-Includes/YSI_Coding/y_hooks.inc"],
  ["file:///workspace/custom/YSI_Coding/y_hooks.inc", "/workspace/custom/YSI_Coding/y_hooks.inc"],
  ["file:///workspace/gamemodes/local_only.inc", "/workspace/gamemodes/local_only.inc"],
  ["file:///workspace/gamemodes/relative.inc", "/workspace/gamemodes/relative.inc"],
  ["file:///workspace/custom/relative.inc", "/workspace/custom/relative.inc"]
]);

const texts = new Map([
  [rootA, [
    '#include "sourse/modules/a/public/api.inc"',
    '#include "sourse/modules/a/private/side.inc"',
    "public OnGameModeInit() {}"
  ].join("\n")],
  [rootB, [
    '#include "sourse/modules/b/public/api.inc"',
    "public OnGameModeInit() {}"
  ].join("\n")],
  [apiA, [
    '#include "sourse/shared/common.inc"',
    "stock GetModuleValue() { return 1; }"
  ].join("\n")],
  [sideA, "stock GetSideValue() { return 2; }"],
  [apiB, "stock GetModuleValue() { return 3; }"],
  [common, "stock GetCommonValue() { return 4; }"]
]);

const pathIndex = new Map();
files.forEach((filePath, uri) => {
  const parts = filePath.split(path.sep);
  for (let index = 0; index < parts.length; index++) {
    const suffix = path.normalize(parts.slice(index).join(path.sep));
    if (!suffix) continue;
    let matches = pathIndex.get(suffix);
    if (!matches) {
      matches = new Set();
      pathIndex.set(suffix, matches);
    }
    matches.add(uri);
  }
});

const includes = extractPawnIncludes([
  "// #include \"commented.inc\"",
  "/*",
  '#include "inside_multiline_comment.inc"',
  "*/",
  '#include "real.inc" // trailing comment',
  '#include <standard.inc>'
].join("\n"));
assert.deepEqual(
  includes,
  [
    { path: "real.inc", mode: "quoted" },
    { path: "standard.inc", mode: "system" }
  ],
  "only active include directives should be parsed and include delimiters must be preserved"
);

const graph = buildPawnIncludeGraph(files, texts, pathIndex, ["/workspace"]);
const unitA = getCompilationUnitUris(rootA, graph);
const unitB = getCompilationUnitUris(rootB, graph);
const includedApiA = getIncludedFileUris(apiA, graph);
assert.deepEqual(
  Array.from(includedApiA).sort(),
  [apiA, common].sort(),
  "semantic dependencies should follow only this file's include chain"
);
assert.equal(
  getIncludedFileUris(apiA, graph),
  includedApiA,
  "included-file traversal should be cached for repeated requests"
);

for (const uri of [rootA, apiA, sideA, common]) {
  assert.ok(unitA.has(uri), "mode A compilation unit should include " + uri);
}
assert.ok(!unitA.has(rootB), "mode A must not include independent mode B root");
assert.ok(!unitA.has(apiB), "same-named symbols in mode B modules must stay isolated");

for (const uri of [rootB, apiB]) {
  assert.ok(unitB.has(uri), "mode B compilation unit should include " + uri);
}
assert.ok(!unitB.has(apiA), "mode B must not include mode A's module");

const resolved = resolveIncludeUris(
  rootA,
  "sourse/modules/a/public/api.inc",
  "quoted",
  files,
  pathIndex,
  ["/workspace"]
);
assert.deepEqual(resolved, [apiA], "project-root include path should resolve to the indexed module");

const ysiFirst = "file:///workspace/dependencies/YSI-Includes/YSI_Coding/y_hooks.inc";
const ysiSecond = "file:///workspace/custom/YSI_Coding/y_hooks.inc";
assert.deepEqual(
  resolveIncludeUris(
    rootA,
    "YSI_Coding/y_hooks",
    "system",
    files,
    pathIndex,
    ["/workspace/dependencies/YSI-Includes", "/workspace/custom"]
  ),
  [ysiFirst],
  "angle includes should select the first matching compiler include directory"
);
assert.deepEqual(
  resolveIncludeUris(
    rootA,
    "YSI_Coding/y_hooks",
    "system",
    files,
    pathIndex,
    ["/workspace/custom", "/workspace/dependencies/YSI-Includes"]
  ),
  [ysiSecond],
  "changing compiler include directory order should change the selected file"
);
assert.deepEqual(
  resolveIncludeUris(
    rootA,
    "relative",
    "quoted",
    files,
    pathIndex,
    ["/workspace/custom"]
  ),
  ["file:///workspace/gamemodes/relative.inc"],
  "quoted includes should prefer the including file's directory over -i paths"
);
assert.deepEqual(
  resolveIncludeUris(
    rootA,
    "local_only",
    "system",
    files,
    pathIndex,
    ["/workspace/custom"]
  ),
  [],
  "angle includes must not resolve from the including file's directory"
);

const isolated = getCompilationUnitUris("file:///workspace/other/isolated.pwn", graph);
assert.deepEqual(
  Array.from(isolated),
  ["file:///workspace/other/isolated.pwn"],
  "an unindexed standalone file should form its own compilation unit"
);

const { analyzePawn, getBoundOccurrences } = require("../out/server/analysis.js");

const analysisByUri = new Map([
  [rootA, analyzePawn([
    "new g_ModuleValue;",
    "public OnGameModeInit() { g_ModuleValue = GetModuleValue(); }"
  ].join("\n"))],
  [rootB, analyzePawn([
    "new g_ModuleValue;",
    "public OnGameModeInit() { g_ModuleValue = GetModuleValue(); }"
  ].join("\n"))],
  [apiA, analyzePawn("stock GetModuleValue() { return 1; }")],
  [apiB, analyzePawn("stock GetModuleValue() { return 2; }")],
  [sideA, analyzePawn("stock UseSide() { return GetModuleValue(); }")],
  [common, analyzePawn("stock UseCommon() { return GetModuleValue(); }")]
]);

const unitWorkspaceA = Array.from(unitA)
  .filter((uri) => analysisByUri.has(uri))
  .map((uri) => ({ uri, analysis: analysisByUri.get(uri) }));
const targetFunction = analysisByUri.get(apiA).symbols.find(
  (symbol) => symbol.kind === "function" && symbol.name === "GetModuleValue"
);
const linkedOccurrences = getBoundOccurrences(targetFunction, apiA, unitWorkspaceA);
assert.ok(
  linkedOccurrences.some((entry) => entry.uri === rootA),
  "references should include the root gamemode"
);
assert.ok(
  linkedOccurrences.some((entry) => entry.uri === sideA),
  "references should include a sibling module connected through the same root"
);
assert.ok(
  !linkedOccurrences.some((entry) => entry.uri === rootB || entry.uri === apiB),
  "references must not leak into an independent compilation unit with the same names"
);

console.log("Pawn include graph tests passed.");
