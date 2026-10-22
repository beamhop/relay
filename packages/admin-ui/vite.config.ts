import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import { VitePWA } from "vite-plugin-pwa";
import { fileURLToPath } from "node:url";

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  base: "/admin/",
  resolve: {
    alias: {
      "@beamhop/sdk-config": r("../sdk/src/config.ts"),
      "@": r("./src"),
    },
  },
  plugins: [
    tanstackRouter({ target: "react", autoCodeSplitting: true, routesDirectory: "./src/routes", generatedRouteTree: "./src/routeTree.gen.ts" }),
    react(),
    tailwindcss(),
    VitePWA({
      strategies: "injectManifest",
      srcDir: "src",
      filename: "sw.ts",
      base: "/admin/",
      scope: "/admin/",
      injectRegister: false,
      registerType: "autoUpdate",
      includeAssets: ["favicon.svg", "icons/*.png", "offline.html", "plugin-shims/*.js"],
      injectManifest: {
        globPatterns: ["**/*.{js,css,html,svg,png,woff2}"],
        globIgnores: ["**/plugin-shims/**", "**/world-map-*"],
        maximumFileSizeToCacheInBytes: 4 * 1024 * 1024,
      },
      manifest: {
        name: "beamhop admin",
        short_name: "beamhop",
        description: "Admin panel for the beamhop nostr relay & blossom server",
        start_url: "/admin/",
        scope: "/admin/",
        display: "standalone",
        orientation: "any",
        background_color: "#18181b",
        theme_color: "#7c3aed",
        icons: [
          { src: "icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
          { src: "icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
          { src: "icons/maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
          { src: "favicon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
        ],
      },
      devOptions: { enabled: false, type: "module" },
    }),
  ],
  server: {
    port: 5173,
    proxy: {
      "/admin/api": { target: "http://localhost:3334", changeOrigin: false, ws: true },
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    chunkSizeWarningLimit: 1200,
    sourcemap: false,
  },
});
