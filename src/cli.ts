/**
 * `pd` entrypoint — the file `bun run build` compiles into `dist/pd`.
 *
 * Only `--version` is wired here (ADR-0021 §6). The command table, the manifest
 * and `--help` arrive with ticket 16; until then any other invocation is a
 * placeholder refusal rather than an invented contract.
 */

/** Stamped by the build through `define` (see `scripts/build.ts`). */
declare const PD_VERSION: string | undefined;

/** Running from source — `bun src/cli.ts` — has no stamp. */
const version = (): string =>
  typeof PD_VERSION === "undefined" ? "0.0.0+source" : PD_VERSION;

const main = (argv: readonly string[]): number => {
  if (argv.length === 1 && argv[0] === "--version") {
    process.stdout.write(`${version()}\n`);
    return 0;
  }

  process.stderr.write("pd: not implemented yet\n");
  return 2;
};

process.exitCode = main(process.argv.slice(2));
