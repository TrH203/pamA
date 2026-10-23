import { resolve } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Three entries: the public Ask Link page, the owner console and the desktop popup views.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    rollupOptions: {
      input: {
        ask: resolve(import.meta.dirname, "ask.html"),
        console: resolve(import.meta.dirname, "console.html"),
        desktop: resolve(import.meta.dirname, "desktop.html"),
      },
    },
  },
  server: { proxy: { "/v1": "http://127.0.0.1:7465", "/a": "http://127.0.0.1:7465" } },
});
