import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { OKRMCPService } from "./OKRMCPService";

export interface MCPHttpServerOptions {
	port: number;
	token: string;
}

/**
 * Minimal HTTP host for the OKR MCP endpoint.
 *
 * Node built-ins are imported lazily so the plugin still loads on platforms
 * without them; the caller only starts the server on desktop.
 */
export class MCPHttpServer {
	private server: Server | null = null;

	constructor(
		private readonly service: OKRMCPService,
		private readonly options: MCPHttpServerOptions,
	) {}

	async start(): Promise<void> {
		if (this.server) return;

		this.server = createServer((req, res) => {
			void this.route(req, res);
		});

		await new Promise<void>((resolve, reject) => {
			const server = this.server;
			if (!server) {
				reject(new Error("MCP server was not created"));
				return;
			}
			server.once("error", reject);
			server.listen(this.options.port, "127.0.0.1", () => {
				server.off("error", reject);
				resolve();
			});
		});
	}

	async stop(): Promise<void> {
		const server = this.server;
		if (!server) return;
		this.server = null;
		await new Promise<void>((resolve) => {
			server.close(() => resolve());
		});
	}

	private async route(req: IncomingMessage, res: ServerResponse): Promise<void> {
		const path = (req.url ?? "").split("?")[0];

		if (req.method === "GET" && path === "/health") {
			this.sendJson(res, 200, { status: "ok", server: "okr" });
			return;
		}

		if (path !== "/mcp") {
			this.sendJson(res, 404, { error: "Not found" });
			return;
		}

		if (!this.isAuthorized(req)) {
			this.sendJson(res, 401, { error: "Authentication required" });
			return;
		}

		let body: unknown;
		try {
			body = await this.readJson(req);
		} catch (error: unknown) {
			this.sendJson(res, 400, {
				jsonrpc: "2.0",
				error: { code: -32700, message: "Invalid JSON body" },
				id: null,
			});
			return;
		}

		await this.service.handleRequest(
			req as never,
			res as never,
			body as Record<string, unknown>,
		);
	}

	private isAuthorized(req: IncomingMessage): boolean {
		const expected = this.options.token;
		if (!expected) return false;
		const header = req.headers.authorization;
		if (typeof header !== "string") return false;
		const match = header.match(/^Bearer\s+(.+)$/i);
		return match?.[1]?.trim() === expected;
	}

	private readJson(req: IncomingMessage): Promise<unknown> {
		return new Promise((resolve, reject) => {
			const chunks: Buffer[] = [];
			let size = 0;
			const limit = 4 * 1024 * 1024;

			req.on("data", (chunk: Buffer) => {
				size += chunk.length;
				if (size > limit) {
					reject(new Error("Request body too large"));
					req.destroy();
					return;
				}
				chunks.push(chunk);
			});
			req.on("end", () => {
				if (size === 0) {
					resolve({});
					return;
				}
				try {
					resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
				} catch (error: unknown) {
					reject(error instanceof Error ? error : new Error("Invalid JSON"));
				}
			});
			req.on("error", reject);
		});
	}

	private sendJson(res: ServerResponse, status: number, payload: unknown): void {
		res.writeHead(status, { "Content-Type": "application/json" });
		res.end(JSON.stringify(payload));
	}
}
