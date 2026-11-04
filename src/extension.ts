import { isAbsolute, join, relative, resolve } from "path";
import { readFile } from "fs";
import * as vscode from "vscode";
import { LanguageClient, ServerOptions, TransportKind } from "vscode-languageclient/node";

let client: LanguageClient;
let clientReady = false;

const pawnGlob = "**/*.{p,pwn,pawn,inc}";
const excludedGlob = "**/{.git,node_modules,.vscode-test,dist,out}/**";
const INDEX_BATCH_SIZE = 32;

const externalIncludeWatchers = new Map<string, vscode.Disposable>();
const pendingExternalFileEvents = new Map<string, ReturnType<typeof setTimeout>>();

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

const scheduleExternalFileEvent = (uri: vscode.Uri, deleted = false) => {
  const key = uri.toString();
  const pending = pendingExternalFileEvents.get(key);
  if (pending) clearTimeout(pending);

  // FileSystemWatcher can emit several events during one save or rename.
  // Coalesce them so a file is read/indexed only once.
  const timer = setTimeout(() => {
    pendingExternalFileEvents.delete(key);
    if (!clientReady) return;

    if (deleted) {
      void client.sendNotification("pawn/indexFiles", {
        deleted: [key],
      });
    } else {
      void readAndIndexFile(uri);
    }
  }, 100);

  pendingExternalFileEvents.set(key, timer);
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
  const files = await vscode.workspace.findFiles(pawnGlob, excludedGlob);

  for (let offset = 0; offset < files.length; offset += INDEX_BATCH_SIZE) {
    const batch = files
      .slice(offset, offset + INDEX_BATCH_SIZE)
      .filter((uri) => !isDocumentOpen(uri));

    const indexedFiles = await Promise.all(
      batch.map(async (uri) => {
        try {
          const bytes = await readFileBytes(uri);
          return {
            uri: uri.toString(),
            text: bytes.toString("utf8"),
          };
        } catch (error) {
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
      await client.sendNotification("pawn/indexFiles", {
        files: validFiles,
        deferGraphRebuild: true,
      });
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
  await client.sendNotification("pawn/configureIncludes", {
    workspaceRoots: (vscode.workspace.workspaceFolders || []).map(
      (folder) => folder.uri.fsPath
    ),
    includePaths: configuration.get<string[]>("includePaths", []),
    compilerPath: configuration.get<string>("compilerPath", ""),
  });
};

export async function activate(context: vscode.ExtensionContext) {
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
    pendingExternalFileEvents.forEach((timer) => clearTimeout(timer));
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
    "**/{pawn.json,pawn.cfg}"
  );
  configWatcher.onDidCreate(() => void sendIncludeConfiguration());
  configWatcher.onDidChange(() => void sendIncludeConfiguration());
  configWatcher.onDidDelete(() => void sendIncludeConfiguration());
  context.subscriptions.push(configWatcher);

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (
        event.affectsConfiguration("pawn.includePaths") ||
        event.affectsConfiguration("pawn.compilerPath")
      ) {
        void sendIncludeConfiguration();
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

  client.start().then(async () => {
    clientReady = true;
    await indexWorkspaceFiles();
    await sendIncludeConfiguration();
  }).catch((error: Error) => {
    console.error("[Pawn Tools] Language server failed to start", error);
  });
}

export function deactivate(): Thenable<void> | undefined {
  clientReady = false;
  return client ? client.stop() : undefined;
}
