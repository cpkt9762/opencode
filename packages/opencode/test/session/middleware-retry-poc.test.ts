import { describe, expect, test } from "bun:test"
import { wrapLanguageModel } from "ai"
import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3Middleware,
  LanguageModelV3StreamPart,
} from "@ai-sdk/provider"

const FINISH: LanguageModelV3StreamPart = {
  type: "finish",
  finishReason: "stop",
  usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
} as unknown as LanguageModelV3StreamPart

function textParts(id: string, delta: string): LanguageModelV3StreamPart[] {
  return [
    { type: "text-start", id } as unknown as LanguageModelV3StreamPart,
    { type: "text-delta", id, delta } as unknown as LanguageModelV3StreamPart,
    { type: "text-end", id } as unknown as LanguageModelV3StreamPart,
  ]
}

function errorPart(msg: string): LanguageModelV3StreamPart {
  return { type: "error", error: new Error(msg) }
}

type FakeModel = LanguageModelV3 & { readonly callCount: number }

function fakeModel(scripts: LanguageModelV3StreamPart[][]): FakeModel {
  let count = 0
  const base: LanguageModelV3 = {
    specificationVersion: "v3",
    provider: "fake-openai",
    modelId: "gpt-5.4-fake",
    supportedUrls: {},
    async doGenerate(): Promise<never> {
      throw new Error("doGenerate not implemented in PoC")
    },
    async doStream(_options: LanguageModelV3CallOptions) {
      const attempt = count
      count++
      const script = scripts[attempt] ?? scripts[scripts.length - 1]
      const stream = new ReadableStream<LanguageModelV3StreamPart>({
        start(controller) {
          for (const part of script) controller.enqueue(part)
          controller.close()
        },
      })
      return { stream }
    },
  }
  return Object.defineProperty(base as FakeModel, "callCount", {
    get: () => count,
  })
}

function isRetryableStreamError(part: LanguageModelV3StreamPart): boolean {
  if (part.type !== "error") return false
  const err = part.error
  const msg = (err instanceof Error ? err.message : String(err ?? "")).toLowerCase()
  return (
    msg.includes("server_error") ||
    msg.includes("service_unavailable") ||
    msg.includes("overloaded") ||
    msg.includes("an error occurred while processing")
  )
}

function retryMiddleware(maxAttempts: number): LanguageModelV3Middleware {
  return {
    specificationVersion: "v3",
    wrapStream: async ({ doStream }) => {
      let lastResult: Awaited<ReturnType<typeof doStream>> | undefined
      let lastChunks: LanguageModelV3StreamPart[] = []
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        const result = await doStream()
        lastResult = result
        const chunks: LanguageModelV3StreamPart[] = []
        const reader = result.stream.getReader()
        let hitRetryable = false
        try {
          while (true) {
            const { done, value } = await reader.read()
            if (done) break
            if (attempt < maxAttempts && isRetryableStreamError(value)) {
              hitRetryable = true
              break
            }
            chunks.push(value)
          }
        } finally {
          reader.releaseLock()
        }
        lastChunks = chunks
        if (!hitRetryable) break
      }
      const replay = new ReadableStream<LanguageModelV3StreamPart>({
        start(controller) {
          for (const c of lastChunks) controller.enqueue(c)
          controller.close()
        },
      })
      return { ...(lastResult as Awaited<ReturnType<typeof doStream>>), stream: replay }
    },
  }
}

async function collect(stream: ReadableStream<LanguageModelV3StreamPart>): Promise<LanguageModelV3StreamPart[]> {
  const out: LanguageModelV3StreamPart[] = []
  const reader = stream.getReader()
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      out.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  return out
}

const DUMMY_CALL: LanguageModelV3CallOptions = {
  prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
} as unknown as LanguageModelV3CallOptions

describe("LLM middleware PoC — mid-stream retry via wrapStream + pre-consume", () => {
  test("retries once when first attempt emits a retryable mid-stream error", async () => {
    const fake = fakeModel([
      [...textParts("t1", "partial"), errorPart("server_error: overloaded")],
      [...textParts("t2", "full answer"), FINISH],
    ])

    const wrapped = wrapLanguageModel({
      model: fake,
      middleware: retryMiddleware(3),
    })

    const result = await wrapped.doStream(DUMMY_CALL)
    const chunks = await collect(result.stream)

    expect(fake.callCount).toBe(2)
    expect(chunks.some((c) => c.type === "error")).toBe(false)
    expect(chunks.some((c) => c.type === "finish")).toBe(true)
    const deltas = chunks
      .filter((c): c is Extract<LanguageModelV3StreamPart, { type: "text-delta" }> => c.type === "text-delta")
      .map((c) => c.delta)
    expect(deltas).toEqual(["full answer"])
  })

  test("does not retry when the first attempt finishes cleanly", async () => {
    const fake = fakeModel([[...textParts("t1", "ok"), FINISH]])

    const wrapped = wrapLanguageModel({
      model: fake,
      middleware: retryMiddleware(3),
    })

    const result = await wrapped.doStream(DUMMY_CALL)
    const chunks = await collect(result.stream)

    expect(fake.callCount).toBe(1)
    expect(chunks.some((c) => c.type === "finish")).toBe(true)
    expect(chunks.some((c) => c.type === "error")).toBe(false)
  })

  test("surfaces error to outer when retry budget is exhausted", async () => {
    const script: LanguageModelV3StreamPart[][] = [
      [errorPart("server_error: overloaded")],
      [errorPart("server_error: overloaded")],
      [errorPart("server_error: overloaded")],
    ]
    const fake = fakeModel(script)

    const wrapped = wrapLanguageModel({
      model: fake,
      middleware: retryMiddleware(3),
    })

    const result = await wrapped.doStream(DUMMY_CALL)
    const chunks = await collect(result.stream)

    expect(fake.callCount).toBe(3)
    expect(chunks.some((c) => c.type === "error")).toBe(true)
  })

  test("non-retryable errors are passed through without retry", async () => {
    const fake = fakeModel([[...textParts("t1", "oops"), errorPart("invalid_request: bad prompt")]])

    const wrapped = wrapLanguageModel({
      model: fake,
      middleware: retryMiddleware(3),
    })

    const result = await wrapped.doStream(DUMMY_CALL)
    const chunks = await collect(result.stream)

    expect(fake.callCount).toBe(1)
    expect(chunks.some((c) => c.type === "error")).toBe(true)
  })

  test("call count is exactly bounded by maxAttempts when every attempt fails", async () => {
    const script: LanguageModelV3StreamPart[][] = Array.from({ length: 10 }, () => [
      errorPart("server_error: overloaded"),
    ])
    const fake = fakeModel(script)

    const wrapped = wrapLanguageModel({
      model: fake,
      middleware: retryMiddleware(5),
    })

    const result = await wrapped.doStream(DUMMY_CALL)
    await collect(result.stream)

    expect(fake.callCount).toBe(5)
  })
})
