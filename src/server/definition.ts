import {
  CompletionItem,
  CompletionItemKind,
  Definition,
  Location,
} from "vscode-languageserver";
import { TextDocument } from "vscode-languageserver-textdocument";

export interface PawnDefinition {
  uri: string;
  completion: CompletionItem;
  definition: Definition;
}

export const definitionTokens: Map<string, PawnDefinition[]> = new Map();

export const parseDefinitions = (textDocument: TextDocument) => {
  const regexDefine = /^\s*#define\s+([A-Za-z_][A-Za-z0-9_]*)/;
  const lines = textDocument.getText().split("\n");
  const definitions: PawnDefinition[] = [];

  lines.forEach((line, lineIndex) => {
    const match = regexDefine.exec(line);
    if (!match) return;

    const name = match[1];
    const character = line.indexOf(name);

    definitions.push({
      uri: textDocument.uri,
      completion: {
        label: name,
        kind: CompletionItemKind.Text,
        insertText: name,
      },
      definition: Location.create(textDocument.uri, {
        start: { line: lineIndex, character },
        end: { line: lineIndex, character: character + name.length },
      }),
    });
  });

  definitionTokens.set(textDocument.uri, definitions);
};
