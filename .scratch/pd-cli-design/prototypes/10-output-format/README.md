# Prototype: output format for large paginated results

Asset for [ticket 10](../../issues/10-prototype-output-format.md). Throwaway — nothing here ships.

**Outcome: NDJSON won.** See [ADR-0002](../../../../docs/adr/0002-output-format.md). The `*.array.json`
files are the **rejected** candidate, kept as the artifact that was reacted to. They still show the
envelope structure that was argued against; their embedded error objects picked up the final field
set when the samples were regenerated, but nothing about the envelope itself was revised. The
`*.ndjson` files carry the accepted design, and are the
normative examples of the format — nothing validates output shape at runtime, so they are the only
guard against drift.

- `generate.ts` writes `samples/`: the same result set in both candidate formats, across five cases.
- `bench.ts` measures what buffering costs on a 40,000-deal account.

Run:

```
bun run .scratch/pd-cli-design/prototypes/10-output-format/generate.ts
PAGE_LATENCY_MS=250 bun run .scratch/pd-cli-design/prototypes/10-output-format/bench.ts
```

## The two candidates as sampled

**Envelope around a JSON array** — one document. Records live under `data`; the completeness
marker, `emitted`, warnings and any error are sibling fields. Nothing can be written until the
run ends, because a failure on the last page changes the document.

**NDJSON** — one JSON value per line, each tagged with a `type` field: `record`, `warning`,
`summary`, `error`. The tag is how a consumer tells a data record from a trailer while streaming;
ADR-0001 left that distinction to this ticket.

Both samples honour the fixed constraints: no total count anywhere (v2 has none, per ticket 02),
a completeness marker on **every** list output including success (ADR-0001), custom fields as raw
40-character hashes (locked point 6), and the ADR-0001 error field set.

## Cases in `samples/`

| Case | Files | What it shows |
| --- | --- | --- |
| A complete | `a-complete.*` | The happy path, marker present anyway |
| B empty | `b-empty.*` | Empty success, not `not_found` |
| C guard | `c-guard-request-ceiling.*` | `--max-requests` hit: records then an `error` trailer, exit 3 |
| D mid-stream failure | `d-midstream-failure.*` | Page 7 dies after bytes are already out |
| E validation warning | `e-validation-warning.*` | One record fails zod, the run continues |
| F usage error | `f-usage-error.ndjson` | One `error` line, no summary — no list was ever started |

`d-midstream-failure.truncated-array.json` is the counter-example: what a naively streamed
envelope leaves on stdout when the process dies. No parser accepts it, and it is not obviously
broken to a reader who only sees the head.

## Measured cost of buffering (40,000 deals, Bun, macOS)

```
buffering 40000 records: +13.9 MB of parsed objects,
                         +63.4 MB more to serialise a 13.6 MB document,
                         peak 106.3 MB RSS (baseline 29.0 MB)
```

With a realistic 250 ms per page (80 pages at the v2 maximum of 500 records):

| | time to first byte | total | peak RSS |
| --- | --- | --- | --- |
| Envelope, buffered | 20,113 ms | 20,119 ms | 110 MB |
| NDJSON, streamed | 252 ms | 20,139 ms | 123 MB |

Reading of the numbers:

- **Time to first byte is the whole difference.** 20 s versus 250 ms. Total wall time is identical —
  both wait on the same 80 requests. Buffering does not make the run slower, it makes it silent.
- **Memory is not the argument.** ~106 MB peak for 40k records is survivable, and the serialisation
  step costs more than the retained objects (a 13.6 MB string costs ~63 MB transient to build).
  NDJSON's peak RSS is no lower here, because allocation churn is what dominates.
- The byte counts are within 7 % of each other; NDJSON pays for the repeated `{"type":"record",...}`
  wrapper, the envelope pays for indentation only when `--pretty` is on.
