import * as path from "path";
import { fileURLToPath } from "url";

export type PawnIncludeMode = "quoted" | "system";

export interface PawnIncludeDirective {
  path: string;
  mode: PawnIncludeMode;
}

export const normalizePawnPath = (value: string): string => {
  const normalized = path.normalize(value);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
};

const normalizeIncludePath = (value: string): string =>
  value.replace(/[\\/]+/g, path.sep);

const includeVariants = (includePath: string): string[] => {
  const normalized = normalizeIncludePath(includePath);
  const variants = [normalized];

  if (!path.extname(normalized)) {
    // Pawn compiler tries these extensions in this order. .pwn is retained
    // as a compatibility fallback for projects that include source files.
    variants.push(
      normalized + ".inc",
      normalized + ".p",
      normalized + ".pawn",
      normalized + ".pwn"
    );
  }

  return variants;
};

export const extractPawnIncludes = (text: string): PawnIncludeDirective[] => {
  const includes: PawnIncludeDirective[] = [];
  const lines = text.split(/\r?\n/);
  let insideBlockComment = false;

  lines.forEach((line) => {
    let index = 0;

    while (index < line.length) {
      if (insideBlockComment) {
        const close = line.indexOf("*/", index);
        if (close === -1) return;
        insideBlockComment = false;
        index = close + 2;
        continue;
      }

      while (index < line.length && /\s/.test(line[index])) index++;
      if (line.startsWith("//", index)) return;
      if (line.startsWith("/*", index)) {
        insideBlockComment = true;
        index += 2;
        continue;
      }
      break;
    }

    if (insideBlockComment) return;

    const match = /^#\s*include\s*(?:([<"])([^">]+)([>"])|([^\s]+))/i.exec(line.slice(index));
    if (!match) return;
    if ((match[1] === "<" && match[3] !== ">") ||
        (match[1] === '"' && match[3] !== '"')) return;

    const includePath = (match[2] || match[4] || "").trim();
    if (!includePath) return;

    includes.push({
      path: includePath,
      // Unquoted and double-quoted includes are local includes in Pawn.
      mode: match[1] === "<" ? "system" : "quoted",
    });
  });

  return includes;
};

export const buildPawnPathIndex = (
  indexedPawnFiles: ReadonlyMap<string, string>
): Map<string, string> => {
  const index = new Map<string, string>();
  indexedPawnFiles.forEach((filePath, uri) => {
    index.set(normalizePawnPath(filePath), uri);
  });
  return index;
};

const findInDirectory = (
  directory: string,
  variants: string[],
  directPathIndex: ReadonlyMap<string, string>
): string | undefined => {
  for (const variant of variants) {
    const candidate = path.resolve(directory, variant);
    const match = directPathIndex.get(normalizePawnPath(candidate));
    if (match) return match;
  }
  return undefined;
};

export const resolveIncludeUris = (
  sourceUri: string,
  includePath: string,
  mode: PawnIncludeMode,
  indexedPawnFiles: ReadonlyMap<string, string>,
  includePathIndex: ReadonlyMap<string, ReadonlySet<string>>,
  includeDirectories: readonly string[] = [],
  suppliedDirectPathIndex?: ReadonlyMap<string, string>
): string[] => {
  if (!sourceUri.startsWith("file:")) return [];

  try {
    const sourceFile = fileURLToPath(sourceUri);
    const variants = includeVariants(includePath);
    const directPathIndex = suppliedDirectPathIndex ||
      buildPawnPathIndex(indexedPawnFiles);

    // Both quote and angle includes can be absolute, though this is uncommon.
    if (path.isAbsolute(variants[0])) {
      const absoluteMatch = variants
        .map((variant) => directPathIndex.get(normalizePawnPath(path.resolve(variant))))
        .find((uri): uri is string => uri !== undefined);
      if (absoluteMatch) return [absoluteMatch];
    }

    // Quoted includes are relative to the including file first. Angle includes
    // deliberately do not search the source file's directory.
    if (mode === "quoted") {
      const localMatch = findInDirectory(
        path.dirname(sourceFile),
        variants,
        directPathIndex
      );
      if (localMatch) return [localMatch];
    }

    // The ordered include directory list mirrors pawncc's -i search order.
    // Return the first match only: later folders must not override an earlier
    // compiler search path with a file bearing the same name.
    for (const directory of includeDirectories) {
      const match = findInDirectory(directory, variants, directPathIndex);
      if (match) return [match];
    }

    // Compatibility fallback is only used when no compiler include paths
    // were discovered. With a configured search path, returning a same-suffix
    // file from an unrelated directory would disagree with pawncc.
    if (includeDirectories.length > 0) return [];

    const matches = new Set<string>();
    const localCandidatePaths = new Set(
      variants.map((variant) =>
        normalizePawnPath(path.resolve(path.dirname(sourceFile), variant))
      )
    );
    variants.forEach((variant) => {
      const parts = variant.split(/[\\/]+/);
      while (parts.length > 0 &&
        (parts[0] === "" || parts[0] === "." || parts[0] === "..")) {
        parts.shift();
      }
      const suffix = normalizePawnPath(parts.join(path.sep));
      const indexedMatches = includePathIndex.get(suffix);
      if (!indexedMatches) return;

      indexedMatches.forEach((uri) => {
        const indexedPath = indexedPawnFiles.get(uri);
        if (
          mode === "system" &&
          indexedPath &&
          localCandidatePaths.has(normalizePawnPath(indexedPath))
        ) return;
        matches.add(uri);
      });
    });

    return Array.from(matches).sort();
  } catch {
    return [];
  }
};

export type PawnIncludeGraph = Map<string, Set<string>>;

const compilationUnitCache = new WeakMap<PawnIncludeGraph, Map<string, Set<string>>>();
const includedUrisCache = new WeakMap<PawnIncludeGraph, Map<string, Set<string>>>();

export const getIncludedFileUris = (
  sourceUri: string,
  graph: PawnIncludeGraph
): Set<string> => {
  let graphCache = includedUrisCache.get(graph);
  if (!graphCache) {
    graphCache = new Map<string, Set<string>>();
    includedUrisCache.set(graph, graphCache);
  }

  const cached = graphCache.get(sourceUri);
  if (cached) return cached;

  const included = new Set<string>();
  const pending = [sourceUri];
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (included.has(current)) continue;
    included.add(current);
    graph.get(current)?.forEach((target) => {
      if (!included.has(target)) pending.push(target);
    });
  }

  graphCache.set(sourceUri, included);
  return included;
};

export const buildPawnIncludeGraph = (
  indexedPawnFiles: ReadonlyMap<string, string>,
  indexedPawnTexts: ReadonlyMap<string, string>,
  includePathIndex: ReadonlyMap<string, ReadonlySet<string>>,
  includeDirectories: readonly string[] = []
): PawnIncludeGraph => {
  const graph: PawnIncludeGraph = new Map();
  const directPathIndex = buildPawnPathIndex(indexedPawnFiles);

  indexedPawnTexts.forEach((text, uri) => {
    const targets = new Set<string>();

    extractPawnIncludes(text).forEach((directive) => {
      resolveIncludeUris(
        uri,
        directive.path,
        directive.mode,
        indexedPawnFiles,
        includePathIndex,
        includeDirectories,
        directPathIndex
      ).forEach((targetUri) => targets.add(targetUri));
    });

    graph.set(uri, targets);
  });

  indexedPawnFiles.forEach((_filePath, uri) => {
    if (!graph.has(uri)) graph.set(uri, new Set());
  });

  return graph;
};

/**
 * Replaces the include edges for one already indexed source file. A content
 * edit that changes only code (not #include directives) does not need to touch
 * the graph at all; this helper handles the less common include-directive edit
 * without reparsing every other file in a large workspace.
 */
export const updatePawnIncludeGraph = (
  graph: PawnIncludeGraph,
  sourceUri: string,
  indexedPawnFiles: ReadonlyMap<string, string>,
  indexedPawnTexts: ReadonlyMap<string, string>,
  includePathIndex: ReadonlyMap<string, ReadonlySet<string>>,
  includeDirectories: readonly string[] = [],
  directPathIndex?: ReadonlyMap<string, string>
): PawnIncludeGraph => {
  const updated = new Map(graph);
  const text = indexedPawnTexts.get(sourceUri);
  if (text === undefined || !indexedPawnFiles.has(sourceUri)) {
    updated.delete(sourceUri);
    return updated;
  }

  const pathIndex = directPathIndex || buildPawnPathIndex(indexedPawnFiles);
  const targets = new Set<string>();
  extractPawnIncludes(text).forEach((directive) => {
    resolveIncludeUris(
      sourceUri,
      directive.path,
      directive.mode,
      indexedPawnFiles,
      includePathIndex,
      includeDirectories,
      pathIndex
    ).forEach((targetUri) => targets.add(targetUri));
  });

  updated.set(sourceUri, targets);
  return updated;
};

/**
 * Returns all files connected to a source through include parents and children.
 * This is used for cross-file symbol lookup, not for compiler include resolution.
 */
export const getCompilationUnitUris = (
  sourceUri: string,
  graph: PawnIncludeGraph
): Set<string> => {
  let graphCache = compilationUnitCache.get(graph);
  if (!graphCache) {
    graphCache = new Map<string, Set<string>>();
    compilationUnitCache.set(graph, graphCache);
  }

  const cached = graphCache.get(sourceUri);
  if (cached) return cached;

  const reverse = new Map<string, Set<string>>();
  graph.forEach((targets, source) => {
    targets.forEach((target) => {
      let parents = reverse.get(target);
      if (!parents) {
        parents = new Set<string>();
        reverse.set(target, parents);
      }
      parents.add(source);
    });
  });

  const ancestors = new Set<string>([sourceUri]);
  const queue = [sourceUri];
  while (queue.length > 0) {
    const current = queue.shift()!;
    reverse.get(current)?.forEach((parent) => {
      if (ancestors.has(parent)) return;
      ancestors.add(parent);
      queue.push(parent);
    });
  }

  const roots = Array.from(ancestors).filter(
    (uri) => (reverse.get(uri)?.size || 0) === 0
  );
  const seeds = roots.length > 0 ? roots : Array.from(ancestors);

  const compilationUnit = new Set<string>();
  const pending = [...seeds];
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (compilationUnit.has(current)) continue;
    compilationUnit.add(current);
    graph.get(current)?.forEach((target) => {
      if (!compilationUnit.has(target)) pending.push(target);
    });
  }

  compilationUnit.add(sourceUri);
  graphCache.set(sourceUri, compilationUnit);
  return compilationUnit;
};


export type PawnFunctionSearchScope = "includes" | "compilationUnit" | "workspace";

/**
 * Resolves the files eligible for cross-file function/symbol lookup.
 * Workspace scope deliberately uses the already-indexed file list supplied by
 * the caller; include and compilation-unit scopes stay bounded by the graph.
 */
export const getPawnSearchUris = (
  sourceUri: string,
  graph: PawnIncludeGraph,
  scope: PawnFunctionSearchScope = "includes",
  workspaceUris?: Iterable<string>
): Set<string> => {
  if (scope === "workspace") {
    const result = new Set(workspaceUris || graph.keys());
    result.add(sourceUri);
    return result;
  }

  if (scope === "compilationUnit") {
    return getCompilationUnitUris(sourceUri, graph);
  }

  return getIncludedFileUris(sourceUri, graph);
};
