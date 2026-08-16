/** Unstable human-only rendering for `--pretty`. Nothing here is a contract. */

const RESOLVED_BY_RAW: Readonly<Record<string, string>> = {
	owner_id: "owner_name",
	creator_user_id: "creator_user_name",
	user_id: "user_name",
	person_id: "person_name",
	org_id: "org_name",
	pipeline_id: "pipeline_name",
	stage_id: "stage_name",
};

const RAW_BY_RESOLVED: Readonly<Record<string, string>> = Object.fromEntries([
	...Object.entries(RESOLVED_BY_RAW).map(([raw, resolved]) => [resolved, raw]),
	["custom_fields_resolved", "custom_fields"],
]);

const oneLine = (value: string): string => value.replace(/[\r\n]+/g, " ");

const humanValue = (value: unknown): string => {
	if (value === undefined || value === null) return "";
	if (typeof value === "string") return oneLine(value);
	if (typeof value === "number" || typeof value === "bigint") {
		return String(value);
	}
	if (typeof value === "boolean") return value ? "yes" : "no";
	if (Array.isArray(value)) return value.map(humanValue).join(", ");
	if (typeof value === "object") {
		return Object.entries(value as Record<string, unknown>)
			.map(([key, nested]) => `${key}=${humanValue(nested)}`)
			.join(", ");
	}
	return oneLine(String(value));
};

const customValue = (
	record: Readonly<Record<string, unknown>>,
	hash: string,
	replaceResolved: boolean,
): unknown => {
	if (replaceResolved) {
		const resolved = record["custom_fields_resolved"];
		if (
			resolved !== null &&
			typeof resolved === "object" &&
			!Array.isArray(resolved)
		) {
			const value = (resolved as Record<string, unknown>)[hash];
			if (value !== undefined) return value;
		}
	}
	const raw = record["custom_fields"];
	return raw !== null && typeof raw === "object" && !Array.isArray(raw)
		? (raw as Record<string, unknown>)[hash]
		: undefined;
};

const valueOf = (
	record: Readonly<Record<string, unknown>>,
	column: string,
	replaceResolved: boolean,
): unknown => {
	if (column.startsWith("custom_fields.")) {
		return customValue(
			record,
			column.slice("custom_fields.".length),
			replaceResolved,
		);
	}
	if (column === "custom_fields") {
		const raw = record[column];
		if (
			!replaceResolved ||
			raw === null ||
			typeof raw !== "object" ||
			Array.isArray(raw)
		) {
			return raw;
		}
		return Object.fromEntries(
			Object.keys(raw as Record<string, unknown>).map((hash) => [
				hash,
				customValue(record, hash, true),
			]),
		);
	}
	const artifact = RESOLVED_BY_RAW[column];
	return replaceResolved &&
		artifact !== undefined &&
		record[artifact] !== undefined
		? record[artifact]
		: record[column];
};

const columnsOf = (
	records: readonly Readonly<Record<string, unknown>>[],
	selected: readonly string[] | undefined,
	replaceResolved: boolean,
): string[] => {
	const columns: string[] = [];
	const seen = new Set<string>();
	const add = (column: string): void => {
		const raw = RAW_BY_RESOLVED[column];
		const replaced =
			replaceResolved &&
			raw !== undefined &&
			records.some((record) => record[raw] !== undefined);
		if (replaced || seen.has(column)) return;
		seen.add(column);
		columns.push(column);
	};

	if (selected !== undefined) {
		for (const column of selected) add(column);
	}
	for (const identity of ["id", "field_code"]) {
		if (records.some((record) => record[identity] !== undefined)) add(identity);
	}
	if (selected !== undefined) return columns;
	for (const record of records) {
		for (const column of Object.keys(record)) add(column);
	}
	return columns;
};

export const renderTable = (
	records: readonly Readonly<Record<string, unknown>>[],
	selected?: readonly string[],
	replaceResolved = false,
): string => {
	if (records.length === 0) return "(no records)\n";
	const columns = columnsOf(records, selected, replaceResolved);
	const rows = records.map((record) =>
		columns.map((column) =>
			humanValue(valueOf(record, column, replaceResolved)),
		),
	);
	const widths = columns.map((column, index) =>
		Math.max(column.length, ...rows.map((row) => row[index]?.length ?? 0)),
	);
	const line = (cells: readonly string[]): string =>
		cells
			.map((cell, index) =>
				index === cells.length - 1
					? cell
					: cell.padEnd(widths[index] ?? cell.length),
			)
			.join("  ")
			.trimEnd();
	return `${[line(columns), ...rows.map(line)].join("\n")}\n`;
};

export const renderObjectTable = (
	object: Readonly<Record<string, unknown>>,
	fields: readonly string[],
): string =>
	renderTable(
		fields.map((field) => ({ field, value: object[field] })),
		["field", "value"],
	);
