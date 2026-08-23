import { staticKeyTokenProvider, type AzureFluidScope } from "@collabnode/azure";
import type { Hub, WorkspaceRecord, WorkspaceRegistry } from "@collabnode/hub";

export interface FluidTokenUser {
  id: string;
  name?: string;
}

export interface FluidTokenRequest {
  /** The document the caller is asking for a token to. */
  documentId: string;
  /** Whoever `user()` said this request is. */
  user: FluidTokenUser;
  request: Request;
}

/** What the request said, before anyone decided whether to believe it. */
export interface FluidTokenClaim {
  documentId: string;
  /**
   * The `actorId` the browser sent — `@collabnode/web` connect() puts its
   * `actorId` here. It is a claim, not an identity: treat it the way you would
   * treat any other field of the body.
   */
  actorId?: string;
}

export interface FluidTokenHandlerOptions {
  /** Tenant primary or secondary key. Defaults to `AZURE_FLUID_KEY`. */
  tenantKey?: string;
  tenantId?: string;
  /**
   * Who is asking. Throw to reject the request as unauthenticated.
   *
   * The second argument is what the request claimed — the document, and the
   * `actorId` the browser sent — so the common case does not have to re-read
   * the body that was already parsed to find the document id.
   */
  user: (
    request: Request,
    claim: FluidTokenClaim,
  ) => FluidTokenUser | Promise<FluidTokenUser>;
  /**
   * Whether this user may open this document. Required, and there is no
   * default: `user()` answers *who*, never *may they*, and a token minted from
   * the tenant key opens whatever `documentId` the caller typed. Without this
   * check the route hands any caller a writable token to any document in the
   * tenant.
   */
  authorize: (context: FluidTokenRequest) => boolean | Promise<boolean>;
  /** Narrow the token, e.g. `["doc:read"]` for a viewer. */
  scopes?: readonly AzureFluidScope[];
  lifetimeSeconds?: number;
}

/**
 * Mount on your HTTP server (POST). Mints Azure Fluid Relay tokens using the
 * **server-side** tenant key. Never ship that key to the browser.
 */
export function createFluidTokenHandler(
  options: FluidTokenHandlerOptions,
): (request: Request) => Promise<Response> {
  const tenantId = options.tenantId ?? process.env.AZURE_FLUID_TENANT_ID;
  if (!tenantId) {
    throw new Error("createFluidTokenHandler requires tenantId or AZURE_FLUID_TENANT_ID");
  }
  const tenantKey = options.tenantKey ?? process.env.AZURE_FLUID_KEY;
  if (!tenantKey) {
    throw new Error("createFluidTokenHandler requires tenantKey or AZURE_FLUID_KEY");
  }
  if (typeof options.authorize !== "function") {
    throw new Error(
      "createFluidTokenHandler requires an authorize({ documentId, user, request }) callback: the tenant key opens every document in the tenant, so the route has to decide which ones this caller may have.",
    );
  }

  const tokenOptions = {
    ...(options.scopes ? { scopes: options.scopes } : {}),
    ...(options.lifetimeSeconds !== undefined ? { lifetimeSeconds: options.lifetimeSeconds } : {}),
  };

  return async (request: Request) => {
    const claim = await readClaim(request);
    if (!claim.documentId) {
      // A token with an empty documentId is tenant-wide. Container creation
      // needs one, and that happens server-side; a browser asking for one is
      // either confused or probing.
      return jsonError(400, "documentId is required");
    }
    const documentId = claim.documentId;

    let user: FluidTokenUser;
    try {
      user = await options.user(request, claim);
    } catch (error) {
      return jsonError(401, error instanceof Error ? error.message : "unauthenticated");
    }
    if (!user?.id) {
      return jsonError(401, "unauthenticated");
    }

    if (!(await options.authorize({ documentId, user, request }))) {
      return jsonError(403, "forbidden");
    }

    const provider = staticKeyTokenProvider(tenantKey, user, tokenOptions);
    const token = await provider.fetchOrdererToken(tenantId, documentId);
    return Response.json(token);
  };
}

function jsonError(status: number, error: string): Response {
  return Response.json({ error }, { status });
}

/** Read the body (or query) once, so `user` and `authorize` share one parse. */
async function readClaim(request: Request): Promise<FluidTokenClaim> {
  const url = new URL(request.url);
  let body: { documentId?: unknown; actorId?: unknown } = {};
  try {
    body = (await request.clone().json()) as typeof body;
  } catch {
    // Not JSON, or no body at all: the query string is the other way in.
  }
  const documentId =
    url.searchParams.get("documentId") ??
    (typeof body.documentId === "string" ? body.documentId : "");
  const actorId =
    url.searchParams.get("actorId") ??
    (typeof body.actorId === "string" ? body.actorId : undefined);
  return {
    documentId,
    ...(actorId ? { actorId } : {}),
  };
}

/**
 * `authorize` for a hub: the document has to be one this hub actually opened.
 *
 * This is the floor, not a policy — it stops a caller minting a token for a
 * document belonging to some other app in the same tenant, and nothing more.
 * Which *people* may open which boards is yours to add on top:
 *
 * ```ts
 * authorize: async (context) =>
 *   (await hubDocumentAuthorizer(hub)(context)) && isMember(context.user.id, context.documentId)
 * ```
 */
export function hubDocumentAuthorizer(
  hub: Pick<Hub, "registry" | "list">,
): (context: FluidTokenRequest) => Promise<boolean> {
  return async ({ documentId }) => {
    if (!documentId) {
      return false;
    }
    const registry = hub.registry as WorkspaceRegistry & {
      findByCollabDocId?: (docId: string) => Promise<WorkspaceRecord | undefined>;
    };
    if (typeof registry.findByCollabDocId === "function") {
      const record = await registry.findByCollabDocId(documentId);
      return record?.state === "active" || record?.state === "seeding";
    }
    // No index on this registry: fall back to a scan, which is correct but
    // costs one read per live workspace on every token request.
    const records = await hub.list({ state: "active" });
    return records.some((record) => record.collabDocId === documentId);
  };
}
