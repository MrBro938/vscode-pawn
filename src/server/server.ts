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

const normalizeIndexPath = (value: string) => {
  const normalized = path.normalize(value);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
};

const indexPawnFile = (uri: string, text?: string) => {
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
  } catch {
    // Ignore malformed or unsupported URIs.
  }
};

const unindexPawnFile = (uri: string) => {
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
        unindexPawnFile(uri);
        analysisCache.delete(uri);
        removeDocumentSymbols(uri);
      });
    }

    if (params.files) {
      params.files.forEach((file) => {
        indexPawnFile(file.uri, file.text);
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

const getDocumentSymbols = (document: TextDocument): DocumentSymbol[] => {
  const lines = document.getText().split(/\r?\n/);
  const symbols: DocumentSymbol[] = [];
  const functionPattern = /^\s*(?:(?:public|stock|static|native|forward)\s+)*(?:[A-Za-z_][A-Za-z0-9_]*:\s*)?([A-Za-z_][A-Za-z0-9_]*)\s*\(/i;
  const definePattern = /^\s*#\s*define\s+([A-Za-z_][A-Za-z0-9_]*)/i;
  const excludedNames = new Set([
    "if", "else", "while", "for", "do", "switch", "case", "return",
    "sizeof", "state", "new", "delete", "assert", "exit", "break",
    "continue", "goto"
  ]);

  lines.forEach((line, lineNumber) => {
    const defineMatch = definePattern.exec(line);
    if (defineMatch) {
      const name = defineMatch[1];
      const character = line.indexOf(name);
      symbols.push({
        name,
        detail: "#define",
        kind: SymbolKind.Constant,
        range: {
          start: { line: lineNumber, character: 0 },
          end: { line: lineNumber, character: line.length },
        },
        selectionRange: {
          start: { line: lineNumber, character },
          end: { line: lineNumber, character: character + name.length },
        },
      });
      return;
    }

    const functionMatch = functionPattern.exec(line);
    if (!functionMatch) return;

    const name = functionMatch[1];
    if (excludedNames.has(name.toLowerCase())) return;

    const character = line.indexOf(name, functionMatch.index);
    symbols.push({
      name,
      detail: line.trim(),
      kind: SymbolKind.Function,
      range: {
        start: { line: lineNumber, character: 0 },
        end: { line: lineNumber, character: line.length },
      },
      selectionRange: {
        start: { line: lineNumber, character },
        end: { line: lineNumber, character: character + name.length },
      },
    });
  });

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

const getWorkspaceAnalyses = (): WorkspacePawnAnalysis[] => {
  const uris = new Set<string>(indexedPawnFiles.keys());
  documents.all().forEach((document) => uris.add(document.uri));

  const result: WorkspacePawnAnalysis[] = [];
  uris.forEach((uri) => {
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

  const workspace = getWorkspaceAnalyses();
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

  const workspace = getWorkspaceAnalyses();
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

  const localSymbols = analysis.symbols.filter(
    (symbol) => symbol.kind === "local" || symbol.kind === "parameter"
  );
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
      } else if (analysis.tokens.some((candidate) =>
        candidate.start === token.end && candidate.kind === "punctuation" && candidate.value === ":"
      )) {
        tokenType = "type";
      } else {
        const local = localSymbols
          .filter((symbol) =>
            symbol.name === token.value &&
            token.start >= symbol.scopeStart &&
            token.start <= symbol.scopeEnd &&
            symbol.start <= token.start
          )
          .sort((a, b) => b.start - a.start)[0];

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
    const matchingUris = new Set<string>();

    includeVariants.forEach((candidate) => {
      const parts = candidate.split(path.sep);
      while (parts.length > 0 && (parts[0] === ".." || parts[0] === ".")) {
        parts.shift();
      }

      const suffix = parts.join(path.sep);
      if (!suffix) return;

      const matches = includePathIndex.get(normalizeIndexPath(suffix));
      if (matches) matches.forEach((uri) => matchingUris.add(uri));
    });

    const locations = Array.from(matchingUris)
      .map((uri) => indexedPawnFiles.get(uri))
      .filter((targetPath): targetPath is string =>
        targetPath !== undefined && isFile(targetPath)
      )
      .map((targetPath) => path.resolve(targetPath))
      .filter((targetPath, index, all) => all.indexOf(targetPath) === index)
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
