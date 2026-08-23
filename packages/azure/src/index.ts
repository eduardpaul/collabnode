export {
  AzureFluidCollabBackend,
  azureOpen,
  azureRelayFromEnv,
  staticKeyTokenProvider,
  type AzureRelayConfig,
  type AzureRelayFromEnvOptions,
  type AzureTokenProvider,
  type AzureTokenResponse,
} from "./backend.js";
export {
  DEFAULT_AZURE_SCOPES,
  DEFAULT_TOKEN_LIFETIME_SECONDS,
  signAzureFluidToken,
  type AzureFluidScope,
  type AzureFluidUser,
  type AzureTokenOptions,
  type SignAzureFluidTokenInput,
} from "./token.js";
