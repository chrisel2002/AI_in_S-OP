import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // forward API calls to the Express backend during development
    proxy: { "/api": "http://localhost:4000" },
  },
});
