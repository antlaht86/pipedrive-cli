import { describe, expect, test } from "bun:test";

import {
	COMMAND_TABLE,
	createManifest,
	renderHelp,
} from "../src/command-table.ts";
import { ERROR_CODES, exitCodeFor, retryFor } from "../src/lib/errors.ts";
import { WARNING_KINDS } from "../src/lib/warnings.ts";
import { resourceNamed } from "../src/lib/pipedrive/resources.ts";
import { cachedResourceNamed, ENTITIES } from "../src/lib/pipedrive/cached.ts";
import { searchNamed } from "../src/lib/pipedrive/searches.ts";

const command = (name: string) => {
	for (const resource of COMMAND_TABLE.resources) {
		const found = resource.commands.find(
			(candidate) => candidate.name === name,
		);
		if (found !== undefined) return found;
	}
	throw new Error(`missing command ${name}`);
};

describe("the command table generates the manifest contract", () => {
	test("enumerates commands, fields, flags and branching vocabularies", () => {
		const manifest = createManifest("1.0.0+gabc123");

		expect(manifest.manifest_version).toBe(1);
		expect(manifest.pd_version).toBe("1.0.0+gabc123");
		expect(manifest.read_only).toBe(true);
		expect(manifest.read_only_scope).toBe("pipedrive_api");
		expect(manifest.output_format).toBe("ndjson");
		expect(manifest.trailer_fields).toEqual([
			"complete",
			"emitted",
			"skipped",
			"duplicates",
			"resolved",
			"requests",
		]);
		expect(manifest.vocabularies).toEqual({
			line_types: ["record", "warning", "summary", "error"],
			warning_kinds: [...WARNING_KINDS],
			resolved: ["off", "partial", "full"],
			exit_codes: [0, 1, 2, 3],
			error_codes: ERROR_CODES.map((code) => ({
				code,
				exit_code: exitCodeFor(code),
				retry: retryFor(code),
			})),
		});
		expect(
			manifest.vocabularies.error_codes.some(
				({ code }) => code === ("unknown_command" as never),
			),
		).toBe(false);
		expect(manifest.global_flags.map(({ name }) => name)).toEqual([
			"--pretty",
			"--no-cache",
			"--max-requests <n>",
			"--limit <n>",
			"--resolve",
			"--resolve-budget <n>",
			"--token-file <path>",
			"--verbose",
			"--fields <a,b>",
		]);
		expect(manifest.global_flags[0]).toMatchObject({
			machine_readable: false,
			instruction: expect.stringContaining(
				"Never invoke --pretty from an agent",
			),
		});
		expect(
			manifest.command_flags.find(({ name }) => name === "--filter-id <n>"),
		).toMatchObject({ enumerable: false });
		expect(manifest.non_ndjson_stdout).toEqual([
			"--help",
			"pd manifest",
			"pd auth status",
			"pd cache info",
			"pd docs",
			"pd --version",
		]);
		expect(manifest.commands.other.map(({ name }) => name)).toEqual([
			"pd manifest",
			"pd cache info",
			"pd cache clear",
			"pd auth status",
			"pd docs",
		]);
		expect(command("pd deals list").flag_values).toMatchObject({
			"--sort-by <field>": ["id", "update_time", "add_time"],
			"--status <name>": ["open", "won", "lost", "deleted"],
		});
		expect(command("pd items search").flag_values).toMatchObject({
			"--types <a,b>": ["deal", "person", "organization", "product"],
		});
		expect(JSON.stringify(manifest)).not.toContain("request_cost");
		expect(JSON.stringify(manifest)).not.toMatch(/[0-9a-f]{40}/i);
	});

	/**
	 * Two things ticket 16 requires the manifest **not** to carry. Both would be
	 * added in good faith — a request cost looks like exactly the thing an agent
	 * wants to plan against, and a hash looks like a selectable field — so they
	 * are asserted over the serialised whole rather than at the one key someone
	 * would think to check.
	 *
	 * A per-command cost would be a lie on a warm cache: `pd users get 42` costs
	 * zero requests there and one when the entry expires. A custom-field hash is
	 * per-account, so publishing one in a binary shared between accounts would
	 * make the manifest wrong for every account but the one it was built beside;
	 * `pd fields list` is how a caller learns them.
	 */
	test("carries no per-command request cost and no custom-field hash", () => {
		const manifest = createManifest("1.0.0+gabc123");
		const serialised = JSON.stringify(manifest);

		expect(serialised).not.toMatch(/[0-9a-f]{40}/i);

		const costKeys: string[] = [];
		const walk = (node: unknown, path: string): void => {
			if (Array.isArray(node)) {
				node.forEach((item, index) => walk(item, `${path}[${index}]`));
				return;
			}
			if (node === null || typeof node !== "object") return;
			for (const [key, value] of Object.entries(node)) {
				if (/cost|requests/i.test(key)) costKeys.push(`${path}.${key}`);
				walk(value, `${path}.${key}`);
			}
		};
		walk(manifest, "$");
		expect(costKeys).toEqual([]);
	});

	test("the two user admin booleans are selectable", () => {
		// Ticket 27: they are derived rather than sent, so nothing about the wire
		// would put them in the vocabulary — the record schema has to carry them.
		for (const verb of ["list", "get"]) {
			expect(command(`pd users ${verb}`).selectable_fields).toEqual(
				expect.arrayContaining(["is_global_admin", "is_deal_admin"]),
			);
		}
	});

	test("the users list filter is published with both its values", () => {
		// Ticket 28: `--admin` exists on `list` alone, and the two values it takes
		// are the answer to "which admin" rather than free text.
		expect(command("pd users list").flags).toContain("--admin <role>");
		expect(command("pd users list").flag_values).toMatchObject({
			"--admin <role>": ["global", "deal"],
		});
		expect(command("pd users get").flags).not.toContain("--admin <role>");
	});

	test("selectable fields are taken from the same runtime schemas", () => {
		for (const name of [
			"deals",
			"persons",
			"organizations",
			"activities",
			"products",
		]) {
			const resource = resourceNamed(name);
			expect(command(`pd ${name} list`).selectable_fields).toEqual(
				resource?.fields.map((field) => resource.rename[field] ?? field),
			);
			expect(command(`pd ${name} get`).selectable_fields).toEqual(
				resource?.fields.map((field) => resource.rename[field] ?? field),
			);
		}
		for (const name of ["users", "pipelines", "stages"]) {
			const source = cachedResourceNamed(name)?.source();
			expect(command(`pd ${name} list`).selectable_fields).toEqual(
				source?.fields,
			);
		}
		for (const name of [
			"deals",
			"persons",
			"organizations",
			"products",
			"items",
		]) {
			expect(command(`pd ${name} search`).selectable_fields).toEqual(
				searchNamed(name)?.fields,
			);
		}
		const fields = command("pd fields list");
		for (const entity of ENTITIES) {
			expect(fields.selectable_fields_by_entity?.[entity]).toEqual(
				cachedResourceNamed("fields")?.source(entity)?.fields,
			);
		}
	});

	test("changing one table entry changes both manifest and help", () => {
		const changed = {
			...COMMAND_TABLE,
			globalFlags: COMMAND_TABLE.globalFlags.map((flag, index) =>
				index === 0 ? { ...flag, instruction: "Changed global flag" } : flag,
			),
			resources: COMMAND_TABLE.resources.map((resource, index) =>
				index === 0 ? { ...resource, description: "Changed once" } : resource,
			),
		};

		const changedManifest = JSON.stringify(createManifest("1.0.0", changed));
		expect(changedManifest).toContain("Changed once");
		expect(changedManifest).toContain("Changed global flag");
		expect(renderHelp([], changed)).toContain("Changed once");
		expect(renderHelp([], changed)).toContain("Changed global flag");
	});
});

test("root and command help are generated from the table", () => {
	const root = renderHelp([]);
	expect(
		root.startsWith(
			"pd is read-only. It issues GET requests only. It cannot create, update or delete anything in Pipedrive.\n",
		),
	).toBe(true);
	expect(root).toContain("administrator's token");
	expect(root).toContain("fully privileged credential");
	expect(root).toContain("safety rests on its own correctness");
	expect(root).toContain("\nRESOURCES\n");
	expect(root).toContain("\nOTHER\n");
	const dealsHelp = renderHelp(["deals", "list"]);
	expect(dealsHelp).toContain("USAGE\n  pd deals list [flags]");
	expect(dealsHelp).toContain("--pretty");
	expect(dealsHelp).toContain("unstable human-readable output");
	expect(dealsHelp).toContain("Never invoke --pretty from an agent");
	expect(dealsHelp).toContain("--verbose");
	expect(dealsHelp).toContain("--sort-by <field> (id, update_time, add_time)");
	expect(renderHelp(["users", "list"])).toContain(
		"--admin <role> (global, deal)",
	);
	expect(renderHelp(["stages", "list"])).toContain("--pipeline-id <n>");
	expect(renderHelp(["fields", "list"])).toContain(
		"SELECTABLE FIELDS BY --ENTITY\n  deal: field_name, field_code",
	);
	expect(renderHelp(["cache", "clear"])).toContain("pd cache clear");
});
