import {
  appendFileSync,
  existsSync,
  mkdirSync,
  renameSync,
  statSync,
  unlinkSync,
} from "fs";
import { dirname } from "path";

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
