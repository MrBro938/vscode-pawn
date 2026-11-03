import * as path from "path";
import { fileURLToPath } from "url";

const normalizePath = (value: string): string => {
  const normalized = path.normalize(value);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
};

const includeVariants = (includePath: string): string[] => {
  const normalized = path.normalize(includePath.replace(/[\\/]+/g, path.sep));
  const variants = [normalized];

  if (!path.extname(normalized)) {
    variants.push(
      normalized + ".inc",
      normalized + ".pwn",
      normalized + ".pawn",
      normalized + ".p"
    );
  }

  return variants;
};

export const extractPawnIncludes = (text: string): string[] => {
  const includes: string[] = [];
  const lines = text.split(/\r?\n/);
  let insideBlockComment = false;

  lines.forEach((line) => {
    let index = 0;

    // Ignore comments before a preprocessor directive, including multi-line
    // block comments. A commented-out #include must not create a graph edge.
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

    const match = /^#\s*include\s*[<"]([^">]+)[">]/i.exec(line.slice(index));
    const includePath = match?.[1]?.trim();
    if (includePath) includes.push(includePath);
  });

  return includes;
};

export const resolveIncludeUris = (
  sourceUri: string,
  includePath: string,
  indexedPawnFiles: ReadonlyMap<string, string>,
  includePathIndex: ReadonlyMap<string, ReadonlySet<string>>
): string[] => {
  if (!sourceUri.startsWith("file:")) return [];

  try {
    const sourceFile = fileURLToPath(sourceUri);
    const variants = includeVariants(includePath);
    const indexedPaths = Array.from(indexedPawnFiles.entries());

    // Prefer a path relative to the including file when it exists in the index.
    for (const variant of variants) {
      const directPath = path.isAbsolute(variant)
        ? path.normalize(variant)
        : path.resolve(path.dirname(sourceFile), variant);
      const directMatch = indexedPaths.find(
        ([, filePath]) => normalizePath(filePath) === normalizePath(directPath)
      );
      if (directMatch) return [directMatch[0]];
    }

    // Fall back to a suffix lookup. This handles project-style include paths
    // such as "modules/feature/public/file.pwn" and "../shared/file.inc".
    const matches = new Set<string>();

    variants.forEach((variant) => {
      const parts = variant.split(/[\\/]+/);
      while (
        parts.length > 0 &&
        (parts[0] === "" || parts[0] === "." || parts[0] === "..")
      ) {
        parts.shift();
      }

      const suffix = parts.join(path.sep);
      if (!suffix) return;

      const indexedMatches = includePathIndex.get(normalizePath(suffix));
      if (indexedMatches) indexedMatches.forEach((uri) => matches.add(uri));
    });

    return Array.from(matches).sort();
  } catch {
    return [];
  }
};

export type PawnIncludeGraph = Map<string, Set<string>>;

export const buildPawnIncludeGraph = (
  indexedPawnFiles: ReadonlyMap<string, string>,
  indexedPawnTexts: ReadonlyMap<string, string>,
  includePathIndex: ReadonlyMap<string, ReadonlySet<string>>
): PawnIncludeGraph => {
  const graph: PawnIncludeGraph = new Map();

  indexedPawnTexts.forEach((text, uri) => {
    const targets = new Set<string>();

    extractPawnIncludes(text).forEach((includePath) => {
      resolveIncludeUris(
        uri,
        includePath,
        indexedPawnFiles,
        includePathIndex
      ).forEach((targetUri) => targets.add(targetUri));
    });

    graph.set(uri, targets);
  });

  // Keep empty nodes for indexed files whose text is temporarily unavailable.
  indexedPawnFiles.forEach((_filePath, uri) => {
    if (!graph.has(uri)) graph.set(uri, new Set());
  });

  return graph;
};

/**
 * Returns the full set of Pawn files belonging to the same compilation unit.
 * It walks up to all includers, finds their roots, then walks down all includes
 * from those roots. Sibling modules included by one gamemode are therefore
 * related, while unrelated workspace folders stay isolated.
 */
export const getCompilationUnitUris = (
  sourceUri: string,
  graph: PawnIncludeGraph
): Set<string> => {
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

  // A graph entry may have not been built yet during initial workspace indexing.
  compilationUnit.add(sourceUri);
  return compilationUnit;
};
