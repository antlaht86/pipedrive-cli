/**
 * `pd` entrypoint — the file `bun run build` compiles into `dist/pd`.
 *
 * `--version` (ADR-0021 §6) and `pd auth status` (ADR-0012 §5) are wired here.
 * The command table, the manifest and `--help` arrive with ticket 16; until then
 * any other invocation is a placeholder refusal rather than an invented
 * contract, and the argument parsing below is deliberately the smallest thing
 * that serves the one command rather than the beginning of that table.
 */

import { homedir } from "node:os";

import { pdError, type PdError } from "./lib/errors.ts";
import { authStatus } from "./lib/auth/status.ts";

/** Stamped by the build through `define` (see `scripts/build.ts`). */
declare const PD_VERSION: string | undefined;

/**
 * Running from source — `bun src/cli.ts` — has no stamp. A built binary always
 * has one, so the artifact only ever prints the three shapes of ADR-0021 §6;
 * this fourth string cannot come out of `dist/pd`, and the binary smoke leg
 * asserts as much.
 */
const version = (): string =>
  typeof PD_VERSION === "undefined" ? "0.0.0+source" : PD_VERSION;

/**
 * ADR-0001: the machine-readable error object goes to **stdout**, and stderr
 * carries a human-readable one-line summary of the same error. Ticket 05's
 * NDJSON writer takes this over and adds the trailer fields a record stream
 * needs; `pd auth status` is not a record stream, so there is nothing for a
 * trailer to say about it.
 */
const fail = (error: PdError): number => {
  process.stdout.write(`${JSON.stringify({ type: "error", ...error })}\n`);
  process.stderr.write(`pd: ${error.message}\n`);
  return error.exit_code;
};

/**
 * ADR-0012 §3 refuses `--token <value>` in any form: argv is readable by every
 * other user on the machine. The refusal is explicit rather than implicit in an
 * unknown-flag error, because the flag is the one an operator will reach for
 * first and the reason is worth stating.
 */
const TOKEN_FLAG = /^--token(=.*)?$/;

const runAuthStatus = (argv: readonly string[]): number => {
  let tokenFile: string | undefined;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined) break;

    if (TOKEN_FLAG.test(arg)) {
      return fail(
        pdError({
          code: "usage",
          message:
            "There is no --token flag. argv is readable by every other user " +
            "on this machine, so pd takes a token only from --token-file, the " +
            "PD_API_TOKEN environment variable, or the credentials file.",
        }),
      );
    }

    if (arg === "--token-file") {
      const value = argv[i + 1];
      if (value === undefined) {
        return fail(
          pdError({
            code: "usage",
            message: "--token-file needs a path.",
          }),
        );
      }
      tokenFile = value;
      i += 1;
      continue;
    }

    if (arg.startsWith("--token-file=")) {
      tokenFile = arg.slice("--token-file=".length);
      continue;
    }

    return fail(
      pdError({
        code: "usage",
        message: `pd auth status does not accept ${arg}.`,
      }),
    );
  }

  const status = authStatus({
    platform: process.platform,
    env: process.env,
    home: homedir(),
    ...(tokenFile === undefined ? {} : { tokenFile }),
  });

  if (status.isErr()) return fail(status.error);

  process.stdout.write(`${JSON.stringify(status.value)}\n`);
  return 0;
};

const main = (argv: readonly string[]): number => {
  if (argv.length === 1 && argv[0] === "--version") {
    process.stdout.write(`${version()}\n`);
    return 0;
  }

  if (argv[0] === "auth" && argv[1] === "status") {
    return runAuthStatus(argv.slice(2));
  }

  process.stderr.write("pd: not implemented yet\n");
  return 2;
};

process.exitCode = main(process.argv.slice(2));
