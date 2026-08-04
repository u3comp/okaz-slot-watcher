const PRODUCT_ID = 850942259;
const STORE_ID = 27747031;
const OPTION_NAME = "ご希望の日時";
const OVERRIDES_URL = `https://au-syd3-storefront-api.ecwid.com/storefront/api/v1/${STORE_ID}/catalog/product/overrides`;
const CUTOFF_MS = Date.parse("2026-08-23T07:30:00.000Z");
const FETCH_TIMEOUT_MS = 12_000;
const MAX_ECWID_ATTEMPTS = 3;
const MAX_DELIVERY_ATTEMPTS = 3;
const LOCK_LEASE_MS = 4 * 60_000;
const USER_AGENT = "okaz-slot-watcher-cf/1.0";

export const SLOTS = [
  { key: "2026-08-22_1030", label: "8/22（土）10:30-12:30" },
  { key: "2026-08-22_1400", label: "8/22（土）14:00-16:00" },
  { key: "2026-08-23_1030", label: "8/23（日）10:30-12:30" },
  { key: "2026-08-23_1400", label: "8/23（日）14:00-16:00" },
] as const;

type Status = "AVAILABLE" | "SOLD_OUT" | "MISSING" | "UNKNOWN";
type ChannelState = { discord: boolean; line?: boolean };
export type DeliveryErrorClass =
  | "timeout"
  | "abort"
  | "network_exception"
  | "redirect_response"
  | "http_error"
  | "response_read_error"
  | "response_validation_error"
  | "configuration_error"
  | "unknown_exception";
export type DeliveryDiagnostic = {
  attempt_count: number;
  last_attempt_at_utc?: string;
  last_http_status?: number;
  last_error_class?: DeliveryErrorClass;
  last_error_name?: string;
  last_error_message?: string;
  response_content_type?: string;
  response_excerpt_hash?: string;
  response_excerpt?: string;
  redirect_status?: number;
  redirect_location_present?: boolean;
  redirect_host?: string;
  permanent_failure: boolean;
  completed_at_utc?: string;
};
export type DiscordDeliveryDiagnostic = DeliveryDiagnostic & {
  discord_request_id?: string;
  webhook_wait_confirmed?: boolean;
};
export type LineDeliveryDiagnostic = DeliveryDiagnostic & {
  retry_key?: string;
  x_line_request_id?: string;
  x_line_accepted_request_id?: string;
};
export type Pending = {
  id: string;
  kind: string;
  message: string;
  channels: ChannelState;
  repeat?: {
    series_id: string;
    sequence: number;
    total: number;
    detected_at_utc: string;
    not_before_utc: string;
  };
  line_retry_key?: string;
  delivery?: {
    discord?: DiscordDeliveryDiagnostic;
    line?: LineDeliveryDiagnostic;
  };
};
export type DiagnosticClass =
  | "timeout"
  | "abort"
  | "network_exception"
  | "redirect_response"
  | "http_error"
  | "json_parse_error"
  | "unknown_exception";
export type SlotDiagnostic = {
  attempt_count: number;
  error_class?: DiagnosticClass;
  error_name?: string;
  error_message?: string;
  http_status?: number;
  response_content_type?: string;
  response_excerpt_hash?: string;
  response_excerpt?: string;
  redirect_status?: number;
  redirect_location_present?: boolean;
  redirect_host?: string;
  content_type_valid?: boolean;
};
type SlotState = {
  label: string;
  status: Status;
  quantity?: number;
  variationId?: number;
  reason?: string;
  diagnostic?: SlotDiagnostic;
};
export type State = {
  schema_version: 2;
  slots: Record<string, SlotState>;
  consecutive_total_failures: number;
  outage_notified: boolean;
  pending_notifications: Pending[];
  updated_at_jst: string;
  last_run_id?: string;
  observed_at_utc?: string;
  observed_at_jst?: string;
  last_attempt_count?: number;
  last_error_class?: DiagnosticClass;
  last_error_name?: string;
  last_error_message?: string;
  last_http_status?: number;
  last_response_content_type?: string;
  last_response_excerpt_hash?: string;
  last_redirect_status?: number;
  last_redirect_location_present?: boolean;
  last_redirect_host?: string;
};
type StateRecord = { state: State; version: number };

export interface Env {
  DB: D1Database;
  DRY_RUN?: string;
  LINE_ENABLED?: string;
  LINE_DESTINATION_MODE?: string;
  TARGET_PAGE_URL?: string;
  DISCORD_WEBHOOK_URL?: string;
  LINE_CHANNEL_ACCESS_TOKEN?: string;
  LINE_USER_ID?: string;
  LINE_GROUP_ID?: string;
}

export type LineDestinationMode = "personal" | "group";
export type LineDestination = { mode: LineDestinationMode; destinationId: string };

export function resolveLineDestination(
  modeValue: string | undefined,
  personalId: string | undefined,
  groupId: string | undefined,
  override: "configured" | "personal" | "group" = "configured",
): LineDestination {
  const configuredMode = (modeValue ?? "personal").trim().toLowerCase() || "personal";
  const selectedMode = override === "configured" ? configuredMode : override;
  if (selectedMode !== "personal" && selectedMode !== "group") {
    throw new Error("line_destination_mode_invalid");
  }
  const destinationId = selectedMode === "personal" ? personalId : groupId;
  if (!destinationId) throw new Error(`line_${selectedMode}_destination_missing`);
  return { mode: selectedMode, destinationId };
}

export function lineDestinationStatus(env: Env): {
  line_destination_mode: string;
  line_user_id_configured: boolean;
  line_group_id_configured: boolean;
} {
  const mode = (env.LINE_DESTINATION_MODE ?? "personal").trim().toLowerCase() || "personal";
  return {
    line_destination_mode: mode,
    line_user_id_configured: Boolean(env.LINE_USER_ID),
    line_group_id_configured: Boolean(env.LINE_GROUP_ID),
  };
}

function nowJst(at = new Date()): string {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Tokyo", dateStyle: "short", timeStyle: "medium", hour12: false,
  }).format(at).replace(" ", "T");
}

function defaultState(): State {
  return {
    schema_version: 2,
    slots: Object.fromEntries(SLOTS.map((slot) => [slot.key, { label: slot.label, status: "UNKNOWN" }])),
    consecutive_total_failures: 0,
    outage_notified: false,
    pending_notifications: [],
    updated_at_jst: nowJst(),
  };
}

async function loadState(db: D1Database): Promise<StateRecord> {
  const row = await db.prepare("SELECT state_json, version FROM watcher_state WHERE id = 1")
    .first<{ state_json: string; version: number }>();
  if (!row) return { state: defaultState(), version: 0 };
  try {
    const state = JSON.parse(row.state_json) as State;
    if (state.schema_version !== 2 || !state.slots || !Array.isArray(state.pending_notifications)) {
      return { state: defaultState(), version: row.version };
    }
    return { state, version: row.version };
  } catch {
    return { state: defaultState(), version: row.version };
  }
}

export async function saveState(db: D1Database, state: State, expectedVersion: number, observedAt = new Date()): Promise<number> {
  state.updated_at_jst = nowJst(observedAt);
  const encoded = JSON.stringify(state);
  await db.prepare(
    "INSERT OR IGNORE INTO watcher_state (id, state_json, updated_at_jst, version) VALUES (1, ?, ?, 0)",
  ).bind(encoded, state.updated_at_jst).run();
  const result = await db.prepare(
    "UPDATE watcher_state SET state_json = ?, updated_at_jst = ?, version = version + 1 WHERE id = 1 AND version = ?",
  ).bind(encoded, state.updated_at_jst, expectedVersion).run();
  if ((result.meta.changes ?? 0) !== 1) throw new Error("state_version_conflict");
  return expectedVersion + 1;
}

export async function acquireLease(db: D1Database, owner: string): Promise<boolean> {
  const now = Date.now();
  const until = now + LOCK_LEASE_MS;
  await db.prepare(
    "INSERT OR IGNORE INTO watcher_lock (id, owner, lease_until_ms) VALUES (1, ?, 0)",
  ).bind(owner).run();
  const result = await db.prepare(
    "UPDATE watcher_lock SET owner = ?, lease_until_ms = ? WHERE id = 1 AND (lease_until_ms < ? OR owner = ?)",
  ).bind(owner, until, now, owner).run();
  return (result.meta.changes ?? 0) === 1;
}

async function releaseLease(db: D1Database, owner: string): Promise<void> {
  await db.prepare("UPDATE watcher_lock SET lease_until_ms = 0 WHERE id = 1 AND owner = ?").bind(owner).run();
}

function retryAfterMs(response: Response): number {
  const value = response.headers.get("retry-after");
  if (!value) return 0;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.min(Math.max(seconds * 1000, 0), 10_000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.min(Math.max(date - Date.now(), 0), 10_000) : 0;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const MAX_DIAGNOSTIC_TEXT = 128;
const MAX_RESPONSE_BYTES = 64 * 1024;

export function sanitizeDiagnosticText(value: unknown): string {
  let text = String(value ?? "")
    .replace(/[\r\n]+/g, " ")
    .replace(/[\u0000-\u001F\u007F]/g, " ");
  text = text.replace(/Bearer\s+[^\s,;]+/gi, "Bearer [REDACTED]");
  text = text.replace(/["']?\b(access[_-]?token|authorization|cookie|token|webhook(?:[_-]?url)?|user[_-]?id)\b["']?\s*[:=]\s*["']?[^"'\s,;}]+["']?/gi, "$1=[REDACTED]");
  text = text.replace(/(["'](?:id|channel_id|user_id|webhook_id|to)["']\s*:\s*)["']?[^"',}\s]+["']?/gi, "$1[REDACTED]");
  text = text.replace(/https?:\/\/discord\.com\/api\/webhooks\/[^\s"'<>]+/gi, "[REDACTED_URL]");
  text = text.replace(/https?:\/\/api\.line\.me\/[^\s"'<>]+/gi, "[REDACTED_URL]");
  text = text.replace(/https?:\/\/[^\s"'<>]+/gi, (raw) => {
    try {
      const url = new URL(raw);
      return `${url.origin}${url.pathname}`;
    } catch {
      return "[REDACTED_URL]";
    }
  });
  return text.slice(0, MAX_DIAGNOSTIC_TEXT);
}

export function isUuid(value: unknown): value is string {
  return typeof value === "string"
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

export function classifyFetchError(error: unknown): {
  errorClass: DiagnosticClass;
  errorName: string;
  errorMessage: string;
} {
  const value = error as { name?: unknown; message?: unknown; constructor?: { name?: unknown } } | null;
  const errorName = sanitizeDiagnosticText(typeof value?.name === "string" ? value.name : value?.constructor?.name);
  const errorMessage = sanitizeDiagnosticText(value?.message);
  if (errorName === "TimeoutError") return { errorClass: "timeout", errorName, errorMessage };
  if (errorName === "AbortError") return { errorClass: "abort", errorName, errorMessage };
  if (error instanceof TypeError) return { errorClass: "network_exception", errorName, errorMessage };
  return { errorClass: "unknown_exception", errorName, errorMessage };
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function readLimitedText(response: Response): Promise<{ text: string; truncated: boolean }> {
  if (!response.body) {
    const text = await response.text();
    return { text: text.slice(0, MAX_RESPONSE_BYTES), truncated: text.length > MAX_RESPONSE_BYTES };
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let bytes = 0;
  let truncated = false;
  try {
    while (bytes < MAX_RESPONSE_BYTES) {
      const chunk = await reader.read();
      if (chunk.done) break;
      const remaining = MAX_RESPONSE_BYTES - bytes;
      const part = chunk.value.byteLength > remaining ? chunk.value.slice(0, remaining) : chunk.value;
      text += decoder.decode(part, { stream: true });
      bytes += part.byteLength;
      if (part.byteLength < chunk.value.byteLength) {
        truncated = true;
        break;
      }
    }
  } finally {
    try { await reader.cancel(); } catch { /* diagnostics must not mask the original response */ }
  }
  return { text: text + decoder.decode(), truncated };
}

function redirectHost(location: string | null, baseUrl = OVERRIDES_URL): string | undefined {
  if (!location) return undefined;
  try { return new URL(location, baseUrl).hostname; } catch { return undefined; }
}

function isJsonContentType(contentType: string | null | undefined): boolean {
  return Boolean(contentType && /(^|[;\s])application\/json(?:\s|;|$)|\+json(?:\s|;|$)/i.test(contentType));
}

function clearLastDiagnostics(state: State): void {
  delete state.last_run_id;
  delete state.observed_at_utc;
  delete state.observed_at_jst;
  delete state.last_attempt_count;
  delete state.last_error_class;
  delete state.last_error_name;
  delete state.last_error_message;
  delete state.last_http_status;
  delete state.last_response_content_type;
  delete state.last_response_excerpt_hash;
  delete state.last_redirect_status;
  delete state.last_redirect_location_present;
  delete state.last_redirect_host;
}

export function statusFromResponse(payload: unknown): { status: Status; quantity?: number; variationId?: number } {
  if (!payload || typeof payload !== "object") return { status: "UNKNOWN", };
  const overrides = (payload as { variationOverrides?: unknown }).variationOverrides;
  if (!overrides || typeof overrides !== "object") return { status: "UNKNOWN" };
  const value = overrides as { isSoldOut?: unknown; quantity?: unknown; variationId?: unknown };
  const quantity = typeof value.quantity === "number" ? value.quantity : undefined;
  const variationId = typeof value.variationId === "number" ? value.variationId : undefined;
  if (value.isSoldOut === true || quantity === 0) return { status: "SOLD_OUT", quantity, variationId };
  if (value.isSoldOut === false && typeof quantity === "number" && quantity > 0) return { status: "AVAILABLE", quantity, variationId };
  return { status: "UNKNOWN", quantity, variationId };
}

async function responseDiagnostic(response: Response, attempt: number): Promise<{ diagnostic: SlotDiagnostic; bodyText: string }> {
  const contentType = response.headers.get("content-type") ?? undefined;
  const diagnostic: SlotDiagnostic = {
    attempt_count: attempt,
    http_status: response.status,
    response_content_type: contentType,
  };
  if (response.status >= 300 && response.status <= 399) {
    diagnostic.error_class = "redirect_response";
    diagnostic.redirect_status = response.status;
    const location = response.headers.get("location");
    diagnostic.redirect_location_present = Boolean(location);
    diagnostic.redirect_host = redirectHost(location);
    return { diagnostic, bodyText: "" };
  }
  let body: { text: string; truncated: boolean };
  try {
    body = await readLimitedText(response);
  } catch (error) {
    const classified = classifyFetchError(error);
    return {
      diagnostic: {
        ...diagnostic,
        error_class: "http_error",
        error_name: "ResponseReadError",
        error_message: classified.errorMessage || "response_read_failed",
      },
      bodyText: "",
    };
  }
  diagnostic.response_excerpt_hash = await sha256Hex(body.text);
  diagnostic.content_type_valid = isJsonContentType(contentType);
  if (!response.ok) {
    diagnostic.error_class = "http_error";
    diagnostic.error_name = `HTTP_${response.status}`;
    diagnostic.error_message = sanitizeDiagnosticText(body.text);
    if (body.text) diagnostic.response_excerpt = sanitizeDiagnosticText(body.text);
    return { diagnostic, bodyText: body.text };
  }
  if (!diagnostic.content_type_valid) {
    diagnostic.error_class = "http_error";
    diagnostic.error_name = "InvalidContentType";
    diagnostic.error_message = "content_type_invalid";
    if (body.text) diagnostic.response_excerpt = sanitizeDiagnosticText(body.text);
  }
  return { diagnostic, bodyText: body.text };
}

export async function observeSlot(slot: (typeof SLOTS)[number]): Promise<SlotState> {
  for (let attempt = 1; attempt <= MAX_ECWID_ATTEMPTS; attempt += 1) {
    let response: Response;
    try {
      response = await fetch(OVERRIDES_URL, {
        method: "POST",
        redirect: "manual",
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        headers: { "content-type": "application/json", accept: "application/json", "user-agent": USER_AGENT },
        body: JSON.stringify({
          lang: "ja",
          productIdentifier: { type: "PUBLISHED", productId: PRODUCT_ID },
          selectedOptions: { [OPTION_NAME]: { type: "RADIO", choice: slot.label } },
        }),
      });
    } catch (error) {
      const classified = classifyFetchError(error);
      const reason = classified.errorClass === "timeout" ? "ecwid_timeout" : "ecwid_request_failed";
      return {
        label: slot.label,
        status: "UNKNOWN",
        reason,
        diagnostic: {
          attempt_count: attempt,
          error_class: classified.errorClass,
          error_name: classified.errorName,
          error_message: classified.errorMessage,
        },
      };
    }
    const retryable = [429, 502, 503, 504].includes(response.status);
    if (retryable && attempt < MAX_ECWID_ATTEMPTS) {
      await wait(Math.max(retryAfterMs(response), 250 * (2 ** (attempt - 1))));
      continue;
    }
    const inspection = await responseDiagnostic(response, attempt);
    const diagnostic = inspection.diagnostic;
    if (diagnostic.error_class === "redirect_response") {
      return { label: slot.label, status: "UNKNOWN", reason: `ecwid_http_${response.status}`, diagnostic };
    }
    if (!response.ok) return { label: slot.label, status: "UNKNOWN", reason: `ecwid_http_${response.status}`, diagnostic };
    if (diagnostic.error_name === "ResponseReadError") {
      return { label: slot.label, status: "UNKNOWN", reason: "ecwid_response_read_failed", diagnostic };
    }
    if (!diagnostic.content_type_valid) {
      return { label: slot.label, status: "UNKNOWN", reason: "ecwid_invalid_content_type", diagnostic };
    }
    try {
      const payload = JSON.parse(inspection.bodyText) as unknown;
      return { label: slot.label, ...statusFromResponse(payload), diagnostic };
    } catch {
      return {
        label: slot.label,
        status: "UNKNOWN",
        reason: "ecwid_invalid_json",
        diagnostic: { ...diagnostic, error_class: "json_parse_error", error_name: "SyntaxError", error_message: "invalid_json" },
      };
    }
  }
  return { label: slot.label, status: "UNKNOWN", reason: "ecwid_retry_exhausted" };
}

function emptyDeliveryDiagnostic(): DeliveryDiagnostic {
  return { attempt_count: 0, permanent_failure: false };
}

function normalizeDeliveryDiagnostic<T extends DeliveryDiagnostic>(value: T | undefined): T {
  return {
    attempt_count: Number.isInteger(value?.attempt_count) && value!.attempt_count >= 0 ? value!.attempt_count : 0,
    permanent_failure: Boolean(value?.permanent_failure),
    ...value,
  } as T;
}

export function preparePendingForDelivery(state: State, lineEnabled: boolean): void {
  for (const item of state.pending_notifications) {
    item.delivery ??= {};
    item.delivery.discord = normalizeDeliveryDiagnostic(item.delivery.discord);
    if (lineEnabled && item.channels.line !== undefined) {
      const existingKey = isUuid(item.line_retry_key)
        ? item.line_retry_key
        : (isUuid(item.delivery.line?.retry_key) ? item.delivery.line.retry_key : undefined);
      const retryKey = existingKey ?? crypto.randomUUID();
      item.line_retry_key = retryKey;
      item.delivery.line = {
        ...normalizeDeliveryDiagnostic(item.delivery.line),
        retry_key: retryKey,
      };
    }
  }
}

export function validateTargetPageUrl(value?: string): boolean {
  if (!value) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:"
      && !url.username
      && !url.password
      && url.hostname === "shop.okaz-design.jp"
      && url.search === ""
      && url.hash === "";
  } catch {
    return false;
  }
}

function pageLink(targetUrl: string): string {
  return `最新状況は申込ページで確認してください。\n\n申込ページ:\n${targetUrl}`;
}

export function buildAvailabilityMessage(
  sequence: number,
  total: number,
  labels: string,
  detectedAt: Date,
  targetUrl: string,
): string {
  const title = sequence === 1
    ? `【空き枠復活 ${sequence}/${total}】`
    : sequence === total
      ? `【空き枠復活 最終通知 ${sequence}/${total}】`
      : `【空き枠復活 再通知 ${sequence}/${total}】`;
  return [
    title,
    `空き枠復活を検知しました: ${labels}`,
    `検知時刻: ${nowJst(detectedAt)}`,
    `通知回数: ${sequence}/${total}`,
    pageLink(targetUrl),
  ].join("\n");
}

export function buildOutageMessage(targetUrl: string): string {
  return `監視障害: 全枠の判定に3回連続で失敗しました。\n${pageLink(targetUrl)}`;
}

export function buildRecoveredMessage(targetUrl: string): string {
  return `監視復旧: 商品ページの判定が復旧しました。\n${pageLink(targetUrl)}`;
}

export function enqueueSingleNotification(
  state: State,
  kind: string,
  message: string,
  lineEnabled: boolean,
  dryRun: boolean,
  dryEvents: Pending[],
): void {
  const lineRetryKey = lineEnabled ? crypto.randomUUID() : undefined;
  const item: Pending = {
    id: crypto.randomUUID(),
    kind,
    message,
    channels: lineEnabled ? { discord: false, line: false } : { discord: false },
    delivery: {
      discord: emptyDeliveryDiagnostic(),
      ...(lineEnabled ? { line: { ...emptyDeliveryDiagnostic(), retry_key: lineRetryKey } } : {}),
    },
    ...(lineRetryKey ? { line_retry_key: lineRetryKey } : {}),
  };
  if (dryRun) dryEvents.push(item); else state.pending_notifications.push(item);
}

export function enqueueAvailabilitySeries(
  state: State,
  labels: string,
  detectedAt: Date,
  targetUrl: string,
  lineEnabled: boolean,
  dryRun: boolean,
  dryEvents: Pending[],
): void {
  const total = 5;
  const seriesId = crypto.randomUUID();
  const detectedAtUtc = detectedAt.toISOString();
  for (let sequence = 1; sequence <= total; sequence += 1) {
    const lineRetryKey = lineEnabled ? crypto.randomUUID() : undefined;
    const item: Pending = {
      id: crypto.randomUUID(),
      kind: "available",
      message: buildAvailabilityMessage(sequence, total, labels, detectedAt, targetUrl),
      channels: lineEnabled ? { discord: false, line: false } : { discord: false },
      repeat: {
        series_id: seriesId,
        sequence,
        total,
        detected_at_utc: detectedAtUtc,
        not_before_utc: new Date(detectedAt.getTime() + (sequence - 1) * 60_000).toISOString(),
      },
      delivery: {
        discord: emptyDeliveryDiagnostic(),
        ...(lineEnabled ? { line: { ...emptyDeliveryDiagnostic(), retry_key: lineRetryKey } } : {}),
      },
      ...(lineRetryKey ? { line_retry_key: lineRetryKey } : {}),
    };
    if (dryRun) dryEvents.push(item); else state.pending_notifications.push(item);
  }
}

async function recordDryRunEvents(db: D1Database, events: Pending[], observedAt: Date): Promise<void> {
  if (!events.length) return;
  const statements = events.map((event) => db.prepare(
    "INSERT OR IGNORE INTO dry_run_events (id, kind, message, created_at_jst) VALUES (?, ?, ?, ?)",
  ).bind(event.id, event.kind, event.message, nowJst(observedAt)));
  const cutoff = nowJst(new Date(observedAt.getTime() - 7 * 24 * 60 * 60 * 1000));
  statements.push(db.prepare("DELETE FROM dry_run_events WHERE created_at_jst < ?").bind(cutoff));
  await db.batch(statements);
}

type DeliveryAttemptResult = {
  success: boolean;
  permanentFailure: boolean;
  diagnostic: Partial<DiscordDeliveryDiagnostic & LineDeliveryDiagnostic>;
};

async function deliveryResponseDetails(response: Response): Promise<{
  bodyText: string;
  diagnostic: Partial<DeliveryDiagnostic>;
  readFailed: boolean;
}> {
  const diagnostic: Partial<DeliveryDiagnostic> = {
    last_http_status: response.status,
    response_content_type: response.headers.get("content-type") ?? undefined,
  };
  try {
    const body = await readLimitedText(response);
    diagnostic.response_excerpt_hash = await sha256Hex(body.text);
    if (body.text) diagnostic.response_excerpt = sanitizeDiagnosticText(body.text);
    return { bodyText: body.text, diagnostic, readFailed: false };
  } catch (error) {
    const classified = classifyFetchError(error);
    return {
      bodyText: "",
      diagnostic: {
        ...diagnostic,
        last_error_class: "response_read_error",
        last_error_name: "ResponseReadError",
        last_error_message: classified.errorMessage || "response_read_failed",
      },
      readFailed: true,
    };
  }
}

function deliveryException(error: unknown, permanentFailure = false): DeliveryAttemptResult {
  const classified = classifyFetchError(error);
  return {
    success: false,
    permanentFailure,
    diagnostic: {
      last_error_class: classified.errorClass as DeliveryErrorClass,
      last_error_name: classified.errorName || "DeliveryError",
      last_error_message: classified.errorMessage || "delivery_failed",
    },
  };
}

export async function sendDiscord(url: string, message: string): Promise<DeliveryAttemptResult> {
  let webhookUrl: URL;
  try {
    webhookUrl = new URL(url);
    webhookUrl.searchParams.set("wait", "true");
  } catch {
    return {
      success: false,
      permanentFailure: true,
      diagnostic: {
        last_error_class: "configuration_error",
        last_error_name: "InvalidWebhookUrl",
        last_error_message: "discord_webhook_url_invalid",
      },
    };
  }
  let response: Response;
  try {
    response = await fetch(webhookUrl.toString(), {
      method: "POST", redirect: "manual", signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { "content-type": "application/json", "user-agent": USER_AGENT },
      body: JSON.stringify({ content: message, allowed_mentions: { parse: [] } }),
    });
  } catch (error) {
    return deliveryException(error);
  }
  const details = await deliveryResponseDetails(response);
  const discordRequestId = response.headers.get("x-discord-request-id")
    ?? response.headers.get("x-request-id")
    ?? undefined;
  const diagnostic = {
    ...details.diagnostic,
    ...(discordRequestId ? { discord_request_id: sanitizeDiagnosticText(discordRequestId) } : {}),
  };
  if (response.status >= 300 && response.status <= 399) {
    return {
      success: false,
      permanentFailure: true,
      diagnostic: {
        ...diagnostic,
        redirect_status: response.status,
        redirect_location_present: Boolean(response.headers.get("location")),
        redirect_host: redirectHost(response.headers.get("location"), webhookUrl.toString()),
        last_error_class: "redirect_response",
        last_error_name: `HTTP_${response.status}`,
        last_error_message: `discord_redirect_${response.status}`,
      },
    };
  }
  if (details.readFailed) return { success: false, permanentFailure: false, diagnostic };
  if (response.status === 204) {
    return { success: true, permanentFailure: false, diagnostic: { ...diagnostic, webhook_wait_confirmed: false } };
  }
  if (response.status === 200) {
    try {
      const payload = JSON.parse(details.bodyText) as unknown;
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("invalid_message_object");
      return { success: true, permanentFailure: false, diagnostic: { ...diagnostic, webhook_wait_confirmed: true } };
    } catch {
      return {
        success: false,
        permanentFailure: false,
        diagnostic: {
          ...diagnostic,
          last_error_class: "response_validation_error",
          last_error_name: "InvalidDiscordMessageResponse",
          last_error_message: "discord_message_response_invalid",
          webhook_wait_confirmed: false,
        },
      };
    }
  }
  const retryable = response.status === 429 || response.status >= 500;
  return {
    success: false,
    permanentFailure: !retryable,
    diagnostic: {
      ...diagnostic,
      last_error_class: "http_error",
      last_error_name: `HTTP_${response.status}`,
      last_error_message: `discord_http_${response.status}`,
      webhook_wait_confirmed: false,
    },
  };
}

export async function sendLine(token: string, userId: string, message: string, retryKey: string): Promise<DeliveryAttemptResult> {
  if (!isUuid(retryKey)) {
    return {
      success: false,
      permanentFailure: true,
      diagnostic: {
        last_error_class: "configuration_error",
        last_error_name: "InvalidLineRetryKey",
        last_error_message: "line_retry_key_invalid",
        retry_key: undefined,
      },
    };
  }
  let response: Response;
  try {
    response = await fetch("https://api.line.me/v2/bot/message/push", {
      method: "POST", redirect: "manual", signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "x-line-retry-key": retryKey, "user-agent": USER_AGENT },
      body: JSON.stringify({ to: userId, messages: [{ type: "text", text: message }] }),
    });
  } catch (error) {
    return deliveryException(error);
  }
  const details = await deliveryResponseDetails(response);
  const lineRequestId = response.headers.get("x-line-request-id") ?? undefined;
  const acceptedRequestId = response.headers.get("x-line-accepted-request-id") ?? undefined;
  const diagnostic = {
    ...details.diagnostic,
    retry_key: retryKey,
    ...(lineRequestId ? { x_line_request_id: sanitizeDiagnosticText(lineRequestId) } : {}),
    ...(acceptedRequestId ? { x_line_accepted_request_id: sanitizeDiagnosticText(acceptedRequestId) } : {}),
  };
  if (response.status >= 300 && response.status <= 399) {
    return {
      success: false,
      permanentFailure: true,
      diagnostic: {
        ...diagnostic,
        redirect_status: response.status,
        redirect_location_present: Boolean(response.headers.get("location")),
        redirect_host: redirectHost(response.headers.get("location"), "https://api.line.me/v2/bot/message/push"),
        last_error_class: "redirect_response",
        last_error_name: `HTTP_${response.status}`,
        last_error_message: `line_redirect_${response.status}`,
      },
    };
  }
  if (details.readFailed) return { success: false, permanentFailure: false, diagnostic };
  if (response.status >= 200 && response.status <= 299) {
    return { success: true, permanentFailure: false, diagnostic };
  }
  if (response.status === 409 && acceptedRequestId) {
    return { success: true, permanentFailure: false, diagnostic };
  }
  const retryable = response.status === 429 || response.status >= 500;
  return {
    success: false,
    permanentFailure: !retryable,
    diagnostic: {
      ...diagnostic,
      last_error_class: "http_error",
      last_error_name: `HTTP_${response.status}`,
      last_error_message: `line_http_${response.status}`,
    },
  };
}

function applyAttemptResult<T extends DeliveryDiagnostic>(
  previous: T,
  result: DeliveryAttemptResult,
  attemptedAt: Date,
): T {
  const attemptCount = previous.attempt_count + 1;
  const completedAt = result.success ? attemptedAt.toISOString() : undefined;
  return {
    attempt_count: attemptCount,
    last_attempt_at_utc: attemptedAt.toISOString(),
    permanent_failure: result.success ? false : (result.permanentFailure || attemptCount >= MAX_DELIVERY_ATTEMPTS),
    ...result.diagnostic,
    ...(completedAt ? { completed_at_utc: completedAt } : {}),
  } as T;
}

function shouldAttempt(diagnostic: DeliveryDiagnostic): boolean {
  return !diagnostic.permanent_failure && diagnostic.attempt_count < MAX_DELIVERY_ATTEMPTS;
}

function isDue(item: Pending, scheduledAt: Date): boolean {
  if (!item.repeat) return true;
  const notBefore = Date.parse(item.repeat.not_before_utc);
  return Number.isFinite(notBefore) && notBefore <= scheduledAt.getTime();
}

function pendingDueForDelivery(state: State, scheduledAt: Date): Pending[] {
  const selectedSeries = new Set<string>();
  return state.pending_notifications.filter((item) => {
    if (!item.repeat) return true;
    if (selectedSeries.has(item.repeat.series_id)) return false;
    if (!isDue(item, scheduledAt)) return false;
    selectedSeries.add(item.repeat.series_id);
    return true;
  });
}

export async function deliverPending(
  env: Env,
  state: State,
  lineEnabled: boolean,
  scheduledAt = new Date(),
): Promise<boolean> {
  const before = JSON.stringify(state);
  const lineConfigured = lineEnabled && Boolean(env.LINE_CHANNEL_ACCESS_TOKEN);
  let lineDestination: LineDestination | undefined;
  if (lineEnabled) {
    try {
      lineDestination = resolveLineDestination(
        env.LINE_DESTINATION_MODE,
        env.LINE_USER_ID,
        env.LINE_GROUP_ID,
      );
    } catch {
      lineDestination = undefined;
    }
  }
  preparePendingForDelivery(state, lineEnabled);
  for (const item of pendingDueForDelivery(state, scheduledAt)) {
    const discordDiagnostic = item.delivery!.discord!;
    if (!item.channels.discord && discordDiagnostic.attempt_count >= MAX_DELIVERY_ATTEMPTS) {
      discordDiagnostic.permanent_failure = true;
    }
    if (!item.channels.discord && env.DISCORD_WEBHOOK_URL && shouldAttempt(discordDiagnostic)) {
      const result = await sendDiscord(env.DISCORD_WEBHOOK_URL, item.message);
      item.delivery!.discord = applyAttemptResult(discordDiagnostic, result, new Date());
      if (result.success) item.channels.discord = true;
      else console.log(JSON.stringify({ event: "notification_delivery_failed", channel: "discord", error_class: item.delivery!.discord.last_error_class }));
    }

    if (lineConfigured && lineDestination && item.channels.line === false) {
      const lineDiagnostic = item.delivery!.line!;
      if (lineDiagnostic.attempt_count >= MAX_DELIVERY_ATTEMPTS) lineDiagnostic.permanent_failure = true;
      if (shouldAttempt(lineDiagnostic)) {
        const result = await sendLine(
          env.LINE_CHANNEL_ACCESS_TOKEN!, lineDestination.destinationId, item.message, item.line_retry_key!,
        );
        item.delivery!.line = {
          ...applyAttemptResult(lineDiagnostic, result, new Date()),
          retry_key: item.line_retry_key,
        };
        if (result.success) item.channels.line = true;
        else console.log(JSON.stringify({ event: "notification_delivery_failed", channel: "line", error_class: item.delivery!.line.last_error_class }));
      }
    }
  }
  state.pending_notifications = state.pending_notifications.filter(
    (item) => !(item.channels.discord && item.channels.line !== false),
  );
  return before !== JSON.stringify(state);
}

function validateStartup(env: Env): boolean {
  if (!validateTargetPageUrl(env.TARGET_PAGE_URL)) {
    console.log("target_page_url_invalid");
    return false;
  }
  if (env.LINE_ENABLED === "true" && !env.LINE_CHANNEL_ACCESS_TOKEN) {
    console.log("line_secret_missing");
    return false;
  }
  if (env.LINE_ENABLED === "true") {
    try {
      resolveLineDestination(env.LINE_DESTINATION_MODE, env.LINE_USER_ID, env.LINE_GROUP_ID);
    } catch (error) {
      console.log(error instanceof Error ? error.message : "line_destination_invalid");
      return false;
    }
  }
  return true;
}

function applyRunDiagnostics(state: State, runId: string, observedAt: Date, slots: Record<string, SlotState>): void {
  clearLastDiagnostics(state);
  state.last_run_id = runId;
  state.observed_at_utc = observedAt.toISOString();
  state.observed_at_jst = nowJst(observedAt);
  const diagnostics = Object.values(slots).map((slot) => slot.diagnostic).filter(
    (diagnostic): diagnostic is SlotDiagnostic => Boolean(diagnostic),
  );
  state.last_attempt_count = diagnostics.reduce((total, diagnostic) => total + diagnostic.attempt_count, 0);
  const firstError = diagnostics.find((diagnostic) => diagnostic.error_class);
  const firstResponse = diagnostics.find((diagnostic) => diagnostic.http_status !== undefined);
  const representative = firstError ?? firstResponse;
  if (!representative) return;
  state.last_error_class = representative.error_class;
  state.last_error_name = representative.error_name;
  state.last_error_message = representative.error_message;
  state.last_http_status = representative.http_status;
  state.last_response_content_type = representative.response_content_type;
  state.last_response_excerpt_hash = representative.response_excerpt_hash;
  state.last_redirect_status = representative.redirect_status;
  state.last_redirect_location_present = representative.redirect_location_present;
  state.last_redirect_host = representative.redirect_host;
}

export async function runOnce(env: Env, at = new Date()): Promise<void> {
  if (at.getTime() >= CUTOFF_MS || !validateStartup(env)) return;
  const owner = crypto.randomUUID();
  let locked = false;
  const started = Date.now();
  const observedAt = new Date(at.getTime());
  const runId = crypto.randomUUID();
  try {
    try { locked = await acquireLease(env.DB, owner); }
    catch { console.log("lock_unavailable"); return; }
    if (!locked) { console.log("lock_busy"); return; }
    const record = await loadState(env.DB);
    const dryRun = env.DRY_RUN !== "false";
    const lineEnabled = env.LINE_ENABLED === "true";
    const targetUrl = env.TARGET_PAGE_URL!;
    const observationDue = at.getUTCMinutes() % 5 === 0;
    if (!observationDue) {
      if (!dryRun) {
        const changed = await deliverPending(env, record.state, lineEnabled, observedAt);
        if (changed) await saveState(env.DB, record.state, record.version, observedAt);
      }
      return;
    }
    const dryEvents: Pending[] = [];
    const observed = await Promise.all(SLOTS.map(async (slot) => {
      try { return [slot.key, await observeSlot(slot)] as const; }
      catch {
        return [slot.key, {
          label: slot.label,
          status: "UNKNOWN" as Status,
          reason: "ecwid_observation_failed",
          diagnostic: {
            attempt_count: 0,
            error_class: "unknown_exception" as DiagnosticClass,
            error_name: "ObservationError",
            error_message: "observation_failed",
          },
        }] as const;
      }
    }));
    const nextSlots = Object.fromEntries(observed);
    applyRunDiagnostics(record.state, runId, observedAt, nextSlots);
    const available = SLOTS.filter((slot) => nextSlots[slot.key].status === "AVAILABLE" && record.state.slots[slot.key]?.status !== "AVAILABLE");
    const allFailed = SLOTS.every((slot) => ["MISSING", "UNKNOWN"].includes(nextSlots[slot.key].status));
    const previousFailureCount = record.state.consecutive_total_failures;
    record.state.slots = nextSlots;
    record.state.consecutive_total_failures = allFailed ? previousFailureCount + 1 : 0;
    if (available.length) {
      enqueueAvailabilitySeries(
        record.state,
        available.map((slot) => slot.label).join(", "),
        observedAt,
        targetUrl,
        lineEnabled,
        dryRun,
        dryEvents,
      );
    }
    if (allFailed && record.state.consecutive_total_failures >= 3 && !record.state.outage_notified) {
      enqueueSingleNotification(record.state, "outage", buildOutageMessage(targetUrl), lineEnabled, dryRun, dryEvents); record.state.outage_notified = true;
    } else if (!allFailed && record.state.outage_notified) {
      enqueueSingleNotification(record.state, "recovered", buildRecoveredMessage(targetUrl), lineEnabled, dryRun, dryEvents); record.state.outage_notified = false;
    }
    if (dryRun) await recordDryRunEvents(env.DB, dryEvents, observedAt);
    else preparePendingForDelivery(record.state, lineEnabled);
    let version = await saveState(env.DB, record.state, record.version, observedAt);
    if (!dryRun) {
      const changed = await deliverPending(env, record.state, lineEnabled, observedAt);
      if (changed) version = await saveState(env.DB, record.state, version, observedAt);
    }
    console.log(JSON.stringify({ event: "watcher_metrics", dry_run: dryRun, duration_ms: Date.now() - started, version, statuses: SLOTS.map((slot) => record.state.slots[slot.key].status) }));
  } finally {
    if (locked) { try { await releaseLease(env.DB, owner); } catch { console.log("lock_release_failed"); } }
  }
}

export default {
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runOnce(env, new Date(event.scheduledTime)));
  },
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") {
      return new Response(JSON.stringify(lineDestinationStatus(env)), {
        status: 200,
        headers: { "content-type": "application/json; charset=utf-8" },
      });
    }
    return new Response("okaz-slot-watcher-cf", { status: 200 });
  },
};
