/**
 * `pd auth whoami` — ADR-0033.
 *
 * The second command in the `auth` subtree, and the one whose grammar differs
 * from its sibling's. `pd auth status` describes a configuration without using
 * it: zero network requests, one JSON object, exit 0 or 2 and never 1. `whoami`
 * **uses** the credential, which makes it a data command and hands it
 * ADR-0012 §7 unamended — a missing, dead or revoked credential is `auth`, exit
 * 1; no network is `upstream`, exit 1; a spent burst window or daily budget is
 * `rate_limited` or `budget_exhausted`, exit 3. No new exit-code rule is written
 * here, and none is needed.
 *
 * A `--live` flag on `status` was rejected in its place: one command with two
 * output shapes and two exit surfaces selected by a flag is the hardest contract
 * for an agent to read (ADR-0033 §1).
 *
 * ## Why it goes through `begin()`
 *
 * Because everything before the request is the same as every other data command:
 * the parse, the request gate, the writer that every failure below it is
 * reported through, the credential chain and its warnings, and the `blocked`
 * sentinel. `whoami` is the command most likely to be the first one a fresh
 * machine runs, so it is the last one that should reach the network by a private
 * path.
 *
 * ## Which flags exist, and why the rest do not
 *
 * `--pretty`, `--fields`, `--token-file`, `--max-requests` and `--verbose`.
 *
 * `--limit` and `--resolve` are absent because a one-record stream has nothing
 * to bound and no sibling field to resolve. `--no-cache` is absent because
 * `whoami` never reads a cache entry, so the flag would have nothing to skip
 * (ADR-0033 §6) — and a flag that does nothing is a flag an agent spends a turn
 * discovering does nothing. `--resolve-budget` follows `--resolve` out.
 */

import { identityOf } from "../lib/auth/credentials.ts";
import { createProjection, projectPages } from "../lib/output/projection.ts";
import { stream } from "../lib/output/stream.ts";
import {
	WHOAMI_FIELDS,
	WHOAMI_RECORD_TYPE,
	whoamiPages,
} from "../lib/pipedrive/whoami.ts";
import type { Flag } from "./arguments.ts";
import { begin, type CommandInput } from "./prologue.ts";

export const WHOAMI_COMMAND = "pd auth whoami";

/**
 * The list lives here rather than in the command table, and the table imports
 * it: the parser and the manifest then cannot disagree about what this command
 * accepts, and the table already depends on this direction elsewhere.
 */
export const WHOAMI_PARSER_FLAGS: readonly Flag[] = [
	"pretty",
	"token-file",
	"max-requests",
	"verbose",
	"fields",
];

export const whoamiCommand = async (input: CommandInput): Promise<number> => {
	const started = begin({
		...input,
		command: WHOAMI_COMMAND,
		flags: WHOAMI_PARSER_FLAGS,
		positional: "none",
		recordType: WHOAMI_RECORD_TYPE,
		// Selector names come from the local record schema, so a typo is refused
		// before the credential is resolved and before anything is dispatched.
		resolve: (flags) => createProjection(flags.fields, WHOAMI_FIELDS),
	});
	if (started.isErr()) return started.error;

	const { resolved: projection, writer, client, credential } = started.value;

	return stream(
		projectPages(
			whoamiPages({ client, identity: identityOf(credential) }),
			projection,
		),
		writer,
	);
};
