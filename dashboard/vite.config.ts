import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@agent-town/shared": resolve(__dirname, "../shared/src/index.ts"),
    },
  },
  server: {
    proxy: {
      "/api": "http://localhost:4680",
      "/ws": {
        target: "ws://localhost:4680",
        ws: true,
      },
    },
  },
});
