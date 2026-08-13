/**
 * `pd` entrypoint — the file `bun run build` compiles into `dist/pd`.
 *
 * `--version` (ADR-0021 §6) and `pd auth status` (ADR-0012 §5) are wired here,
 * because ADR-0009 §8 puts both outside the resource grammar. Everything else
 * goes to `router.ts`, which owns that grammar and the refusal for what is not
 * in it. The manifest and `--help` arrive with ticket 16.
 */

import { homedir } from "node:os";

import { pdError, type PdError } from "./lib/errors.ts";
import { authStatus } from "./lib/auth/status.ts";
import { route } from "./router.ts";
import { isPdFailure } from "./lib/pipedrive/failure.ts";
import { errorLine, ZERO_COUNTERS } from "./lib/output/ndjson-writer.ts";

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

const main = async (argv: readonly string[]): Promise<number> => {
  if (argv.length === 1 && argv[0] === "--version") {
    process.stdout.write(`${version()}\n`);
    return 0;
  }

  if (argv[0] === "auth" && argv[1] === "status") {
    return runAuthStatus(argv.slice(2));
  }

  // Everything else is the resource grammar of ADR-0009 §1, including the
  // refusal for what it does not recognise.
  return route({
    argv,
    platform: process.platform,
    env: process.env,
    home: homedir(),
    transport: globalThis.fetch,
  });
};

/**
 * ADR-0004: a run that exits with no trailer is a bug and surfaces as
 * `internal`. The writer refuses a second trailer by throwing the `PdFailure`
 * carrier (there is no `Result` channel on a void method), and `guardedFetch`
 * throws the same carrier for its refusals — so this is the one place both come
 * back to being the values the rest of `pd` deals in.
 *
 * A throw that reaches here means no trailer was written — with **one
 * exception, and it is the reason for the check below**. The writer raises
 * `details.trailer_already_written` (ADR-0024 §3) when the trailer and its
 * stderr line are both already out: its second-trailer refusal, because
 * answering that with an `error` line would commit the violation the refusal
 * exists to catch, and its shadowed-key refusal, which writes a truthful
 * trailer of its own first (ADR-0025 §1). That case gets the exit code and
 * nothing else.
 *
 * In every other case the `error` line is still owed, and `internal` is what an
 * escaped programmer error is called.
 */
main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (cause: unknown) => {
    const error = isPdFailure(cause)
      ? cause.error
      : pdError({
          code: "internal",
          message: `pd ended without writing a trailer: ${String(cause)}`,
        });
    if (error.details?.["trailer_already_written"] !== true) {
      process.stdout.write(
        `${JSON.stringify(errorLine(error, ZERO_COUNTERS))}\n`,
      );
      process.stderr.write(`pd: ${error.message}\n`);
    }
    process.exitCode = error.exit_code;
  },
);
