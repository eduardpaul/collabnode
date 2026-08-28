import { describe, expect, it } from "vitest";
import { parseArgs } from "../src/args.ts";

describe("parseArgs", () => {
  it("parses serve flags", () => {
    const args = parseArgs([
      "node",
      "collabnode",
      "serve",
      "schema.yaml",
      "--backend",
      "fluid",
      "--relay",
      "azure",
      "--graph",
      "ladybug",
      "--join",
      "abc",
    ]);
    expect(args.command).toBe("serve");
    expect(args.schemaPath).toBe("schema.yaml");
    expect(args.backend).toBe("fluid");
    expect(args.relay).toBe("azure");
    expect(args.graph).toBe("ladybug");
    expect(args.join).toBe("abc");
  });

  it("defaults Hocuspocus to port 1234 unless --port is set", () => {
    const defaults = parseArgs(["node", "collabnode", "serve", "schema.yaml", "--backend", "hocuspocus"]);
    expect(defaults.backend).toBe("hocuspocus");
    expect(defaults.port).toBe(1234);
    const custom = parseArgs([
      "node",
      "collabnode",
      "serve",
      "schema.yaml",
      "--backend",
      "hocuspocus",
      "--port",
      "9000",
    ]);
    expect(custom.port).toBe(9000);
  });

  it("parses Apache AGE graph flags", () => {
    const args = parseArgs([
      "node",
      "collabnode",
      "ddl",
      "schema.yaml",
      "--graph",
      "age",
      "--graph-name",
      "harbor_lanes",
      "--data",
      "postgresql://postgres:postgres@127.0.0.1:5455/postgres",
    ]);
    expect(args.graph).toBe("age");
    expect(args.graphName).toBe("harbor_lanes");
    expect(args.data).toContain("5455");
  });

  it("parses mcp transport flags", () => {
    const args = parseArgs([
      "node",
      "collabnode",
      "mcp",
      "schema.yaml",
      "--transport",
      "http",
      "--listen",
      "127.0.0.1:4000",
      "--actor",
      "agent-1",
    ]);
    expect(args.command).toBe("mcp");
    expect(args.transport).toBe("http");
    expect(args.listen).toBe("127.0.0.1:4000");
    expect(args.actor).toBe("agent-1");
  });
});

describe("parseArgs types command", () => {
  it("parses the generation flags", () => {
    const args = parseArgs([
      "node",
      "collabnode",
      "types",
      "workspace.yaml",
      "-o",
      "src/workspace.types.ts",
      "--name",
      "MyBoard",
      "--full",
      "--watch",
    ]);
    expect(args.command).toBe("types");
    expect(args.schemaPath).toBe("workspace.yaml");
    expect(args.out).toBe("src/workspace.types.ts");
    expect(args.typeName).toBe("MyBoard");
    expect(args.full).toBe(true);
    expect(args.watch).toBe(true);
    expect(args.check).toBeUndefined();
  });

  it("treats a prototype key as a positional argument, not a flag", () => {
    // `VALUE_FLAGS[token]` finds `Object.prototype.constructor` for a schema
    // file literally named `constructor`, and `__proto__` for one named that.
    for (const name of ["constructor", "__proto__", "toString"]) {
      const args = parseArgs(["node", "collabnode", "types", name]);
      expect(args.schemaPath).toBe(name);
      expect(args.command).toBe("types");
    }
  });

  it("parses --check on its own", () => {
    const args = parseArgs(["node", "collabnode", "types", "w.yaml", "--check", "--out", "t.ts"]);
    expect(args.check).toBe(true);
    expect(args.out).toBe("t.ts");
    expect(args.full).toBeUndefined();
  });
});
