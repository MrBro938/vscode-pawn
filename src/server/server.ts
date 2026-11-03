import {
  createConnection,
  TextDocuments,
  ProposedFeatures,
  CompletionItem,
  TextDocumentPositionParams,
  TextDocumentSyncKind,
  Hover,
  DefinitionParams,
  SignatureHelpParams,
  SignatureHelp,
  CompletionList,
  CompletionParams,
  MarkedString,
  Position,
} from "vscode-languageserver";
import { TextDocument } from "vscode-languageserver-textdocument";

import { positionToIndex, findIdentifierAtCursor } from "./util";
import {
  PawnFunction,
  parseFunctions,
  functionTokens,
  findFunctionIdentifier,
} from "./function";
import { parseWords, wordTokens } from "./words";
import { definitionTokens, parseDefinitions } from "./definition";

const connection = createConnection(ProposedFeatures.all);
const documents = new TextDocuments(TextDocument);

const PARSE_DEBOUNCE_MS = 150;
const pendingParses = new Map<string, ReturnType<typeof setTimeout>>();
const completionCache = new Map<string, CompletionItem[]>();

documents.listen(connection);

connection.onInitialize(() => ({
  capabilities: {
    textDocumentSync: TextDocumentSyncKind.Full,
    completionProvider: { resolveProvider: true },
    definitionProvider: true,
    hoverProvider: true,
    signatureHelpProvider: { triggerCharacters: ["(", ","] },
  },
}));

const removeDocumentSymbols = (uri: string) => {
  functionTokens.forEach((value, key) => {
    if (value.textDocument.uri === uri) functionTokens.delete(key);
  });
  wordTokens.delete(uri);
  definitionTokens.delete(uri);
};

const collectSymbols = (textDocument: TextDocument, includeWords = true) => {
  removeDocumentSymbols(textDocument.uri);
  parseDefinitions(textDocument);
  parseFunctions(textDocument);
  if (includeWords) parseWords(textDocument);
  completionCache.clear();
};

const scheduleCollectSymbols = (textDocument: TextDocument) => {
  const uri = textDocument.uri;
  const pending = pendingParses.get(uri);
  if (pending) clearTimeout(pending);

  const timer = setTimeout(() => {
    pendingParses.delete(uri);
    collectSymbols(textDocument);
  }, PARSE_DEBOUNCE_MS);

  pendingParses.set(uri, timer);
};

documents.onDidOpen((change) => scheduleCollectSymbols(change.document));
documents.onDidChangeContent((change) => scheduleCollectSymbols(change.document));
documents.onDidClose((event) => {
  const pending = pendingParses.get(event.document.uri);
  if (pending) clearTimeout(pending);
  pendingParses.delete(event.document.uri);
  removeDocumentSymbols(event.document.uri);
  completionCache.clear();
});

connection.onDidChangeConfiguration(() => {
  documents.all().forEach(scheduleCollectSymbols);
});

// Workspace files are read in the extension host without opening editor documents.
// They are indexed in small batches to keep the initial language-server load responsive.
connection.onNotification(
  "pawn/indexFiles",
  (params: { files?: Array<{ uri: string; text: string }>; deleted?: string[] }) => {
    if (params.deleted) {
      params.deleted.forEach((uri) => removeDocumentSymbols(uri));
    }

    if (params.files) {
      params.files.forEach((file) => {
        const document = TextDocument.create(file.uri, "pawn", 1, file.text);
        collectSymbols(document, false);
      });
    }

    if ((params.deleted && params.deleted.length > 0) ||
        (params.files && params.files.length > 0)) {
      completionCache.clear();
    }
  }
);

const buildCompletionItems = (uri: string): CompletionItem[] => {
  const cached = completionCache.get(uri);
  if (cached) return cached;

  const items: CompletionItem[] = [];
  const seen = new Set<string>();

  const add = (item: CompletionItem) => {
    const key = item.label;
    if (seen.has(key)) return;
    seen.add(key);
    items.push(item);
  };

  functionTokens.forEach((res) => add(res.completion));

  definitionTokens.forEach((definitions) => {
    definitions.forEach((res) => add(res.completion));
  });

  const words = wordTokens.get(uri);
  if (words) words.forEach(add);

  completionCache.set(uri, items);
  return items;
};

connection.onCompletion((params: CompletionParams): CompletionList => {
  const items = buildCompletionItems(params.textDocument.uri);
  const document = documents.get(params.textDocument.uri);

  if (!document) {
    return { isIncomplete: false, items };
  }

  const offset = document.offsetAt(params.position);
  const prefixMatch = /[A-Za-z_][A-Za-z0-9_]*$/.exec(
    document.getText().slice(0, offset)
  );
  const prefix = prefixMatch ? prefixMatch[0].toLowerCase() : "";

  // Filtering before sending the response avoids returning thousands of unrelated
  // project symbols on every keystroke.
  const filteredItems = prefix
    ? items.filter((item) => item.label.toLowerCase().startsWith(prefix))
    : items;

  return { isIncomplete: false, items: filteredItems };
});

connection.onCompletionResolve((item: CompletionItem): CompletionItem => item);

connection.onHover((params: TextDocumentPositionParams): Hover | undefined => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return undefined;
  return doHover(doc, params.position);
});

const doHover = (
  document: TextDocument,
  position: Position
): Hover | undefined => {
  const content = document.getText();
  const cursorIndex = positionToIndex(content, position);
  const result = findIdentifierAtCursor(content, cursorIndex);
  const snip = functionTokens.get(result.identifier);

  if (!snip) return undefined;

  const contents: MarkedString[] = [];
  if (snip.completion.label !== undefined) contents.push(snip.completion.label);
  if (snip.completion.documentation !== undefined) {
    contents.push(String(snip.completion.documentation));
  }

  return { contents };
};

connection.onSignatureHelp((params: SignatureHelpParams):
  | SignatureHelp
  | undefined => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return undefined;
  return doSignHelp(doc, params.position);
});

const doSignHelp = (
  document: TextDocument,
  position: Position
): SignatureHelp | undefined => {
  const content = document.getText();
  const cursorIndex = positionToIndex(content, position);
  const result = findFunctionIdentifier(content, cursorIndex);
  if (result.identifier === "") return undefined;

  const snip = functionTokens.get(result.identifier);
  if (!snip) return undefined;

  return {
    activeParameter: Math.min(result.parameterIndex, Math.max(0, (snip.params || []).length - 1)),
    activeSignature: 0,
    signatures: [{
      label: snip.completion.label || result.identifier,
      parameters: snip.params,
      documentation: snip.completion.documentation,
    }],
  };
};

connection.onDefinition((params: DefinitionParams) => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return undefined;
  return doGoToDef(doc, params.position);
});

const doGoToDef = (document: TextDocument, position: Position) => {
  const content = document.getText();
  const cursorIndex = positionToIndex(content, position);
  const result = findIdentifierAtCursor(content, cursorIndex);
  const functionSymbol = functionTokens.get(result.identifier);
  if (functionSymbol) return functionSymbol.definition;

  for (const definitions of definitionTokens.values()) {
    const definition = definitions.find((item) => item.completion.label === result.identifier);
    if (definition) return definition.definition;
  }

  return undefined;
};

connection.listen();
