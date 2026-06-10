import { createEventListener } from "@solid-primitives/event-listener"
import { createResizeObserver } from "@solid-primitives/resize-observer"
import { createEffect, on, onCleanup } from "solid-js"
import { createStore } from "solid-js/store"

export interface AutoScrollOptions {
  working: () => boolean
  onUserInteracted?: () => void
  overflowAnchor?: "none" | "auto" | "dynamic"
  bottomThreshold?: number
}

export function createAutoScroll(options: AutoScrollOptions) {
  let settling = false
  let settleTimer: ReturnType<typeof setTimeout> | undefined
  let autoTimer: ReturnType<typeof setTimeout> | undefined
  let auto: { top: number; time: number } | undefined
  let height: number | undefined
  let anchorFrame: number | undefined
  let wheelNear = 0

  const threshold = () => options.bottomThreshold ?? 10

  const [store, setStore] = createStore({
    contentRef: undefined as HTMLElement | undefined,
    scrollRef: undefined as HTMLElement | undefined,
    userScrolled: false,
  })

  const active = () => options.working() || settling

  const distanceFromBottom = (el: HTMLElement) => {
    return Math.max(0, el.scrollHeight - el.clientHeight - Math.max(0, el.scrollTop))
  }

  const canScroll = (el: HTMLElement) => {
    return el.scrollHeight - el.clientHeight > 1
  }

  // Browsers can dispatch scroll events asynchronously. If new content arrives
  // between us calling `scrollTo()` and the subsequent `scroll` event firing,
  // the handler can see a non-zero `distanceFromBottom` and incorrectly assume
  // the user scrolled.
  const markAuto = (el: HTMLElement) => {
    auto = {
      top: Math.max(0, el.scrollHeight - el.clientHeight),
      time: Date.now(),
    }

    if (autoTimer) clearTimeout(autoTimer)
    autoTimer = setTimeout(() => {
      auto = undefined
      autoTimer = undefined
    }, 1500)
  }

  const isAuto = (el: HTMLElement) => {
    const a = auto
    if (!a) return false

    if (Date.now() - a.time > 1500) {
      auto = undefined
      return false
    }

    return Math.abs(el.scrollTop - a.top) < 2
  }

  const scrollToBottomNow = (behavior: ScrollBehavior, trigger: string) => {
    const el = store.scrollRef
    if (!el) return
    markAuto(el)
    if (behavior === "smooth") {
      el.scrollTo({ top: el.scrollHeight, behavior })
      return
    }

    // `scrollTop` assignment bypasses any CSS `scroll-behavior: smooth`.
    el.scrollTop = el.scrollHeight
  }

  const scrollToBottom = (force: boolean) => {
    if (!force && !active()) return

    if (force && store.userScrolled) setStore("userScrolled", false)

    const el = store.scrollRef
    if (!el) return

    if (!force && store.userScrolled) return

    const distance = distanceFromBottom(el)
    if (distance < 2) {
      markAuto(el)
      return
    }

    // For auto-following content we prefer immediate updates to avoid
    // visible "catch up" animations while content is still settling.
    scrollToBottomNow("auto", force ? "scrollToBottom:force" : "scrollToBottom")
  }

  const stop = () => {
    const el = store.scrollRef
    if (!el) return
    if (!canScroll(el)) {
      if (store.userScrolled) setStore("userScrolled", false)
      return
    }
    if (store.userScrolled) return

    setStore("userScrolled", true)
    options.onUserInteracted?.()
  }

  const handleWheel = (e: WheelEvent) => {
    if (e.deltaY >= 0) return
    // If the user is scrolling within a nested scrollable region (tool output,
    // code block, etc), don't treat it as leaving the "follow bottom" mode.
    // Those regions opt in via `data-scrollable`.
    const el = store.scrollRef
    const target = e.target instanceof Element ? e.target : undefined
    const nested = target?.closest("[data-scrollable]")
    if (el && nested && nested !== el) return
    // Don't break auto-follow for small scrolls near the bottom;
    // let handleScroll decide after the position settles.
    if (el && distanceFromBottom(el) <= threshold()) {
      wheelNear = Date.now()
      return
    }
    stop()
  }

  const handleScroll = () => {
    const el = store.scrollRef
    if (!el) return
    const dist = distanceFromBottom(el)

    if (!canScroll(el)) {
      if (store.userScrolled) setStore("userScrolled", false)
      return
    }

    if (dist < threshold()) {
      if (store.userScrolled) setStore("userScrolled", false)
      return
    }

    // Ignore scroll events triggered by our own scrollToBottom calls.
    if (!store.userScrolled && isAuto(el)) {
      scrollToBottom(false)
      return
    }

    // handleWheel recently blocked a stop near the bottom — inertia
    // may have carried scrollTop just past the threshold. Re-anchor
    // instead of breaking auto-follow.
    if (!store.userScrolled && Date.now() - wheelNear < 150) {
      scrollToBottom(false)
      return
    }

    stop()
  }

  const handleInteraction = () => {
    if (!active()) return
    const selection = window.getSelection()
    if (selection && selection.toString().length > 0) {
      stop()
    }
  }

  const updateOverflowAnchor = (el: HTMLElement) => {
    const mode = options.overflowAnchor ?? "dynamic"
    const value = mode === "none" ? "none" : mode === "auto" ? "auto" : store.userScrolled ? "auto" : "none"
    el.style.overflowAnchor = value
  }

  createResizeObserver(
    () => store.contentRef,
    () => {
      const el = store.scrollRef
      if (!el) {
        height = undefined
        return
      }
      const prev = height
      height = el.scrollHeight
      if (!canScroll(el)) {
        // Don't clear userScrolled on transient content shrinks (DOM rebuilds
        // during turn backfill can briefly make scrollHeight < clientHeight)
        if (store.userScrolled && !(prev !== undefined && height < prev)) setStore("userScrolled", false)
        return
      }
      if (!active()) return
      if (store.userScrolled) return
      // ResizeObserver fires after layout, before paint.
      // Keep the bottom locked in the same frame to avoid visible
      // "jump up then catch up" artifacts while streaming content.
      scrollToBottom(false)
    },
  )

  createEffect(
    on(options.working, (working: boolean) => {
      settling = false
      if (settleTimer) clearTimeout(settleTimer)
      settleTimer = undefined

      if (working) {
        if (!store.userScrolled) scrollToBottom(true)
        return
      }

      settling = true
      settleTimer = setTimeout(() => {
        settling = false
      }, 300)
    }),
  )

  createEffect(() => {
    store.userScrolled
    const el = store.scrollRef
    if (!el) return
    if (anchorFrame !== undefined) cancelAnimationFrame(anchorFrame)
    anchorFrame = requestAnimationFrame(() => {
      anchorFrame = undefined
      updateOverflowAnchor(el)
    })
  })

  createEventListener(() => store.scrollRef, "wheel", handleWheel, {
    passive: true,
  })

  onCleanup(() => {
    if (settleTimer) clearTimeout(settleTimer)
    if (autoTimer) clearTimeout(autoTimer)
    if (anchorFrame !== undefined) cancelAnimationFrame(anchorFrame)
  })

  return {
    scrollRef: (el: HTMLElement | undefined) => setStore("scrollRef", el),
    contentRef: (el: HTMLElement | undefined) => setStore("contentRef", el),
    handleScroll,
    handleInteraction,
    pause: stop,
    resume: () => {
      if (store.userScrolled) setStore("userScrolled", false)
      scrollToBottom(true)
    },
    scrollToBottom: () => scrollToBottom(false),
    forceScrollToBottom: () => scrollToBottom(true),
    userScrolled: () => store.userScrolled,
  }
}
