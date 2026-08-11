# ADR-0002: Output format

Status: accepted
Date: 2026-08-11
Deciding ticket: [Output format for large paginated results](../../.scratch/pd-cli-design/issues/10-prototype-output-format.md)
Prototype: [`.scratch/pd-cli-design/prototypes/10-output-format/`](../../.scratch/pd-cli-design/prototypes/10-output-format/)

## Context

`pd` is a read-only Pipedrive CLI whose primary consumer is an AI coding agent on no particular
harness. A list command may walk tens of thousands of records across cursor pages. The candidate
formats were a single JSON array inside an envelope, and NDJSON.

[ADR-0001](0001-error-model-and-exit-codes.md) fixed that the machine-readable error object goes to
stdout, that a completeness marker rides on every list output, and that an error must be
distinguishable from a data record while streaming — leaving *how* it is distinguished to this
decision.

Two research findings constrain the shape: Pipedrive v2 reports **no total count** anywhere, so
"3,200 of N" cannot be expressed ([cursor pagination research](../../.scratch/pd-cli-design/research/02-cursor-pagination-semantics.md));
and cursors behave like keyset markers, so a walk may duplicate records if data changes underneath it.

## Measured, not assumed

A throwaway prototype rendered the same 40,000-deal result set both ways and measured the cost.
With a realistic 250 ms per page (80 pages at the v2 maximum page size of 500):

| | time to first byte | total wall time | peak RSS |
| --- | --- | --- | --- |
| Envelope, buffered | 20,113 ms | 20,119 ms | 110 MB |
| NDJSON, streamed | 252 ms | 20,139 ms | 123 MB |

- **Time to first byte is the entire difference**: 20 s against 250 ms. Total wall time is identical
  because both wait on the same 80 requests. Buffering does not make a run slower, it makes it silent.
- **Memory is not an argument either way.** ~106 MB peak for 40,000 records is survivable, and
  serialising costs more than retaining: a 13.6 MB JSON string costs roughly 63 MB of transient RSS
  to build, against 14 MB for the parsed objects it came from. NDJSON's peak is no lower, because
  allocation churn dominates.

## Decision

### NDJSON is the only machine format

One JSON value per line. The JSON array and its envelope are cut entirely.

Streaming's benefit is real but conditional — it only pays if a consumer starts work before the
process exits, and a harness that captures stdout and waits for exit gains nothing. The decision
does not rest on that, because **format and streaming are separable**: a buffered NDJSON writer
produces byte-identical output to a streaming one, differing only in timing. So NDJSON may ship
buffered and become streaming later with no change to the consumer's contract. The envelope has no
such path — moving it to streaming is a breaking change.

Implementation effort for the streaming writer was judged 8/10 on ease and therefore in scope:
the write path is a generator yielding pages into `stdout.write`; zod validation is already
per-record; custom-field resolution is a prefetch rather than a buffer; and cross-page
deduplication needs only a `Set` of ids. The 2 points against are that streaming is
**irreversible** — once bytes are out they cannot be retracted, so whole-set post-processing is
foreclosed. If the command surface later needs sorting, aggregation or "top 10 by value", those
commands cannot stream and would need a second path.

### Every line carries a `type` tag

`record`, `warning`, `summary`, `error`. This is how an error is distinguished from a data record
mid-stream, as ADR-0001 required. Tag dispatch is the format's native consumption model — a
consumer must already separate `record` from `warning` — so the tag costs a consumer nothing.

### Exactly one trailer line, and it is exclusive

A run ends with **either** a `summary` line **or** an `error` line, never both.

```
{"type":"summary","complete":true,"emitted":40000}
{"type":"summary","complete":false,"emitted":100,"reason":"limit"}
{"type":"error","code":"rate_limited","message":"…","complete":false,"emitted":5,"exit_code":3,"retry":"after","retry_after_seconds":4,"details":{}}
{"type":"error","code":"usage","message":"Unknown flag --frobnicate.","complete":false,"emitted":0,"exit_code":2,"retry":"never","details":{}}
```

**The invariant: the last line always carries `complete` and `emitted`, whatever its type.** A lazy
consumer reads the last line and two fields. A careful one dispatches on `type`. Neither is misled.

Two trailers — a `summary` followed by an `error` — was rejected because `emitted` would appear on
both lines and could drift. Wrapping the error inside the `summary` was rejected because it makes
the error object nested, when ADR-0001 promised it in the same shape family as success, and because
a usage error would then emit a `summary` for a list that was never started.

A usage error emits the single `error` line and nothing else. Its `complete: false` is vacuous but
keeps the invariant total, which is worth more than the special case it would otherwise need.

`reason` on a bounded summary is named here only to show the line's shape; its values belong to the
[pagination-bounding ticket](../../.scratch/pd-cli-design/issues/11-grilling-pagination-bounding.md).

### Nothing validates output at runtime

zod guards the boundary where untrusted data enters — Pipedrive's response — and nowhere else.
Output line shapes are TypeScript types, not runtime schemas, and are not re-checked on the way out.
Consequence: the sample files in the prototype directory are the **normative examples** of the
format, and the only guard against shape drift.

A record rejected by zod does not stop the run. It emits a `warning` line and is skipped; the
`summary` reports how many. This is the input boundary that produces ADR-0001's `invalid_response`
when the failure is structural rather than per-record.

### `--pretty` is a human renderer, and is explicitly unstable

`--pretty` cannot be "the same format, rendered differently": indented JSON is multi-line, and
NDJSON is one value per line by definition. So `--pretty` switches to an aligned table with no JSON
in it at all. Buffering the whole set to compute column widths is acceptable precisely because the
flag is opt-in and never used by an agent.

An indented JSON array was rejected as the `--pretty` rendering because it reintroduces the
envelope through the back door — two output code paths, two partiality representations, and a `jq`
user who inevitably starts depending on it.

**`--pretty` output is explicitly unstable**: wording, columns and alignment may change in any
release, and nothing in it may be parsed. Without that declaration it becomes a de facto contract
the moment one user scripts against it, leaving `pd` with two stable formats instead of one.

### In `--pretty` mode there is no machine-readable error object

Not a second error channel — an absence. ADR-0001 already sends a human one-line summary of every
error to stderr unconditionally. Writing the error to stdout as well in `--pretty` mode would print
it twice to a human whose terminal merges the channels.

> The machine-readable error object is part of the NDJSON stream. Under `--pretty` there is no
> NDJSON stream, so there is no error object — only the stderr line that already existed.

stdout under `--pretty` carries the table and nothing else; on failure, the rows that were fetched
before it stopped.

The cost: `--pretty` loses the `code` field, so an agent cannot act on a failure precisely. The exit
code survives, but **an agent must never invoke `pd --pretty`**, and `AGENTS.md` says so directly.

### What the command manifest declares

Because there is exactly one machine format, the manifest declares it **once, globally** — not per
command, and not as a list of supported formats. A per-command format list would model a variability
that does not exist. `--pretty` appears in the manifest as a human-output flag, marked unstable.

## Consequences

- The streaming write path is in scope, but may ship buffered first without a contract change.
- Any future command needing whole-set post-processing breaks the streaming property and must be
  recognised as a second output path, not smuggled in.
- A naive consumer that pipes NDJSON into a whole-document JSON parser gets an error. This is
  accepted: it fails loudly on the first line rather than silently on a truncated document, which is
  what a streamed envelope would have produced.
- The prototype's `d-midstream-failure.truncated-array.json` records the rejected alternative's
  failure mode: a document with no closing bracket, which no parser accepts and which does not look
  broken to a reader who sees only its head.
