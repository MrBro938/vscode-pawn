const assert = require("node:assert/strict");
const {
  buildPawnFunctionSearchIndex,
  FunctionSearchIndexCache
} = require("../out/server/functionSearchIndex.js");

const mainFunction = { uri: "main.pwn", label: "GetValue()" };
const duplicateMainFunction = { uri: "main.pwn", label: "getvalue()" };
const includedFunction = { uri: "helpers.inc", label: "GetValue()" };
const mainDefinition = { uri: "main.pwn", label: "MAX_VALUE" };
const includedDefinition = { uri: "helpers.inc", label: "MAX_VALUE" };

const functionsByUri = new Map([
  ["main.pwn", [
    ["GetValue", mainFunction],
    ["getvalue", duplicateMainFunction]
  ]],
  ["helpers.inc", [["GetValue", includedFunction]]],
  ["other.inc", [["OtherFunction", { uri: "other.inc" }]]]
]);
const definitionsByUri = new Map([
  ["main.pwn", [mainDefinition]],
  ["helpers.inc", [includedDefinition]]
]);

const index = buildPawnFunctionSearchIndex(
  ["main.pwn", "helpers.inc", "other.inc"],
  (uri) => functionsByUri.get(uri),
  (uri) => definitionsByUri.get(uri),
  (definition) => definition.label
);

assert.equal(index.functions.get("getvalue"), mainFunction,
  "the first function in the configured URI order must win");
assert.equal(index.functions.get("otherfunction").uri, "other.inc");
assert.equal(index.definitions.get("MAX_VALUE"), mainDefinition,
  "the first exact-name definition in search order must win");
assert.equal(index.sourceUris.size, 3);

const reversed = buildPawnFunctionSearchIndex(
  ["helpers.inc", "main.pwn"],
  (uri) => functionsByUri.get(uri),
  (uri) => definitionsByUri.get(uri),
  (definition) => definition.label
);
assert.equal(reversed.functions.get("getvalue"), includedFunction,
  "changing search order must change the selected duplicate function");

const cache = new FunctionSearchIndexCache(2);
assert.equal(cache.set("main.pwn", index), false);
assert.equal(cache.get("main.pwn"), index);
assert.equal(cache.set("helpers.inc", reversed), false);
assert.equal(cache.set("other.inc", reversed), true,
  "the least recently used index must be evicted at capacity");
assert.equal(cache.get("main.pwn"), undefined);
assert.equal(cache.get("helpers.inc"), reversed);

assert.equal(cache.markSourceStale("helpers.inc"), 1);
assert.equal(cache.get("helpers.inc"), undefined,
  "editing a dependency must invalidate only indexes containing it");
assert.equal(cache.markSourceStale("not-in-scope.inc"), 0);

cache.clear();
assert.equal(cache.get("helpers.inc"), undefined);
console.log("Pawn function search index tests passed.");
