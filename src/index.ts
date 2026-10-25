import {
  OAuthError,
  OAuthProvider,
  getOAuthApi,
  type OAuthProviderOptions,
} from "@cloudflare/workers-oauth-provider";
import { createMcpHandler, getMcpAuthContext } from "agents/mcp/server";
import { AuthHandler, isAllowedEmail } from "./auth";
import { GoogleOAuth, googleProps } from "./google-oauth";
import { createServer } from "./tools";

const day = 24 * 60 * 60;

// A fresh MCP server per request, reading Google Health with the token's own Google access.
const mcpHandler = createMcpHandler(
  () => {
    const props = googleProps.parse(getMcpAuthContext()?.props);
    return createServer(props.accessToken);
  },
  // Every request carries a bearer token rather than a cookie, so a page on another origin cannot
  // act for the user; accept browser-hosted clients from any origin.
  { allowedOriginHostnames: "*" },
);

/**
 * The provider binds tokens to the canonical `/mcp` URL, which is only known from the request,
 * so one provider is built per origin the Worker is served on.
 */
function createProvider(origin: string): OAuthProvider<Env> {
  const options: OAuthProviderOptions<Env> = {
    apiRoute: "/mcp",
    apiHandler: { fetch: mcpHandler },
    // Helpers from this origin's own options: the provider caches the first helpers it builds on
    // `env`, which every origin shares.
    defaultHandler: {
      fetch: (request, env) => new AuthHandler(env, getOAuthApi(options, env)).route(request),
    },
    authorizeEndpoint: "/authorize",
    tokenEndpoint: "/token",
    clientRegistrationEndpoint: "/register",
    clientIdMetadataDocumentEnabled: true,
    resourceMetadata: { resource: `${origin}/mcp`, resource_name: "Google Health" },
    // A grant lives while its client keeps refreshing at least monthly.
    refreshTokenTTL: 30 * day,
    refreshTokenIdleTTL: 30 * day,
    tokenExchangeCallback: async ({ grantType, props, env }) => {
      const current = googleProps.parse(props);
      // Removing an account from ALLOWED_EMAILS ends its grants at their next refresh.
      if (grantType === "refresh_token" && !isAllowedEmail(env, current.email)) {
        throw new OAuthError("invalid_grant", { description: "This account is no longer allowed" });
      }
      // Each MCP refresh also refreshes Google, so the MCP token expires with Google's.
      const google =
        grantType === "refresh_token"
          ? await new GoogleOAuth(env.GOOGLE_CLIENT_ID, env.GOOGLE_CLIENT_SECRET).refresh(current)
          : current;
      const secondsLeft = google.expiresAt - Math.floor(Date.now() / 1000);
      return { newProps: google, accessTokenTTL: Math.max(60, secondsLeft - 60) };
    },
  };
  return new OAuthProvider(options);
}

const providers = new Map<string, OAuthProvider<Env>>();

export default {
  fetch(request, env, ctx) {
    const origin = new URL(request.url).origin;
    let provider = providers.get(origin);
    if (!provider) {
      provider = createProvider(origin);
      providers.set(origin, provider);
    }
    return provider.fetch(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
