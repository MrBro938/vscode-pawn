import { join } from "path";
import * as vscode from "vscode";
import * as VLC from "vscode-languageclient";

let client: VLC.LanguageClient;
let clientReady = false;

const pawnGlob = "**/*.{p,pwn,pawn,inc}";
const excludedGlob = "**/{.git,node_modules,.vscode-test,dist,out}/**";
const INDEX_BATCH_SIZE = 16;

const readAndIndexFile = async (uri: vscode.Uri) => {
  if (!clientReady) return;

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
    const batch = files.slice(offset, offset + INDEX_BATCH_SIZE);
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

    const validFiles = indexedFiles.filter(
      (file): file is { uri: string; text: string } => file !== undefined
    );

    if (validFiles.length > 0) {
      await client.sendNotification("pawn/indexFiles", { files: validFiles });
    }

    // Yield to the extension host between batches so indexing does not monopolise it.
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
