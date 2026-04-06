declare global {
  interface Window {
    __OPENCODE_SCROLL_LOG__?: (event: string, data: Record<string, unknown>) => void
  }
}

const MAX = 5000
const buf: string[] = []

export function scrollLog(
  event: string,
  data: {
    scrollTop?: number
    scrollHeight?: number
    clientHeight?: number
    distBottom?: number
    userScrolled?: boolean
    isAuto?: boolean
    trigger?: string
    extra?: string
  },
) {
  const ts = Date.now()
  const line = [
    ts,
    event,
    data.scrollTop ?? "",
    data.scrollHeight ?? "",
    data.clientHeight ?? "",
    data.distBottom ?? "",
    data.userScrolled ?? "",
    data.isAuto ?? "",
    data.trigger ?? "",
    data.extra ?? "",
  ].join("\t")
  buf.push(line)
  if (buf.length > MAX) buf.shift()

  if (typeof window !== "undefined" && window.__OPENCODE_SCROLL_LOG__) {
    window.__OPENCODE_SCROLL_LOG__(event, data as Record<string, unknown>)
  }
}

function download() {
  const header =
    "timestamp_ms\tevent\tscrollTop\tscrollHeight\tclientHeight\tdistBottom\tuserScrolled\tisAuto\ttrigger\textra\n"
  const blob = new Blob([header + buf.join("\n") + "\n"], { type: "text/plain" })
  const url = URL.createObjectURL(blob)
  const a = document.createElement("a")
  a.href = url
  a.download = `scroll-debug-${Date.now()}.dat`
  a.click()
  URL.revokeObjectURL(url)
}

if (typeof window !== "undefined") {
  ;(window as any).__exportScrollLog = download
  ;(window as any).__clearScrollLog = () => {
    buf.length = 0
  }
  ;(window as any).__scrollLogBuf = buf
}
