import { Button } from "@opencode-ai/ui/button"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { ProviderIcon } from "@opencode-ai/ui/provider-icon"
import { Tag } from "@opencode-ai/ui/tag"
import { showToast } from "@opencode-ai/ui/toast"
import { Spinner } from "@opencode-ai/ui/spinner"
import { popularProviders, useProviders } from "@/hooks/use-providers"
import { createMemo, createResource, createSignal, type Component, For, Show } from "solid-js"
import { useLanguage } from "@/context/language"
import { useGlobalSDK } from "@/context/global-sdk"
import { useGlobalSync } from "@/context/global-sync"
import { DialogConnectProvider } from "./dialog-connect-provider"
import { DialogSelectProvider } from "./dialog-select-provider"
import { DialogCustomProvider } from "./dialog-custom-provider"

type ProviderSource = "env" | "api" | "config" | "custom"
type ProviderItem = ReturnType<ReturnType<typeof useProviders>["connected"]>[number]

interface CodexAccountInfo {
  id: string
  email: string
  active: boolean
  limited: boolean
  resetAt?: number
}

interface CodexUsageInfo {
  primary?: number
  primaryReset?: number
  secondary?: number
  secondaryReset?: number
  plan?: string
}

function usageColor(percent?: number): string {
  if (percent === undefined) return "bg-fill-base"
  if (percent <= 50) return "bg-fill-success-base"
  if (percent <= 80) return "bg-fill-warning-base"
  return "bg-fill-danger-base"
}

const PROVIDER_NOTES = [
  { match: (id: string) => id === "opencode", key: "dialog.provider.opencode.note" },
  { match: (id: string) => id === "opencode-go", key: "dialog.provider.opencodeGo.tagline" },
  { match: (id: string) => id === "anthropic", key: "dialog.provider.anthropic.note" },
  { match: (id: string) => id.startsWith("github-copilot"), key: "dialog.provider.copilot.note" },
  { match: (id: string) => id === "openai", key: "dialog.provider.openai.note" },
  { match: (id: string) => id === "google", key: "dialog.provider.google.note" },
  { match: (id: string) => id === "openrouter", key: "dialog.provider.openrouter.note" },
  { match: (id: string) => id === "vercel", key: "dialog.provider.vercel.note" },
] as const

function formatReset(resetAt?: number): string {
  if (!resetAt) return ""
  const diff = resetAt - Date.now()
  if (diff <= 0) return "now"
  const hours = Math.floor(diff / 3_600_000)
  const minutes = Math.floor((diff % 3_600_000) / 60_000)
  if (hours > 0) return `${hours}h ${minutes}m`
  return `${minutes}m`
}

function UsageBar(props: { label: string; percent?: number; reset?: number }) {
  return (
    <Show when={props.percent !== undefined}>
      <div class="flex items-center gap-2 w-full">
        <span class="text-11-regular text-text-weak w-12 shrink-0">{props.label}</span>
        <div class="flex-1 h-1.5 bg-fill-base rounded-full overflow-hidden">
          <div
            class={`h-full rounded-full transition-all ${usageColor(props.percent)}`}
            style={{ width: `${Math.min(props.percent ?? 0, 100)}%` }}
          />
        </div>
        <span class="text-11-regular text-text-weak w-8 text-right shrink-0">{props.percent}%</span>
        <Show when={props.reset}>
          <span class="text-11-regular text-text-weakest shrink-0">· {formatReset(props.reset)}</span>
        </Show>
      </div>
    </Show>
  )
}

function CodexAccounts() {
  const globalSDK = useGlobalSDK()
  const dialog = useDialog()
  const language = useLanguage()
  const [switching, setSwitching] = createSignal<string | null>(null)
  const [removing, setRemoving] = createSignal<string | null>(null)

  const [accounts, { refetch }] = createResource(async () => {
    const res = await globalSDK.client.provider.codex.accounts()
    if (!res.data) return [] as CodexAccountInfo[]
    return res.data.accounts
  })

  const [usage] = createResource(async () => {
    const res = await globalSDK.client.provider.codex.usage()
    if (!res.data) return new Map<string, CodexUsageInfo | null>()
    const map = new Map<string, CodexUsageInfo | null>()
    for (const a of res.data.accounts) map.set(a.id, a.usage)
    return map
  })

  const switchAccount = async (index: number, email: string) => {
    setSwitching(email)
    await globalSDK.client.provider.codex
      .active({ index })
      .then(() => {
        refetch()
        showToast({
          variant: "success",
          icon: "circle-check",
          title: "Switched to " + email,
        })
      })
      .catch(() => {
        showToast({ title: "Failed to switch account" })
      })
      .finally(() => setSwitching(null))
  }

  const removeAccount = async (id: string, email: string) => {
    setRemoving(id)
    await globalSDK.client.provider.codex
      .remove({ id })
      .then(async () => {
        await globalSDK.client.global.dispose()
        refetch()
        showToast({
          variant: "success",
          icon: "circle-check",
          title: "Removed " + email,
        })
      })
      .catch(() => {
        showToast({ title: "Failed to remove account" })
      })
      .finally(() => setRemoving(null))
  }

  return (
    <Show when={accounts() !== undefined}>
      <div class="flex flex-col gap-1" data-component="codex-accounts-section">
        <div class="flex items-center justify-between pb-2">
          <h3 class="text-14-medium text-text-strong">Codex Accounts</h3>
          <Button
            size="large"
            variant="secondary"
            icon="plus-small"
            onClick={() => {
              dialog.show(() => <DialogConnectProvider provider="openai" />)
            }}
          >
            {language.t("common.connect")}
          </Button>
        </div>
        <div class="bg-surface-raised-base px-4 rounded-lg">
          <For each={accounts()}>
            {(account, index) => {
              const info = () => usage()?.get(account.id)
              return (
                <div class="group flex flex-col gap-2 py-3 border-b border-border-weak-base last:border-none">
                  <div class="flex flex-wrap items-center justify-between gap-4 min-h-8">
                    <div class="flex items-center gap-3 min-w-0">
                      <ProviderIcon id="openai" class="size-5 shrink-0 icon-strong-base" />
                      <span class="text-14-medium text-text-strong truncate">{account.email}</span>
                      <Show when={account.active}>
                        <Tag>Active</Tag>
                      </Show>
                      <Show when={account.limited}>
                        <Tag>Rate Limited{account.resetAt ? ` · ${formatReset(account.resetAt)}` : ""}</Tag>
                      </Show>
                      <Show when={info()?.plan}>{(plan) => <Tag>{plan()}</Tag>}</Show>
                    </div>
                    <div class="flex items-center gap-2">
                      <Show when={!account.active}>
                        <Button
                          size="large"
                          variant="secondary"
                          disabled={switching() === account.email}
                          onClick={() => switchAccount(index(), account.email)}
                        >
                          <Show when={switching() === account.email} fallback="Switch">
                            <Spinner />
                          </Show>
                        </Button>
                      </Show>
                      <Button
                        size="large"
                        variant="ghost"
                        disabled={removing() === account.id}
                        onClick={() => removeAccount(account.id, account.email)}
                      >
                        <Show when={removing() === account.id} fallback={language.t("common.disconnect")}>
                          <Spinner />
                        </Show>
                      </Button>
                    </div>
                  </div>
                  <Show when={info()}>
                    {(u) => (
                      <div class="flex flex-col gap-1 pl-8">
                        <UsageBar label="5h" percent={u().primary} reset={u().primaryReset} />
                        <UsageBar label="7d" percent={u().secondary} reset={u().secondaryReset} />
                      </div>
                    )}
                  </Show>
                </div>
              )
            }}
          </For>
        </div>
      </div>
    </Show>
  )
}

export const SettingsProviders: Component = () => {
  const dialog = useDialog()
  const language = useLanguage()
  const globalSDK = useGlobalSDK()
  const globalSync = useGlobalSync()
  const providers = useProviders()

  const connected = createMemo(() => {
    return providers
      .connected()
      .filter((p) => p.id !== "opencode" || Object.values(p.models).find((m) => m.cost?.input))
  })

  const popular = createMemo(() => {
    const connectedIDs = new Set(connected().map((p) => p.id))
    const items = providers
      .popular()
      .filter((p) => !connectedIDs.has(p.id))
      .slice()
    items.sort((a, b) => popularProviders.indexOf(a.id) - popularProviders.indexOf(b.id))
    return items
  })

  const source = (item: ProviderItem): ProviderSource | undefined => {
    if (!("source" in item)) return
    const value = item.source
    if (value === "env" || value === "api" || value === "config" || value === "custom") return value
    return
  }

  const type = (item: ProviderItem) => {
    const current = source(item)
    if (current === "env") return language.t("settings.providers.tag.environment")
    if (current === "api") return language.t("provider.connect.method.apiKey")
    if (current === "config") {
      if (isConfigCustom(item.id)) return language.t("settings.providers.tag.custom")
      return language.t("settings.providers.tag.config")
    }
    if (current === "custom") return language.t("settings.providers.tag.custom")
    return language.t("settings.providers.tag.other")
  }

  const canDisconnect = (item: ProviderItem) => source(item) !== "env"

  const note = (id: string) => PROVIDER_NOTES.find((item) => item.match(id))?.key

  const isConfigCustom = (providerID: string) => {
    const provider = globalSync.data.config.provider?.[providerID]
    if (!provider) return false
    if (provider.npm !== "@ai-sdk/openai-compatible") return false
    if (!provider.models || Object.keys(provider.models).length === 0) return false
    return true
  }

  const disableProvider = async (providerID: string, name: string) => {
    const before = globalSync.data.config.disabled_providers ?? []
    const next = before.includes(providerID) ? before : [...before, providerID]
    globalSync.set("config", "disabled_providers", next)

    await globalSync
      .updateConfig({ disabled_providers: next })
      .then(() => {
        showToast({
          variant: "success",
          icon: "circle-check",
          title: language.t("provider.disconnect.toast.disconnected.title", { provider: name }),
          description: language.t("provider.disconnect.toast.disconnected.description", { provider: name }),
        })
      })
      .catch((err: unknown) => {
        globalSync.set("config", "disabled_providers", before)
        const message = err instanceof Error ? err.message : String(err)
        showToast({ title: language.t("common.requestFailed"), description: message })
      })
  }

  const disconnect = async (providerID: string, name: string) => {
    if (isConfigCustom(providerID)) {
      await globalSDK.client.auth.remove({ providerID }).catch(() => undefined)
      await disableProvider(providerID, name)
      return
    }
    await globalSDK.client.auth
      .remove({ providerID })
      .then(async () => {
        await globalSDK.client.global.dispose()
        showToast({
          variant: "success",
          icon: "circle-check",
          title: language.t("provider.disconnect.toast.disconnected.title", { provider: name }),
          description: language.t("provider.disconnect.toast.disconnected.description", { provider: name }),
        })
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err)
        showToast({ title: language.t("common.requestFailed"), description: message })
      })
  }

  return (
    <div class="flex flex-col h-full overflow-y-auto no-scrollbar px-4 pb-10 sm:px-10 sm:pb-10">
      <div class="sticky top-0 z-10 bg-[linear-gradient(to_bottom,var(--surface-stronger-non-alpha)_calc(100%_-_24px),transparent)]">
        <div class="flex flex-col gap-1 pt-6 pb-8 max-w-[720px]">
          <h2 class="text-16-medium text-text-strong">{language.t("settings.providers.title")}</h2>
        </div>
      </div>

      <div class="flex flex-col gap-8 max-w-[720px]">
        <div class="flex flex-col gap-1" data-component="connected-providers-section">
          <h3 class="text-14-medium text-text-strong pb-2">{language.t("settings.providers.section.connected")}</h3>
          <div class="bg-surface-raised-base px-4 rounded-lg">
            <Show
              when={connected().length > 0}
              fallback={
                <div class="py-4 text-14-regular text-text-weak">
                  {language.t("settings.providers.connected.empty")}
                </div>
              }
            >
              <For each={connected()}>
                {(item) => (
                  <div class="group flex flex-wrap items-center justify-between gap-4 min-h-16 py-3 border-b border-border-weak-base last:border-none">
                    <div class="flex items-center gap-3 min-w-0">
                      <ProviderIcon id={item.id} class="size-5 shrink-0 icon-strong-base" />
                      <span class="text-14-medium text-text-strong truncate">{item.name}</span>
                      <Tag>{type(item)}</Tag>
                    </div>
                    <Show
                      when={canDisconnect(item)}
                      fallback={
                        <span class="text-14-regular text-text-base opacity-0 group-hover:opacity-100 transition-opacity duration-200 pr-3 cursor-default">
                          {language.t("settings.providers.connected.environmentDescription")}
                        </span>
                      }
                    >
                      <Button size="large" variant="ghost" onClick={() => void disconnect(item.id, item.name)}>
                        {language.t("common.disconnect")}
                      </Button>
                    </Show>
                  </div>
                )}
              </For>
            </Show>
          </div>
        </div>

        <CodexAccounts />

        <div class="flex flex-col gap-1">
          <h3 class="text-14-medium text-text-strong pb-2">{language.t("settings.providers.section.popular")}</h3>
          <div class="bg-surface-raised-base px-4 rounded-lg">
            <For each={popular()}>
              {(item) => (
                <div class="flex flex-wrap items-center justify-between gap-4 min-h-16 py-3 border-b border-border-weak-base last:border-none">
                  <div class="flex flex-col min-w-0">
                    <div class="flex items-center gap-x-3">
                      <ProviderIcon id={item.id} class="size-5 shrink-0 icon-strong-base" />
                      <span class="text-14-medium text-text-strong">{item.name}</span>
                      <Show when={item.id === "opencode"}>
                        <Tag>{language.t("dialog.provider.tag.recommended")}</Tag>
                      </Show>
                      <Show when={item.id === "opencode-go"}>
                        <Tag>{language.t("dialog.provider.tag.recommended")}</Tag>
                      </Show>
                    </div>
                    <Show when={note(item.id)} keyed>
                      {(key) => <span class="text-12-regular text-text-weak pl-8">{language.t(key)}</span>}
                    </Show>
                  </div>
                  <Button
                    size="large"
                    variant="secondary"
                    icon="plus-small"
                    onClick={() => {
                      dialog.show(() => <DialogConnectProvider provider={item.id} />)
                    }}
                  >
                    {language.t("common.connect")}
                  </Button>
                </div>
              )}
            </For>

            <div
              class="flex items-center justify-between gap-4 min-h-16 border-b border-border-weak-base last:border-none flex-wrap py-3"
              data-component="custom-provider-section"
            >
              <div class="flex flex-col min-w-0">
                <div class="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <ProviderIcon id="synthetic" class="size-5 shrink-0 icon-strong-base" />
                  <span class="text-14-medium text-text-strong">{language.t("provider.custom.title")}</span>
                  <Tag>{language.t("settings.providers.tag.custom")}</Tag>
                </div>
                <span class="text-12-regular text-text-weak pl-8">
                  {language.t("settings.providers.custom.description")}
                </span>
              </div>
              <Button
                size="large"
                variant="secondary"
                icon="plus-small"
                onClick={() => {
                  dialog.show(() => <DialogCustomProvider back="close" />)
                }}
              >
                {language.t("common.connect")}
              </Button>
            </div>
          </div>

          <Button
            variant="ghost"
            class="px-0 py-0 mt-5 text-14-medium text-text-interactive-base text-left justify-start hover:bg-transparent active:bg-transparent"
            onClick={() => {
              dialog.show(() => <DialogSelectProvider />)
            }}
          >
            {language.t("dialog.provider.viewAll")}
          </Button>
        </div>
      </div>
    </div>
  )
}
