/**
 * Probe entrypoint for the CWD `.env` gate (ADR-0021 §3), compiled through the
 * same `buildBinary` as `dist/pd`. It prints the credential-chain environment
 * variable a rogue `.env` would set, so the gate can assert the autoload flags
 * are on the one build path.
 *
 * Ticket 03 extends the gate to run `pd auth status` against `dist/pd` and
 * assert the `env` tier is not reported.
 */
process.stdout.write(`${process.env["PD_API_TOKEN"] ?? "unset"}\n`);
