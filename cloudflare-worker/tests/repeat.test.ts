import { afterEach, describe, expect, it, vi } from "vitest";

import {
  deliverPending,
  enqueueAvailabilitySeries,
  isUuid,
  runOnce,
  SLOTS,
  type Pending,
  type State,
} from "../src/index";

const T0 = new Date("2026-08-04T11:05:00.000Z");
const TARGET_PAGE_URL = "https://shop.okaz-design.jp/store/%E8%8C%A8%E3%81%A8%E6%9E%9C%E5%AE%9F-p850942259";
const jsonHeaders = { "content-type": "application/json" };
const available = () => new Response(JSON.stringify({ variationOverrides: { isSoldOut: false, quantity: 2, variationId: 2 } }), { status: 200, headers: jsonHeaders });
const soldOut = () => new Response(JSON.stringify({ variationOverrides: { isSoldOut: true, quantity: 0, variationId: 1 } }), { status: 200, headers: jsonHeaders });

function stateWithSlots(status = "SOLD_OUT"): State {
  return {
    schema_version: 2,
    slots: Object.fromEntries(SLOTS.map((slot) => [slot.key, { label: slot.label, status: status as "SOLD_OUT" }])),
    consecutive_total_failures: 0,
    outage_notified: false,
    pending_notifications: [],
    updated_at_jst: "2026-08-04T20:00:00",
  };
}

function fakeDb(initialState: State) {
  let storedState = JSON.parse(JSON.stringify(initialState)) as State;
  let version = 0;
  const dryEvents: Pending[] = [];
  const db = {
    prepare(sql: string) {
      return {
        async first() {
          if (sql.startsWith("SELECT state_json")) return { state_json: JSON.stringify(storedState), version };
          return null;
        },
        bind(...args: unknown[]) {
          return {
            async run() {
              if (sql.startsWith("INSERT OR IGNORE INTO dry_run_events")) {
                dryEvents.push({ id: String(args[0]), kind: String(args[1]), message: String(args[2]), channels: { discord: false } });
              }
              if (sql.startsWith("UPDATE watcher_state")) {
                storedState = JSON.parse(String(args[0])) as State;
                version += 1;
              }
              return { meta: { changes: 1 } };
            },
          };
        },
      };
    },
    async batch(statements: Array<{ run: () => Promise<unknown> }>) {
      for (const statement of statements) await statement.run();
    },
  } as unknown as D1Database;
  return { db, getState: () => storedState, getVersion: () => version, dryEvents };
}

function notificationEnv(db: D1Database) {
  return {
    DB: db,
    DRY_RUN: "false",
    DYNAMIC_DISCOVERY: "false",
    LINE_ENABLED: "true",
    TARGET_PAGE_URL,
    DISCORD_WEBHOOK_URL: "https://discord.invalid/webhook",
    LINE_CHANNEL_ACCESS_TOKEN: "fixture-token",
    LINE_USER_ID: "fixture-user",
  };
}

afterEach(() => vi.restoreAllMocks());

describe("availability five-shot series", () => {
  it("生成時に5件、共通series、1分間隔、別IDと別Retry-Keyを保存する", () => {
    const state = stateWithSlots();
    const events: Pending[] = [];
    enqueueAvailabilitySeries(state, SLOTS[0].label, T0, TARGET_PAGE_URL, true, false, events);
    expect(state.pending_notifications).toHaveLength(5);
    const items = state.pending_notifications;
    const seriesIds = new Set(items.map((item) => item.repeat?.series_id));
    expect(seriesIds.size).toBe(1);
    expect(items.map((item) => item.repeat?.sequence)).toEqual([1, 2, 3, 4, 5]);
    expect(items.every((item) => item.repeat?.total === 5)).toBe(true);
    expect(items.map((item) => item.repeat?.not_before_utc)).toEqual([
      "2026-08-04T11:05:00.000Z",
      "2026-08-04T11:06:00.000Z",
      "2026-08-04T11:07:00.000Z",
      "2026-08-04T11:08:00.000Z",
      "2026-08-04T11:09:00.000Z",
    ]);
    expect(new Set(items.map((item) => item.id)).size).toBe(5);
    const retryKeys = items.map((item) => item.line_retry_key);
    expect(retryKeys.every((key) => isUuid(key))).toBe(true);
    expect(new Set(retryKeys).size).toBe(5);
    expect(items.every((item) => item.delivery?.line?.retry_key === item.line_retry_key)).toBe(true);
    expect(items[0].message).toContain("空き枠復活 1/5");
    expect(items[4].message).toContain("空き枠復活 最終通知 5/5");
  });

  it("DRY_RUNでは5件の予定だけを証跡化しProduction pendingへ追加しない", async () => {
    const fake = fakeDb(stateWithSlots());
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(available());
    await runOnce({ DB: fake.db, DRY_RUN: "true", DYNAMIC_DISCOVERY: "false", TARGET_PAGE_URL, LINE_ENABLED: "true", LINE_CHANNEL_ACCESS_TOKEN: "fixture", LINE_USER_ID: "fixture" }, T0);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(fake.getState().pending_notifications).toEqual([]);
    expect(fake.dryEvents).toHaveLength(5);
    expect(fake.dryEvents.every((event) => event.kind === "available")).toBe(true);
  });

  it("T0から1分ごとに1 Roundだけ配送し、6回目を送らない", async () => {
    const state = stateWithSlots();
    enqueueAvailabilitySeries(state, SLOTS[0].label, T0, TARGET_PAGE_URL, true, false, []);
    let discordCalls = 0;
    let lineCalls = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      if (String(input).startsWith("https://api.line.me")) { lineCalls += 1; return new Response("", { status: 200 }); }
      discordCalls += 1;
      return new Response(JSON.stringify({ id: `message-${discordCalls}` }), { status: 200, headers: jsonHeaders });
    });
    for (let minute = 0; minute < 5; minute += 1) {
      await deliverPending(notificationEnv({} as D1Database), state, true, new Date(T0.getTime() + minute * 60_000));
      expect(state.pending_notifications.length).toBe(4 - minute);
      expect(discordCalls).toBe(minute + 1);
      expect(lineCalls).toBe(minute + 1);
    }
    await deliverPending(notificationEnv({} as D1Database), state, true, new Date(T0.getTime() + 5 * 60_000));
    expect(state.pending_notifications).toEqual([]);
    expect(discordCalls).toBe(5);
    expect(lineCalls).toBe(5);
  });

  it("未来Roundは送らず、遅延時も同一Seriesの最小sequenceだけ送る", async () => {
    const state = stateWithSlots();
    enqueueAvailabilitySeries(state, SLOTS[0].label, T0, TARGET_PAGE_URL, true, false, []);
    let calls = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      calls += 1;
      if (String(input).startsWith("https://api.line.me")) return new Response("", { status: 200 });
      return new Response(JSON.stringify({ id: `message-${calls}` }), { status: 200, headers: jsonHeaders });
    });
    await deliverPending(notificationEnv({} as D1Database), state, true, T0);
    expect(calls).toBe(2);
    await deliverPending(notificationEnv({} as D1Database), state, true, new Date(T0.getTime() + 59_000));
    expect(calls).toBe(2);
    await deliverPending(notificationEnv({} as D1Database), state, true, new Date(T0.getTime() + 5 * 60_000));
    expect(calls).toBe(4);
    expect(state.pending_notifications.map((item) => item.repeat?.sequence)).toEqual([3, 4, 5]);
  });

  it("配送失敗の再試行は同じRound・同じRetry-Keyで、次Roundと分離する", async () => {
    const state = stateWithSlots();
    enqueueAvailabilitySeries(state, SLOTS[0].label, T0, TARGET_PAGE_URL, true, false, []);
    const retryKeys: string[] = [];
    let lineCalls = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      if (String(input).startsWith("https://api.line.me")) {
        lineCalls += 1;
        retryKeys.push(new Headers(init?.headers).get("x-line-retry-key") ?? "");
        return new Response("retry", { status: 500 });
      }
      return new Response(JSON.stringify({ id: "message" }), { status: 200, headers: jsonHeaders });
    });
    await deliverPending(notificationEnv({} as D1Database), state, true, T0);
    await deliverPending(notificationEnv({} as D1Database), state, true, new Date(T0.getTime() + 60_000));
    expect(lineCalls).toBe(2);
    expect(retryKeys[1]).toBe(retryKeys[0]);
    expect(state.pending_notifications[0].repeat?.sequence).toBe(1);
    expect(state.pending_notifications[0].delivery?.line?.attempt_count).toBe(2);
    expect(state.pending_notifications[0].delivery?.line?.permanent_failure).toBe(false);
  });

  it("5分観測と毎分配送を分離し、5分目の観測でも新Seriesを作らない", async () => {
    const fake = fakeDb(stateWithSlots());
    let ecwidCalls = 0;
    let discordCalls = 0;
    let lineCalls = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.startsWith("https://au-syd3")) { ecwidCalls += 1; return available(); }
      if (url.startsWith("https://api.line.me")) { lineCalls += 1; return new Response("", { status: 200 }); }
      discordCalls += 1;
      return new Response(JSON.stringify({ id: `message-${discordCalls}` }), { status: 200, headers: jsonHeaders });
    });
    const env = notificationEnv(fake.db);
    await runOnce(env, T0);
    await runOnce(env, new Date(T0.getTime() + 60_000));
    await runOnce(env, new Date(T0.getTime() + 2 * 60_000));
    await runOnce(env, new Date(T0.getTime() + 3 * 60_000));
    await runOnce(env, new Date(T0.getTime() + 4 * 60_000));
    expect(ecwidCalls).toBe(4);
    expect(discordCalls).toBe(5);
    expect(lineCalls).toBe(5);
    expect(fake.getState().pending_notifications).toEqual([]);
    await runOnce(env, new Date(T0.getTime() + 5 * 60_000));
    expect(ecwidCalls).toBe(8);
    expect(discordCalls).toBe(5);
    expect(lineCalls).toBe(5);
  });

  it("AVAILABLE継続では新Seriesを作らず、SOLD_OUT後の復活で新Seriesを作る", async () => {
    const fake = fakeDb(stateWithSlots());
    let phase: "available" | "sold_out" = "available";
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      if (String(input).startsWith("https://au-syd3")) return phase === "available" ? available() : soldOut();
      return new Response(JSON.stringify({ id: "message" }), { status: 200, headers: jsonHeaders });
    });
    const env = { ...notificationEnv(fake.db), DRY_RUN: "true" };
    await runOnce(env, T0);
    expect(fake.dryEvents).toHaveLength(5);
    await runOnce(env, new Date(T0.getTime() + 5 * 60_000));
    expect(fake.dryEvents).toHaveLength(5);
    phase = "sold_out";
    await runOnce(env, new Date(T0.getTime() + 10 * 60_000));
    phase = "available";
    await runOnce(env, new Date(T0.getTime() + 15 * 60_000));
    expect(fake.dryEvents).toHaveLength(10);
    expect(new Set(fake.dryEvents.map((event) => event.id)).size).toBe(10);
  });

  it("初回UNKNOWNからAVAILABLEへ戻った場合も新Seriesを作る", async () => {
    const fake = fakeDb(stateWithSlots("UNKNOWN"));
    vi.spyOn(globalThis, "fetch").mockResolvedValue(available());
    await runOnce({ ...notificationEnv(fake.db), DRY_RUN: "true" }, T0);
    expect(fake.dryEvents).toHaveLength(5);
    expect(fake.dryEvents.map((event) => event.message.match(/(?:1|2|3|4|5)\/5/)?.[0])).toEqual([
      "1/5", "2/5", "3/5", "4/5", "5/5",
    ]);
  });

  it("配送対象も変更もない毎分Invocationではversionを増やさない", async () => {
    const fake = fakeDb(stateWithSlots());
    const fetchMock = vi.spyOn(globalThis, "fetch");
    await runOnce(notificationEnv(fake.db), new Date(T0.getTime() + 60_000));
    expect(fake.getVersion()).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("cutoff以降は観測も配送も行わない", async () => {
    const fake = fakeDb(stateWithSlots());
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(available());
    await runOnce({ DB: fake.db, DRY_RUN: "false", DYNAMIC_DISCOVERY: "false", TARGET_PAGE_URL, LINE_ENABLED: "true" }, new Date("2026-08-23T07:30:00.000Z"));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(fake.getVersion()).toBe(0);
  });
});
