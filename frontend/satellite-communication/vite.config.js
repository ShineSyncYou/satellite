import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import vueDevTools from "vite-plugin-vue-devtools";
import cesium from "vite-plugin-cesium";
import viteCompression from "vite-plugin-compression";

export default defineConfig({
  plugins: [
    vue({
      template: {
        compilerOptions: {
          isCustomElement: (tag) => tag === "model-viewer",
        },
      },
    }),
    vueDevTools(),
    cesium(),
    viteCompression({
      algorithm: "gzip",
      ext: ".gz",
      threshold: 10240,
      deleteOriginFile: false,
      filter: /\.(js|mjs|css|html|json|svg|wasm|czml)$/i,
    }),
    viteCompression({
      algorithm: "brotliCompress",
      ext: ".br",
      threshold: 10240,
      deleteOriginFile: false,
      filter: /\.(js|mjs|css|html|json|svg|wasm|czml)$/i,
    }),
  ],
  server: {
    proxy: {
      "/api": {
        target: "http://127.0.0.1:8787",
        changeOrigin: true,
      },
      "/tianditu": {
        target: "http://t0.tianditu.com",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/tianditu/, ""),
      },
      "/tiles": {
        target: "http://localhost:8088",
        changeOrigin: true,
      },
    },
  },
  define: {
    CESIUM_BASE_URL: JSON.stringify("/cesium/"),
  },
  optimizeDeps: {
    include: ["cesium"],
  },
  build: {
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL("./index.html", import.meta.url)),
        metrics: fileURLToPath(new URL("./metrics.html", import.meta.url)),
      },
    },
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
});
