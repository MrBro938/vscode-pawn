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
    cursorIndex > token.start && cursorIndex < token.end
  );

  // A cursor inside a comment or string is not part of a function argument.
  if (containingToken?.kind === "comment" || containingToken?.kind === "string") {
    return { identifier: "", parameterIndex: 0 };
  }

  const tokens = allTokens.filter((token) =>
    token.start < cursorIndex &&
    token.kind !== "comment" &&
    token.kind !== "string"
  );

  let parenthesisDepth = 0;
  let squareDepth = 0;
  let curlyDepth = 0;
  let parameterIndex = 0;

  for (let index = tokens.length - 1; index >= 0; index--) {
    const token = tokens[index];
    if (token.kind !== "punctuation") continue;

    switch (token.value) {
      case ")":
        parenthesisDepth++;
        break;
      case "(":
        if (parenthesisDepth > 0) {
          parenthesisDepth--;
          break;
        }

        // Only an identifier followed by an opening parenthesis is a call.
        const callee = tokens[index - 1];
        if (callee?.kind !== "identifier") {
          return { identifier: "", parameterIndex: 0 };
        }
        return {
          identifier: callee.value,
          parameterIndex,
        };
      case "]":
        squareDepth++;
        break;
      case "[":
        squareDepth = Math.max(0, squareDepth - 1);
        break;
      case "}":
        curlyDepth++;
        break;
      case "{":
        curlyDepth = Math.max(0, curlyDepth - 1);
        break;
      case ",":
        if (parenthesisDepth === 0 && squareDepth === 0 && curlyDepth === 0) {
          parameterIndex++;
        }
        break;
      case ";":
        if (parenthesisDepth === 0 && squareDepth === 0 && curlyDepth === 0) {
          return { identifier: "", parameterIndex: 0 };
        }
        break;
    }
  }

  return { identifier: "", parameterIndex: 0 };
};
