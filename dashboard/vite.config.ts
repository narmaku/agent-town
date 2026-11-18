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
      // The server binds 127.0.0.1 by default; "localhost" may resolve to ::1
      "/api": "http://127.0.0.1:4680",
      "/ws": {
        target: "ws://127.0.0.1:4680",
        ws: true,
      },
    },
  },
});
