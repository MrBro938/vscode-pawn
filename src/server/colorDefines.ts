export interface PawnColorDefineExpression {
  name: string;
  expression: string;
}

export interface PawnColorDefine {
  name: string;
  red: number;
  green: number;
  blue: number;
  alpha: number;
}

const stripPawnComments = (
  line: string,
  startsInBlockComment: boolean
): { text: string; inBlockComment: boolean } => {
  let output = "";
  let inBlockComment = startsInBlockComment;
  let quote: "\"" | "'" | undefined;
  let escaped = false;

  for (let index = 0; index < line.length; index++) {
    const current = line[index];
    const next = line[index + 1];

    if (inBlockComment) {
      if (current === "*" && next === "/") {
        inBlockComment = false;
        index++;
      }
      continue;
    }

    if (quote) {
      output += current;
      if (escaped) escaped = false;
      else if (current === "\\") escaped = true;
      else if (current === quote) quote = undefined;
      continue;
    }

    if (current === "\"" || current === "'") {
      quote = current;
      output += current;
      continue;
    }
    if (current === "/" && next === "/") break;
    if (current === "/" && next === "*") {
      inBlockComment = true;
      index++;
      continue;
    }
    output += current;
  }

  return { text: output, inBlockComment };
};

export const extractPawnColorDefineExpressions = (
  text: string
): PawnColorDefineExpression[] => {
  const lines = text.split(/\r?\n/);
  const definitions: PawnColorDefineExpression[] = [];
  let inBlockComment = false;

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const cleaned = stripPawnComments(lines[lineIndex], inBlockComment);
    inBlockComment = cleaned.inBlockComment;
    const match = /^\s*#\s*define\s+([A-Za-z_@][A-Za-z0-9_@]*)(.*)$/.exec(cleaned.text);
    if (!match) continue;

    // Function-like macros have no whitespace between the name and "(".
    const tail = match[2] || "";
    if (!tail || !/^\s/.test(tail)) continue;

    let expression = tail.trim();
    while (/\\\s*$/.test(expression) && lineIndex + 1 < lines.length) {
      expression = expression.replace(/\\\s*$/, "");
      const next = stripPawnComments(lines[++lineIndex], inBlockComment);
      inBlockComment = next.inBlockComment;
      expression += " " + next.text.trim();
    }
    if (expression) definitions.push({ name: match[1], expression });
  }

  return definitions;
};

const unwrapParentheses = (value: string): string => {
  let expression = value.trim();
  while (expression.startsWith("(") && expression.endsWith(")")) {
    let depth = 0;
    let closesAtEnd = false;
    for (let index = 0; index < expression.length; index++) {
      if (expression[index] === "(") depth++;
      else if (expression[index] === ")") {
        depth--;
        if (depth === 0) {
          closesAtEnd = index === expression.length - 1;
          break;
        }
      }
    }
    if (!closesAtEnd) break;
    expression = expression.slice(1, -1).trim();
  }
  return expression;
};

export const parsePawnColorDefineValue = (
  value: string
): Omit<PawnColorDefine, "name"> | undefined => {
  const expression = unwrapParentheses(value);
  const match = /^0[xX]([0-9A-Fa-f]{6}|[0-9A-Fa-f]{8})$/.exec(expression);
  if (!match) return undefined;

  const digits = match[1];
  return {
    red: parseInt(digits.slice(0, 2), 16) / 255,
    green: parseInt(digits.slice(2, 4), 16) / 255,
    blue: parseInt(digits.slice(4, 6), 16) / 255,
    alpha: digits.length === 8
      ? parseInt(digits.slice(6, 8), 16) / 255
      : 1,
  };
};

export const resolvePawnColorDefines = (
  definitions: readonly PawnColorDefineExpression[]
): PawnColorDefine[] => {
  const byName = new Map<string, PawnColorDefineExpression>();
  definitions.forEach((definition) => {
    byName.set(definition.name.toLowerCase(), definition);
  });

  const resolve = (
    key: string,
    visited: Set<string>
  ): Omit<PawnColorDefine, "name"> | undefined => {
    if (visited.has(key)) return undefined;
    const definition = byName.get(key);
    if (!definition) return undefined;

    const direct = parsePawnColorDefineValue(definition.expression);
    if (direct) return direct;

    const alias = unwrapParentheses(definition.expression);
    if (!/^[A-Za-z_@][A-Za-z0-9_@]*$/.test(alias)) return undefined;
    const nextVisited = new Set(visited);
    nextVisited.add(key);
    return resolve(alias.toLowerCase(), nextVisited);
  };

  const result: PawnColorDefine[] = [];
  byName.forEach((definition, key) => {
    const color = resolve(key, new Set());
    if (color) result.push({ name: definition.name, ...color });
  });
  return result;
};
