/**
 * Regenerates `samples/` — the normative examples of the NDJSON format.
 *
 * ADR-0002 decided that nothing validates output at runtime, which makes these
 * files the only guard against format drift. Ticket 05 therefore stopped
 * hand-writing them: every `*.ndjson` file below is produced by driving the
 * shipped `NdjsonWriter`, and `test/output-samples.test.ts` re-runs this script's
 * cases and compares byte for byte. A change to the writer that nobody meant to
 * make fails that test; a change somebody did mean to make is a diff on these
 * files, in the same commit, which is what a normative example is for.
 *
 * The `*.array.json` files are the **rejected** envelope candidate, kept as the
 * artifact that was reacted to. They are still written by hand here, because
 * there is no code that produces them and there never will be. Only their
 * embedded error objects track the final field set.
 *
 * Run: bun run .scratch/pd-cli-design/prototypes/10-output-format/generate.ts
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { dealsList } from "../../../../src/commands/deals-list.ts";
import { pdError } from "../../../../src/lib/errors.ts";
import { NdjsonWriter } from "../../../../src/lib/output/ndjson-writer.ts";
import type { Page } from "../../../../src/lib/pipedrive/walk.ts";
import { deal } from "../../../../test/support/deals.ts";

const OUT = join(import.meta.dir, "samples");

type Record_ = Record<string, unknown>;

const HASH_AMOUNT = "8a1b3c9d2e4f5061728394a5b6c7d8e9f0a1b2c3";
const HASH_SOURCE = "1f2e3d4c5b6a798877665544332211aabbccddee";

/**
 * A deal as `pd` emits one: the record schema's fields, with the custom-field
 * block Pipedrive actually sends and the nullable fields left null so the
 * samples show ADR-0020 §6's omission rule doing its work.
 */
const sample = (i: number): Record_ =>
  deal(1000 + i, {
    status: ["open", "won", "lost"][i % 3] as string,
    custom_fields: { [HASH_AMOUNT]: 4200, [HASH_SOURCE]: 34 },
  });

const samples = (n: number, from = 0): Record_[] =>
  Array.from({ length: n }, (_, i) => sample(from + i));

const page = (
  records: Record_[],
  warnings: Page<Record_>["warnings"] = [],
): Page<Record_> => ({ records, warnings, duplicates: 0 });

/** One run of the writer, captured as a string. Exported for the drift test. */
export const render = (
  requests: number,
  run: (writer: NdjsonWriter) => void,
): string => {
  const out: string[] = [];
  const writer = new NdjsonWriter({
    recordType: "deal",
    requests: () => requests,
    sink: (line) => out.push(line),
    stderr: () => {},
  });
  run(writer);
  return out.join("");
};

/** Runs `pd deals list --frobnicate` and captures its stdout. */
const usageError = async (): Promise<string> => {
  const out: string[] = [];
  await dealsList({
    argv: ["--frobnicate"],
    platform: "linux",
    env: {},
    home: "/home/nobody",
    sink: (line) => out.push(line),
    stderr: () => {},
  });
  return out.join("");
};

const REJECTED = {
  kind: "record_rejected" as const,
  resource: "deal",
  id: 1002,
  path: "value",
  issue: "invalid_type",
  message: "Invalid input: expected number, received string",
};

const CEILING = pdError({
  code: "request_ceiling",
  message: "Stopped after 50 requests; raise --max-requests and run again.",
  details: { max_requests: 50 },
});

const MID_STREAM = pdError({
  code: "rate_limited",
  message: "The 2-second burst window was exhausted three times and the retries are spent.",
  retryAfterSeconds: 2,
  details: { path: "/api/v2/deals", status: 429, burst_strikes: 3 },
});

/**
 * The six cases, each a name and the run that produces it. The drift test
 * imports this table rather than re-describing it.
 */
export const CASES: { name: string; ndjson: string }[] = [
  {
    // A — the happy path. The completeness marker is present anyway.
    name: "a-complete.ndjson",
    ndjson: render(1, (writer) => {
      writer.page(page(samples(4)));
      writer.finish(null);
    }),
  },
  {
    // B — an empty result set is an empty success, not not_found.
    name: "b-empty.ndjson",
    ndjson: render(1, (writer) => {
      writer.finish(null);
    }),
  },
  {
    // C — a guard stop: --max-requests reached. Exit 3, and the records already
    // written stay written beside the error trailer.
    name: "c-guard-request-ceiling.ndjson",
    ndjson: render(50, (writer) => {
      writer.page(page(samples(3)));
      writer.error(CEILING);
    }),
  },
  {
    // D — the case that decided the format: bytes are already on stdout when
    // page seven dies. NDJSON has no document to truncate.
    name: "d-midstream-failure.ndjson",
    ndjson: render(9, (writer) => {
      writer.page(page(samples(5)));
      writer.error(MID_STREAM);
    }),
  },
  {
    // E — one record failed zod. One warning, skipped += 1, the run continues.
    name: "e-validation-warning.ndjson",
    ndjson: render(1, (writer) => {
      writer.page(page(samples(2), [REJECTED]));
      writer.page(page(samples(1, 3)));
      writer.finish(null);
    }),
  },
  {
    // F — a usage error. No list was ever started, so there is no summary: the
    // single error line is the whole output and carries the invariant fields.
    //
    // This one is produced by running the **real command**, not by handing the
    // writer an invented error. A usage error short-circuits before any request,
    // so no transport is needed — and the sample then pins the message `pd`
    // actually emits rather than one nobody would ever see.
    name: "f-usage-error.ndjson",
    ndjson: await usageError(),
  },
];

// ---------------------------------------------------------------------------
// The rejected candidate, written by hand because nothing produces it.
// ---------------------------------------------------------------------------

const envelope = (body: Record_): string => `${JSON.stringify(body, null, 2)}\n`;

const trailerFields = (emitted: number, extra: Record_ = {}) => ({
  complete: false,
  emitted,
  skipped: 0,
  duplicates: 0,
  resolved: "off",
  requests: 0,
  ...extra,
});

const errorObject = (
  error: ReturnType<typeof pdError>,
  emitted: number,
  requests: number,
): Record_ => ({
  code: error.code,
  message: error.message,
  exit_code: error.exit_code,
  retry: error.retry,
  ...(error.retry_after_seconds === undefined
    ? {}
    : { retry_after_seconds: error.retry_after_seconds }),
  ...trailerFields(emitted, { requests }),
  details: error.details ?? {},
});

export const ARRAY_CASES: { name: string; body: string }[] = [
  {
    name: "a-complete.array.json",
    body: envelope({
      type: "result",
      command: "deals list",
      data: samples(4),
      complete: true,
      emitted: 4,
      skipped: 0,
      duplicates: 0,
      resolved: "off",
      requests: 1,
    }),
  },
  {
    name: "b-empty.array.json",
    body: envelope({
      type: "result",
      command: "deals list",
      data: [],
      complete: true,
      emitted: 0,
      skipped: 0,
      duplicates: 0,
      resolved: "off",
      requests: 1,
    }),
  },
  {
    name: "c-guard-request-ceiling.array.json",
    body: envelope({
      type: "result",
      command: "deals list",
      data: samples(3),
      ...trailerFields(3, { requests: 50 }),
      error: errorObject(CEILING, 3, 50),
    }),
  },
  {
    name: "d-midstream-failure.array.json",
    body: envelope({
      type: "result",
      command: "deals list",
      data: samples(5),
      ...trailerFields(5, { requests: 9 }),
      error: errorObject(MID_STREAM, 5, 9),
    }),
  },
  {
    name: "e-validation-warning.array.json",
    body: envelope({
      type: "result",
      command: "deals list",
      data: [...samples(2), ...samples(1, 3)],
      complete: true,
      emitted: 3,
      skipped: 1,
      duplicates: 0,
      resolved: "off",
      requests: 1,
      warnings: [REJECTED],
    }),
  },
  {
    // The counter-example: what a naively *streamed* envelope leaves on stdout
    // when the process dies. No parser accepts it, and it does not look broken
    // to a reader who sees only its head.
    name: "d-midstream-failure.truncated-array.json",
    body:
      JSON.stringify(
        { type: "result", command: "deals list", data: samples(5) },
        null,
        2,
      ).replace(/\n\s*\]\n\}$/, "\n") +
      "  ... process died here, no closing bracket\n",
  },
];

if (import.meta.main) {
  mkdirSync(OUT, { recursive: true });
  for (const { name, ndjson } of CASES) writeFileSync(join(OUT, name), ndjson);
  for (const { name, body } of ARRAY_CASES) writeFileSync(join(OUT, name), body);
  console.error(`wrote ${CASES.length + ARRAY_CASES.length} samples to ${OUT}`);
}
