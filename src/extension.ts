import { join } from "path";
import * as vscode from "vscode";
import * as VLC from "vscode-languageclient";

let client: VLC.LanguageClient;
let clientReady = false;

const pawnGlob = "**/*.{p,pwn,pawn,inc}";
const excludedGlob = "**/{.git,node_modules,.vscode-test,dist,out}/**";
const INDEX_BATCH_SIZE = 4;

const isDocumentOpen = (uri: vscode.Uri) =>
  vscode.workspace.textDocuments.some(
    (document) => document.uri.toString() === uri.toString()
  );

const readAndIndexFile = async (uri: vscode.Uri, force = false) => {
  if (!clientReady || (!force && isDocumentOpen(uri))) return;

  try {
    const bytes = await vscode.workspace.fs.readFile(uri);
    await client.sendNotification("pawn/indexFiles", {
      files: [{ uri: uri.toString(), text: Buffer.from(bytes).toString("utf8") }],
    });
  } catch (error) {
    // A file may be deleted or become inaccessible while it is being indexed.
    console.warn(`[Pawn Tools] Could not index ${uri.fsPath}`, error);
  }
};

const indexWorkspaceFiles = async () => {
  const files = await vscode.workspace.findFiles(pawnGlob, excludedGlob, 5000);

  for (let offset = 0; offset < files.length; offset += INDEX_BATCH_SIZE) {
    const batch = files
      .slice(offset, offset + INDEX_BATCH_SIZE)
      .filter((uri) => !isDocumentOpen(uri));

    const indexedFiles = await Promise.all(
      batch.map(async (uri) => {
        try {
          const bytes = await vscode.workspace.fs.readFile(uri);
          return {
            uri: uri.toString(),
            text: Buffer.from(bytes).toString("utf8"),
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
      await client.sendNotification("pawn/indexFiles", { files: validFiles });
    }

    // Yield to the extension host between small batches.
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  }
};

export async function activate(context: vscode.ExtensionContext) {
  const serverModule = context.asAbsolutePath(join("out", "server", "server.js"));
  const debugOptions = { execArgv: ["--nolazy", "--inspect=6009"] };

  const serverOptions: VLC.ServerOptions = {
    run: { module: serverModule, transport: VLC.TransportKind.ipc },
    debug: {
      module: serverModule,
      transport: VLC.TransportKind.ipc,
      options: debugOptions,
    },
  };

  client = new VLC.LanguageClient(
    "Pawn Client",
    "Pawn Server",
    serverOptions,
    {
      documentSelector: [{ scheme: "file", language: "pawn" }],
    }
  );

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

  context.subscriptions.push(
    vscode.workspace.onDidCloseTextDocument((document) => {
      if (document.languageId === "pawn" && clientReady) {
        // Restore the saved on-disk version after symbols from the editor buffer
        // have been removed by the language server's close event.
        setTimeout(() => readAndIndexFile(document.uri, true), 0);
      }
    })
  );

  client.start();
  client.onReady().then(async () => {
    clientReady = true;
    await indexWorkspaceFiles();
  }).catch((error) => {
    console.error("[Pawn Tools] Language server failed to start", error);
  });
}

export function deactivate(): Thenable<void> | undefined {
  clientReady = false;
  return client ? client.stop() : undefined;
}
