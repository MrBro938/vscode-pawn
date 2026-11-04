import { PawnToken, tokenizePawn } from "./symbols";

export type PawnSymbolKind =
  | "function"
  | "macro"
  | "global"
  | "local"
  | "parameter"
  | "enum"
  | "enumMember"
  | "type";

export interface PawnSymbol {
  name: string;
  kind: PawnSymbolKind;
  start: number;
  end: number;
  scopeStart: number;
  scopeEnd: number;
  isArray?: boolean;
  detail?: string;
  /** Pawn preprocessor placeholders in the macro pattern, e.g. ["%1", "%2"]. */
  macroParameters?: string[];
  /** The pattern suffix immediately following the macro name, e.g. "(%1,%2)" or "[%1]". */
  macroPattern?: string;
  /** Text substituted by the preprocessor when the macro is invoked. */
  macroReplacement?: string;
  /** Documentation comment immediately preceding the #define directive. */
  documentation?: string;
}

export interface PawnAnalysis {
  text: string;
  tokens: PawnToken[];
  symbols: PawnSymbol[];
}

interface FunctionRegion {
  name: string;
  start: number;
  end: number;
  openToken: number;
  closeToken: number;
}

const keywords = new Set([
  "if", "else", "while", "for", "do", "switch", "case", "default",
  "return", "break", "continue", "goto", "new", "const", "static",
  "public", "stock", "native", "forward", "enum", "sizeof", "state",
  "true", "false", "defined", "operator", "assert", "exit", "sleep",
  "tagof", "and", "or", "not", "decl", "char", "bool"
]);

const isPunctuation = (token: PawnToken | undefined, value: string) =>
  token !== undefined && token.kind === "punctuation" && token.value === value;

const findMatching = (
  tokens: PawnToken[],
  startIndex: number,
  open: string,
  close: string
): number => {
  let depth = 0;
  for (let index = startIndex; index < tokens.length; index++) {
    if (isPunctuation(tokens[index], open)) depth++;
    else if (isPunctuation(tokens[index], close)) {
      depth--;
      if (depth === 0) return index;
    }
  }
  return -1;
};

const addSymbol = (
  symbols: PawnSymbol[],
  symbol: PawnSymbol
) => {
  if (symbol.start < 0 || symbol.end <= symbol.start) return;
  symbols.push(symbol);
};

const linePrefix = (text: string, offset: number): string => {
  const lineStart = text.lastIndexOf("\n", Math.max(0, offset - 1)) + 1;
  return text.slice(lineStart, offset);
};

const looksLikeFunctionDeclaration = (
  text: string,
  tokens: PawnToken[],
  index: number,
  closeParen: number
): boolean => {
  const token = tokens[index];
  const prefix = linePrefix(text, token.start);
  if (!/^\s*(?:(?:public|stock|static|native|forward)\s+|[A-Za-z_@][A-Za-z0-9_@]*:\s*)*$/.test(prefix)) {
    return false;
  }

  let next = closeParen + 1;
  while (next < tokens.length && tokens[next].kind === "comment") next++;
  if (isPunctuation(tokens[next], ":")) next += 2; // optional state name
  if (isPunctuation(tokens[next], "{")) return true;

  // Semicolon-terminated declarations must be explicit prototypes; otherwise
  // a call at file scope could be mistaken for a function declaration.
  if (isPunctuation(tokens[next], ";")) {
    return /\b(?:forward|native|stock)\s+/.test(prefix);
  }

  // A function body may put its opening brace on the next line.
  if (next < tokens.length && tokens[next].value === "{") return true;
  return false;
};

const splitTopLevel = (
  tokens: PawnToken[],
  start: number,
  end: number,
  delimiter: string
): Array<[number, number]> => {
  const result: Array<[number, number]> = [];
  let segmentStart = start;
  let round = 0;
  let square = 0;
  let curly = 0;

  for (let index = start; index < end; index++) {
    const token = tokens[index];
    if (isPunctuation(token, "(")) round++;
    else if (isPunctuation(token, ")")) round--;
    else if (isPunctuation(token, "[")) square++;
    else if (isPunctuation(token, "]")) square--;
    else if (isPunctuation(token, "{")) curly++;
    else if (isPunctuation(token, "}")) curly--;

    if (
      isPunctuation(token, delimiter) &&
      round === 0 && square === 0 && curly === 0
    ) {
      result.push([segmentStart, index]);
      segmentStart = index + 1;
    }
  }

  if (segmentStart < end) result.push([segmentStart, end]);
  return result;
};

const findDeclaredName = (
  tokens: PawnToken[],
  start: number,
  end: number
): { token: PawnToken; isArray: boolean } | undefined => {
  let limit = end;
  for (let index = start; index < end; index++) {
    if (isPunctuation(tokens[index], "=")) {
      limit = index;
      break;
    }
  }

  for (let index = start; index < limit; index++) {
    if (isPunctuation(tokens[index], "[")) {
      limit = index;
      break;
    }
  }

  const candidates: PawnToken[] = [];
  for (let index = start; index < limit; index++) {
    const token = tokens[index];
    if (token.kind !== "identifier" || keywords.has(token.value.toLowerCase())) continue;
    if (isPunctuation(tokens[index + 1], ":")) continue;
    candidates.push(token);
  }

  const name = candidates[candidates.length - 1];
  if (!name) return undefined;

  const isArray = isPunctuation(tokens[limit], "[");
  return { token: name, isArray };
};

const getLeadingMacroDocumentation = (
  text: string,
  lineStart: number
): string | undefined => {
  const lines = text.slice(0, lineStart).split(/\r?\n/);
  let index = lines.length - 1;

  while (index >= 0 && !lines[index].trim()) index--;
  if (index < 0) return undefined;

  const lastLine = lines[index].trim();
  if (lastLine.endsWith("*/")) {
    const end = index;
    while (index >= 0 && !lines[index].includes("/*")) index--;
    if (index < 0) return undefined;
    return lines.slice(index, end + 1)
      .join("\n")
      .replace(/^\s*\/\*\*?/, "")
      .replace(/\*\/\s*$/, "")
      .split("\n")
      .map((line) => line.replace(/^\s*\* ?/, "").trimEnd())
      .join("\n")
      .trim() || undefined;
  }

  if (lastLine.startsWith("//")) {
    const comments: string[] = [];
    while (index >= 0 && lines[index].trim().startsWith("//")) {
      comments.unshift(lines[index].replace(/^\s*\/\/!? ?/, ""));
      index--;
    }
    return comments.join("\n").trim() || undefined;
  }

  return undefined;
};

/**
 * Parse Pawn #define directives. Pawn macro arguments are positional
 * placeholders (%1..%9 and %0) embedded in the match pattern, not named
 * C-style parameters. A backslash at end of a directive joins the next line.
 */
const extractPawnMacroSymbols = (
  text: string,
  tokens: PawnToken[]
): PawnSymbol[] => {
  const symbols: PawnSymbol[] = [];
  const nonCodeTokens = tokens.filter((token) =>
    token.kind === "comment" || token.kind === "string"
  );
  let nonCodeIndex = 0;
  let lineStart = 0;

  const isInsideNonCode = (offset: number): boolean => {
    while (
      nonCodeIndex < nonCodeTokens.length &&
      nonCodeTokens[nonCodeIndex].end <= offset
    ) {
      nonCodeIndex++;
    }
    const token = nonCodeTokens[nonCodeIndex];
    return !!token && token.start <= offset && offset < token.end;
  };

  while (lineStart <= text.length) {
    const firstLineEnd = text.indexOf("\n", lineStart);
    const currentLineEnd = firstLineEnd === -1 ? text.length : firstLineEnd;
    const firstLine = text.slice(lineStart, currentLineEnd).replace(/\r$/, "");
    const directiveOffset = firstLine.search(/\S/);

    if (
      directiveOffset !== -1 &&
      /^\s*#\s*define\b/.test(firstLine) &&
      !isInsideNonCode(lineStart + directiveOffset)
    ) {
      let logicalLine = firstLine;
      let finalLineEnd = currentLineEnd;

      while (/\\\s*$/.test(logicalLine) && finalLineEnd < text.length) {
        logicalLine = logicalLine.replace(/\\\s*$/, "");
        const nextLineStart = finalLineEnd + 1;
        const nextLineEndIndex = text.indexOf("\n", nextLineStart);
        const nextLineEnd = nextLineEndIndex === -1
          ? text.length
          : nextLineEndIndex;
        const nextLine = text.slice(nextLineStart, nextLineEnd).replace(/\r$/, "");
        logicalLine += nextLine.replace(/^\s+/, "");
        finalLineEnd = nextLineEnd;
      }

      const match = /^\s*#\s*define\s+([A-Za-z_@][A-Za-z0-9_@]*)/.exec(logicalLine);
      if (match) {
        const name = match[1];
        const relativeNameStart = match[0].lastIndexOf(name);
        const start = lineStart + relativeNameStart;
        const tail = logicalLine.slice(relativeNameStart + name.length);

        let macroPattern = "";
        let macroReplacement = tail.trim();
        // Pawn requires the macro matching pattern to be adjacent to its name.
        if (tail && !/^\s/.test(tail)) {
          const whitespace = tail.search(/\s/);
          if (whitespace === -1) {
            macroPattern = tail;
            macroReplacement = "";
          } else {
            macroPattern = tail.slice(0, whitespace);
            macroReplacement = tail.slice(whitespace).trim();
          }
        }

        const macroParameters = Array.from(new Set(
          macroPattern.match(/%[0-9]/g) || []
        ));
        const displayPattern = macroPattern.replace(/,/g, ", ");
        const signature = name + displayPattern;
        const documentation = getLeadingMacroDocumentation(text, lineStart);

        addSymbol(symbols, {
          name,
          kind: "macro",
          start,
          end: start + name.length,
          scopeStart: 0,
          scopeEnd: text.length,
          detail: macroPattern ? signature : undefined,
          macroParameters,
          macroPattern,
          macroReplacement: macroReplacement || undefined,
          documentation,
        });
      }

      lineStart = finalLineEnd >= text.length ? text.length + 1 : finalLineEnd + 1;
    } else {
      lineStart = currentLineEnd >= text.length ? text.length + 1 : currentLineEnd + 1;
    }
  }

  return symbols;
};

export const analyzePawn = (text: string): PawnAnalysis => {
  const tokens = tokenizePawn(text);
  const symbols: PawnSymbol[] = [];
  const functions: FunctionRegion[] = [];
  const bracePairs = new Map<number, number>();
  const braceStack: number[] = [];
  const braceDepths: number[] = [];
  let braceDepth = 0;

  tokens.forEach((token, index) => {
    if (isPunctuation(token, "}")) braceDepth = Math.max(0, braceDepth - 1);
    braceDepths[index] = braceDepth;

    if (isPunctuation(token, "{")) {
      braceStack.push(index);
      braceDepth++;
    } else if (isPunctuation(token, "}")) {
      const open = braceStack.pop();
      if (open !== undefined) bracePairs.set(open, index);
    }
  });

  // Pawn functions are declared at file scope. This prevents ordinary calls
  // inside function bodies from being mistaken for declarations.
  for (let index = 0; index < tokens.length - 1; index++) {
    const nameToken = tokens[index];
    if (braceDepths[index] !== 0) continue;
    if (nameToken.kind !== "identifier" || keywords.has(nameToken.value.toLowerCase())) continue;
    if (!isPunctuation(tokens[index + 1], "(")) continue;

    const closeParen = findMatching(tokens, index + 1, "(", ")");
    if (closeParen === -1 || !looksLikeFunctionDeclaration(text, tokens, index, closeParen)) continue;

    let next = closeParen + 1;
    if (isPunctuation(tokens[next], ":")) next += 2;

    addSymbol(symbols, {
      name: nameToken.value,
      kind: "function",
      start: nameToken.start,
      end: nameToken.end,
      scopeStart: 0,
      scopeEnd: text.length,
      detail: text.slice(nameToken.start, tokens[closeParen].end).trim(),
    });

    // Forward/native declarations have no local scope. Only index parameters
    // when a function body exists.
    if (!isPunctuation(tokens[next], "{")) continue;

    const closeBrace = bracePairs.get(next);
    if (closeBrace === undefined) continue;

    const scopeStart = tokens[next].end;
    const scopeEnd = tokens[closeBrace].start;

    functions.push({
      name: nameToken.value,
      start: scopeStart,
      end: scopeEnd,
      openToken: next,
      closeToken: closeBrace,
    });

    const parameters = splitTopLevel(tokens, index + 2, closeParen, ",");
    parameters.forEach(([paramStart, paramEnd]) => {
      if (paramStart >= paramEnd) return;
      const declared = findDeclaredName(tokens, paramStart, paramEnd);
      if (!declared) return;

      addSymbol(symbols, {
        name: declared.token.value,
        kind: "parameter",
        start: declared.token.start,
        end: declared.token.end,
        scopeStart,
        scopeEnd,
        isArray: declared.isArray,
        detail: text.slice(tokens[paramStart].start, tokens[paramEnd - 1].end),
      });
    });
  }

  // Register enum names and their members.
  for (let index = 0; index < tokens.length; index++) {
    if (tokens[index].value.toLowerCase() !== "enum") continue;

    let nameIndex = index + 1;
    let enumName: PawnToken | undefined;
    if (
      tokens[nameIndex]?.kind === "identifier" &&
      (isPunctuation(tokens[nameIndex + 1], "{") ||
        isPunctuation(tokens[nameIndex + 1], ":"))
    ) {
      enumName = tokens[nameIndex];
      nameIndex++;
    }
    while (nameIndex < tokens.length && !isPunctuation(tokens[nameIndex], "{") &&
      tokens[nameIndex].kind !== "comment") nameIndex++;
    if (!isPunctuation(tokens[nameIndex], "{")) continue;

    const close = bracePairs.get(nameIndex);
    if (close === undefined) continue;

    if (enumName) {
      addSymbol(symbols, {
        name: enumName.value,
        kind: "enum",
        start: enumName.start,
        end: enumName.end,
        scopeStart: 0,
        scopeEnd: text.length,
      });
      addSymbol(symbols, {
        name: enumName.value,
        kind: "type",
        start: enumName.start,
        end: enumName.end,
        scopeStart: 0,
        scopeEnd: text.length,
      });
    }

    const members = splitTopLevel(tokens, nameIndex + 1, close, ",");
    members.forEach(([memberStart, memberEnd]) => {
      const declared = findDeclaredName(tokens, memberStart, memberEnd);
      if (!declared) return;

      addSymbol(symbols, {
        name: declared.token.value,
        kind: "enumMember",
        start: declared.token.start,
        end: declared.token.end,
        scopeStart: 0,
        scopeEnd: text.length,
        isArray: declared.isArray,
        detail: enumName ? enumName.value : "enum",
      });
    });
    index = close;
  }

  // Register Pawn #define macros, including positional parameters and patterns.
  extractPawnMacroSymbols(text, tokens).forEach((symbol) => addSymbol(symbols, symbol));

  // Discover new/static variable declarations and distinguish globals from locals.
  for (let index = 0; index < tokens.length; index++) {
    const keyword = tokens[index].value.toLowerCase();
    if (keyword !== "new" && keyword !== "static") continue;
    if (tokens[index].kind !== "identifier") continue;

    // "static" can also be a function modifier. Do not parse the function
    // header as a variable declaration.
    if (keyword === "static") {
      const lineEnd = text.indexOf("\n", tokens[index].start);
      const declarationEnd = lineEnd === -1 ? text.length : lineEnd;
      const isFunctionModifier = symbols.some((symbol) =>
        symbol.kind === "function" &&
        symbol.start > tokens[index].start &&
        symbol.start < declarationEnd
      );
      if (isFunctionModifier) continue;
    }

    const functionRegion = functions
      .filter((region) => tokens[index].start >= region.start && tokens[index].start <= region.end)
      .sort((a, b) => (a.end - a.start) - (b.end - b.start))[0];

    let statementEnd = index + 1;
    let round = 0;
    let square = 0;
    let curly = 0;
    for (; statementEnd < tokens.length; statementEnd++) {
      const token = tokens[statementEnd];
      if (isPunctuation(token, "(")) round++;
      else if (isPunctuation(token, ")")) round--;
      else if (isPunctuation(token, "[")) square++;
      else if (isPunctuation(token, "]")) square--;
      else if (isPunctuation(token, "{")) curly++;
      else if (isPunctuation(token, "}")) {
        if (curly === 0) break;
        curly--;
      } else if (
        isPunctuation(token, ";") &&
        round === 0 && square === 0 && curly === 0
      ) {
        break;
      }
    }
    if (!isPunctuation(tokens[statementEnd], ";")) continue;

    let scopeStart = functionRegion ? functionRegion.start : 0;
    let scopeEnd = functionRegion ? functionRegion.end : text.length;

    if (functionRegion) {
      const enclosingBlocks = Array.from(bracePairs.entries())
        .filter(([open, close]) =>
          open >= functionRegion.openToken &&
          close <= functionRegion.closeToken &&
          tokens[open].start < tokens[index].start &&
          tokens[close].start > tokens[index].start
        )
        .sort((left, right) =>
          (tokens[left[1]].start - tokens[left[0]].start) -
          (tokens[right[1]].start - tokens[right[0]].start)
        );

      const innermostBlock = enclosingBlocks[0];
      if (innermostBlock) {
        scopeStart = tokens[innermostBlock[0]].end;
        scopeEnd = tokens[innermostBlock[1]].start;
      }
    }

    const declarations = splitTopLevel(tokens, index + 1, statementEnd, ",");
    declarations.forEach(([declStart, declEnd]) => {
      if (declStart >= declEnd) return;
      const declared = findDeclaredName(tokens, declStart, declEnd);
      if (!declared) return;

      addSymbol(symbols, {
        name: declared.token.value,
        kind: functionRegion ? "local" : "global",
        start: declared.token.start,
        end: declared.token.end,
        scopeStart,
        scopeEnd,
        isArray: declared.isArray,
        detail: text.slice(tokens[declStart].start, tokens[declEnd - 1].end),
      });
    });

    index = statementEnd;
  }

  return { text, tokens, symbols };
};

export const resolvePawnSymbol = (
  analysis: PawnAnalysis,
  uri: string,
  offset: number,
  workspace: PawnAnalysis[]
): PawnSymbol | undefined => {
  const currentToken = analysis.tokens.find(
    (token) => token.kind === "identifier" && offset >= token.start && offset <= token.end
  );
  if (!currentToken) return undefined;

  const name = currentToken.value;
  const localCandidates = analysis.symbols
    .filter((symbol) =>
      (symbol.kind === "local" || symbol.kind === "parameter") &&
      symbol.name === name &&
      offset >= symbol.scopeStart &&
      offset <= symbol.scopeEnd &&
      symbol.start <= offset
    )
    .sort((a, b) => b.start - a.start);
  if (localCandidates.length > 0) return localCandidates[0];

  const declaration = analysis.symbols.find(
    (symbol) => symbol.name === name && symbol.start <= offset && offset <= symbol.end
  );
  if (declaration) return declaration;

  const nextToken = analysis.tokens.find((token) => token.start === currentToken.end);
  if (nextToken?.value === ":") {
    for (const candidate of workspace) {
      const typeSymbol = candidate.symbols.find((symbol) =>
        symbol.kind === "type" && symbol.name === name
      );
      if (typeSymbol) return typeSymbol;
    }
  }

  const expectedFunction = nextToken?.value === "(";
  const globalKinds: PawnSymbolKind[] = expectedFunction
    ? ["function", "macro"]
    : ["macro", "global", "enumMember"];

  const localGlobal = analysis.symbols.find((symbol) =>
    globalKinds.includes(symbol.kind) && symbol.name === name
  );
  if (localGlobal) return localGlobal;

  for (const candidate of workspace) {
    const found = candidate.symbols.find((symbol) =>
      globalKinds.includes(symbol.kind) && symbol.name === name
    );
    if (found) return found;
  }

  return undefined;
};

export const getBoundOccurrences = (
  target: PawnSymbol,
  targetUri: string,
  workspace: Array<{ uri: string; analysis: PawnAnalysis }>
): Array<{ uri: string; token: PawnToken }> => {
  const occurrences: Array<{ uri: string; token: PawnToken }> = [];
  const localSymbol = target.kind === "local" || target.kind === "parameter";

  workspace.forEach(({ uri, analysis }) => {
    if (localSymbol && uri !== targetUri) return;

    analysis.tokens.forEach((token) => {
      if (token.kind !== "identifier" || token.value !== target.name) return;

      if (localSymbol) {
        const isDeclaration = token.start === target.start;
        if (!isDeclaration && (
          token.start < target.scopeStart ||
          token.start > target.scopeEnd ||
          token.start < target.start
        )) return;

        const shadowing = analysis.symbols
          .filter((symbol) =>
            (symbol.kind === "local" || symbol.kind === "parameter") &&
            symbol.name === target.name &&
            token.start >= symbol.scopeStart &&
            token.start <= symbol.scopeEnd &&
            symbol.start <= token.start
          )
          .sort((a, b) => b.start - a.start)[0];

        if (shadowing && shadowing.start !== target.start) return;
      } else {
        const shadowing = analysis.symbols.some((symbol) =>
          (symbol.kind === "local" || symbol.kind === "parameter") &&
          symbol.name === target.name &&
          token.start >= symbol.scopeStart &&
          token.start <= symbol.scopeEnd &&
          symbol.start <= token.start
        );
        if (shadowing) return;
      }

      occurrences.push({ uri, token });
    });
  });

  return occurrences;
};
