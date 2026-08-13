import { describe, expect, test } from "bun:test";

/**
 * Read-only layer (d), ADR-0013 §2 — the gate that outlives the other layers.
 *
 * Layers (a) and (b) can be removed by an edit; this test is what notices. It
 * asserts against the **committed** generated output rather than regenerating,
 * so it fails on the change that introduced a write operation and not on the day
 * Pipedrive edits its published spec.
 *
 * A failure here blocks the merge. It is not a warning: the safety property must
 * not depend on somebody reading a log.
 */

const GENERATED_SDKS = {
  v2: "src/lib/pipedrive/v2/generated/sdk.gen.ts",
  v1: "src/lib/pipedrive/v1/generated/sdk.gen.ts",
} as const;

/** Every generated operation is `client.<method><...>(...)`. */
const countCalls = (source: string, method: string): number =>
  source.match(new RegExp(`\\.${method}<`, "g"))?.length ?? 0;

const WRITE_METHODS = ["post", "put", "patch", "delete", "head", "options"];

const readSdk = async (path: string): Promise<string> => {
  const file = Bun.file(path);
  expect(await file.exists()).toBe(true);
  return await file.text();
};

describe("the write-method detector", () => {
  // The gate is only worth having if it fires, so it is exercised against a
  // synthetic regression before it is pointed at the real output.
  const reintroduced = `export const addDeal = <ThrowOnError extends boolean = false>(
    options: Options<AddDealData, ThrowOnError>
  ) => options.client.post<AddDealResponses, unknown, ThrowOnError>({ url: '/deals' });`;

  test("counts a reintroduced write operation", () => {
    expect(countCalls(reintroduced, "post")).toBe(1);
  });

  test("does not count a GET", () => {
    expect(countCalls("options.client.get<A, B, C>({})", "post")).toBe(0);
  });
});

describe.each(Object.entries(GENERATED_SDKS))("the generated %s client", (_version, path) => {
  test.each(WRITE_METHODS)("contains zero .%s< operations", async (method) => {
    expect(countCalls(await readSdk(path), method)).toBe(0);
  });

  test("contains GET operations, so the filter did not empty the output", async () => {
    expect(countCalls(await readSdk(path), "get")).toBeGreaterThan(0);
  });

  // `sdk.client: false`, ADR-0013 §1. The generated SDK must hold no ambient
  // client, so calling an operation without the client the wrapper built is a
  // compile error rather than a convention. `client.gen.ts` does construct one
  // with a bare `baseUrl` and no guarded fetch; nothing may import it.
  test("imports no client instance, so every call must be handed one", async () => {
    expect(await readSdk(path)).not.toContain("./client.gen");
  });
});

/**
 * Read-only layer (c). `bun run lint` in CI is what stops a new import of the
 * generated SDK from outside the client module — but a lint run passes just as
 * quietly when the rule has been deleted. This drives a forbidden import through
 * ESLint and asserts it is refused, so the rule's absence is a failure too.
 */
describe("the no-restricted-imports ban on the generated SDK", () => {
  const lint = async (source: string, filename: string): Promise<string> => {
    const proc = Bun.spawn(["bunx", "eslint", "--stdin", "--stdin-filename", filename], {
      stdin: new TextEncoder().encode(source),
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    await proc.exited;
    return stdout + stderr;
  };

  const IMPORT = "import { getUsers } from './lib/pipedrive/v1/generated/sdk.gen.ts';\n";

  test("refuses the import from outside the client module", async () => {
    const output = await lint(IMPORT + "console.log(getUsers);\n", "src/probe.ts");
    expect(output).toContain("no-restricted-imports");
  }, 30_000);

  test("permits the import inside the client module", async () => {
    const source = "import { getUsers } from './v1/generated/sdk.gen.ts';\nconsole.log(getUsers);\n";
    const output = await lint(source, "src/lib/pipedrive/probe.ts");
    expect(output).not.toContain("no-restricted-imports");
  }, 30_000);
});

describe("the v1 client", () => {
  test("holds exactly one operation, getUsers", async () => {
    const source = await readSdk(GENERATED_SDKS.v1);
    const operations = source.match(/^export const (\w+)/gm) ?? [];
    expect(operations).toEqual(["export const getUsers"]);
  });
});
