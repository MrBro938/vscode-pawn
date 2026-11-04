import * as vscode from "vscode";
import {
  expandPawnViewportRanges,
  formatPawnColorLiteral,
  PawnColorLineCache,
  scanPawnColorLine,
} from "./pawnColorSupport";

const PREFETCH_MIN_LINES = 80;
const PREFETCH_MAX_LINES = 240;
const BLOCK_COMMENT_LOOKBEHIND_LINES = 96;
const MAX_CACHED_LINES_PER_DOCUMENT = 8192;

export class PawnDocumentColorProvider implements vscode.DocumentColorProvider {
  private readonly documentCaches = new Map<string, PawnColorLineCache>();

  provideDocumentColors(
    document: vscode.TextDocument,
    token: vscode.CancellationToken
  ): vscode.ColorInformation[] {
    const visibleRanges = vscode.window.visibleTextEditors
      .filter((editor) => editor.document.uri.toString() === document.uri.toString())
      .flatMap((editor) => editor.visibleRanges.map((range) => ({
        startLine: range.start.line,
        endLine: range.end.line,
      })));

    if (visibleRanges.length === 0 || token.isCancellationRequested) return [];

    const visibleLineCount = visibleRanges.reduce(
      (total, range) => total + Math.max(1, range.endLine - range.startLine + 1),
      0
    );
    const prefetchLines = Math.min(
      PREFETCH_MAX_LINES,
      Math.max(PREFETCH_MIN_LINES, Math.ceil(visibleLineCount * 0.75))
    );
    const scanRanges = expandPawnViewportRanges(
      visibleRanges,
      document.lineCount,
      prefetchLines
    );
    const cache = this.getCache(document);
    cache.setCoverage(scanRanges);

    const result: vscode.ColorInformation[] = [];
    const emittedLines = new Set<number>();

    for (const range of scanRanges) {
      if (token.isCancellationRequested) return [];

      // A bounded look-behind establishes block-comment and continued-string
      // state without scanning from the beginning of a multi-megabyte file.
      const contextStart = Math.max(
        0,
        range.startLine - BLOCK_COMMENT_LOOKBEHIND_LINES
      );
      let inBlockComment = false;
      let continuedQuote: "\"" | "'" | undefined;
      const preceding = contextStart > 0
        ? cache.get(document.version, contextStart - 1)
        : undefined;
      if (preceding) {
        inBlockComment = preceding.inBlockComment;
        continuedQuote = preceding.continuedQuote;
      }

      for (let lineNumber = contextStart; lineNumber <= range.endLine; lineNumber++) {
        if (token.isCancellationRequested) return [];

        let lineScan = cache.get(document.version, lineNumber);
        if (!lineScan) {
          lineScan = scanPawnColorLine(
            document.lineAt(lineNumber).text,
            inBlockComment,
            continuedQuote
          );
          cache.set(document.version, lineNumber, lineScan);
        }
        inBlockComment = lineScan.inBlockComment;
        continuedQuote = lineScan.continuedQuote;

        if (lineNumber < range.startLine || emittedLines.has(lineNumber)) continue;
        emittedLines.add(lineNumber);

        lineScan.colors.forEach((color) => {
          result.push(new vscode.ColorInformation(
            new vscode.Range(
              lineNumber,
              color.startColumn,
              lineNumber,
              color.endColumn
            ),
            new vscode.Color(
              color.red,
              color.green,
              color.blue,
              color.alpha
            )
          ));
        });
      }
    }

    return result;
  }

  provideColorPresentations(
    color: vscode.Color,
    context: { document: vscode.TextDocument; range: vscode.Range },
    _token: vscode.CancellationToken
  ): vscode.ColorPresentation[] {
    const literal = context.document.getText(context.range);
    const formatted = formatPawnColorLiteral({
      red: color.red,
      green: color.green,
      blue: color.blue,
      alpha: color.alpha,
    }, literal);
    return formatted
      ? [new vscode.ColorPresentation(formatted)]
      : [];
  }

  isViewportCovered(
    document: vscode.TextDocument,
    visibleRanges: readonly vscode.Range[]
  ): boolean {
    const cache = this.documentCaches.get(document.uri.toString());
    return !!cache && cache.isViewportCovered(visibleRanges.map((range) => ({
      startLine: range.start.line,
      endLine: range.end.line,
    })));
  }

  invalidateDocument(
    document: vscode.TextDocument,
    firstChangedLine: number
  ): void {
    this.documentCaches.get(document.uri.toString())
      ?.invalidateFromLine(document.version, firstChangedLine);
  }

  closeDocument(document: vscode.TextDocument): void {
    this.documentCaches.delete(document.uri.toString());
  }

  dispose(): void {
    this.documentCaches.clear();
  }

  private getCache(document: vscode.TextDocument): PawnColorLineCache {
    const uri = document.uri.toString();
    let cache = this.documentCaches.get(uri);
    if (!cache) {
      cache = new PawnColorLineCache(
        document.version,
        MAX_CACHED_LINES_PER_DOCUMENT
      );
      this.documentCaches.set(uri, cache);
    } else {
      cache.ensureVersion(document.version);
    }
    return cache;
  }
}
