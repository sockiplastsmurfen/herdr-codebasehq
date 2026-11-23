// Module hooks for the tests: the mod's imports of Herdr's modules go to the fakes, and the
// mod's codebase.js (the API, the keychain, git) to the mock data over the real module.
const fake = (name) => new URL(`./fake/${name}`, import.meta.url).href;
const MOD = new URL("../mods/codebasehq/", import.meta.url).href;

export async function resolve(specifier, context, next) {
  if (specifier === "gpui-kit" || specifier === "gpui-base") return { url: fake("gpui.mjs"), shortCircuit: true };
  if (specifier === "herdr") return { url: fake("herdr.mjs"), shortCircuit: true };
  // The mod's own files asking for codebase.js get the mock (which builds on the real one).
  if (specifier === "./codebase.js" && context.parentURL?.startsWith(MOD)) return { url: fake("codebase.mjs"), shortCircuit: true };
  return next(specifier, context);
}
