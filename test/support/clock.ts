/**
 * The fake `Clock` of ADR-0019 §4.
 *
 * Time does not pass; it is jumped. `sleep()` registers a waiter and a drain
 * scheduled on the real macrotask queue advances virtual time to the earliest
 * waiter once the run has nothing else to do. So a test of ADR-0011 §7's
 * three-strike budget — about six real seconds of stall — finishes in
 * milliseconds, and the exact durations are recorded rather than approximated.
 *
 * `random()` is a seeded mulberry32 rather than `Math.random`, so the full
 * jitter of ADR-0011 §8 is reproducible. A test that wants the undamped backoff
 * passes `random: () => 1`.
 */

import type { Clock } from "../../src/lib/pipedrive/clock.ts";

type Waiter = { at: number; resolve: () => void };

const mulberry32 = (seed: number): (() => number) => {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

export type FakeClockOptions = {
  /** Virtual epoch. Any number will do; nothing in `pd` reads a wall date. */
  start?: number;
  seed?: number;
  /** Overrides the seeded generator outright — `() => 1` for undamped jitter. */
  random?: () => number;
};

export class FakeClock implements Clock {
  #now: number;
  #waiters: Waiter[] = [];
  #drainScheduled = false;
  readonly #random: () => number;

  /** Every duration passed to `sleep`, in order, including the zero waits. */
  readonly sleeps: number[] = [];

  constructor({ start = 0, seed = 1, random }: FakeClockOptions = {}) {
    this.#now = start;
    this.#random = random ?? mulberry32(seed);
  }

  now = (): number => this.#now;

  random = (): number => this.#random();

  sleep = (ms: number): Promise<void> => {
    this.sleeps.push(ms);
    if (ms <= 0) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.#waiters.push({ at: this.#now + ms, resolve });
      this.#scheduleDrain();
    });
  };

  /**
   * A drain runs on the real timer queue, which is what makes it fire only after
   * every already-runnable continuation has had its turn. Without that, time
   * would jump past work that was about to register its own sleep.
   */
  #scheduleDrain(): void {
    if (this.#drainScheduled) return;
    this.#drainScheduled = true;
    setTimeout(() => {
      this.#drainScheduled = false;
      this.#advanceToEarliest();
    }, 0);
  }

  #advanceToEarliest(): void {
    if (this.#waiters.length === 0) return;
    const earliest = Math.min(...this.#waiters.map((w) => w.at));
    this.#now = Math.max(this.#now, earliest);
    const due = this.#waiters.filter((w) => w.at <= this.#now);
    this.#waiters = this.#waiters.filter((w) => w.at > this.#now);
    for (const waiter of due) waiter.resolve();
    // Waiters still pending get their own drain: a resolved continuation that
    // sleeps again schedules one itself, so this never spins on an idle queue.
    if (this.#waiters.length > 0) this.#scheduleDrain();
  }
}
