/**
 * Reading back what a run wrote.
 *
 * Every test that drives `NdjsonWriter` needs the same two things: a sink that
 * collects, and the parse of what it collected. Written once here so that the
 * shape of an assertion does not vary by which file it lives in — and so that a
 * change to the line grammar breaks one helper rather than four copies.
 */

export type Line = Record<string, unknown>;

export const parseNdjson = (chunks: readonly string[]): Line[] =>
  chunks
    .join("")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as Line);

export type Capture = {
  /** Pass as the writer's or command's `sink`. */
  sink: (line: string) => void;
  /** Pass as the writer's or command's `stderr`. */
  stderr: (line: string) => void;
  /** Exact bytes written to stdout, including line endings. */
  text: () => string;
  lines: () => Line[];
  /** The trailer, once the run has ended. */
  last: () => Line | undefined;
  /** Every line of one `type` — `"record"`, `"warning"`, `"summary"`, `"error"`. */
  of: (type: string) => Line[];
  errors: string[];
};

export const capture = (): Capture => {
  const out: string[] = [];
  const errors: string[] = [];
  const lines = (): Line[] => parseNdjson(out);
  return {
    sink: (line) => out.push(line),
    stderr: (line) => errors.push(line),
    text: () => out.join(""),
    lines,
    last: () => lines().at(-1),
    of: (type) => lines().filter((line) => line["type"] === type),
    errors,
  };
};
