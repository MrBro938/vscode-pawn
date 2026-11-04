export interface SemanticTokensDependencySnapshot<TAnalysis> {
  graphGeneration: number;
  sourceVersions: ReadonlyMap<string, number>;
  sourceAnalyses: ReadonlyMap<string, TAnalysis>;
}

/**
 * Validates only this document's include closure. Unrelated analysis cache
 * misses never invalidate the snapshot.
 */
export function isSemanticTokensDependencySnapshotCurrent<TAnalysis>(
  snapshot: SemanticTokensDependencySnapshot<TAnalysis>,
  currentGraphGeneration: number,
  getSourceVersion: (uri: string) => number,
  getCachedAnalysis: (uri: string) => TAnalysis | undefined
): boolean {
  if (snapshot.graphGeneration !== currentGraphGeneration) return false;

  for (const [uri, version] of snapshot.sourceVersions) {
    if (getSourceVersion(uri) !== version) return false;
    if (getCachedAnalysis(uri) !== snapshot.sourceAnalyses.get(uri)) return false;
  }

  return true;
}
