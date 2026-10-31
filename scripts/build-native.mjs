import { build } from "vite"
import { fileURLToPath } from "node:url"

export async function buildNative() {
  const output = fileURLToPath(new URL("../.cache/native", import.meta.url))
  await build({
    configFile: false,
    logLevel: "warn",
    build: {
      outDir: output,
      license: { fileName: "dependencies.md" },
      emptyOutDir: true,
      target: ["safari16.4", "chrome111"],
      lib: { entry: fileURLToPath(new URL("../src/bootstrap.mjs", import.meta.url)), formats: ["es"], fileName: () => "bootstrap.js" },
    },
  })
  return output + "/bootstrap.js"
}
