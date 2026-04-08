import type { NamedError } from "@opencode-ai/util/error"
import { Cause, Clock, Duration, Effect, Schedule } from "effect"
import { MessageV2 } from "./message-v2"
import { iife } from "@/util/iife"
import { Log } from "@/util/log"
import { retryLog } from "./retry-log"

export namespace SessionRetry {
  const log = Log.create({ service: "session.retry" })

  export type Err = ReturnType<NamedError["toObject"]>

  export const RETRY_INITIAL_DELAY = 2000
  export const RETRY_BACKOFF_FACTOR = 2
  export const RETRY_MAX_DELAY_NO_HEADERS = 30_000 // 30 seconds
  export const RETRY_MAX_DELAY = 2_147_483_647 // max 32-bit signed integer for setTimeout
  export const RETRY_MAX_ATTEMPTS = 10

  function cap(ms: number) {
    return Math.min(ms, RETRY_MAX_DELAY)
  }

  export function delay(attempt: number, error?: MessageV2.APIError) {
    if (error) {
      const headers = error.data.responseHeaders
      if (headers) {
        const retryAfterMs = headers["retry-after-ms"]
        if (retryAfterMs) {
          const parsedMs = Number.parseFloat(retryAfterMs)
          if (!Number.isNaN(parsedMs)) {
            return cap(parsedMs)
          }
        }

        const retryAfter = headers["retry-after"]
        if (retryAfter) {
          const parsedSeconds = Number.parseFloat(retryAfter)
          if (!Number.isNaN(parsedSeconds)) {
            // convert seconds to milliseconds
            return cap(Math.ceil(parsedSeconds * 1000))
          }
          // Try parsing as HTTP date format
          const parsed = Date.parse(retryAfter) - Date.now()
          if (!Number.isNaN(parsed) && parsed > 0) {
            return cap(Math.ceil(parsed))
          }
        }

        return cap(RETRY_INITIAL_DELAY * Math.pow(RETRY_BACKOFF_FACTOR, attempt - 1))
      }
    }

    return cap(Math.min(RETRY_INITIAL_DELAY * Math.pow(RETRY_BACKOFF_FACTOR, attempt - 1), RETRY_MAX_DELAY_NO_HEADERS))
  }

  function isGptModel(modelID?: string) {
    return typeof modelID === "string" && modelID.toLowerCase().startsWith("gpt-")
  }

  function gptFallback(error: Err, modelID?: string) {
    if (!isGptModel(modelID)) return undefined
    if (MessageV2.ContextOverflowError.isInstance(error)) return undefined
    if (MessageV2.AuthError.isInstance(error)) return undefined
    const raw = typeof error.data?.message === "string" ? error.data.message : ""
    return raw.length > 0 ? raw : "Retrying GPT model"
  }

  export function retryable(error: Err, opts?: { modelID?: string }) {
    // context overflow errors should not be retried
    if (MessageV2.ContextOverflowError.isInstance(error)) return undefined
    if (MessageV2.AuthError.isInstance(error)) return undefined
    if (MessageV2.APIError.isInstance(error)) {
      if (!error.data.isRetryable) return gptFallback(error, opts?.modelID)
      if (error.data.responseBody?.includes("FreeUsageLimitError"))
        return `Free usage exceeded, subscribe to Go https://opencode.ai/go`
      return error.data.message.includes("Overloaded") ? "Provider is overloaded" : error.data.message
    }

    // Check for rate limit patterns in plain text error messages
    const msg = error.data?.message
    if (typeof msg === "string") {
      const lower = msg.toLowerCase()
      if (
        lower.includes("rate increased too quickly") ||
        lower.includes("rate limit") ||
        lower.includes("too many requests")
      ) {
        return msg
      }
    }

    const json = iife(() => {
      try {
        if (typeof error.data?.message === "string") {
          const parsed = JSON.parse(error.data.message)
          return parsed
        }

        return JSON.parse(error.data.message)
      } catch {
        return undefined
      }
    })
    if (!json || typeof json !== "object") return gptFallback(error, opts?.modelID)
    const code = typeof json.code === "string" ? json.code : ""

    if (json.type === "error" && json.error?.type === "too_many_requests") {
      return "Too Many Requests"
    }
    if (code.includes("exhausted") || code.includes("unavailable")) {
      return "Provider is overloaded"
    }
    if (json.type === "error" && typeof json.error?.code === "string" && json.error.code.includes("rate_limit")) {
      return "Rate Limited"
    }
    return gptFallback(error, opts?.modelID)
  }

  function errorSummary(error: Err) {
    const raw = typeof error.data?.message === "string" ? error.data.message : ""
    const snippet = raw.length > 200 ? raw.slice(0, 200) + "..." : raw
    const statusCode = MessageV2.APIError.isInstance(error) ? error.data.statusCode : undefined
    return {
      name: error.name,
      statusCode,
      message: snippet,
    }
  }

  export function policy(opts: {
    parse: (error: unknown) => Err
    set: (input: { attempt: number; message: string; next: number }) => Effect.Effect<void>
    modelID?: string
  }) {
    return Schedule.fromStepWithMetadata(
      Effect.succeed((meta: Schedule.InputMetadata<unknown>) => {
        const error = opts.parse(meta.input)
        const summary = errorSummary(error)
        if (meta.attempt > RETRY_MAX_ATTEMPTS) {
          const info = { attempt: meta.attempt, max: RETRY_MAX_ATTEMPTS, modelID: opts.modelID, ...summary }
          log.error("retry limit reached", info)
          retryLog("ERROR", "retry limit reached", info)
          return Cause.done(meta.attempt)
        }
        const message = retryable(error, { modelID: opts.modelID })
        if (!message) {
          const info = { attempt: meta.attempt, modelID: opts.modelID, ...summary }
          log.warn("giving up, error not retryable", info)
          retryLog("WARN", "giving up, error not retryable", info)
          return Cause.done(meta.attempt)
        }
        return Effect.gen(function* () {
          const wait = delay(meta.attempt, MessageV2.APIError.isInstance(error) ? error : undefined)
          const now = yield* Clock.currentTimeMillis
          const info = {
            attempt: meta.attempt,
            max: RETRY_MAX_ATTEMPTS,
            waitMs: wait,
            reason: message,
            modelID: opts.modelID,
            ...summary,
          }
          log.warn("retrying", info)
          retryLog("WARN", "retrying", info)
          yield* opts.set({ attempt: meta.attempt, message, next: now + wait })
          return [meta.attempt, Duration.millis(wait)] as [number, Duration.Duration]
        })
      }),
    )
  }
}
