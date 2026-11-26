/**
 * Claude plan usage fetcher.
 *
 * Reads the Claude Code OAuth access token from the macOS keychain on every
 * call, queries Anthropic's (undocumented) usage endpoint, and normalizes the
 * response. The token is held only in a local variable for the duration of the
 * request: it is never cached, logged, returned, or included in error messages.
 *
 * This module never refreshes the OAuth token. Refreshing rotates the stored
 * refresh token and can sign Claude Code out; Claude Code refreshes it on its
 * own the next time it is used.
 */
import { execFile } from "node:child_process"

const KEYCHAIN_SERVICE = "Claude Code-credentials"
const USAGE_URL = "https://api.anthropic.com/api/oauth/usage"
const BETA_HEADER = "oauth-2025-04-20"
const REQUEST_TIMEOUT_MS = 10_000

export interface UsageWindow {
  readonly key: string
  readonly label: string
  /** 0-100 */
  readonly utilization: number
  /** Epoch ms, or null when the window has not started (no usage yet, endpoint returns resets_at: null). */
  readonly resetsAt: number | null
}

export interface ExtraUsage {
  readonly enabled: boolean
  /** In major currency units (e.g. dollars), already scaled from the endpoint's minor units. */
  readonly usedCredits: number
  /** In major currency units (e.g. dollars), already scaled from the endpoint's minor units. */
  readonly monthlyLimit: number | null
  readonly currency: string
  readonly spendLimitReached: boolean
}

export type UsageResult =
  | {
      readonly status: "ok"
      readonly windows: readonly UsageWindow[]
      readonly extra: ExtraUsage | null
      /** Epoch ms. */
      readonly fetchedAt: number
    }
  | { readonly status: "stale"; readonly message: string }
  | { readonly status: "rate_limited"; readonly message: string; readonly retryAfterMs?: number }
  | { readonly status: "error"; readonly message: string }

/** Thrown when the endpoint's response no longer matches what we expect. */
export class UsageSchemaError extends Error {
  constructor(problems: readonly string[]) {
    super(`Usage response shape changed: ${problems.join("; ")}`)
    this.name = "UsageSchemaError"
  }
}

// Windows we know how to label. five_hour and seven_day are required; the rest
// are shown only when the endpoint returns a non-null object for them.
const WINDOWS: ReadonlyArray<{ key: string; label: string; required: boolean }> = [
  { key: "five_hour", label: "5h", required: true },
  { key: "seven_day", label: "7d", required: true },
  { key: "seven_day_opus", label: "7d Opus", required: false },
  { key: "seven_day_sonnet", label: "7d Sonnet", required: false },
  { key: "seven_day_oauth_apps", label: "7d apps", required: false },
]

/**
 * The single place that interprets the endpoint's response.
 * Throws UsageSchemaError when required fields are missing or mistyped.
 */
export function parseUsage(body: unknown, now = Date.now()): Extract<UsageResult, { status: "ok" }> {
  const problems: string[] = []
  if (!isRecord(body)) throw new UsageSchemaError(["response is not a JSON object"])

  const windows: UsageWindow[] = []
  for (const spec of WINDOWS) {
    const raw = body[spec.key]
    if (raw === undefined || raw === null) {
      if (spec.required) problems.push(`missing ${spec.key}`)
      continue
    }
    if (!isRecord(raw)) {
      problems.push(`${spec.key} is not an object`)
      continue
    }
    const utilization = raw.utilization
    // resets_at is null while a window is idle (no usage since the last reset).
    const resetsAt =
      raw.resets_at === null || raw.resets_at === undefined
        ? null
        : typeof raw.resets_at === "string"
          ? Date.parse(raw.resets_at)
          : Number.NaN
    if (typeof utilization !== "number" || !Number.isFinite(utilization)) {
      problems.push(`${spec.key}.utilization is not a number`)
      continue
    }
    if (Number.isNaN(resetsAt)) {
      problems.push(`${spec.key}.resets_at is not an ISO timestamp`)
      continue
    }
    windows.push({ key: spec.key, label: spec.label, utilization, resetsAt })
  }

  let extra: ExtraUsage | null = null
  const rawExtra = body.extra_usage
  if (rawExtra !== undefined && rawExtra !== null) {
    if (!isRecord(rawExtra) || typeof rawExtra.is_enabled !== "boolean") {
      problems.push("extra_usage.is_enabled is not a boolean")
    } else {
      // Amounts arrive in minor units (e.g. cents); decimal_places gives the scale.
      const scale = 10 ** decimalPlaces(rawExtra.decimal_places)
      extra = {
        enabled: rawExtra.is_enabled,
        usedCredits: isFiniteNumber(rawExtra.used_credits) ? rawExtra.used_credits / scale : 0,
        monthlyLimit: isFiniteNumber(rawExtra.monthly_limit) ? rawExtra.monthly_limit / scale : null,
        currency: typeof rawExtra.currency === "string" ? rawExtra.currency : "USD",
        spendLimitReached: rawExtra.spend_limit_reached === true,
      }
    }
  }

  if (problems.length > 0) throw new UsageSchemaError(problems)
  return { status: "ok", windows, extra, fetchedAt: now }
}

/** Reads the keychain, calls the endpoint, and returns a normalized result. Never throws. */
export async function fetchUsage(): Promise<UsageResult> {
  if (process.platform !== "darwin") {
    return { status: "error", message: "macOS only: credentials are read from the macOS keychain" }
  }

  let token: string
  try {
    const creds = await readCredentials()
    if (creds.expiresAt <= Date.now()) {
      return { status: "stale", message: "stale — token refreshes on next Claude use" }
    }
    token = creds.accessToken
  } catch (error) {
    return { status: "error", message: (error as Error).message }
  }

  let response: Response
  try {
    response = await fetch(USAGE_URL, {
      headers: { Authorization: `Bearer ${token}`, "anthropic-beta": BETA_HEADER },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
  } catch (error) {
    const name = (error as Error).name
    return {
      status: "error",
      message: name === "TimeoutError" ? "usage request timed out" : "usage request failed (network)",
    }
  } finally {
    token = ""
  }

  if (response.status === 401) {
    return { status: "stale", message: "stale — token rejected (401); refreshes on next Claude use" }
  }
  if (response.status === 429) {
    const retryAfter = Number(response.headers.get("retry-after"))
    return {
      status: "rate_limited",
      message: "rate limited by usage endpoint",
      retryAfterMs: Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : undefined,
    }
  }
  if (!response.ok) {
    return { status: "error", message: `usage endpoint returned HTTP ${response.status}` }
  }

  let body: unknown
  try {
    body = await response.json()
  } catch {
    return { status: "error", message: "usage endpoint returned non-JSON body" }
  }

  try {
    return parseUsage(body)
  } catch (error) {
    return { status: "error", message: (error as Error).message }
  }
}

interface Credentials {
  readonly accessToken: string
  readonly expiresAt: number
}

async function readCredentials(): Promise<Credentials> {
  const raw = await new Promise<string>((resolve, reject) => {
    execFile(
      "security",
      ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-w"],
      { timeout: 5_000, maxBuffer: 1024 * 1024 },
      (error, stdout) => {
        // Do not forward stdout/stderr: on partial failure they may contain secrets.
        if (error) reject(new Error(`keychain item "${KEYCHAIN_SERVICE}" not readable — sign in to Claude Code first`))
        else resolve(stdout)
      },
    )
  })

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    // JSON.parse messages can quote input; never surface them.
    throw new Error("keychain credentials are not valid JSON")
  }

  const oauth = isRecord(parsed) ? parsed.claudeAiOauth : undefined
  if (!isRecord(oauth)) throw new Error("keychain credentials missing claudeAiOauth")
  if (typeof oauth.accessToken !== "string" || oauth.accessToken.length === 0) {
    throw new Error("keychain credentials missing accessToken")
  }
  if (typeof oauth.expiresAt !== "number") throw new Error("keychain credentials missing expiresAt")
  return { accessToken: oauth.accessToken, expiresAt: oauth.expiresAt }
}

/** Minor-unit scale for extra_usage amounts. Defaults to 2 (cents) when absent or not a sane integer. */
const DEFAULT_DECIMAL_PLACES = 2
const MAX_DECIMAL_PLACES = 8

function decimalPlaces(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= MAX_DECIMAL_PLACES
    ? value
    : DEFAULT_DECIMAL_PLACES
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
