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
