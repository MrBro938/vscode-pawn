const assert = require("node:assert/strict");

const { analyzePawn } = require("../out/server/analysis.js");
const { buildPawnCompletionItems } = require("../out/server/completion.js");
const { findFunctionIdentifier } = require("../out/server/function.js");

const mainUri = "file:///workspace/gamemodes/main.pwn";
const includeUri = "file:///workspace/dependencies/project.inc";

const mainText = [
  "new g_Total;",
  "enum E_STATE { E_STATE_ID, E_STATE_ACTIVE }",
  "#define MAX_COUNT 100",
  "native GetUserName(playerid, name[], size);",
  "public OnPlayerConnect(playerid) {",
  "    new localValue;",
  "    localValue = 1;",
  "    {",
  "        new bool:localValue;",
  "        new nestedValue;",
  "        nestedValue = 2;",
  "        |",
  "    }",
  "    new declaredAfterCursor;",
  "}"
].join("\n");

const cursorOffset = mainText.indexOf("|");
const cleanMainText = mainText.replace("|", "");

const includeText = [
  "new G_TOTAL;",
  "new g_IncludeTotal;",
  "#define INCLUDE_LIMIT 10",
  "enum E_INCLUDE_STATE { E_INCLUDE_ACTIVE, E_INCLUDE_DISABLED }",
  "stock IncludedFunction(value) {",
  "    new hiddenIncludeLocal;",
  "    return value;",
  "}"
].join("\n");

const mainAnalysis = analyzePawn(cleanMainText);
const includeAnalysis = analyzePawn(includeText);
const items = buildPawnCompletionItems(mainUri, cursorOffset, [
  { uri: mainUri, analysis: mainAnalysis },
  { uri: includeUri, analysis: includeAnalysis }
]);
const byName = new Map(items.map((item) => [item.label.toLowerCase(), item]));

assert.ok(byName.has("localvalue"), "visible local variable should be suggested");
assert.ok(byName.has("nestedvalue"), "local variable in the active nested block should be suggested");
assert.ok(byName.has("playerid"), "function parameters should be suggested inside the function");
assert.ok(!byName.has("declaredaftercursor"), "locals declared after the cursor must not be suggested");
assert.ok(!byName.has("hiddenincludelocal"), "locals from included files must not leak into the current scope");

assert.ok(byName.has("getusername"), "native functions should be suggested");
assert.ok(byName.has("includedfunction"), "functions from resolved includes should be suggested");
assert.ok(byName.has("g_includetotal"), "globals from resolved includes should be suggested");
assert.ok(byName.has("max_count"), "macros should be suggested");
assert.ok(byName.has("e_include_active"), "enum members from includes should be suggested");
assert.ok(byName.has("return"), "Pawn keywords should be suggested");

assert.equal(
  items.filter((item) => item.label.toLowerCase() === "g_total").length,
  1,
  "symbols with case-only name differences should be deduplicated"
);
assert.equal(
  byName.get("localvalue").detail,
  "bool:localValue",
  "the innermost visible declaration should win when a local shadows an outer local"
);

const nestedCall = 'Outer(first, Nested(1, 2), "text, with comma", values[1, 2], ';
assert.deepEqual(
  findFunctionIdentifier(nestedCall, nestedCall.length),
  { identifier: "Outer", parameterIndex: 4 },
  "Signature Help should count only top-level arguments and ignore commas in nested calls, strings and indexes"
);

const innerCall = "Outer(first, Nested(value, ";
assert.deepEqual(
  findFunctionIdentifier(innerCall, innerCall.length),
  { identifier: "Nested", parameterIndex: 1 },
  "Signature Help should select the innermost unfinished call"
);

assert.deepEqual(
  findFunctionIdentifier("SomeStatement; notACall", "SomeStatement; notACall".length),
  { identifier: "", parameterIndex: 0 },
  "Signature Help should not attach to a previous completed statement"
);

console.log("Pawn completion and signature help tests passed.");
