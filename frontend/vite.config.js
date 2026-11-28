
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, root, "VITE_");

  const backend = env.VITE_BACKEND_URL || "http://localhost:5000";

  return {
    plugins: [react()],

    resolve: {
      alias: [
        {
          find: /^monaco-editor\/esm\/vs\/(.*)$/,
          replacement: path.resolve(
            root,
            "node_modules/monaco-editor/esm/vs/$1"
          )
        }
      ]
    },

    optimizeDeps: {
      include: ["monaco-editor"]
    },

    build: {
      sourcemap: false,
      rollupOptions: {
        treeshake: {
          moduleSideEffects(id, external) {
            if (external) return true;
            const normalizedId = id.replaceAll("\\", "/");
            const languageRegistration = normalizedId.match(
              /\/monaco-editor\/esm\/vs\/languages\/definitions\/([^/]+)\/register\.js$/
            );
            if (!languageRegistration) return true;
            return ["cpp", "go", "java", "javascript", "python", "typescript"]
              .includes(languageRegistration[1]);
          }
        }
      }
    },

    server: {
      host: "0.0.0.0", // Important
      port: 5713,
      strictPort: true,

      proxy: {
        "/api": {
          target: backend,
          changeOrigin: true,
          secure: true
        },
        "/socket.io": {
          target: backend,
          ws: true,
          changeOrigin: true,
          secure: true
        }
      }
    }
  };
});
