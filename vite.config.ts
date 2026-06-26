import { defineConfig } from "@lovable.dev/vite-tanstack-config";

export default defineConfig({
  tanstackStart: {
    server: { entry: "server" },
  },
  // Force-enable Nitro deploy plugin (default: cloudflare-module preset)
  // Required for production builds outside the Lovable sandbox.
  nitro: {
    preset: "cloudflare-module",
  },
});
