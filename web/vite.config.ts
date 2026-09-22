import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const appTarget = process.env.WEB_API_PROXY_TARGET ?? "http://127.0.0.1:3000";

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/api": {
        target: appTarget,
        changeOrigin: false,
      },
      "/browser-live-view": {
        target: appTarget,
        changeOrigin: false,
        ws: true,
      },
    },
  },
});
