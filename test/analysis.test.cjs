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
  "new E_PLAYER:g_Player;",
  "forward TestNative(playerid);",
  "public OnPlayerConnect(playerid) {",
  "    new localValue;",
  "    localValue = g_Total;",
  "    printf(\"localValue %d\", localValue); // localValue is only a comment",
  "    {",
  "        new localValue;",
  "        localValue = 2;",
  "    }",
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
assert.ok(find("E_PLAYER", "type"), "enum tag should also be registered as a Pawn type");
assert.equal(find("E_NAME", "enumMember").isArray, true, "enum array member should be marked as an array");

const localDeclarations = analysis.symbols.filter(
  (symbol) => symbol.name === "localValue" && symbol.kind === "local"
);
assert.equal(localDeclarations.length, 3, "locals in function and nested block scopes should be indexed separately");

const firstLocal = localDeclarations[0];
const firstUseOffset = source.indexOf("localValue = g_Total") + 2;
const resolved = resolvePawnSymbol(analysis, uri, firstUseOffset, [analysis]);
assert.equal(resolved, firstLocal, "local reference should resolve to the declaration in its own function");

const occurrences = getBoundOccurrences(firstLocal, uri, [{ uri, analysis }]);
assert.equal(occurrences.length, 3, "outer local references should exclude the nested block and second function");
assert.ok(
  occurrences.every(({ token }) => token.start >= firstLocal.start && token.start < firstLocal.scopeEnd),
  "local references should stay inside the declaration's scope"
);

const nestedLocal = localDeclarations[1];
const nestedOccurrences = getBoundOccurrences(
  nestedLocal,
  uri,
  [{ uri, analysis }]
);
assert.equal(nestedOccurrences.length, 2, "nested block local should only bind within its block");

const typeOffset = source.indexOf("E_PLAYER:g_Player") + 2;
const resolvedType = resolvePawnSymbol(analysis, uri, typeOffset, [analysis]);
assert.equal(resolvedType.kind, "type", "enum tags should resolve in Pawn tag annotations");

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
