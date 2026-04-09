import type { LanguageModelV3Middleware, LanguageModelV3StreamPart } from "@ai-sdk/provider"

export const budget = {
  transient: { max: 5, base: 200 },
  rate_limit: { max: 3, base: 2000 },
  overloaded: { max: 3, base: 2000 },
  quota: { max: 2, base: 3000 },
  context: { max: 2, base: 3000 },
  invalid: { max: 2, base: 3000 },
  unknown: { max: 3, base: 1000 },
} as const

export const cap = 5

export type RetryCategory = keyof typeof budget

export type RetryClass = {
  category: RetryCategory
  max: number
  base: number
  delay?: number
}

type Wrap = NonNullable<LanguageModelV3Middleware["wrapStream"]>
type WrapArg = Parameters<Wrap>[0]
type WrapRes = Awaited<ReturnType<WrapArg["doStream"]>>

export type RetryOpts = {
  rand?: () => number
  sleep?: (ms: number) => Promise<void>
}

export function active(providerID: string, modelID: string) {
  return providerID.startsWith("openai") || modelID.startsWith("gpt-")
}

const transport = [
  "fetch failed",
  "network",
  "timeout",
  "timed out",
  "econnreset",
  "etimedout",
  "econnrefused",
  "socket hang up",
  "connection reset",
] as const

const transient = [
  "server_error",
  "service_unavailable",
  "an error occurred",
  "an error occurred while processing",
] as const

const rate = ["rate_limit", "too many requests", "try again in"] as const
const load = ["server_is_overloaded", "slow_down"] as const
const quota = ["insufficient_quota", "quota exceeded", "billing hard limit"] as const
const context = ["context_length_exceeded", "context window", "prompt is too long"] as const
const invalid = ["invalid_request", "invalid input", "unsupported parameter"] as const

function has(txt: string, list: readonly string[]) {
  return list.some((part) => txt.includes(part))
}

function take(category: RetryCategory, delay?: number): RetryClass {
  const rule = budget[category]
  return delay === undefined
    ? { category, max: rule.max, base: rule.base }
    : { category, max: rule.max, base: rule.base, delay }
}

function obj(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function pick(value: unknown) {
  if (!obj(value)) return {}
  return {
    code: typeof value.code === "string" ? value.code : typeof value.type === "string" ? value.type : undefined,
    msg: typeof value.message === "string" ? value.message : typeof value.msg === "string" ? value.msg : undefined,
    status:
      typeof value.status === "number"
        ? value.status
        : typeof value.statusCode === "number"
          ? value.statusCode
          : undefined,
  }
}

function json(msg?: string) {
  if (!msg) return {}
  try {
    const value = JSON.parse(msg)
    const root = pick(value)
    const inner = pick(obj(value) ? value.error : undefined)
    return {
      code: root.code ?? inner.code,
      msg: root.msg ?? inner.msg ?? msg,
      status: root.status ?? inner.status,
    }
  } catch {
    return { msg }
  }
}

function info(err: unknown) {
  if (err instanceof Error) {
    const parsed = json(err.message)
    const root = pick(err)
    return {
      code: root.code ?? parsed.code,
      msg: root.msg ?? parsed.msg,
      status: root.status ?? parsed.status,
    }
  }
  if (typeof err === "string") return json(err)
  const root = pick(err)
  const inner = pick(obj(err) ? err.error : undefined)
  const parsed = json(root.msg ?? inner.msg)
  return {
    code: root.code ?? inner.code ?? parsed.code,
    msg: root.msg ?? inner.msg ?? parsed.msg ?? String(err ?? ""),
    status: root.status ?? inner.status ?? parsed.status,
  }
}

function seen() {
  return {
    transient: 0,
    rate_limit: 0,
    overloaded: 0,
    quota: 0,
    context: 0,
    invalid: 0,
    unknown: 0,
  } satisfies Record<RetryCategory, number>
}

function again(hit: Record<RetryCategory, number>, total: number, kind: RetryClass, rand: () => number) {
  hit[kind.category] += 1
  if (total >= cap) return
  if (hit[kind.category] >= kind.max) return
  return kind.delay ?? backoff(hit[kind.category], kind.base, rand)
}

function kind(err: unknown) {
  const data = info(err)
  return classify(data.code, data.msg, data.status)
}

function swap(result: WrapRes, stream: ReadableStream<LanguageModelV3StreamPart>) {
  return { ...result, stream }
}

function empty() {
  return new ReadableStream<LanguageModelV3StreamPart>({
    start(controller) {
      controller.close()
    },
  })
}

function drop(reader: ReadableStreamDefaultReader<LanguageModelV3StreamPart>) {
  return reader
    .cancel()
    .catch(() => undefined)
    .finally(() => reader.releaseLock())
}

export function parseRetryAfter(msg?: string) {
  if (!msg) return
  const match = /try again in\s+(\d+(?:\.\d+)?)\s*(ms|msec|milliseconds?|s|sec|secs|seconds?)/i.exec(msg)
  if (!match) return
  const value = Number.parseFloat(match[1])
  if (Number.isNaN(value)) return
  return match[2].toLowerCase().startsWith("m") ? Math.ceil(value) : Math.ceil(value * 1000)
}

export function backoff(attempt: number, base: number, rand = Math.random) {
  const span = Math.max(1, attempt)
  const jitter = 0.9 + rand() * 0.2
  return Math.ceil(base * 2 ** (span - 1) * jitter)
}

export function classify(code?: string, msg?: string, status?: number) {
  const txt = `${code ?? ""} ${msg ?? ""}`.trim().toLowerCase()
  const delay = parseRetryAfter(msg)
  if (status === 429 || has(txt, rate)) return take("rate_limit", delay)
  if (has(txt, load)) return take("overloaded", delay)
  if (has(txt, quota)) return take("quota", delay)
  if (has(txt, context)) return take("context", delay)
  if (has(txt, invalid)) return take("invalid", delay)
  if ((status ?? 0) >= 500 || has(txt, transient) || has(txt, transport)) return take("transient", delay)
  return take("unknown", delay)
}

export function prepend<T>(first: T, reader: ReadableStreamDefaultReader<T>) {
  let head = true
  let open = true
  const stop = () => {
    if (!open) return
    open = false
    reader.releaseLock()
  }
  return new ReadableStream<T>({
    async pull(controller) {
      if (head) {
        head = false
        controller.enqueue(first)
        return
      }
      try {
        const part = await reader.read()
        if (part.done) {
          stop()
          controller.close()
          return
        }
        controller.enqueue(part.value)
      } catch (err) {
        stop()
        controller.error(err)
      }
    },
    cancel(reason) {
      if (!open) return
      return reader
        .cancel(reason)
        .catch(() => undefined)
        .finally(stop)
    },
  })
}

export async function retryStream(args: WrapArg, opts: RetryOpts = {}) {
  const hit = seen()
  const rand = opts.rand ?? Math.random
  const sleep = opts.sleep ?? Bun.sleep
  let total = 0

  while (true) {
    total += 1

    let result: WrapRes
    try {
      result = await args.doStream()
    } catch (err) {
      const wait = again(hit, total, kind(err), rand)
      if (wait === undefined) throw err
      await sleep(wait)
      continue
    }

    const reader = result.stream.getReader()
    let part: Awaited<ReturnType<typeof reader.read>>
    try {
      part = await reader.read()
    } catch (err) {
      reader.releaseLock()
      const wait = again(hit, total, kind(err), rand)
      if (wait === undefined) throw err
      await sleep(wait)
      continue
    }

    if (part.done) {
      reader.releaseLock()
      return swap(result, empty())
    }

    if (part.value.type !== "error") {
      return swap(result, prepend(part.value, reader))
    }

    const wait = again(hit, total, kind(part.value.error), rand)
    if (wait === undefined) return swap(result, prepend(part.value, reader))

    await drop(reader)
    await sleep(wait)
  }
}

export function codexRetryMiddleware(opts: RetryOpts = {}): LanguageModelV3Middleware {
  return {
    specificationVersion: "v3",
    wrapStream(args) {
      return retryStream(args, opts)
    },
  }
}
