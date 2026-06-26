import { defineConfig } from "@lovable.dev/vite-tanstack-config";

export default defineConfig({
  tanstackStart: {
    server: { entry: "server" },
  },
  // Force-enable Nitro deploy plugin for Cloudflare Pages
  nitro: {
    preset: "cloudflare-pages",
  },
});
