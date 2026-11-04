export interface PawnColorLiteral {
  startColumn: number;
  endColumn: number;
  red: number;
  green: number;
  blue: number;
  alpha: number;
}

export interface PawnColorIdentifier {
  name: string;
  startColumn: number;
  endColumn: number;
}

export interface PawnColorLineScan {
  colors: PawnColorLiteral[];
  identifiers: PawnColorIdentifier[];
  inBlockComment: boolean;
  continuedQuote?: "\"" | "'";
}

export interface PawnLineRange {
  startLine: number;
  endLine: number;
}

export interface PawnColorValue {
  red: number;
  green: number;
  blue: number;
  alpha: number;
}

const isIdentifierCharacter = (value: string | undefined): boolean =>
  value !== undefined && /[A-Za-z0-9_@]/.test(value);

const isIdentifierStart = (value: string | undefined): boolean =>
  value !== undefined && /[A-Za-z_@]/.test(value);

const isHexCharacter = (value: string | undefined): boolean =>
  value !== undefined && /[0-9A-Fa-f]/.test(value);

const hasUnescapedTrailingBackslash = (line: string): boolean => {
  let count = 0;
  for (let index = line.length - 1; index >= 0 && line[index] === "\\"; index--) {
    count++;
  }
  return count % 2 === 1;
};

/**
 * Finds Pawn/SA-MP color literals on one line without lexing the rest of a file.
 * Six digits are RGB; eight digits use the common Pawn/SA-MP RGBA layout.
 * Comments and ordinary quoted-string contents are skipped; {RRGGBB} tags
 * inside strings are returned. Block comments and continued strings are
 * tracked across line boundaries.
 */
export const scanPawnColorLine = (
  line: string,
  startsInBlockComment = false,
  continuesQuote?: "\"" | "'"
): PawnColorLineScan => {
  const colors: PawnColorLiteral[] = [];
  const identifiers: PawnColorIdentifier[] = [];
  const isPreprocessorLine = /^\s*#/.test(line);
  let inBlockComment = startsInBlockComment;
  let quote: "\"" | "'" | undefined = continuesQuote;
  let escaped = false;
  let index = 0;

  while (index < line.length) {
    const current = line[index];
    const next = line[index + 1];

    if (inBlockComment) {
      if (current === "*" && next === "/") {
        inBlockComment = false;
        index += 2;
      } else {
        index++;
      }
      continue;
    }

    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (current === "\\") {
        escaped = true;
      } else if (current === quote) {
        quote = undefined;
      } else if (current === "{") {
        // SA-MP inline text color: {RRGGBB}. Only recognize this syntax
        // inside a quoted Pawn string, never as an ordinary code token.
        const colorEnd = index + 7;
        if (
          line[colorEnd] === "}" &&
          isHexCharacter(line[index + 1]) &&
          isHexCharacter(line[index + 2]) &&
          isHexCharacter(line[index + 3]) &&
          isHexCharacter(line[index + 4]) &&
          isHexCharacter(line[index + 5]) &&
          isHexCharacter(line[index + 6])
        ) {
          const digits = line.slice(index + 1, colorEnd);
          colors.push({
            startColumn: index,
            endColumn: colorEnd + 1,
            red: parseInt(digits.slice(0, 2), 16) / 255,
            green: parseInt(digits.slice(2, 4), 16) / 255,
            blue: parseInt(digits.slice(4, 6), 16) / 255,
            alpha: 1,
          });
          index = colorEnd + 1;
          continue;
        }
      }
      index++;
      continue;
    }

    if (current === "/" && next === "*") {
      inBlockComment = true;
      index += 2;
      continue;
    }
    if (current === "/" && next === "/") break;
    if (current === "\"" || current === "'") {
      quote = current;
      index++;
      continue;
    }

    if (isIdentifierStart(current)) {
      const start = index++;
      while (isIdentifierCharacter(line[index])) index++;
      if (!isPreprocessorLine) {
        identifiers.push({
          name: line.slice(start, index),
          startColumn: start,
          endColumn: index,
        });
      }
      continue;
    }

    if (
      current !== "0" ||
      (next !== "x" && next !== "X") ||
      isIdentifierCharacter(line[index - 1])
    ) {
      index++;
      continue;
    }

    let digitsEnd = index + 2;
    while (isHexCharacter(line[digitsEnd])) digitsEnd++;
    const digitCount = digitsEnd - (index + 2);
    if (
      (digitCount !== 6 && digitCount !== 8) ||
      isIdentifierCharacter(line[digitsEnd])
    ) {
      index = Math.max(index + 2, digitsEnd);
      continue;
    }

    const digits = line.slice(index + 2, digitsEnd);
    colors.push({
      startColumn: index,
      endColumn: digitsEnd,
      red: parseInt(digits.slice(0, 2), 16) / 255,
      green: parseInt(digits.slice(2, 4), 16) / 255,
      blue: parseInt(digits.slice(4, 6), 16) / 255,
      alpha: digitCount === 8
        ? parseInt(digits.slice(6, 8), 16) / 255
        : 1,
    });
    index = digitsEnd;
  }

  return {
    colors,
    identifiers,
    inBlockComment,
    continuedQuote: quote && hasUnescapedTrailingBackslash(line)
      ? quote
      : undefined,
  };
};

const toHexByte = (value: number): string =>
  Math.round(Math.min(1, Math.max(0, value)) * 255)
    .toString(16)
    .padStart(2, "0");

/**
 * Rewrites a color using the literal's existing prefix and hex casing.
 * RGB literals grow to RGBA only when the picker introduces transparency.
 * Eight-digit Pawn/SA-MP literals retain their trailing alpha byte.
 */
export const formatPawnColorLiteral = (
  color: PawnColorValue,
  originalLiteral: string
): string | undefined => {
  const hexMatch = /^(0[xX])([0-9A-Fa-f]{6}|[0-9A-Fa-f]{8})$/.exec(originalLiteral);
  const textTagMatch = /^\{([0-9A-Fa-f]{6})\}$/.exec(originalLiteral);
  if (!hexMatch && !textTagMatch) return undefined;

  const originalDigits = hexMatch ? hexMatch[2] : textTagMatch![1];
  const uppercase = /[A-F]/.test(originalDigits) ||
    (!/[a-f]/.test(originalDigits) && !!hexMatch && /X/.test(hexMatch[1]));
  const formatByte = (value: number) => {
    const result = toHexByte(value);
    return uppercase ? result.toUpperCase() : result;
  };

  const rgb = [
    formatByte(color.red),
    formatByte(color.green),
    formatByte(color.blue),
  ].join("");

  // SA-MP's {RRGGBB} string tag has no alpha component. Keep its exact
  // six-digit shape even when the picker reports a transparent color.
  if (textTagMatch) return `{${rgb}}`;

  const includeAlpha = originalDigits.length === 8 || color.alpha < 1;
  const alpha = includeAlpha ? formatByte(color.alpha) : "";
  return hexMatch![1] + rgb + alpha;
};

export const expandPawnViewportRanges = (
  visibleRanges: readonly PawnLineRange[],
  lineCount: number,
  prefetchLines = 80
): PawnLineRange[] => {
  if (lineCount <= 0 || visibleRanges.length === 0) return [];

  const margin = Math.max(0, Math.floor(prefetchLines));
  const expanded = visibleRanges
    .filter((range) =>
      Number.isFinite(range.startLine) &&
      Number.isFinite(range.endLine) &&
      range.endLine >= range.startLine
    )
    .map((range) => ({
      startLine: Math.max(0, Math.floor(range.startLine) - margin),
      endLine: Math.min(lineCount - 1, Math.floor(range.endLine) + margin),
    }))
    .sort((left, right) =>
      left.startLine - right.startLine || left.endLine - right.endLine
    );

  const merged: PawnLineRange[] = [];
  expanded.forEach((range) => {
    const previous = merged[merged.length - 1];
    if (!previous || range.startLine > previous.endLine + 1) {
      merged.push({ ...range });
    } else {
      previous.endLine = Math.max(previous.endLine, range.endLine);
    }
  });
  return merged;
};

export const arePawnViewportRangesCovered = (
  visibleRanges: readonly PawnLineRange[],
  coverage: readonly PawnLineRange[]
): boolean => visibleRanges.length > 0 && visibleRanges.every((visible) =>
  coverage.some((range) =>
    range.startLine <= visible.startLine &&
    range.endLine >= visible.endLine
  )
);

/**
 * Per-document, per-line cache. Edits invalidate only the changed suffix;
 * lines before the first changed line remain reusable.
 */
export class PawnColorLineCache {
  private readonly lines = new Map<number, PawnColorLineScan>();
  private coverage: PawnLineRange[] = [];

  constructor(
    private currentVersion: number,
    private readonly maxLines = 8192
  ) {}

  ensureVersion(version: number): void {
    if (version === this.currentVersion) return;
    this.currentVersion = version;
    this.lines.clear();
    this.coverage = [];
  }

  get(version: number, line: number): PawnColorLineScan | undefined {
    this.ensureVersion(version);
    const cached = this.lines.get(line);
    if (!cached) return undefined;
    this.lines.delete(line);
    this.lines.set(line, cached);
    return cached;
  }

  set(version: number, line: number, scan: PawnColorLineScan): void {
    this.ensureVersion(version);
    this.lines.delete(line);
    this.lines.set(line, scan);
    while (this.lines.size > this.maxLines) {
      const oldest = this.lines.keys().next();
      if (oldest.done) break;
      this.lines.delete(oldest.value);
    }
  }

  setCoverage(ranges: readonly PawnLineRange[]): void {
    this.coverage = ranges.map((range) => ({ ...range }));
  }

  isViewportCovered(ranges: readonly PawnLineRange[]): boolean {
    return arePawnViewportRangesCovered(ranges, this.coverage);
  }

  invalidateFromLine(version: number, firstChangedLine: number): void {
    this.currentVersion = version;
    for (const line of this.lines.keys()) {
      if (line >= firstChangedLine) this.lines.delete(line);
    }
    this.coverage = [];
  }

  clear(): void {
    this.lines.clear();
    this.coverage = [];
  }

  get size(): number {
    return this.lines.size;
  }
}
