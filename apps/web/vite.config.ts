import { defineConfig } from "vite-plus";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import { cloudflare } from "@cloudflare/vite-plugin";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { redact } from "@tanstack/redact/vite";

export default defineConfig({
  fmt: {
    ignorePatterns: [
      "src/routeTree.gen.ts",
      "dist/**",
      ".wrangler/**",
      ".tanstack/**",
      "public/baidu_verify_*.html",
    ],
  },
  resolve: { tsconfigPaths: true },
  ssr: { noExternal: true },
  plugins: [
    cloudflare({ viteEnvironment: { name: "ssr" } }),
    tanstackStart(),
    react(),
    redact(),
    tailwindcss(),
  ],
});
