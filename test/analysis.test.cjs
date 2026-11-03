const assert = require("node:assert/strict");

const {
  analyzePawn,
  resolvePawnSymbol,
  getBoundOccurrences
} = require("../out/server/analysis.js");

const uri = "file:///workspace/gamemodes/test.pwn";
const source = [
  "new g_Total;",
  "enum E_PLAYER {",
  "    E_ID,",
  "    E_NAME[24]",
  "}",
  "forward TestNative(playerid);",
  "public OnPlayerConnect(playerid) {",
  "    new localValue;",
  "    localValue = g_Total;",
  "    printf(\"%d\", localValue);",
  "}",
  "public OnPlayerDisconnect(playerid) {",
  "    new localValue;",
  "    localValue = 0;",
  "}"
].join("\n");

const analysis = analyzePawn(source);
const find = (name, kind) =>
  analysis.symbols.find((symbol) => symbol.name === name && symbol.kind === kind);

assert.ok(find("OnPlayerConnect", "function"), "function declaration should be indexed");
assert.ok(find("TestNative", "function"), "forward prototype should be indexed");
assert.ok(find("g_Total", "global"), "global variable should be indexed");
assert.ok(find("E_PLAYER", "enum"), "named enum should be indexed");
assert.ok(find("E_ID", "enumMember"), "enum member should be indexed");
assert.equal(find("E_NAME", "enumMember").isArray, true, "enum array member should be marked as an array");

const localDeclarations = analysis.symbols.filter(
  (symbol) => symbol.name === "localValue" && symbol.kind === "local"
);
assert.equal(localDeclarations.length, 2, "same-named locals in separate functions should remain separate symbols");

const firstLocal = localDeclarations[0];
const firstUseOffset = source.indexOf("localValue = g_Total") + 2;
const resolved = resolvePawnSymbol(analysis, uri, firstUseOffset, [analysis]);
assert.equal(resolved, firstLocal, "local reference should resolve to the declaration in its own function");

const occurrences = getBoundOccurrences(firstLocal, uri, [{ uri, analysis }]);
assert.equal(occurrences.length, 2, "local references should not cross into the second function");
assert.ok(
  occurrences.every(({ token }) => token.start >= firstLocal.start && token.start < firstLocal.scopeEnd),
  "local references should stay inside the declaration's scope"
);

const parameter = find("playerid", "parameter");
assert.ok(parameter, "function parameter should be indexed");
const parameterDeclarationIncluded = getBoundOccurrences(
  parameter,
  uri,
  [{ uri, analysis }]
).some(({ token }) => token.start === parameter.start);
assert.ok(parameterDeclarationIncluded, "parameter declaration should be included in its references");

const printfTokens = analysis.tokens.filter((token) => token.value === "printf");
assert.equal(printfTokens.length, 1, "function calls inside a body should remain tokens");
assert.equal(
  analysis.symbols.filter((symbol) => symbol.name === "printf" && symbol.kind === "function").length,
  0,
  "function calls must not be misidentified as declarations"
);

console.log("Pawn symbol analysis tests passed.");
