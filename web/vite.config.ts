import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The UI only talks to /api; the dev server forwards it to the Deno API.
export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 5180,
    strictPort: true,
    proxy: { "/api": "http://127.0.0.1:8787" },
  },
});
