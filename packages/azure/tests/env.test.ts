import { describe, expect, it } from "vitest";
import { azureRelayFromEnv, staticKeyTokenProvider } from "../src/index.ts";

describe("azureRelayFromEnv", () => {
  it("reads tenant and endpoint", () => {
    const provider = staticKeyTokenProvider("secret", { id: "user-1" });
    const config = azureRelayFromEnv(provider, {
      AZURE_FLUID_TENANT_ID: "tenant",
      AZURE_FLUID_ENDPOINT: "https://example.fluidrelay.azure.com",
    });
    expect(config.tenantId).toBe("tenant");
    expect(config.endpoint).toContain("fluidrelay");
  });

  it("explains that the relay is not started locally", () => {
    expect(() => azureRelayFromEnv(staticKeyTokenProvider("k", { id: "u" }), {})).toThrow(
      /provisioned in Azure/,
    );
  });
});
