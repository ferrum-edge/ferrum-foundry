import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";
import { resolveViteDevServer } from "./src/lib/viteDevServer.ts";

const { host, port, proxyTarget } = resolveViteDevServer(process.env);

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "src"),
    },
  },
  server: {
    host,
    port,
    proxy: {
      // Match only /api/ (with slash) so SPA routes like /api-specs are
      // served by the router rather than proxied to the BFF.
      "^/api/": {
        target: proxyTarget,
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: "dist",
    sourcemap: false,
  },
});
