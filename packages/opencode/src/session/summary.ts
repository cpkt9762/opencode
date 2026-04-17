import z from "zod"
import { Effect, Layer, Context } from "effect"
import { Bus } from "@/bus"
import { Snapshot } from "@/snapshot"
import { Storage } from "@/storage"
import * as Session from "./session"
import type { MessageV2 } from "./message-v2"
import { SessionID, MessageID } from "./schema"

export namespace SessionSummary {
  export interface Interface {
    readonly summarize: (input: { sessionID: SessionID; messageID: MessageID }) => Effect.Effect<void>
    readonly diff: (input: { sessionID: SessionID; messageID?: MessageID }) => Effect.Effect<Snapshot.FileDiff[]>
    readonly computeDiff: (input: { messages: MessageV2.WithParts[] }) => Effect.Effect<Snapshot.FileDiff[]>
  }

  export class Service extends Context.Service<Service, Interface>()("@opencode/SessionSummary") {}

  export const layer = Layer.effect(
    Service,
    Effect.gen(function* () {
      const snapshot = yield* Snapshot.Service

      const computeDiff = Effect.fn("SessionSummary.computeDiff")(function* (input: {
        messages: MessageV2.WithParts[]
      }) {
        let from: string | undefined
        let to: string | undefined
        for (const item of input.messages) {
          if (!from) {
            for (const part of item.parts) {
              if (part.type === "step-start" && part.snapshot) {
                from = part.snapshot
                break
              }
            }
          }
          for (const part of item.parts) {
            if (part.type === "step-finish" && part.snapshot) to = part.snapshot
          }
        }
        if (from && to) return yield* snapshot.diffFull(from, to)
        return []
      })

      // TODO: session diff disabled — investigating desktop perf
      const summarize = Effect.fn("SessionSummary.summarize")(function* (_input: {
        sessionID: SessionID
        messageID: MessageID
      }) {
        yield* Effect.void
      })

      const diff = Effect.fn("SessionSummary.diff")(function* (_input: {
        sessionID: SessionID
        messageID?: MessageID
      }) {
        yield* Effect.void
        return [] as Snapshot.FileDiff[]
      })

      return Service.of({ summarize, diff, computeDiff })
    }),
  )

  export const defaultLayer = Layer.suspend(() =>
    layer.pipe(
      Layer.provide(Session.defaultLayer),
      Layer.provide(Snapshot.defaultLayer),
      Layer.provide(Storage.defaultLayer),
      Layer.provide(Bus.layer),
    ),
  )

  export const DiffInput = z.object({
    sessionID: SessionID.zod,
    messageID: MessageID.zod.optional(),
  })
}
