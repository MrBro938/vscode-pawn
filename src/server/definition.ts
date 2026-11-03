import {
  CompletionItem,
  CompletionItemKind,
  Definition,
  Location,
} from "vscode-languageserver";
import { TextDocument } from "vscode-languageserver-textdocument";

export interface PawnDefinition {
  textDocument: TextDocument;
  completion: CompletionItem;
  definition: Definition;
}

export const definitionTokens: Map<string, PawnDefinition[]> = new Map();

export const parseDefinitions = (textDocument: TextDocument) => {
  const regexDefine = /^\s*#define\s+([A-Za-z_][A-Za-z0-9_]*)/gm;
  const content = textDocument.getText();
  const definitions: PawnDefinition[] = [];
  let match: RegExpExecArray | null;

  while ((match = regexDefine.exec(content)) !== null) {
    const before = content.slice(0, match.index);
    const line = before.split("\n").length - 1;
    const lineStart = before.lastIndexOf("\n") + 1;
    const character = match.index + match[0].indexOf(match[1]) - lineStart;
    const name = match[1];

    definitions.push({
      textDocument,
      completion: {
        label: name,
        kind: CompletionItemKind.Text,
        insertText: name,
      },
      definition: Location.create(textDocument.uri, {
        start: { line, character },
        end: { line, character: character + name.length },
      }),
    });
  }

  definitionTokens.set(textDocument.uri, definitions);
};
