import path from "path"
import { Global } from "../global"
import z from "zod"
import { Filesystem } from "../util/filesystem"

export const OAUTH_DUMMY_KEY = "opencode-oauth-dummy-key"

export namespace Auth {
  export const Oauth = z
    .object({
      type: z.literal("oauth"),
      refresh: z.string(),
      access: z.string(),
      expires: z.number(),
      accountId: z.string().optional(),
      enterpriseUrl: z.string().optional(),
    })
    .meta({ ref: "OAuth" })

  export const Api = z
    .object({
      type: z.literal("api"),
      key: z.string(),
    })
    .meta({ ref: "ApiAuth" })

  export const WellKnown = z
    .object({
      type: z.literal("wellknown"),
      key: z.string(),
      token: z.string(),
    })
    .meta({ ref: "WellKnownAuth" })

  export const CodexUsage = z.object({
    primary: z.number().optional(),
    primaryReset: z.number().optional(),
    secondary: z.number().optional(),
    secondaryReset: z.number().optional(),
    plan: z.string().optional(),
    fetchedAt: z.number().optional(),
  })
  export type CodexUsage = z.infer<typeof CodexUsage>

  export const CodexAccount = z.object({
    id: z.string(),
    email: z.string(),
    refresh: z.string(),
    access: z.string(),
    expires: z.number(),
    accountId: z.string().optional(),
    limited: z.boolean().optional(),
    resetAt: z.number().optional(),
    usage: CodexUsage.optional(),
  })
  export type CodexAccount = z.infer<typeof CodexAccount>

  export const CodexMultiAccount = z
    .object({
      type: z.literal("codex-multi"),
      accounts: z.array(CodexAccount),
      active: z.number().default(0),
    })
    .meta({ ref: "CodexMultiAccount" })
  export type CodexMultiAccount = z.infer<typeof CodexMultiAccount>

  export const Info = z.discriminatedUnion("type", [Oauth, Api, WellKnown, CodexMultiAccount]).meta({ ref: "Auth" })
  export type Info = z.infer<typeof Info>

  const filepath = path.join(Global.Path.data, "auth.json")

  async function raw(): Promise<Record<string, unknown>> {
    return Filesystem.readJson<Record<string, unknown>>(filepath).catch(() => ({}))
  }

  export async function get(providerID: string) {
    const auth = await all()
    return auth[providerID]
  }

  export async function all(): Promise<Record<string, Info>> {
    const data = await raw()
    return Object.entries(data).reduce(
      (acc, [key, value]) => {
        const parsed = Info.safeParse(value)
        if (!parsed.success) return acc
        acc[key] = parsed.data
        return acc
      },
      {} as Record<string, Info>,
    )
  }

  export async function set(key: string, info: Info) {
    const normalized = key.replace(/\/+$/, "")
    const data = await all()
    if (normalized !== key) delete data[key]
    delete data[normalized + "/"]
    await Filesystem.writeJson(filepath, { ...data, [normalized]: info }, 0o600)
  }

  export async function remove(key: string) {
    const normalized = key.replace(/\/+$/, "")
    const data = await all()
    delete data[key]
    delete data[normalized]
    await Filesystem.writeJson(filepath, data, 0o600)
  }

  export async function codex(): Promise<CodexMultiAccount | undefined> {
    const data = await raw()
    const entry = data["openai"]
    if (!entry) return undefined

    const multi = CodexMultiAccount.safeParse(entry)
    if (multi.success) {
      const auth = multi.data
      if (auth.accounts.length > 0) {
        auth.active = Math.max(0, Math.min(auth.active, auth.accounts.length - 1))
      } else {
        auth.active = 0
      }
      const now = Date.now()
      for (const account of auth.accounts) {
        if (account.limited && account.resetAt && account.resetAt <= now) {
          account.limited = false
          account.resetAt = undefined
        }
      }
      return auth
    }

    const legacy = Oauth.safeParse(entry)
    if (legacy.success) {
      let email: string | undefined
      try {
        const parts = legacy.data.access.split(".")
        if (parts.length === 3) {
          const claims = JSON.parse(atob(parts[1].replace(/-/g, "+").replace(/_/g, "/")))
          email = claims?.["https://api.openai.com/profile"]?.email
        }
      } catch {}
      const migrated: CodexMultiAccount = {
        type: "codex-multi",
        accounts: [
          {
            id: crypto.randomUUID(),
            email: email ?? legacy.data.accountId ?? "account-1",
            refresh: legacy.data.refresh,
            access: legacy.data.access,
            expires: legacy.data.expires,
            accountId: legacy.data.accountId,
          },
        ],
        active: 0,
      }
      data["openai"] = migrated
      await Filesystem.writeJson(filepath, data, 0o600)
      return migrated
    }

    return undefined
  }

  export async function codexSave(auth: CodexMultiAccount): Promise<void> {
    const data = await raw()
    data["openai"] = auth
    await Filesystem.writeJson(filepath, data, 0o600)
  }

  export async function codexAdd(account: Omit<CodexAccount, "id"> & { id?: string }): Promise<void> {
    const data = await raw()
    const existing = await codex()
    const auth = existing ?? { type: "codex-multi" as const, accounts: [], active: 0 }

    const idx = auth.accounts.findIndex((a) =>
      account.accountId ? a.accountId === account.accountId : a.email === account.email,
    )
    const entry: CodexAccount = {
      id: account.id ?? crypto.randomUUID(),
      email: account.email,
      refresh: account.refresh,
      access: account.access,
      expires: account.expires,
      accountId: account.accountId,
    }
    if (idx >= 0) {
      auth.accounts[idx] = entry
    } else {
      auth.accounts.push(entry)
    }

    data["openai"] = auth
    await Filesystem.writeJson(filepath, data, 0o600)
  }

  export async function codexRemove(id: string): Promise<void> {
    const auth = await codex()
    if (!auth) return

    const idx = auth.accounts.findIndex((a) => a.id === id)
    if (idx < 0) return

    auth.accounts.splice(idx, 1)
    if (auth.accounts.length === 0) {
      await remove("openai")
      return
    }
    if (auth.active >= auth.accounts.length) {
      auth.active = auth.accounts.length - 1
    } else if (idx < auth.active) {
      auth.active--
    }
    await codexSave(auth)
  }

  export async function codexSetActive(index: number): Promise<void> {
    const auth = await codex()
    if (!auth || auth.accounts.length === 0) return
    auth.active = Math.max(0, Math.min(index, auth.accounts.length - 1))
    await codexSave(auth)
  }
}
