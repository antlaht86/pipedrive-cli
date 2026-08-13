/**
 * The vendored client of both generated jobs refers to the global `BodyInit`,
 * which the DOM lib supplies and `bun-types` does not — it exposes the same type
 * as `Bun.BodyInit`. Bridging it here keeps `lib: ["ESNext"]` free of the whole
 * DOM surface, and keeps the generated output unedited.
 */
declare global {
  type BodyInit = Bun.BodyInit;
}

export {};
