# google-health-mcp

A remote [MCP](https://modelcontextprotocol.io) server for the
[Google Health API](https://developers.google.com/health), the API behind Fitbit and Pixel Watch
data. It runs on Cloudflare Workers, signs you in with Google over OAuth, and gives any MCP
client read-only access to your activity, sleep, heart, body, nutrition and ECG data.

You deploy your own copy, with your own Google OAuth client, and decide which Google accounts may
connect. Nothing is written to your Google account.

## Tools

| Tool                | What it returns                                                                           |
| ------------------- | ----------------------------------------------------------------------------------------- |
| `get_profile`       | Profile (age, stride lengths, member since) and settings (time zone, UTC offset, units)   |
| `list_devices`      | Paired trackers and scales, with battery and last sync time                               |
| `get_data_points`   | Readings, sessions or daily values for one data type, newest first, merged across devices |
| `get_daily_summary` | Totals or statistics per local day, or per window of days                                 |
| `get_rollup`        | Totals or statistics per fixed window of time, such as hourly heart rate                  |

Each tool's `dataType` parameter lists only the
[data types](https://developers.google.com/health/data-types) its endpoint supports: steps,
distance, floors, calories, active zone minutes, exercise, sleep, heart rate, resting heart rate,
HRV, SpO2, respiratory rate, VO2 max, weight, body fat, height, blood glucose, body temperature,
sleep temperature variation, hydration and nutrition logs, foods, ECG and irregular rhythm
notifications. Write-only types (moods, symptoms, menstrual periods, ovulation tests) are left out.

Rollups span at most 90 days, or 14 days for `heart-rate`, `total-calories`,
`calories-in-heart-rate-zone` and `active-minutes`.

## How sign-in works

The Worker is the OAuth authorization server for MCP clients and an OAuth client of Google:

1. An MCP client connects to `/mcp`, gets a `401`, and discovers this server's OAuth metadata. It
   registers itself through a Client ID Metadata Document or dynamic client registration.
2. You see a consent page naming the client and where its tokens go, then Google's own consent
   screen for the read-only Google Health scopes.
3. If the Google account is in `ALLOWED_EMAILS`, the client gets its own token. Google's tokens stay
   encrypted in Workers KV and never reach the client. Any other account is refused and its Google
   access is revoked.
4. The MCP token expires with Google's access token. When the client refreshes, the Worker refreshes
   Google too. If you revoke the app in your Google account, the next refresh fails and the client
   has to sign in again.

Built with [`@cloudflare/workers-oauth-provider`](https://github.com/cloudflare/workers-oauth-provider)
and the [Agents SDK](https://developers.cloudflare.com/agents/) MCP handler.

## Setup

You need Node.js 24+, [pnpm](https://pnpm.io), a Cloudflare account and a Google Cloud project.
The Worker will be served at `https://google-health-mcp.<your-subdomain>.workers.dev`, where the
subdomain is your account's workers.dev subdomain (Workers & Pages in the Cloudflare dashboard).

### 1. Create the Google OAuth client

In the [Google Cloud console](https://console.cloud.google.com):

1. Create a project, or pick one, and enable the **Google Health API** in APIs & Services.
2. In **Google Auth Platform**, choose **Get started**, with **External** as the audience.
3. Under **Data Access**, add the read-only Google Health scopes (`.../auth/googlehealth.*.readonly`)
   and `openid` and `email`.
4. Under **Audience**, add your Google account as a test user, then choose **Publish app**. While the
   app is in testing, Google expires refresh tokens after 7 days and you would sign in again every
   week. A published but unverified app works for you and your test users, after a one-time
   "Google hasn't verified this app" warning.
5. Under **Clients**, create a **Web application** client with the authorized redirect URI
   `https://google-health-mcp.<your-subdomain>.workers.dev/callback`. Add
   `http://localhost:8788/callback` too for local development.

### 2. Fill in the secrets

```sh
pnpm install
cp .dev.vars.example .dev.vars
```

Set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` from the client, and `ALLOWED_EMAILS` to a
comma-separated list of the Google accounts that may connect, such as
`you@example.com,partner@example.com`. An empty list refuses everyone. The file is git-ignored and
also serves `pnpm dev`.

### 3. Deploy

```sh
pnpm exec wrangler login
pnpm exec wrangler deploy --secrets-file .dev.vars
```

The first deploy creates the `OAUTH_KV` namespace and uploads the secrets. Later deploys keep them,
so `pnpm run deploy` is enough; change one with `pnpm exec wrangler secret put <NAME>`. To deploy to
a specific account, set `CLOUDFLARE_ACCOUNT_ID`. On a custom domain, add its `/callback` URL to the
Google client as well.

To keep your own settings, such as a custom domain, out of a public fork, copy `wrangler.jsonc` to
the git-ignored `wrangler.local.jsonc`, add them there, and deploy with
`pnpm exec wrangler deploy -c wrangler.local.jsonc`:

```jsonc
"routes": [{ "pattern": "mcp.example.com", "custom_domain": true }],
"workers_dev": false,
```

Removing an account from `ALLOWED_EMAILS` ends its access within the hour, when its client next
refreshes.

### 4. Connect a client

Add `https://<your-worker>/mcp` as a remote MCP server in any client that supports MCP OAuth, such
as Claude (Settings → Connectors → Add custom connector), ChatGPT, Cursor or VS Code. The client
opens the consent page and Google sign-in the first time it connects.

## Google's rules for health data

Google treats most Google Health API scopes as
[restricted](https://developers.google.com/health/app-verification). Your own deployment can stay
unverified while it serves you and up to 100 users you add yourself. Opening it to the public needs
Google's OAuth app verification, an annual
[CASA](https://appdefensealliance.dev/casa) security assessment and an in-app health data
disclosure, and must follow the Google Health API Developer and User Data Policy.

## Development

```sh
pnpm dev                          # http://localhost:8788/mcp
pnpm test                         # Vitest in the Workers runtime, with Google faked
pnpm check                        # formatting, lint and types
pnpm types                        # regenerate worker-configuration.d.ts after editing wrangler.jsonc
```

| File                   | Role                                                                |
| ---------------------- | ------------------------------------------------------------------- |
| `src/index.ts`         | Worker entry: the OAuth provider, token refresh and the MCP handler |
| `src/auth.ts`          | Consent page, Google sign-in and the email allowlist                |
| `src/google-oauth.ts`  | Google's OAuth endpoints and the scopes requested                   |
| `src/google-health.ts` | Read-only Google Health API client                                  |
| `src/data-types.ts`    | Which data types each endpoint supports, and their time filters     |
| `src/tools.ts`         | The MCP tools                                                       |
| `src/pages.ts`         | Consent and error pages                                             |

## License

[MIT](LICENSE)
