import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

export default defineConfig({
  plugins: [vue()],
  server: {
    port: 5173,
    host: "127.0.0.1",
    proxy: {
      "/api": "http://127.0.0.1:5174",
      "/ws": { target: "ws://127.0.0.1:5174", ws: true },
      // Login/logout/callback are served by the backend.
      "/auth": "http://127.0.0.1:5174",
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
