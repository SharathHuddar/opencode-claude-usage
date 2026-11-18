import { Plugin, usePlugin } from "@opencode/plugin/tui"
import { For, Show, createEffect, createMemo, createRoot, createSignal, on, onCleanup } from "solid-js"
import { fetchUsage, type ExtraUsage, type UsageWindow } from "./usage.ts"

interface Options {
  /** Provider IDs that bill against the Claude plan. */
  readonly providers: readonly string[]
  /** How often to refresh while a matching model is selected. Minimum 60. */
  readonly intervalSeconds: number
  /** Utilization (%) at which a window turns the warning colour. */
  readonly warnAt: number
  /** Utilization (%) at which a window turns the error colour. */
  readonly criticalAt: number
}

const DEFAULTS: Options = { providers: ["claude-agent"], intervalSeconds: 300, warnAt: 75, criticalAt: 90 }
/** How often each instance checks whether a refresh is due (and updates relative times). */
const TICK_MS = 30_000
/** Slack so instances whose ticks drift slightly still refresh once per interval. */
const TICK_SLACK_MS = 5_000
const AFTER_TURN_DELAY_MS = 3_000
/** Minimum gap between requests triggered by turns or /claude-usage, shared across all instances. */
const ON_DEMAND_GAP_MS = 60_000
/** Base wait after a 429 without Retry-After, and the floor when it has one. */
const RATE_LIMIT_BASE_MS = 60_000
const RATE_LIMIT_MAX_MS = 15 * 60_000

interface Snapshot {
  readonly windows: UsageWindow[]
  readonly extra: ExtraUsage | null
  readonly fetchedAt: number
}

interface Failure {
  readonly status: "stale" | "error" | "rate_limited"
  readonly message: string
  readonly at: number
}

/**
 * Persisted plugin storage, shared by every TUI instance and plugin reload. Holds only the normalized usage
 * snapshot and request bookkeeping: never the token or raw credentials.
 */
interface Shared {
  snapshot: Snapshot | null
  failure: Failure | null
  /** Last request attempt by any instance (epoch ms). */
  lastAttemptAt: number
  /** No instance sends a request before this time (epoch ms). */
  blockedUntil: number
  /** Consecutive 429s, for exponential backoff. */
  rateLimitStreak: number
}

export default Plugin.define({
  id: "claude-usage",
  setup(context) {
    const options = readOptions(context.options)
    const intervalMs = options.intervalSeconds * 1000

    const [shared, update] = context.storage.store<Shared>("usage", {
      initial: { snapshot: null, failure: null, lastAttemptAt: 0, blockedUntil: 0, rateLimitStreak: 0 },
    })

    // Plugin-owned reactive state (signals, memo, polling effect). No host UI APIs are called in here.
    const state = createRoot((dispose) => {
      const [now, setNow] = createSignal(Date.now())
      const [loading, setLoading] = createSignal(false)
      // Number of mounted sidebar slots. The host mounts sidebar.content only while the sidebar is visible.
      const [sidebarMounts, setSidebarMounts] = createSignal(0)

      const active = createMemo(() => {
        const providerID = context.ui.model.current()?.providerID
        return providerID !== undefined && options.providers.includes(providerID)
      })

      let inFlight: Promise<void> | undefined

      /** Sends a request only if no instance has tried within minGapMs and no rate-limit backoff is in effect. */
      const refresh = (minGapMs: number): Promise<void> => {
        if (inFlight) return inFlight
        const start = Date.now()
        if (start < shared.blockedUntil) return Promise.resolve()
        if (start - shared.lastAttemptAt < minGapMs) return Promise.resolve()
        setLoading(true)
        inFlight = (async () => {
          // Claim the attempt first so other instances skip this cycle.
          await update((draft) => {
            draft.lastAttemptAt = start
          })
          const result = await fetchUsage()
          const done = Date.now()
          await update((draft) => {
            if (result.status === "ok") {
              draft.snapshot = {
                windows: result.windows.map((w) => ({ ...w })),
                extra: result.extra ? { ...result.extra } : null,
                fetchedAt: result.fetchedAt,
              }
              draft.failure = null
              draft.blockedUntil = 0
              draft.rateLimitStreak = 0
              return
            }
            draft.failure = { status: result.status, message: result.message, at: done }
            if (result.status === "rate_limited") {
              draft.rateLimitStreak += 1
              const base = Math.max(result.retryAfterMs ?? RATE_LIMIT_BASE_MS, RATE_LIMIT_BASE_MS)
              draft.blockedUntil = done + Math.min(base * 2 ** (draft.rateLimitStreak - 1), RATE_LIMIT_MAX_MS)
            }
          })
        })().finally(() => {
          setLoading(false)
          setNow(Date.now())
          inFlight = undefined
        })
        return inFlight
      }

      // While a Claude Agent model is selected: refresh if the shared snapshot is older than the interval,
      // then check every tick. A plugin reload or a second TUI reuses the shared snapshot instead of fetching.
      createEffect(
        on(active, (isActive) => {
          if (!isActive) return
          void refresh(intervalMs)
          const tick = setInterval(() => {
            setNow(Date.now())
            void refresh(intervalMs - TICK_SLACK_MS)
          }, TICK_MS)
          onCleanup(() => clearInterval(tick))
        }),
      )

      // Refresh shortly after a completed turn, at most once per ON_DEMAND_GAP_MS across all instances.
      let afterTurn: ReturnType<typeof setTimeout> | undefined
      const stopEvents = context.data.on("session.execution.succeeded", () => {
        if (!active()) return
        clearTimeout(afterTurn)
        afterTurn = setTimeout(() => void refresh(ON_DEMAND_GAP_MS), AFTER_TURN_DELAY_MS)
      })

      const view: ViewProps = {
        snapshot: () => shared.snapshot,
        failure: () => {
          const failure = shared.failure
          const snapshot = shared.snapshot
          // A failure older than the current snapshot has already been resolved.
          return failure && (!snapshot || failure.at > snapshot.fetchedAt) ? failure : null
        },
        blockedUntil: () => shared.blockedUntil,
        loading,
        now,
        options,
      }

      return {
        active,
        refresh,
        view,
        sidebarVisible: () => sidebarMounts() > 0,
        sidebarMounted: () => setSidebarMounts((n) => n + 1),
        sidebarUnmounted: () => setSidebarMounts((n) => Math.max(0, n - 1)),
        cleanup: () => {
          clearTimeout(afterTurn)
          stopEvents()
          dispose()
        },
      }
    })

    // UI registration happens outside the plugin's own Solid root. keymap.layer builds its layer under the
    // current owner when there is one, and only the host's owner provides the keymap context; calling it
    // inside createRoot fails with "Keymap.Provider is missing".
    const stopSidebar = context.ui.slot({
      append: "sidebar.content",
      render: () => {
        const Presence = () => {
          state.sidebarMounted()
          onCleanup(state.sidebarUnmounted)
          return null
        }
        return (
          <>
            <Presence />
            <Show when={state.active()}>
              <Sidebar {...state.view} />
            </Show>
          </>
        )
      },
    })

    // The footer duplicates the sidebar, so it only shows while the sidebar is hidden (or on the home screen).
    const stopFooter = context.ui.slot({
      append: "prompt.footer.status",
      render: () => (
        <Show when={state.active() && !state.sidebarVisible()}>
          <Footer {...state.view} />
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
            if (!state.active()) {
              await context.ui.dialog.alert({
                title: "Claude plan usage",
                message: `Not active: the selected model isn't from ${options.providers.join(", ")}.`,
              })
              return
            }
            await state.refresh(ON_DEMAND_GAP_MS)
            await context.ui.dialog.alert({ title: "Claude plan usage", message: describe(state.view, Date.now()) })
          },
        },
      ],
    }))

    // The host removes the keymap layer itself when the plugin is disabled or reloaded.
    return () => {
      stopSidebar()
      stopFooter()
      state.cleanup()
    }
  },
})

interface ViewProps {
  readonly snapshot: () => Snapshot | null
  readonly failure: () => Failure | null
  readonly blockedUntil: () => number
  readonly loading: () => boolean
  readonly now: () => number
  readonly options: Options
}

function Sidebar(props: ViewProps) {
  const { theme } = usePlugin()
  return (
    <box flexDirection="column" paddingTop={1}>
      <text fg={theme.text.base}>
        <b>Claude plan</b>
      </text>
      <Show
        when={props.snapshot()}
        fallback={
          <text fg={theme.text.muted}>
            {props.failure() ? failureText(props.failure()!, props.blockedUntil()) : props.loading() ? "loading…" : "no data yet"}
          </text>
        }
      >
        {(snapshot) => (
          <>
            <For each={snapshot().windows}>
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
            <Show when={snapshot().extra?.enabled}>
              <text fg={theme.text.muted}>{extraText(snapshot().extra!)}</text>
            </Show>
            <text fg={theme.text.faint}>updated {formatAge(snapshot().fetchedAt, props.now())}</text>
            <Show when={props.failure()}>
              {(failure) => (
                <text fg={theme.text.feedback.warning.base}>{failureText(failure(), props.blockedUntil())}</text>
              )}
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
      when={props.snapshot()}
      fallback={<text fg={theme.text.muted}>claude {props.failure()?.status === "stale" ? "stale" : "…"}</text>}
    >
      {(snapshot) => (
        <box flexDirection="row" gap={1}>
          <For each={snapshot().windows.filter(isPrimary)}>
            {(w) => (
              <text fg={levelColor(theme, w.utilization, props.options)}>
                {w.label} {formatPct(w.utilization)}
              </text>
            )}
          </For>
        </box>
      )}
    </Show>
  )
}

function describe(view: ViewProps, now: number): string {
  const snapshot = view.snapshot()
  const failure = view.failure()
  if (!snapshot) return failure ? failureText(failure, view.blockedUntil()) : "No data yet."
  const lines = snapshot.windows.map(
    (w) =>
      `${w.label.padEnd(9)} ${bar(w.utilization)} ${formatPct(w.utilization).padStart(4)}  ${formatReset(w.resetsAt, now)}`,
  )
  if (snapshot.extra) {
    const e = snapshot.extra
    lines.push(
      "",
      `Extra usage: ${e.enabled ? "enabled" : "disabled"}`,
      `  used ${formatMoney(e.usedCredits, e.currency)}${e.monthlyLimit !== null ? ` of ${formatMoney(e.monthlyLimit, e.currency)}` : " (no monthly limit)"}`,
    )
    if (e.spendLimitReached) lines.push("  spend limit reached")
  }
  lines.push("", `Updated ${new Date(snapshot.fetchedAt).toLocaleTimeString()} (${formatAge(snapshot.fetchedAt, now)})`)
  if (failure) lines.push(`Last refresh: ${failureText(failure, view.blockedUntil())}`)
  return lines.join("\n")
}

function failureText(failure: Failure, blockedUntil: number): string {
  if (failure.status === "rate_limited" && blockedUntil > Date.now()) {
    return `rate limited · retry ${new Date(blockedUntil).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`
  }
  return failure.message
}

function extraText(extra: ExtraUsage): string {
  const limit = extra.monthlyLimit !== null ? ` / ${formatMoney(extra.monthlyLimit, extra.currency)}` : ""
  return `extra usage on · ${formatMoney(extra.usedCredits, extra.currency)} used${limit}`
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
  const width = 10
  const filled = Math.round((Math.min(Math.max(pct, 0), 100) / 100) * width)
  return "█".repeat(filled) + "░".repeat(width - filled)
}

function formatPct(pct: number): string {
  return `${Math.round(pct)}%`
}

function formatReset(at: number, now: number): string {
  const ms = at - now
  if (ms <= 0) return "resetting"
  const minutes = Math.round(ms / 60_000)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h${String(minutes % 60).padStart(2, "0")}m`
  return `${Math.floor(hours / 24)}d${hours % 24}h`
}

function formatAge(at: number, now: number): string {
  const minutes = Math.floor(Math.max(0, now - at) / 60_000)
  if (minutes < 1) return "just now"
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
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
