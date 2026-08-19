// From "vitest/config", not "vite": the `test` block below is a Vitest key,
// and Vite's own `defineConfig` rejects it.
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // Tauri expects a fixed port and fails if it is taken.
  server: { port: 1420, strictPort: true },
  build: { target: "safari15", sourcemap: true },
  test: {
    environment: "jsdom",
    globals: true,
    coverage: { provider: "v8", reporter: ["text", "json-summary"] },
  },
});
