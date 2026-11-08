import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // Relative asset paths let the same build run from a static host and from
  // Electron's file:// origin.
  base: "./",
  plugins: [react()],
  worker: { format: "es" },
  test: { include: ["src/**/*.test.ts"], testTimeout: 60000 },
});
