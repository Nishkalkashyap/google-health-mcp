import { OAuthError } from "@cloudflare/workers-oauth-provider";
import { z } from "zod";

const authorizeUrl = "https://accounts.google.com/o/oauth2/v2/auth";
const tokenUrl = "https://oauth2.googleapis.com/token";
const revokeUrl = "https://oauth2.googleapis.com/revoke";
const userInfoUrl = "https://openidconnect.googleapis.com/v1/userinfo";

/** Every read-only Google Health scope, plus the identity needed to check the allowlist. */
export const googleScopes = [
  "openid",
  "email",
  ...[
    "activity_and_fitness",
    "health_metrics_and_measurements",
    "sleep",
    "nutrition",
    "ecg",
    "irn",
    "location",
    "reproductive_health",
    "logged_symptoms",
    "mindfulness",
    "profile",
    "settings",
  ].map((scope) => `https://www.googleapis.com/auth/googlehealth.${scope}.readonly`),
];

/** What each grant and access token carries, encrypted by the OAuth provider. */
export const googleProps = z.object({
  email: z.string(),
  accessToken: z.string(),
  refreshToken: z.string(),
  /** Epoch seconds when `accessToken` expires. */
  expiresAt: z.number(),
});
export type GoogleProps = z.infer<typeof googleProps>;

const tokenResponse = z.object({
  access_token: z.string(),
  expires_in: z.number(),
  refresh_token: z.string().optional(),
});

const tokenError = z.object({ error: z.string() });

const userInfo = z.object({
  sub: z.string(),
  email: z.string(),
  email_verified: z.boolean(),
});

/** Google's OAuth endpoints, called with this deployment's client credentials. */
export class GoogleOAuth {
  constructor(
    private readonly _clientId: string,
    private readonly _clientSecret: string,
  ) {}

  /** Offline access with forced consent, so Google always returns a refresh token. */
  authorizeUrl(options: { redirectUri: string; state: string; codeChallenge: string }): string {
    const url = new URL(authorizeUrl);
    url.searchParams.set("client_id", this._clientId);
    url.searchParams.set("redirect_uri", options.redirectUri);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", googleScopes.join(" "));
    url.searchParams.set("state", options.state);
    url.searchParams.set("code_challenge", options.codeChallenge);
    url.searchParams.set("code_challenge_method", "S256");
    url.searchParams.set("access_type", "offline");
    url.searchParams.set("prompt", "consent");
    return url.href;
  }

  /** Exchanges the callback's code and reads who signed in. */
  async signIn(options: {
    code: string;
    codeVerifier: string;
    redirectUri: string;
  }): Promise<{ userId: string; emailVerified: boolean; props: GoogleProps }> {
    const response = await this._token({
      grant_type: "authorization_code",
      code: options.code,
      code_verifier: options.codeVerifier,
      redirect_uri: options.redirectUri,
    });
    if (!response.ok) throw new Error(`Google code exchange failed: ${await response.text()}`);
    const tokens = tokenResponse.parse(await response.json());
    if (!tokens.refresh_token) throw new Error("Google returned no refresh token");

    const user = await this._userInfo(tokens.access_token);
    return {
      userId: user.sub,
      emailVerified: user.email_verified,
      props: {
        email: user.email.toLowerCase(),
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
        expiresAt: GoogleOAuth._expiresAt(tokens.expires_in),
      },
    };
  }

  /**
   * Gets a fresh access token. A refused refresh token means the user revoked access, so it
   * throws `invalid_grant`, which makes the provider revoke the grant and the client sign in again.
   */
  async refresh(props: GoogleProps): Promise<GoogleProps> {
    const response = await this._token({
      grant_type: "refresh_token",
      refresh_token: props.refreshToken,
    });
    if (!response.ok) {
      const failure = tokenError.safeParse(await response.json().catch(() => null));
      if (failure.success && failure.data.error === "invalid_grant") {
        throw new OAuthError("invalid_grant", { description: "Google access was revoked" });
      }
      console.error("Google token refresh failed", { status: response.status, email: props.email });
      throw new OAuthError("temporarily_unavailable", {
        description: "Google is unavailable",
        statusCode: 503,
      });
    }
    const tokens = tokenResponse.parse(await response.json());
    return {
      ...props,
      accessToken: tokens.access_token,
      // Google usually keeps the refresh token; use a rotated one when it sends one.
      refreshToken: tokens.refresh_token ?? props.refreshToken,
      expiresAt: GoogleOAuth._expiresAt(tokens.expires_in),
    };
  }

  /** Revokes the whole Google grant, for accounts this deployment refuses. */
  async revoke(token: string): Promise<void> {
    await fetch(revokeUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token }),
    });
  }

  private _token(params: Record<string, string>): Promise<Response> {
    return fetch(tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        ...params,
        client_id: this._clientId,
        client_secret: this._clientSecret,
      }),
    });
  }

  private async _userInfo(accessToken: string): Promise<z.infer<typeof userInfo>> {
    const response = await fetch(userInfoUrl, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!response.ok) throw new Error(`Google user info failed: ${response.status}`);
    return userInfo.parse(await response.json());
  }

  private static _expiresAt(expiresIn: number): number {
    return Math.floor(Date.now() / 1000) + expiresIn;
  }
}
