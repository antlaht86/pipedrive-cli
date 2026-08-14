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
		const found = resource.commands.find((candidate) => candidate.name === name);
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
		expect(manifest.vocabularies.error_codes.some(({ code }) => code === "unknown_command" as never)).toBe(false);
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
			instruction: expect.stringContaining("Never invoke --pretty from an agent"),
		});
		expect(manifest.command_flags.find(({ name }) => name === "--filter-id <n>")).toMatchObject({ enumerable: false });
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
		expect(JSON.stringify(manifest)).not.toContain("request_cost");
		expect(JSON.stringify(manifest)).not.toMatch(/[0-9a-f]{40}/i);
	});

	test("selectable fields are taken from the same runtime schemas", () => {
		for (const name of ["deals", "persons", "organizations", "activities", "products"]) {
			const resource = resourceNamed(name);
			expect(command(`pd ${name} list`).selectable_fields).toEqual(resource?.fields.map((field) => resource.rename[field] ?? field));
			expect(command(`pd ${name} get`).selectable_fields).toEqual(resource?.fields.map((field) => resource.rename[field] ?? field));
		}
		for (const name of ["users", "pipelines", "stages"]) {
			const source = cachedResourceNamed(name)?.source();
			expect(command(`pd ${name} list`).selectable_fields).toEqual(source?.fields);
		}
		for (const name of ["deals", "persons", "organizations", "products", "items"]) {
			expect(command(`pd ${name} search`).selectable_fields).toEqual(searchNamed(name)?.fields);
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
			resources: COMMAND_TABLE.resources.map((resource, index) =>
				index === 0 ? { ...resource, description: "Changed once" } : resource,
			),
		};

		expect(JSON.stringify(createManifest("1.0.0", changed))).toContain("Changed once");
		expect(renderHelp([], changed)).toContain("Changed once");
	});
});

test("root and command help are generated from the table", () => {
	const root = renderHelp([]);
	expect(root.startsWith("pd is read-only. It issues GET requests only. It cannot create, update or delete anything in Pipedrive.\n")).toBe(true);
	expect(root).toContain("\nRESOURCES\n");
	expect(root).toContain("\nOTHER\n");
	expect(renderHelp(["deals", "list"])).toContain("USAGE\n  pd deals list [flags]");
	expect(renderHelp(["fields", "list"])).toContain(
		"SELECTABLE FIELDS BY --ENTITY\n  deal: field_name, field_code",
	);
	expect(renderHelp(["cache", "clear"])).toContain("pd cache clear");
});
