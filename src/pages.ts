import type { ConsentDescription } from "@cloudflare/workers-oauth-provider";

/** Client names and URLs come from dynamic registration or a metadata document: escape all of it. */
function escape(value: string): string {
  return value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

function layout(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(title)}</title>
<style>
  body { font: 16px/1.5 system-ui, sans-serif; max-width: 34rem; margin: 3rem auto; padding: 0 1rem; color: #1f2328; }
  h1 { font-size: 1.4rem; }
  .note { background: #fff8c5; border: 1px solid #d4a72c; border-radius: 6px; padding: .75rem 1rem; }
  .actions { display: flex; gap: .75rem; margin-top: 1.5rem; }
  button { font: inherit; padding: .5rem 1.25rem; border-radius: 6px; border: 1px solid #d0d7de; background: #f6f8fa; cursor: pointer; }
  button[value="approve"] { background: #1f883d; border-color: #1f883d; color: #fff; }
</style>
<body>
${body}
</body>
</html>`;
}

/** The consent page MCP requires before signing in through Google on a client's behalf. */
export function consentPage(details: ConsentDescription, handle: string): string {
  const name = escape(details.clientName);
  const origin = details.clientDomain
    ? `Published by <strong>${escape(details.clientDomain)}</strong>.`
    : "This app registered itself, so its name is not verified.";
  const loopback = details.redirectIsLoopback
    ? `<p class="note"><strong>This sends access to an app on your computer.</strong> Continue only if you just started connecting from it.</p>`
    : "";

  return layout(
    `Connect ${details.clientName} to Google Health`,
    `<h1>Allow ${name} to read your Google Health data?</h1>
<p>${origin} Access will be sent to <strong>${escape(details.redirectHost)}</strong>.</p>
${loopback}
<p>After you allow it, Google asks you to sign in and approve read-only access to your activity, sleep, heart, body, nutrition, ECG and device data. Nothing is written to your account.</p>
<form method="post">
  <input type="hidden" name="handle" value="${escape(handle)}">
  <div class="actions">
    <button name="decision" value="approve">Allow</button>
    <button name="decision" value="deny">Deny</button>
  </div>
</form>`,
  );
}

/** A local error page, for failures where redirecting back to the client is not safe. */
export function errorPage(message: string, status: number): Response {
  const html = layout("Cannot connect", `<h1>Cannot connect</h1><p>${escape(message)}</p>`);
  return new Response(html, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}
