import {
  CompletionItem,
  CompletionItemKind,
  Definition,
  Location,
  ParameterInformation,
} from "vscode-languageserver";
import { TextDocument } from "vscode-languageserver-textdocument";

import { tokenizePawn } from "./symbols";

export interface PawnFunction {
  uri: string;
  completion: CompletionItem;
  definition: Definition;
  params?: ParameterInformation[];
}

export interface FindFunctionIdentifierResult {
  identifier: string;
  parameterIndex: number;
}

export let functionTokens: Map<string, PawnFunction> = new Map();
export const functionTokensByUri: Map<string, Map<string, PawnFunction>> = new Map();

export const parseFunctions = (textDocument: TextDocument) => {
  const regex = /^(?:(forward|native|stock)\s+)?(\S+)\((.*?)\)/gm;
  const content = textDocument.getText();
  const splitContent = content.split("\n");
  splitContent.forEach((cont: string, index: number) => {
    var m;
    do {
      m = regex.exec(cont);
      if (m) {
        let doc: string = "";
        let endDoc = -1;
        if (splitContent[index - 1] !== undefined)
          endDoc = splitContent[index - 1].indexOf("*/");
        if (endDoc !== -1) {
          let startDoc = -1;
          let inNum = index;
          while (inNum >= 0) {
            inNum--;
            if (splitContent[inNum] === undefined) continue;
            startDoc = splitContent[inNum].indexOf("/*");
            if (startDoc !== -1) {
              if (inNum === index) {
                doc = splitContent[index];
              } else if (inNum < index) {
                while (inNum < index) {
                  doc += splitContent[inNum] + "\n\n";
                  inNum++;
                }
              }
              break;
            }
          }
        }
        doc = doc.replace("/*", "").replace("*/", "").trim();
        const newSnip: CompletionItem = {
          label: m[2] + "(" + m[3] + ")",
          kind: CompletionItemKind.Function,
          insertText: m[2] + "(" + m[3] + ")",
          documentation: doc,
        };
        const newDef: Definition = Location.create(textDocument.uri, {
          start: { line: index, character: m.input.indexOf(m[2]) },
          end: { line: index, character: m.input.indexOf(m[2]) + m[2].length },
        });
        let params: ParameterInformation[] = [];
        if (m[3].trim().length > 0) {
          params = m[3].split(",").map((value) => ({ label: value.trim() }));
        } else {
          params = [];
        }
        const pwnFun: PawnFunction = {
          uri: textDocument.uri,
          definition: newDef,
          completion: newSnip,
          params,
        };
        const indexPos = m[2].indexOf(":");
        if (indexPos !== -1) {
          const resOut = /:(.*)/gm.exec(m[2]);
          if (resOut) m[2] = resOut[1];
        }
        let documentFunctions = functionTokensByUri.get(textDocument.uri);
        if (!documentFunctions) {
          documentFunctions = new Map<string, PawnFunction>();
          functionTokensByUri.set(textDocument.uri, documentFunctions);
        }
        documentFunctions.set(m[2], pwnFun);

        const findSnip = functionTokens.get(m[2]);
        if (findSnip === undefined) functionTokens.set(m[2], pwnFun);
      }
    } while (m);
  });
};

export const findFunctionIdentifier = (
  content: string,
  cursorIndex: number
): FindFunctionIdentifierResult => {
  const allTokens = tokenizePawn(content);
  const containingToken = allTokens.find((token) =>
    cursorIndex >= token.start &&
    cursorIndex < token.end &&
    (token.kind === "comment" || token.kind === "string")
  );
  if (containingToken) return { identifier: "", parameterIndex: 0 };

  const tokens = allTokens.filter((token) =>
    token.start < cursorIndex &&
    token.kind !== "comment" &&
    token.kind !== "string"
  );

  type Delimiter = "(" | "[" | "{";
  interface CallContext {
    delimiter: Delimiter;
    identifier: string;
    parameterIndex: number;
  }
  const stack: CallContext[] = [];

  tokens.forEach((token, index) => {
    if (token.kind !== "punctuation") return;

    if (token.value === "(" || token.value === "[") {
      const previous = tokens[index - 1];
      stack.push({
        delimiter: token.value,
        identifier: previous?.kind === "identifier" ? previous.value : "",
        parameterIndex: 0,
      });
      return;
    }

    if (token.value === "{") {
      stack.push({ delimiter: "{", identifier: "", parameterIndex: 0 });
      return;
    }

    if (token.value === ")" || token.value === "]" || token.value === "}") {
      const expected = token.value === ")" ? "(" : token.value === "]" ? "[" : "{";
      if (stack[stack.length - 1]?.delimiter === expected) stack.pop();
      return;
    }

    const active = stack[stack.length - 1];
    if (token.value === "," && active && active.delimiter !== "{") {
      active.parameterIndex++;
      return;
    }

    // A semicolon ends an expression unless it belongs to a parenthesized
    // construct such as a for-loop header.
    if (
      token.value === ";" &&
      !stack.some((context) => context.delimiter === "(" || context.delimiter === "[")
    ) {
      stack.length = 0;
    }
  });

  for (let index = stack.length - 1; index >= 0; index--) {
    const context = stack[index];
    if (
      (context.delimiter === "(" || context.delimiter === "[") &&
      context.identifier
    ) {
      return {
        identifier: context.identifier,
        parameterIndex: context.parameterIndex,
      };
    }
  }

  return { identifier: "", parameterIndex: 0 };
};
