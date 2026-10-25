import {
  AuthorizationError,
  CimdFetchError,
  authorizationErrorRedirect,
  type OAuthHelpers,
} from "@cloudflare/workers-oauth-provider";
import { GoogleOAuth } from "./google-oauth";
import { consentPage, errorPage } from "./pages";

/** What `beginUpstream()` keeps for the Google callback; never sent to Google. */
interface UpstreamData {
  codeVerifier: string;
}

/**
 * Signs MCP clients in through Google: consent for the client, then Google's own consent, then
 * the allowlist. Requests to `/mcp` with a valid token never reach this handler.
 */
export class AuthHandler {
  private readonly _google: GoogleOAuth;

  constructor(
    private readonly _env: Env,
    private readonly _oauth: OAuthHelpers,
  ) {
    this._google = new GoogleOAuth(_env.GOOGLE_CLIENT_ID, _env.GOOGLE_CLIENT_SECRET);
  }

  async route(request: Request): Promise<Response> {
    const { pathname } = new URL(request.url);
    try {
      switch (`${request.method} ${pathname}`) {
        case "GET /authorize":
          return await this._showConsent(request);
        case "POST /authorize":
          return await this._decide(request);
        case "GET /callback":
          return await this._callback(request);
        default:
          return new Response("Not found", { status: 404 });
      }
    } catch (error) {
      return AuthHandler._failure(error);
    }
  }

  /** Every client gets a consent page first, so no client can borrow this server's Google app. */
  private async _showConsent(request: Request): Promise<Response> {
    const authRequest = await this._oauth.parseAuthRequest(request);
    // Describe first: a client whose metadata cannot be fetched leaves nothing in KV.
    const details = await this._oauth.describeConsent(authRequest);
    const consent = await this._oauth.beginConsent(authRequest);
    consent.headers.set("Content-Type", "text/html; charset=utf-8");
    return new Response(consentPage(details, consent.handle), { headers: consent.headers });
  }

  private async _decide(request: Request): Promise<Response> {
    const form = await request.formData();
    const handle = String(form.get("handle"));
    if (form.get("decision") !== "approve") {
      const denied = await this._oauth.denyConsent(request, handle);
      return new Response(null, { status: 302, headers: denied.headers });
    }

    const approved = await this._oauth.approveConsent(request, handle);
    // PKCE between this Worker and Google; the verifier stays server-side until the callback.
    const codeVerifier = `${crypto.randomUUID()}${crypto.randomUUID()}`;
    const upstream = await this._oauth.beginUpstream(approved.request, {
      data: { codeVerifier } satisfies UpstreamData,
      headers: approved.headers,
    });
    const location = this._google.authorizeUrl({
      redirectUri: AuthHandler._callbackUrl(request),
      state: upstream.state,
      codeChallenge: await AuthHandler._challenge(codeVerifier),
    });
    upstream.headers.set("Location", location);
    return new Response(null, { status: 302, headers: upstream.headers });
  }

  private async _callback(request: Request): Promise<Response> {
    const resumed = await this._oauth.finishUpstream<UpstreamData>(request);
    const params = new URL(request.url).searchParams;
    const code = params.get("code");
    // The user declined at Google, or Google failed: tell the client, not just this browser.
    if (params.get("error") || !code) {
      return AuthHandler._redirect(
        authorizationErrorRedirect(resumed.request, "access_denied"),
        resumed.headers,
      );
    }

    const google = await this._google.signIn({
      code,
      codeVerifier: resumed.data.codeVerifier,
      redirectUri: AuthHandler._callbackUrl(request),
    });
    if (!google.emailVerified || !this._allowedEmails().has(google.props.email)) {
      // Leave no Google access behind for an account this deployment refuses.
      await this._google.revoke(google.props.refreshToken);
      const description = `${google.props.email} is not allowed to use this server`;
      return AuthHandler._redirect(
        authorizationErrorRedirect(resumed.request, "access_denied", description),
        resumed.headers,
      );
    }

    const { redirectTo } = await this._oauth.completeAuthorization({
      request: resumed.request,
      userId: google.userId,
      metadata: { email: google.props.email },
      scope: resumed.request.scope,
      props: google.props,
    });
    return AuthHandler._redirect(redirectTo, resumed.headers);
  }

  /** `ALLOWED_EMAILS` is comma-separated; an empty list refuses everyone. */
  private _allowedEmails(): Set<string> {
    const emails = new Set<string>();
    for (const email of this._env.ALLOWED_EMAILS.split(",")) {
      const normalized = email.trim().toLowerCase();
      if (normalized) emails.add(normalized);
    }
    return emails;
  }

  private static _callbackUrl(request: Request): string {
    return new URL("/callback", request.url).href;
  }

  private static async _challenge(verifier: string): Promise<string> {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
    // PKCE uses unpadded base64url.
    return btoa(String.fromCharCode(...new Uint8Array(digest)))
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replace(/=+$/, "");
  }

  private static _redirect(location: string, headers: Headers): Response {
    headers.set("Location", location);
    return new Response(null, { status: 302, headers });
  }

  /** Only a validated client and redirect URI may receive an error redirect; render the rest. */
  private static _failure(error: unknown): Response {
    if (error instanceof AuthorizationError) {
      if (error.redirectTo) return Response.redirect(error.redirectTo, 302);
      return errorPage(error.description, 400);
    }
    if (error instanceof CimdFetchError) {
      return errorPage("This app's metadata could not be verified.", 400);
    }
    console.error("Authorization failed", error);
    return errorPage("Something went wrong while connecting. Try again.", 500);
  }
}
