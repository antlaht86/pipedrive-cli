/**
 * Probe entrypoint for the CWD autoload gate (ADR-0021 §3), compiled through the
 * same `buildBinary` as `dist/pd`.
 *
 * It prints two things a rogue directory could set if the binary autoloaded its
 * files: `PD_API_TOKEN`, which a `.env` sets directly and which is tier 2 of the
 * credential chain, and `PD_BUNFIG_PRELOAD`, which a `bunfig.toml` sets through
 * a preloaded module. Both must read `unset`.
 *
 * Ticket 03 extends the `.env` half of the gate to run `pd auth status` against
 * `dist/pd` and assert the `env` tier is not reported.
 */
process.stdout.write(
  `${process.env["PD_API_TOKEN"] ?? "unset"} ${process.env["PD_BUNFIG_PRELOAD"] ?? "unset"}\n`,
);
