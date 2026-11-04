export interface PawnFunctionSearchIndex<TFunction, TDefinition> {
  functions: Map<string, TFunction>;
  definitions: Map<string, TDefinition>;
  sourceUris: Set<string>;
  stale: boolean;
}

/**
 * Build a search index in the exact URI order returned by the configured
 * Pawn search scope. First match wins, matching the previous linear lookup.
 * Function names are case-insensitive; preprocessor definitions remain
 * case-sensitive to preserve existing behavior.
 */
export function buildPawnFunctionSearchIndex<TFunction, TDefinition>(
  orderedUris: Iterable<string>,
  getFunctions: (uri: string) => Iterable<[string, TFunction]> | undefined,
  getDefinitions: (uri: string) => Iterable<TDefinition> | undefined,
  getDefinitionName: (definition: TDefinition) => string
): PawnFunctionSearchIndex<TFunction, TDefinition> {
  const functions = new Map<string, TFunction>();
  const definitions = new Map<string, TDefinition>();
  const sourceUris = new Set<string>();

  for (const uri of orderedUris) {
    sourceUris.add(uri);

    for (const [name, fn] of getFunctions(uri) || []) {
      const key = name.toLowerCase();
      if (!functions.has(key)) functions.set(key, fn);
    }

    for (const definition of getDefinitions(uri) || []) {
      const name = getDefinitionName(definition);
      if (!definitions.has(name)) definitions.set(name, definition);
    }
  }

  return { functions, definitions, sourceUris, stale: false };
}

/**
 * Bounded LRU cache. Editing a source invalidates only search indexes whose
 * configured scope included that source; include-graph/scope changes clear all.
 */
export class FunctionSearchIndexCache<TFunction, TDefinition> {
  private readonly entries = new Map<
    string,
    PawnFunctionSearchIndex<TFunction, TDefinition>
  >();

  constructor(private readonly capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new Error("Function search index cache capacity must be positive");
    }
  }

  get(uri: string): PawnFunctionSearchIndex<TFunction, TDefinition> | undefined {
    const entry = this.entries.get(uri);
    if (!entry || entry.stale) return undefined;

    this.entries.delete(uri);
    this.entries.set(uri, entry);
    return entry;
  }

  set(
    uri: string,
    entry: PawnFunctionSearchIndex<TFunction, TDefinition>
  ): boolean {
    this.entries.delete(uri);
    this.entries.set(uri, entry);

    let evicted = false;
    while (this.entries.size > this.capacity) {
      const oldestUri = this.entries.keys().next().value;
      if (oldestUri === undefined) break;
      this.entries.delete(oldestUri);
      evicted = true;
    }
    return evicted;
  }

  markSourceStale(uri: string): number {
    let invalidated = 0;
    this.entries.forEach((entry) => {
      if (!entry.sourceUris.has(uri) || entry.stale) return;
      entry.stale = true;
      invalidated++;
    });
    return invalidated;
  }

  clear(): void {
    this.entries.clear();
  }
}
