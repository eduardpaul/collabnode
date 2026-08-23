import { staticKeyTokenProvider, type AzureFluidScope } from "@collabnode/azure";

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

export interface FluidTokenHandlerOptions {
  /** Tenant primary or secondary key. Defaults to `AZURE_FLUID_KEY`. */
  tenantKey?: string;
  tenantId?: string;
  /** Who is asking. Throw to reject the request as unauthenticated. */
  user: (request: Request) => FluidTokenUser | Promise<FluidTokenUser>;
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
    let user: FluidTokenUser;
    try {
      user = await options.user(request);
    } catch (error) {
      return jsonError(401, error instanceof Error ? error.message : "unauthenticated");
    }
    if (!user?.id) {
      return jsonError(401, "unauthenticated");
    }

    const documentId = await readDocumentId(request);
    if (!documentId) {
      // A token with an empty documentId is tenant-wide. Container creation
      // needs one, and that happens server-side; a browser asking for one is
      // either confused or probing.
      return jsonError(400, "documentId is required");
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

async function readDocumentId(request: Request): Promise<string | undefined> {
  const url = new URL(request.url);
  const fromQuery = url.searchParams.get("documentId");
  if (fromQuery) {
    return fromQuery;
  }
  try {
    const body = (await request.clone().json()) as { documentId?: unknown };
    return typeof body.documentId === "string" && body.documentId.length > 0
      ? body.documentId
      : undefined;
  } catch {
    return undefined;
  }
}
