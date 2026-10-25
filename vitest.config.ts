import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          GOOGLE_CLIENT_ID: "test-client",
          GOOGLE_CLIENT_SECRET: "test-secret",
          ALLOWED_EMAILS: "Allowed@Example.com, second@example.com",
        },
      },
    }),
  ],
});
