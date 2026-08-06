import { afterEach, describe, expect, it, vi } from "vitest";
import {
  acquireLease,
  buildAvailabilityMessage,
  buildAcceptanceAvailabilityMessage,
  buildOutageMessage,
  buildRecoveredMessage,
  classifyFetchError,
  observeSlot,
  runOnce,
  sanitizeDiagnosticText,
  saveState,
  SLOTS,
  statusFromResponse,
  validateTargetPageUrl,
  enqueueAcceptanceSeries,
  type State,
} from "../src/index";
import worker from "../src/index";

const jsonHeaders = { "content-type": "application/json" };
const TARGET_PAGE_URL = "https://shop.okaz-design.jp/store/%E8%8C%A8%E3%81%A8%E6%9E%9C%E5%AE%9F-p850942259";
const soldOut = () => new Response(JSON.stringify({ variationOverrides: { isSoldOut: true, quantity: 0, variationId: 1 } }), { status: 200, headers: jsonHeaders });
const available = () => new Response(JSON.stringify({ variationOverrides: { isSoldOut: false, quantity: 2, variationId: 2 } }), { status: 200, headers: jsonHeaders });

function testState(status: string, consecutive_total_failures = 0, outage_notified = false) {
  return {
    schema_version: 2,
    slots: Object.fromEntries(SLOTS.map((slot) => [slot.key, { label: slot.label, status }])),
    consecutive_total_failures,
    outage_notified,
    pending_notifications: [],
    updated_at_jst: "2026-08-03T20:00:00",
  };
}

function fakeRunDb(initialState: ReturnType<typeof testState>) {
  let storedState = JSON.parse(JSON.stringify(initialState)) as ReturnType<typeof testState>;
  let version = 0;
  const dryEvents: Array<{ kind: string; message: string }> = [];
  const db = {
    prepare(sql: string) {
      const statement = {
        async first() {
          if (sql.startsWith("SELECT state_json")) return { state_json: JSON.stringify(storedState), version };
          return null;
        },
        bind(...args: unknown[]) {
          return {
            async run() {
              if (sql.startsWith("INSERT OR IGNORE INTO dry_run_events")) {
                dryEvents.push({ kind: String(args[1]), message: String(args[2]) });
              }
              if (sql.startsWith("UPDATE watcher_state")) {
                storedState = JSON.parse(String(args[0]));
                version += 1;
              }
              return { meta: { changes: 1 } };
            },
          };
        },
      };
      return statement;
    },
    async batch(statements: Array<{ run: () => Promise<unknown> }>) {
      for (const statement of statements) await statement.run();
    },
  } as unknown as D1Database;
  return { db, getState: () => storedState, getVersion: () => version, dryEvents };
}

afterEach(() => vi.restoreAllMocks());

describe("API判定", () => {
  it("HTTP 200 / SOLD_OUTを判定する", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(soldOut());
    await expect(observeSlot(SLOTS[0])).resolves.toMatchObject({ status: "SOLD_OUT", quantity: 0, variationId: 1 });
  });

  it("HTTP 200 / AVAILABLEを判定する", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(available());
    await expect(observeSlot(SLOTS[0])).resolves.toMatchObject({ status: "AVAILABLE", quantity: 2, variationId: 2 });
  });

  it("必須フィールド欠落をUNKNOWNにする", () => {
    expect(statusFromResponse({ variationOverrides: {} })).toEqual({ status: "UNKNOWN" });
  });

  it("URL、Method、Body、manual redirectを維持する", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(soldOut());
    await observeSlot(SLOTS[0]);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://au-syd3-storefront-api.ecwid.com/storefront/api/v1/27747031/catalog/product/overrides");
    expect(init.method).toBe("POST");
    expect(init.redirect).toBe("manual");
    expect(JSON.parse(String(init.body))).toMatchObject({
      lang: "ja",
      productIdentifier: { type: "PUBLISHED", productId: 850942259 },
      selectedOptions: { "ご希望の日時": { type: "RADIO", choice: SLOTS[0].label } },
    });
  });
});

describe("診断分類と安全化", () => {
  it("TimeoutError / AbortError / TypeErrorを分類する", () => {
    expect(classifyFetchError(new DOMException("timeout", "TimeoutError")).errorClass).toBe("timeout");
    expect(classifyFetchError(new DOMException("aborted", "AbortError")).errorClass).toBe("abort");
    expect(classifyFetchError(new TypeError("network failure")).errorClass).toBe("network_exception");
  });

  it("改行、URL query、Bearer、tokenをマスクし128文字に切り詰める", () => {
    const text = sanitizeDiagnosticText("Bearer abc123 token=secret\r\nhttps://example.test/path?q=secret " + "x".repeat(300));
    expect(text).not.toContain("abc123");
    expect(text).not.toContain("secret");
    expect(sanitizeDiagnosticText('{"access_token":"hidden"}')).not.toContain("hidden");
    expect(text).not.toMatch(/[\r\n]/);
    expect(text.length).toBeLessThanOrEqual(128);
  });
});

describe("HTTP診断", () => {
  it("3xxを追跡せずstatusとhostだけ保存する", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("", {
      status: 302,
      headers: { location: "https://other.example.test/path?secret=value" },
    }));
    await expect(observeSlot(SLOTS[0])).resolves.toMatchObject({
      status: "UNKNOWN",
      reason: "ecwid_http_302",
      diagnostic: { error_class: "redirect_response", redirect_status: 302, redirect_location_present: true, redirect_host: "other.example.test", attempt_count: 1 },
    });
  });

  it("400の本文を保存せず安全なexcerptとhashだけ作る", async () => {
    const body = "authorization: Bearer hidden\n" + "x".repeat(400);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(body, { status: 400, headers: { "content-type": "text/plain" } }));
    const result = await observeSlot(SLOTS[0]);
    expect(result).toMatchObject({ status: "UNKNOWN", reason: "ecwid_http_400", diagnostic: { error_class: "http_error", http_status: 400 } });
    expect(result.diagnostic?.response_excerpt?.length).toBeLessThanOrEqual(128);
    expect(result.diagnostic?.response_excerpt).not.toContain("hidden");
    expect(result.diagnostic?.response_excerpt_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("Response Body読み取り例外をResponseReadErrorへ分類する", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { controller.error(new Error("body read failed")); },
    });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(stream, { status: 200, headers: jsonHeaders }));
    await expect(observeSlot(SLOTS[0])).resolves.toMatchObject({
      status: "UNKNOWN",
      reason: "ecwid_response_read_failed",
      diagnostic: { error_name: "ResponseReadError" },
    });
  });

  it("403をhttp_errorとして扱う", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("forbidden", { status: 403, headers: { "content-type": "text/plain" } }));
    await expect(observeSlot(SLOTS[0])).resolves.toMatchObject({ status: "UNKNOWN", reason: "ecwid_http_403", diagnostic: { error_class: "http_error", http_status: 403 } });
  });

  it("長大なレスポンス本文を64KiB以内に制限しexcerptを128文字以内にする", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("x".repeat(100_000), { status: 400, headers: { "content-type": "text/plain" } }));
    const result = await observeSlot(SLOTS[0]);
    expect(result.diagnostic?.response_excerpt?.length).toBeLessThanOrEqual(128);
    expect(result.diagnostic?.response_excerpt_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("不正Content-TypeはAVAILABLEにせずUNKNOWNにする", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ variationOverrides: { isSoldOut: false, quantity: 1 } }), { status: 200, headers: { "content-type": "text/html" } }));
    await expect(observeSlot(SLOTS[0])).resolves.toMatchObject({ status: "UNKNOWN", reason: "ecwid_invalid_content_type", diagnostic: { content_type_valid: false } });
  });

  it("不正JSONをjson_parse_errorへ分類する", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{not-json", { status: 200, headers: jsonHeaders }));
    await expect(observeSlot(SLOTS[0])).resolves.toMatchObject({ status: "UNKNOWN", reason: "ecwid_invalid_json", diagnostic: { error_class: "json_parse_error", error_name: "SyntaxError" } });
  });

  it("429 + Retry-Afterと502を含め最大3回で止める", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response("", { status: 429, headers: { "Retry-After": "0" } }))
      .mockResolvedValueOnce(new Response("", { status: 502 }))
      .mockResolvedValueOnce(soldOut());
    await expect(observeSlot(SLOTS[0])).resolves.toMatchObject({ status: "SOLD_OUT", diagnostic: { attempt_count: 3 } });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("連続502は1枠3回で打ち切る", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("bad", { status: 502 }));
    await expect(observeSlot(SLOTS[0])).resolves.toMatchObject({ status: "UNKNOWN", reason: "ecwid_http_502", diagnostic: { attempt_count: 3 } });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("4枠全体でも最大12リクエストに制限する", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("bad", { status: 503 }));
    const results = await Promise.all(SLOTS.map((slot) => observeSlot(slot)));
    expect(results).toHaveLength(4);
    expect(results.every((result) => result.diagnostic?.attempt_count === 3)).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(12);
  });

  it("TimeoutError、AbortError、TypeErrorは既存reasonを維持し診断だけ追加する", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new DOMException("timeout", "TimeoutError"));
    await expect(observeSlot(SLOTS[0])).resolves.toMatchObject({ status: "UNKNOWN", reason: "ecwid_timeout", diagnostic: { error_class: "timeout" } });
    fetchMock.mockRejectedValueOnce(new DOMException("aborted", "AbortError"));
    await expect(observeSlot(SLOTS[0])).resolves.toMatchObject({ status: "UNKNOWN", reason: "ecwid_request_failed", diagnostic: { error_class: "abort" } });
    fetchMock.mockRejectedValueOnce(new TypeError("connect failed"));
    await expect(observeSlot(SLOTS[0])).resolves.toMatchObject({ status: "UNKNOWN", reason: "ecwid_request_failed", diagnostic: { error_class: "network_exception" } });
  });
});

describe("D1 lease", () => {
  it("同時所有者の2回目取得を拒否する", async () => {
    let owner = "";
    const db = {
      prepare(sql: string) {
        return {
          bind(...args: unknown[]) {
            return {
              async run() {
                if (sql.startsWith("INSERT")) return { meta: { changes: owner ? 0 : 1 } };
                if (!owner || owner === args[0] || (args[2] as number) > Date.now()) {
                  if (!owner || owner === args[0]) { owner = String(args[0]); return { meta: { changes: 1 } }; }
                }
                return { meta: { changes: 0 } };
              },
            };
          },
        };
      },
    } as unknown as D1Database;
    await expect(acquireLease(db, "first")).resolves.toBe(true);
    await expect(acquireLease(db, "second")).resolves.toBe(false);
  });
});

describe("D1 CAS", () => {
  it("expectedVersion不一致ではstate_version_conflictとなり既存状態を上書きしない", async () => {
    const originalState = JSON.stringify({ schema_version: 2, slots: {}, pending_notifications: [] });
    let persisted = originalState;
    let persistedVersion = 8;
    const db = {
      prepare(sql: string) {
        return {
          bind(...args: unknown[]) {
            return {
              async run() {
                if (sql.startsWith("INSERT OR IGNORE")) return { meta: { changes: 0 } };
                if (sql.startsWith("UPDATE watcher_state")) {
                  return { meta: { changes: 0 } };
                }
                return { meta: { changes: 0 } };
              },
            };
          },
        };
      },
    } as unknown as D1Database;
    const nextState = { schema_version: 2 as const, slots: {}, consecutive_total_failures: 0, outage_notified: false, pending_notifications: [], updated_at_jst: "" };
    await expect(saveState(db, nextState, 7, new Date("2026-08-03T11:00:00.000Z"))).rejects.toThrow("state_version_conflict");
    expect(persisted).toBe(originalState);
    expect(persistedVersion).toBe(8);
  });
});

describe("公開商品ページURLと通知本文", () => {
  it.each([
    TARGET_PAGE_URL,
  ])("正しいURLを受理する: %s", (url) => {
    expect(validateTargetPageUrl(url)).toBe(true);
  });

  it.each([
    undefined,
    "",
    "http://shop.okaz-design.jp/store/product",
    "https://user:pass@shop.okaz-design.jp/store/product",
    "not-a-url",
    "https://au-syd3-storefront-api.ecwid.com/storefront/api/v1/27747031/catalog/product/overrides",
    "https://discord.com/api/webhooks/123/token",
    "https://api.line.me/v2/bot/message/push",
    "https://shop.okaz-design.jp/store/product?tracking=1",
  ])("不正な設定値を拒否する: %s", (url) => {
    expect(validateTargetPageUrl(url)).toBe(false);
  });

  it("5連通知と単発通知へ公開URLを各1回だけ追加する", () => {
    for (let sequence = 1; sequence <= 5; sequence += 1) {
      const message = buildAvailabilityMessage(sequence, 5, "対象枠", new Date("2026-08-04T11:05:00.000Z"), TARGET_PAGE_URL);
      expect(message.split(TARGET_PAGE_URL)).toHaveLength(2);
      expect(message).toContain("申込ページ:\n" + TARGET_PAGE_URL);
      expect(message).not.toContain("/catalog/product/overrides");
      expect(message).not.toContain("[申込ページ]");
    }
    for (const message of [buildOutageMessage(TARGET_PAGE_URL), buildRecoveredMessage(TARGET_PAGE_URL)]) {
      expect(message.split(TARGET_PAGE_URL)).toHaveLength(2);
    }
  });

  it("DiscordとLINEへ同一本文を渡せる形式を維持する", async () => {
    const message = buildAvailabilityMessage(1, 5, "対象枠", new Date("2026-08-04T11:05:00.000Z"), TARGET_PAGE_URL);
    const calls: Array<{ url: string; body: string }> = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      calls.push({ url: String(input), body: String(init?.body ?? "") });
      return String(input).startsWith("https://api.line.me")
        ? new Response("", { status: 200 })
        : new Response(JSON.stringify({ id: "message" }), { status: 200, headers: jsonHeaders });
    });
    const { sendDiscord, sendLine } = await import("../src/index");
    await sendDiscord("https://discord.invalid/webhook", message);
    await sendLine("11111111-1111-4111-8111-111111111111", "fixture-user", message, "11111111-1111-4111-8111-111111111112");
    expect(JSON.parse(calls[0].body).content).toBe(message);
    expect(JSON.parse(calls[1].body).messages[0].text).toBe(message);
  });
});

describe("DRY_RUNと状態診断", () => {
  it("DRY_RUNでは通知先へ送らず、状態へ診断を保存する", async () => {
    const state: {
      schema_version: number;
      slots: Record<string, { label: string; status: string; diagnostic?: unknown }>;
      consecutive_total_failures: number;
      outage_notified: boolean;
      pending_notifications: unknown[];
      updated_at_jst: string;
      last_run_id?: string;
      observed_at_utc?: string;
      observed_at_jst?: string;
      last_attempt_count?: number;
    } = {
      schema_version: 2,
      slots: Object.fromEntries(SLOTS.map((slot) => [slot.key, { label: slot.label, status: "UNKNOWN" }])),
      consecutive_total_failures: 0,
      outage_notified: false,
      pending_notifications: [],
      updated_at_jst: "2026-08-03T20:00:00",
    };
    let version = 0;
    const dryEvents: unknown[] = [];
    const db = {
      prepare(sql: string) {
        const statement = {
          async first() {
            if (sql.startsWith("SELECT state_json")) return { state_json: JSON.stringify(state), version };
            return null;
          },
          bind(...args: unknown[]) {
            return {
              async run() {
                if (sql.startsWith("INSERT OR IGNORE INTO watcher_lock")) return { meta: { changes: 1 } };
                if (sql.startsWith("UPDATE watcher_lock")) return { meta: { changes: 1 } };
                if (sql.startsWith("INSERT OR IGNORE INTO watcher_state")) return { meta: { changes: 1 } };
                if (sql.startsWith("UPDATE watcher_state")) { version += 1; Object.assign(state, JSON.parse(String(args[0]))); state.updated_at_jst = String(args[1]); return { meta: { changes: 1 } }; }
                if (sql.startsWith("INSERT OR IGNORE INTO dry_run_events")) { dryEvents.push(args); return { meta: { changes: 1 } }; }
                if (sql.startsWith("DELETE FROM dry_run_events")) return { meta: { changes: 0 } };
                return { meta: { changes: 1 } };
              },
            };
          },
        };
        return statement;
      },
      async batch(statements: unknown[]) { void statements; },
    } as unknown as D1Database;
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.startsWith("https://au-syd3")) return soldOut();
      throw new Error(`unexpected external notification: ${url}`);
    });
    await runOnce({ DB: db, DRY_RUN: "true", TARGET_PAGE_URL, DISCORD_WEBHOOK_URL: "https://discord.invalid", LINE_ENABLED: "true", LINE_CHANNEL_ACCESS_TOKEN: "not-used", LINE_USER_ID: "not-used" }, new Date("2026-08-03T11:00:00.000Z"));
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(dryEvents).toHaveLength(0);
    expect(state.slots[SLOTS[0].key].diagnostic).toMatchObject({ attempt_count: 1, http_status: 200 });
    expect(state.consecutive_total_failures).toBe(0);
    expect(state.last_run_id).toEqual(expect.any(String));
    expect(state.observed_at_utc).toBe("2026-08-03T11:00:00.000Z");
    expect(state.observed_at_jst).toBe("2026-08-03T20:00:00");
    expect(state.last_attempt_count).toBe(4);
    expect(version).toBe(1);
  });

  it("障害通知済み状態では次回全件失敗時にoutageを重複生成しない", async () => {
    const fake = fakeRunDb(testState("UNKNOWN", 3, true));
    const fetchMock = vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("network"));
    await runOnce({ DB: fake.db, DRY_RUN: "true", TARGET_PAGE_URL }, new Date("2026-08-03T11:00:00.000Z"));
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(fake.dryEvents).toEqual([]);
    expect(fake.getState().outage_notified).toBe(true);
  });

  it.each([
    ["outage", testState("UNKNOWN", 2, false), () => new Response("", { status: 503 })],
    ["recovered", testState("UNKNOWN", 4, true), soldOut],
    ["available", testState("SOLD_OUT", 0, false), available],
  ] as const)("DRY_RUN=trueでは%sイベントでもDiscord/LINEへ送信しない", async (kind, initialState, responseFactory) => {
    const fake = fakeRunDb(initialState);
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (!url.startsWith("https://au-syd3")) throw new Error("notification_fetch_must_not_run");
      return responseFactory();
    });
    await runOnce({
      DB: fake.db,
      DRY_RUN: "true",
      TARGET_PAGE_URL,
      DISCORD_WEBHOOK_URL: "configured-but-not-used",
      LINE_ENABLED: "true",
      LINE_CHANNEL_ACCESS_TOKEN: "configured-but-not-used",
      LINE_USER_ID: "configured-but-not-used",
    }, new Date("2026-08-03T11:00:00.000Z"));
    expect(fetchMock.mock.calls.every(([input]) => String(input).startsWith("https://au-syd3"))).toBe(true);
    expect(fake.dryEvents.map((event) => event.kind)).toContain(kind);
  });
});

describe("LINE_ENABLED契約", () => {
  it("LINE_ENABLED=trueかつDRY_RUN=falseでline=falseをpendingへ追加し、LINE失敗だけ再試行する", async () => {
    const fake = fakeRunDb(testState("SOLD_OUT"));
    let discordCalls = 0;
    let lineCalls = 0;
    let versionAtFirstLineAttempt = -1;
    let firstLineRetryKey = "";
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.startsWith("https://au-syd3")) return available();
      if (url.startsWith("https://discord")) { discordCalls += 1; return new Response(null, { status: 204 }); }
      if (url.startsWith("https://api.line.me")) {
        lineCalls += 1;
        if (lineCalls === 1) {
          versionAtFirstLineAttempt = fake.getVersion();
          firstLineRetryKey = new Headers(fetchMock.mock.calls.at(-1)?.[1]?.headers).get("x-line-retry-key") ?? "";
        }
        throw new Error("line unavailable");
      }
      throw new Error("unexpected_external_fetch");
    });
    const env = {
      DB: fake.db,
      DRY_RUN: "false",
      TARGET_PAGE_URL,
      LINE_ENABLED: "true",
      DISCORD_WEBHOOK_URL: "https://discord.invalid/webhook",
      LINE_CHANNEL_ACCESS_TOKEN: "configured-but-not-used-in-tests",
      LINE_USER_ID: "configured-but-not-used-in-tests",
    };
    await runOnce(env, new Date("2026-08-03T11:00:00.000Z"));
    expect(fake.getState().pending_notifications).toHaveLength(5);
    expect(fake.getState().pending_notifications[0]).toMatchObject({ channels: { discord: true, line: false }, repeat: { sequence: 1, total: 5 } });
    await runOnce(env, new Date("2026-08-03T11:05:00.000Z"));
    expect(discordCalls).toBe(1);
    expect(lineCalls).toBe(2);
    expect(versionAtFirstLineAttempt).toBe(1);
    expect(firstLineRetryKey).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    const persistedPending = fake.getState().pending_notifications as Array<{ line_retry_key?: string }>;
    expect(persistedPending[0].line_retry_key).toBe(firstLineRetryKey);
    expect(fetchMock.mock.calls.filter(([input]) => String(input).startsWith("https://au-syd3"))).toHaveLength(8);
  });

  it("Discord成功／LINE成功時はpendingから削除する", async () => {
    const fake = fakeRunDb(testState("SOLD_OUT"));
    let discordCalls = 0;
    let lineCalls = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.startsWith("https://au-syd3")) return available();
      if (url.startsWith("https://discord")) { discordCalls += 1; return new Response(null, { status: 204 }); }
      if (url.startsWith("https://api.line.me")) { lineCalls += 1; return new Response("", { status: 200 }); }
      throw new Error("unexpected_external_fetch");
    });
    const env = { DB: fake.db, DRY_RUN: "false", TARGET_PAGE_URL, LINE_ENABLED: "true", DISCORD_WEBHOOK_URL: "https://discord.invalid/webhook", LINE_CHANNEL_ACCESS_TOKEN: "configured-but-not-used-in-tests", LINE_USER_ID: "configured-but-not-used-in-tests" };
    await runOnce(env, new Date("2026-08-03T11:00:00.000Z"));
    await runOnce(env, new Date("2026-08-03T11:01:00.000Z"));
    await runOnce(env, new Date("2026-08-03T11:02:00.000Z"));
    await runOnce(env, new Date("2026-08-03T11:03:00.000Z"));
    await runOnce(env, new Date("2026-08-03T11:04:00.000Z"));
    expect(fake.getState().pending_notifications).toEqual([]);
    expect(discordCalls).toBe(5);
    expect(lineCalls).toBe(5);
  });

  it("LINE_ENABLED未設定またはfalseではLINEへ送信しない", async () => {
    for (const lineEnabled of [undefined, "false"]) {
      const fake = fakeRunDb(testState("SOLD_OUT"));
      (fake.getState().pending_notifications as Array<{ id: string; kind: string; message: string; channels: { discord: boolean; line: boolean } }>).push({ id: "pending-1", kind: "available", message: "test", channels: { discord: true, line: false } });
      let lineCalls = 0;
      vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
        const url = String(input);
        if (url.startsWith("https://au-syd3")) return soldOut();
        if (url.startsWith("https://api.line.me")) { lineCalls += 1; return new Response("", { status: 200 }); }
        throw new Error("unexpected_external_fetch");
      });
      await runOnce({ DB: fake.db, DRY_RUN: "false", TARGET_PAGE_URL, LINE_ENABLED: lineEnabled, LINE_CHANNEL_ACCESS_TOKEN: "configured-but-not-used-in-tests", LINE_USER_ID: "configured-but-not-used-in-tests" }, new Date("2026-08-03T11:00:00.000Z"));
      expect(lineCalls).toBe(0);
      vi.restoreAllMocks();
    }
  });

  it("LINE_ENABLED=trueでSecret不足の場合は監視処理を開始しない", async () => {
    const fake = fakeRunDb(testState("SOLD_OUT"));
    const fetchMock = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("must_not_fetch"));
    await runOnce({ DB: fake.db, DRY_RUN: "false", TARGET_PAGE_URL, LINE_ENABLED: "true" }, new Date("2026-08-03T11:00:00.000Z"));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(fake.getVersion()).toBe(0);
  });
});

describe("隔離Acceptance Harness", () => {
  function acceptanceDb() {
    const canonical = testState("SOLD_OUT");
    let canonicalVersion = 12;
    let lockOwner = "";
    const acceptances = new Map<string, { state_json: string; version: number; active: number }>();
    const db = {
      prepare(sql: string) {
        return {
          async first() {
            if (sql.startsWith("SELECT state_json")) return { state_json: JSON.stringify(canonical), version: canonicalVersion };
            if (sql.startsWith("SELECT test_id, state_json")) {
              const testId = String((this as unknown as { args?: unknown[] }).args?.[0] ?? "");
              const row = acceptances.get(testId);
              return row && row.active === 1 ? { test_id: testId, state_json: row.state_json, version: row.version } : null;
            }
            return null;
          },
          async all() {
            return {
              results: [...acceptances.entries()]
                .filter(([, row]) => row.active === 1)
                .map(([test_id, row]) => ({ test_id, state_json: row.state_json, version: row.version })),
            };
          },
          bind(...args: unknown[]) {
            return {
              async first() {
                if (sql.startsWith("SELECT test_id, state_json")) {
                  const testId = String(args[0]);
                  const row = acceptances.get(testId);
                  return row && row.active === 1 ? { test_id: testId, state_json: row.state_json, version: row.version } : null;
                }
                return null;
              },
              async run() {
                if (sql.startsWith("INSERT OR IGNORE INTO watcher_lock")) return { meta: { changes: lockOwner ? 0 : (lockOwner = String(args[0]), 1) } };
                if (sql.startsWith("UPDATE watcher_lock SET owner")) return { meta: { changes: lockOwner === String(args[3]) || !lockOwner ? (lockOwner = String(args[0]), 1) : 0 } };
                if (sql.startsWith("UPDATE watcher_lock SET lease_until_ms = 0")) { lockOwner = ""; return { meta: { changes: 1 } }; }
                if (sql.startsWith("INSERT INTO acceptance_state")) {
                  const testId = String(args[0]);
                  if (acceptances.has(testId)) return { meta: { changes: 0 } };
                  acceptances.set(testId, { state_json: String(args[1]), version: 0, active: 1 });
                  return { meta: { changes: 1 } };
                }
                if (sql.startsWith("UPDATE acceptance_state")) {
                  const testId = String(args[2]);
                  const row = acceptances.get(testId);
                  if (!row || row.version !== Number(args[3])) return { meta: { changes: 0 } };
                  row.state_json = String(args[0]);
                  row.version += 1;
                  return { meta: { changes: 1 } };
                }
                return { meta: { changes: 0 } };
              },
            };
          },
        };
      },
    } as unknown as D1Database;
    return { db, canonical, getCanonicalVersion: () => canonicalVersion, acceptances };
  }

  it("同じ5連生成器でURL/Test ID付き通知を隔離状態へ作成できる", () => {
    const state = testState("SOLD_OUT") as State;
    const testId = "CF-CUJ-20260806-isolation";
    const seriesId = enqueueAcceptanceSeries(state, testId, new Date("2026-08-06T11:00:00.000Z"), TARGET_PAGE_URL, true);
    expect(seriesId).toEqual(expect.any(String));
    expect(state.pending_notifications).toHaveLength(5);
    expect(state.pending_notifications.every((item) => item.test_id === testId)).toBe(true);
    expect(state.pending_notifications.every((item) => item.message.includes("本番想定テスト") && item.message.includes(TARGET_PAGE_URL))).toBe(true);
    expect(state.pending_notifications.map((item) => item.repeat?.sequence)).toEqual([1, 2, 3, 4, 5]);
    expect(new Set(state.pending_notifications.map((item) => item.line_retry_key)).size).toBe(5);
  });

  it("start/observeはcanonical watcher_stateを変更せずacceptance_stateだけを作る", async () => {
    const fake = acceptanceDb();
    const env = {
      DB: fake.db,
      DRY_RUN: "false",
      LINE_ENABLED: "true",
      TARGET_PAGE_URL,
      ACCEPTANCE_HARNESS_ENABLED: "true",
      ACCEPTANCE_HARNESS_TOKEN: "harness-token",
    };
    const testId = "CF-CUJ-20260806-endpoint";
    const headers = { authorization: "Bearer harness-token", "content-type": "application/json" };
    const start = await worker.fetch(new Request("https://worker.test/__acceptance/start", { method: "POST", headers, body: JSON.stringify({ test_id: testId }) }), env);
    expect(start.status).toBe(201);
    const observe = await worker.fetch(new Request("https://worker.test/__acceptance/observe", { method: "POST", headers, body: JSON.stringify({ test_id: testId, status: "AVAILABLE", slot_label: "Acceptance Test Slot" }) }), env);
    expect(observe.status).toBe(200);
    expect(JSON.parse(fake.acceptances.get(testId)!.state_json).pending_notifications).toHaveLength(5);
    expect(fake.getCanonicalVersion()).toBe(12);
    expect(fake.canonical.pending_notifications).toEqual([]);
    const row = fake.acceptances.get(testId);
    expect(row).toBeDefined();
    expect(JSON.parse(row!.state_json).pending_notifications).toHaveLength(5);
  });

  it("通常cronの配送器だけでAcceptance pendingを1 Round処理する", async () => {
    const fake = acceptanceDb();
    const env = {
      DB: fake.db,
      DRY_RUN: "false",
      LINE_ENABLED: "true",
      TARGET_PAGE_URL,
      DISCORD_WEBHOOK_URL: "https://discord.invalid/webhook",
      LINE_CHANNEL_ACCESS_TOKEN: "configured-token",
      LINE_GROUP_ID: "configured-group",
      LINE_DESTINATION_MODE: "group",
      ACCEPTANCE_HARNESS_ENABLED: "true",
      ACCEPTANCE_HARNESS_TOKEN: "harness-token",
    };
    const testId = "CF-CUJ-20260806-delivery";
    const headers = { authorization: "Bearer harness-token", "content-type": "application/json" };
    const start = await worker.fetch(new Request("https://worker.test/__acceptance/start", { method: "POST", headers, body: JSON.stringify({ test_id: testId }) }), env);
    expect(start.status).toBe(201);
    const observe = await worker.fetch(new Request("https://worker.test/__acceptance/observe", { method: "POST", headers, body: JSON.stringify({ test_id: testId, status: "AVAILABLE", slot_label: "Acceptance Test Slot" }) }), env);
    expect(observe.status).toBe(200);
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      if (String(input).startsWith("https://api.line.me")) return new Response("", { status: 200 });
      if (String(input).startsWith("https://discord")) return new Response(null, { status: 204 });
      throw new Error("unexpected_external_fetch");
    });
    const now = new Date();
    const scheduledAt = now.getUTCMinutes() % 5 === 0 ? new Date(now.getTime() + 60_000) : now;
    await runOnce(env, scheduledAt);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fake.getCanonicalVersion()).toBe(12);
    expect(JSON.parse(fake.acceptances.get(testId)!.state_json).pending_notifications).toHaveLength(4);
  });

  it("ハーネス無効時はAcceptance endpointを公開しない", async () => {
    const fake = acceptanceDb();
    const response = await worker.fetch(new Request("https://worker.test/__acceptance/start", { method: "POST" }), { DB: fake.db, ACCEPTANCE_HARNESS_ENABLED: "false" });
    expect(response.status).toBe(404);
  });
});
