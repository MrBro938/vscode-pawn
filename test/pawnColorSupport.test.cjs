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
