import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

const frontendRoot = path.dirname(fileURLToPath(import.meta.url));

// In development the browser talks to Vite on port 5173. Vite forwards
// /api and /socket.io to the backend on port 5000.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, frontendRoot, "VITE_");
  const backendEnv = loadEnv(mode, path.resolve(frontendRoot, "../backend"), "");
  const backendPort = process.env.PORT || backendEnv.PORT || 5000;
  const backend = process.env.VITE_BACKEND_URL
    || env.VITE_BACKEND_URL
    || `https://chatapp-splc.onrender.com${backendPort}`;

  return {
    plugins: [react()],
    resolve: {
      alias: [
        { find: /^monaco-editor\/esm\/vs\/(.*)$/, replacement: "monaco-editor/$1" }
      ]
    },
    server: {
      port: 5173,
      strictPort: true,
      proxy: {
        "/api": { target: backend, changeOrigin: true },
        "/socket.io": { target: backend, ws: true, changeOrigin: true }
      }
    }
  };
});
