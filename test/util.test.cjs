const assert = require("node:assert/strict");
const { TextDocument } = require("vscode-languageserver-textdocument");
const { createTextPositionCursor } = require("../out/server/util.js");

const source = "alpha 😀 beta\r\n\r\n\tPawn:Value\rnext\nlast";
const document = TextDocument.create("file:///workspace/cursor-test.pwn", "pawn", 1, source);
const cursor = createTextPositionCursor(source);

const values = ["alpha", "😀", "beta", "Pawn", "Value", "next", "last"];
let previousEnd = 0;

for (const value of values) {
  const start = source.indexOf(value, previousEnd);
  assert.notEqual(start, -1, `test token should exist: ${value}`);
  const end = start + value.length;

  assert.deepEqual(
    cursor(start, end),
    document.positionAt(start),
    `sequential position should match LSP TextDocument.positionAt for ${value}`
  );
  previousEnd = end;
}

console.log("Text position cursor tests passed.");
