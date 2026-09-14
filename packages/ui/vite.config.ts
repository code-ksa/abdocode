import { defineConfig } from "vite"
import solidPlugin from "vite-plugin-solid"
import { iconsSpritesheet } from "vite-plugin-icons-spritesheet"
import fs from "fs"

export default defineConfig({
  plugins: [
    solidPlugin(),
    providerIconsPlugin(),
    iconsSpritesheet([
      {
        withTypes: true,
        inputDir: "src/assets/icons/file-types",
        outputDir: "src/components/file-icons",
        formatter: "prettier",
      },
      {
        withTypes: true,
        inputDir: "src/assets/icons/provider",
        outputDir: "src/components/provider-icons",
        formatter: "prettier",
        iconNameTransformer: (iconName) => iconName,
      },
    ]),
  ],
  server: { port: 3001 },
  build: {
    target: "esnext",
  },
  worker: {
    format: "es",
  },
})

function providerIconsPlugin() {
  return {
    name: "provider-icons-plugin",
    configureServer() {
      void fetchProviderIcons()
    },
    buildStart() {
      void fetchProviderIcons()
    },
  }
}

/**
 * Refreshes provider logos. OFF unless a catalogue host is configured.
 *
 * This ran on `buildStart` of every UI build, against the upstream project's
 * host: one request for the catalogue, then one per provider — around 190
 * more — downloading SVGs straight into our source tree. So a build could not
 * run offline, two builds could produce different artwork, and whoever served
 * those files got a request from every machine that ever built the UI, plus
 * the ability to put arbitrary SVG into our bundle.
 *
 * The icons are committed to this repository (104 of them). Refreshing them is
 * a deliberate act: set ABDO_MODELS_URL and build.
 */
async function fetchProviderIcons() {
  const url = process.env.ABDO_MODELS_URL
  if (!url) return
  const providers = await fetch(`${url}/api.json`)
    .then((res) => res.json())
    .then((json) => Object.keys(json))
  await Promise.all(
    providers.map((provider) =>
      fetch(`${url}/logos/${provider}.svg`)
        .then((res) => res.text())
        .then((svg) => fs.writeFileSync(`./src/assets/icons/provider/${provider}.svg`, svg)),
    ),
  )
}
