import path from "path"
import z from "zod"
import { Global } from "../global"
import { Filesystem } from "../util/filesystem"
import { Auth } from "../auth"
import { Log } from "../util/log"

const log = Log.create({ service: "codex" })

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

const filepath = path.join(Global.Path.data, "auth.json")

async function raw(): Promise<Record<string, unknown>> {
  return Filesystem.readJson<Record<string, unknown>>(filepath).catch(() => ({}))
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

  const legacy = Auth.Oauth.safeParse(entry)
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

  const idx = auth.accounts.findIndex((a) => a.email === account.email)
  const entry: CodexAccount = {
    id: account.id ?? crypto.randomUUID(),
    email: account.email,
    refresh: account.refresh,
    access: account.access,
    expires: account.expires,
    accountId: account.accountId,
  }
  if (idx >= 0) {
    log.info("codex account updated", { email: account.email, accountId: account.accountId })
    entry.id = auth.accounts[idx].id
    auth.accounts[idx] = entry
  } else {
    log.info("codex account added", { email: account.email, accountId: account.accountId })
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
    const data = await raw()
    delete data["openai"]
    await Filesystem.writeJson(filepath, data, 0o600)
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
