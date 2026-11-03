import { join } from "path";
import * as vscode from "vscode";
import * as VLC from "vscode-languageclient";

let client: VLC.LanguageClient;

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

  const clientOptions: VLC.LanguageClientOptions = {
    documentSelector: [{ scheme: "file", language: "pawn" }],
    synchronize: {
      // Watch Pawn files (the old pattern only matched a literal ".pwn" name).
      fileEvents: vscode.workspace.createFileSystemWatcher("**/*.{p,pwn,pawn,inc}"),
    },
  };

  client = new VLC.LanguageClient(
    "Pawn Client",
    "Pawn Server",
    serverOptions,
    clientOptions
  );

  context.subscriptions.push(client.start());
}

export function deactivate(): Thenable<void> | undefined {
  return client ? client.stop() : undefined;
}
