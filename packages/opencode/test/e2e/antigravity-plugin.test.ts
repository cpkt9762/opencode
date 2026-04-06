import { expect, test } from "bun:test"
import path from "path"

import type { Agent } from "../../src/agent/agent"
import { Auth } from "../../src/auth"
import { Plugin } from "../../src/plugin"
import { Instance } from "../../src/project/instance"
import { Provider } from "../../src/provider/provider"
import { ModelID, ProviderID } from "../../src/provider/schema"
import type { MessageV2 } from "../../src/session/message-v2"
import { LLM } from "../../src/session/llm"
import { MessageID, SessionID } from "../../src/session/schema"
import { tmpdir } from "../fixture/fixture"

const FILE =
  "file:///Users/pingzi/Developer/work/AIGC/opencode/3rd-github/opencode-antigravity-auth/dist/antigravity-auth.js"
const MODEL = "antigravity-claude-opus-4-6-thinking"
const TOKEN = "OPUS46_PLUGIN_OK"
const ACCOUNTS = path.join(process.env.HOME ?? "", ".config/opencode/antigravity-accounts.json")

async function refresh() {
  const raw = (await Bun.file(ACCOUNTS).json()) as {
    accounts?: Array<{ refreshToken?: string; enabled?: boolean }>
  }
  const hit = raw.accounts?.find((item) => item.enabled !== false && item.refreshToken)?.refreshToken
  if (!hit) throw new Error(`No enabled Antigravity account in ${ACCOUNTS}`)
  return hit
}

test(
  "opencode drives antigravity plugin with opus 4.6",
  async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(
          path.join(dir, "opencode.json"),
          JSON.stringify({
            $schema: "https://opencode.ai/config.json",
            plugin: [FILE],
            enabled_providers: ["google"],
            provider: {
              google: {
                options: {
                  apiKey: "antigravity-e2e-placeholder",
                },
                models: {
                  [MODEL]: {
                    name: "Claude Opus 4.6 Thinking (Antigravity)",
                    limit: { context: 200000, output: 64000 },
                    modalities: { input: ["text", "image", "pdf"], output: ["text"] },
                    variants: {
                      low: { thinkingConfig: { thinkingBudget: 8192 } },
                      max: { thinkingConfig: { thinkingBudget: 32768 } },
                    },
                  },
                },
              },
            },
          }),
        )
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const prev = await Auth.get("google")
        await Auth.set(
          "google",
          new Auth.Oauth({
            type: "oauth",
            refresh: await refresh(),
            access: "",
            expires: 0,
          }),
        )
        try {
          await Plugin.init()
          expect((await Plugin.list()).length).toBeGreaterThan(0)

          const model = await Provider.getModel(ProviderID.make("google"), ModelID.make(MODEL))
          const sessionID = SessionID.make("session-antigravity-e2e")
          const agent = {
            name: "test",
            mode: "primary",
            options: {},
            permission: [{ permission: "*", pattern: "*", action: "allow" }],
          } satisfies Agent.Info

          const user = {
            id: MessageID.make("user-antigravity-e2e"),
            sessionID,
            role: "user",
            time: { created: Date.now() },
            agent: agent.name,
            model: { providerID: ProviderID.make("google"), modelID: model.id },
            variant: "max",
          } satisfies MessageV2.User

          const stream = await LLM.stream({
            user,
            sessionID,
            model,
            agent,
            system: [],
            abort: new AbortController().signal,
            messages: [{ role: "user", content: `Reply with exactly: ${TOKEN}` }],
            tools: {},
          })

          let text = ""
          let reasoning = ""
          const types: string[] = []
          const errs: string[] = []
          for await (const part of stream.fullStream) {
            types.push(part.type)
            if (part.type === "text-delta") text += part.text
            if (part.type === "reasoning-delta") reasoning += part.text
            if (part.type === "error") errs.push(part.error instanceof Error ? part.error.message : String(part.error))
          }

          expect({ text, reasoning, types, errs }).toEqual(
            expect.objectContaining({
              text: expect.stringMatching(TOKEN),
            }),
          )
        } finally {
          if (prev) await Auth.set("google", prev)
          else await Auth.remove("google")
        }
      },
    })
  },
  { timeout: 180000 },
)
