// Node ESM resolve hook for running engine modules outside vite.
//
// src/ imports extensionless relative specifiers ("./strokeBuffer",
// "./brushSprites") — vite resolves them, Node's ESM loader does not
// (ERR_MODULE_NOT_FOUND). Scripts that import the engine in Node (the golden
// fixture generator) register this hook first, then dynamic-import the
// engine:
//
//   import { register } from "node:module";
//   register("./node-esm-hooks.mjs", import.meta.url);
//   const engine = await import("../../src/utils/brushes.js");
//
// Only relative specifiers without an extension are touched, and only when
// the ".js" file exists; everything else falls through to Node untouched.
export async function resolve(specifier, context, nextResolve) {
  if (/^\.\.?\//.test(specifier) && !/\.[a-z]+$/i.test(specifier)) {
    try {
      return await nextResolve(`${specifier}.js`, context);
    } catch {
      /* not a .js file: let Node report the original specifier */
    }
  }
  return nextResolve(specifier, context);
}
