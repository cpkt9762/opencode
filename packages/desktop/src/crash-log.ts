import { SourceMapConsumer } from "source-map-js"
import { Store } from "@tauri-apps/plugin-store"

const MAX = 200
const CRUMB_MAX = 30

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
  const json = await fetch(url + ".map")
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null)
  const consumer = json ? new SourceMapConsumer(json) : null
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

export async function log(label: string, err: unknown) {
  const msg = err instanceof Error ? err.message : String(err)
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

export function init() {
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
