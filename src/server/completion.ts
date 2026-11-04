import {
  CompletionItem,
  CompletionItemKind,
  InsertTextFormat,
} from "vscode-languageserver";
import { PawnAnalysis, PawnSymbol, PawnSymbolKind } from "./analysis";
import { formatPawnCompletionDetail } from "./symbolDisplay";

export interface PawnCompletionSource {
  uri: string;
  analysis: PawnAnalysis;
}

const localKinds = new Set<PawnSymbolKind>(["local", "parameter"]);

const completionKind = (kind: PawnSymbolKind): CompletionItemKind => {
  switch (kind) {
    case "function": return CompletionItemKind.Function;
    case "macro": return CompletionItemKind.Constant;
    case "enum": return CompletionItemKind.Enum;
    case "enumMember": return CompletionItemKind.EnumMember;
    case "type": return CompletionItemKind.TypeParameter;
    default: return CompletionItemKind.Variable;
  }
};

const formatMacroPattern = (symbol: PawnSymbol): string =>
  (symbol.macroPattern || "").replace(/,/g, ", ");

const buildMacroSnippet = (symbol: PawnSymbol): string => {
  const positions = new Map<string, number>();
  let nextPosition = 1;
  const pattern = (symbol.macroPattern || "").replace(/%[0-9]/g, (placeholder) => {
    let position = positions.get(placeholder);
    if (position === undefined) {
      position = nextPosition++;
      positions.set(placeholder, position);
    }
    return "$" + position;
  });
  return symbol.name + pattern + (symbol.macroParameters?.length ? "$0" : "");
};

export const getPawnMacroSignature = (
  symbol: PawnSymbol
): {
  label: string;
  parameters: Array<{ label: string }>;
  documentation?: string;
} | undefined => {
  if (symbol.kind !== "macro" || !symbol.macroParameters?.length) return undefined;

  return {
    label: symbol.name + formatMacroPattern(symbol),
    parameters: symbol.macroParameters.map((label) => ({ label })),
    documentation: symbol.documentation,
  };
};

const toCompletionItem = (symbol: PawnSymbol): CompletionItem => {
  const macroSignature = getPawnMacroSignature(symbol);
  const isParameterizedMacro = !!macroSignature;
  return {
    label: macroSignature?.label || symbol.name,
    kind: isParameterizedMacro
      ? CompletionItemKind.Function
      : completionKind(symbol.kind),
    detail: symbol.kind === "macro"
      ? symbol.macroReplacement || symbol.detail
      : formatPawnCompletionDetail(symbol),
    documentation: symbol.documentation,
    filterText: symbol.name,
    insertText: isParameterizedMacro ? buildMacroSnippet(symbol) : symbol.name,
    insertTextFormat: isParameterizedMacro ? InsertTextFormat.Snippet : undefined,
  };
};

const pawnKeywords = [
  "and", "assert", "bool", "break", "case", "char", "const", "continue",
  "decl", "default", "defined", "do", "else", "enum", "exit", "false",
  "for", "forward", "goto", "if", "native", "new", "not", "operator",
  "or", "public", "return", "sizeof", "sleep", "state", "static", "stock",
  "switch", "tagof", "true", "Float", "while"
];

/**
 * Build completion candidates from the active file and its resolved include
 * closure. Local declarations are offered only after their declaration and
 * while their lexical scope is active. Included files contribute globals only.
 */
export const buildPawnCompletionItems = (
  currentUri: string,
  offset: number,
  sources: readonly PawnCompletionSource[]
): CompletionItem[] => {
  const current = sources.find((source) => source.uri === currentUri);
  const orderedSources = current
    ? [current, ...sources.filter((source) => source.uri !== currentUri)]
    : Array.from(sources);

  const items: CompletionItem[] = [];
  const seen = new Set<string>();

  const add = (symbol: PawnSymbol) => {
    const key = symbol.name.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    items.push(toCompletionItem(symbol));
  };

  if (current) {
    const visibleLocals = current.analysis.symbols
      .filter((symbol) =>
        localKinds.has(symbol.kind) &&
        symbol.start <= offset &&
        offset >= symbol.scopeStart &&
        offset <= symbol.scopeEnd
      )
      // Prefer the innermost active scope, then the latest declaration.
      .sort((left, right) =>
        (left.scopeEnd - left.scopeStart) - (right.scopeEnd - right.scopeStart) ||
        right.start - left.start
      );

    visibleLocals.forEach(add);
  }

  orderedSources.forEach(({ analysis }) => {
    analysis.symbols.forEach((symbol) => {
      if (localKinds.has(symbol.kind)) return;
      add(symbol);
    });
  });

  pawnKeywords.forEach((keyword) => {
    const key = keyword.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    items.push({
      label: keyword,
      kind: CompletionItemKind.Keyword,
      filterText: keyword,
      insertText: keyword,
    });
  });

  return items;
};
