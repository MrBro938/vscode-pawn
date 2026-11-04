import { isAbsolute, join, relative, resolve } from "path";
import { readFile } from "fs";
import * as vscode from "vscode";
import { performance } from "perf_hooks";
import { LanguageClient, ServerOptions, TransportKind } from "vscode-languageclient/node";
import {
  PerformanceMonitor,
  PerformanceSnapshot,
  formatPerformanceSnapshot,
} from "./performance";
import { PawnDocumentColorProvider } from "./pawnColorProvider";

let client: LanguageClient;
let clientReady = false;
const performanceStats = new PerformanceMonitor();

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
  performanceStats.setEnabled(
    vscode.workspace.getConfiguration("pawn").get<boolean>("performanceLogging", false)
  );

  const pawnColorProvider = new PawnDocumentColorProvider();
  let pawnColorProviderRegistration = vscode.languages.registerColorProvider(
    { language: "pawn" },
    pawnColorProvider
  );
  let pawnColorRefreshTimer: ReturnType<typeof setTimeout> | undefined;

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

  context.subscriptions.push(
    new vscode.Disposable(() => {
      if (pawnColorRefreshTimer) clearTimeout(pawnColorRefreshTimer);
      pawnColorRefreshTimer = undefined;
      pawnColorProviderRegistration.dispose();
      pawnColorProvider.dispose();
    }),
    vscode.window.onDidChangeTextEditorVisibleRanges((event) => {
      updatePawnColorViewport(event.textEditor);
    }),
    vscode.window.onDidChangeVisibleTextEditors((editors) => {
      editors.forEach(updatePawnColorViewport);
    }),
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      updatePawnColorViewport(editor);
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
    }),
    vscode.workspace.onDidCloseTextDocument((document) => {
      if (document.languageId === "pawn") {
        pawnColorProvider.closeDocument(document);
      }
    })
  );

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
    })
  );

  const serverModule = context.asAbsolutePath(join("out", "server", "server.js"));
  const debugOptions = { execArgv: ["--nolazy", "--inspect=6009"] };

  const serverOptions: ServerOptions = {
    run: { module: serverModule, transport: TransportKind.ipc },
    debug: {
      module: serverModule,
      transport: TransportKind.ipc,
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

  context.subscriptions.push(
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
  watcher.onDidCreate(readAndIndexFile);
  watcher.onDidChange(readAndIndexFile);
  watcher.onDidDelete((uri) => {
    if (clientReady) {
      client.sendNotification("pawn/indexFiles", {
        deleted: [uri.toString()],
      });
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
    clientReady = true;
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
    performanceStats.record(
      "startup.postClientInitialization",
      performance.now() - startupStartedAt
    );
    performanceStats.record(
      "extension.activationToReady",
      performance.now() - activationStartedAt
    );
  }).catch((error: Error) => {
    console.error("[Pawn Tools] Language server failed to start", error);
  });
}

export function deactivate(): Thenable<void> | undefined {
  clientReady = false;
  return client ? client.stop() : undefined;
}
