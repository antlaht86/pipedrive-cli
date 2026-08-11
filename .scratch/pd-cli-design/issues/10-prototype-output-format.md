# Output format for large paginated results

Type: prototype
Status: resolved

Blocked by: 02, 09

## Question

A single JSON array, or NDJSON — and is it a flag or a fixed choice?

Make a concrete sample of each format for the same realistic result set, including the failure and partiality cases, and react to them as an agent consumer would.

- The JSON array buffers whole. What does that cost on a large result set, in memory and in time-to-first-byte?
- NDJSON streams and lets a consumer start work early, but a naive consumer that pipes it into a JSON parser gets an error. How likely is that consumer, given the tool is invoked by an arbitrary harness?
- How does each format carry non-record information — the count, the partiality marker from ticket 09, a warning about a record that failed validation? An NDJSON trailer record, an envelope around a JSON array, or a separate channel?
- What does each format do when a failure happens mid-stream after bytes are already on stdout? This is the same question ticket 12 asks from the other side; answer it here for the format and let 12 answer it for the control flow.
- Does `--pretty` change the format or only its rendering?
- If it is a flag: what is the default, and does a harness that reads the command manifest learn which formats a command supports?

Produce the sample outputs as an asset and link them from this ticket.

## Answer

Recorded in full as [ADR-0002: Output format](../../../docs/adr/0002-output-format.md).
Asset: [`prototypes/10-output-format/`](../prototypes/10-output-format/) — `generate.ts` writing six
sampled cases in both candidate formats, and `bench.ts` measuring the cost of buffering.

In gist:

- **NDJSON is the only machine format.** The JSON array and its envelope are cut. The decision does
  not rest on streaming paying off, because format and streaming are separable: a buffered NDJSON
  writer is byte-identical to a streaming one, so NDJSON can ship buffered and become streaming with
  no contract change. The envelope has no such path.
- **The measurement**: on 40,000 deals at 250 ms per page, time to first byte is 20,113 ms buffered
  against 252 ms streamed, with identical total wall time and no memory advantage either way
  (~106 MB peak; serialising a 13.6 MB string costs ~63 MB transient, more than the 14 MB of parsed
  objects). Buffering does not make a run slower — it makes it silent.
- The streaming write path was judged **8/10 on ease** and is therefore in scope. The 2 points
  against are irreversibility: once bytes are out they cannot be retracted, so any future command
  needing whole-set post-processing (sorting, aggregation, "top 10") cannot stream.
- **Every line carries a `type` tag** — `record`, `warning`, `summary`, `error`. This is ADR-0001's
  "an error must be distinguishable from a data record mid-stream", answered.
- **Exactly one trailer, exclusive**: a run ends with a `summary` **or** an `error`, never both. The
  invariant is that **the last line always carries `complete` and `emitted`**, whatever its type. Two
  trailers were rejected for duplicating `emitted`; wrapping the error inside the summary was
  rejected for nesting the error object and for emitting a summary for a list never started.
- **Nothing validates output at runtime** — zod guards only the boundary where untrusted data enters.
  Output shapes are TypeScript types, so the sample files are the format's normative examples and the
  only guard against drift.
- **`--pretty` is an aligned table, not JSON**, and is explicitly unstable — nothing in it may be
  parsed. Indented JSON was rejected as the rendering because it reintroduces the envelope.
- **Under `--pretty` there is no machine-readable error object** — not a second channel, an absence.
  ADR-0001's unconditional stderr one-liner already covers the human, and writing to stdout too would
  print the error twice in a merged terminal.
- The manifest declares the single format **once, globally**, not per command.

Three things this resolution hands onward:

- **An agent must never invoke `pd --pretty`** — it loses the `code` field. To be stated directly in
  `AGENTS.md`.
- [Ticket 12](12-grilling-streaming-and-result-composition.md) inherits a format that permits
  streaming and a trailer that carries partiality, so a `ResultAsync` over the whole collection is
  now the weaker candidate on format grounds as well as ergonomic ones.
- [Ticket 11](11-grilling-pagination-bounding.md) owns the `summary` line's contents: the values of
  `reason`, and whether a resumption token appears there.
