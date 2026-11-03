import { CompletionItem, CompletionItemKind } from "vscode-languageserver";
import { TextDocument } from "vscode-languageserver-textdocument";

export let wordTokens: Map<string, CompletionItem[]> = new Map();

export const parseWords = (textDocument: TextDocument) => {
  const regex = /[A-Za-z_][A-Za-z0-9_]*/g;
  const content = textDocument.getText();
  const words = new Set<string>();
  let match: RegExpExecArray | null;

  while ((match = regex.exec(content)) !== null) {
    words.add(match[0]);
  }

  const wordCompletion: CompletionItem[] = Array.from(words, (word) => ({
    label: word,
    kind: CompletionItemKind.Text,
    insertText: word,
  }));

  // Always replace the previous snapshot; this also removes deleted words.
  wordTokens.set(textDocument.uri, wordCompletion);
};
