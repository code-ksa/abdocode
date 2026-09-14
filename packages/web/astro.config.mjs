import { defineConfig } from "astro/config"

export default defineConfig({
  output: "static",
  site: "https://example.invalid",
  server: { host: "127.0.0.1" },
  vite: {
    build: { sourcemap: false },
  },
})
