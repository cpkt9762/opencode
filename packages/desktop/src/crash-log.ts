import { SourceMapConsumer } from "source-map-js"
import { Store } from "@tauri-apps/plugin-store"

declare global {
  interface Window {
    __OPENCODE_CRASH_LOG__?: typeof log
    __OPENCODE_DEBUG__?: (tag: string, data: Record<string, unknown>) => void
    __OPENCODE_SCROLL_LOG__?: (event: string, data: Record<string, unknown>) => void
  }
}

const MAX = 200
const CRUMB_MAX = 30
const DEBUG_MAX = 500

type Crumb = { kind: string; data: string; ts: number }
type Entry = {
  label: string
  message: string
  raw: string
  resolved: string
  route: string
  crumbs: Crumb[]
  time: string
}

const crumbs: Crumb[] = []
const maps = new Map<string, SourceMapConsumer | null>()
let store: Awaited<ReturnType<typeof Store.load>> | undefined

function crumb(kind: string, data: string) {
  crumbs.push({ kind, data, ts: Date.now() })
  if (crumbs.length > CRUMB_MAX) crumbs.shift()
}

// Chrome: "    at name (url:line:col)" or "    at url:line:col"
// Safari/WebKit: "name@url:line:col"
function frames(stack: string) {
  const out: { fn: string; url: string; line: number; col: number }[] = []
  for (const row of stack.split("\n")) {
    const chrome = row.match(/at\s+(.+?)\s+\((.+?):(\d+):(\d+)\)/) ?? row.match(/at\s+()(.*?):(\d+):(\d+)/)
    if (chrome) {
      out.push({ fn: chrome[1] || "?", url: chrome[2], line: +chrome[3], col: +chrome[4] })
      continue
    }
    const webkit = row.match(/(.*)@(.+?):(\d+):(\d+)/)
    if (webkit) {
      out.push({ fn: webkit[1] || "?", url: webkit[2], line: +webkit[3], col: +webkit[4] })
    }
  }
  return out
}

async function sourcemap(url: string) {
  if (maps.has(url)) return maps.get(url)
  const text = await fetch(url)
    .then((r) => (r.ok ? r.text() : null))
    .catch(() => null)
  let raw: string | null = null
  if (text) {
    const m = text.match(/\/\/# sourceMappingURL=data:[^;]+;base64,(.+)$/m)
    if (m) raw = atob(m[1])
  }
  if (!raw)
    raw = await fetch(url + ".map")
      .then((r) => (r.ok ? r.text() : null))
      .catch(() => null)
  const consumer = raw ? new SourceMapConsumer(JSON.parse(raw)) : null
  maps.set(url, consumer)
  return consumer
}

async function resolve(stack: string) {
  const parsed = frames(stack)
  if (!parsed.length) return stack
  const lines: string[] = []
  for (const f of parsed) {
    const map = await sourcemap(f.url).catch(() => null)
    if (!map) {
      lines.push(`  at ${f.fn} (${f.url}:${f.line}:${f.col})`)
      continue
    }
    const pos = map.originalPositionFor({ line: f.line, column: f.col })
    if (pos.source) {
      lines.push(`  at ${pos.name || f.fn} (${pos.source}:${pos.line}:${pos.column})`)
    } else {
      lines.push(`  at ${f.fn} (${f.url}:${f.line}:${f.col})`)
    }
  }
  return lines.join("\n")
}

async function persist(entry: Entry) {
  store ??= await Store.load("crash-log.dat").catch(() => undefined)
  if (!store) return
  await store.set(entry.time, JSON.stringify(entry)).catch(() => undefined)
  const keys = await store.keys().catch(() => [] as string[])
  if (keys.length > MAX) {
    for (const k of keys.sort().slice(0, keys.length - MAX)) await store.delete(k).catch(() => undefined)
  }
}

const NOISE = ["ResizeObserver loop"]

export async function log(label: string, err: unknown) {
  const msg = err instanceof Error ? err.message : String(err)
  if (NOISE.some((n) => msg.includes(n))) return
  const raw = err instanceof Error ? (err.stack ?? "") : ""
  console.error(`[crash:${label}]`, err)
  const entry: Entry = {
    label,
    message: msg,
    raw,
    resolved: await resolve(raw).catch(() => raw),
    route: location.pathname + location.hash,
    crumbs: crumbs.slice(),
    time: new Date().toISOString(),
  }
  await persist(entry)
}

let debugStore: Awaited<ReturnType<typeof Store.load>> | undefined

async function debugLog(tag: string, data: Record<string, unknown>) {
  debugStore ??= await Store.load("model-debug.dat").catch(() => undefined)
  if (!debugStore) return
  const ts = new Date().toISOString()
  await debugStore.set(ts, JSON.stringify({ tag, ...data, ts })).catch(() => undefined)
  const keys = await debugStore.keys().catch(() => [] as string[])
  if (keys.length > DEBUG_MAX) {
    for (const k of keys.sort().slice(0, keys.length - DEBUG_MAX)) await debugStore.delete(k).catch(() => undefined)
  }
}

let scrollStore: Awaited<ReturnType<typeof Store.load>> | undefined
const SCROLL_MAX = 5000

async function scrollLog(event: string, data: Record<string, unknown>) {
  scrollStore ??= await Store.load("scroll-debug.dat").catch(() => undefined)
  if (!scrollStore) return
  const ts = Date.now()
  const key = `${ts}-${Math.random().toString(36).slice(2, 6)}`
  await scrollStore.set(key, JSON.stringify({ event, ...data, ts })).catch(() => undefined)
  const keys = await scrollStore.keys().catch(() => [] as string[])
  if (keys.length > SCROLL_MAX) {
    for (const k of keys.sort().slice(0, keys.length - SCROLL_MAX)) await scrollStore.delete(k).catch(() => undefined)
  }
}

export function init() {
  window.__OPENCODE_CRASH_LOG__ = log
  window.__OPENCODE_DEBUG__ = debugLog
  window.__OPENCODE_SCROLL_LOG__ = scrollLog
  window.addEventListener("error", (e) => void log("error", e.error ?? e.message))
  window.addEventListener("unhandledrejection", (e) => void log("rejection", e.reason))

  document.addEventListener(
    "click",
    (e) => {
      const el = e.target as HTMLElement
      const tag = el.tagName?.toLowerCase() ?? "?"
      const cls = el.className?.toString().split(" ")[0] ?? ""
      const txt = (el.textContent ?? "").trim().slice(0, 40)
      crumb("click", `${tag}${cls ? "." + cls : ""} "${txt}"`)
    },
    true,
  )

  const push = history.pushState.bind(history)
  history.pushState = (...args: Parameters<typeof history.pushState>) => {
    crumb("nav", String(args[2] ?? ""))
    return push(...args)
  }

  window.addEventListener("popstate", () => crumb("nav", location.pathname + location.hash))
}
