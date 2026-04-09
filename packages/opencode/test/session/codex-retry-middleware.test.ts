import { describe, expect, test } from "bun:test";
import type {
	LanguageModelV3,
	LanguageModelV3CallOptions,
	LanguageModelV3StreamPart,
} from "@ai-sdk/provider";
import { wrapLanguageModel } from "ai";
import * as core from "../../src/session/codex-retry-middleware";

const FINISH: LanguageModelV3StreamPart = {
	type: "finish",
	finishReason: "stop",
	usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
} as unknown as LanguageModelV3StreamPart;

function textParts(id: string, delta: string): LanguageModelV3StreamPart[] {
	return [
		{ type: "text-start", id } as unknown as LanguageModelV3StreamPart,
		{ type: "text-delta", id, delta } as unknown as LanguageModelV3StreamPart,
		{ type: "text-end", id } as unknown as LanguageModelV3StreamPart,
	];
}

function errorPart(msg: string): LanguageModelV3StreamPart {
	return { type: "error", error: new Error(msg) };
}

type Script = LanguageModelV3StreamPart[] | Error;
type FakeModel = LanguageModelV3 & { readonly callCount: number };

function fakeModel(scripts: Script[]): FakeModel {
	let count = 0;
	const base: LanguageModelV3 = {
		specificationVersion: "v3",
		provider: "fake-openai",
		modelId: "gpt-5.4-fake",
		supportedUrls: {},
		async doGenerate(): Promise<never> {
			throw new Error("doGenerate not implemented in test");
		},
		async doStream(_options: LanguageModelV3CallOptions) {
			const index = count;
			count += 1;
			const script = scripts[index] ?? scripts[scripts.length - 1];
			if (script instanceof Error) throw script;
			const stream = new ReadableStream<LanguageModelV3StreamPart>({
				start(controller) {
					for (const part of script) controller.enqueue(part);
					controller.close();
				},
			});
			return { stream };
		},
	};
	return Object.defineProperty(base as FakeModel, "callCount", {
		get: () => count,
	});
}

async function collect(
	stream: ReadableStream<LanguageModelV3StreamPart>,
): Promise<LanguageModelV3StreamPart[]> {
	const out: LanguageModelV3StreamPart[] = [];
	const reader = stream.getReader();
	try {
		while (true) {
			const part = await reader.read();
			if (part.done) break;
			out.push(part.value);
		}
	} finally {
		reader.releaseLock();
	}
	return out;
}

const DUMMY_CALL: LanguageModelV3CallOptions = {
	prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
} as unknown as LanguageModelV3CallOptions;

async function run(scripts: Script[]) {
	const wait: number[] = [];
	const fake = fakeModel(scripts);
	const wrapped = wrapLanguageModel({
		model: fake,
		middleware: core.codexRetryMiddleware({
			rand: () => 0.5,
			sleep: async (ms) => {
				wait.push(ms);
			},
		}),
	});
	const result = await wrapped.doStream(DUMMY_CALL);
	const parts = await collect(result.stream);
	return { parts, calls: fake.callCount, wait };
}

function deltas(parts: LanguageModelV3StreamPart[]) {
	return parts
		.filter(
			(
				part,
			): part is Extract<LanguageModelV3StreamPart, { type: "text-delta" }> =>
				part.type === "text-delta",
		)
		.map((part) => part.delta);
}

describe("codex-retry middleware", () => {
	test("transient retries on first-chunk server_error", async () => {
		const out = await run([
			[errorPart("server_error")],
			[...textParts("t2", "ok"), FINISH],
		]);

		expect(out.calls).toBe(2);
		expect(out.wait).toEqual([200]);
		expect(out.parts.some((part) => part.type === "error")).toBe(false);
		expect(out.parts.some((part) => part.type === "finish")).toBe(true);
		expect(deltas(out.parts)).toEqual(["ok"]);
	});

	test("transient retries on service_unavailable", async () => {
		const out = await run([
			[errorPart("service_unavailable")],
			[...textParts("t2", "ok"), FINISH],
		]);

		expect(out.calls).toBe(2);
		expect(out.wait).toEqual([200]);
		expect(out.parts.some((part) => part.type === "error")).toBe(false);
	});

	test("rate_limit retries with longer backoff", async () => {
		const out = await run([
			[errorPart("rate_limit_exceeded")],
			[...textParts("t2", "ok"), FINISH],
		]);

		expect(out.calls).toBe(2);
		expect(out.wait).toEqual([2000]);
		expect(out.parts.some((part) => part.type === "error")).toBe(false);
	});

	test("context retries on context_length_exceeded", async () => {
		const out = await run([
			[errorPart("context_length_exceeded")],
			[...textParts("t2", "ok"), FINISH],
		]);

		expect(out.calls).toBe(2);
		expect(out.wait).toEqual([3000]);
		expect(out.parts.some((part) => part.type === "error")).toBe(false);
	});

	test("invalid retries on invalid_request_error", async () => {
		const out = await run([
			[errorPart("invalid_request_error")],
			[...textParts("t2", "ok"), FINISH],
		]);

		expect(out.calls).toBe(2);
		expect(out.wait).toEqual([3000]);
		expect(out.parts.some((part) => part.type === "error")).toBe(false);
	});

	test("does not retry after visible output", async () => {
		const out = await run([
			[...textParts("t1", "ok"), errorPart("server_error")],
		]);

		expect(out.calls).toBe(1);
		expect(deltas(out.parts)).toEqual(["ok"]);
		expect(out.parts.some((part) => part.type === "error")).toBe(true);
	});

	test("transport retries when doStream throws", async () => {
		const out = await run([
			new Error("fetch failed"),
			[...textParts("t2", "ok"), FINISH],
		]);

		expect(out.calls).toBe(2);
		expect(out.wait).toEqual([200]);
		expect(out.parts.some((part) => part.type === "error")).toBe(false);
		expect(out.parts.some((part) => part.type === "finish")).toBe(true);
	});

	test("budget exhausted stops at the global cap", async () => {
		const out = await run(
			Array.from({ length: 6 }, () => [errorPart("server_error")]),
		);

		expect(out.calls).toBe(5);
		expect(out.wait).toEqual([200, 400, 800, 1600]);
		expect(out.parts.some((part) => part.type === "error")).toBe(true);
	});

	test("per-category quota stops at two attempts", async () => {
		const out = await run([
			[errorPart("insufficient_quota")],
			[errorPart("insufficient_quota")],
			[errorPart("insufficient_quota")],
		]);

		expect(out.calls).toBe(2);
		expect(out.wait).toEqual([3000]);
		expect(out.parts.some((part) => part.type === "error")).toBe(true);
	});

	test("classify maps known patterns and unknown errors", () => {
		expect(core.classify("server_error", "boom", 500)).toMatchObject({
			category: "transient",
		});
		expect(core.classify(undefined, "service_unavailable", 503)).toMatchObject({
			category: "transient",
		});
		expect(
			core.classify("rate_limit_exceeded", "try again in 2.5s", 429),
		).toMatchObject({
			category: "rate_limit",
			delay: 2500,
		});
		expect(core.classify(undefined, "server_is_overloaded", 529)).toMatchObject(
			{ category: "overloaded" },
		);
		expect(core.classify(undefined, "insufficient_quota", 400)).toMatchObject({
			category: "quota",
		});
		expect(core.classify(undefined, "context window", 400)).toMatchObject({
			category: "context",
		});
		expect(core.classify(undefined, "invalid_request", 400)).toMatchObject({
			category: "invalid",
		});
		expect(core.classify(undefined, "mystery", 418)).toMatchObject({
			category: "unknown",
		});
	});

	test("backoff stays inside the expected ranges", () => {
		const a = core.backoff(1, 200);
		const b = core.backoff(2, 200);
		const c = core.backoff(3, 2000);

		expect(a).toBeGreaterThanOrEqual(180);
		expect(a).toBeLessThanOrEqual(220);
		expect(b).toBeGreaterThanOrEqual(360);
		expect(b).toBeLessThanOrEqual(440);
		expect(c).toBeGreaterThanOrEqual(7200);
		expect(c).toBeLessThanOrEqual(8800);
	});

	test("non-openai providers are not intercepted", () => {
		expect(typeof core.active).toBe("function");

		const out = {
			middleware: [] as ReturnType<typeof core.codexRetryMiddleware>[],
		};
		if (core.active?.("anthropic", "claude-sonnet-4")) {
			out.middleware.push(core.codexRetryMiddleware());
		}

		expect(out.middleware).toHaveLength(0);
	});
});
