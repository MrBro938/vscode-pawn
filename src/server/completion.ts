import {
  CompletionItem,
  CompletionItemKind,
} from "vscode-languageserver";
import { PawnAnalysis, PawnSymbol, PawnSymbolKind } from "./analysis";

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

const toCompletionItem = (symbol: PawnSymbol): CompletionItem => ({
  label: symbol.name,
  kind: completionKind(symbol.kind),
  detail: symbol.detail,
  filterText: symbol.name,
  // Keep insertion predictable; Signature Help provides the argument details
  // after the user types the opening parenthesis.
  insertText: symbol.name,
});

const pawnKeywords = [
  "assert", "break", "case", "const", "continue", "decl", "default",
  "defined", "do", "else", "enum", "exit", "false", "for", "forward",
  "goto", "if", "native", "new", "not", "operator", "or", "public",
  "return", "sizeof", "sleep", "state", "static", "stock", "switch",
  "tagof", "true", "while"
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
