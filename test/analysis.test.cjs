const assert = require("node:assert/strict");

const {
  analyzePawn,
  resolvePawnSymbol,
  getBoundOccurrences,
  inferPawnExpressionTag
} = require("../out/server/analysis.js");
const {
  tokenizePawn,
  isPawnFunctionInvocation
} = require("../out/server/symbols.js");

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
  "    new g_Total;",
  "    g_Total = 10;",
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

const tagSource = [
  "enum E_PLAYER {",
  "    E_PLAYER_ID,",
  "    Float:E_PLAYER_HEALTH,",
  "    bool:E_PLAYER_ACTIVE",
  "}",
  "new Float:g_PlayerHealth;",
  "new E_PLAYER:g_Player;",
  "new bool:g_PlayerReady;",
  "forward Float:GetPlayerHealth(playerid, Float:bonus, const bool:includeBonus);",
  "native E_PLAYER:GetPlayerType(playerid);",
  "stock Float:Calculate(Float:left, const Float:right[]) {",
  "    new Float:result;",
  "    return left + right[0];",
  "}"
].join("\n");
const tagAnalysis = analyzePawn(tagSource);
const findTagSymbol = (name, kind) =>
  tagAnalysis.symbols.find((symbol) => symbol.name === name && symbol.kind === kind);

assert.equal(findTagSymbol("g_PlayerHealth", "global").tag, "Float",
  "built-in Float tags should be stored on global variables");
assert.equal(findTagSymbol("g_Player", "global").tag, "E_PLAYER",
  "custom enum tags should be stored on variables");
assert.equal(findTagSymbol("g_PlayerReady", "global").tag, "bool",
  "bool tags should be stored on variables");
assert.equal(findTagSymbol("E_PLAYER_HEALTH", "enumMember").tag, "Float",
  "tagged enum members should retain their own tag");
assert.equal(findTagSymbol("E_PLAYER_ACTIVE", "enumMember").tag, "bool",
  "bool-tagged enum members should retain their tag");

const healthFunction = findTagSymbol("GetPlayerHealth", "function");
assert.equal(healthFunction.tag, "Float",
  "forward declarations should expose their return tag");
assert.deepEqual(
  healthFunction.parameters.map(({ name, tag }) => [name, tag]),
  [["playerid", undefined], ["bonus", "Float"], ["includeBonus", "bool"]],
  "forward parameters should retain names and tags even without a function body"
);
assert.equal(findTagSymbol("GetPlayerType", "function").tag, "E_PLAYER",
  "native declarations should expose custom return tags");

const calculateFunction = findTagSymbol("Calculate", "function");
assert.equal(calculateFunction.tag, "Float",
  "function definitions should expose their return tag");
assert.deepEqual(
  calculateFunction.parameters.map(({ name, tag, isArray }) => [name, tag, !!isArray]),
  [["left", "Float", false], ["right", "Float", true]],
  "function parameter metadata should retain tags and array information"
);
assert.equal(findTagSymbol("left", "parameter").tag, "Float",
  "parameter symbols should expose their Pawn tag");
assert.equal(findTagSymbol("right", "parameter").tag, "Float",
  "array parameter symbols should expose their Pawn tag");
assert.equal(findTagSymbol("result", "local").tag, "Float",
  "local variables should expose their Pawn tag");

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

const nestedScopeSource = [
  "static ScopedHelper() {",
  "    new outerValue;",
  "    if (true) {",
  "        new innerValue;",
  "    }",
  "    new afterBlock;",
  "}"
].join("\n");
const nestedScopeAnalysis = analyzePawn(nestedScopeSource);
const scoped = (name) => nestedScopeAnalysis.symbols.find(
  (symbol) => symbol.kind === "local" && symbol.name === name
);
const outerValue = scoped("outerValue");
const innerValue = scoped("innerValue");
const afterBlock = scoped("afterBlock");
assert.ok(outerValue && innerValue && afterBlock,
  "locals in nested function blocks should all be indexed");
assert.ok(innerValue.scopeStart > outerValue.scopeStart,
  "nested local scope should start after the outer function scope");
assert.ok(innerValue.scopeEnd < outerValue.scopeEnd,
  "nested local scope should end before the outer function scope");
assert.equal(afterBlock.scopeStart, outerValue.scopeStart,
  "locals after a nested block should return to the outer scope");
assert.equal(afterBlock.scopeEnd, outerValue.scopeEnd,
  "outer lexical scope should remain unchanged after a nested block");
assert.equal(
  nestedScopeAnalysis.symbols.filter((symbol) => symbol.kind === "function" && symbol.name === "ScopedHelper").length,
  1,
  "static function modifiers must not be indexed as variable declarations"
);

const typeOffset = source.indexOf("E_PLAYER:g_Player") + 2;
const resolvedType = resolvePawnSymbol(analysis, uri, typeOffset, [analysis]);
assert.equal(resolvedType.kind, "type", "enum tags should resolve in Pawn tag annotations");

const otherUri = "file:///workspace/gamemodes/other.pwn";
const otherAnalysis = analyzePawn([
  "public ReadTotal() {",
  "    printf(\"%d\", g_Total);",
  "}"
].join("\n"));
const globalTotal = find("g_Total", "global");
const globalOccurrences = getBoundOccurrences(
  globalTotal,
  uri,
  [
    { uri, analysis },
    { uri: otherUri, analysis: otherAnalysis }
  ]
);
assert.equal(
  globalOccurrences.length,
  3,
  "global references should cross files but ignore a same-named local shadow"
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

const macroSource = [
  "/**",
  " * Returns the smaller value.",
  " */",
  "#define min(%1,%2) ((%1) < (%2) ? (%1) : (%2))",
  "#define IsValid(%1) \\",
  "    (IsPlayerConnected(%1) && %1 != INVALID_PLAYER_ID)",
  "#define Object[%1] CallObject(%1)",
  "#define MAX_PATH 260",
  "/*",
  "#define HIDDEN_MACRO(%1) should_not_be_indexed",
  "*/"
].join("\n");
const macroAnalysis = analyzePawn(macroSource);
const findMacro = (name) =>
  macroAnalysis.symbols.find((symbol) => symbol.kind === "macro" && symbol.name === name);

const minMacro = findMacro("min");
assert.ok(minMacro, "parameterized function-style macros should be indexed");
assert.deepEqual(
  minMacro.macroParameters,
  ["%1", "%2"],
  "Pawn macro placeholders should be extracted in pattern order"
);
assert.equal(
  minMacro.macroPattern,
  "(%1,%2)",
  "macro matching pattern should be retained without replacement text"
);
assert.equal(
  minMacro.documentation,
  "Returns the smaller value.",
  "documentation comments immediately above macros should be retained"
);

const multilineMacro = findMacro("IsValid");
assert.deepEqual(
  multilineMacro.macroParameters,
  ["%1"],
  "continued macro directives should preserve their parameter list"
);
assert.ok(
  multilineMacro.macroReplacement.includes("IsPlayerConnected(%1)"),
  "continued macro replacement text should be joined"
);

const patternMacro = findMacro("Object");
assert.deepEqual(
  patternMacro.macroParameters,
  ["%1"],
  "bracket-pattern Pawn macros should be indexed"
);
assert.equal(
  patternMacro.macroPattern,
  "[%1]",
  "non-parenthesized Pawn macro patterns should be preserved"
);
assert.ok(findMacro("MAX_PATH"), "simple constant-style defines should remain supported");
assert.ok(!findMacro("HIDDEN_MACRO"), "defines inside block comments must not be indexed");

// Exercise declaration parsing at a scale large enough to catch accidental
// full-token-array rescans for every declaration.
const stressDeclarationCount = 4096;
const stressSource = Array.from(
  { length: stressDeclarationCount },
  (_, index) => `new Float:g_Stress${index};`
).join("\n");
const stressAnalysis = analyzePawn(stressSource);
const stressGlobals = stressAnalysis.symbols.filter(
  (symbol) => symbol.kind === "global"
);
assert.equal(
  stressGlobals.length,
  stressDeclarationCount,
  "large files should retain every global declaration"
);
assert.equal(
  stressGlobals[0].tag,
  "Float",
  "large-file declaration scanning should retain Pawn tags"
);
assert.equal(
  stressGlobals[stressGlobals.length - 1].name,
  `g_Stress${stressDeclarationCount - 1}`,
  "large-file declaration scanning should preserve source order"
);

console.log("Pawn symbol analysis tests passed.");


const callSource = [
  "PlayerTextDrawDestroy(playerid, textdraw);",
  "UpdatePlayerTextDraw(playerid, textdraw);",
  "notAFunction;",
  'printf("notAFunction(", playerid);',
  "// HiddenFunction(playerid);"
].join("\n");
const callTokens = tokenizePawn(callSource);
const tokenIndex = (name) => callTokens.findIndex((token) =>
  token.kind === "identifier" && token.value === name
);
assert.equal(
  isPawnFunctionInvocation(callTokens, tokenIndex("PlayerTextDrawDestroy")),
  true,
  "native calls should be recognized without parsing an include declaration"
);
assert.equal(
  isPawnFunctionInvocation(callTokens, tokenIndex("UpdatePlayerTextDraw")),
  true,
  "function invocation should be identified from Pawn call syntax"
);
assert.equal(
  isPawnFunctionInvocation(callTokens, tokenIndex("notAFunction")),
  false,
  "plain identifiers must not be classified as function calls"
);
assert.equal(
  callTokens.some((token, index) =>
    token.value === "notAFunction" &&
    isPawnFunctionInvocation(callTokens, index)
  ),
  false,
  "function-like text inside strings must not be treated as calls"
);
assert.ok(
  !callTokens.some((token) => token.kind === "identifier" && token.value === "HiddenFunction"),
  "function-like text inside comments must not become code tokens"
);

console.log("Pawn function invocation detection tests passed.");


const inferenceSource = [
  "new Float:g_PlayerHealth;",
  "stock CalculateBonus(Float:base) {",
  "    return base + 1.0;",
  "}",
  "stock IsPlayerReady(bool:ready) {",
  "    return ready && true;",
  "}",
  "public TestInference() {",
  "    new copiedHealth = g_PlayerHealth;",
  "    new calculatedBonus = CalculateBonus(g_PlayerHealth);",
  "    new ready = IsPlayerReady(true);",
  "}"
].join("\n");
const inferenceAnalysis = analyzePawn(inferenceSource);
const inferred = (name, kind) => inferenceAnalysis.symbols.find(
  (symbol) => symbol.name === name && symbol.kind === kind
);
assert.equal(inferred("copiedHealth", "local").inferredTag, "Float",
  "an initializer that copies a tagged variable should infer its Pawn tag");
assert.equal(inferred("calculatedBonus", "local").inferredTag, "Float",
  "variable inference should use an inferred function return tag");
assert.equal(inferred("ready", "local").inferredTag, "bool",
  "variable inference should use bool-returning calls");
assert.equal(inferred("CalculateBonus", "function").inferredTag, "Float",
  "consistent Float return expressions should infer a function return tag");
assert.equal(inferred("IsPlayerReady", "function").inferredTag, "bool",
  "logical return expressions should infer bool");
assert.equal(inferPawnExpressionTag("true", []), "bool",
  "boolean literals should infer bool");
assert.equal(inferPawnExpressionTag("1.25", []), "Float",
  "decimal literals should infer Float");
assert.equal(inferPawnExpressionTag("1 < 2", []), "bool",
  "comparison expressions should infer bool");
assert.equal(inferPawnExpressionTag("unknownValue", []), undefined,
  "unknown identifiers must not receive a guessed tag");


const repeatedDeclarations = [];
for (let index = 0; index < 250; index++) {
  repeatedDeclarations.push(
    `stock StressFunction${index}(playerid, Float:value) { new local${index} = value; return local${index}; }`
  );
}
const repeatedAnalysis = analyzePawn(repeatedDeclarations.join(String.fromCharCode(10)));
assert.equal(
  repeatedAnalysis.symbols.filter((symbol) => symbol.kind === "function" && symbol.name.startsWith("StressFunction")).length,
  250,
  "large files should index every function declaration"
);
assert.equal(
  repeatedAnalysis.symbols.filter((symbol) => symbol.kind === "local" && symbol.name.startsWith("local")).length,
  250,
  "large files should index every local declaration"
);

const lineDocumentedMacros = analyzePawn([
  "// first line",
  "// second line",
  "#define DOCUMENTED_LINE 1",
  "",
  "/**",
  " * block documentation",
  " */",
  "#define DOCUMENTED_BLOCK 2"
].join(String.fromCharCode(10)));
assert.equal(
  lineDocumentedMacros.symbols.find((symbol) => symbol.name === "DOCUMENTED_LINE")?.documentation,
  ["first line", "second line"].join(String.fromCharCode(10)),
  "adjacent line comments should remain macro documentation"
);
assert.equal(
  lineDocumentedMacros.symbols.find((symbol) => symbol.name === "DOCUMENTED_BLOCK")?.documentation,
  "block documentation",
  "block comments should remain macro documentation"
);
