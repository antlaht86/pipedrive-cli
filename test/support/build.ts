/**
 * `buildBinary`, retried — a workaround for a Bun bundler bug, confined to
 * tests.
 *
 * ## The bug
 *
 * Under `bun test`, `Bun.build` intermittently fails with `Could not resolve`
 * on an import that plainly resolves. Observed on Bun 1.3.14, roughly one build
 * in five to ten, and only on the first `Bun.build` of a process. The module it
 * names is **random**: `./v2/generated/sdk.gen.ts` on one run and `../errors.ts`
 * — an import that has resolved since ticket 01 — on the next. It appeared when
 * ticket 05 grew the module graph, which is consistent with a race between
 * concurrent resolutions rather than with anything about a particular file.
 *
 * `bun run build`, the production path, did not reproduce it in fifteen
 * consecutive runs. So this is a flaky *test*, not a broken artifact.
 *
 * ## Why the retry is here and not in `scripts/build.ts`
 *
 * `scripts/build.ts` is what a person and CI run to produce `dist/pd`. A retry
 * there would swallow a genuine unresolvable import — the one failure a build
 * must report loudly — for the sake of a test runner's bug. The retry belongs
 * to the tests that drive the builder, and this is the module they share.
 *
 * A real broken import fails deterministically and therefore fails all three
 * attempts, so the retry costs nothing in fidelity. Remove this module, and the
 * two imports of it, when Bun fixes the resolver.
 *
 * The retry is unconditional rather than matched against the message: `Bun.build`
 * reports this failure by *rejecting* with an aggregate whose `String()` does not
 * carry the `Could not resolve` text, so matching on it silently never fired.
 * Bun still prints the diagnostic itself, so a discarded attempt is visible in
 * the test output even when the retry succeeds.
 */

import { buildBinary, type BuildBinaryOptions } from "../../scripts/build.ts";

const ATTEMPTS = 3;

export const buildBinaryRetrying = async (
  options: BuildBinaryOptions,
): Promise<string> => {
  let last: unknown;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
    try {
      return await buildBinary(options);
    } catch (cause) {
      last = cause;
    }
  }
  throw last;
};
