const assert = require("node:assert/strict");
const {
  arePawnViewportRangesCovered,
  expandPawnViewportRanges,
  formatPawnColorLiteral,
  PawnColorLineCache,
  scanPawnColorLine
} = require("../out/pawnColorSupport.js");

const basicSource = "new color = 0xFF3366; new rgba = 0x12AB34CC;";
const basic = scanPawnColorLine(basicSource);
assert.equal(basic.colors.length, 2, "RGB and RGBA literals should be found");
assert.equal(basic.colors[0].startColumn, basicSource.indexOf("0xFF3366"));
assert.equal(basic.colors[0].endColumn, basicSource.indexOf("0xFF3366") + 8);
assert.deepEqual(
  {
    red: basic.colors[0].red,
    green: basic.colors[0].green,
    blue: basic.colors[0].blue,
    alpha: basic.colors[0].alpha
  },
  { red: 1, green: 0x33 / 255, blue: 0x66 / 255, alpha: 1 },
  "six-digit literals should be decoded as opaque RGB"
);
assert.deepEqual(
  {
    red: basic.colors[1].red,
    green: basic.colors[1].green,
    blue: basic.colors[1].blue,
    alpha: basic.colors[1].alpha
  },
  {
    red: 0x12 / 255,
    green: 0xAB / 255,
    blue: 0x34 / 255,
    alpha: 0xCC / 255
  },
  "eight-digit SA-MP literals should decode the trailing RGBA alpha byte"
);

const ignored = scanPawnColorLine(
  `printf("0xFF0000", '0x00FF00'); // 0x0000FF`
);
assert.equal(ignored.colors.length, 0, "color-like text in strings and line comments must be ignored");

const saMpText = 'SendClientMessage(playerid, -1, "Привет {FFFFFF}Как {FF3333}твои дела?");';
const saMpColors = scanPawnColorLine(saMpText);
assert.equal(
  saMpColors.colors.length,
  2,
  "SA-MP {RRGGBB} tags should be detected inside quoted Pawn text"
);
const whiteTagStart = saMpText.indexOf("{FFFFFF}");
assert.equal(saMpColors.colors[0].startColumn, whiteTagStart);
assert.equal(
  saMpColors.colors[0].endColumn,
  whiteTagStart + "{FFFFFF}".length,
  "the color range should include both braces so the picker replaces the complete tag"
);
assert.deepEqual(
  {
    red: saMpColors.colors[0].red,
    green: saMpColors.colors[0].green,
    blue: saMpColors.colors[0].blue,
    alpha: saMpColors.colors[0].alpha
  },
  { red: 1, green: 1, blue: 1, alpha: 1 },
  "SA-MP inline text colors should be interpreted as opaque RGB"
);
assert.deepEqual(
  formatPawnColorLiteral(
    { red: 1, green: 0, blue: 0, alpha: 0.4 },
    "{FFFFFF}"
  ),
  "{FF0000}",
  "the picker should update RGB while preserving braces and six-digit SA-MP syntax"
);
assert.deepEqual(
  formatPawnColorLiteral(
    { red: 0, green: 0.5, blue: 1, alpha: 1 },
    "{ffffff}"
  ),
  "{0080ff}",
  "inline color formatting should preserve lowercase hex style"
);
assert.deepEqual(
  formatPawnColorLiteral(
    { red: 0, green: 0, blue: 0, alpha: 1 },
    "{GGGGGG}"
  ),
  undefined,
  "invalid inline color tags should not produce color presentations"
);

assert.equal(
  scanPawnColorLine('new value = {FFFFFF};').colors.length,
  0,
  "brace hex values outside strings must not be treated as SA-MP text colors"
);
assert.equal(
  scanPawnColorLine('// "message {FFFFFF}"').colors.length,
  0,
  "inline color-like text in line comments must be ignored"
);
assert.equal(
  scanPawnColorLine('/* "message {FFFFFF}" */').colors.length,
  0,
  "inline color-like text in block comments must be ignored"
);

const continuedInlineStart = scanPawnColorLine(
  'new text[] = "continued message ' + String.fromCharCode(92)
);
const continuedInlineEnd = scanPawnColorLine(
  ' {00AAFF}";',
  false,
  continuedInlineStart.continuedQuote
);
assert.equal(
  continuedInlineEnd.colors.length,
  1,
  "inline SA-MP colors should also be recognized in backslash-continued strings"
);


const blockStart = scanPawnColorLine("/* comment starts with 0xFF0000");
assert.equal(blockStart.colors.length, 0);
assert.equal(blockStart.inBlockComment, true);
const blockMiddle = scanPawnColorLine("still comment 0x00FF00", blockStart.inBlockComment);
assert.equal(blockMiddle.colors.length, 0);
assert.equal(blockMiddle.inBlockComment, true);
const blockEnd = scanPawnColorLine("*/ new color = 0x123456;", blockMiddle.inBlockComment);
assert.equal(blockEnd.colors.length, 1, "code after a closing block comment should be scanned");
assert.equal(blockEnd.inBlockComment, false);

const continuedStringLine = 'new text[] = "still a string ' + "\\";
const stringStart = scanPawnColorLine(continuedStringLine);
assert.equal(stringStart.colors.length, 0);
assert.equal(stringStart.continuedQuote, '"', "Pawn backslash-continued strings should carry lexical state");
const stringEnd = scanPawnColorLine(
  '0xFF0000"; new color = 0xAABBCC;',
  false,
  stringStart.continuedQuote
);
assert.equal(stringEnd.colors.length, 1, "only code after a continued string should be decorated");

const identifierScan = scanPawnColorLine(
  'HUD_SendMessage(playerid, COLOR_GREY, COLOR_ALIAS); // COLOR_COMMENT'
);
assert.deepEqual(
  identifierScan.identifiers.map((identifier) => identifier.name),
  ["HUD_SendMessage", "playerid", "COLOR_GREY", "COLOR_ALIAS"],
  "Pawn code identifiers should be collected without comment contents"
);
assert.equal(
  scanPawnColorLine('printf("COLOR_GREY");').identifiers.length,
  0,
  "identifiers inside regular strings should not become color references"
);
assert.equal(
  scanPawnColorLine("#define COLOR_GREY 0xAFAFAFAA").identifiers.length,
  0,
  "preprocessor definition names should not be decorated as references"
);

const invalidNumbers = scanPawnColorLine(
  "0x12345 0x1234567 0x123456789 identifier0xAABBCC 0xAABBCC_suffix"
);
assert.equal(
  invalidNumbers.colors.length,
  0,
  "short, oversized, and identifier-embedded hex numbers must not become color decorators"
);

assert.equal(
  formatPawnColorLiteral(
    { red: 1, green: 0, blue: 0.5, alpha: 1 },
    "0x00ff00"
  ),
  "0xff0080",
  "six-digit color presentation should preserve lowercase and omit alpha when opaque"
);
assert.equal(
  formatPawnColorLiteral(
    { red: 1, green: 0.5, blue: 0, alpha: 0.25 },
    "0X00AA00FF"
  ),
  "0XFF800040",
  "eight-digit color presentation should preserve uppercase prefix, hex casing and trailing alpha"
);
assert.equal(
  formatPawnColorLiteral(
    { red: 1, green: 0, blue: 0, alpha: 0.5 },
    "0xFF0000"
  ),
  "0xFF000080",
  "choosing transparency for an RGB literal should add the trailing alpha byte"
);
assert.equal(
  formatPawnColorLiteral(
    { red: 0, green: 0, blue: 0, alpha: 1 },
    "0x1234567"
  ),
  undefined,
  "unsupported literal widths should not be rewritten"
);

assert.deepEqual(
  expandPawnViewportRanges(
    [
      { startLine: 100, endLine: 120 },
      { startLine: 190, endLine: 205 },
      { startLine: 2, endLine: 5 }
    ],
    1000,
    40
  ),
  [
    { startLine: 0, endLine: 45 },
    { startLine: 60, endLine: 245 }
  ],
  "visible ranges should expand by the prefetch margin and merge overlaps"
);
assert.deepEqual(
  expandPawnViewportRanges([{ startLine: 990, endLine: 1100 }], 1000, 80),
  [{ startLine: 910, endLine: 999 }],
  "viewport ranges should be clamped to document bounds"
);
assert.deepEqual(
  expandPawnViewportRanges([], 1000, 80),
  [],
  "documents without visible ranges should not trigger a scan"
);

const coverage = [
  { startLine: 20, endLine: 180 },
  { startLine: 500, endLine: 700 }
];
assert.equal(
  arePawnViewportRangesCovered(
    [{ startLine: 40, endLine: 80 }, { startLine: 540, endLine: 600 }],
    coverage
  ),
  true,
  "cached viewport windows should cover scrolling inside their prefetch margins"
);
assert.equal(
  arePawnViewportRangesCovered([{ startLine: 181, endLine: 190 }], coverage),
  false,
  "scrolling outside cached windows should request a new scan"
);

const cache = new PawnColorLineCache(1, 5);
const scanA = scanPawnColorLine("new color = 0x112233;");
const scanB = scanPawnColorLine("new color = 0x445566;");
cache.set(1, 10, scanA);
cache.set(1, 11, scanB);
cache.setCoverage([{ startLine: 10, endLine: 11 }]);
assert.equal(cache.get(1, 10), scanA, "cached line scans should be reusable");
assert.equal(cache.isViewportCovered([{ startLine: 10, endLine: 11 }]), true);
cache.invalidateFromLine(2, 11);
assert.equal(
  cache.get(2, 10),
  scanA,
  "edits should preserve cached lines before the first changed line"
);
assert.equal(
  cache.get(2, 11),
  undefined,
  "edits should invalidate the changed line and following cached lines"
);
assert.equal(cache.isViewportCovered([{ startLine: 10, endLine: 10 }]), false);

for (let line = 0; line < 10; line++) {
  cache.set(2, line, scanA);
}
assert.equal(cache.size, 5, "the per-document cache should enforce its memory bound");

cache.ensureVersion(3);
assert.equal(cache.size, 0, "unexpected document-version changes should safely clear stale cache entries");

console.log("Pawn color picker support tests passed.");
