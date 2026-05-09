import {
	afterAll,
	afterEach,
	beforeAll,
	describe,
	expect,
	test,
} from "bun:test";
import fs from "node:fs/promises";
import { createServer, type Server } from "node:http";
import path from "node:path";
import { AppFileSystem } from "@opencode-ai/shared/filesystem";
import { Effect, Layer, ManagedRuntime } from "effect";
import { tmpdir } from "../../../test/fixture/fixture";
import { Agent } from "../../agent/agent";
import { Bus } from "../../bus";
import * as CrossSpawnSpawner from "../../effect/cross-spawn-spawner";
import { Format } from "../../format";
import { LSP } from "../../lsp";
import { Instance } from "../../project/instance";
import { Instruction } from "../../session/instruction";
import { MessageID, SessionID } from "../../session/schema";
import type { Tool } from "..";
import { Truncate } from "..";
import { ApplyPatchTool } from "../apply_patch";
import { EditTool } from "../edit";
import { ReadTool } from "../read";
import { WriteTool } from "../write";

let server: Server;
let serverPort = 0;
const requests: Array<{ method: string; path: string; body: unknown }> = [];

const runtime = ManagedRuntime.make(
	Layer.mergeAll(
		Agent.defaultLayer,
		AppFileSystem.defaultLayer,
		Bus.layer,
		CrossSpawnSpawner.defaultLayer,
		Format.defaultLayer,
		Instruction.defaultLayer,
		LSP.defaultLayer,
		Truncate.defaultLayer,
	),
);

const ctx: Tool.Context = {
	sessionID: SessionID.make("ses_test-diff-bridge"),
	messageID: MessageID.make(""),
	callID: "",
	agent: "build",
	abort: AbortSignal.any([]),
	messages: [],
	metadata: () => Effect.void,
	ask: () => Effect.void,
};

const bridgeUrl = () => `http://127.0.0.1:${serverPort}`;

const initEdit = () =>
	runtime.runPromise(
		Effect.gen(function* () {
			const info = yield* EditTool;
			return yield* info.init();
		}),
	);

const initWrite = () =>
	runtime.runPromise(
		Effect.gen(function* () {
			const info = yield* WriteTool;
			return yield* info.init();
		}),
	);

const initApplyPatch = () =>
	runtime.runPromise(
		Effect.gen(function* () {
			const info = yield* ApplyPatchTool;
			return yield* info.init();
		}),
	);

const initRead = () =>
	runtime.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				const info = yield* ReadTool;
				return yield* info.init();
			}),
		),
	);

beforeAll(async () => {
	server = createServer((req, res) => {
		let body = "";
		req.on("data", (chunk) => {
			body += chunk;
		});
		req.on("end", () => {
			const parsed = body ? JSON.parse(body) : undefined;
			requests.push({
				method: req.method ?? "GET",
				path: req.url ?? "/",
				body: parsed,
			});

			if (req.url === "/health") {
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ ok: true }));
				return;
			}

			if (req.url?.startsWith("/read-buffer")) {
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(
					JSON.stringify({
						dirty: true,
						content: "staged-line1\nstaged-line2\n",
					}),
				);
				return;
			}

			if (req.url === "/apply-edit" || req.url === "/apply-write") {
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ zoneId: "diffzone-test-1" }));
				return;
			}

			if (req.url === "/apply-patch") {
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ zoneIds: ["diffzone-test-1"] }));
				return;
			}

			res.writeHead(404);
			res.end();
		});
	});

	await new Promise<void>((resolve) => {
		server.listen(0, "127.0.0.1", () => {
			const address = server.address() as { port: number };
			serverPort = address.port;
			resolve();
		});
	});
});

afterEach(async () => {
	requests.length = 0;
	delete process.env.OPENCODE_DIFF_BRIDGE_URL;
	await Instance.disposeAll();
});

afterAll(async () => {
	await runtime.dispose();
	await new Promise<void>((resolve) => {
		server.close(() => resolve());
	});
	delete process.env.OPENCODE_DIFF_BRIDGE_URL;
});

describe("diff-bridge-client", () => {
	test("getBridgeUrl returns undefined when env not set", async () => {
		const { getBridgeUrl } = await import("../diff-bridge-client");
		expect(getBridgeUrl()).toBeUndefined();
	});

	test("getBridgeUrl returns URL when env set", async () => {
		process.env.OPENCODE_DIFF_BRIDGE_URL = bridgeUrl();
		const { getBridgeUrl } = await import("../diff-bridge-client");
		expect(getBridgeUrl()).toBe(bridgeUrl());
	});

	test("bridgePost sends JSON and returns response", async () => {
		process.env.OPENCODE_DIFF_BRIDGE_URL = bridgeUrl();
		const { bridgePost } = await import("../diff-bridge-client");
		const result = await bridgePost("/apply-edit", {
			filePath: "/test",
			newContent: "hello",
			edits: [],
		});

		expect(result).toEqual({ zoneId: "diffzone-test-1" });
		expect(requests).toHaveLength(1);
		expect(requests[0]).toEqual({
			method: "POST",
			path: "/apply-edit",
			body: { filePath: "/test", newContent: "hello", edits: [] },
		});
	});

	test("bridgeGet sends GET and returns response", async () => {
		process.env.OPENCODE_DIFF_BRIDGE_URL = bridgeUrl();
		const { bridgeGet } = await import("../diff-bridge-client");
		const result = await bridgeGet("/read-buffer?path=/test");

		expect(result).toEqual({
			dirty: true,
			content: "staged-line1\nstaged-line2\n",
		});
		expect(requests).toHaveLength(1);
		expect(requests[0].method).toBe("GET");
		expect(requests[0].path).toBe("/read-buffer?path=/test");
	});

	test("bridgePost throws on non-2xx", async () => {
		process.env.OPENCODE_DIFF_BRIDGE_URL = bridgeUrl();
		const { bridgePost } = await import("../diff-bridge-client");
		await expect(bridgePost("/nonexistent", {})).rejects.toThrow("404");
	});

	test("bridgePost throws when env not set", async () => {
		const { bridgePost } = await import("../diff-bridge-client");
		await expect(bridgePost("/apply-edit", {})).rejects.toThrow(
			"OPENCODE_DIFF_BRIDGE_URL not set",
		);
	});
});

describe("diff-bridge tool intercepts", () => {
	test("edit queues create requests through the bridge", async () => {
		await using tmp = await tmpdir();
		const filepath = path.join(tmp.path, "created.txt");
		process.env.OPENCODE_DIFF_BRIDGE_URL = bridgeUrl();

		await Instance.provide({
			directory: tmp.path,
			fn: async () => {
				const edit = await initEdit();
				const result = await Effect.runPromise(
					edit.execute(
						{
							filePath: filepath,
							oldString: "",
							newString: "hello from bridge",
						},
						ctx,
					),
				);

				expect(result.output).toBe("Edit queued for review");
				expect(result.metadata.filepath).toBe(filepath);
			},
		});

		expect(requests).toHaveLength(1);
		expect(requests[0]).toEqual({
			method: "POST",
			path: "/apply-edit",
			body: {
				filePath: filepath,
				newContent: "hello from bridge",
				edits: [
					{
						originalStartLine: 1,
						originalEndLine: 0,
						modifiedText: "hello from bridge",
					},
				],
			},
		});
		await expect(fs.readFile(filepath, "utf-8")).rejects.toThrow();
	});

	test("edit queues update requests through the bridge without touching disk", async () => {
		await using tmp = await tmpdir();
		const filepath = path.join(tmp.path, "edit.txt");
		await fs.writeFile(filepath, "before\n", "utf-8");
		process.env.OPENCODE_DIFF_BRIDGE_URL = bridgeUrl();

		await Instance.provide({
			directory: tmp.path,
			fn: async () => {
				const edit = await initEdit();
				const result = await Effect.runPromise(
					edit.execute(
						{ filePath: filepath, oldString: "before", newString: "after" },
						ctx,
					),
				);

				expect(result.output).toBe("Edit queued for review");
				expect(result.metadata.filepath).toBe(filepath);
			},
		});

		expect(requests).toHaveLength(1);
		expect(requests[0]).toEqual({
			method: "POST",
			path: "/apply-edit",
			body: { filePath: filepath, newContent: "after\n", edits: [] },
		});
		expect(await fs.readFile(filepath, "utf-8")).toBe("before\n");
	});

	test("write queues bridge requests and preserves existing file content", async () => {
		await using tmp = await tmpdir();
		const filepath = path.join(tmp.path, "write.txt");
		await fs.writeFile(filepath, "old content\n", "utf-8");
		process.env.OPENCODE_DIFF_BRIDGE_URL = bridgeUrl();

		await Instance.provide({
			directory: tmp.path,
			fn: async () => {
				const write = await initWrite();
				const result = await Effect.runPromise(
					write.execute({ filePath: filepath, content: "new content\n" }, ctx),
				);

				expect(result.output).toBe("Write queued for review");
				expect(result.metadata.filepath).toBe(filepath);
				expect(result.metadata.exists).toBe(true);
			},
		});

		expect(requests).toHaveLength(1);
		expect(requests[0]).toEqual({
			method: "POST",
			path: "/apply-write",
			body: { filePath: filepath, newContent: "new content\n" },
		});
		expect(await fs.readFile(filepath, "utf-8")).toBe("old content\n");
	});

	test("apply_patch queues bridge payloads and leaves files untouched", async () => {
		await using tmp = await tmpdir();
		const filepath = path.join(tmp.path, "target.txt");
		await fs.writeFile(filepath, "old\n", "utf-8");
		process.env.OPENCODE_DIFF_BRIDGE_URL = bridgeUrl();

		await Instance.provide({
			directory: tmp.path,
			fn: async () => {
				const applyPatch = await initApplyPatch();
				const result = await Effect.runPromise(
					applyPatch.execute(
						{
							patchText:
								"*** Begin Patch\n*** Update File: target.txt\n@@\n-old\n+new\n*** End Patch",
						},
						ctx,
					),
				);

				expect(result.output).toContain("Patch queued for review");
				expect(result.metadata.files).toHaveLength(1);
			},
		});

		expect(requests).toHaveLength(1);
		expect(requests[0].method).toBe("POST");
		expect(requests[0].path).toBe("/apply-patch");
		const body = requests[0].body as {
			files: Array<{
				filePath: string;
				type: string;
				newContent: string;
				diff: string;
			}>;
		};
		expect(body.files).toHaveLength(1);
		expect(body.files[0].filePath).toBe(filepath);
		expect(body.files[0].type).toBe("update");
		expect(body.files[0].newContent).toBe("new\n");
		expect(body.files[0].diff).toContain("-old");
		expect(body.files[0].diff).toContain("+new");
		expect(await fs.readFile(filepath, "utf-8")).toBe("old\n");
	});

	test("read prefers dirty bridge buffers over on-disk content", async () => {
		await using tmp = await tmpdir();
		const filepath = path.join(tmp.path, "read.txt");
		await fs.writeFile(filepath, "disk-line\n", "utf-8");
		process.env.OPENCODE_DIFF_BRIDGE_URL = bridgeUrl();

		await Instance.provide({
			directory: tmp.path,
			fn: async () => {
				const read = await initRead();
				const result = await Effect.runPromise(
					read.execute({ filePath: filepath }, ctx),
				);

				expect(result.output).toContain("1: staged-line1");
				expect(result.output).toContain("2: staged-line2");
				expect(result.output).not.toContain("disk-line");
			},
		});

		expect(requests).toHaveLength(1);
		expect(requests[0].method).toBe("GET");
		expect(requests[0].path).toBe(
			`/read-buffer?path=${encodeURIComponent(filepath)}`,
		);
	});
});
