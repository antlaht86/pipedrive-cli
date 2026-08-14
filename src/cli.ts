/**
 * `pd` entrypoint — the file `bun run build` compiles into `dist/pd`.
 *
 * Surface-introspection and named exception commands are wired here because
 * ADR-0009 puts them outside the resource grammar. Data commands go to
 * `router.ts`; their manifest entries and every help page come from the shared
 * command table.
 */

import { homedir } from "node:os";

import { ResultAsync } from "neverthrow";
import { z } from "zod";

import {
	createManifest,
	otherCommandNamed,
	renderHelp,
} from "./command-table.ts";
import {
	TOKEN_REFUSAL,
	parseArguments,
	refusesToken,
} from "./commands/arguments.ts";
import { pdError, type PdError } from "./lib/errors.ts";
import { authStatus } from "./lib/auth/status.ts";
import { route } from "./router.ts";
import { cacheCommand, isCacheVerb, CACHE_VERBS } from "./commands/cache.ts";
import { isPdFailure } from "./lib/pipedrive/failure.ts";
import {
	errorLine,
	failWith,
	ZERO_COUNTERS,
} from "./lib/output/ndjson-writer.ts";

/** Stamped by the build through `define` (see `scripts/build.ts`). */
declare const PD_VERSION: string | undefined;
/** AGENTS.md, embedded by the same build so `pd docs` survives being copied. */
declare const PD_DOCS: string | undefined;

/**
 * Running from source — `bun src/cli.ts` — has no stamp. A built binary always
 * has one, so the artifact only ever prints the three shapes of ADR-0021 §6;
 * this fourth string cannot come out of `dist/pd`, and the binary smoke leg
 * asserts as much.
 */
const version = (): string =>
	typeof PD_VERSION === "undefined" ? "0.0.0+source" : PD_VERSION;

const docs = (): ResultAsync<string, PdError> =>
	ResultAsync.fromPromise(
		typeof PD_DOCS === "undefined"
			? Bun.file(new URL("../AGENTS.md", import.meta.url)).text()
			: Promise.resolve(PD_DOCS),
		(cause) =>
			pdError({
				code: "internal",
				message: `pd could not read its embedded documentation: ${String(cause)}`,
			}),
	);

/**
 * ADR-0001: the machine-readable error object goes to **stdout**, and stderr
 * carries a human-readable one-line summary of the same error. `NdjsonWriter`
 * takes this over and adds the trailer fields a record stream needs; the three
 * commands ADR-0009 §8 puts outside the grammar are not record streams, so
 * there is nothing for a trailer to say about one.
 */
const fail = (error: PdError): number => failWith(error);

const runAuthStatus = (argv: readonly string[]): number => {
	const definition = otherCommandNamed("pd auth status");
	if (definition === undefined) {
		return fail(
			pdError({
				code: "internal",
				message: "pd auth status is missing from the command table.",
			}),
		);
	}
	if (refusesToken(argv)) return fail(TOKEN_REFUSAL);

	const parsed = parseArguments({
		command: definition.name,
		flags: definition.parserFlags,
		positional: "none",
		argv,
	});
	if (parsed.isErr()) return fail(parsed.error);

	const tokenFile = parsed.value.flags["token-file"];
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
	if (argv.includes("--help")) {
		const help = renderHelp(argv);
		if (help !== "") {
			process.stdout.write(help);
			return 0;
		}
	}

	if (argv.length === 1 && argv[0] === "--version") {
		process.stdout.write(`${version()}\n`);
		return 0;
	}

	if (argv.length === 1 && argv[0] === "manifest") {
		process.stdout.write(`${JSON.stringify(createManifest(version()))}\n`);
		return 0;
	}

	if (argv.length === 1 && argv[0] === "docs") {
		const text = await docs();
		if (text.isErr()) return fail(text.error);
		process.stdout.write(text.value);
		return 0;
	}

	if (argv[0] === "auth" && argv[1] === "status") {
		return runAuthStatus(argv.slice(2));
	}

	// ADR-0009 §8: `cache` is not a resource and `info` / `clear` are not verbs of
	// the grammar, so both are named exceptions wired here. Neither resolves a
	// credential and neither makes a request (ADR-0005 §7).
	if (argv[0] === "cache") {
		const verb = argv[1];
		if (!isCacheVerb(verb)) {
			return fail(
				pdError({
					code: "usage",
					message:
						`pd cache takes one of: ${CACHE_VERBS.join(", ")}. ` +
						"Both are local and make no request to Pipedrive.",
				}),
			);
		}
		return cacheCommand({
			verb,
			argv: argv.slice(2),
			platform: process.platform,
			env: process.env,
			home: homedir(),
		});
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
const ProcessArgv = z.array(z.string());
const parsedArgv = ProcessArgv.safeParse(process.argv.slice(2));
const running = parsedArgv.success
	? main(parsedArgv.data)
	: Promise.resolve(
			fail(
				pdError({
					code: "usage",
					message: "pd received command arguments it cannot read.",
				}),
			),
		);

running.then(
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
