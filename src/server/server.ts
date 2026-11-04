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
  DocumentSymbol,
  SymbolKind,
  ReferenceParams,
  RenameParams,
  WorkspaceEdit,
  TextEdit,
  SemanticTokensBuilder,
  SemanticTokensLegend,
} from "vscode-languageserver/node";
import { TextDocument } from "vscode-languageserver-textdocument";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath, pathToFileURL } from "url";

import { positionToIndex, findIdentifierAtCursor } from "./util";
import {
  parseFunctions,
  functionTokens,
  functionTokensByUri,
  findFunctionIdentifier,
} from "./function";
import { parseWords, wordTokens } from "./words";
import { definitionTokens, parseDefinitions } from "./definition";
import { tokenizePawn } from "./symbols";
import {
  analyzePawn,
  getBoundOccurrences,
  PawnAnalysis,
  PawnSymbol,
  resolvePawnSymbol,
} from "./analysis";
import {
  buildPawnIncludeGraph,
  getCompilationUnitUris,
  PawnIncludeGraph,
  resolveIncludeUris,
} from "./includeGraph";
import { resolveIncludeConfiguration } from "./includeConfig";

const connection = createConnection(ProposedFeatures.all);
const documents = new TextDocuments(TextDocument);

const PARSE_DEBOUNCE_MS = 150;
const pendingParses = new Map<string, ReturnType<typeof setTimeout>>();
const completionCache = new Map<string, CompletionItem[]>();
const analysisCache = new Map<string, { text: string; analysis: PawnAnalysis }>();

// Workspace include index. Each path suffix points to all matching files,
// allowing includes to resolve independently of the including file's directory.
const indexedPawnFiles = new Map<string, string>();
const indexedPawnTexts = new Map<string, string>();
const includePathIndex = new Map<string, Set<string>>();
const configuredIncludeFileUris = new Set<string>();
let includeGraph: PawnIncludeGraph = new Map();
let configuredWorkspaceRoots: string[] = [];
let configuredIncludePaths: string[] = [];
let configuredCompilerPath = "";

const rebuildIncludeGraph = () => {
  includeGraph = buildPawnIncludeGraph(
    indexedPawnFiles,
    indexedPawnTexts,
    includePathIndex
  );
};

const normalizeIndexPath = (value: string) => {
  const normalized = path.normalize(value);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
};

const indexPawnFile = (uri: string, text?: string, rebuildGraph = true) => {
  if (!uri.startsWith("file:")) return;

  try {
    const filePath = path.resolve(fileURLToPath(uri));
    indexedPawnFiles.set(uri, filePath);
    if (text !== undefined) indexedPawnTexts.set(uri, text);

    const parts = filePath.split(path.sep);
    for (let index = 0; index < parts.length; index++) {
      const suffix = parts.slice(index).join(path.sep);
      if (!suffix) continue;

      const key = normalizeIndexPath(suffix);
      let matches = includePathIndex.get(key);
      if (!matches) {
        matches = new Set<string>();
        includePathIndex.set(key, matches);
      }
      matches.add(uri);
    }

    if (rebuildGraph) rebuildIncludeGraph();
  } catch {
    // Ignore malformed or unsupported URIs.
  }
};

const unindexPawnFile = (uri: string, rebuildGraph = true) => {
  const filePath = indexedPawnFiles.get(uri);
  if (!filePath) return;

  indexedPawnFiles.delete(uri);
  indexedPawnTexts.delete(uri);
  const parts = filePath.split(path.sep);

  for (let index = 0; index < parts.length; index++) {
    const suffix = parts.slice(index).join(path.sep);
    if (!suffix) continue;

    const key = normalizeIndexPath(suffix);
    const matches = includePathIndex.get(key);
    if (!matches) continue;

    matches.delete(uri);
    if (matches.size === 0) includePathIndex.delete(key);
  }

  if (rebuildGraph) rebuildIncludeGraph();
};

const isPawnSourceFile = (filename: string) =>
  /\.(?:inc|pwn|pawn|p)$/i.test(filename);

const scanIncludeDirectory = (
  directory: string,
  workspaceRoots: string[],
  maxFiles: number
) => {
  const workspaceContains = (filePath: string) => workspaceRoots.some((root) => {
    const relative = path.relative(root, filePath);
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
  });

  const directoryIsInWorkspace = workspaceRoots.some((root) => {
    const relative = path.relative(path.resolve(root), path.resolve(directory));
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
  });
  // The extension already indexes every Pawn source file under workspace
  // folders. Avoid walking a whole workspace root a second time.
  if (directoryIsInWorkspace) return;

  const pending = [{ directory, depth: 0 }];
  let indexedCount = 0;

  while (pending.length > 0 && indexedCount < maxFiles) {
    const current = pending.pop()!;
    if (current.depth > 12) continue;

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current.directory, { withFileTypes: true });
    } catch {
      continue;
    }

    entries.forEach((entry) => {
      if (indexedCount >= maxFiles) return;
      if (entry.name === ".git" || entry.name === "node_modules" ||
          entry.name === ".vscode" || entry.name === "out" || entry.name === "dist") {
        return;
      }

      const fullPath = path.join(current.directory, entry.name);
      if (entry.isDirectory()) {
        pending.push({ directory: fullPath, depth: current.depth + 1 });
        return;
      }

      if (!entry.isFile() || !isPawnSourceFile(entry.name)) return;

      const absolutePath = path.resolve(fullPath);
      if (workspaceContains(absolutePath)) return;

      const uri = pathToFileURL(absolutePath).toString();
      if (indexedPawnFiles.has(uri)) return;

      try {
        const text = fs.readFileSync(absolutePath, "utf8");
        indexPawnFile(uri, text, false);
        collectSymbols(TextDocument.create(uri, "pawn", 1, text), false);
        configuredIncludeFileUris.add(uri);
        indexedCount++;
      } catch {
        // Ignore include files that are inaccessible or removed during scanning.
      }
    });
  }
};

const reloadConfiguredIncludes = () => {
  configuredIncludeFileUris.forEach((uri) => {
    // An include file may have been opened after it was discovered. Its live
    // TextDocument is authoritative, so keep its index entry during reload.
    if (documents.get(uri)) return;

    unindexPawnFile(uri, false);
    analysisCache.delete(uri);
    removeDocumentSymbols(uri);
  });
  configuredIncludeFileUris.clear();

  const configuration = resolveIncludeConfiguration({
    workspaceRoots: configuredWorkspaceRoots,
    customIncludePaths: configuredIncludePaths,
    compilerPath: configuredCompilerPath,
  });

  configuration.includeDirectories.forEach((directory) => {
    scanIncludeDirectory(directory, configuredWorkspaceRoots, 20000);
  });

  rebuildIncludeGraph();
  completionCache.clear();
};

documents.listen(connection);

connection.onInitialize(() => ({
  capabilities: {
    textDocumentSync: TextDocumentSyncKind.Full,
    completionProvider: { resolveProvider: true },
    definitionProvider: true,
    documentSymbolProvider: true,
    hoverProvider: true,
    signatureHelpProvider: { triggerCharacters: ["(", ","] },
    referencesProvider: true,
    renameProvider: true,
    semanticTokensProvider: {
      legend: {
        tokenTypes: [
          "keyword", "function", "macro", "variable", "parameter",
          "enum", "enumMember", "type", "number", "string", "comment"
        ],
        tokenModifiers: ["declaration"],
      },
      full: true,
    },
  },
}));

const removeDocumentSymbols = (uri: string) => {
  functionTokens.forEach((value, key) => {
    if (value.uri === uri) functionTokens.delete(key);
  });
  functionTokensByUri.delete(uri);
  wordTokens.delete(uri);
  definitionTokens.delete(uri);
};

const collectSymbols = (textDocument: TextDocument, includeWords = true) => {
  removeDocumentSymbols(textDocument.uri);
  parseDefinitions(textDocument);
  parseFunctions(textDocument);
  if (includeWords) parseWords(textDocument);
  analysisCache.set(textDocument.uri, {
    text: textDocument.getText(),
    analysis: analyzePawn(textDocument.getText()),
  });
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
    indexPawnFile(change.document.uri, change.document.getText());
  }
  scheduleCollectSymbols(change.document);
});
documents.onDidChangeContent((change) => {
  if (change.document.uri.startsWith("file:")) {
    indexPawnFile(change.document.uri, change.document.getText());
  }
  scheduleCollectSymbols(change.document);
});
documents.onDidClose((event) => {
  const pending = pendingParses.get(event.document.uri);
  if (pending) clearTimeout(pending);
  pendingParses.delete(event.document.uri);
  removeDocumentSymbols(event.document.uri);
  analysisCache.delete(event.document.uri);
  completionCache.clear();
});

connection.onNotification(
  "pawn/indexFiles",
  (params: { files?: Array<{ uri: string; text: string }>; deleted?: string[] }) => {
    if (params.deleted) {
      params.deleted.forEach((uri) => {
        unindexPawnFile(uri, false);
        analysisCache.delete(uri);
        removeDocumentSymbols(uri);
      });
    }

    if (params.files) {
      params.files.forEach((file) => {
        indexPawnFile(file.uri, file.text, false);
        const document = TextDocument.create(file.uri, "pawn", 1, file.text);
        collectSymbols(document, false);
      });
    }

    if ((params.deleted && params.deleted.length > 0) ||
        (params.files && params.files.length > 0)) {
      rebuildIncludeGraph();
      completionCache.clear();
    }
  }
);

connection.onNotification(
  "pawn/configureIncludes",
  (params: {
    workspaceRoots?: string[];
    includePaths?: string[];
    compilerPath?: string;
  }) => {
    configuredWorkspaceRoots = (params.workspaceRoots || [])
      .filter((value) => typeof value === "string")
      .map((value) => path.resolve(value));
    configuredIncludePaths = (params.includePaths || [])
      .filter((value) => typeof value === "string");
    configuredCompilerPath =
      typeof params.compilerPath === "string" ? params.compilerPath : "";

    reloadConfiguredIncludes();
  }
);

connection.onDidChangeConfiguration(() => {
  documents.all().forEach(scheduleCollectSymbols);
});

const getDocumentSymbols = (document: TextDocument): DocumentSymbol[] => {
  const analysis = getAnalysis(document.uri);
  if (!analysis) return [];
  const symbols: DocumentSymbol[] = [];
  const enumParents = new Map<string, DocumentSymbol>();

  const createDocumentSymbol = (
    symbol: PawnSymbol,
    kind: SymbolKind
  ): DocumentSymbol => {
    const start = document.positionAt(symbol.start);
    const end = document.positionAt(symbol.end);
    return {
      name: symbol.name,
      detail: symbol.detail,
      kind,
      range: { start, end },
      selectionRange: { start, end },
    };
  };

  analysis.symbols
    .filter((symbol) => symbol.kind === "enum")
    .forEach((symbol) => {
      const documentSymbol = createDocumentSymbol(symbol, SymbolKind.Enum);
      documentSymbol.children = [];
      enumParents.set(symbol.name, documentSymbol);
      symbols.push(documentSymbol);
    });

  analysis.symbols.forEach((symbol) => {
    let documentSymbol: DocumentSymbol | undefined;

    switch (symbol.kind) {
      case "function":
        documentSymbol = createDocumentSymbol(symbol, SymbolKind.Function);
        break;
      case "macro":
        documentSymbol = createDocumentSymbol(symbol, SymbolKind.Constant);
        break;
      case "global":
        documentSymbol = createDocumentSymbol(symbol, SymbolKind.Variable);
        break;
      case "enumMember":
        documentSymbol = createDocumentSymbol(symbol, SymbolKind.EnumMember);
        break;
      default:
        return;
    }

    if (symbol.kind === "enumMember" && symbol.detail) {
      const parent = enumParents.get(symbol.detail);
      if (parent) {
        parent.children = parent.children || [];
        parent.children.push(documentSymbol);
        return;
      }
    }

    symbols.push(documentSymbol);
  });

  const sortByPosition = (items: DocumentSymbol[]) => {
    items.sort((left, right) =>
      left.range.start.line - right.range.start.line ||
      left.range.start.character - right.range.start.character
    );
    items.forEach((item) => {
      if (item.children) sortByPosition(item.children);
    });
  };
  sortByPosition(symbols);

  return symbols;
};

connection.onDocumentSymbol((params) => {
  const document = documents.get(params.textDocument.uri);
  return document ? getDocumentSymbols(document) : [];
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

  const visibleUris = getCompilationUnitUris(uri, includeGraph);
  visibleUris.forEach((visibleUri) => {
    functionTokensByUri.get(visibleUri)?.forEach((res) => add(res.completion));
    definitionTokens.get(visibleUri)?.forEach((res) => add(res.completion));
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

const pawnKeywords = new Set([
  "if", "else", "while", "for", "do", "switch", "case", "default",
  "return", "break", "continue", "goto", "new", "const", "static",
  "public", "stock", "native", "forward", "enum", "sizeof", "state",
  "true", "false", "defined", "operator", "assert", "exit", "sleep",
  "tagof", "and", "or", "not", "decl", "char", "bool"
]);

const getDocumentText = (uri: string): string | undefined => {
  const openDocument = documents.get(uri);
  return openDocument ? openDocument.getText() : indexedPawnTexts.get(uri);
};

const getAnalysis = (uri: string): PawnAnalysis | undefined => {
  const text = getDocumentText(uri);
  if (text === undefined) return undefined;

  const cached = analysisCache.get(uri);
  if (cached && cached.text === text) return cached.analysis;

  const analysis = analyzePawn(text);
  analysisCache.set(uri, { text, analysis });
  return analysis;
};

interface WorkspacePawnAnalysis {
  uri: string;
  analysis: PawnAnalysis;
}

const getWorkspaceAnalyses = (sourceUri?: string): WorkspacePawnAnalysis[] => {
  const uris = new Set<string>(indexedPawnFiles.keys());
  documents.all().forEach((document) => uris.add(document.uri));

  const visibleUris = sourceUri
    ? getCompilationUnitUris(sourceUri, includeGraph)
    : uris;

  const result: WorkspacePawnAnalysis[] = [];
  visibleUris.forEach((uri) => {
    if (!uris.has(uri) && uri !== sourceUri) return;
    const analysis = getAnalysis(uri);
    if (analysis) result.push({ uri, analysis });
  });
  return result;
};

const resolveSymbolAt = (
  uri: string,
  document: TextDocument,
  position: Position
): { symbol: PawnSymbol; symbolUri: string; workspace: WorkspacePawnAnalysis[] } | undefined => {
  const currentAnalysis = getAnalysis(uri);
  if (!currentAnalysis) return undefined;

  const workspace = getWorkspaceAnalyses(uri);
  const symbol = resolvePawnSymbol(
    currentAnalysis,
    uri,
    document.offsetAt(position),
    workspace.map((entry) => entry.analysis)
  );
  if (!symbol) return undefined;

  const declarationEntry = workspace.find((entry) =>
    entry.analysis.symbols.includes(symbol)
  );
  return {
    symbol,
    symbolUri: declarationEntry?.uri || uri,
    workspace,
  };
};

const symbolOccurrences = (
  uri: string,
  symbol: PawnSymbol,
  workspace: WorkspacePawnAnalysis[]
): Location[] => {
  return getBoundOccurrences(symbol, uri, workspace).map(({ uri: targetUri, token }) => {
    const targetAnalysis = workspace.find((entry) => entry.uri === targetUri)?.analysis;
    const targetText = targetAnalysis?.text || "";
    const targetDocument = TextDocument.create(targetUri, "pawn", 1, targetText);
    return Location.create(targetUri, {
      start: targetDocument.positionAt(token.start),
      end: targetDocument.positionAt(token.end),
    });
  });
};

connection.onReferences((params: ReferenceParams) => {
  const document = documents.get(params.textDocument.uri);
  if (!document) return [];

  const resolved = resolveSymbolAt(document.uri, document, params.position);
  if (!resolved) return [];

  const locations = symbolOccurrences(resolved.symbolUri, resolved.symbol, resolved.workspace);
  if (params.context.includeDeclaration) return locations;

  const declarationEntry = resolved.workspace.find(
    (entry) => entry.uri === resolved.symbolUri
  );
  const declarationDocument = documents.get(resolved.symbolUri) ||
    TextDocument.create(
      resolved.symbolUri,
      "pawn",
      1,
      declarationEntry?.analysis.text || ""
    );
  const declarationPosition = declarationDocument.positionAt(resolved.symbol.start);

  return locations.filter((location) =>
    location.uri !== resolved.symbolUri ||
    location.range.start.character !== declarationPosition.character ||
    location.range.start.line !== declarationPosition.line
  );
});

connection.onRenameRequest((params: RenameParams): WorkspaceEdit | undefined => {
  if (!/^[A-Za-z_@][A-Za-z0-9_@]*$/.test(params.newName)) return undefined;

  const document = documents.get(params.textDocument.uri);
  if (!document) return undefined;

  const resolved = resolveSymbolAt(document.uri, document, params.position);
  if (!resolved) return undefined;

  const locations = symbolOccurrences(resolved.symbolUri, resolved.symbol, resolved.workspace);
  if (locations.length === 0) return undefined;

  const changes: { [uri: string]: TextEdit[] } = {};
  locations.forEach((location) => {
    if (!changes[location.uri]) changes[location.uri] = [];
    changes[location.uri].push(TextEdit.replace(location.range, params.newName));
  });

  return { changes };
});

const semanticLegend: SemanticTokensLegend = {
  tokenTypes: [
    "keyword", "function", "macro", "variable", "parameter",
    "enum", "enumMember", "type", "number", "string", "comment"
  ],
  tokenModifiers: ["declaration"],
};

connection.languages.semanticTokens.on((params) => {
  const document = documents.get(params.textDocument.uri);
  if (!document) return { data: [] };

  const analysis = getAnalysis(document.uri);
  if (!analysis) return { data: [] };

  const workspace = getWorkspaceAnalyses(document.uri);
  const projectKinds = new Map<string, PawnSymbol["kind"]>();
  workspace.forEach((entry) => {
    entry.analysis.symbols.forEach((symbol) => {
      if (!projectKinds.has(symbol.name) ||
          symbol.kind === "function" ||
          symbol.kind === "macro" ||
          symbol.kind === "enum" ||
          symbol.kind === "enumMember" ||
          symbol.kind === "type") {
        projectKinds.set(symbol.name, symbol.kind);
      }
    });
  });

  const localSymbolsByName = new Map<string, PawnSymbol[]>();
  analysis.symbols.forEach((symbol) => {
    if (symbol.kind !== "local" && symbol.kind !== "parameter") return;

    const matches = localSymbolsByName.get(symbol.name) || [];
    matches.push(symbol);
    localSymbolsByName.set(symbol.name, matches);
  });
  // Keep the most recently declared candidate first so resolving a local
  // identifier does not filter and sort the complete symbol list each time.
  localSymbolsByName.forEach((matches) =>
    matches.sort((left, right) => right.start - left.start)
  );

  const typeAnnotationStarts = new Set<number>();
  for (let index = 0; index < analysis.tokens.length - 1; index++) {
    const token = analysis.tokens[index];
    const next = analysis.tokens[index + 1];
    if (
      token.kind === "identifier" &&
      token.end === next.start &&
      next.kind === "punctuation" &&
      next.value === ":"
    ) {
      typeAnnotationStarts.add(token.start);
    }
  }

  const declarations = new Map<number, PawnSymbol>();
  analysis.symbols.forEach((symbol) => declarations.set(symbol.start, symbol));

  const tokenTypes = semanticLegend.tokenTypes;
  const tokenTypeIndex = new Map(tokenTypes.map((type, index) => [type, index]));
  const builder = new SemanticTokensBuilder();

  analysis.tokens.forEach((token) => {
    let tokenType: string | undefined;
    let isDeclaration = false;

    if (token.kind === "comment") tokenType = "comment";
    else if (token.kind === "string") tokenType = "string";
    else if (token.kind === "number") tokenType = "number";
    else if (token.kind === "identifier") {
      const normalized = token.value.toLowerCase();
      const declaration = declarations.get(token.start);

      if (declaration) {
        isDeclaration = true;
        switch (declaration.kind) {
          case "function": tokenType = "function"; break;
          case "macro": tokenType = "macro"; break;
          case "parameter": tokenType = "parameter"; break;
          case "enum": tokenType = "enum"; break;
          case "enumMember": tokenType = "enumMember"; break;
          case "type": tokenType = "type"; break;
          default: tokenType = "variable"; break;
        }
      } else if (pawnKeywords.has(normalized)) {
        tokenType = "keyword";
      } else if (typeAnnotationStarts.has(token.start)) {
        tokenType = "type";
      } else {
        const local = localSymbolsByName.get(token.value)?.find((symbol) =>
          token.start >= symbol.scopeStart &&
          token.start <= symbol.scopeEnd &&
          symbol.start <= token.start
        );

        const kind = local?.kind || projectKinds.get(token.value);
        if (kind === "function") tokenType = "function";
        else if (kind === "macro") tokenType = "macro";
        else if (kind === "parameter") tokenType = "parameter";
        else if (kind === "enum") tokenType = "enum";
        else if (kind === "enumMember") tokenType = "enumMember";
        else if (kind === "type") tokenType = "type";
        else tokenType = "variable";
      }
    }

    if (!tokenType) return;
    const typeIndex = tokenTypeIndex.get(tokenType);
    if (typeIndex === undefined) return;

    const position = document.positionAt(token.start);
    builder.push(
      position.line,
      position.character,
      token.end - token.start,
      typeIndex,
      isDeclaration ? 1 : 0
    );
  });

  return builder.build();
});

connection.onCompletionResolve((item: CompletionItem): CompletionItem => item);

connection.onHover((params: TextDocumentPositionParams): Hover | undefined => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return undefined;
  return doHover(doc, params.position);
});

const getFunctionInCompilationUnit = (
  uri: string,
  identifier: string
) => {
  const visibleUris = getCompilationUnitUris(uri, includeGraph);
  for (const visibleUri of visibleUris) {
    const found = functionTokensByUri.get(visibleUri)?.get(identifier);
    if (found) return found;
  }
  return undefined;
};

const getDefinitionInCompilationUnit = (
  uri: string,
  identifier: string
) => {
  const visibleUris = getCompilationUnitUris(uri, includeGraph);
  for (const visibleUri of visibleUris) {
    const found = definitionTokens.get(visibleUri)?.find(
      (definition) => definition.completion.label === identifier
    );
    if (found) return found;
  }
  return undefined;
};

const doHover = (
  document: TextDocument,
  position: Position
): Hover | undefined => {
  const content = document.getText();
  const cursorIndex = positionToIndex(content, position);
  const result = findIdentifierAtCursor(content, cursorIndex);
  const snip = getFunctionInCompilationUnit(document.uri, result.identifier);

  if (snip) {
    const contents: MarkedString[] = [];
    if (snip.completion.label !== undefined) contents.push(snip.completion.label);
    if (snip.completion.documentation !== undefined) {
      contents.push(String(snip.completion.documentation));
    }
    return { contents };
  }

  const definition = getDefinitionInCompilationUnit(
    document.uri,
    result.identifier
  );
  if (definition) return { contents: [definition.completion.label] };

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

  const snip = getFunctionInCompilationUnit(document.uri, result.identifier);
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

    const matchingUris = resolveIncludeUris(
      document.uri,
      includePath,
      indexedPawnFiles,
      includePathIndex
    );

    const locations = matchingUris.map((uri) =>
      Location.create(uri, {
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

  const includeDefinition = resolveIncludeDefinition(doc, params.position);
  if (includeDefinition) return includeDefinition;

  const resolved = resolveSymbolAt(doc.uri, doc, params.position);
  if (resolved) {
    const targetAnalysis = resolved.workspace.find(
      (entry) => entry.uri === resolved.symbolUri
    )?.analysis;
    const targetDocument = documents.get(resolved.symbolUri) ||
      TextDocument.create(
        resolved.symbolUri,
        "pawn",
        1,
        targetAnalysis?.text || ""
      );

    return Location.create(resolved.symbolUri, {
      start: targetDocument.positionAt(resolved.symbol.start),
      end: targetDocument.positionAt(resolved.symbol.end),
    });
  }

  return doGoToDef(doc, params.position);
});

const doGoToDef = (document: TextDocument, position: Position) => {
  const includeDefinition = resolveIncludeDefinition(document, position);
  if (includeDefinition) return includeDefinition;

  const content = document.getText();
  const cursorIndex = positionToIndex(content, position);
  const result = findIdentifierAtCursor(content, cursorIndex);
  const functionSymbol = getFunctionInCompilationUnit(document.uri, result.identifier);
  if (functionSymbol) return functionSymbol.definition;

  const definition = getDefinitionInCompilationUnit(document.uri, result.identifier);
  if (definition) return definition.definition;

  return undefined;
};

connection.listen();
