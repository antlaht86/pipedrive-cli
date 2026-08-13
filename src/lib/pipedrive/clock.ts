/**
 * The injected clock — ADR-0019 §4.
 *
 * ADR-0011 made three separate things timing behaviour: the rolling
 * 10-requests-per-2-seconds gate, the three-strike 429 pause at ≤2 s each, and
 * the 250 ms / 1 s / 4 s jittered 5xx backoff. Tested against the real clock the
 * retry-budget test alone costs about six seconds, and ADR-0019 §9 refuses to
 * test those paths against the live API *permanently* — so the fake clock is the
 * only place they are ever exercised.
 *
 * `random()` sits on the same object rather than beside it because ADR-0019 §4
 * requires the full jitter of ADR-0011 §8 to be seeded from the same injected
 * source: a backoff test then asserts exact sleep durations instead of a range.
 * Nothing else in `pd` reads the wall clock, and no other module gains a
 * parameter for this.
 *
 * This is not a test-only surface. ADR-0019 §5 forbids a test-only flag or
 * environment variable of any kind; a constructor parameter on the one module
 * that already takes an injected transport is not one.
 */

export type Clock = {
  /** Milliseconds since the epoch, monotonic enough for a 2-second window. */
  now: () => number;
  /** Resolves after `ms` of this clock's time. `ms <= 0` resolves immediately. */
  sleep: (ms: number) => Promise<void>;
  /** Uniform in `[0, 1)`. The full-jitter source of ADR-0011 §8. */
  random: () => number;
};

export const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) =>
    ms <= 0
      ? Promise.resolve()
      : new Promise((resolve) => {
          setTimeout(resolve, ms);
        }),
  random: () => Math.random(),
};
