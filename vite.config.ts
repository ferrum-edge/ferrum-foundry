import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";
import { resolveViteDevServer } from "./src/lib/viteDevServer.ts";
import { CSP_NONCE_PLACEHOLDER } from "./shared/csp-nonce.js";

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
  // Every script, style and link tag in the built shell carries this
  // placeholder as its nonce, plus a <meta property="csp-nonce"> the app reads
  // at startup. The BFF swaps in a per-response nonce (issue #594).
  html: {
    cspNonce: CSP_NONCE_PLACEHOLDER,
  },
  build: {
    outDir: "dist",
    sourcemap: false,
  },
});
