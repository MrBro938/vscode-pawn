import { PawnSymbol } from "./analysis";

const kindLabels: Record<PawnSymbol["kind"], string> = {
  function: "Function",
  macro: "Macro",
  global: "Global variable",
  local: "Local variable",
  parameter: "Parameter",
  enum: "Enum",
  enumMember: "Enum member",
  type: "Pawn tag",
};

export const getPawnSymbolTag = (symbol: PawnSymbol): string | undefined =>
  symbol.tag || symbol.inferredTag;

const formatParameter = (parameter: { detail: string; name?: string; tag?: string; isArray?: boolean }): string => {
  if (parameter.detail.trim()) return parameter.detail.trim();
  const name = parameter.name || "parameter";
  return `${parameter.tag ? parameter.tag + ":" : ""}${name}${parameter.isArray ? "[]" : ""}`;
};

export const formatPawnFunctionSignature = (symbol: PawnSymbol): string => {
  const returnTag = getPawnSymbolTag(symbol);
  const parameters = symbol.parameters?.map(formatParameter) || [];
  return `${returnTag ? returnTag + ":" : ""}${symbol.name}(${parameters.join(", ")})`;
};

export const getPawnSignatureParameters = (
  symbol: PawnSymbol
): Array<{ label: string }> | undefined =>
  symbol.parameters?.map((parameter) => ({ label: formatParameter(parameter) }));

export const formatPawnCompletionDetail = (symbol: PawnSymbol): string | undefined => {
  if (symbol.kind === "function") {
    const returnTag = getPawnSymbolTag(symbol);
    if (returnTag) {
      return `Function · returns ${returnTag}${symbol.inferredTag && !symbol.tag ? " (inferred)" : ""}`;
    }
  }

  const tag = getPawnSymbolTag(symbol);
  if (tag && ["global", "local", "parameter", "enumMember"].includes(symbol.kind)) {
    return `${kindLabels[symbol.kind]} · ${tag}${symbol.isArray ? "[]" : ""}${symbol.inferredTag && !symbol.tag ? " (inferred)" : ""}`;
  }
  return symbol.detail;
};

export const formatPawnSymbolHover = (symbol: PawnSymbol): string => {
  if (symbol.kind === "function") {
    const lines = ["**Function**", "`" + formatPawnFunctionSignature(symbol) + "`"];
    const returnTag = getPawnSymbolTag(symbol);
    if (returnTag) {
      lines.push(`**Returns:** ${returnTag}${symbol.inferredTag && !symbol.tag ? " (inferred)" : ""}`);
    }
    if (symbol.parameters?.length) {
      lines.push("**Parameters:**");
      symbol.parameters.forEach((parameter) => lines.push(`- ${formatParameter(parameter)}`));
    }
    if (symbol.documentation) lines.push(symbol.documentation);
    return lines.join("\n\n");
  }

  if (symbol.kind === "macro") {
    const lines = [symbol.detail || symbol.name];
    if (symbol.documentation) lines.push(symbol.documentation);
    if (symbol.macroReplacement) lines.push("Expands to: " + symbol.macroReplacement);
    return lines.join("\n\n");
  }

  const tag = getPawnSymbolTag(symbol);
  const typeText = tag
    ? `${tag}${symbol.isArray ? "[]" : ""}${symbol.inferredTag && !symbol.tag ? " (inferred)" : ""}`
    : "No tag";
  const lines = [
    `**${kindLabels[symbol.kind]}**`,
    `\`${symbol.name}\` — **${typeText}**`,
  ];
  if (symbol.detail) lines.push(`Declaration: \`${symbol.detail}\``);
  if (symbol.documentation) lines.push(symbol.documentation);
  return lines.join("\n\n");
};
