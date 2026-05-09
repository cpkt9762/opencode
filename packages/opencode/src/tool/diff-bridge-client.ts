const BRIDGE_TIMEOUT = 5000

export function getBridgeUrl(): string | undefined {
  return process.env.OPENCODE_DIFF_BRIDGE_URL
}

export async function bridgePost(path: string, body: unknown): Promise<unknown> {
  const url = getBridgeUrl()
  if (!url) throw new Error("OPENCODE_DIFF_BRIDGE_URL not set")
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), BRIDGE_TIMEOUT)
  try {
    const response = await fetch(`${url}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
    if (!response.ok) throw new Error(`Bridge ${path} returned ${response.status}`)
    return response.json()
  } finally {
    clearTimeout(timeout)
  }
}

export async function bridgeGet(path: string): Promise<unknown> {
  const url = getBridgeUrl()
  if (!url) throw new Error("OPENCODE_DIFF_BRIDGE_URL not set")
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), BRIDGE_TIMEOUT)
  try {
    const response = await fetch(`${url}${path}`, { signal: controller.signal })
    if (!response.ok) throw new Error(`Bridge ${path} returned ${response.status}`)
    return response.json()
  } finally {
    clearTimeout(timeout)
  }
}
