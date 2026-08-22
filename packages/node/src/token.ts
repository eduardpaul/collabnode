import { staticKeyTokenProvider } from "@collabnode/azure";

export interface FluidTokenUser {
  id: string;
  name?: string;
}

/**
 * Mount on your HTTP server (POST). Mints Azure Fluid Relay tokens using the
 * **server-side** tenant key. Never ship that key to the browser.
 */
export function createFluidTokenHandler(options: {
  tenantKey: string;
  tenantId?: string;
  user: (request: Request) => FluidTokenUser | Promise<FluidTokenUser>;
}): (request: Request) => Promise<Response> {
  const tenantId = options.tenantId ?? process.env.AZURE_FLUID_TENANT_ID;
  if (!tenantId) {
    throw new Error("createFluidTokenHandler requires tenantId or AZURE_FLUID_TENANT_ID");
  }

  return async (request: Request) => {
    const user = await options.user(request);
    const documentId = await readDocumentId(request);
    const provider = staticKeyTokenProvider(options.tenantKey, user);
    const token = await provider.fetchOrdererToken(tenantId, documentId);
    return Response.json(token);
  };
}

async function readDocumentId(request: Request): Promise<string | undefined> {
  const url = new URL(request.url);
  const fromQuery = url.searchParams.get("documentId");
  if (fromQuery) {
    return fromQuery;
  }
  try {
    const body = (await request.clone().json()) as { documentId?: unknown };
    return typeof body.documentId === "string" ? body.documentId : undefined;
  } catch {
    return undefined;
  }
}
