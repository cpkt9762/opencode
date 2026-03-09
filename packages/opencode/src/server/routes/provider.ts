import { Hono } from "hono"
import { describeRoute, validator, resolver } from "hono-openapi"
import z from "zod"
import { Config } from "../../config/config"
import { Provider } from "../../provider/provider"
import { ModelsDev } from "../../provider/models"
import { ProviderAuth } from "../../provider/auth"
import { fetchCodexUsage } from "../../plugin/codex"
import { CodexUsage, codex, codexSave, codexSetActive, codexRemove } from "../../plugin/codex-store"
import { mapValues } from "remeda"
import { errors } from "../error"
import { lazy } from "../../util/lazy"

export const ProviderRoutes = lazy(() =>
  new Hono()
    .get(
      "/",
      describeRoute({
        summary: "List providers",
        description: "Get a list of all available AI providers, including both available and connected ones.",
        operationId: "provider.list",
        responses: {
          200: {
            description: "List of providers",
            content: {
              "application/json": {
                schema: resolver(
                  z.object({
                    all: ModelsDev.Provider.array(),
                    default: z.record(z.string(), z.string()),
                    connected: z.array(z.string()),
                  }),
                ),
              },
            },
          },
        },
      }),
      async (c) => {
        const config = await Config.get()
        const disabled = new Set(config.disabled_providers ?? [])
        const enabled = config.enabled_providers ? new Set(config.enabled_providers) : undefined

        const allProviders = await ModelsDev.get()
        const filteredProviders: Record<string, (typeof allProviders)[string]> = {}
        for (const [key, value] of Object.entries(allProviders)) {
          if ((enabled ? enabled.has(key) : true) && !disabled.has(key)) {
            filteredProviders[key] = value
          }
        }

        const connected = await Provider.list()
        const providers = Object.assign(
          mapValues(filteredProviders, (x) => Provider.fromModelsDevProvider(x)),
          connected,
        )
        return c.json({
          all: Object.values(providers),
          default: mapValues(providers, (item) => Provider.sort(Object.values(item.models))[0].id),
          connected: Object.keys(connected),
        })
      },
    )
    .get(
      "/auth",
      describeRoute({
        summary: "Get provider auth methods",
        description: "Retrieve available authentication methods for all AI providers.",
        operationId: "provider.auth",
        responses: {
          200: {
            description: "Provider auth methods",
            content: {
              "application/json": {
                schema: resolver(z.record(z.string(), z.array(ProviderAuth.Method))),
              },
            },
          },
        },
      }),
      async (c) => {
        return c.json(await ProviderAuth.methods())
      },
    )
    .post(
      "/:providerID/oauth/authorize",
      describeRoute({
        summary: "OAuth authorize",
        description: "Initiate OAuth authorization for a specific AI provider to get an authorization URL.",
        operationId: "provider.oauth.authorize",
        responses: {
          200: {
            description: "Authorization URL and method",
            content: {
              "application/json": {
                schema: resolver(ProviderAuth.Authorization.optional()),
              },
            },
          },
          ...errors(400),
        },
      }),
      validator(
        "param",
        z.object({
          providerID: z.string().meta({ description: "Provider ID" }),
        }),
      ),
      validator(
        "json",
        z.object({
          method: z.number().meta({ description: "Auth method index" }),
        }),
      ),
      async (c) => {
        const providerID = c.req.valid("param").providerID
        const { method } = c.req.valid("json")
        const result = await ProviderAuth.authorize({
          providerID,
          method,
        })
        return c.json(result)
      },
    )
    .post(
      "/:providerID/oauth/callback",
      describeRoute({
        summary: "OAuth callback",
        description: "Handle the OAuth callback from a provider after user authorization.",
        operationId: "provider.oauth.callback",
        responses: {
          200: {
            description: "OAuth callback processed successfully",
            content: {
              "application/json": {
                schema: resolver(z.boolean()),
              },
            },
          },
          ...errors(400),
        },
      }),
      validator(
        "param",
        z.object({
          providerID: z.string().meta({ description: "Provider ID" }),
        }),
      ),
      validator(
        "json",
        z.object({
          method: z.number().meta({ description: "Auth method index" }),
          code: z.string().optional().meta({ description: "OAuth authorization code" }),
        }),
      ),
      async (c) => {
        const providerID = c.req.valid("param").providerID
        const { method, code } = c.req.valid("json")
        await ProviderAuth.callback({
          providerID,
          method,
          code,
        })
        return c.json(true)
      },
    )
    .get(
      "/codex/accounts",
      describeRoute({
        summary: "List Codex accounts",
        description: "Get all Codex multi-account entries with usage info.",
        operationId: "provider.codex.accounts",
        responses: {
          200: {
            description: "Codex accounts",
            content: {
              "application/json": {
                schema: resolver(
                  z.object({
                    accounts: z.array(
                      z.object({
                        id: z.string(),
                        email: z.string(),
                        active: z.boolean(),
                        limited: z.boolean(),
                        resetAt: z.number().optional(),
                      }),
                    ),
                  }),
                ),
              },
            },
          },
        },
      }),
      async (c) => {
        const multi = await codex()
        if (!multi) return c.json({ accounts: [] })
        return c.json({
          accounts: multi.accounts.map((a, i) => ({
            id: a.id,
            email: a.email,
            active: i === multi.active,
            limited: !!a.limited,
            resetAt: a.resetAt,
          })),
        })
      },
    )
    .post(
      "/codex/active",
      describeRoute({
        summary: "Set active Codex account",
        description: "Switch the active Codex account by index.",
        operationId: "provider.codex.active",
        responses: {
          200: {
            description: "Active account updated",
            content: {
              "application/json": {
                schema: resolver(z.boolean()),
              },
            },
          },
          ...errors(400),
        },
      }),
      validator(
        "json",
        z.object({
          index: z.number(),
        }),
      ),
      async (c) => {
        const { index } = c.req.valid("json")
        await codexSetActive(index)
        return c.json(true)
      },
    )
    .delete(
      "/codex/accounts/:id",
      describeRoute({
        summary: "Remove Codex account",
        description: "Remove a Codex account by ID.",
        operationId: "provider.codex.remove",
        responses: {
          200: {
            description: "Account removed",
            content: {
              "application/json": {
                schema: resolver(z.boolean()),
              },
            },
          },
          ...errors(400),
        },
      }),
      validator(
        "param",
        z.object({
          id: z.string(),
        }),
      ),
      async (c) => {
        const { id } = c.req.valid("param")
        await codexRemove(id)
        return c.json(true)
      },
    )
    .get(
      "/codex/usage",
      describeRoute({
        summary: "Get Codex account usage",
        description: "Fetch usage data for all Codex accounts from ChatGPT API.",
        operationId: "provider.codex.usage",
        responses: {
          200: {
            description: "Codex account usage",
            content: {
              "application/json": {
                schema: resolver(
                  z.object({
                    accounts: z.array(
                      z.object({
                        id: z.string(),
                        email: z.string(),
                        active: z.boolean(),
                        usage: CodexUsage.nullable(),
                        error: z.string().optional(),
                      }),
                    ),
                  }),
                ),
              },
            },
          },
        },
      }),
      async (c) => {
        const multi = await codex()
        if (!multi) return c.json({ accounts: [] })
        const results = await Promise.all(
          multi.accounts.map(async (account, i) => {
            try {
              const usage = await fetchCodexUsage(account, multi)
              account.usage = usage
              return { id: account.id, email: account.email, active: i === multi.active, usage, error: undefined }
            } catch (err) {
              return {
                id: account.id,
                email: account.email,
                active: i === multi.active,
                usage: account.usage ?? null,
                error: err instanceof Error ? err.message : String(err),
              }
            }
          }),
        )
        await codexSave(multi)
        return c.json({ accounts: results })
      },
    ),
)
