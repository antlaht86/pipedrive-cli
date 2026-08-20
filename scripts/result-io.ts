import {
	existsSync,
	mkdtempSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
	type WriteFileOptions,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import {
	err,
	errAsync,
	Result,
	ResultAsync,
	type Result as ResultType,
} from "neverthrow";

const message = (operation: string, cause: unknown): string =>
	`${operation}: ${String(cause)}`;

export const readText = Result.fromThrowable(
	(path: string) => readFileSync(path, "utf8"),
	(cause) => message("read failed", cause),
);

export const fileExists = Result.fromThrowable(
	(path: string) => existsSync(path),
	(cause) => message("existence check failed", cause),
);

export const readBytes = Result.fromThrowable(
	(path: string) => readFileSync(path),
	(cause) => message("read failed", cause),
);

export const writeText = Result.fromThrowable(
	(path: string, text: string, options?: WriteFileOptions) =>
		writeFileSync(path, text, options),
	(cause) => message("write failed", cause),
);

export const makeDirectory = Result.fromThrowable(
	(path: string) => mkdirSync(path, { recursive: true }),
	(cause) => message("directory creation failed", cause),
);

export type SpawnOptions = {
	cwd?: string;
	env?: Record<string, string | undefined>;
};

export const runProcessSync = Result.fromThrowable(
	(command: string[], options?: SpawnOptions) =>
		Bun.spawnSync(command, options),
	(cause) => message("process launch failed", cause),
);

export const homeDirectory = Result.fromThrowable(
	() => homedir(),
	(cause) => message("home-directory lookup failed", cause),
);

export const writeStdout = Result.fromThrowable(
	(text: string | Uint8Array) => process.stdout.write(text),
	(cause) => message("stdout write failed", cause),
);

export const writeStderr = Result.fromThrowable(
	(text: string | Uint8Array) => process.stderr.write(text),
	(cause) => message("stderr write failed", cause),
);

const makeTempDirectory = Result.fromThrowable(
	(prefix: string) => mkdtempSync(join(tmpdir(), prefix)),
	(cause) => message("temporary directory creation failed", cause),
);

const removeDirectory = Result.fromThrowable(
	(path: string) => rmSync(path, { recursive: true, force: true }),
	(cause) => message("temporary directory cleanup failed", cause),
);

const workFailure = (cause: unknown): string =>
	message("temporary-directory work failed", cause);

/** Run synchronous Result-based work with cleanup on both Ok and Err. */
export const withTempDirectory = <Value>(
	prefix: string,
	work: (path: string) => ResultType<Value, string>,
): ResultType<Value, string> =>
	makeTempDirectory(prefix).andThen((path) => {
		const started = Result.fromThrowable(work, workFailure)(path);
		const result = started.isErr() ? err(started.error) : started.value;
		const cleanup = removeDirectory(path);
		if (cleanup.isErr()) return err(cleanup.error);
		return result;
	});

/** Run asynchronous Result-based work with cleanup on both Ok and Err. */
export const withTempDirectoryAsync = <Value>(
	prefix: string,
	work: (path: string) => ResultAsync<Value, string>,
): ResultAsync<Value, string> =>
	makeTempDirectory(prefix).asyncAndThen((path) => {
		const started = Result.fromThrowable(work, workFailure)(path);
		if (started.isErr()) {
			const cleanup = removeDirectory(path);
			return cleanup.isErr()
				? errAsync(cleanup.error)
				: errAsync(started.error);
		}
		const awaited = ResultAsync.fromPromise(
			Promise.resolve(started.value),
			workFailure,
		);
		const clean = (
			result: ResultType<Value, string>,
		): ResultType<Value, string> => removeDirectory(path).andThen(() => result);
		return awaited.andThen(clean).orElse((cause) => clean(err(cause)));
	});
