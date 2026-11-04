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
