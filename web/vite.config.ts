import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const apiTarget = process.env.WEB_API_PROXY_TARGET ?? "http://127.0.0.1:3000";

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/api": {
        target: apiTarget,
        changeOrigin: false,
      },
      "/browser-live-view": {
        target: apiTarget,
        changeOrigin: false,
        ws: true,
      },
    },
  },
});
