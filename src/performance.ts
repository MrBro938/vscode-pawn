import { performance } from "perf_hooks";

export interface PerformanceTiming {
  count: number;
  totalMs: number;
  averageMs: number;
  maxMs: number;
  p95Ms: number;
}

export interface SlowFileTiming {
  path: string;
  name: string;
  bytes: number;
  tokens: number;
  symbols: number;
  count: number;
  totalMs: number;
  averageMs: number;
  maxMs: number;
}

export interface PerformanceSnapshot {
  enabled: boolean;
  collectedSince?: number;
  elapsedMs: number;
  counters: Record<string, number>;
  timings: Record<string, PerformanceTiming>;
  slowFiles: SlowFileTiming[];
}

interface MutableTiming {
  count: number;
  totalMs: number;
  maxMs: number;
  p95: P2Quantile;
}

interface MutableSlowFile {
  path: string;
  name: string;
  bytes: number;
  tokens: number;
  symbols: number;
  count: number;
  totalMs: number;
  maxMs: number;
}

/**
 * Streaming P² quantile estimator.
 * Memory usage stays constant while the estimate includes every observation.
 */
class P2Quantile {
  private readonly initial: number[] = [];
  private heights: number[] = [];
  private positions = [1, 2, 3, 4, 5];
  private desiredPositions: number[] = [];
  private readonly increments: number[];

  constructor(private readonly quantile: number) {
    this.increments = [
      0,
      quantile / 2,
      quantile,
      (1 + quantile) / 2,
      1,
    ];
  }

  add(value: number): void {
    if (this.initial.length < 5) {
      this.initial.push(value);
      if (this.initial.length === 5) {
        this.initial.sort((left, right) => left - right);
        this.heights = [...this.initial];
        this.desiredPositions = [
          1,
          1 + 2 * this.quantile,
          1 + 4 * this.quantile,
          3 + 2 * this.quantile,
          5,
        ];
      }
      return;
    }

    let cell: number;
    if (value < this.heights[0]) {
      this.heights[0] = value;
      cell = 0;
    } else if (value >= this.heights[4]) {
      this.heights[4] = value;
      cell = 3;
    } else {
      cell = 0;
      while (cell < 3 && value >= this.heights[cell + 1]) cell++;
    }

    for (let index = cell + 1; index < 5; index++) {
      this.positions[index]++;
    }
    for (let index = 0; index < 5; index++) {
      this.desiredPositions[index] += this.increments[index];
    }

    for (let index = 1; index <= 3; index++) {
      const delta = this.desiredPositions[index] - this.positions[index];
      const direction = Math.sign(delta);
      const canMoveUp = delta >= 1 &&
        this.positions[index + 1] - this.positions[index] > 1;
      const canMoveDown = delta <= -1 &&
        this.positions[index - 1] - this.positions[index] < -1;
      if (!canMoveUp && !canMoveDown) continue;

      const leftGap = this.positions[index] - this.positions[index - 1];
      const rightGap = this.positions[index + 1] - this.positions[index];
      const adjusted = this.heights[index] + direction / (leftGap + rightGap) * (
        (leftGap + direction) *
          (this.heights[index + 1] - this.heights[index]) / rightGap +
        (rightGap - direction) *
          (this.heights[index] - this.heights[index - 1]) / leftGap
      );

      if (
        adjusted > this.heights[index - 1] &&
        adjusted < this.heights[index + 1]
      ) {
        this.heights[index] = adjusted;
      } else {
        const neighbour = index + direction;
        this.heights[index] += direction *
          (this.heights[neighbour] - this.heights[index]) /
          (this.positions[neighbour] - this.positions[index]);
      }
      this.positions[index] += direction;
    }
  }

  value(): number {
    if (this.initial.length === 0) return 0;
    if (this.initial.length < 5 || this.positions[4] === 5) {
      const sorted = [...this.initial].sort((left, right) => left - right);
      return sorted[Math.max(0, Math.ceil(sorted.length * this.quantile) - 1)];
    }
    return this.heights[2];
  }
}

export class PerformanceMonitor {
  private enabled = false;
  private collectedSince: number | undefined;
  private readonly counters = new Map<string, number>();
  private readonly timings = new Map<string, MutableTiming>();
  private readonly slowFiles = new Map<string, MutableSlowFile>();
  private static readonly MAX_SLOW_FILES = 100;

  get isEnabled(): boolean {
    return this.enabled;
  }

  setEnabled(enabled: boolean): void {
    if (enabled && !this.enabled && this.collectedSince === undefined) {
      this.collectedSince = Date.now();
    }
    this.enabled = enabled;
  }

  count(name: string, amount = 1): void {
    if (!this.enabled || !amount) return;
    this.counters.set(name, (this.counters.get(name) || 0) + amount);
  }

  record(name: string, durationMs: number): void {
    if (!this.enabled || !Number.isFinite(durationMs) || durationMs < 0) return;

    let timing = this.timings.get(name);
    if (!timing) {
      timing = {
        count: 0,
        totalMs: 0,
        maxMs: 0,
        p95: new P2Quantile(0.95),
      };
      this.timings.set(name, timing);
    }

    timing.count++;
    timing.totalMs += durationMs;
    timing.maxMs = Math.max(timing.maxMs, durationMs);
    timing.p95.add(durationMs);
  }

  recordFileAnalysis(
    path: string,
    bytes: number,
    tokens: number,
    symbols: number,
    durationMs: number
  ): void {
    if (!this.enabled || !Number.isFinite(durationMs) || durationMs < 0) return;

    const existing = this.slowFiles.get(path);
    if (existing) {
      existing.count++;
      existing.totalMs += durationMs;
      existing.maxMs = Math.max(existing.maxMs, durationMs);
      existing.bytes = bytes;
      existing.tokens = tokens;
      existing.symbols = symbols;
      return;
    }

    this.slowFiles.set(path, {
      path,
      name: path.replace(/\\/g, "/").split("/").pop() || path,
      bytes,
      tokens,
      symbols,
      count: 1,
      totalMs: durationMs,
      maxMs: durationMs,
    });

    if (this.slowFiles.size > PerformanceMonitor.MAX_SLOW_FILES) {
      let slowestPath = "";
      let lowestMax = Number.POSITIVE_INFINITY;
      this.slowFiles.forEach((file, filePath) => {
        if (file.maxMs < lowestMax) {
          lowestMax = file.maxMs;
          slowestPath = filePath;
        }
      });
      if (slowestPath) this.slowFiles.delete(slowestPath);
    }
  }

  measure<T>(name: string, operation: () => T): T {
    if (!this.enabled) return operation();
    const startedAt = performance.now();
    try {
      return operation();
    } finally {
      this.record(name, performance.now() - startedAt);
    }
  }

  async measureAsync<T>(name: string, operation: () => PromiseLike<T>): Promise<T> {
    if (!this.enabled) return await operation();
    const startedAt = performance.now();
    try {
      return await operation();
    } finally {
      this.record(name, performance.now() - startedAt);
    }
  }

  reset(): void {
    this.counters.clear();
    this.timings.clear();
    this.slowFiles.clear();
    this.collectedSince = this.enabled ? Date.now() : undefined;
  }

  snapshot(): PerformanceSnapshot {
    const timings: Record<string, PerformanceTiming> = {};
    this.timings.forEach((timing, name) => {
      timings[name] = {
        count: timing.count,
        totalMs: timing.totalMs,
        averageMs: timing.count > 0 ? timing.totalMs / timing.count : 0,
        maxMs: timing.maxMs,
        p95Ms: timing.p95.value(),
      };
    });

    const slowFiles = Array.from(this.slowFiles.values())
      .map((file) => ({
        ...file,
        averageMs: file.count > 0 ? file.totalMs / file.count : 0,
      }))
      .sort((left, right) => right.maxMs - left.maxMs)
      .slice(0, 20);

    return {
      enabled: this.enabled,
      collectedSince: this.collectedSince,
      elapsedMs: this.collectedSince === undefined
        ? 0
        : Math.max(0, Date.now() - this.collectedSince),
      counters: Object.fromEntries(this.counters),
      timings,
      slowFiles,
    };
  }
}

export const formatPerformanceSnapshot = (
  title: string,
  snapshot: PerformanceSnapshot
): string => {
  const lines = [
    `========== ${title.toUpperCase()} ==========`,
    `Status: ${snapshot.enabled ? "ON" : "OFF"}`,
    snapshot.collectedSince
      ? `Collected since: ${new Date(snapshot.collectedSince).toLocaleString()}`
      : "Collected since: —",
    `Elapsed: ${(snapshot.elapsedMs / 1000).toFixed(1)} s`,
    "",
    "Counters:",
  ];

  const counterEntries = Object.entries(snapshot.counters).sort(([left], [right]) =>
    left.localeCompare(right)
  );
  if (counterEntries.length === 0) lines.push("  No counters collected.");
  counterEntries.forEach(([name, value]) => {
    lines.push(`  ${name.padEnd(40)} ${value.toLocaleString()}`);
  });

  lines.push("", "Timings (average / P95 / max):");
  const timingEntries = Object.entries(snapshot.timings).sort(([left], [right]) =>
    left.localeCompare(right)
  );
  if (timingEntries.length === 0) lines.push("  No timings collected.");
  timingEntries.forEach(([name, timing]) => {
    lines.push(
      `  ${name.padEnd(40)} ${timing.averageMs.toFixed(2)} / ${timing.p95Ms.toFixed(2)} / ${timing.maxMs.toFixed(2)} ms  (n=${timing.count})`
    );
  });

  if (snapshot.slowFiles.length > 0) {
    lines.push("", "Slowest Pawn files (by max analysis time):");
    snapshot.slowFiles.forEach((file, index) => {
      lines.push(
        `  ${String(index + 1).padStart(2)}. ${file.path}`,
        `      max=${file.maxMs.toFixed(2)} ms, avg=${file.averageMs.toFixed(2)} ms, ` +
        `runs=${file.count}, bytes=${file.bytes.toLocaleString()}, ` +
        `tokens=${file.tokens.toLocaleString()}, symbols=${file.symbols.toLocaleString()}`
      );
    });
  }

  lines.push("========================================");
  return lines.join("\n");
};
