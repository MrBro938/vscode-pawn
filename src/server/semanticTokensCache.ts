export type SemanticTokensDependencyInvalidationReason =
  | "graphChanged"
  | "sourceVersionChanged"
  | "analysisChanged";

export interface SemanticTokensDependencySnapshot<TAnalysis> {
  graphGeneration: number;
  sourceVersions: ReadonlyMap<string, number>;
  sourceAnalyses: ReadonlyMap<string, TAnalysis>;
}

export function getSemanticTokensDependencyInvalidationReason<TAnalysis>(
  snapshot: SemanticTokensDependencySnapshot<TAnalysis>,
  currentGraphGeneration: number,
  getSourceVersion: (uri: string) => number,
  getCachedAnalysis: (uri: string) => TAnalysis | undefined
): SemanticTokensDependencyInvalidationReason | undefined {
  if (snapshot.graphGeneration !== currentGraphGeneration) {
    return "graphChanged";
  }

  for (const [uri, version] of snapshot.sourceVersions) {
    if (getSourceVersion(uri) !== version) {
      return "sourceVersionChanged";
    }
    if (getCachedAnalysis(uri) !== snapshot.sourceAnalyses.get(uri)) {
      return "analysisChanged";
    }
  }

  return undefined;
}

export function isSemanticTokensDependencySnapshotCurrent<TAnalysis>(
  snapshot: SemanticTokensDependencySnapshot<TAnalysis>,
  currentGraphGeneration: number,
  getSourceVersion: (uri: string) => number,
  getCachedAnalysis: (uri: string) => TAnalysis | undefined
): boolean {
  return getSemanticTokensDependencyInvalidationReason(
    snapshot,
    currentGraphGeneration,
    getSourceVersion,
    getCachedAnalysis
  ) === undefined;
}


/**
 * Captures only files included by the active document, excluding the document
 * itself. Its local analysis can change independently while this project
 * symbol index remains valid.
 */
export function createSemanticTokensProjectDependencySnapshot<TAnalysis>(
  documentUri: string,
  graphGeneration: number,
  includedUris: Iterable<string>,
  getSourceVersion: (uri: string) => number,
  getSourceAnalysis: (uri: string) => TAnalysis | undefined
): SemanticTokensDependencySnapshot<TAnalysis> {
  const sourceVersions = new Map<string, number>();
  const sourceAnalyses = new Map<string, TAnalysis>();

  for (const uri of includedUris) {
    if (uri === documentUri) continue;
    const analysis = getSourceAnalysis(uri);
    if (analysis === undefined) continue;

    sourceVersions.set(uri, getSourceVersion(uri));
    sourceAnalyses.set(uri, analysis);
  }

  return {
    graphGeneration,
    sourceVersions,
    sourceAnalyses,
  };
}
