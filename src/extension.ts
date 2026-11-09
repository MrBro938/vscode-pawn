import { isAbsolute, join, relative, resolve } from "path";
import { existsSync, mkdirSync, readFile, readFileSync, unlinkSync, writeFileSync } from "fs";
import * as vscode from "vscode";
import { performance } from "perf_hooks";
import { appendCrashLog } from "./crashDiagnostics";
import { LanguageClient, ServerOptions, State, TransportKind } from "vscode-languageclient/node";
import {
  PerformanceMonitor,
  PerformanceSnapshot,
  formatPerformanceSnapshot,
} from "./performance";
import { PawnDocumentColorProvider } from "./pawnColorProvider";
import type { PawnColorDefine } from "./server/colorDefines";

let client: LanguageClient;
let clientReady = false;
let refreshPawnColorDefinesFromIndex: (() => void) | undefined;
const performanceStats = new PerformanceMonitor();
let crashLogPath: string | undefined;
let sessionMarkerPath: string | undefined;
let extensionHostCrashMonitor: ((error: Error, origin: string) => void) | undefined;
let isDeactivating = false;
let serverHasBeenRunning = false;
let lastServerCrashNotificationAt = 0;

const pawnGlob = "**/*.{p,pwn,pawn,inc}";
const excludedGlob = "**/{.git,node_modules,.vscode-test,dist,out}/**";
const INDEX_BATCH_SIZE = 32;

const externalIncludeWatchers = new Map<string, vscode.Disposable>();
const pendingExternalFileEvents = new Map<string, { uri: vscode.Uri; deleted: boolean }>();
let externalIncludeFlushTimer: ReturnType<typeof setTimeout> | undefined;

const normalizeDirectory = (directory: string) => {
  const normalized = resolve(directory);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
};

const isPathWithin = (parent: string, candidate: string) => {
  const relativePath = relative(resolve(parent), resolve(candidate));
  return relativePath === "" ||
    (!relativePath.startsWith("..") && !isAbsolute(relativePath));
};

const isInsideWorkspace = (directory: string) =>
  (vscode.workspace.workspaceFolders || []).some((folder) =>
    isPathWithin(folder.uri.fsPath, directory)
  );

const flushExternalFileEvents = async () => {
  if (!clientReady || pendingExternalFileEvents.size === 0) return;

  const batch = Array.from(pendingExternalFileEvents.values());
  pendingExternalFileEvents.clear();

  const deleted: string[] = [];
  const files: Array<{ uri: string; text: string }> = [];

  await Promise.all(batch.map(async (event) => {
    const uri = event.uri.toString();
    if (event.deleted) {
      deleted.push(uri);
      return;
    }

    // Open documents are indexed from their live editor contents by LSP.
    if (isDocumentOpen(event.uri)) return;

    try {
      const bytes = await readFileBytes(event.uri);
      files.push({ uri, text: bytes.toString("utf8") });
    } catch {
      // The file may have been removed between the watcher event and the read.
      deleted.push(uri);
    }
  }));

  if (deleted.length > 0 || files.length > 0) {
    await client.sendNotification("pawn/indexFiles", { files, deleted });
    refreshPawnColorDefinesFromIndex?.();
  }
};

const scheduleExternalFileEvent = (uri: vscode.Uri, deleted = false) => {
  // Keep only the latest state for each path. A save, checkout or dependency
  // update can touch hundreds of files; one batched LSP notification avoids
  // rebuilding the include graph once per file.
  pendingExternalFileEvents.set(uri.toString(), { uri, deleted });

  if (externalIncludeFlushTimer) clearTimeout(externalIncludeFlushTimer);
  externalIncludeFlushTimer = setTimeout(() => {
    externalIncludeFlushTimer = undefined;
    void flushExternalFileEvents();
  }, 120);
};

const updateExternalIncludeWatchers = (directories: string[]) => {
  // Workspace files are already covered by the main workspace watcher.
  const candidates = Array.from(new Set(
    directories
      .filter((directory) => typeof directory === "string" && !!directory.trim())
      .map((directory) => resolve(directory))
      .filter((directory) => !isInsideWorkspace(directory))
  )).sort((left, right) => left.length - right.length);

  // A recursive watcher on a parent also covers its nested include directories.
  const desiredDirectories: string[] = [];
  candidates.forEach((candidate) => {
    if (desiredDirectories.some((parent) => isPathWithin(parent, candidate))) return;
    desiredDirectories.push(candidate);
  });

  const desired = new Map(
    desiredDirectories.map((directory) => [normalizeDirectory(directory), directory])
  );

  externalIncludeWatchers.forEach((disposable, key) => {
    if (desired.has(key)) return;
    disposable.dispose();
    externalIncludeWatchers.delete(key);
  });

  desired.forEach((directory, key) => {
    if (externalIncludeWatchers.has(key)) return;

    const pattern = new vscode.RelativePattern(
      vscode.Uri.file(directory),
      "**/*.{p,pwn,pawn,inc}"
    );
    const watcher = vscode.workspace.createFileSystemWatcher(pattern);
    const created = watcher.onDidCreate((uri) =>
      scheduleExternalFileEvent(uri)
    );
    const changed = watcher.onDidChange((uri) =>
      scheduleExternalFileEvent(uri)
    );
    const deleted = watcher.onDidDelete((uri) =>
      scheduleExternalFileEvent(uri, true)
    );

    externalIncludeWatchers.set(
      key,
      vscode.Disposable.from(watcher, created, changed, deleted)
    );
  });
};

const readFileBytes = (uri: vscode.Uri): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    readFile(uri.fsPath, (error, data) => {
      if (error) reject(error);
      else resolve(data);
    });
  });

const isDocumentOpen = (uri: vscode.Uri) =>
  vscode.workspace.textDocuments.some(
    (document) => document.uri.toString() === uri.toString()
  );

const readAndIndexFile = async (uri: vscode.Uri, force = false) => {
  if (!clientReady || (!force && isDocumentOpen(uri))) return;

  try {
    const bytes = await readFileBytes(uri);
    await client.sendNotification("pawn/indexFiles", {
      files: [{ uri: uri.toString(), text: bytes.toString("utf8") }],
    });
  } catch (error) {
    // A file may be deleted or become inaccessible while it is being indexed.
    console.warn(`[Pawn Tools] Could not index ${uri.fsPath}`, error);
  }
};

const indexWorkspaceFiles = async () => {
  const files = await performanceStats.measureAsync(
    "workspace.scan",
    () => vscode.workspace.findFiles(pawnGlob, excludedGlob)
  );
  performanceStats.count("workspace.filesFound", files.length);

  for (let offset = 0; offset < files.length; offset += INDEX_BATCH_SIZE) {
    const batch = files
      .slice(offset, offset + INDEX_BATCH_SIZE)
      .filter((uri) => !isDocumentOpen(uri));

    const indexedFiles = await Promise.all(
      batch.map(async (uri) => {
        try {
          const bytes = await performanceStats.measureAsync(
            "workspace.fileRead",
            () => readFileBytes(uri)
          );
          performanceStats.count("workspace.filesRead");
          performanceStats.count("workspace.bytesRead", bytes.length);
          return {
            uri: uri.toString(),
            text: bytes.toString("utf8"),
          };
        } catch (error) {
          performanceStats.count("workspace.readFailures");
          console.warn(`[Pawn Tools] Could not read ${uri.fsPath}`, error);
          return undefined;
        }
      })
    );

    // A file may have been opened while it was being read. In that case its
    // in-memory document is authoritative and will be indexed by the LSP events.
    const validFiles = indexedFiles.filter(
      (file): file is { uri: string; text: string } =>
        file !== undefined && !isDocumentOpen(vscode.Uri.parse(file.uri))
    );

    if (validFiles.length > 0) {
      performanceStats.count("workspace.indexedFilesSent", validFiles.length);
      performanceStats.count("workspace.indexBatches");
      await performanceStats.measureAsync(
        "workspace.indexNotification",
        () => client.sendNotification("pawn/indexFiles", {
          files: validFiles,
          deferGraphRebuild: true,
        })
      );
    }

    // Yield to the extension host between small batches.
    // Keep the extension host responsive without adding a large fixed delay
    // for every tiny batch in workspaces containing thousands of Pawn files.
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
};

const sendIncludeConfiguration = async () => {
  if (!clientReady) return;

  const configuration = vscode.workspace.getConfiguration("pawn");
  await performanceStats.measureAsync(
    "includes.sendConfiguration",
    () => client.sendNotification("pawn/configureIncludes", {
      workspaceRoots: (vscode.workspace.workspaceFolders || []).map(
        (folder) => folder.uri.fsPath
      ),
      includePaths: configuration.get<string[]>("includePaths", []),
      compilerPath: configuration.get<string>("compilerPath", ""),
      functionSearchScope: configuration.get<string>("functionSearchScope", "includes"),
    })
  );
};

export async function activate(context: vscode.ExtensionContext) {
  const activationStartedAt = performance.now();
  isDeactivating = false;
  crashLogPath = join(context.globalStorageUri.fsPath, "crash.log");
  sessionMarkerPath = join(context.globalStorageUri.fsPath, "session-active");

  let previousSessionCrashed = false;
  try {
    mkdirSync(context.globalStorageUri.fsPath, { recursive: true });
    previousSessionCrashed = existsSync(sessionMarkerPath);
    if (previousSessionCrashed) {
      let previousSessionDetails = "The previous session marker was still present at activation.";
      try {
        previousSessionDetails = readFileSync(sessionMarkerPath, "utf8");
      } catch {
        // The marker may be inaccessible; the recovery notice is still useful.
      }
      appendCrashLog(
        crashLogPath,
        "Extension Host recovery",
        "The previous session did not complete normal deactivation.",
        previousSessionDetails
      );
    }

    writeFileSync(sessionMarkerPath, JSON.stringify({
      startedAt: new Date().toISOString(),
      pid: process.pid,
      vscodeVersion: vscode.version,
      extensionVersion: String(context.extension.packageJSON.version || "unknown"),
    }, null, 2), "utf8");
  } catch (error) {
    console.error("[Pawn Tools] Could not initialize crash diagnostics", error);
  }

  appendCrashLog(
    crashLogPath,
    "Extension Host",
    "Pawn Tools activation started.",
    `PID: ${process.pid}\nVS Code: ${vscode.version}\nExtension: ${String(context.extension.packageJSON.version || "unknown")}`
  );

  extensionHostCrashMonitor = (error, origin) => {
    appendCrashLog(
      crashLogPath,
      "Extension Host uncaught exception",
      error,
      `Origin: ${origin}\nNote: the Extension Host is shared; this error may originate from another extension.`
    );
  };
  process.on("uncaughtExceptionMonitor", extensionHostCrashMonitor);
  performanceStats.setEnabled(
    vscode.workspace.getConfiguration("pawn").get<boolean>("performanceLogging", false)
  );

  const pawnColorProvider = new PawnDocumentColorProvider();
  let pawnColorProviderRegistration = vscode.languages.registerColorProvider(
    { language: "pawn" },
    pawnColorProvider
  );
  let pawnColorRefreshTimer: ReturnType<typeof setTimeout> | undefined;
  let pawnColorDefineRefreshTimer: ReturnType<typeof setTimeout> | undefined;

  const schedulePawnColorRefresh = () => {
    if (pawnColorRefreshTimer) clearTimeout(pawnColorRefreshTimer);
    pawnColorRefreshTimer = setTimeout(() => {
      pawnColorRefreshTimer = undefined;
      // Re-registering fires VS Code's native color-provider change event.
      // The provider then recalculates only the current viewport + its prefetch
      // margin, reusing cached per-line results for overlapping ranges.
      pawnColorProviderRegistration.dispose();
      pawnColorProviderRegistration = vscode.languages.registerColorProvider(
        { language: "pawn" },
        pawnColorProvider
      );
    }, 120);
  };

  const updatePawnColorViewport = (editor: vscode.TextEditor | undefined) => {
    if (!editor || editor.document.languageId !== "pawn") return;
    if (pawnColorProvider.isViewportCovered(editor.document, editor.visibleRanges)) return;
    schedulePawnColorRefresh();
  };

  const refreshPawnColorDefines = async () => {
    if (!clientReady) return;
    const visibleDocuments = new Map<string, vscode.TextDocument>();
    vscode.window.visibleTextEditors.forEach((editor) => {
      if (editor.document.languageId === "pawn") {
        visibleDocuments.set(editor.document.uri.toString(), editor.document);
      }
    });
    const activeDocument = vscode.window.activeTextEditor?.document;
    if (activeDocument?.languageId === "pawn") {
      visibleDocuments.set(activeDocument.uri.toString(), activeDocument);
    }

    let changed = false;
    await Promise.all(Array.from(visibleDocuments.keys()).map(async (uri) => {
      try {
        const defines = await client.sendRequest<PawnColorDefine[]>(
          "pawn/colorDefines",
          { uri }
        );
        if (pawnColorProvider.setColorDefines(uri, defines || [])) changed = true;
      } catch (error) {
        console.warn("[Pawn Tools] Could not resolve color #define values", error);
      }
    }));

    if (changed) schedulePawnColorRefresh();
  };

  const schedulePawnColorDefineRefresh = () => {
    if (pawnColorDefineRefreshTimer) clearTimeout(pawnColorDefineRefreshTimer);
    pawnColorDefineRefreshTimer = setTimeout(() => {
      pawnColorDefineRefreshTimer = undefined;
      void refreshPawnColorDefines();
    }, 350);
  };
  refreshPawnColorDefinesFromIndex = schedulePawnColorDefineRefresh;

  context.subscriptions.push(
    new vscode.Disposable(() => {
      if (pawnColorRefreshTimer) clearTimeout(pawnColorRefreshTimer);
      if (pawnColorDefineRefreshTimer) clearTimeout(pawnColorDefineRefreshTimer);
      pawnColorRefreshTimer = undefined;
      pawnColorDefineRefreshTimer = undefined;
      refreshPawnColorDefinesFromIndex = undefined;
      pawnColorProviderRegistration.dispose();
      pawnColorProvider.dispose();
    }),
    vscode.window.onDidChangeTextEditorVisibleRanges((event) => {
      updatePawnColorViewport(event.textEditor);
    }),
    vscode.window.onDidChangeVisibleTextEditors((editors) => {
      editors.forEach(updatePawnColorViewport);
      schedulePawnColorDefineRefresh();
    }),
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      updatePawnColorViewport(editor);
      schedulePawnColorDefineRefresh();
    }),
    vscode.workspace.onDidChangeTextDocument((event) => {
      if (event.document.languageId !== "pawn") return;
      const firstChangedLine = event.contentChanges.reduce(
        (minimum, change) => Math.min(minimum, change.range.start.line),
        Number.MAX_SAFE_INTEGER
      );
      pawnColorProvider.invalidateDocument(
        event.document,
        firstChangedLine === Number.MAX_SAFE_INTEGER ? 0 : firstChangedLine
      );
      schedulePawnColorDefineRefresh();
    }),
    vscode.workspace.onDidCloseTextDocument((document) => {
      if (document.languageId === "pawn") {
        pawnColorProvider.closeDocument(document);
      }
    })
  );

  const openCrashLog = async () => {
    const filePath = crashLogPath;
    if (!filePath) return;

    try {
      if (!existsSync(filePath)) {
        appendCrashLog(filePath, "Diagnostics", "Crash log opened before any crash was recorded.");
      }
      const document = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
      await vscode.window.showTextDocument(document, { preview: false });
    } catch (error) {
      void vscode.window.showErrorMessage(
        `Не удалось открыть лог Pawn Tools: ${String(error)}`
      );
    }
  };

  const performanceOutput = vscode.window.createOutputChannel("Pawn Performance");
  context.subscriptions.push(performanceOutput);

  const showPerformanceStats = async () => {
    let serverSnapshot: PerformanceSnapshot | undefined;
    if (clientReady) {
      try {
        serverSnapshot = await client.sendRequest<PerformanceSnapshot>(
          "pawn/performanceStats"
        );
      } catch (error) {
        performanceOutput.appendLine(
          `Could not retrieve Language Server statistics: ${String(error)}`
        );
      }
    }

    performanceOutput.clear();
    performanceOutput.appendLine(
      formatPerformanceSnapshot("Extension Host", performanceStats.snapshot())
    );
    performanceOutput.appendLine("");
    performanceOutput.appendLine(
      serverSnapshot
        ? formatPerformanceSnapshot("Language Server", serverSnapshot)
        : "Language Server: not connected"
    );
    if (!performanceStats.isEnabled) {
      performanceOutput.appendLine("");
      performanceOutput.appendLine(
        "Profiling is disabled. Run 'Pawn: Toggle Performance Logging' to enable it."
      );
    }
    performanceOutput.show(true);
  };

  context.subscriptions.push(
    vscode.commands.registerCommand("pawn.showPerformanceStats", showPerformanceStats),
    vscode.commands.registerCommand("pawn.togglePerformanceLogging", async () => {
      const configuration = vscode.workspace.getConfiguration("pawn");
      const enabled = !configuration.get<boolean>("performanceLogging", false);
      await configuration.update(
        "performanceLogging",
        enabled,
        vscode.ConfigurationTarget.Global
      );
      performanceStats.setEnabled(enabled);
      if (clientReady) {
        await client.sendNotification("pawn/performanceEnabled", { enabled });
      }
      void vscode.window.showInformationMessage(
        enabled
          ? "Pawn performance logging enabled. Reload VS Code to include startup measurements."
          : "Pawn performance logging disabled."
      );
    }),
    vscode.commands.registerCommand("pawn.resetPerformanceStats", async () => {
      performanceStats.reset();
      if (clientReady) {
        await client.sendNotification("pawn/performanceReset", {});
      }
      void vscode.window.showInformationMessage("Pawn performance statistics reset.");
    }),
    vscode.commands.registerCommand("pawn.openCrashLog", openCrashLog)
  );

  if (previousSessionCrashed) {
    void vscode.window.showWarningMessage(
      "Pawn Tools обнаружил, что предыдущий сеанс VS Code завершился без штатного закрытия расширения. Открыть диагностический лог?",
      "Открыть лог"
    ).then((selection) => {
      if (selection === "Открыть лог") void openCrashLog();
    });
  }

  const serverModule = context.asAbsolutePath(join("out", "server", "server.js"));
  const debugOptions = { execArgv: ["--nolazy", "--inspect=6009"] };

  const serverOptions: ServerOptions = {
    run: { module: serverModule, transport: TransportKind.ipc, args: ["--pawn-crash-log", crashLogPath || ""] },
    debug: {
      module: serverModule,
      transport: TransportKind.ipc,
      args: ["--pawn-crash-log", crashLogPath || ""],
      options: debugOptions,
    },
  };

  client = new LanguageClient(
    "Pawn Client",
    "Pawn Server",
    serverOptions,
    {
      documentSelector: [{ scheme: "file", language: "pawn" }],
    }
  );

  let serverInitializationInProgress = false;
  let serverInitializationRequested = false;
  const initializeServer = async () => {
    if (isDeactivating) return;
    if (serverInitializationInProgress) {
      serverInitializationRequested = true;
      return;
    }
    serverInitializationRequested = false;
    serverInitializationInProgress = true;
    clientReady = true;

    try {
      await client.sendNotification("pawn/performanceEnabled", {
        enabled: performanceStats.isEnabled,
      });

      const startupStartedAt = performance.now();
      await performanceStats.measureAsync(
        "startup.workspaceIndexing",
        indexWorkspaceFiles
      );
      await performanceStats.measureAsync(
        "startup.includeConfiguration",
        sendIncludeConfiguration
      );
      await refreshPawnColorDefines();
      performanceStats.record(
        "startup.postClientInitialization",
        performance.now() - startupStartedAt
      );
    } finally {
      serverInitializationInProgress = false;
      if (serverInitializationRequested && client.state === State.Running && !isDeactivating) {
        serverInitializationRequested = false;
        void initializeServer().catch(reportServerStartupError);
      }
    }
  };

  const reportServerStartupError = (error: unknown) => {
    clientReady = false;
    appendCrashLog(crashLogPath, "Pawn Server initialization", error);
    void vscode.window.showErrorMessage(
      "Не удалось запустить или восстановить Pawn Server. Диагностика сохранена в crash.log.",
      "Открыть лог"
    ).then((selection) => {
      if (selection === "Открыть лог") void openCrashLog();
    });
  };

  context.subscriptions.push(
    client.onDidChangeState(({ oldState, newState }) => {
      if (newState === State.Running) {
        const isRestart = serverHasBeenRunning;
        serverHasBeenRunning = true;

        if (isRestart && !isDeactivating) {
          appendCrashLog(
            crashLogPath,
            "Pawn Server",
            "Language Server process restarted."
          );
          void initializeServer().catch(reportServerStartupError);
        }
        return;
      }

      if (
        oldState === State.Running &&
        newState === State.Stopped &&
        serverHasBeenRunning &&
        !isDeactivating
      ) {
        clientReady = false;
        appendCrashLog(
          crashLogPath,
          "Pawn Server",
          "Language Server stopped unexpectedly. The process may have crashed or been terminated."
        );

        const now = Date.now();
        if (now - lastServerCrashNotificationAt >= 30000) {
          lastServerCrashNotificationAt = now;
          void vscode.window.showErrorMessage(
            "Pawn Server неожиданно завершил работу. Подробности сохранены в crash.log.",
            "Открыть лог"
          ).then((selection) => {
            if (selection === "Открыть лог") void openCrashLog();
          });
        }
      }
    }),
    client.onNotification(
      "pawn/includeDirectories",
      (params: { directories?: string[] }) => {
        updateExternalIncludeWatchers(params.directories || []);
      }
    )
  );

  context.subscriptions.push(new vscode.Disposable(() => {
    externalIncludeWatchers.forEach((watcher) => watcher.dispose());
    externalIncludeWatchers.clear();
    if (externalIncludeFlushTimer) clearTimeout(externalIncludeFlushTimer);
    externalIncludeFlushTimer = undefined;
    pendingExternalFileEvents.clear();
  }));

  const watcher = vscode.workspace.createFileSystemWatcher(pawnGlob);
  watcher.onDidCreate((uri) => {
    void readAndIndexFile(uri).then(schedulePawnColorDefineRefresh);
  });
  watcher.onDidChange((uri) => {
    void readAndIndexFile(uri).then(schedulePawnColorDefineRefresh);
  });
  watcher.onDidDelete((uri) => {
    if (clientReady) {
      void client.sendNotification("pawn/indexFiles", {
        deleted: [uri.toString()],
      }).then(schedulePawnColorDefineRefresh);
    }
  });
  context.subscriptions.push(watcher);

  const configWatcher = vscode.workspace.createFileSystemWatcher(
    "**/{pawn.json,pawn.yaml,pawn.cfg}"
  );
  configWatcher.onDidCreate(() => void sendIncludeConfiguration());
  configWatcher.onDidChange(() => void sendIncludeConfiguration());
  configWatcher.onDidDelete(() => void sendIncludeConfiguration());
  context.subscriptions.push(configWatcher);

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("pawn.performanceLogging")) {
        const enabled = vscode.workspace
          .getConfiguration("pawn")
          .get<boolean>("performanceLogging", false);
        performanceStats.setEnabled(enabled);
        if (clientReady) {
          void client.sendNotification("pawn/performanceEnabled", { enabled });
        }
      }

      if (
        event.affectsConfiguration("pawn.includePaths") ||
        event.affectsConfiguration("pawn.compilerPath")
      ) {
        void sendIncludeConfiguration();
      }

      if (event.affectsConfiguration("pawn.functionSearchScope") && clientReady) {
        const scope = vscode.workspace
          .getConfiguration("pawn")
          .get<string>("functionSearchScope", "includes");
        void client.sendNotification("pawn/functionSearchScope", { scope });
      }
    })
  );

  context.subscriptions.push(
    vscode.workspace.onDidCloseTextDocument((document) => {
      if (
        document.languageId === "pawn" &&
        document.uri.scheme === "file" &&
        clientReady
      ) {
        // Restore the saved on-disk version after symbols from the editor buffer
        // have been removed by the language server's close event.
        setTimeout(() => readAndIndexFile(document.uri, true), 0);
      }
    })
  );

  const clientStartAt = performance.now();
  client.start().then(async () => {
    performanceStats.record("extension.clientStart", performance.now() - clientStartAt);
    await initializeServer();
    performanceStats.record(
      "extension.activationToReady",
      performance.now() - activationStartedAt
    );
  }).catch(reportServerStartupError);
}

export function deactivate(): Thenable<void> | undefined {
  clientReady = false;
  isDeactivating = true;

  const cleanup = () => {
    if (extensionHostCrashMonitor) {
      process.removeListener("uncaughtExceptionMonitor", extensionHostCrashMonitor);
      extensionHostCrashMonitor = undefined;
    }

    if (sessionMarkerPath) {
      try {
        unlinkSync(sessionMarkerPath);
      } catch {
        // The marker may already have been removed.
      }
    }
  };

  if (!client) {
    cleanup();
    return undefined;
  }

  return client.stop().then(() => {
    cleanup();
  }, (error) => {
    appendCrashLog(crashLogPath, "Pawn Server shutdown", error);
    cleanup();
  });
}
