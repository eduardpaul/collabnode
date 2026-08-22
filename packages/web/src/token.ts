import type { AzureTokenProvider, AzureTokenResponse } from "./options.js";

/**
 * Browser token provider: POST `{ tenantId, documentId }` to your Node route
 * mounted with `createFluidTokenHandler`.
 */
export function httpTokenProvider(url: string, headers?: HeadersInit): AzureTokenProvider {
  const fetchToken = async (tenantId: string, documentId?: string): Promise<AzureTokenResponse> => {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headersInit(headers) },
      body: JSON.stringify({ tenantId, documentId }),
    });
    if (!response.ok) {
      throw new Error(`fluid token request failed: ${response.status}`);
    }
    const body = (await response.json()) as { jwt?: unknown };
    if (typeof body.jwt !== "string" || body.jwt.length === 0) {
      throw new Error("fluid token response missing jwt");
    }
    return { jwt: body.jwt };
  };
  return {
    fetchOrdererToken: fetchToken,
    fetchStorageToken: fetchToken,
  };
}

function headersInit(headers: HeadersInit | undefined): Record<string, string> {
  if (!headers) {
    return {};
  }
  if (headers instanceof Headers) {
    return Object.fromEntries(headers.entries());
  }
  if (Array.isArray(headers)) {
    return Object.fromEntries(headers);
  }
  return { ...headers };
}
