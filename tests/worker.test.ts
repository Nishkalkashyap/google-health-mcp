import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";

const origin = "https://health-mcp.example.com";
const redirectUri = "http://localhost:9999/callback";
const codeVerifier = "test-verifier-0123456789-0123456789-0123456789";

/** Sends a request to the Worker, as the runtime would. */
async function call(request: Request): Promise<Response> {
  const ctx = createExecutionContext();
  const incoming = new Request<unknown, IncomingRequestCfProperties>(request);
  const response = await worker.fetch(incoming, env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

/** A browser's cookies, enough for the consent and upstream binding cookies. */
class CookieJar {
  private readonly _cookies = new Map<string, string>();

  store(response: Response): void {
    for (const cookie of response.headers.getSetCookie()) {
      const [pair = ""] = cookie.split(";");
      const [name = "", value = ""] = pair.split("=");
      if (value) this._cookies.set(name, value);
      else this._cookies.delete(name);
    }
  }

  header(): string {
    return [...this._cookies].map(([name, value]) => `${name}=${value}`).join("; ");
  }
}

/** Google's OAuth and Health endpoints, answering for whichever account is signing in. */
class FakeGoogle {
  email = "allowed@example.com";
  refreshToken = "google-refresh";
  issued = 0;
  healthError: string | null = null;
  readonly revoked: string[] = [];
  readonly healthRequests: { url: string; method: string; body: string; auth: string | null }[] =
    [];

  async fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.href === "https://oauth2.googleapis.com/token") return this._token(request);
    if (url.href === "https://oauth2.googleapis.com/revoke") {
      const body = await request.formData();
      this.revoked.push(String(body.get("token")));
      return new Response(null, { status: 200 });
    }
    if (url.href === "https://openidconnect.googleapis.com/v1/userinfo") {
      return Response.json({ sub: "google-user-1", email: this.email, email_verified: true });
    }
    if (url.hostname === "health.googleapis.com") {
      this.healthRequests.push({
        url: url.href,
        method: request.method,
        body: await request.text(),
        auth: request.headers.get("Authorization"),
      });
      if (this.healthError) {
        return Response.json({ error: { message: this.healthError } }, { status: 403 });
      }
      return Response.json({ path: url.pathname });
    }
    throw new Error(`Unexpected fetch to ${url.href}`);
  }

  private async _token(request: Request): Promise<Response> {
    const body = await request.formData();
    if (body.get("client_id") !== "test-client" || body.get("client_secret") !== "test-secret") {
      return Response.json({ error: "invalid_client" }, { status: 401 });
    }
    if (
      body.get("grant_type") === "refresh_token" &&
      body.get("refresh_token") !== this.refreshToken
    ) {
      return Response.json({ error: "invalid_grant" }, { status: 400 });
    }
    this.issued++;
    return Response.json({
      access_token: `google-access-${this.issued}`,
      expires_in: 3600,
      ...(body.get("grant_type") === "authorization_code" && { refresh_token: this.refreshToken }),
    });
  }
}

let google: FakeGoogle;

beforeEach(() => {
  google = new FakeGoogle();
  vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => google.fetch(input, init));
});

const allowedEmails = env.ALLOWED_EMAILS;

afterEach(() => {
  vi.restoreAllMocks();
  env.ALLOWED_EMAILS = allowedEmails;
});

async function registerClient(): Promise<string> {
  const response = await call(
    new Request(`${origin}/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_name: "<script>Test</script>",
        redirect_uris: [redirectUri],
        token_endpoint_auth_method: "none",
      }),
    }),
  );
  const body: { client_id: string } = await response.json();
  return body.client_id;
}

async function challenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

/** Runs the browser part: consent page, approval, Google's redirect back to the callback. */
async function authorize(clientId: string): Promise<{ consent: string; callback: Response }> {
  const jar = new CookieJar();
  const authorizeUrl = new URL(`${origin}/authorize`);
  authorizeUrl.search = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    state: "client-state",
    code_challenge: await challenge(codeVerifier),
    code_challenge_method: "S256",
    resource: `${origin}/mcp`,
  }).toString();

  const page = await call(new Request(authorizeUrl));
  jar.store(page);
  const consent = await page.text();
  const handle = /name="handle" value="([^"]+)"/.exec(consent)?.[1] ?? "";

  const approved = await call(
    new Request(`${origin}/authorize`, {
      method: "POST",
      headers: { Cookie: jar.header(), "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ handle, decision: "approve" }),
    }),
  );
  jar.store(approved);
  const toGoogle = new URL(approved.headers.get("Location") ?? "");
  expect(toGoogle.origin).toBe("https://accounts.google.com");
  expect(toGoogle.searchParams.get("redirect_uri")).toBe(`${origin}/callback`);
  expect(toGoogle.searchParams.get("access_type")).toBe("offline");

  const callbackUrl = new URL(`${origin}/callback`);
  callbackUrl.searchParams.set("code", "google-code");
  callbackUrl.searchParams.set("state", toGoogle.searchParams.get("state") ?? "");
  const callback = await call(new Request(callbackUrl, { headers: { Cookie: jar.header() } }));
  return { consent, callback };
}

async function token(params: Record<string, string>): Promise<Response> {
  return call(
    new Request(`${origin}/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ ...params, resource: `${origin}/mcp` }),
    }),
  );
}

interface Tokens {
  access_token: string;
  refresh_token: string;
  expires_in: number;
}

async function signIn(clientId: string): Promise<Tokens> {
  const { callback } = await authorize(clientId);
  const back = new URL(callback.headers.get("Location") ?? "");
  expect(back.origin + back.pathname).toBe(redirectUri);
  const response = await token({
    grant_type: "authorization_code",
    code: back.searchParams.get("code") ?? "",
    client_id: clientId,
    redirect_uri: redirectUri,
    code_verifier: codeVerifier,
  });
  expect(response.status).toBe(200);
  return response.json();
}

async function mcpClient(
  accessToken: string,
  headers: Record<string, string> = {},
): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), {
    requestInit: { headers: { ...headers, Authorization: `Bearer ${accessToken}` } },
    fetch: (input, init) => call(new Request(input, init)),
  });
  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(transport);
  return client;
}

describe("discovery", () => {
  it("challenges unauthenticated MCP requests with the resource metadata", async () => {
    const response = await call(new Request(`${origin}/mcp`, { method: "POST", body: "{}" }));
    expect(response.status).toBe(401);
    expect(response.headers.get("WWW-Authenticate")).toContain(
      `resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`,
    );
  });

  it("binds tokens to the origin the request came in on", async () => {
    const response = await call(
      new Request("https://other.example.com/.well-known/oauth-protected-resource/mcp"),
    );
    const metadata: { resource: string } = await response.json();
    expect(metadata.resource).toBe("https://other.example.com/mcp");
  });
});

describe("sign-in", () => {
  it("escapes the client's self-registered name on the consent page", async () => {
    const { consent } = await authorize(await registerClient());
    expect(consent).toContain("&#60;script&#62;Test&#60;/script&#62;");
    expect(consent).not.toContain("<script>Test");
  });

  it("refuses an account outside ALLOWED_EMAILS and revokes its Google access", async () => {
    google.email = "stranger@example.com";
    const { callback } = await authorize(await registerClient());
    const back = new URL(callback.headers.get("Location") ?? "");
    expect(back.searchParams.get("error")).toBe("access_denied");
    expect(back.searchParams.get("state")).toBe("client-state");
    expect(back.searchParams.has("code")).toBe(false);
    expect(google.revoked).toEqual(["google-refresh"]);
  });

  it("issues an MCP token that expires with Google's access token", async () => {
    const tokens = await signIn(await registerClient());
    expect(tokens.expires_in).toBeGreaterThan(3400);
    expect(tokens.expires_in).toBeLessThanOrEqual(3540);
  });

  it("refreshes Google's access token when the client refreshes", async () => {
    const clientId = await registerClient();
    const first = await signIn(clientId);
    const refreshed = await token({
      grant_type: "refresh_token",
      refresh_token: first.refresh_token,
      client_id: clientId,
    });
    expect(refreshed.status).toBe(200);
    const tokens: Tokens = await refreshed.json();

    const client = await mcpClient(tokens.access_token);
    await client.callTool({ name: "list_devices", arguments: {} });
    expect(google.healthRequests.at(-1)?.auth).toBe("Bearer google-access-2");
  });

  it("revokes the grant once Google refuses the refresh token", async () => {
    const clientId = await registerClient();
    const first = await signIn(clientId);
    google.refreshToken = "rotated-elsewhere";
    const refreshed = await token({
      grant_type: "refresh_token",
      refresh_token: first.refresh_token,
      client_id: clientId,
    });
    expect(refreshed.status).toBe(400);
    const body: { error: string } = await refreshed.json();
    expect(body.error).toBe("invalid_grant");
  });

  it("stops refreshing once the account leaves ALLOWED_EMAILS", async () => {
    const clientId = await registerClient();
    const first = await signIn(clientId);
    env.ALLOWED_EMAILS = "someone-else@example.com";
    const refreshed = await token({
      grant_type: "refresh_token",
      refresh_token: first.refresh_token,
      client_id: clientId,
    });
    expect(refreshed.status).toBe(400);
    const body: { error: string } = await refreshed.json();
    expect(body.error).toBe("invalid_grant");
    // Only the code exchange reached Google; the refused refresh never did.
    expect(google.issued).toBe(1);
  });
});

describe("tools", () => {
  it("lists the read-only tools", async () => {
    const client = await mcpClient((await signIn(await registerClient())).access_token);
    const { tools } = await client.listTools();
    const names = tools.map((tool) => tool.name).sort();
    expect(names).toEqual([
      "get_daily_summary",
      "get_data_points",
      "get_profile",
      "get_rollup",
      "list_devices",
    ]);
    for (const tool of tools) expect(tool.annotations?.readOnlyHint).toBe(true);
  });

  it("serves browser-hosted clients on other origins", async () => {
    const tokens = await signIn(await registerClient());
    const client = await mcpClient(tokens.access_token, {
      Origin: "https://web-client.example.net",
    });
    const { tools } = await client.listTools();
    expect(tools.length).toBeGreaterThan(0);
  });

  it("reads reconciled points with a civil time filter", async () => {
    const client = await mcpClient((await signIn(await registerClient())).access_token);
    await client.callTool({
      name: "get_data_points",
      arguments: { dataType: "steps", start: "2026-10-01", end: "2026-10-02" },
    });
    const request = new URL(google.healthRequests.at(-1)?.url ?? "");
    expect(request.pathname).toBe("/v4/users/me/dataTypes/steps/dataPoints:reconcile");
    expect(request.searchParams.get("filter")).toBe(
      'steps.interval.civil_start_time >= "2026-10-01" AND steps.interval.civil_start_time < "2026-10-02"',
    );
    expect(request.searchParams.get("pageSize")).toBe("100");
  });

  it("asks for whole days with an inclusive last day", async () => {
    const client = await mcpClient((await signIn(await registerClient())).access_token);
    await client.callTool({
      name: "get_daily_summary",
      arguments: { dataType: "steps", startDate: "2026-10-01", endDate: "2026-10-31" },
    });
    const request = google.healthRequests.at(-1);
    expect(request?.method).toBe("POST");
    expect(JSON.parse(request?.body ?? "{}")).toMatchObject({
      range: {
        start: { date: { year: 2026, month: 10, day: 1 } },
        end: { date: { year: 2026, month: 11, day: 1 } },
      },
      windowSizeDays: 1,
    });
  });

  it("rolls up windows of physical time", async () => {
    const client = await mcpClient((await signIn(await registerClient())).access_token);
    await client.callTool({
      name: "get_rollup",
      arguments: {
        dataType: "heart-rate",
        startTime: "2026-10-01T00:00:00+05:30",
        endTime: "2026-10-02T00:00:00+05:30",
        windowMinutes: 60,
      },
    });
    const request = google.healthRequests.at(-1);
    expect(new URL(request?.url ?? "").pathname).toBe(
      "/v4/users/me/dataTypes/heart-rate/dataPoints:rollUp",
    );
    expect(JSON.parse(request?.body ?? "{}")).toMatchObject({
      range: { startTime: "2026-10-01T00:00:00+05:30", endTime: "2026-10-02T00:00:00+05:30" },
      windowSize: "3600s",
    });
  });

  it("returns Google's error message to the model", async () => {
    const client = await mcpClient((await signIn(await registerClient())).access_token);
    google.healthError = "Request had insufficient authentication scopes.";
    const result = await client.callTool({ name: "get_profile", arguments: {} });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("insufficient authentication scopes");
  });

  it("rejects a data type the tool's method does not support", async () => {
    const client = await mcpClient((await signIn(await registerClient())).access_token);
    const result = await client.callTool({
      name: "get_daily_summary",
      arguments: { dataType: "sleep", startDate: "2026-10-01", endDate: "2026-10-02" },
    });
    expect(result.isError).toBe(true);
    expect(google.healthRequests).toHaveLength(0);
  });
});
