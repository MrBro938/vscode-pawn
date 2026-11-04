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

import { createTextPositionCursor, positionToIndex, findIdentifierAtCursor } from "./util";
import {
  parseFunctions,
  functionTokens,
  functionTokensByUri,
  findFunctionIdentifier,
} from "./function";
import {
  buildPawnCompletionItems,
  getPawnMacroSignature,
  PawnCompletionSource,
} from "./completion";
import {
  formatPawnFunctionSignature,
  formatPawnSymbolHover,
  getPawnSignatureParameters,
} from "./symbolDisplay";
import { definitionTokens, parseDefinitions } from "./definition";
import { isPawnFunctionInvocation, tokenizePawn } from "./symbols";
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
  getIncludedFileUris,
  extractPawnIncludes,
  updatePawnIncludeGraph,
  normalizePawnPath,
  PawnIncludeMode,
} from "./includeGraph";
import { resolveIncludeConfiguration } from "./includeConfig";
import { PerformanceMonitor } from "../performance";

const connection = createConnection(ProposedFeatures.all);
const documents = new TextDocuments(TextDocument);
const performanceStats = new PerformanceMonitor();

connection.onNotification(
  "pawn/performanceEnabled",
  (params: { enabled?: boolean }) => {
    performanceStats.setEnabled(params.enabled === true);
  }
);
connection.onNotification("pawn/performanceReset", () => {
  performanceStats.reset();
});
connection.onRequest("pawn/performanceStats", () => performanceStats.snapshot());

const PARSE_DEBOUNCE_MS = 150;
const pendingParses = new Map<string, ReturnType<typeof setTimeout>>();
const analysisCache = new Map<string, { text: string; analysis: PawnAnalysis }>();
const indexedSymbolTexts = new Map<string, string>();
let semanticTokensRefreshSupported = false;

// Workspace include index. Each path suffix points to all matching files,
// allowing includes to resolve independently of the including file's directory.
const indexedPawnFiles = new Map<string, string>();
const indexedPawnTexts = new Map<string, string>();
const includePathIndex = new Map<string, Set<string>>();
const indexedPawnPathIndex = new Map<string, string>();
const configuredIncludeFileUris = new Set<string>();
let includeGraph: PawnIncludeGraph = new Map();
let configuredWorkspaceRoots: string[] = [];
let configuredIncludePaths: string[] = [];
let configuredIncludeDirectories: string[] = [];
let configuredCompilerPath = "";

const rebuildIncludeGraph = () => performanceStats.measure(
  "include.graphRebuild",
  () => {
    includeGraph = buildPawnIncludeGraph(
      indexedPawnFiles,
      indexedPawnTexts,
      includePathIndex,
      configuredIncludeDirectories
    );
    performanceStats.count("include.graphFiles", includeGraph.size);
  }
);

const normalizeIndexPath = (value: string) => {
  const normalized = path.normalize(value);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
};

const indexPawnFile = (uri: string, text?: string, rebuildGraph = true) => {
  if (!uri.startsWith("file:")) return;

  try {
    const filePath = path.resolve(fileURLToPath(uri));
    const wasIndexed = indexedPawnFiles.has(uri);
    const previousText = indexedPawnTexts.get(uri);
    const textChanged = text !== undefined && previousText !== text;
    const includeGraphChanged = text !== undefined && textChanged && (
      previousText === undefined ||
      JSON.stringify(extractPawnIncludes(previousText)) !==
        JSON.stringify(extractPawnIncludes(text))
    );

    if (textChanged) {
      indexedSymbolTexts.delete(uri);
      analysisCache.delete(uri);
      removeDocumentSymbols(uri);
    }

    indexedPawnFiles.set(uri, filePath);
    indexedPawnPathIndex.set(normalizePawnPath(filePath), uri);
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

    const isWorkspaceFile = configuredWorkspaceRoots.some((root) => {
      const relativePath = path.relative(root, filePath);
      return relativePath === "" ||
        (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));
    });
    const isConfiguredExternalInclude = !isWorkspaceFile &&
      configuredIncludeDirectories.some((directory) => {
        const relativePath = path.relative(directory, filePath);
        return relativePath === "" ||
          (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));
      });
    if (isConfiguredExternalInclude) configuredIncludeFileUris.add(uri);

    if (rebuildGraph) {
      if (!wasIndexed) {
        rebuildIncludeGraph();
      } else if (includeGraphChanged) {
        includeGraph = updatePawnIncludeGraph(
          includeGraph,
          uri,
          indexedPawnFiles,
          indexedPawnTexts,
          includePathIndex,
          configuredIncludeDirectories,
          indexedPawnPathIndex
        );
      }
    }
  } catch {
    // Ignore malformed or unsupported URIs.
  }
};

const unindexPawnFile = (uri: string, rebuildGraph = true) => {
  const filePath = indexedPawnFiles.get(uri);
  if (!filePath) return;

  indexedPawnFiles.delete(uri);
  indexedPawnPathIndex.delete(normalizePawnPath(filePath));
  configuredIncludeFileUris.delete(uri);
  indexedPawnTexts.delete(uri);
  indexedSymbolTexts.delete(uri);
  analysisCache.delete(uri);
  removeDocumentSymbols(uri);
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
        configuredIncludeFileUris.add(uri);
        indexedCount++;
      } catch {
        // Ignore include files that are inaccessible or removed during scanning.
      }
    });
  }
};

const reloadConfiguredIncludes = () => performanceStats.measure(
  "include.reload",
  () => {
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

  configuredIncludeDirectories = configuration.includeDirectories;
  configuration.includeDirectories.forEach((directory) => {
    performanceStats.count("include.directoriesScanned");
    scanIncludeDirectory(directory, configuredWorkspaceRoots, 20000);
  });
  performanceStats.count("include.configuredFilesDiscovered", configuredIncludeFileUris.size);

  rebuildIncludeGraph();

  // Let the extension host watch external dependency folders without having
  // to duplicate pawn.json / pawn.cfg parsing on the client side.
  connection.sendNotification("pawn/includeDirectories", {
    directories: configuredIncludeDirectories,
  });
  }
);

documents.listen(connection);

connection.onInitialize((params) => {
  semanticTokensRefreshSupported =
    params.capabilities.workspace?.semanticTokens?.refreshSupport === true;

  return {
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
  };
});

const removeDocumentSymbols = (uri: string) => {
  functionTokens.forEach((value, key) => {
    if (value.uri === uri) functionTokens.delete(key);
  });
  functionTokensByUri.delete(uri);
  definitionTokens.delete(uri);
};

const analyzePawnMeasured = (uri: string, text: string): PawnAnalysis => {
  const startedAt = performanceStats.isEnabled ? performance.now() : 0;
  const analysis = performanceStats.measure("analysis.parse", () =>
    analyzePawn(
      text,
      performanceStats.isEnabled
        ? (phase, durationMs) => performanceStats.record(`analysis.phase.${phase}`, durationMs)
        : undefined
    )
  );
  performanceStats.count("analysis.filesParsed");
  performanceStats.count("analysis.tokens", analysis.tokens.length);
  performanceStats.count("analysis.symbols", analysis.symbols.length);

  if (performanceStats.isEnabled) {
    let sourcePath = uri;
    try {
      if (uri.startsWith("file:")) sourcePath = fileURLToPath(uri);
    } catch {
      // Keep the URI as a useful fallback for virtual documents.
    }
    performanceStats.recordFileAnalysis(
      sourcePath,
      Buffer.byteLength(text, "utf8"),
      analysis.tokens.length,
      analysis.symbols.length,
      performance.now() - startedAt
    );
  }
  return analysis;
};

const collectSymbols = (textDocument: TextDocument) => {
  performanceStats.measure("analysis.collectSymbols", () => {
    const text = textDocument.getText();
    removeDocumentSymbols(textDocument.uri);
    performanceStats.measure("analysis.parseDefinitions", () => parseDefinitions(textDocument));
    performanceStats.measure("analysis.parseFunctions", () => parseFunctions(textDocument));
    const cachedAnalysis = analysisCache.get(textDocument.uri);
    analysisCache.set(textDocument.uri, {
      text,
      analysis: cachedAnalysis?.text === text
        ? cachedAnalysis.analysis
        : analyzePawnMeasured(textDocument.uri, text),
    });
    indexedSymbolTexts.set(textDocument.uri, text);
  });
};

const ensureSymbolsIndexed = (uri: string) => {
  const text = getDocumentText(uri);
  if (text === undefined || indexedSymbolTexts.get(uri) === text) return;

  const document = documents.get(uri) ||
    TextDocument.create(uri, "pawn", 1, text);
  collectSymbols(document);
};

const scheduleCollectSymbols = (
  textDocument: TextDocument,
  refreshSemanticTokens = false
) => {
  const uri = textDocument.uri;
  const pending = pendingParses.get(uri);
  if (pending) clearTimeout(pending);

  const timer = setTimeout(() => {
    pendingParses.delete(uri);
    ensureSymbolsIndexed(uri);

    // A reopened document can retain stale semantic-token state in the editor.
    // Ask the client for a fresh full token response after its analysis is ready.
    if (refreshSemanticTokens && semanticTokensRefreshSupported) {
      void connection.languages.semanticTokens.refresh();
    }
  }, PARSE_DEBOUNCE_MS);

  pendingParses.set(uri, timer);
};

documents.onDidOpen((change) => {
  if (change.document.uri.startsWith("file:")) {
    indexPawnFile(change.document.uri, change.document.getText());
  }
  scheduleCollectSymbols(change.document, true);
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

  // Keep the cached file snapshot and symbols when a tab closes. The file is
  // still part of the workspace, and re-opening it should not force a reparse.
});

const getIndexedUrisUnderPath = (uri: string): string[] => {
  try {
    const targetPath = path.resolve(fileURLToPath(uri));
    return Array.from(indexedPawnFiles.entries())
      .filter(([, indexedPath]) => {
        const relativePath = path.relative(targetPath, indexedPath);
        return relativePath === "" ||
          (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));
      })
      .map(([indexedUri]) => indexedUri);
  } catch {
    return indexedPawnFiles.has(uri) ? [uri] : [];
  }
};

connection.onNotification(
  "pawn/indexFiles",
  (params: {
    files?: Array<{ uri: string; text: string }>;
    deleted?: string[];
    deferGraphRebuild?: boolean;
  }) => performanceStats.measure("index.notification", () => {
    performanceStats.count("index.filesReceived", params.files?.length || 0);
    performanceStats.count("index.filesDeleted", params.deleted?.length || 0);
    let needsFullGraphRebuild = false;
    let hasIndexChanges = false;
    const changedIncludeSources = new Set<string>();

    params.deleted?.forEach((deletedUri) => {
      // A filesystem watcher may report a deleted directory instead of each
      // child file. Remove both an exact file and any indexed descendants.
      const targets = getIndexedUrisUnderPath(deletedUri);
      targets.forEach((targetUri) => {
        if (!indexedPawnFiles.has(targetUri)) return;
        unindexPawnFile(targetUri, false);
        needsFullGraphRebuild = true;
        hasIndexChanges = true;
      });
    });

    params.files?.forEach((file) => {
      const wasIndexed = indexedPawnFiles.has(file.uri);
      const previousText = indexedPawnTexts.get(file.uri);
      const textChanged = previousText !== file.text;
      const includeDirectivesChanged = previousText !== undefined &&
        JSON.stringify(extractPawnIncludes(previousText)) !==
          JSON.stringify(extractPawnIncludes(file.text));

      indexPawnFile(file.uri, file.text, false);

      if (!wasIndexed) {
        // A newly created include can satisfy previously unresolved directives.
        needsFullGraphRebuild = true;
        hasIndexChanges = true;
      } else if (textChanged) {
        hasIndexChanges = true;
        if (includeDirectivesChanged || previousText === undefined) {
          changedIncludeSources.add(file.uri);
        }
      }
    });

    if (hasIndexChanges) {
      if (!params.deferGraphRebuild) {
        if (needsFullGraphRebuild) {
          rebuildIncludeGraph();
        } else {
          changedIncludeSources.forEach((uri) => {
            includeGraph = updatePawnIncludeGraph(
              includeGraph,
              uri,
              indexedPawnFiles,
              indexedPawnTexts,
              includePathIndex,
              configuredIncludeDirectories,
              indexedPawnPathIndex
            );
          });
        }
      }

      if (semanticTokensRefreshSupported) {
        void connection.languages.semanticTokens.refresh();
      }
    }
  })
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
  documents.all().forEach((document) => scheduleCollectSymbols(document));
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

const buildCompletionItems = (uri: string, offset: number): CompletionItem[] => {
  const visibleUris = performanceStats.measure(
    "completion.includeClosure",
    () => getIncludedFileUris(uri, includeGraph)
  );
  performanceStats.count("completion.includeFiles", visibleUris.size);

  const sources: PawnCompletionSource[] = [];
  performanceStats.measure("completion.sourcePreparation", () => {
    visibleUris.forEach((visibleUri) => {
      performanceStats.count("completion.filesVisited");
      const text = getDocumentText(visibleUri);
      const needsSymbolIndex = text !== undefined &&
        indexedSymbolTexts.get(visibleUri) !== text;
      if (needsSymbolIndex) performanceStats.count("completion.filesIndexedOnDemand");

      const cached = analysisCache.get(visibleUri);
      if (!cached || cached.text !== text) {
        performanceStats.count("completion.filesParsedOnDemand");
      }

      performanceStats.measure("completion.ensureSymbolsIndexed", () =>
        ensureSymbolsIndexed(visibleUri)
      );
      const analysis = performanceStats.measure(
        "completion.getAnalysis",
        () => getAnalysis(visibleUri)
      );
      if (analysis) {
        sources.push({ uri: visibleUri, analysis });
        performanceStats.count("completion.sourceSymbols", analysis.symbols.length);
      }
    });
  });

  const items = performanceStats.measure(
    "completion.buildItems",
    () => buildPawnCompletionItems(uri, offset, sources)
  );
  performanceStats.count("completion.sources", sources.length);
  performanceStats.count("completion.candidateItems", items.length);
  return items;
};

connection.onCompletion((params: CompletionParams): CompletionList =>
  performanceStats.measure("completion.request", () => {
    const document = documents.get(params.textDocument.uri);
    if (!document) return { isIncomplete: false, items: [] };

    const offset = document.offsetAt(params.position);
    const items = buildCompletionItems(params.textDocument.uri, offset);
    const filteredItems = performanceStats.measure("completion.filterItems", () => {
      const prefixMatch = /[A-Za-z_@][A-Za-z0-9_@]*$/.exec(
        document.getText().slice(0, offset)
      );
      const prefix = prefixMatch ? prefixMatch[0].toLowerCase() : "";

      return prefix
        ? items.filter((item) =>
            String(item.filterText || item.label).toLowerCase().startsWith(prefix)
          )
        : items;
    });
    performanceStats.count("completion.returnedItems", filteredItems.length);

    return { isIncomplete: false, items: filteredItems };
  })
);

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
  if (cached && cached.text === text) {
    performanceStats.count("analysis.cacheHits");
    return cached.analysis;
  }

  performanceStats.count("analysis.cacheMisses");
  const analysis = analyzePawnMeasured(uri, text);
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
    ? performanceStats.measure(
        "workspace.compilationUnitLookup",
        () => getCompilationUnitUris(sourceUri, includeGraph)
      )
    : uris;
  performanceStats.count("workspace.analysisFiles", visibleUris.size);

  const result: WorkspacePawnAnalysis[] = [];
  performanceStats.measure("workspace.analysisPreparation", () => {
    visibleUris.forEach((uri) => {
      if (!uris.has(uri) && uri !== sourceUri) return;
      performanceStats.count("workspace.analysisFilesVisited");
      const before = analysisCache.get(uri);
      const text = getDocumentText(uri);
      const needsParse = text !== undefined && (!before || before.text !== text);
      if (needsParse) performanceStats.count("workspace.analysisFilesParsedOnDemand");
      const analysis = performanceStats.measure(
        "workspace.getAnalysis",
        () => getAnalysis(uri)
      );
      if (analysis) result.push({ uri, analysis });
    });
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

connection.languages.semanticTokens.on((params) =>
  performanceStats.measure("semanticTokens.request", () => {
  const document = documents.get(params.textDocument.uri);
  if (!document) return { data: [] };

  const analysis = getAnalysis(document.uri);
  if (!analysis) return { data: [] };

  // Semantic coloring only needs declarations from this file and the
  // files it actually includes. Walking the full compilation unit also pulls
  // in every sibling module and can expand to thousands of YSI files.
  const includedUris = performanceStats.measure(
    "semanticTokens.includeClosure",
    () => getIncludedFileUris(document.uri, includeGraph)
  );
  performanceStats.count("semanticTokens.includeFiles", includedUris.size);

  const workspace: WorkspacePawnAnalysis[] = [];
  performanceStats.measure("semanticTokens.analysisPreparation", () => {
    includedUris.forEach((uri) => {
      performanceStats.count("semanticTokens.filesVisited");
      const before = analysisCache.get(uri);
      const text = getDocumentText(uri);
      if (text !== undefined && (!before || before.text !== text)) {
        performanceStats.count("semanticTokens.filesParsedOnDemand");
      }
      const includedAnalysis = performanceStats.measure(
        "semanticTokens.getAnalysis",
        () => getAnalysis(uri)
      );
      if (includedAnalysis) workspace.push({ uri, analysis: includedAnalysis });
    });
  });
  performanceStats.count("semanticTokens.sourceSymbols", workspace.reduce(
    (total, entry) => total + entry.analysis.symbols.length,
    0
  ));

  const projectKinds = performanceStats.measure(
    "semanticTokens.projectSymbolIndex",
    () => {
      const index = new Map<string, PawnSymbol["kind"]>();
      workspace.forEach((entry) => {
        entry.analysis.symbols.forEach((symbol) => {
          if (!index.has(symbol.name) ||
              symbol.kind === "function" ||
              symbol.kind === "macro" ||
              symbol.kind === "enum" ||
              symbol.kind === "enumMember" ||
              symbol.kind === "type") {
            index.set(symbol.name, symbol.kind);
          }
        });
      });
      return index;
    }
  );

  const localSymbolsByName = performanceStats.measure(
    "semanticTokens.localSymbolIndex",
    () => {
      const index = new Map<string, PawnSymbol[]>();
      analysis.symbols.forEach((symbol) => {
        if (symbol.kind !== "local" && symbol.kind !== "parameter") return;
        const matches = index.get(symbol.name) || [];
        matches.push(symbol);
        index.set(symbol.name, matches);
      });
      // Keep the most recently declared candidate first so resolving a local
      // identifier does not filter and sort the complete symbol list each time.
      index.forEach((matches) =>
        matches.sort((left, right) => right.start - left.start)
      );
      return index;
    }
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
  const tokenPosition = createTextPositionCursor(analysis.text);

  performanceStats.measure("semanticTokens.classifyTokens", () =>
  analysis.tokens.forEach((token, tokenIndex) => {
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
        else if (kind !== undefined) tokenType = "variable";
        else if (isPawnFunctionInvocation(analysis.tokens, tokenIndex)) {
          // Highlight calls even when their native declaration is only visible
          // through the parent gamemode's includes, not this module's closure.
          tokenType = "function";
        } else tokenType = "variable";
      }
    }

    if (!tokenType) return;
    const typeIndex = tokenTypeIndex.get(tokenType);
    if (typeIndex === undefined) return;

    const position = tokenPosition(token.start, token.end);
    builder.push(
      position.line,
      position.character,
      token.end - token.start,
      typeIndex,
      isDeclaration ? 1 : 0
    );
  })
  );

  const result = builder.build();
  performanceStats.count("semanticTokens.inputTokens", analysis.tokens.length);
  performanceStats.count("semanticTokens.outputEntries", Math.floor(result.data.length / 5));
  return result;
  })
);

connection.onCompletionResolve((item: CompletionItem): CompletionItem => item);

connection.onHover((params: TextDocumentPositionParams): Hover | undefined =>
  performanceStats.measure("hover.request", () => {
    const doc = documents.get(params.textDocument.uri);
    if (!doc) return undefined;
    return doHover(doc, params.position);
  })
);

const getFunctionInCompilationUnit = (
  uri: string,
  identifier: string
) => {
  const visibleUris = performanceStats.measure(
    "hover.functionIncludeClosure",
    () => getIncludedFileUris(uri, includeGraph)
  );
  performanceStats.count("hover.functionFilesVisited", visibleUris.size);
  for (const visibleUri of visibleUris) {
    performanceStats.measure(
      "hover.functionEnsureSymbols",
      () => ensureSymbolsIndexed(visibleUri)
    );
    const functions = functionTokensByUri.get(visibleUri);
    if (!functions) continue;
    const found = Array.from(functions.entries()).find(
      ([name]) => name.toLowerCase() === identifier.toLowerCase()
    )?.[1];
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
    ensureSymbolsIndexed(visibleUri);
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
  const currentAnalysis = performanceStats.measure(
    "hover.currentAnalysis",
    () => getAnalysis(document.uri)
  );

  if (currentAnalysis && result.identifier) {
    const currentSymbol = performanceStats.measure(
      "hover.localSymbolResolve",
      () => resolvePawnSymbol(
        currentAnalysis,
        document.uri,
        cursorIndex,
        [currentAnalysis]
      )
    );
    if (currentSymbol) {
      return { contents: [formatPawnSymbolHover(currentSymbol)] };
    }

    // Only load wider include/parent scopes when the symbol is not declared
    // in the active file. Ordinary local-variable Hover stays lightweight.
    const workspace = performanceStats.measure(
      "hover.workspaceLookup",
      () => getWorkspaceAnalyses(document.uri)
    );
    const includedSymbol = performanceStats.measure(
      "hover.includedSymbolResolve",
      () => resolvePawnSymbol(
        currentAnalysis,
        document.uri,
        cursorIndex,
        workspace.map((entry) => entry.analysis)
      )
    );
    if (includedSymbol) {
      return { contents: [formatPawnSymbolHover(includedSymbol)] };
    }
  }

  const snip = performanceStats.measure(
    "hover.functionLookup",
    () => getFunctionInCompilationUnit(document.uri, result.identifier)
  );
  if (snip) {
    const contents: MarkedString[] = [];
    if (snip.completion.label !== undefined) contents.push(snip.completion.label);
    if (snip.completion.documentation !== undefined) {
      contents.push(String(snip.completion.documentation));
    }
    return { contents };
  }

  const definition = performanceStats.measure(
    "hover.definitionLookup",
    () => getDefinitionInCompilationUnit(document.uri, result.identifier)
  );
  if (definition) return { contents: [definition.completion.label] };

  return undefined;
};

connection.onSignatureHelp((params: SignatureHelpParams):
  | SignatureHelp
  | undefined =>
  performanceStats.measure("signatureHelp.request", () => {
    const doc = documents.get(params.textDocument.uri);
    if (!doc) return undefined;
    return doSignHelp(doc, params.position);
  })
);

const findFunctionSymbolInIncludeClosure = (
  uri: string,
  identifier: string
): { analysis: PawnAnalysis; symbol: PawnSymbol } | undefined => {
  const visibleUris = new Set<string>([
    ...getIncludedFileUris(uri, includeGraph),
    ...getCompilationUnitUris(uri, includeGraph),
  ]);

  for (const visibleUri of visibleUris) {
    ensureSymbolsIndexed(visibleUri);
    const analysis = getAnalysis(visibleUri);
    if (!analysis) continue;
    const symbol = analysis.symbols.find((candidate) =>
      (candidate.kind === "function" || candidate.kind === "macro") &&
      candidate.name.toLowerCase() === identifier.toLowerCase()
    );
    if (symbol) return { analysis, symbol };
  }
  return undefined;
};

const getFunctionSignatureParameters = (
  analysis: PawnAnalysis,
  symbol: PawnSymbol
): Array<{ label: string }> => {
  const nameIndex = analysis.tokens.findIndex((token) =>
    token.kind === "identifier" && token.start === symbol.start
  );
  if (nameIndex < 0 || analysis.tokens[nameIndex + 1]?.value !== "(") return [];

  const parameters: Array<{ label: string }> = [];
  let segmentStart = nameIndex + 2;
  let roundDepth = 0;
  let squareDepth = 0;
  let curlyDepth = 0;

  for (let index = nameIndex + 2; index < analysis.tokens.length; index++) {
    const token = analysis.tokens[index];
    if (token.kind !== "punctuation") continue;

    if (token.value === "(") roundDepth++;
    else if (token.value === ")") {
      if (roundDepth === 0 && squareDepth === 0 && curlyDepth === 0) {
        if (segmentStart < index) {
          parameters.push({
            label: analysis.text.slice(
              analysis.tokens[segmentStart].start,
              analysis.tokens[index - 1].end
            ).trim()
          });
        }
        break;
      }
      roundDepth--;
    } else if (token.value === "[") squareDepth++;
    else if (token.value === "]") squareDepth = Math.max(0, squareDepth - 1);
    else if (token.value === "{") curlyDepth++;
    else if (token.value === "}") curlyDepth = Math.max(0, curlyDepth - 1);
    else if (
      token.value === "," &&
      roundDepth === 0 && squareDepth === 0 && curlyDepth === 0
    ) {
      if (segmentStart < index) {
        parameters.push({
          label: analysis.text.slice(
            analysis.tokens[segmentStart].start,
            analysis.tokens[index - 1].end
          ).trim()
        });
      }
      segmentStart = index + 1;
    }
  }

  return parameters;
};

const doSignHelp = (
  document: TextDocument,
  position: Position
): SignatureHelp | undefined => {
  const content = document.getText();
  const cursorIndex = positionToIndex(content, position);
  const result = findFunctionIdentifier(content, cursorIndex);
  if (result.identifier === "") return undefined;

  const resolved = findFunctionSymbolInIncludeClosure(
    document.uri,
    result.identifier
  );
  const snip = getFunctionInCompilationUnit(document.uri, result.identifier);
  if (!resolved && !snip) return undefined;

  const macroSignature = resolved?.symbol.kind === "macro"
    ? getPawnMacroSignature(resolved.symbol)
    : undefined;
  const symbolParameters = resolved
    ? getPawnSignatureParameters(resolved.symbol)
    : undefined;
  const parameters = macroSignature?.parameters ||
    symbolParameters ||
    (resolved
      ? getFunctionSignatureParameters(resolved.analysis, resolved.symbol)
      : snip?.params || []);
  const functionSignature = resolved?.symbol.kind === "function"
    ? formatPawnFunctionSignature(resolved.symbol)
    : undefined;

  return {
    activeParameter: parameters.length > 0
      ? Math.min(result.parameterIndex, parameters.length - 1)
      : 0,
    activeSignature: 0,
    signatures: [{
      label: macroSignature?.label ||
        functionSignature ||
        resolved?.symbol.detail ||
        snip?.completion.label ||
        result.identifier,
      parameters,
      documentation: macroSignature?.documentation ||
        resolved?.symbol.documentation ||
        snip?.completion.documentation,
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

  const match = /^\s*#\s*include\s*(?:([<"])([^">]+)([>"])|([^\s]+))/i.exec(line);
  if (!match) return undefined;
  if ((match[1] === "<" && match[3] !== ">") ||
      (match[1] === '"' && match[3] !== '"')) return undefined;

  const includePath = (match[2] || match[4] || "").trim();
  const includeMode: PawnIncludeMode = match[1] === "<" ? "system" : "quoted";
  const pathStart = line.indexOf(includePath);
  if (
    position.character < pathStart ||
    position.character > pathStart + includePath.length
  ) {
    return undefined;
  }

  try {
    if (!document.uri.startsWith("file:")) return undefined;

    const matchingUris = resolveIncludeUris(
      document.uri,
      includePath,
      includeMode,
      indexedPawnFiles,
      includePathIndex,
      configuredIncludeDirectories,
      indexedPawnPathIndex
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
