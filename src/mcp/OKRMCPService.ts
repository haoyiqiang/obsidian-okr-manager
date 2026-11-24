import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import type { OKRManager } from "../manager/OKRManager";
import type {
	Confidence,
	InitialKeyResult,
	KRUnit,
	KeyResult,
	OKRPeriodType,
	OKRStatus,
	Objective,
} from "../types";
import { currentPeriod, periodDue, todayLocalDate } from "./periods";

const OKR_STATUS = z.enum(["active", "completed", "cancelled", "on-hold"]);
const CONFIDENCE = z.enum(["low", "medium", "high"]);
const UNIT = z.enum(["score", "percentage", "number", "boolean"]);
const PERIOD_TYPE = z.enum(["week", "month", "quarter", "year"]);

interface HTTPRequestLike {
	method?: string;
	headers: Record<string, unknown>;
}

interface HTTPResponseLike {
	writeHead(status: number, headers?: Record<string, string>): void;
	end(body?: string): void;
}

type JsonRpcBody = Record<string, unknown> & { method?: string; params?: unknown };

/**
 * MCP server exposing OKR objectives and key results over the Streamable HTTP
 * transport in stateless mode. Reuses OKRManager for every mutation so the
 * plugin's own period locks, cache invalidation, and file format stay the
 * single source of truth.
 *
 * Task management is intentionally out of scope: TaskNotes owns tasks.
 */
export class OKRMCPService {
	constructor(
		private readonly manager: OKRManager,
		private readonly settings: OKRPluginSettingsLike,
		private readonly version: string,
	) {}

	async handleRequest(
		req: HTTPRequestLike,
		res: HTTPResponseLike,
		parsedBody: JsonRpcBody,
	): Promise<void> {
		if (req.method !== "POST") {
			res.writeHead(405, { Allow: "POST" });
			res.end(
				JSON.stringify({
					jsonrpc: "2.0",
					error: { code: -32000, message: "Method not allowed" },
					id: null,
				}),
			);
			return;
		}

		try {
			const transport = new StreamableHTTPServerTransport({
				sessionIdGenerator: undefined,
			});
			const server = new McpServer({ name: "okr", version: this.version });
			this.registerTools(server);

			await server.connect(transport);
			await transport.handleRequest(req as never, res as never, parsedBody);
			await transport.close();
			await server.close();
		} catch (error: unknown) {
			console.error("[okr-mcp] request failed", error);
			if (!res.writeHead || !res.end) return;
			res.writeHead(500, { "Content-Type": "application/json" });
			res.end(
				JSON.stringify({
					jsonrpc: "2.0",
					error: { code: -32603, message: this.getErrorMessage(error) },
					id: null,
				}),
			);
		}
	}

	private getErrorMessage(error: unknown): string {
		return error instanceof Error ? error.message : String(error);
	}

	private jsonResult(data: unknown) {
		return {
			content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
		};
	}

	private errorResult(message: string) {
		return {
			content: [{ type: "text" as const, text: JSON.stringify({ error: message }) }],
			isError: true,
		};
	}

	/** Wrap a handler so thrown errors become MCP error results. */
	private handle<T>(run: (args: T) => Promise<unknown>) {
		return async (args: T) => {
			try {
				return this.jsonResult(await run(args));
			} catch (error: unknown) {
				return this.errorResult(this.getErrorMessage(error));
			}
		};
	}

	private registerTools(server: McpServer): void {
		const tool = server.registerTool.bind(server) as never as (
			name: string,
			config: { description: string; inputSchema: Record<string, unknown> },
			handler: (args: never) => Promise<unknown>,
		) => void;

		tool(
			"okr_list_periods",
			{
				description:
					"List every OKR period that exists in the vault, with objective counts and status.",
				inputSchema: {},
			},
			this.handle(async () => {
				const infos = await this.manager.getPeriodInfos({ includeArchived: true });
				const out = [];
				for (const info of infos) {
					const objectives = await this.manager.getObjectives(info.period);
					out.push({
						period: info.period,
						periodType: info.periodType,
						status: info.status,
						objectiveCount: objectives.length,
					});
				}
				return { currentPeriod: currentPeriod(this.periodType()), periods: out };
			}),
		);

		tool(
			"okr_list_objectives",
			{
				description:
					"List objectives for one period (defaults to the current period) with their key results. Use this instead of reading OKR markdown files.",
				inputSchema: {
					period: z
						.string()
						.optional()
						.describe("OKR period such as '2026-Q4'. Defaults to the current period."),
				},
			},
			this.handle(async ({ period }: { period?: string }) => {
				const target = await this.resolvePeriod({ period });
				const objectives = await this.manager.getObjectives(target);
				return { period: target, objectives: objectives.map((objective) => summarizeObjective(objective)) };
			}),
		);

		tool(
			"okr_get_objective",
			{
				description:
					"Get one objective with its full key result detail, including progress and check-in counts.",
				inputSchema: {
					objectiveId: z.string().describe("Objective id such as 'O1'"),
					period: z.string().optional().describe("Skip if you do not know the period"),
				},
			},
			this.handle(async ({ objectiveId, period }: { objectiveId: string; period?: string }) => {
				const { objective } = await this.findObjective(objectiveId, period);
				return summarizeObjective(objective, true);
			}),
		);

		tool(
			"okr_create_objective",
			{
				description:
					"Create an objective, optionally with its key results in the same call. The id is assigned by the plugin. Requires a title; description should explain the bet behind the objective.",
				inputSchema: {
					title: z.string().describe("Qualitative direction, no numbers"),
					period: z.string().optional().describe("Defaults to the current period"),
					periodType: PERIOD_TYPE.optional().describe("Defaults to the plugin setting"),
					description: z.string().optional().describe("Why this objective, what is being bet"),
					owner: z.string().optional(),
					due: z.string().optional().describe("YYYY-MM-DD, defaults to the end of the period"),
					keyResults: z
						.array(
							z.object({
								title: z.string(),
								description: z.string().optional(),
								owner: z.string().optional(),
								unit: UNIT.optional(),
								weight: z.number().positive().optional(),
								current: z.number().min(0).optional(),
								target: z.number(),
								confidence: CONFIDENCE.optional(),
								due: z.string().optional(),
							}),
						)
						.optional()
						.describe("Key results to create with the objective"),
				},
			},
			this.handle(
				async (args: {
					title: string;
					period?: string;
					periodType?: OKRPeriodType;
					description?: string;
					owner?: string;
					due?: string;
					keyResults?: Partial<InitialKeyResult>[];
				}) => {
					const periodType = args.periodType ?? this.periodType();
					const period = args.period ?? currentPeriod(periodType);
					const due = args.due ?? periodDue(period, periodType);
					if (!due) throw new Error(`无法从周期 ${period} 推算截止日期，请显式传 due`);
					const initialKeyResults: InitialKeyResult[] = (args.keyResults ?? []).map(
						(draft) => ({
							title: draft.title ?? "",
							description: draft.description ?? "",
							owner: draft.owner ?? "",
							unit: draft.unit ?? "number",
							weight: draft.weight ?? 1,
							current: draft.current ?? 0,
							target: draft.target ?? 1,
							confidence: draft.confidence ?? "medium",
							due: draft.due ?? due,
						}),
					);
					const objective = await this.manager.createObjective(
						{
							period,
							periodType,
							title: args.title,
							description: args.description ?? "",
							owner: args.owner ?? "",
							status: "active",
							created: todayLocalDate(),
							due,
						},
						initialKeyResults,
					);
					return summarizeObjective(objective, true);
				},
			),
		);

		tool(
			"okr_update_objective",
			{
				description:
					"Update an objective's own fields. Only the fields you pass change. Use okr_update_key_result for key results.",
				inputSchema: {
					objectiveId: z.string().describe("Objective id such as 'O1'"),
					period: z.string().optional(),
					title: z.string().optional(),
					description: z.string().optional(),
					owner: z.string().optional(),
					status: OKR_STATUS.optional(),
					due: z.string().optional().describe("YYYY-MM-DD"),
				},
			},
			this.handle(
				async (args: {
					objectiveId: string;
					period?: string;
					title?: string;
					description?: string;
					owner?: string;
					status?: OKRStatus;
					due?: string;
				}) => {
					const { objective, period } = await this.findObjective(args.objectiveId, args.period);
					const updated = await this.manager.updateObjective(
						objective.id,
						period,
						{
							title: args.title ?? objective.title,
							description: args.description ?? objective.description,
							owner: args.owner ?? objective.owner,
							status: args.status ?? objective.status,
							due: args.due ?? objective.due,
						},
						objective,
					);
					return summarizeObjective(updated, true);
				},
			),
		);

		tool(
			"okr_delete_objective",
			{
				description:
					"Move an objective note to the trash. Destructive: requires confirm, and also removes its key results and check-in history.",
				inputSchema: {
					objectiveId: z.string().describe("Objective id such as 'O1'"),
					period: z.string().optional(),
					confirm: z.literal(true).describe("Must be true to delete"),
				},
			},
			this.handle(
				async (args: { objectiveId: string; period?: string; confirm?: boolean }) => {
					if (args.confirm !== true) throw new Error("删除需要 confirm: true");
					const { period } = await this.findObjective(args.objectiveId, args.period);
					await this.manager.deleteObjective(args.objectiveId, period, true);
					return { deleted: args.objectiveId, period };
				},
			),
		);

		tool(
			"okr_add_key_result",
			{
				description:
					"Add a key result to an existing objective. The id is assigned by the plugin. Requires a title and a numeric target; current is the baseline.",
				inputSchema: {
					objectiveId: z.string().describe("Objective id such as 'O1'"),
					period: z.string().optional(),
					title: z.string(),
					description: z.string().optional(),
					owner: z.string().optional(),
					unit: UNIT.optional(),
					current: z.number().min(0).optional().describe("Baseline value"),
					target: z.number().describe("Target value"),
					weight: z.number().positive().optional(),
					confidence: CONFIDENCE.optional(),
					due: z.string().optional().describe("YYYY-MM-DD, defaults to the objective's due"),
				},
			},
			this.handle(
				async (args: {
					objectiveId: string;
					period?: string;
					title: string;
					description?: string;
					owner?: string;
					unit?: KRUnit;
					current?: number;
					target: number;
					weight?: number;
					confidence?: Confidence;
					due?: string;
				}) => {
					const { objective, period } = await this.findObjective(args.objectiveId, args.period);
					const created = await this.manager.createKeyResult({
						objectiveId: objective.id,
						period,
						title: args.title,
						description: args.description ?? "",
						owner: args.owner ?? "",
						unit: args.unit ?? "number",
						current: args.current ?? 0,
						target: args.target,
						weight: args.weight ?? 1,
						status: "active",
						confidence: args.confidence ?? "medium",
						created: todayLocalDate(),
						due: args.due ?? objective.due,
					});
					return summarizeKeyResult(created);
				},
			),
		);

		tool(
			"okr_update_key_result",
			{
				description:
					"Update a key result. Passing current or target recomputes progress, and the objective's weighted progress is refreshed automatically.",
				inputSchema: {
					krId: z.string().describe("Key result id such as 'O1-KR1'"),
					period: z.string().optional(),
					title: z.string().optional(),
					description: z.string().optional(),
					owner: z.string().optional(),
					unit: UNIT.optional(),
					current: z.number().min(0).optional(),
					target: z.number().optional(),
					weight: z.number().positive().optional(),
					confidence: CONFIDENCE.optional(),
					status: OKR_STATUS.optional(),
					due: z.string().optional(),
				},
			},
			this.handle(
				async (args: {
					krId: string;
					period?: string;
					title?: string;
					description?: string;
					owner?: string;
					unit?: KRUnit;
					current?: number;
					target?: number;
					weight?: number;
					confidence?: Confidence;
					status?: OKRStatus;
					due?: string;
				}) => {
					const { kr, period } = await this.findKeyResult(args.krId, args.period);
					const updated = await this.manager.updateKeyResult(
						kr.id,
						period,
						{
							title: args.title ?? kr.title,
							description: args.description ?? kr.description,
							owner: args.owner ?? kr.owner,
							unit: args.unit ?? kr.unit,
							current: args.current ?? kr.current,
							target: args.target ?? kr.target,
							weight: args.weight ?? kr.weight,
							confidence: args.confidence ?? kr.confidence,
							status: args.status ?? kr.status,
							due: args.due ?? kr.due,
						},
						kr,
					);
					return summarizeKeyResult(updated);
				},
			),
		);

		tool(
			"okr_delete_key_result",
			{
				description:
					"Remove a key result from its objective, including its check-in history. The plugin also renumbers the remaining key results.",
				inputSchema: {
					krId: z.string().describe("Key result id such as 'O1-KR1'"),
					period: z.string().optional(),
					confirm: z.literal(true).describe("Must be true to delete"),
				},
			},
			this.handle(async (args: { krId: string; period?: string; confirm?: boolean }) => {
				if (args.confirm !== true) throw new Error("删除需要 confirm: true");
				const { period } = await this.findKeyResult(args.krId, args.period);
				await this.manager.deleteKeyResult(args.krId, period);
				return { deleted: args.krId, period };
			}),
		);
	}

	private periodType(): OKRPeriodType {
		return this.settings.defaultPeriodType ?? "quarter";
	}

	/** Use the given period, or infer it from the entity being addressed. */
	private async resolvePeriod(options: {
		period?: string;
		objectiveId?: string;
		krId?: string;
	}): Promise<string> {
		if (options.period) return options.period;
		if (options.objectiveId) {
			return (await this.findObjective(options.objectiveId)).period;
		}
		if (options.krId) {
			return (await this.findKeyResult(options.krId)).period;
		}
		return currentPeriod(this.periodType());
	}

	private async findObjective(
		objectiveId: string,
		period?: string,
	): Promise<{ objective: Objective; period: string }> {
		const periods = period ? [period] : await this.manager.getAllPeriods();
		for (const candidate of periods) {
			const objectives = await this.manager.getObjectives(candidate);
			const objective = objectives.find((item) => item.id === objectiveId);
			if (objective) return { objective, period: candidate };
		}
		throw new Error(`找不到目标 ${objectiveId}${period ? ` (周期 ${period})` : ""}`);
	}

	private async findKeyResult(
		krId: string,
		period?: string,
	): Promise<{ kr: KeyResult; objective: Objective; period: string }> {
		const periods = period ? [period] : await this.manager.getAllPeriods();
		for (const candidate of periods) {
			const objectives = await this.manager.getObjectives(candidate);
			for (const objective of objectives) {
				const kr = objective.keyResults.find((item) => item.id === krId);
				if (kr) return { kr, objective, period: candidate };
			}
		}
		throw new Error(`找不到关键结果 ${krId}${period ? ` (周期 ${period})` : ""}`);
	}
}

interface OKRPluginSettingsLike {
	defaultPeriodType?: OKRPeriodType;
}

function summarizeKeyResult(kr: KeyResult) {
	return {
		id: kr.id,
		title: kr.title,
		unit: kr.unit,
		weight: kr.weight,
		current: kr.current,
		target: kr.target,
		progress: kr.progress,
		status: kr.status,
		confidence: kr.confidence,
		hasBlocker: kr.hasBlocker,
		checkInCount: kr.checkIns.length,
		due: kr.due,
	};
}

function summarizeObjective(objective: Objective, detailed = false) {
	return {
		id: objective.id,
		period: objective.period,
		title: objective.title,
		description: objective.description,
		owner: objective.owner,
		status: objective.status,
		progress: objective.progress,
		created: objective.created,
		due: objective.due,
		keyResultCount: objective.keyResults.length,
		keyResults: objective.keyResults.map((kr) =>
			detailed
				? { ...summarizeKeyResult(kr), description: kr.description, owner: kr.owner }
				: { id: kr.id, title: kr.title, progress: kr.progress, weight: kr.weight },
		),
	};
}
