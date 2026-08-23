import { createHmac, randomUUID } from "node:crypto";

/**
 * Azure Fluid Relay token minting.
 *
 * The relay accepts an HS256 JWT signed with the tenant's primary or secondary
 * key, carrying the claim set below. There is no anonymous mode and no
 * `alg: none` mode: an unsigned token is rejected at the orderer, so this file
 * is what separates "connects to Azure" from "connects to Tinylicious".
 *
 * The claim names are fixed by the service, not by us — `documentId`, `scopes`,
 * `tenantId`, `user`, `iat`, `exp`, `ver`, `jti` — and mirror what
 * `@fluidframework/azure-service-utils` produces.
 */

export type AzureFluidScope = "doc:read" | "doc:write" | "summary:write";

export interface AzureFluidUser {
  id: string;
  name?: string;
  /** Anything else the app wants readable in presence; the relay passes it through. */
  additionalDetails?: Record<string, unknown>;
}

export interface AzureTokenOptions {
  /** Defaults to read + write + summary:write, which is what a full peer needs. */
  scopes?: readonly AzureFluidScope[];
  /** Token lifetime. Short on purpose: the client re-fetches on expiry. */
  lifetimeSeconds?: number;
}

export const DEFAULT_AZURE_SCOPES: readonly AzureFluidScope[] = [
  "doc:read",
  "doc:write",
  "summary:write",
];

/** One hour, matching the Azure default. */
export const DEFAULT_TOKEN_LIFETIME_SECONDS = 3600;

export interface SignAzureFluidTokenInput extends AzureTokenOptions {
  /** Tenant primary or secondary key. Server-side only — never ship it to a browser. */
  key: string;
  tenantId: string;
  /**
   * Absent while creating a container: the id does not exist until `attach()`
   * returns, and the relay accepts an empty `documentId` for that one call.
   */
  documentId?: string;
  user: AzureFluidUser;
}

export function signAzureFluidToken(input: SignAzureFluidTokenInput): string {
  if (!input.key || input.key.trim().length === 0) {
    throw new Error(
      "Azure Fluid Relay tenant key is required to mint a token (AZURE_FLUID_KEY). The relay rejects unsigned tokens.",
    );
  }
  if (!input.tenantId || input.tenantId.trim().length === 0) {
    throw new Error("Azure Fluid Relay tenantId is required to mint a token (AZURE_FLUID_TENANT_ID)");
  }
  if (!input.user?.id) {
    throw new Error("Azure Fluid Relay token requires a user with an id");
  }

  const issuedAt = Math.floor(Date.now() / 1000);
  const lifetime = input.lifetimeSeconds ?? DEFAULT_TOKEN_LIFETIME_SECONDS;

  const header = { alg: "HS256", typ: "JWT" };
  const payload = {
    documentId: input.documentId ?? "",
    scopes: [...(input.scopes ?? DEFAULT_AZURE_SCOPES)],
    tenantId: input.tenantId,
    user: {
      id: input.user.id,
      name: input.user.name ?? input.user.id,
      ...(input.user.additionalDetails ? { additionalDetails: input.user.additionalDetails } : {}),
    },
    iat: issuedAt,
    exp: issuedAt + lifetime,
    ver: "1.0",
    // The relay tracks jti to reject replays; a fresh one per token is required.
    jti: randomUUID(),
  };

  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`;
  const signature = createHmac("sha256", input.key).update(signingInput).digest("base64url");
  return `${signingInput}.${signature}`;
}

function base64url(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}
