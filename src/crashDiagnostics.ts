import {
  appendFileSync,
  existsSync,
  mkdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import { dirname } from "path";
import { freemem, totalmem } from "os";
import { getHeapStatistics } from "v8";

const MAX_LOG_BYTES = 2 * 1024 * 1024;

const describeError = (error: unknown): string => {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}${error.stack ? `\n${error.stack}` : ""}`;
  }
  if (typeof error === "string") return error;

  try {
    return JSON.stringify(error, null, 2) ?? String(error);
  } catch {
    return String(error);
  }
};

/**
 * Captures process, V8 heap, OS memory and active-handle information.
 * This checkpoint is written periodically so the last known state survives
 * crashes where JavaScript exception handlers never get a chance to run.
 */
export const createRuntimeSnapshot = (
  source: string,
  details: Record<string, unknown> = {}
) => {
  const memory = process.memoryUsage();
  let heap: ReturnType<typeof getHeapStatistics> | undefined;
  let resourceUsage: ReturnType<typeof process.resourceUsage> | undefined;
  let activeResources: string[] | undefined;

  try {
    heap = getHeapStatistics();
  } catch {
    // Heap statistics may be unavailable during process teardown.
  }

  try {
    resourceUsage = process.resourceUsage();
  } catch {
    // Resource usage is supplementary; do not fail the checkpoint.
  }

  try {
    activeResources = process.getActiveResourcesInfo();
  } catch {
    // This API may not be available in older embedded Node runtimes.
  }

  return {
    capturedAt: new Date().toISOString(),
    source,
    process: {
      pid: process.pid,
      ppid: process.ppid,
      uptimeSeconds: Number(process.uptime().toFixed(1)),
      nodeVersion: process.versions.node,
      v8Version: process.versions.v8,
      electronVersion: process.versions.electron || null,
      platform: process.platform,
      architecture: process.arch,
    },
    memoryBytes: memory,
    v8Heap: heap ? {
      totalHeapSize: heap.total_heap_size,
      usedHeapSize: heap.used_heap_size,
      heapSizeLimit: heap.heap_size_limit,
      externalMemory: heap.external_memory,
      mallocedMemory: heap.malloced_memory,
      peakMallocedMemory: heap.peak_malloced_memory,
    } : null,
    systemMemoryBytes: {
      free: freemem(),
      total: totalmem(),
    },
    resourceUsage: resourceUsage || null,
    activeResources: activeResources || null,
    details,
  };
};

/**
 * Atomically replaces a small JSON checkpoint. A crash therefore leaves
 * either the previous complete snapshot or the new complete snapshot.
 */
export const writeRuntimeSnapshot = (
  filePath: string | undefined,
  snapshot: unknown
): void => {
  if (!filePath) return;

  const temporaryPath = `${filePath}.${process.pid}.tmp`;

  try {
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(temporaryPath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
    renameSync(temporaryPath, filePath);
  } catch (error) {
    try {
      if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
    } catch {
      // Ignore cleanup errors while reporting the original failure.
    }

    try {
      process.stderr.write(
        `[Pawn Tools] Could not write runtime checkpoint: ${String(error)}\n`
      );
    } catch {
      // Diagnostics must not introduce another process-level failure.
    }
  }
};

/**
 * Appends a crash/diagnostic entry synchronously so it survives process teardown.
 * The log is capped at 2 MB, with one rotated copy retained.
 */
export const appendCrashLog = (
  filePath: string | undefined,
  source: string,
  error: unknown,
  details?: string
): void => {
  if (!filePath) return;

  const entry = [
    `[${new Date().toISOString()}] [${source}]`,
    describeError(error),
    details,
  ].filter(Boolean).join("\n") + "\n\n";

  try {
    mkdirSync(dirname(filePath), { recursive: true });

    if (existsSync(filePath) && statSync(filePath).size + Buffer.byteLength(entry, "utf8") > MAX_LOG_BYTES) {
      const rotatedPath = `${filePath}.1`;
      try {
        if (existsSync(rotatedPath)) unlinkSync(rotatedPath);
        renameSync(filePath, rotatedPath);
      } catch {
        // Keep appending to the current log if rotation is not possible.
      }
    }

    appendFileSync(filePath, entry, { encoding: "utf8" });
  } catch (writeError) {
    try {
      process.stderr.write(
        `[Pawn Tools] Could not write crash log: ${String(writeError)}\n`
      );
    } catch {
      // Logging must never introduce another process-level failure.
    }
  }
};
