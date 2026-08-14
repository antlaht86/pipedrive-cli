import { err, ok, type Result } from "neverthrow";
import { z } from "zod";

import { pdError, type PdError } from "../errors.ts";

export const DEAL_STATUSES = ["open", "won", "lost", "deleted"] as const;
export const SORT_FIELDS = [
	"id",
	"update_time",
	"add_time",
	"due_date",
	"name",
] as const;

export const SortField = z.enum(SORT_FIELDS);
export type SortField = z.infer<typeof SortField>;

const FilterArguments = z.object({
	ids: z.array(z.int()).optional(),
	"owner-id": z.int().optional(),
	"person-id": z.int().optional(),
	"org-id": z.int().optional(),
	"deal-id": z.int().optional(),
	"pipeline-id": z.int().optional(),
	"stage-id": z.int().optional(),
	"filter-id": z.int().optional(),
	status: z.enum(DEAL_STATUSES).optional(),
	done: z.boolean().optional(),
	"not-done": z.boolean().optional(),
	"updated-since": z.string().optional(),
	"updated-until": z.string().optional(),
	"sort-by": SortField.optional(),
	"sort-direction": z.enum(["asc", "desc"]).optional(),
});

export type ListFilterFlag = keyof z.infer<typeof FilterArguments>;

type FilterArguments = z.infer<typeof FilterArguments>;

const toListFilters = (flags: FilterArguments) => ({
	...(flags.ids === undefined ? {} : { ids: flags.ids }),
	...(flags["owner-id"] === undefined ? {} : { ownerId: flags["owner-id"] }),
	...(flags["person-id"] === undefined ? {} : { personId: flags["person-id"] }),
	...(flags["org-id"] === undefined ? {} : { orgId: flags["org-id"] }),
	...(flags["deal-id"] === undefined ? {} : { dealId: flags["deal-id"] }),
	...(flags["pipeline-id"] === undefined
		? {}
		: { pipelineId: flags["pipeline-id"] }),
	...(flags["stage-id"] === undefined ? {} : { stageId: flags["stage-id"] }),
	...(flags.status === undefined ? {} : { status: flags.status }),
	...(flags.done === true ? { done: true } : {}),
	...(flags["not-done"] === true ? { done: false } : {}),
	...(flags["updated-since"] === undefined
		? {}
		: { updatedSince: flags["updated-since"] }),
	...(flags["updated-until"] === undefined
		? {}
		: { updatedUntil: flags["updated-until"] }),
	...(flags["sort-by"] === undefined ? {} : { sortBy: flags["sort-by"] }),
	...(flags["sort-direction"] === undefined
		? {}
		: { sortDirection: flags["sort-direction"] }),
	...(flags["filter-id"] === undefined ? {} : { filterId: flags["filter-id"] }),
});

const ListFilters = FilterArguments.transform(toListFilters);
export type ListFilters = z.infer<typeof ListFilters>;

export type ListFilterRules = {
	name: string;
	sortFields: readonly SortField[];
};

const schemaFor = (rules: ListFilterRules) =>
	FilterArguments.superRefine((flags, context) => {
		if (flags.ids !== undefined && flags["filter-id"] !== undefined) {
			context.addIssue({
				code: "custom",
				message:
					"--ids and --filter-id cannot be used together; Pipedrive would ignore --ids.",
			});
		}
		if (flags.done === true && flags["not-done"] === true) {
			context.addIssue({
				code: "custom",
				message: "--done and --not-done cannot be used together.",
			});
		}
		if (
			flags["sort-by"] !== undefined &&
			!rules.sortFields.includes(flags["sort-by"])
		) {
			context.addIssue({
				code: "custom",
				path: ["sort-by"],
				message:
					`pd ${rules.name} list cannot sort by '${flags["sort-by"]}'. ` +
					`--sort-by takes one of: ${rules.sortFields.join(", ")}.`,
			});
		}
	}).transform(toListFilters);

export const parseListFilters = (
	rules: ListFilterRules,
	flags: unknown,
): Result<ListFilters, PdError> => {
	const parsed = schemaFor(rules).safeParse(flags);
	return parsed.success
		? ok(parsed.data)
		: err(
				pdError({
					code: "usage",
					message: parsed.error.issues.map((issue) => issue.message).join(" "),
				}),
			);
};
