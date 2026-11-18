import { Plugin, usePlugin } from "@opencode/plugin/tui"
import { For, Show, createEffect, createMemo, createRoot, createSignal, on, onCleanup } from "solid-js"
import { fetchUsage, type UsageResult, type UsageWindow } from "./usage.ts"

interface Options {
  /** Provider IDs that bill against the Claude plan. */
  readonly providers: readonly string[]
  /** Polling interval while a matching model is selected. Minimum 60. */
  readonly intervalSeconds: number
  /** Utilization (%) at which a window turns the warning colour. */
  readonly warnAt: number
  /** Utilization (%) at which a window turns the error colour. */
  readonly criticalAt: number
}

const DEFAULTS: Options = { providers: ["claude-agent"], intervalSeconds: 120, warnAt: 75, criticalAt: 90 }
const AFTER_TURN_DELAY_MS = 3_000
const MIN_GAP_MS = 15_000
const BAR_WIDTH = 10

export default Plugin.define({
  id: "claude-usage",
  setup(context) {
    const options = readOptions(context.options)

    return createRoot((dispose) => {
      const [result, setResult] = createSignal<UsageResult | undefined>()
      const [loading, setLoading] = createSignal(false)
      const [now, setNow] = createSignal(Date.now())
      const [lastError, setLastError] = createSignal<string | undefined>()

      const active = createMemo(() => {
        const providerID = context.ui.model.current()?.providerID
        return providerID !== undefined && options.providers.includes(providerID)
      })

      let lastAttempt = 0
      let blockedUntil = 0
      let inFlight: Promise<void> | undefined

      const refresh = (force = false): Promise<void> => {
        if (inFlight) return inFlight
        const t = Date.now()
        if (t < blockedUntil) return Promise.resolve()
        if (!force && t - lastAttempt < MIN_GAP_MS) return Promise.resolve()
        lastAttempt = t
        setLoading(true)
        inFlight = fetchUsage()
          .then((next) => {
            if (next.status === "rate_limited") blockedUntil = Date.now() + next.retryAfterMs
            // Keep the last good numbers visible through transient failures; surface the error alongside.
            setResult((prev) => (next.status === "ok" || prev?.status !== "ok" ? next : prev))
            if (next.status !== "ok") setLastError(next.message)
            else setLastError(undefined)
          })
          .finally(() => {
            setLoading(false)
            setNow(Date.now())
            inFlight = undefined
          })
        return inFlight
      }

      // Poll only while a Claude Agent model is selected.
      createEffect(
        on(active, (isActive) => {
          if (!isActive) return
          void refresh(true)
          const poll = setInterval(() => void refresh(), options.intervalSeconds * 1000)
          const tick = setInterval(() => setNow(Date.now()), 30_000)
          onCleanup(() => {
            clearInterval(poll)
            clearInterval(tick)
          })
        }),
      )

      // Refresh shortly after each completed turn.
      let afterTurn: ReturnType<typeof setTimeout> | undefined
      const stopEvents = context.data.on("session.execution.succeeded", () => {
        if (!active()) return
        clearTimeout(afterTurn)
        afterTurn = setTimeout(() => void refresh(), AFTER_TURN_DELAY_MS)
      })

      const state = { result, loading, lastError, now, options }

      const stopSidebar = context.ui.slot({
        append: "sidebar.content",
        render: () => (
          <Show when={active()}>
            <Sidebar {...state} />
          </Show>
        ),
      })

      const stopFooter = context.ui.slot({
        append: "prompt.footer.status",
        render: () => (
          <Show when={active()}>
            <Footer {...state} />
          </Show>
        ),
      })

      context.keymap.layer(() => ({
        mode: "global",
        commands: [
          {
            id: "claude-usage.show",
            title: "Claude plan usage",
            group: "Claude usage",
            palette: true,
            slash: { name: "claude-usage" },
            run: async () => {
              if (!active()) {
                await context.ui.dialog.alert({
                  title: "Claude plan usage",
                  message: `Not active: the selected model isn't from ${options.providers.join(", ")}.`,
                })
                return
              }
              await refresh(true)
              await context.ui.dialog.alert({ title: "Claude plan usage", message: describe(result(), lastError()) })
            },
          },
        ],
      }))

      return () => {
        clearTimeout(afterTurn)
        stopEvents()
        stopSidebar()
        stopFooter()
        dispose()
      }
    })
  },
})

interface ViewProps {
  readonly result: () => UsageResult | undefined
  readonly loading: () => boolean
  readonly lastError: () => string | undefined
  readonly now: () => number
  readonly options: Options
}

function Sidebar(props: ViewProps) {
  const { theme } = usePlugin()
  const ok = () => {
    const r = props.result()
    return r?.status === "ok" ? r : undefined
  }
  return (
    <box flexDirection="column" paddingTop={1}>
      <text fg={theme.text.base}>
        <b>Claude plan</b>
      </text>
      <Show
        when={ok()}
        fallback={
          <text fg={theme.text.muted}>{props.loading() ? "loading…" : (props.lastError() ?? "no data yet")}</text>
        }
      >
        {(r) => (
          <>
            <For each={r().windows}>
              {(w) => (
                <box flexDirection="row" gap={1}>
                  <text fg={theme.text.muted}>{w.label.padEnd(9)}</text>
                  <text fg={levelColor(theme, w.utilization, props.options)}>
                    {bar(w.utilization)} {formatPct(w.utilization)}
                  </text>
                  <text fg={theme.text.faint}>{formatReset(w.resetsAt, props.now())}</text>
                </box>
              )}
            </For>
            <Show when={r().extra?.enabled}>
              <text fg={theme.text.muted}>
                extra usage on · {formatMoney(r().extra!.usedCredits, r().extra!.currency)} used
                {r().extra!.monthlyLimit !== null
                  ? ` / ${formatMoney(r().extra!.monthlyLimit!, r().extra!.currency)}`
                  : ""}
              </text>
            </Show>
            <Show when={props.lastError()}>
              <text fg={theme.text.feedback.warning.base}>{props.lastError()}</text>
            </Show>
          </>
        )}
      </Show>
    </box>
  )
}

function Footer(props: ViewProps) {
  const { theme } = usePlugin()
  return (
    <Show
      when={props.result()?.status === "ok"}
      fallback={<text fg={theme.text.muted}>claude {props.result()?.status === "stale" ? "stale" : "…"}</text>}
    >
      <box flexDirection="row" gap={1}>
        <For each={(props.result() as Extract<UsageResult, { status: "ok" }>).windows.filter(isPrimary)}>
          {(w) => (
            <text fg={levelColor(theme, w.utilization, props.options)}>
              {w.label} {formatPct(w.utilization)}
            </text>
          )}
        </For>
      </box>
    </Show>
  )
}

function describe(result: UsageResult | undefined, lastError: string | undefined): string {
  if (!result) return lastError ?? "No data yet."
  if (result.status !== "ok") return result.message
  const now = Date.now()
  const lines = result.windows.map(
    (w) => `${w.label.padEnd(9)} ${bar(w.utilization)} ${formatPct(w.utilization).padStart(4)}  ${formatReset(w.resetsAt, now)}`,
  )
  if (result.extra) {
    const e = result.extra
    lines.push(
      "",
      `Extra usage: ${e.enabled ? "enabled" : "disabled"}`,
      `  used ${formatMoney(e.usedCredits, e.currency)}${e.monthlyLimit !== null ? ` of ${formatMoney(e.monthlyLimit, e.currency)}` : " (no monthly limit)"}`,
    )
    if (e.spendLimitReached) lines.push("  spend limit reached")
  }
  if (lastError) lines.push("", `Last refresh failed: ${lastError}`)
  lines.push("", `Updated ${result.fetchedAt.toLocaleTimeString()}`)
  return lines.join("\n")
}

function isPrimary(w: UsageWindow): boolean {
  return w.key === "five_hour" || w.key === "seven_day"
}

function levelColor(theme: ReturnType<typeof usePlugin>["theme"], pct: number, options: Options) {
  if (pct >= options.criticalAt) return theme.text.feedback.error.base
  if (pct >= options.warnAt) return theme.text.feedback.warning.base
  return theme.text.base
}

function bar(pct: number): string {
  const filled = Math.round((Math.min(Math.max(pct, 0), 100) / 100) * BAR_WIDTH)
  return "█".repeat(filled) + "░".repeat(BAR_WIDTH - filled)
}

function formatPct(pct: number): string {
  return `${Math.round(pct)}%`
}

function formatReset(at: Date, now: number): string {
  const ms = at.getTime() - now
  if (ms <= 0) return "resetting"
  const minutes = Math.round(ms / 60_000)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h${String(minutes % 60).padStart(2, "0")}m`
  return `${Math.floor(hours / 24)}d${hours % 24}h`
}

function formatMoney(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency }).format(amount)
  } catch {
    return `${amount.toFixed(2)} ${currency}`
  }
}

function readOptions(raw: Readonly<Record<string, unknown>>): Options {
  const providers =
    Array.isArray(raw.providers) && raw.providers.every((p) => typeof p === "string") && raw.providers.length > 0
      ? (raw.providers as string[])
      : DEFAULTS.providers
  const num = (value: unknown, fallback: number) =>
    typeof value === "number" && Number.isFinite(value) ? value : fallback
  return {
    providers,
    intervalSeconds: Math.max(60, num(raw.intervalSeconds, DEFAULTS.intervalSeconds)),
    warnAt: num(raw.warnAt, DEFAULTS.warnAt),
    criticalAt: num(raw.criticalAt, DEFAULTS.criticalAt),
  }
}
