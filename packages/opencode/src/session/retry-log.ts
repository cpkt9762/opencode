import fs from "fs"
import path from "path"
import { Global } from "@/global"

const FILE = path.join(Global.Path.log, "session-retry.log")
const MAX_BYTES = 5 * 1024 * 1024

let prepared = false

function prepare() {
  if (prepared) return
  try {
    fs.mkdirSync(Global.Path.log, { recursive: true })
  } catch {}
  prepared = true
}

function rotate() {
  try {
    const stat = fs.statSync(FILE)
    if (stat.size > MAX_BYTES) fs.renameSync(FILE, FILE + ".1")
  } catch {}
}

function render(extra: Record<string, any>) {
  return Object.entries(extra)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => {
      if (v instanceof Error) return `${k}=${v.message}`
      if (typeof v === "object") return `${k}=${JSON.stringify(v)}`
      return `${k}=${v}`
    })
    .join(" ")
}

export function retryLog(level: "INFO" | "WARN" | "ERROR", message: string, extra: Record<string, any> = {}) {
  prepare()
  rotate()
  const line = `${new Date().toISOString()} ${level.padEnd(5)} ${message} ${render(extra)}\n`
  fs.appendFile(FILE, line, () => {})
}

export const RETRY_LOG_FILE = FILE
