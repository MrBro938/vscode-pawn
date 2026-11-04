export type PawnTokenKind = "identifier" | "comment" | "string" | "number" | "punctuation";

export interface PawnToken {
  value: string;
  start: number;
  end: number;
  kind: PawnTokenKind;
}

/**
 * Lightweight Pawn lexer shared by references, rename and semantic tokens.
 * Comments and strings are emitted as separate tokens so identifiers inside
 * them are never mistaken for code references.
 */
export const tokenizePawn = (source: string): PawnToken[] => {
  const tokens: PawnToken[] = [];
  let index = 0;

  while (index < source.length) {
    const character = source[index];
    const next = source[index + 1];

    if (/\s/.test(character)) {
      index++;
      continue;
    }

    if (character === "/" && next === "/") {
      const start = index;
      index += 2;
      while (index < source.length && source[index] !== "\n") index++;
      tokens.push({ value: source.slice(start, index), start, end: index, kind: "comment" });
      continue;
    }

    if (character === "/" && next === "*") {
      const start = index;
      index += 2;
      while (index < source.length && !(source[index] === "*" && source[index + 1] === "/")) {
        index++;
      }
      if (index < source.length) index += 2;
      tokens.push({ value: source.slice(start, index), start, end: index, kind: "comment" });
      continue;
    }

    if (character === "\"" || character === "'") {
      const quote = character;
      const start = index++;
      while (index < source.length) {
        if (source[index] === "\\") {
          index = Math.min(source.length, index + 2);
          continue;
        }
        if (source[index] === quote) {
          index++;
          break;
        }
        index++;
      }
      tokens.push({ value: source.slice(start, index), start, end: index, kind: "string" });
      continue;
    }

    if (/[A-Za-z_@]/.test(character)) {
      const start = index++;
      while (index < source.length && /[A-Za-z0-9_@]/.test(source[index])) index++;
      tokens.push({ value: source.slice(start, index), start, end: index, kind: "identifier" });
      continue;
    }

    if (/[0-9]/.test(character)) {
      const start = index++;
      while (index < source.length && /[A-Za-z0-9_.]/.test(source[index])) index++;
      tokens.push({ value: source.slice(start, index), start, end: index, kind: "number" });
      continue;
    }

    tokens.push({
      value: character,
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
