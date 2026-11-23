import { register } from "node:module";
register("./hooks.mjs", import.meta.url);

// No test reaches the network: anything not answered by the mock data fails loudly.
globalThis.fetch = async (url) => { throw new Error(`a test reached the network: ${url}`); };
