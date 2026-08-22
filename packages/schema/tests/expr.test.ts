import { describe, expect, it } from "vitest";
import {
  arithmeticIdentifiers,
  evaluateExpression,
  evaluateValue,
  expressionIdentifiers,
  interpolateTemplate,
  parseArithmeticExpression,
  parseExpression,
  SchemaError,
} from "../src/index.ts";

describe("expression parser & evaluator", () => {
  it("parses and evaluates basic arithmetic", () => {
    expect(evaluateExpression("1 + 2")).toBe(3);
    expect(evaluateExpression("10 - 4")).toBe(6);
    expect(evaluateExpression("3 * 7")).toBe(21);
    expect(evaluateExpression("20 / 4")).toBe(5);
    expect(evaluateExpression("10 % 3")).toBe(1);
    expect(evaluateExpression("2 + 3 * 4")).toBe(14);
    expect(evaluateExpression("(2 + 3) * 4")).toBe(20);
  });

  it("handles unary operators", () => {
    expect(evaluateExpression("-5")).toBe(-5);
    expect(evaluateExpression("+5")).toBe(5);
    expect(evaluateExpression("!true")).toBe(false);
    expect(evaluateExpression("!false")).toBe(true);
    expect(evaluateExpression("!(sprint == 0)", { sprint: 1 })).toBe(true);
  });

  it("handles string and boolean literals", () => {
    expect(evaluateExpression('"hello"')).toBe("hello");
    expect(evaluateExpression("'world'")).toBe("world");
    expect(evaluateExpression("true")).toBe(true);
    expect(evaluateExpression("false")).toBe(false);
    expect(evaluateExpression("null")).toBeNull();
  });

  it("handles string concatenation with +", () => {
    expect(evaluateExpression('"Sprint " + 42')).toBe("Sprint 42");
    expect(evaluateExpression('"Hello " + name', { name: "Alice" })).toBe("Hello Alice");
  });

  it("handles comparison operators", () => {
    expect(evaluateExpression("5 == 5")).toBe(true);
    expect(evaluateExpression("5 != 6")).toBe(true);
    expect(evaluateExpression("5 === 5")).toBe(true);
    expect(evaluateExpression("5 !== 6")).toBe(true);
    expect(evaluateExpression("3 < 5")).toBe(true);
    expect(evaluateExpression("5 <= 5")).toBe(true);
    expect(evaluateExpression("5 > 3")).toBe(true);
    expect(evaluateExpression("5 >= 5")).toBe(true);
    expect(evaluateExpression("3 > 5")).toBe(false);
  });

  it("handles logical operators with short-circuiting", () => {
    expect(evaluateExpression("true && false")).toBe(false);
    expect(evaluateExpression("true && true")).toBe(true);
    expect(evaluateExpression("false || true")).toBe(true);
    expect(evaluateExpression("false || false")).toBe(false);
    expect(evaluateExpression("sprint > 0 && active", { sprint: 1, active: true })).toBe(true);
    expect(evaluateExpression("sprint > 0 && active", { sprint: 0, active: true })).toBe(false);
  });

  it("handles nested member access", () => {
    const context = {
      user: {
        profile: {
          name: "Alice",
          age: 30,
        },
      },
      item: {
        votes: 10,
      },
    };
    expect(evaluateExpression("user.profile.name", context)).toBe("Alice");
    expect(evaluateExpression("user.profile.age + 1", context)).toBe(31);
    expect(evaluateExpression("item.votes >= 5", context)).toBe(true);
    expect(evaluateExpression("user.missing.property", context)).toBeUndefined();
  });

  it("extracts identifiers correctly", () => {
    const expr = parseExpression("complexity * (1 + uncertainty / 5)");
    expect(expressionIdentifiers(expr).sort()).toEqual(["complexity", "uncertainty"].sort());
    expect(arithmeticIdentifiers(expr).sort()).toEqual(["complexity", "uncertainty"].sort());

    const memberExpr = parseExpression("user.profile.name == target && active");
    expect(expressionIdentifiers(memberExpr).sort()).toEqual(["active", "target", "user"].sort());
  });

  it("throws SchemaError on invalid expressions and division by zero", () => {
    expect(() => evaluateExpression("10 / 0")).toThrow(SchemaError);
    expect(() => parseExpression("10 +")).toThrow(SchemaError);
    expect(() => parseExpression("(1 + 2")).toThrow(SchemaError);
    expect(() => parseExpression("foo()")).toThrow(/function calls/);
    expect(() => parseExpression("")).toThrow(SchemaError);
  });

  it("maintains compatibility with parseArithmeticExpression", () => {
    const expr = parseArithmeticExpression("n + 1");
    expect(expr.kind).toBe("binary");
    expect(evaluateExpression(expr, { n: 5 })).toBe(6);
  });
});

describe("template string interpolation & evaluateValue", () => {
  it("interpolates simple placeholders", () => {
    expect(interpolateTemplate("member_{item}", { item: "alice" })).toBe("member_alice");
    expect(interpolateTemplate("Sprint {sprint} Retro", { sprint: 42 })).toBe("Sprint 42 Retro");
  });

  it("interpolates expressions inside placeholders", () => {
    expect(interpolateTemplate("Sprint {sprint + 1}", { sprint: 1 })).toBe("Sprint 2");
    expect(interpolateTemplate("Task: {item.title}", { item: { title: "Refactor" } })).toBe("Task: Refactor");
  });

  it("leaves text without braces untouched", () => {
    expect(interpolateTemplate("simple text", {})).toBe("simple text");
  });

  it("evaluates values with evaluateValue", () => {
    expect(evaluateValue("{sprint}", { sprint: 42 })).toBe(42);
    expect(evaluateValue("{active}", { active: true })).toBe(true);
    expect(evaluateValue("Sprint {sprint}", { sprint: 42 })).toBe("Sprint 42");
    expect(evaluateValue({ title: "{title}", count: "{count}" }, { title: "A", count: 10 })).toEqual({
      title: "A",
      count: 10,
    });
    expect(evaluateValue(["{item1}", "{item2}"], { item1: "A", item2: "B" })).toEqual(["A", "B"]);
  });
});
