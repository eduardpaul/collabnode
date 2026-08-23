import { describe, expect, it } from "vitest";
import { createFluidTokenHandler } from "../src/index.ts";

const TENANT = { tenantId: "tenant-1", tenantKey: "test-key" } as const;
const ada = () => ({ id: "ada", name: "Ada" });

function post(body: Record<string, unknown>): Request {
  return new Request("http://localhost/api/fluid/token", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function payloadOf(jwt: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(jwt.split(".")[1]!, "base64url").toString("utf8"));
}

describe("createFluidTokenHandler", () => {
  it("mints a token for a document the caller is allowed to open", async () => {
    const handler = createFluidTokenHandler({
      ...TENANT,
      user: ada,
      authorize: ({ documentId }) => documentId === "doc-allowed",
    });

    const response = await handler(post({ documentId: "doc-allowed" }));
    expect(response.status).toBe(200);

    const { jwt } = (await response.json()) as { jwt: string };
    expect(payloadOf(jwt).documentId).toBe("doc-allowed");
    expect(payloadOf(jwt).user).toEqual({ id: "ada", name: "Ada" });
  });

  it("refuses a document the caller is not allowed to open", async () => {
    const handler = createFluidTokenHandler({
      ...TENANT,
      user: ada,
      authorize: ({ documentId }) => documentId === "doc-allowed",
    });

    // Without this check the tenant key would happily open someone else's
    // document: `user()` says who is asking, never what they may have.
    const response = await handler(post({ documentId: "someone-elses-doc" }));
    expect(response.status).toBe(403);
  });

  it("passes the caller and the raw request to authorize", async () => {
    const seen: string[] = [];
    const handler = createFluidTokenHandler({
      ...TENANT,
      user: ada,
      authorize: ({ user, documentId, request }) => {
        seen.push(`${user.id}:${documentId}:${new URL(request.url).pathname}`);
        return true;
      },
    });

    await handler(post({ documentId: "doc-1" }));
    expect(seen).toEqual(["ada:doc-1:/api/fluid/token"]);
  });

  it("rejects a request with no documentId instead of minting a tenant-wide token", async () => {
    const handler = createFluidTokenHandler({ ...TENANT, user: ada, authorize: () => true });
    const response = await handler(post({}));
    expect(response.status).toBe(400);
  });

  it("treats a throwing user() as unauthenticated", async () => {
    const handler = createFluidTokenHandler({
      ...TENANT,
      user: () => {
        throw new Error("no session cookie");
      },
      authorize: () => true,
    });

    const response = await handler(post({ documentId: "doc-1" }));
    expect(response.status).toBe(401);
  });

  it("does not consult authorize when the caller is unauthenticated", async () => {
    let authorizeCalls = 0;
    const handler = createFluidTokenHandler({
      ...TENANT,
      user: () => {
        throw new Error("no session cookie");
      },
      authorize: () => {
        authorizeCalls++;
        return true;
      },
    });

    await handler(post({ documentId: "doc-1" }));
    expect(authorizeCalls).toBe(0);
  });

  it("reads documentId from the query string too", async () => {
    const handler = createFluidTokenHandler({ ...TENANT, user: ada, authorize: () => true });
    const response = await handler(
      new Request("http://localhost/api/fluid/token?documentId=doc-q", { method: "POST" }),
    );
    expect(response.status).toBe(200);
  });

  it("narrows the minted token to the scopes it was configured with", async () => {
    const handler = createFluidTokenHandler({
      ...TENANT,
      user: ada,
      authorize: () => true,
      scopes: ["doc:read"],
    });

    const { jwt } = (await (await handler(post({ documentId: "doc-1" }))).json()) as { jwt: string };
    expect(payloadOf(jwt).scopes).toEqual(["doc:read"]);
  });

  it("refuses to construct without a tenant key", () => {
    const previous = process.env.AZURE_FLUID_KEY;
    delete process.env.AZURE_FLUID_KEY;
    try {
      expect(() =>
        createFluidTokenHandler({ tenantId: "tenant-1", user: ada, authorize: () => true }),
      ).toThrow(/AZURE_FLUID_KEY/);
    } finally {
      if (previous !== undefined) {
        process.env.AZURE_FLUID_KEY = previous;
      }
    }
  });

  it("refuses to construct without an authorize callback", () => {
    expect(() =>
      createFluidTokenHandler({
        ...TENANT,
        user: ada,
      } as unknown as Parameters<typeof createFluidTokenHandler>[0]),
    ).toThrow(/authorize/);
  });
});
