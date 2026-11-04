export type PawnTokenKind = "identifier" | "comment" | "string" | "number" | "punctuation";

export interface PawnToken {
  value: string;
  start: number;
  end: number;
  kind: PawnTokenKind;
}

/**
 * Pawn lexer character checks. The common ASCII path avoids running regular
 * expressions for every character in large gamemodes, while non-ASCII
 * whitespace keeps the same ECMAScript \s behavior as the original lexer.
 */
const isPawnWhitespace = (code: number): boolean => {
  if (code === 0x20 || (code >= 0x09 && code <= 0x0d)) return true;
  return code === 0x00a0 ||
    code === 0x1680 ||
    (code >= 0x2000 && code <= 0x200a) ||
    code === 0x2028 ||
    code === 0x2029 ||
    code === 0x202f ||
    code === 0x205f ||
    code === 0x3000 ||
    code === 0xfeff;
};

const isIdentifierStart = (code: number): boolean =>
  (code >= 0x41 && code <= 0x5a) ||
  (code >= 0x61 && code <= 0x7a) ||
  code === 0x5f ||
  code === 0x40;

const isIdentifierPart = (code: number): boolean =>
  isIdentifierStart(code) || (code >= 0x30 && code <= 0x39);

const isNumberPart = (code: number): boolean =>
  (code >= 0x41 && code <= 0x5a) ||
  (code >= 0x61 && code <= 0x7a) ||
  (code >= 0x30 && code <= 0x39) ||
  code === 0x5f ||
  code === 0x2e;

/**
 * Lightweight Pawn lexer shared by references, rename and semantic tokens.
 * Comments and strings are emitted as separate tokens so identifiers inside
 * them are never mistaken for code references.
 */
export const tokenizePawn = (source: string): PawnToken[] => {
  const tokens: PawnToken[] = [];
  const length = source.length;
  let index = 0;

  while (index < length) {
    const code = source.charCodeAt(index);
    const nextCode = index + 1 < length ? source.charCodeAt(index + 1) : 0;

    if (isPawnWhitespace(code)) {
      index++;
      continue;
    }

    if (code === 0x2f && nextCode === 0x2f) {
      const start = index;
      index += 2;
      while (index < length && source.charCodeAt(index) !== 0x0a) index++;
      tokens.push({ value: source.slice(start, index), start, end: index, kind: "comment" });
      continue;
    }

    if (code === 0x2f && nextCode === 0x2a) {
      const start = index;
      index += 2;
      while (index < length &&
        !(source.charCodeAt(index) === 0x2a &&
          source.charCodeAt(index + 1) === 0x2f)) {
        index++;
      }
      if (index < length) index += 2;
      tokens.push({ value: source.slice(start, index), start, end: index, kind: "comment" });
      continue;
    }

    if (code === 0x22 || code === 0x27) {
      const quote = code;
      const start = index++;
      while (index < length) {
        const current = source.charCodeAt(index);
        if (current === 0x5c) {
          index = Math.min(length, index + 2);
          continue;
        }
        if (current === quote) {
          index++;
          break;
        }
        index++;
      }
      tokens.push({ value: source.slice(start, index), start, end: index, kind: "string" });
      continue;
    }

    if (isIdentifierStart(code)) {
      const start = index++;
      while (index < length && isIdentifierPart(source.charCodeAt(index))) index++;
      tokens.push({ value: source.slice(start, index), start, end: index, kind: "identifier" });
      continue;
    }

    if (code >= 0x30 && code <= 0x39) {
      const start = index++;
      while (index < length && isNumberPart(source.charCodeAt(index))) index++;
      tokens.push({ value: source.slice(start, index), start, end: index, kind: "number" });
      continue;
    }

    tokens.push({
      value: source[index],
      start: index,
      end: index + 1,
      kind: "punctuation",
    });
    index++;
  }

  return tokens;
};

export const findPawnIdentifierAt = (
  source: string,
  offset: number
): PawnToken | undefined => {
  return tokenizePawn(source).find(
    (token) =>
      token.kind === "identifier" &&
      offset >= token.start &&
      offset <= token.end
  );
};

export const findPawnIdentifierOccurrences = (
  source: string,
  identifier: string
): PawnToken[] => {
  const normalized = identifier.toLowerCase();
  return tokenizePawn(source).filter(
    (token) =>
      token.kind === "identifier" &&
      token.value.toLowerCase() === normalized
  );
};


/**
 * Return true when an identifier is used as a function-style invocation.
 * This is a syntax-only fallback for semantic highlighting: a Pawn module may
 * be included by a gamemode that imports natives such as a_samp, without
 * including those declarations directly in the module itself.
 */
export const isPawnFunctionInvocation = (
  tokens: PawnToken[],
  tokenIndex: number
): boolean => {
  if (tokens[tokenIndex]?.kind !== "identifier") return false;

  let nextIndex = tokenIndex + 1;
  while (tokens[nextIndex]?.kind === "comment") nextIndex++;

  return tokens[nextIndex]?.kind === "punctuation" &&
    tokens[nextIndex].value === "(";
};
