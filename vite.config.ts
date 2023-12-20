import { defineConfig } from "vite";
import dts from "vite-plugin-dts";
import pkg from "./package.json";

export default defineConfig({
  build: {
    lib: {
      entry: "./lib/main.ts",
      name: "leafog",
      fileName: "leafog",
    },
    rollupOptions: { external: Object.keys(pkg.dependencies || {}) },
  },
  plugins: [dts()],
});
