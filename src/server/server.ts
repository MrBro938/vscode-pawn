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
  Location,
} from "vscode-languageserver";
import { TextDocument } from "vscode-languageserver-textdocument";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath, pathToFileURL } from "url";

import { positionToIndex, findIdentifierAtCursor } from "./util";
import {
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

// Contains every Pawn source file discovered in the workspace, including files
// that are not currently open in the editor.
const indexedPawnFiles = new Set<string>();

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
    if (value.uri === uri) functionTokens.delete(key);
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

documents.onDidOpen((change) => {
  if (change.document.uri.startsWith("file:")) {
    indexedPawnFiles.add(change.document.uri);
  }
  scheduleCollectSymbols(change.document);
});
documents.onDidChangeContent((change) => {
  if (change.document.uri.startsWith("file:")) {
    indexedPawnFiles.add(change.document.uri);
  }
  scheduleCollectSymbols(change.document);
});
documents.onDidClose((event) => {
  const pending = pendingParses.get(event.document.uri);
  if (pending) clearTimeout(pending);
  pendingParses.delete(event.document.uri);
  removeDocumentSymbols(event.document.uri);
  completionCache.clear();
});

connection.onNotification(
  "pawn/indexFiles",
  (params: { files?: Array<{ uri: string; text: string }>; deleted?: string[] }) => {
    if (params.deleted) {
      params.deleted.forEach((uri) => {
        indexedPawnFiles.delete(uri);
        removeDocumentSymbols(uri);
      });
    }

    if (params.files) {
      params.files.forEach((file) => {
        indexedPawnFiles.add(file.uri);
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

connection.onDidChangeConfiguration(() => {
  documents.all().forEach(scheduleCollectSymbols);
});

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

  if (!document) return { isIncomplete: false, items };

  const offset = document.offsetAt(params.position);
  const prefixMatch = /[A-Za-z_][A-Za-z0-9_]*$/.exec(
    document.getText().slice(0, offset)
  );
  const prefix = prefixMatch ? prefixMatch[0].toLowerCase() : "";

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

  if (snip) {
    const contents: MarkedString[] = [];
    if (snip.completion.label !== undefined) contents.push(snip.completion.label);
    if (snip.completion.documentation !== undefined) {
      contents.push(String(snip.completion.documentation));
    }
    return { contents };
  }

  for (const definitions of definitionTokens.values()) {
    const definition = definitions.find(
      (item) => item.completion.label === result.identifier
    );
    if (definition) return { contents: [definition.completion.label] };
  }

  return undefined;
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

const resolveIncludeDefinition = (
  document: TextDocument,
  position: Position
): Location | Location[] | undefined => {
  const lines = document.getText().split(/\r?\n/);
  const line = lines[position.line];
  if (line === undefined) return undefined;

  const match = /^\s*#\s*include\s*[<"]([^">]+)[">]/i.exec(line);
  if (!match) return undefined;

  const includePath = match[1].trim();
  const pathStart = line.indexOf(match[1]);
  if (
    position.character < pathStart ||
    position.character > pathStart + match[1].length
  ) {
    return undefined;
  }

  try {
    if (!document.uri.startsWith("file:")) return undefined;

    const sourceFile = fileURLToPath(document.uri);
    const normalizedIncludePath = path.normalize(
      includePath.replace(/[\\/]+/g, path.sep)
    );

    const includeVariants = [normalizedIncludePath];
    if (!path.extname(normalizedIncludePath)) {
      includeVariants.push(
        normalizedIncludePath + ".inc",
        normalizedIncludePath + ".pwn",
        normalizedIncludePath + ".pawn",
        normalizedIncludePath + ".p"
      );
    }

    // Preserve the original relative-to-current-file behavior as the first
    // choice. This also supports explicit relative paths such as ../shared/file.
    const directCandidates = includeVariants.map((candidate) =>
      path.isAbsolute(candidate)
        ? path.normalize(candidate)
        : path.resolve(path.dirname(sourceFile), candidate)
    );

    const isFile = (candidate: string) => {
      try {
        return fs.statSync(candidate).isFile();
      } catch {
        return false;
      }
    };

    const directTarget = directCandidates.find(isFile);
    if (directTarget) {
      return Location.create(pathToFileURL(directTarget).toString(), {
        start: { line: 0, character: 0 },
        end: { line: 0, character: 0 },
      });
    }

    // Module includes are often written relative to a project/module root,
    // not relative to the file containing the #include. Search the workspace
    // index by path suffix so the including file can live in any subdirectory.
    const normalizeForComparison = (value: string) => {
      const normalized = path.normalize(value);
      return process.platform === "win32"
        ? normalized.toLowerCase()
        : normalized;
    };

    const suffixes = includeVariants.map((candidate) =>
      candidate.replace(/^(?:\\.\\.(?:\\\\|\\/))+/, "")
    );
    const matchingPaths = new Set<string>();

    indexedPawnFiles.forEach((uri) => {
      try {
        if (!uri.startsWith("file:")) return;

        const indexedPath = fileURLToPath(uri);
        if (!isFile(indexedPath)) return;

        const comparablePath = normalizeForComparison(indexedPath);
        const matches = suffixes.some((suffix) => {
          const comparableSuffix = normalizeForComparison(suffix);
          return (
            comparablePath === comparableSuffix ||
            comparablePath.endsWith(path.sep + comparableSuffix)
          );
        });

        if (matches) matchingPaths.add(path.resolve(indexedPath));
      } catch {
        // Ignore malformed or unsupported indexed URIs.
      }
    });

    const locations = Array.from(matchingPaths)
      .sort()
      .map((targetPath) =>
        Location.create(pathToFileURL(targetPath).toString(), {
          start: { line: 0, character: 0 },
          end: { line: 0, character: 0 },
        })
      );

    if (locations.length === 1) return locations[0];
    if (locations.length > 1) return locations;
    return undefined;
  } catch {
    // Ignore unsupported document schemes and malformed or inaccessible paths.
    return undefined;
  }
};

connection.onDefinition((params: DefinitionParams) => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return undefined;
  return doGoToDef(doc, params.position);
});

const doGoToDef = (document: TextDocument, position: Position) => {
  const includeDefinition = resolveIncludeDefinition(document, position);
  if (includeDefinition) return includeDefinition;

  const content = document.getText();
  const cursorIndex = positionToIndex(content, position);
  const result = findIdentifierAtCursor(content, cursorIndex);
  const functionSymbol = functionTokens.get(result.identifier);
  if (functionSymbol) return functionSymbol.definition;

  for (const definitions of definitionTokens.values()) {
    const definition = definitions.find(
      (item) => item.completion.label === result.identifier
    );
    if (definition) return definition.definition;
  }

  return undefined;
};

connection.listen();
