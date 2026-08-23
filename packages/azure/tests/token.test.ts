import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { signAzureFluidToken, staticKeyTokenProvider } from "../src/index.ts";

// Synthetic. A real tenant key is a bearer credential for every document in the
// tenant, so one must never end up in a test file — least of all in a package
// that gets published.
const KEY = "test-tenant-key-0000000000000000000000000000";

function decode(token: string): { header: Record<string, unknown>; payload: Record<string, unknown> } {
  const [header, payload] = token.split(".");
  return {
    header: JSON.parse(Buffer.from(header!, "base64url").toString("utf8")),
    payload: JSON.parse(Buffer.from(payload!, "base64url").toString("utf8")),
  };
}

function verify(token: string, key: string): boolean {
  const parts = token.split(".");
  const expected = createHmac("sha256", key)
    .update(`${parts[0]}.${parts[1]}`)
    .digest("base64url");
  return parts[2] === expected;
}

describe("signAzureFluidToken", () => {
  it("signs with HS256 so the relay can verify it", () => {
    const token = signAzureFluidToken({
      key: KEY,
      tenantId: "tenant-1",
      documentId: "doc-1",
      user: { id: "ada", name: "Ada" },
    });

    expect(decode(token).header).toEqual({ alg: "HS256", typ: "JWT" });
    expect(verify(token, KEY)).toBe(true);
    // An unsigned token — the shape this used to emit — is what Azure rejects.
    expect(token.endsWith(".")).toBe(false);
  });

  it("does not verify under a different key", () => {
    const token = signAzureFluidToken({
      key: KEY,
      tenantId: "tenant-1",
      documentId: "doc-1",
      user: { id: "ada" },
    });
    expect(verify(token, "some-other-key")).toBe(false);
  });

  it("carries the claim set Azure Fluid Relay expects", () => {
    const { payload } = decode(
      signAzureFluidToken({
        key: KEY,
        tenantId: "tenant-1",
        documentId: "doc-1",
        user: { id: "ada", name: "Ada" },
      }),
    );

    expect(payload.documentId).toBe("doc-1");
    expect(payload.tenantId).toBe("tenant-1");
    expect(payload.scopes).toEqual(["doc:read", "doc:write", "summary:write"]);
    expect(payload.user).toEqual({ id: "ada", name: "Ada" });
    expect(payload.ver).toBe("1.0");
    expect(typeof payload.jti).toBe("string");
    expect(Number(payload.exp)).toBeGreaterThan(Number(payload.iat));
  });

  it("never puts key material in the payload", () => {
    const token = signAzureFluidToken({
      key: KEY,
      tenantId: "tenant-1",
      documentId: "doc-1",
      user: { id: "ada" },
    });
    const [, payload] = token.split(".");
    const decoded = Buffer.from(payload!, "base64url").toString("utf8");
    expect(decoded).not.toContain(KEY.slice(0, 4));
  });

  it("mints a fresh jti per token so replays are rejected", () => {
    const mint = () =>
      decode(
        signAzureFluidToken({ key: KEY, tenantId: "t", documentId: "d", user: { id: "ada" } }),
      ).payload.jti;
    expect(mint()).not.toBe(mint());
  });

  it("allows an empty documentId, which is what container creation needs", () => {
    const { payload } = decode(
      signAzureFluidToken({ key: KEY, tenantId: "t", user: { id: "ada" } }),
    );
    expect(payload.documentId).toBe("");
  });

  it("narrows scopes and lifetime when asked", () => {
    const { payload } = decode(
      signAzureFluidToken({
        key: KEY,
        tenantId: "t",
        documentId: "d",
        user: { id: "ada" },
        scopes: ["doc:read"],
        lifetimeSeconds: 60,
      }),
    );
    expect(payload.scopes).toEqual(["doc:read"]);
    expect(Number(payload.exp) - Number(payload.iat)).toBe(60);
  });

  it("refuses to mint without a key rather than emitting an unsigned token", () => {
    expect(() =>
      signAzureFluidToken({ key: "", tenantId: "t", documentId: "d", user: { id: "ada" } }),
    ).toThrow(/tenant key is required/);
  });
});

describe("staticKeyTokenProvider", () => {
  it("signs both the orderer and the storage token", async () => {
    const provider = staticKeyTokenProvider(KEY, { id: "ada" });
    const orderer = await provider.fetchOrdererToken("tenant-1", "doc-1");
    const storage = await provider.fetchStorageToken("tenant-1", "doc-1");

    expect(verify(orderer.jwt, KEY)).toBe(true);
    expect(verify(storage.jwt, KEY)).toBe(true);
  });

  it("scopes the token to the document it was asked for", async () => {
    const provider = staticKeyTokenProvider(KEY, { id: "ada" });
    const { jwt } = await provider.fetchOrdererToken("tenant-1", "doc-42");
    expect(decode(jwt).payload.documentId).toBe("doc-42");
  });
});
