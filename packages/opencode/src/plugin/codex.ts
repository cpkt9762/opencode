import type { Hooks, PluginInput } from "@opencode-ai/plugin"
import { Log } from "../util/log"
import { Installation } from "../installation"
import { OAUTH_DUMMY_KEY } from "../auth"
import {
  codex,
  codexAdd,
  codexSave,
  type CodexAccount,
  type CodexMultiAccount,
  type CodexUsage,
} from "./codex-store"
import os from "os"
import { ProviderTransform } from "@/provider/transform"
import { setTimeout as sleep } from "node:timers/promises"

const log = Log.create({ service: "plugin.codex" })

const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"
const ISSUER = "https://auth.openai.com"
const CODEX_API_ENDPOINT = "https://chatgpt.com/backend-api/codex/responses"
const CODEX_USAGE_ENDPOINT = "https://chatgpt.com/backend-api/wham/usage"
const OAUTH_PORT = 1455
const OAUTH_POLLING_SAFETY_MARGIN_MS = 3000

interface PkceCodes {
  verifier: string
  challenge: string
}

async function generatePKCE(): Promise<PkceCodes> {
  const verifier = generateRandomString(43)
  const encoder = new TextEncoder()
  const data = encoder.encode(verifier)
  const hash = await crypto.subtle.digest("SHA-256", data)
  const challenge = base64UrlEncode(hash)
  return { verifier, challenge }
}

function generateRandomString(length: number): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~"
  const bytes = crypto.getRandomValues(new Uint8Array(length))
  return Array.from(bytes)
    .map((b) => chars[b % chars.length])
    .join("")
}

function base64UrlEncode(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  const binary = String.fromCharCode(...bytes)
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

function generateState(): string {
  return base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)).buffer)
}

export interface IdTokenClaims {
  chatgpt_account_id?: string
  organizations?: Array<{ id: string }>
  email?: string
  "https://api.openai.com/auth"?: {
    chatgpt_account_id?: string
  }
  "https://api.openai.com/profile"?: {
    email?: string
  }
}

export function parseJwtClaims(token: string): IdTokenClaims | undefined {
  const parts = token.split(".")
  if (parts.length !== 3) return undefined
  try {
    return JSON.parse(Buffer.from(parts[1], "base64url").toString())
  } catch {
    return undefined
  }
}

export function extractAccountIdFromClaims(claims: IdTokenClaims): string | undefined {
  return (
    claims.chatgpt_account_id ||
    claims["https://api.openai.com/auth"]?.chatgpt_account_id ||
    claims.organizations?.[0]?.id
  )
}

export function extractAccountId(tokens: TokenResponse): string | undefined {
  if (tokens.id_token) {
    const claims = parseJwtClaims(tokens.id_token)
    const accountId = claims && extractAccountIdFromClaims(claims)
    if (accountId) return accountId
  }
  if (tokens.access_token) {
    const claims = parseJwtClaims(tokens.access_token)
    return claims ? extractAccountIdFromClaims(claims) : undefined
  }
  return undefined
}

function buildAuthorizeUrl(redirectUri: string, pkce: PkceCodes, state: string): string {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: CLIENT_ID,
    redirect_uri: redirectUri,
    scope: "openid profile email offline_access",
    code_challenge: pkce.challenge,
    code_challenge_method: "S256",
    id_token_add_organizations: "true",
    codex_cli_simplified_flow: "true",
    state,
    originator: "opencode",
  })
  return `${ISSUER}/oauth/authorize?${params.toString()}`
}

interface TokenResponse {
  id_token: string
  access_token: string
  refresh_token: string
  expires_in?: number
}

async function exchangeCodeForTokens(code: string, redirectUri: string, pkce: PkceCodes): Promise<TokenResponse> {
  const response = await fetch(`${ISSUER}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: CLIENT_ID,
      code_verifier: pkce.verifier,
    }).toString(),
  })
  if (!response.ok) {
    throw new Error(`Token exchange failed: ${response.status}`)
  }
  return response.json()
}

async function refreshAccessToken(refreshToken: string): Promise<TokenResponse> {
  const response = await fetch(`${ISSUER}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: CLIENT_ID,
    }).toString(),
  })
  if (!response.ok) {
    throw new Error(`Token refresh failed: ${response.status}`)
  }
  return response.json()
}

interface UsageResponse {
  plan_type?: string
  rate_limit?: {
    primary_window?: {
      used_percent: number
      reset_at?: number
    }
    secondary_window?: {
      used_percent: number
      reset_at?: number
    }
  }
}

export async function fetchCodexUsage(
  account: CodexAccount,
  multi?: CodexMultiAccount,
): Promise<CodexUsage> {
  if (!account.access || account.expires < Date.now()) {
    const tokens = await refreshAccessToken(account.refresh)
    account.access = tokens.access_token
    account.refresh = tokens.refresh_token ?? account.refresh
    account.expires = Date.now() + (tokens.expires_in ?? 3600) * 1000
    account.accountId = extractAccountId(tokens) ?? account.accountId
    if (multi) await codexSave(multi)
  }

  const headers: Record<string, string> = {
    authorization: `Bearer ${account.access}`,
    accept: "application/json",
  }
  if (account.accountId) headers["ChatGPT-Account-Id"] = account.accountId

  const response = await fetch(CODEX_USAGE_ENDPOINT, { headers })
  if (!response.ok) throw new Error(`Usage fetch failed: ${response.status}`)

  const data: UsageResponse = await response.json()
  return {
    primary: data.rate_limit?.primary_window?.used_percent,
    primaryReset: data.rate_limit?.primary_window?.reset_at
      ? data.rate_limit.primary_window.reset_at * 1000
      : undefined,
    secondary: data.rate_limit?.secondary_window?.used_percent,
    secondaryReset: data.rate_limit?.secondary_window?.reset_at
      ? data.rate_limit.secondary_window.reset_at * 1000
      : undefined,
    plan: data.plan_type,
    fetchedAt: Date.now(),
  }
}

const HTML_SUCCESS = `<!doctype html>
<html>
  <head>
    <title>OpenCode - Codex Authorization Successful</title>
    <style>
      body {
        font-family:
          system-ui,
          -apple-system,
          sans-serif;
        display: flex;
        justify-content: center;
        align-items: center;
        height: 100vh;
        margin: 0;
        background: #131010;
        color: #f1ecec;
      }
      .container {
        text-align: center;
        padding: 2rem;
      }
      h1 {
        color: #f1ecec;
        margin-bottom: 1rem;
      }
      p {
        color: #b7b1b1;
      }
    </style>
  </head>
  <body>
    <div class="container">
      <h1>Authorization Successful</h1>
      <p>You can close this window and return to OpenCode.</p>
    </div>
    <script>
      setTimeout(() => window.close(), 2000)
    </script>
  </body>
</html>`

const HTML_ERROR = (error: string) => `<!doctype html>
<html>
  <head>
    <title>OpenCode - Codex Authorization Failed</title>
    <style>
      body {
        font-family:
          system-ui,
          -apple-system,
          sans-serif;
        display: flex;
        justify-content: center;
        align-items: center;
        height: 100vh;
        margin: 0;
        background: #131010;
        color: #f1ecec;
      }
      .container {
        text-align: center;
        padding: 2rem;
      }
      h1 {
        color: #fc533a;
        margin-bottom: 1rem;
      }
      p {
        color: #b7b1b1;
      }
      .error {
        color: #ff917b;
        font-family: monospace;
        margin-top: 1rem;
        padding: 1rem;
        background: #3c140d;
        border-radius: 0.5rem;
      }
    </style>
  </head>
  <body>
    <div class="container">
      <h1>Authorization Failed</h1>
      <p>An error occurred during authorization.</p>
      <div class="error">${error}</div>
    </div>
  </body>
</html>`

interface PendingOAuth {
  pkce: PkceCodes
  state: string
  resolve: (tokens: TokenResponse) => void
  reject: (error: Error) => void
}

let oauthServer: ReturnType<typeof Bun.serve> | undefined
let pendingOAuth: PendingOAuth | undefined

async function startOAuthServer(): Promise<{ port: number; redirectUri: string }> {
  if (oauthServer) {
    return { port: OAUTH_PORT, redirectUri: `http://localhost:${OAUTH_PORT}/auth/callback` }
  }

  oauthServer = Bun.serve({
    port: OAUTH_PORT,
    fetch(req) {
      const url = new URL(req.url)

      if (url.pathname === "/auth/callback") {
        const code = url.searchParams.get("code")
        const state = url.searchParams.get("state")
        const error = url.searchParams.get("error")
        const errorDescription = url.searchParams.get("error_description")

        if (error) {
          const errorMsg = errorDescription || error
          pendingOAuth?.reject(new Error(errorMsg))
          pendingOAuth = undefined
          return new Response(HTML_ERROR(errorMsg), {
            headers: { "Content-Type": "text/html" },
          })
        }

        if (!code) {
          const errorMsg = "Missing authorization code"
          pendingOAuth?.reject(new Error(errorMsg))
          pendingOAuth = undefined
          return new Response(HTML_ERROR(errorMsg), {
            status: 400,
            headers: { "Content-Type": "text/html" },
          })
        }

        if (!pendingOAuth || state !== pendingOAuth.state) {
          const errorMsg = "Invalid state - potential CSRF attack"
          pendingOAuth?.reject(new Error(errorMsg))
          pendingOAuth = undefined
          return new Response(HTML_ERROR(errorMsg), {
            status: 400,
            headers: { "Content-Type": "text/html" },
          })
        }

        const current = pendingOAuth
        pendingOAuth = undefined

        exchangeCodeForTokens(code, `http://localhost:${OAUTH_PORT}/auth/callback`, current.pkce)
          .then((tokens) => current.resolve(tokens))
          .catch((err) => current.reject(err))

        return new Response(HTML_SUCCESS, {
          headers: { "Content-Type": "text/html" },
        })
      }

      if (url.pathname === "/cancel") {
        pendingOAuth?.reject(new Error("Login cancelled"))
        pendingOAuth = undefined
        return new Response("Login cancelled", { status: 200 })
      }

      return new Response("Not found", { status: 404 })
    },
  })

  log.info("codex oauth server started", { port: OAUTH_PORT })
  return { port: OAUTH_PORT, redirectUri: `http://localhost:${OAUTH_PORT}/auth/callback` }
}

function stopOAuthServer() {
  if (oauthServer) {
    oauthServer.stop()
    oauthServer = undefined
    log.info("codex oauth server stopped")
  }
}

function waitForOAuthCallback(pkce: PkceCodes, state: string): Promise<TokenResponse> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => {
        if (pendingOAuth) {
          pendingOAuth = undefined
          reject(new Error("OAuth callback timeout - authorization took too long"))
        }
      },
      5 * 60 * 1000,
    ) // 5 minute timeout

    pendingOAuth = {
      pkce,
      state,
      resolve: (tokens) => {
        clearTimeout(timeout)
        resolve(tokens)
      },
      reject: (error) => {
        clearTimeout(timeout)
        reject(error)
      },
    }
  })
}

function stripAuthHeader(init?: RequestInit) {
  if (!init?.headers) return
  if (init.headers instanceof Headers) {
    init.headers.delete("authorization")
    init.headers.delete("Authorization")
  } else if (Array.isArray(init.headers)) {
    init.headers = init.headers.filter(([key]) => key.toLowerCase() !== "authorization")
  } else {
    delete init.headers["authorization"]
    delete init.headers["Authorization"]
  }
}

function mergeHeaders(init?: RequestInit): Headers {
  const headers = new Headers()
  if (!init?.headers) return headers
  if (init.headers instanceof Headers) {
    init.headers.forEach((value, key) => {
      headers.set(key, value)
    })
  } else if (Array.isArray(init.headers)) {
    for (const [key, value] of init.headers) {
      if (value !== undefined) headers.set(key, String(value))
    }
  } else {
    for (const [key, value] of Object.entries(init.headers)) {
      if (value !== undefined) headers.set(key, String(value))
    }
  }
  return headers
}

function rewriteUrl(requestInput: RequestInfo | URL): URL {
  const parsed =
    requestInput instanceof URL
      ? requestInput
      : new URL(typeof requestInput === "string" ? requestInput : requestInput.url)
  if (parsed.pathname.includes("/v1/responses") || parsed.pathname.includes("/chat/completions"))
    return new URL(CODEX_API_ENDPOINT)
  return parsed
}

function filterModels(provider: { models: Record<string, any> }) {
  const allowed = new Set([
    "gpt-5.1-codex-max",
    "gpt-5.1-codex-mini",
    "gpt-5.2",
    "gpt-5.4",
    "gpt-5.2-codex",
    "gpt-5.3-codex",
    "gpt-5.1-codex",
  ])
  for (const id of Object.keys(provider.models)) {
    if (id.includes("codex")) continue
    if (allowed.has(id)) continue
    delete provider.models[id]
  }

  if (!provider.models["gpt-5.3-codex"]) {
    const model = {
      id: "gpt-5.3-codex",
      providerID: "openai",
      api: {
        id: "gpt-5.3-codex",
        url: "https://chatgpt.com/backend-api/codex",
        npm: "@ai-sdk/openai",
      },
      name: "GPT-5.3 Codex",
      capabilities: {
        temperature: false,
        reasoning: true,
        attachment: true,
        toolcall: true,
        input: { text: true, audio: false, image: true, video: false, pdf: false },
        output: { text: true, audio: false, image: false, video: false, pdf: false },
        interleaved: false,
      },
      cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
      limit: { context: 400_000, input: 272_000, output: 128_000 },
      status: "active" as const,
      options: {},
      headers: {},
      release_date: "2026-02-05",
      variants: {} as Record<string, Record<string, any>>,
      family: "gpt-codex",
    }
    model.variants = ProviderTransform.variants(model)
    provider.models["gpt-5.3-codex"] = model
  }

  for (const model of Object.values(provider.models)) {
    ;(model as any).cost = { input: 0, output: 0, cache: { read: 0, write: 0 } }
  }
}

async function codexFetch(
  account: CodexAccount,
  multiAuth: CodexMultiAccount,
  requestInput: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  if (!account.access || account.expires < Date.now()) {
    log.info("refreshing codex access token", { email: account.email })
    const tokens = await refreshAccessToken(account.refresh)
    account.access = tokens.access_token
    account.refresh = tokens.refresh_token ?? account.refresh
    account.expires = Date.now() + (tokens.expires_in ?? 3600) * 1000
    account.accountId = extractAccountId(tokens) ?? account.accountId
    await codexSave(multiAuth)
  }

  const headers = mergeHeaders(init)
  headers.set("authorization", `Bearer ${account.access}`)
  if (account.accountId) headers.set("ChatGPT-Account-Id", account.accountId)

  const response = await fetch(rewriteUrl(requestInput), { ...init, headers })

  if (response.status === 429 && multiAuth.accounts.length > 1) {
    account.limited = true
    account.resetAt = Date.now() + 5 * 3600 * 1000
    const next = multiAuth.accounts.findIndex((a, i) => i !== multiAuth.active && !a.limited)
    if (next >= 0) {
      log.info("rotating to next account", { from: account.email, to: multiAuth.accounts[next].email })
      multiAuth.active = next
      await codexSave(multiAuth)
      return codexFetch(multiAuth.accounts[next], multiAuth, requestInput, init)
    }
    await codexSave(multiAuth)
  }

  const primary = response.headers.get("x-codex-primary-used-percent")
  const secondary = response.headers.get("x-codex-secondary-used-percent")
  if (primary || secondary) {
    const primaryReset = response.headers.get("x-codex-primary-reset-at")
    const secondaryReset = response.headers.get("x-codex-secondary-reset-at")
    account.usage = {
      primary: primary ? Number(primary) : account.usage?.primary,
      primaryReset: primaryReset ? Number(primaryReset) * 1000 : account.usage?.primaryReset,
      secondary: secondary ? Number(secondary) : account.usage?.secondary,
      secondaryReset: secondaryReset ? Number(secondaryReset) * 1000 : account.usage?.secondaryReset,
      plan: account.usage?.plan,
      fetchedAt: Date.now(),
    }
    codexSave(multiAuth).catch(() => {})
  }

  return response
}

async function oauthToMultiAccount(tokens: TokenResponse): Promise<void> {
  const accountId = extractAccountId(tokens)
  const email = extractEmail(tokens)
  const resolved = email ?? accountId ?? "account-" + Date.now()
  log.info("codex oauth resolved", {
    email,
    accountId,
    resolved,
    hasIdToken: !!tokens.id_token,
    hasAccessToken: !!tokens.access_token,
  })
  await codexAdd({
    email: resolved,
    refresh: tokens.refresh_token,
    access: tokens.access_token,
    expires: Date.now() + (tokens.expires_in ?? 3600) * 1000,
    accountId,
  })
}

export function extractEmail(tokens: TokenResponse): string | undefined {
  for (const token of [tokens.id_token, tokens.access_token]) {
    if (!token) continue
    const claims = parseJwtClaims(token)
    if (!claims) continue
    const email = claims.email || claims["https://api.openai.com/profile"]?.email
    if (email) return email
  }
  return undefined
}

export async function CodexAuthPlugin(input: PluginInput): Promise<Hooks> {
  return {
    auth: {
      provider: "openai",
      async loader(getAuth, provider) {
        const multiAuth = await codex()
        const auth = await getAuth()
        if (auth.type !== "oauth" && !multiAuth) return {}

        filterModels(provider)

        if (!multiAuth || multiAuth.accounts.length === 0) {
          if (auth.type !== "oauth") return {}
          return {
            apiKey: OAUTH_DUMMY_KEY,
            async fetch(requestInput: RequestInfo | URL, init?: RequestInit) {
              stripAuthHeader(init)
              const current = await getAuth()
              if (current.type !== "oauth") return fetch(requestInput, init)

              if (!current.access || current.expires < Date.now()) {
                log.info("refreshing codex access token")
                const tokens = await refreshAccessToken(current.refresh)
                const aid = extractAccountId(tokens) || (current as any).accountId
                await input.client.auth.set({
                  path: { id: "openai" },
                  body: {
                    type: "oauth",
                    refresh: tokens.refresh_token,
                    access: tokens.access_token,
                    expires: Date.now() + (tokens.expires_in ?? 3600) * 1000,
                    ...(aid && { accountId: aid }),
                  },
                })
                current.access = tokens.access_token
              }

              const headers = mergeHeaders(init)
              headers.set("authorization", `Bearer ${current.access}`)
              if ((current as any).accountId) headers.set("ChatGPT-Account-Id", (current as any).accountId)
              return fetch(rewriteUrl(requestInput), { ...init, headers })
            },
          }
        }

        return {
          apiKey: OAUTH_DUMMY_KEY,
          async fetch(requestInput: RequestInfo | URL, init?: RequestInit) {
            stripAuthHeader(init)
            const fresh = await codex()
            if (!fresh || fresh.accounts.length === 0) return fetch(requestInput, init)
            const account = fresh.accounts[fresh.active]
            if (!account) return fetch(requestInput, init)
            return codexFetch(account, fresh, requestInput, init)
          },
        }
      },
      methods: [
        {
          label: "ChatGPT Pro/Plus (browser)",
          type: "oauth",
          authorize: async () => {
            const { redirectUri } = await startOAuthServer()
            const pkce = await generatePKCE()
            const state = generateState()
            const authUrl = buildAuthorizeUrl(redirectUri, pkce, state)

            const callbackPromise = waitForOAuthCallback(pkce, state)

            return {
              url: authUrl,
              instructions: "Complete authorization in your browser. This window will close automatically.",
              method: "auto" as const,
              callback: async () => {
                const tokens = await callbackPromise
                stopOAuthServer()
                await oauthToMultiAccount(tokens)
                return {
                  type: "success" as const,
                  refresh: tokens.refresh_token,
                  access: tokens.access_token,
                  expires: Date.now() + (tokens.expires_in ?? 3600) * 1000,
                  accountId: extractAccountId(tokens),
                }
              },
            }
          },
        },
        {
          label: "ChatGPT Pro/Plus (headless)",
          type: "oauth",
          authorize: async () => {
            const deviceResponse = await fetch(`${ISSUER}/api/accounts/deviceauth/usercode`, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "User-Agent": `opencode/${Installation.VERSION}`,
              },
              body: JSON.stringify({ client_id: CLIENT_ID }),
            })

            if (!deviceResponse.ok) throw new Error("Failed to initiate device authorization")

            const deviceData = (await deviceResponse.json()) as {
              device_auth_id: string
              user_code: string
              interval: string
            }
            const interval = Math.max(parseInt(deviceData.interval) || 5, 1) * 1000

            return {
              url: `${ISSUER}/codex/device`,
              instructions: `Enter code: ${deviceData.user_code}`,
              method: "auto" as const,
              async callback() {
                while (true) {
                  const response = await fetch(`${ISSUER}/api/accounts/deviceauth/token`, {
                    method: "POST",
                    headers: {
                      "Content-Type": "application/json",
                      "User-Agent": `opencode/${Installation.VERSION}`,
                    },
                    body: JSON.stringify({
                      device_auth_id: deviceData.device_auth_id,
                      user_code: deviceData.user_code,
                    }),
                  })

                  if (response.ok) {
                    const data = (await response.json()) as {
                      authorization_code: string
                      code_verifier: string
                    }

                    const tokenResponse = await fetch(`${ISSUER}/oauth/token`, {
                      method: "POST",
                      headers: { "Content-Type": "application/x-www-form-urlencoded" },
                      body: new URLSearchParams({
                        grant_type: "authorization_code",
                        code: data.authorization_code,
                        redirect_uri: `${ISSUER}/deviceauth/callback`,
                        client_id: CLIENT_ID,
                        code_verifier: data.code_verifier,
                      }).toString(),
                    })

                    if (!tokenResponse.ok) {
                      throw new Error(`Token exchange failed: ${tokenResponse.status}`)
                    }

                    const tokens: TokenResponse = await tokenResponse.json()
                    await oauthToMultiAccount(tokens)

                    return {
                      type: "success" as const,
                      refresh: tokens.refresh_token,
                      access: tokens.access_token,
                      expires: Date.now() + (tokens.expires_in ?? 3600) * 1000,
                      accountId: extractAccountId(tokens),
                    }
                  }

                  if (response.status !== 403 && response.status !== 404) {
                    return { type: "failed" as const }
                  }

                  await sleep(interval + OAUTH_POLLING_SAFETY_MARGIN_MS)
                }
              },
            }
          },
        },
        {
          label: "Manually enter API Key",
          type: "api",
        },
      ],
    },
    "chat.headers": async (input, output) => {
      if (input.model.providerID !== "openai") return
      output.headers.originator = "opencode"
      output.headers["User-Agent"] = `opencode/${Installation.VERSION} (${os.platform()} ${os.release()}; ${os.arch()})`
      output.headers.session_id = input.sessionID
    },
  }
}
