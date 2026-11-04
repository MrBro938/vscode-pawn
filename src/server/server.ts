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
import {
  buildPawnCompletionItems,
  getPawnMacroSignature,
  PawnCompletionSource,
} from "./completion";
import {
  CompletionSourcesCache,
  refreshReadyCompletionSources,
} from "./completionSourceCache";
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
  PawnIncludeGraph,
  resolveIncludeUris,
  getIncludedFileUris,
  extractPawnIncludes,
  updatePawnIncludeGraph,
  normalizePawnPath,
  PawnIncludeMode,
  PawnFunctionSearchScope,
  getPawnSearchUris,
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

interface CompletionSourcesSnapshot {
  sources: PawnCompletionSource[];
  sourceIndexByUri: Map<string, number>;
  staleUris: Set<string>;
  includeFiles: number;
  sourceSymbols: number;
}

// Completion source analyses change only when source text, the indexed file
// set, include graph or search scope changes. A lazy analysis cache miss in an
// unrelated file must not invalidate these prepared sources.
const completionSourcesCache = new CompletionSourcesCache<CompletionSourcesSnapshot>(8);
const invalidateCompletionSources = () => completionSourcesCache.clear();

// Ordinary source edits only stale the corresponding analysis in snapshots.
// Include-graph and file-set changes still clear the complete cache.
const markCompletionSourceStale = (uri: string) => {
  completionSourcesCache.forEachValue((snapshot) => {
    if (snapshot.sourceIndexByUri.has(uri)) snapshot.staleUris.add(uri);
  });
};
const indexedSymbolTexts = new Map<string, string>();
let semanticTokensRefreshSupported = false;

interface SemanticTokensCacheEntry {
  analysis: PawnAnalysis;
  generation: number;
  result: ReturnType<SemanticTokensBuilder["build"]>;
}

interface SemanticTokensContext {
  analysis: PawnAnalysis;
  generation: number;
  projectKinds: Map<string, PawnSymbol["kind"]>;
  localSymbolsByName: Map<string, PawnSymbol[]>;
  declarations: Map<number, PawnSymbol>;
}

// The generation changes whenever a Pawn source, cached analysis or include
// graph changes. This lets cached range responses validate in O(1) without
// walking every include on each editor request.
let semanticTokensGeneration = 0;

// Keep a small LRU of range responses plus one symbol-resolution context per
// recently used document. The context is shared by all visible ranges.
const semanticTokensCache = new Map<string, SemanticTokensCacheEntry>();
const MAX_SEMANTIC_TOKEN_CACHE_ENTRIES = 24;
const semanticTokensContextCache = new Map<string, SemanticTokensContext>();
const MAX_SEMANTIC_TOKEN_CONTEXTS = 2;

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
let configuredFunctionSearchScope: PawnFunctionSearchScope = "includes";

const setFunctionSearchScope = (scope?: string) => {
  const nextScope: PawnFunctionSearchScope =
    scope === "compilationUnit" || scope === "workspace"
      ? scope
      : "includes";
  if (nextScope === configuredFunctionSearchScope) return;

  configuredFunctionSearchScope = nextScope;
  invalidateCompletionSources();
};

const rebuildIncludeGraph = () => performanceStats.measure(
  "include.graphRebuild",
  () => {
    semanticTokensGeneration++;
    invalidateCompletionSources();
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
      semanticTokensGeneration++;
      markCompletionSourceStale(uri);
      if (includeGraphChanged) invalidateCompletionSources();
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

  semanticTokensGeneration++;
  invalidateCompletionSources();
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
      range: true,
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
  const analysis = performanceStats.measure("analysis.parse", () => analyzePawn(text));
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
    const analysis = cachedAnalysis?.text === text
      ? cachedAnalysis.analysis
      : (() => {
          semanticTokensGeneration++;
          return analyzePawnMeasured(textDocument.uri, text);
        })();
    analysisCache.set(textDocument.uri, { text, analysis });
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
    functionSearchScope?: string;
  }) => {
    configuredWorkspaceRoots = (params.workspaceRoots || [])
      .filter((value) => typeof value === "string")
      .map((value) => path.resolve(value));
    configuredIncludePaths = (params.includePaths || [])
      .filter((value) => typeof value === "string");
    configuredCompilerPath =
      typeof params.compilerPath === "string" ? params.compilerPath : "";
    setFunctionSearchScope(params.functionSearchScope);

    reloadConfiguredIncludes();
  }
);

connection.onNotification(
  "pawn/functionSearchScope",
  (params: { scope?: string }) => setFunctionSearchScope(params.scope)
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

const getCompletionSources = (uri: string): CompletionSourcesSnapshot => {
  const cached = completionSourcesCache.getOrCreate(uri, () => {
    const visibleUris = getFunctionSearchUris(uri);
    const sources: PawnCompletionSource[] = [];
    const sourceIndexByUri = new Map<string, number>();
    let sourceSymbols = 0;

    performanceStats.measure("completion.sourcePreparation", () => {
      visibleUris.forEach((visibleUri) => {
        performanceStats.count("completion.filesVisited");
        const text = getDocumentText(visibleUri);
        const analysisEntry = analysisCache.get(visibleUri);
        if (!analysisEntry || analysisEntry.text !== text) {
          performanceStats.count("completion.filesParsedOnDemand");
        }

        const analysis = performanceStats.measure(
          "completion.getAnalysis",
          () => getAnalysis(visibleUri)
        );
        if (analysis) {
          sourceIndexByUri.set(visibleUri, sources.length);
          sources.push({ uri: visibleUri, analysis });
          sourceSymbols += analysis.symbols.length;
        }
      });
    });

    return {
      sources,
      sourceIndexByUri,
      staleUris: new Set<string>(),
      includeFiles: visibleUris.size,
      sourceSymbols,
    };
  });

  const snapshot = cached.value;
  if (cached.cacheHit) {
    performanceStats.count("completion.sourceCacheHits");

    if (snapshot.staleUris.size > 0) {
      const deferred = performanceStats.measure("completion.sourceRefresh", () =>
        refreshReadyCompletionSources(
          snapshot.staleUris,
          (staleUri) => {
            const text = getDocumentText(staleUri);
            const cachedAnalysis = analysisCache.get(staleUri);
            // A current cached analysis is always safe to apply. Otherwise,
            // wait for the document's debounced background parse rather than
            // forcing a 500ms+ full-file parse in the completion request.
            return cachedAnalysis?.text === text || !pendingParses.has(staleUri);
          },
          (staleUri) => {
            const sourceIndex = snapshot.sourceIndexByUri.get(staleUri);
            if (sourceIndex === undefined) return;

            const previous = snapshot.sources[sourceIndex];
            const text = getDocumentText(staleUri);
            const cachedAnalysis = analysisCache.get(staleUri);
            let analysis = cachedAnalysis?.text === text
              ? cachedAnalysis.analysis
              : undefined;

            if (!analysis) {
              if (text === undefined) return;
              performanceStats.count("completion.filesParsedOnDemand");
              analysis = performanceStats.measure(
                "completion.getAnalysis",
                () => getAnalysis(staleUri)
              );
            }
            if (!analysis) return;

            snapshot.sourceSymbols += analysis.symbols.length - previous.analysis.symbols.length;
            snapshot.sources[sourceIndex] = { uri: staleUri, analysis };
            performanceStats.count("completion.sourceCacheRefreshedFiles");
          }
        )
      );
      if (deferred > 0) {
        performanceStats.count("completion.sourceRefreshDeferred", deferred);
      }
    }
  } else {
    performanceStats.count("completion.sourceCacheMisses");
  }

  return snapshot;
};

const buildCompletionItems = (
  uri: string,
  offset: number,
  prefix: string
): CompletionItem[] => {
  const prepared = getCompletionSources(uri);
  performanceStats.count("completion.includeFiles", prepared.includeFiles);
  performanceStats.count("completion.sourceSymbols", prepared.sourceSymbols);

  const items = performanceStats.measure(
    "completion.buildItems",
    () => buildPawnCompletionItems(uri, offset, prepared.sources, prefix)
  );
  performanceStats.count("completion.sources", prepared.sources.length);
  performanceStats.count("completion.candidateItems", items.length);
  return items;
};

connection.onCompletion((params: CompletionParams): CompletionList =>
  performanceStats.measure("completion.request", () => {
    const document = documents.get(params.textDocument.uri);
    if (!document) return { isIncomplete: false, items: [] };

    const offset = document.offsetAt(params.position);
    const prefix = performanceStats.measure("completion.prefixExtraction", () => {
      const linePrefix = document.getText({
        start: { line: params.position.line, character: 0 },
        end: params.position,
      });
      const prefixMatch = /[A-Za-z_@][A-Za-z0-9_@]*$/.exec(linePrefix);
      return prefixMatch ? prefixMatch[0].toLowerCase() : "";
    });
    const items = buildCompletionItems(params.textDocument.uri, offset, prefix);
    performanceStats.count("completion.returnedItems", items.length);

    return { isIncomplete: false, items };
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
  semanticTokensGeneration++;
  const analysis = analyzePawnMeasured(uri, text);
  analysisCache.set(uri, { text, analysis });
  return analysis;
};

interface WorkspacePawnAnalysis {
  uri: string;
  analysis: PawnAnalysis;
}

const getFunctionSearchUris = (sourceUri: string): Set<string> => {
  const workspaceUris = new Set<string>(indexedPawnFiles.keys());
  documents.all().forEach((document) => workspaceUris.add(document.uri));
  return performanceStats.measure(
    "functionSearch.scopeLookup",
    () => getPawnSearchUris(
      sourceUri,
      includeGraph,
      configuredFunctionSearchScope,
      workspaceUris
    )
  );
};

const getWorkspaceAnalyses = (sourceUri?: string): WorkspacePawnAnalysis[] => {
  const uris = new Set<string>(indexedPawnFiles.keys());
  documents.all().forEach((document) => uris.add(document.uri));

  const visibleUris = sourceUri
    ? getFunctionSearchUris(sourceUri)
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

connection.languages.semanticTokens.onRange((params) =>
  performanceStats.measure("semanticTokens.request", () => {
  const document = documents.get(params.textDocument.uri);
  if (!document) return { data: [] };

  const rangeStart = document.offsetAt(params.range.start);
  const rangeEnd = document.offsetAt(params.range.end);
  if (rangeEnd <= rangeStart) return { data: [] };

  const analysis = getAnalysis(document.uri);
  if (!analysis) return { data: [] };

  const cacheKey = `${document.uri}:${rangeStart}:${rangeEnd}`;
  const cachedTokens = semanticTokensCache.get(cacheKey);
  if (
    cachedTokens &&
    cachedTokens.analysis === analysis &&
    cachedTokens.generation === semanticTokensGeneration
  ) {
    performanceStats.count("semanticTokens.cacheHits");
    semanticTokensCache.delete(cacheKey);
    semanticTokensCache.set(cacheKey, cachedTokens);
    return cachedTokens.result;
  }
  if (cachedTokens) semanticTokensCache.delete(cacheKey);
  performanceStats.count("semanticTokens.cacheMisses");

  let context = semanticTokensContextCache.get(document.uri);
  if (
    !context ||
    context.analysis !== analysis ||
    context.generation !== semanticTokensGeneration
  ) {
    performanceStats.count("semanticTokens.contextCacheMisses");

    // Only rebuild the include workspace and symbol indexes after a real
    // source/analysis/graph change. Scrolling through a file reuses this context.
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
        // identifier does not filter and sort the complete symbol list per token.
        index.forEach((matches) =>
          matches.sort((left, right) => right.start - left.start)
        );
        return index;
      }
    );

    const declarations = new Map<number, PawnSymbol>();
    analysis.symbols.forEach((symbol) => declarations.set(symbol.start, symbol));

    context = {
      analysis,
      generation: semanticTokensGeneration,
      projectKinds,
      localSymbolsByName,
      declarations,
    };
    semanticTokensContextCache.delete(document.uri);
    semanticTokensContextCache.set(document.uri, context);
    while (semanticTokensContextCache.size > MAX_SEMANTIC_TOKEN_CONTEXTS) {
      const oldestUri = semanticTokensContextCache.keys().next().value;
      if (oldestUri === undefined) break;
      semanticTokensContextCache.delete(oldestUri);
    }
  } else {
    performanceStats.count("semanticTokens.contextCacheHits");
    semanticTokensContextCache.delete(document.uri);
    semanticTokensContextCache.set(document.uri, context);
  }

  const { projectKinds, localSymbolsByName, declarations } = context;

  // Token arrays are ordered by source offset. Binary-search the requested
  // range so only visible tokens are classified.
  let low = 0;
  let high = analysis.tokens.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (analysis.tokens[middle].start < rangeStart) low = middle + 1;
    else high = middle;
  }
  const firstTokenIndex = low;

  low = firstTokenIndex;
  high = analysis.tokens.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (analysis.tokens[middle].start < rangeEnd) low = middle + 1;
    else high = middle;
  }
  const endTokenIndex = low;

  const typeAnnotationStarts = new Set<number>();
  for (let index = firstTokenIndex; index < endTokenIndex; index++) {
    const token = analysis.tokens[index];
    const next = analysis.tokens[index + 1];
    if (
      token.kind === "identifier" &&
      next !== undefined &&
      token.end === next.start &&
      next.kind === "punctuation" &&
      next.value === ":"
    ) {
      typeAnnotationStarts.add(token.start);
    }
  }

  const tokenTypes = semanticLegend.tokenTypes;
  const tokenTypeIndex = new Map(tokenTypes.map((type, index) => [type, index]));
  const builder = new SemanticTokensBuilder();

  let processedTokenCount = 0;
  performanceStats.measure("semanticTokens.classifyTokens", () => {
    for (let tokenIndex = firstTokenIndex; tokenIndex < endTokenIndex; tokenIndex++) {
      const token = analysis.tokens[tokenIndex];
      processedTokenCount++;
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

      if (!tokenType) continue;
      const typeIndex = tokenTypeIndex.get(tokenType);
      if (typeIndex === undefined) continue;

      const position = document.positionAt(token.start);
      builder.push(
        position.line,
        position.character,
        token.end - token.start,
        typeIndex,
        isDeclaration ? 1 : 0
      );
    }
  });

  const result = builder.build();
  performanceStats.count("semanticTokens.inputTokens", processedTokenCount);
  performanceStats.count("semanticTokens.outputEntries", Math.floor(result.data.length / 5));

  semanticTokensCache.delete(cacheKey);
  semanticTokensCache.set(cacheKey, {
    analysis,
    generation: semanticTokensGeneration,
    result,
  });
  while (semanticTokensCache.size > MAX_SEMANTIC_TOKEN_CACHE_ENTRIES) {
    const oldestKey = semanticTokensCache.keys().next().value;
    if (oldestKey === undefined) break;
    semanticTokensCache.delete(oldestKey);
  }

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

const getFunctionInSearchScope = (
  uri: string,
  identifier: string
) => {
  const visibleUris = getFunctionSearchUris(uri);
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

const getDefinitionInSearchScope = (
  uri: string,
  identifier: string
) => {
  const visibleUris = getFunctionSearchUris(uri);
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
    () => getFunctionInSearchScope(document.uri, result.identifier)
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
    () => getDefinitionInSearchScope(document.uri, result.identifier)
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

const findFunctionSymbolInSearchScope = (
  uri: string,
  identifier: string
): { analysis: PawnAnalysis; symbol: PawnSymbol } | undefined => {
  const visibleUris = getFunctionSearchUris(uri);

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

  const resolved = findFunctionSymbolInSearchScope(
    document.uri,
    result.identifier
  );
  const snip = getFunctionInSearchScope(document.uri, result.identifier);
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
  const functionSymbol = getFunctionInSearchScope(document.uri, result.identifier);
  if (functionSymbol) return functionSymbol.definition;

  const definition = getDefinitionInSearchScope(document.uri, result.identifier);
  if (definition) return definition.definition;

  return undefined;
};

connection.listen();
