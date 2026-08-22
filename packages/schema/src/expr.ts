import { SchemaError } from "./types.js";

export type Expr =
  | { kind: "num"; value: number }
  | { kind: "str"; value: string }
  | { kind: "bool"; value: boolean }
  | { kind: "null" }
  | { kind: "id"; name: string }
  | { kind: "member"; object: Expr; property: string }
  | { kind: "unary"; op: "+" | "-" | "!"; expr: Expr }
  | {
      kind: "binary";
      op:
        | "+"
        | "-"
        | "*"
        | "/"
        | "%"
        | "=="
        | "!="
        | "==="
        | "!=="
        | "<"
        | "<="
        | ">"
        | ">="
        | "&&"
        | "||";
      left: Expr;
      right: Expr;
    };

export type ArithmeticExpr = Expr;

type Token =
  | { kind: "num"; value: number }
  | { kind: "str"; value: string }
  | { kind: "bool"; value: boolean }
  | { kind: "null" }
  | { kind: "id"; name: string }
  | {
      kind: "op";
      op:
        | "+"
        | "-"
        | "*"
        | "/"
        | "%"
        | "=="
        | "!="
        | "==="
        | "!=="
        | "<"
        | "<="
        | ">"
        | ">="
        | "&&"
        | "||"
        | "!"
        | "("
        | ")"
        | ".";
    }
  | { kind: "eof" };

function tokenize(source: string, path: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const c = source[i]!;
    if (c === " " || c === "\t" || c === "\n" || c === "\r") {
      i += 1;
      continue;
    }

    if (source.startsWith("===", i)) {
      tokens.push({ kind: "op", op: "===" });
      i += 3;
      continue;
    }
    if (source.startsWith("!==", i)) {
      tokens.push({ kind: "op", op: "!==" });
      i += 3;
      continue;
    }
    if (source.startsWith("==", i)) {
      tokens.push({ kind: "op", op: "==" });
      i += 2;
      continue;
    }
    if (source.startsWith("!=", i)) {
      tokens.push({ kind: "op", op: "!=" });
      i += 2;
      continue;
    }
    if (source.startsWith("<=", i)) {
      tokens.push({ kind: "op", op: "<=" });
      i += 2;
      continue;
    }
    if (source.startsWith(">=", i)) {
      tokens.push({ kind: "op", op: ">=" });
      i += 2;
      continue;
    }
    if (source.startsWith("&&", i)) {
      tokens.push({ kind: "op", op: "&&" });
      i += 2;
      continue;
    }
    if (source.startsWith("||", i)) {
      tokens.push({ kind: "op", op: "||" });
      i += 2;
      continue;
    }

    if (
      c === "+" ||
      c === "-" ||
      c === "*" ||
      c === "/" ||
      c === "%" ||
      c === "<" ||
      c === ">" ||
      c === "!" ||
      c === "(" ||
      c === ")" ||
      c === "."
    ) {
      tokens.push({ kind: "op", op: c });
      i += 1;
      continue;
    }

    if (c === '"' || c === "'") {
      const quote = c;
      let str = "";
      i += 1;
      let closed = false;
      while (i < source.length) {
        const ch = source[i]!;
        if (ch === "\\") {
          i += 1;
          if (i >= source.length) {
            throw new SchemaError("unterminated escape sequence in string", path);
          }
          const next = source[i]!;
          if (next === "n") str += "\n";
          else if (next === "t") str += "\t";
          else if (next === "r") str += "\r";
          else if (next === "\\" || next === '"' || next === "'") str += next;
          else str += next;
          i += 1;
          continue;
        }
        if (ch === quote) {
          closed = true;
          i += 1;
          break;
        }
        str += ch;
        i += 1;
      }
      if (!closed) {
        throw new SchemaError("unterminated string literal in expression", path);
      }
      tokens.push({ kind: "str", value: str });
      continue;
    }

    if (c >= "0" && c <= "9") {
      let j = i;
      while (j < source.length && source[j]! >= "0" && source[j]! <= "9") {
        j += 1;
      }
      if (source[j] === ".") {
        j += 1;
        const frac = j;
        while (j < source.length && source[j]! >= "0" && source[j]! <= "9") {
          j += 1;
        }
        if (j === frac) {
          throw new SchemaError("invalid number in expression", path);
        }
      }
      const value = Number(source.slice(i, j));
      if (!Number.isFinite(value)) {
        throw new SchemaError("invalid number in expression", path);
      }
      tokens.push({ kind: "num", value });
      i = j;
      continue;
    }

    if ((c >= "A" && c <= "Z") || (c >= "a" && c <= "z") || c === "_") {
      let j = i + 1;
      while (j < source.length) {
        const n = source[j]!;
        if (
          (n >= "A" && n <= "Z") ||
          (n >= "a" && n <= "z") ||
          (n >= "0" && n <= "9") ||
          n === "_"
        ) {
          j += 1;
          continue;
        }
        break;
      }
      const name = source.slice(i, j);
      if (name === "true") {
        tokens.push({ kind: "bool", value: true });
      } else if (name === "false") {
        tokens.push({ kind: "bool", value: false });
      } else if (name === "null") {
        tokens.push({ kind: "null" });
      } else {
        tokens.push({ kind: "id", name });
      }
      i = j;
      continue;
    }

    throw new SchemaError(`unexpected character '${c}' in derived expression`, path);
  }
  tokens.push({ kind: "eof" });
  return tokens;
}

class Parser {
  private index = 0;

  constructor(
    private readonly tokens: Token[],
    private readonly path: string,
  ) {}

  parse(): Expr {
    if (this.peek().kind === "eof") {
      throw new SchemaError("derived expression is empty", this.path);
    }
    const expr = this.logicalOr();
    if (this.peek().kind !== "eof") {
      throw new SchemaError("unexpected token in derived expression", this.path);
    }
    return expr;
  }

  private logicalOr(): Expr {
    let left = this.logicalAnd();
    while (this.hasOp("||")) {
      const op = this.nextOp();
      left = { kind: "binary", op: op as "||", left, right: this.logicalAnd() };
    }
    return left;
  }

  private logicalAnd(): Expr {
    let left = this.equality();
    while (this.hasOp("&&")) {
      const op = this.nextOp();
      left = { kind: "binary", op: op as "&&", left, right: this.equality() };
    }
    return left;
  }

  private equality(): Expr {
    let left = this.relational();
    while (this.hasOp("==") || this.hasOp("!=") || this.hasOp("===") || this.hasOp("!==")) {
      const op = this.nextOp();
      left = {
        kind: "binary",
        op: op as "==" | "!=" | "===" | "!==",
        left,
        right: this.relational(),
      };
    }
    return left;
  }

  private relational(): Expr {
    let left = this.additive();
    while (this.hasOp("<") || this.hasOp("<=") || this.hasOp(">") || this.hasOp(">=")) {
      const op = this.nextOp();
      left = {
        kind: "binary",
        op: op as "<" | "<=" | ">" | ">=",
        left,
        right: this.additive(),
      };
    }
    return left;
  }

  private additive(): Expr {
    let left = this.multiplicative();
    while (this.hasOp("+") || this.hasOp("-")) {
      const op = this.nextOp();
      left = {
        kind: "binary",
        op: op as "+" | "-",
        left,
        right: this.multiplicative(),
      };
    }
    return left;
  }

  private multiplicative(): Expr {
    let left = this.unary();
    while (this.hasOp("*") || this.hasOp("/") || this.hasOp("%")) {
      const op = this.nextOp();
      left = {
        kind: "binary",
        op: op as "*" | "/" | "%",
        left,
        right: this.unary(),
      };
    }
    return left;
  }

  private unary(): Expr {
    if (this.hasOp("+") || this.hasOp("-") || this.hasOp("!")) {
      const op = this.nextOp() as "+" | "-" | "!";
      return { kind: "unary", op, expr: this.unary() };
    }
    return this.postfix();
  }

  private postfix(): Expr {
    let expr = this.primary();
    while (this.hasOp(".")) {
      this.nextOp();
      const token = this.peek();
      if (token.kind !== "id") {
        throw new SchemaError("expected identifier after '.' in member access", this.path);
      }
      this.index += 1;
      expr = { kind: "member", object: expr, property: token.name };
    }
    return expr;
  }

  private primary(): Expr {
    const token = this.peek();
    if (token.kind === "num") {
      this.index += 1;
      return { kind: "num", value: token.value };
    }
    if (token.kind === "str") {
      this.index += 1;
      return { kind: "str", value: token.value };
    }
    if (token.kind === "bool") {
      this.index += 1;
      return { kind: "bool", value: token.value };
    }
    if (token.kind === "null") {
      this.index += 1;
      return { kind: "null" };
    }
    if (token.kind === "id") {
      this.index += 1;
      if (this.hasOp("(")) {
        throw new SchemaError("function calls are not allowed in derived expressions", this.path);
      }
      return { kind: "id", name: token.name };
    }
    if (this.hasOp("(")) {
      this.index += 1;
      const inner = this.logicalOr();
      if (!this.hasOp(")")) {
        throw new SchemaError("missing ')' in derived expression", this.path);
      }
      this.index += 1;
      return inner;
    }
    throw new SchemaError("unexpected token in derived expression", this.path);
  }

  private peek(): Token {
    return this.tokens[this.index] ?? { kind: "eof" };
  }

  private hasOp(
    op:
      | "+"
      | "-"
      | "*"
      | "/"
      | "%"
      | "=="
      | "!="
      | "==="
      | "!=="
      | "<"
      | "<="
      | ">"
      | ">="
      | "&&"
      | "||"
      | "!"
      | "("
      | ")"
      | ".",
  ): boolean {
    const token = this.peek();
    return token.kind === "op" && token.op === op;
  }

  private nextOp():
    | "+"
    | "-"
    | "*"
    | "/"
    | "%"
    | "=="
    | "!="
    | "==="
    | "!=="
    | "<"
    | "<="
    | ">"
    | ">="
    | "&&"
    | "||"
    | "!"
    | "("
    | ")"
    | "." {
    const token = this.peek();
    if (token.kind !== "op") {
      throw new SchemaError("unexpected token in derived expression", this.path);
    }
    this.index += 1;
    return token.op;
  }
}

export function parseExpression(source: string, path = ""): Expr {
  return new Parser(tokenize(source, path), path).parse();
}

export function parseArithmeticExpression(source: string, path = ""): ArithmeticExpr {
  return parseExpression(source, path);
}

export function expressionIdentifiers(expr: Expr): string[] {
  const names = new Set<string>();
  walk(expr, names);
  return [...names];
}

export function arithmeticIdentifiers(expr: ArithmeticExpr): string[] {
  return expressionIdentifiers(expr);
}

function walk(expr: Expr, names: Set<string>): void {
  switch (expr.kind) {
    case "num":
    case "str":
    case "bool":
    case "null":
      return;
    case "id":
      names.add(expr.name);
      return;
    case "member":
      walk(expr.object, names);
      return;
    case "unary":
      walk(expr.expr, names);
      return;
    case "binary":
      walk(expr.left, names);
      walk(expr.right, names);
      return;
  }
}

export function evaluateExpression(
  exprOrSource: Expr | string,
  context: Record<string, unknown> = {},
  path = "",
): unknown {
  const expr = typeof exprOrSource === "string" ? parseExpression(exprOrSource, path) : exprOrSource;
  return evalNode(expr, context, path);
}

function evalNode(expr: Expr, context: Record<string, unknown>, path: string): unknown {
  switch (expr.kind) {
    case "num":
      return expr.value;
    case "str":
      return expr.value;
    case "bool":
      return expr.value;
    case "null":
      return null;
    case "id":
      return context[expr.name];
    case "member": {
      const obj = evalNode(expr.object, context, path);
      if (obj !== null && typeof obj === "object") {
        return (obj as Record<string, unknown>)[expr.property];
      }
      return undefined;
    }
    case "unary": {
      const val = evalNode(expr.expr, context, path);
      if (expr.op === "!") {
        return !val;
      }
      if (expr.op === "-") {
        return -Number(val);
      }
      return +Number(val);
    }
    case "binary": {
      if (expr.op === "&&") {
        const left = evalNode(expr.left, context, path);
        return left ? evalNode(expr.right, context, path) : left;
      }
      if (expr.op === "||") {
        const left = evalNode(expr.left, context, path);
        return left ? left : evalNode(expr.right, context, path);
      }
      const left = evalNode(expr.left, context, path);
      const right = evalNode(expr.right, context, path);
      switch (expr.op) {
        case "+":
          if (typeof left === "string" || typeof right === "string") {
            return String(left ?? "") + String(right ?? "");
          }
          return Number(left) + Number(right);
        case "-":
          return Number(left) - Number(right);
        case "*":
          return Number(left) * Number(right);
        case "/": {
          const numRight = Number(right);
          if (numRight === 0) {
            throw new SchemaError("division by zero", path);
          }
          return Number(left) / numRight;
        }
        case "%":
          return Number(left) % Number(right);
        case "==":
          // eslint-disable-next-line eqeqeq
          return left == right;
        case "!=":
          // eslint-disable-next-line eqeqeq
          return left != right;
        case "===":
          return left === right;
        case "!==":
          return left !== right;
        case "<":
          return (left as number) < (right as number);
        case "<=":
          return (left as number) <= (right as number);
        case ">":
          return (left as number) > (right as number);
        case ">=":
          return (left as number) >= (right as number);
      }
    }
  }
}

/**
 * Interpolates `{expr}` patterns in template strings.
 * e.g. `"member_{item}"` with `{ item: "alice" }` -> `"member_alice"`
 * e.g. `"Sprint {sprint + 1}"` with `{ sprint: 1 }` -> `"Sprint 2"`
 */
export function interpolateTemplate(
  template: string,
  context: Record<string, unknown>,
  path = "",
): string {
  if (!template.includes("{")) {
    return template;
  }
  return template.replace(/\{([^}]+)\}/g, (_match, exprStr: string) => {
    const trimmed = exprStr.trim();
    try {
      const result = evaluateExpression(trimmed, context, path);
      if (result === undefined || result === null) {
        return "";
      }
      if (typeof result === "object") {
        return JSON.stringify(result);
      }
      return String(result);
    } catch {
      if (trimmed in context) {
        const val = context[trimmed];
        return val === undefined || val === null ? "" : String(val);
      }
      return "";
    }
  });
}

/**
 * Evaluates a value which might be a template string, raw value, or structured object.
 * If the value is strictly `"{expression}"`, returns the raw evaluated result (number, boolean, object, etc.).
 */
export function evaluateValue(
  value: unknown,
  context: Record<string, unknown>,
  path = "",
): unknown {
  if (typeof value === "string") {
    const trimmed = value.trim();
    const singleMatch = trimmed.match(/^\{([^}]+)\}$/);
    if (singleMatch) {
      try {
        return evaluateExpression(singleMatch[1]!.trim(), context, path);
      } catch {
        return interpolateTemplate(value, context, path);
      }
    }
    if (value.includes("{")) {
      return interpolateTemplate(value, context, path);
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => evaluateValue(item, context, path));
  }
  if (value !== null && typeof value === "object") {
    const res: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      res[k] = evaluateValue(v, context, path);
    }
    return res;
  }
  return value;
}

