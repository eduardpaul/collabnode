import type { AzureTokenProvider, AzureTokenResponse } from "./options.js";

export interface HttpTokenProviderOptions {
  headers?: HeadersInit;
  /**
   * Who this browser says it is, sent alongside the document id. Exactly as
   * trustworthy as anything else a browser sends: the route decides what to do
   * with it, and a real deployment resolves the user from a session or a bearer
   * token instead.
   */
  actorId?: string;
}

/**
 * Browser token provider: POST `{ tenantId, documentId, actorId }` to your Node
 * route mounted with `createFluidTokenHandler`.
 */
export function httpTokenProvider(
  url: string,
  options: HeadersInit | HttpTokenProviderOptions = {},
): AzureTokenProvider {
  const settings: HttpTokenProviderOptions = isProviderOptions(options)
    ? options
    : { headers: options };
  const fetchToken = async (tenantId: string, documentId?: string): Promise<AzureTokenResponse> => {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headersInit(settings.headers) },
      body: JSON.stringify({
        tenantId,
        documentId,
        ...(settings.actorId !== undefined ? { actorId: settings.actorId } : {}),
      }),
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

/** Distinguishes the options object from the `HeadersInit` this used to take. */
function isProviderOptions(
  value: HeadersInit | HttpTokenProviderOptions,
): value is HttpTokenProviderOptions {
  if (value instanceof Headers || Array.isArray(value)) {
    return false;
  }
  return "headers" in value || "actorId" in value || Object.keys(value).length === 0;
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
