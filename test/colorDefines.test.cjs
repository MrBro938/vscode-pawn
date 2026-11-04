const assert = require("node:assert/strict");
const {
  extractPawnColorDefineExpressions,
  parsePawnColorDefineValue,
  resolvePawnColorDefines
} = require("../out/server/colorDefines.js");

const source = [
  "#define COLOR_GREY 0xAFAFAFAA",
  "#define COLOR_WHITE (0xFFFFFFFF)",
  "#define COLOR_RGB 0xA1B2C3 // trailing comment",
  "#define COLOR_BLOCK /* inline comment */ 0x123456",
  "#define COLOR_ALIAS COLOR_GREY",
  "#define COLOR_FORWARD (COLOR_WHITE)",
  "#define COLOR_MULTILINE \\",
  "    0xFF00FF",
  "#define NOT_A_COLOR 1234",
  "#define COLOR_FUNCTION(x) 0xFF0000",
  "// #define COMMENTED_COLOR 0xFFFFFF",
  "/*",
  "#define BLOCK_COMMENT_COLOR 0xFFFFFF",
  "*/",
  "#define COLOR_AFTER_BLOCK 0x010203"
].join("\n");

const expressions = extractPawnColorDefineExpressions(source);
const names = expressions.map((definition) => definition.name);
assert.deepEqual(names, [
  "COLOR_GREY",
  "COLOR_WHITE",
  "COLOR_RGB",
  "COLOR_BLOCK",
  "COLOR_ALIAS",
  "COLOR_FORWARD",
  "COLOR_MULTILINE",
  "NOT_A_COLOR",
  "COLOR_AFTER_BLOCK"
], "only real object-like #define directives should be indexed");

const resolved = resolvePawnColorDefines(expressions);
const byName = new Map(resolved.map((definition) => [definition.name, definition]));
assert.deepEqual(
  byName.get("COLOR_GREY"),
  {
    name: "COLOR_GREY",
    red: 0xAF / 255,
    green: 0xAF / 255,
    blue: 0xAF / 255,
    alpha: 0xAA / 255
  },
  "8-digit Pawn color defines should preserve the trailing alpha channel"
);
assert.deepEqual(
  byName.get("COLOR_WHITE"),
  { name: "COLOR_WHITE", red: 1, green: 1, blue: 1, alpha: 1 },
  "parenthesized RGB values should be resolved"
);
assert.deepEqual(
  {
    red: byName.get("COLOR_ALIAS").red,
    green: byName.get("COLOR_ALIAS").green,
    blue: byName.get("COLOR_ALIAS").blue,
    alpha: byName.get("COLOR_ALIAS").alpha
  },
  {
    red: byName.get("COLOR_GREY").red,
    green: byName.get("COLOR_GREY").green,
    blue: byName.get("COLOR_GREY").blue,
    alpha: byName.get("COLOR_GREY").alpha
  },
  "aliases should resolve to the referenced color channels while retaining their own names"
);
assert.equal(byName.get("COLOR_ALIAS").name, "COLOR_ALIAS");
assert.deepEqual(
  {
    red: byName.get("COLOR_FORWARD").red,
    green: byName.get("COLOR_FORWARD").green,
    blue: byName.get("COLOR_FORWARD").blue,
    alpha: byName.get("COLOR_FORWARD").alpha
  },
  {
    red: byName.get("COLOR_WHITE").red,
    green: byName.get("COLOR_WHITE").green,
    blue: byName.get("COLOR_WHITE").blue,
    alpha: byName.get("COLOR_WHITE").alpha
  },
  "parenthesized aliases should resolve while retaining their own names"
);
assert.equal(byName.get("COLOR_FORWARD").name, "COLOR_FORWARD");
assert.equal(byName.get("COLOR_MULTILINE").red, 1);
assert.equal(byName.get("COLOR_MULTILINE").blue, 1);
assert.deepEqual(
  byName.get("COLOR_AFTER_BLOCK"),
  {
    name: "COLOR_AFTER_BLOCK",
    red: 1 / 255,
    green: 2 / 255,
    blue: 3 / 255,
    alpha: 1
  },
  "directives after a block comment should still be parsed"
);
assert.equal(byName.has("NOT_A_COLOR"), false);
assert.equal(byName.has("COLOR_FUNCTION"), false);
assert.equal(byName.has("BLOCK_COMMENT_COLOR"), false);

assert.deepEqual(
  parsePawnColorDefineValue("((0x123456))"),
  { red: 0x12 / 255, green: 0x34 / 255, blue: 0x56 / 255, alpha: 1 }
);

const crossFileAlias = resolvePawnColorDefines([
  { name: "COLOR_BASE", expression: "0x334455" },
  { name: "COLOR_ALIAS", expression: "COLOR_BASE" }
]);
assert.deepEqual(
  crossFileAlias.find((definition) => definition.name === "COLOR_ALIAS"),
  { name: "COLOR_ALIAS", red: 0x33 / 255, green: 0x44 / 255, blue: 0x55 / 255, alpha: 1 },
  "aliases should resolve after the include-aware definitions are merged"
);

const cyclicAliases = resolvePawnColorDefines([
  { name: "COLOR_A", expression: "COLOR_B" },
  { name: "COLOR_B", expression: "COLOR_A" }
]);
assert.deepEqual(cyclicAliases, [], "cyclic aliases must not produce a color");

console.log("Pawn color #define tests passed.");
