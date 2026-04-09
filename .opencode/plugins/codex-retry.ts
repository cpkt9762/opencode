import type { Hooks } from "@opencode-ai/plugin"
import { active, codexRetryMiddleware } from "../../packages/opencode/src/session/codex-retry-middleware"

const mw = codexRetryMiddleware()

export default async () =>
  ({
    "llm.middleware": async (input, output) => {
      if (!active(input.providerID, input.model.id)) return
      output.middleware.push(mw)
    },
  }) satisfies Hooks
