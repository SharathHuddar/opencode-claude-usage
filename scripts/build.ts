// Compiles src/tui.tsx to dist/tui.js for publishing.
//
// OpenCode's runtime Solid JSX transform skips files under node_modules, so an npm-installed plugin must ship
// precompiled JSX. Host-shared modules are rewritten to OpenCode's runtime module IDs so the plugin uses the
// host's Solid/OpenTUI instances (required for reactivity and context).
import { createSolidTransformPlugin } from "@opentui/solid/bun-plugin"
import { runtimeModuleIdForSpecifier } from "@opentui/core/runtime-plugin"

const shared = new Set(["@opencode/plugin/tui", "@opentui/core", "@opentui/solid", "solid-js", "solid-js/store"])

const result = await Bun.build({
  entrypoints: ["./src/tui.tsx"],
  outdir: "./dist",
  target: "bun",
  format: "esm",
  packages: "external",
  external: ["opentui:*"],
  plugins: [
    createSolidTransformPlugin({
      moduleName: runtimeModuleIdForSpecifier("@opentui/solid"),
      resolvePath(specifier: string) {
        return shared.has(specifier) ? runtimeModuleIdForSpecifier(specifier) : null
      },
    }),
  ],
})

if (!result.success) {
  for (const log of result.logs) console.error(log)
  process.exit(1)
}
for (const output of result.outputs) console.log(`built ${output.path}`)
