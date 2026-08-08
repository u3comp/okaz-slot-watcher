import { afterEach, describe, expect, it, vi } from "vitest";
import {
  discoverSlotsFromHtml,
  discoverSlotsFromProductPayload,
  runOnce,
  stableSlotKey,
  type State,
} from "../src/index";

const TARGET_PAGE_URL = "https://shop.okaz-design.jp/store/%E8%8C%A8%E3%81%A8%E6%9E%9C%E5%AE%9F-p850942259";
const labels4 = [
  "8/22（土）10:30-12:30",
  "8/22（土）14:00-16:00",
  "8/23（日）10:30-12:30",
  "8/23（日）14:00-16:00",
];
const label5 = "8/22（土）17:00-19:00";
const htmlFor = (labels: string[]) => new Response(
  labels.map((label) => `<input type="radio" name="ご希望の日時" value="${label}">`).join(""),
  { status: 200, headers: { "content-type": "text/html; charset=UTF-8" } },
);
const soldOut = () => new Response(
  JSON.stringify({ variationOverrides: { isSoldOut: true, quantity: 0, variationId: 1 } }),
  { status: 200, headers: { "content-type": "application/json" } },
);
const available = () => new Response(
  JSON.stringify({ variationOverrides: { isSoldOut: false, quantity: 2, variationId: 2 } }),
  { status: 200, headers: { "content-type": "application/json" } },
);
const productPayload = (labels: string[]) => new Response(
  JSON.stringify({ defaultOptionsOverrides: { pricesOverrides: { optionsChoicesWithModifiersAndTaxes: [
    { optionId: "ご希望の日時", choices: labels.map((choiceName) => ({ type: "SELECT", choiceId: choiceName, choiceName })) },
  ] } } }),
  { status: 200, headers: { "content-type": "application/json" } },
);

function initialState(labels = labels4): State {
  return {
    schema_version: 2,
    slots: Object.fromEntries(labels.map((label) => {
      const key = stableSlotKey(label, new Date("2026-08-08T00:00:00Z"))!;
      return [key, { label, status: "SOLD_OUT" as const, active: true, missing_observation_count: 0 }];
    })),
    consecutive_total_failures: 0,
    outage_notified: false,
    pending_notifications: [],
    updated_at_jst: "2026-08-08T20:00:00",
    opportunity_events: {},
  };
}

function fakeDb(state: State) {
  let stored = structuredClone(state);
  let version = 0;
  const dryEvents: Array<{ id: string; kind: string; message: string }> = [];
  const db = {
    prepare(sql: string) {
      const statement = {
        async first() {
          if (sql.startsWith("SELECT state_json")) return { state_json: JSON.stringify(stored), version };
          return null;
        },
        bind(...args: unknown[]) {
          return {
            async run() {
              if (sql.startsWith("UPDATE watcher_state")) {
                stored = JSON.parse(String(args[0]));
                version += 1;
              }
              if (sql.startsWith("INSERT OR IGNORE INTO dry_run_events")) {
                dryEvents.push({ id: String(args[0]), kind: String(args[1]), message: String(args[2]) });
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
  return { db, getState: () => stored, dryEvents };
}

afterEach(() => vi.restoreAllMocks());

describe("dynamic slot discovery and stable identity", () => {
  it.each([4, 5, 6])("parses %i slots without positional identity", (count) => {
    const labels = [...labels4, label5, "8/23（日）17:00-19:00"].slice(0, count);
    const result = discoverSlotsFromHtml(labels.map((label) => `<input name="ご希望の日時" value="${label}">`).join(""), new Date("2026-08-08T00:00:00Z"));
    expect(result.anomaly).toBeUndefined();
    expect(result.slots).toHaveLength(count);
    expect(new Set(result.slots.map((slot) => slot.key)).size).toBe(count);
  });

  it("is reorder tolerant and normalizes whitespace", () => {
    const result = discoverSlotsFromHtml(
      `<input name="ご希望の日時" value="8/22（土）  17:00〜19:00"><input name="ご希望の日時" value="8/22（土）10:30-12:30">`,
      new Date("2026-08-08T00:00:00Z"),
    );
    expect(result.slots.map((slot) => slot.key)).toEqual([
      "2026-08-22_1700",
      "2026-08-22_1030",
    ]);
  });

  it("discovers choices from the storefront product payload", () => {
    const result = discoverSlotsFromProductPayload({
      defaultOptionsOverrides: { pricesOverrides: { optionsChoicesWithModifiersAndTaxes: [
        { optionId: "ご希望の日時", choices: [{ choiceName: labels4[0] }, { choiceName: label5 }] },
      ] } },
    }, new Date("2026-08-08T00:00:00Z"));
    expect(result.anomaly).toBeUndefined();
    expect(result.slots.map((slot) => slot.key)).toEqual(["2026-08-22_1030", "2026-08-22_1700"]);
  });

  it("fails closed on duplicate, unknown, and zero-slot input", () => {
    expect(discoverSlotsFromHtml(`<input name="ご希望の日時" value="${labels4[0]}"><input name="ご希望の日時" value="${labels4[0]}">`).anomaly).toBe("duplicate_slot");
    expect(discoverSlotsFromHtml(`<input name="ご希望の日時" value="unknown">`).anomaly).toBe("unparseable_slot");
    expect(discoverSlotsFromHtml("<div>no options</div>").anomaly).toBe("container_missing");
  });
});
describe("4 to 5 opportunity surface integration", () => {
  it("persists a SOLD_OUT added slot and emits NEW_SLOT once", async () => {
    const fake = fakeDb(initialState());
    let pageLabels = [...labels4, label5];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      if (String(input).includes("catalog/product") && !String(input).includes("overrides")) return productPayload(pageLabels);
      if (String(input).includes("catalog/product/overrides")) return soldOut();
      throw new Error("unexpected_external_fetch");
    });
    const env = { DB: fake.db, DRY_RUN: "true", TARGET_PAGE_URL, LINE_ENABLED: "true", LINE_CHANNEL_ACCESS_TOKEN: "fixture", LINE_USER_ID: "fixture" };
    await runOnce(env, new Date("2026-08-08T15:00:00Z"));
    expect(Object.keys(fake.getState().slots)).toHaveLength(5);
    expect(fake.dryEvents.filter((event) => event.kind === "new_slot")).toHaveLength(1);
    expect(fake.dryEvents[0].message).toContain("8/22（土）17:00-19:00");
    pageLabels = [...labels4, label5];
    await runOnce(env, new Date("2026-08-08T15:05:00Z"));
    expect(fake.dryEvents.filter((event) => event.kind === "new_slot")).toHaveLength(1);
  });

  it("coalesces a new AVAILABLE slot into one five-round series", async () => {
    const fake = fakeDb(initialState());
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      if (String(input).includes("catalog/product") && !String(input).includes("overrides")) return productPayload([...labels4, label5]);
      if (String(input).includes("catalog/product/overrides")) {
        const body = JSON.parse(String(init?.body)) as { selectedOptions?: Record<string, { choice?: string }> };
        return body.selectedOptions?.["ご希望の日時"]?.choice === label5 ? available() : soldOut();
      }
      throw new Error("unexpected_external_fetch");
    });
    await runOnce({ DB: fake.db, DRY_RUN: "true", TARGET_PAGE_URL, LINE_ENABLED: "true", LINE_CHANNEL_ACCESS_TOKEN: "fixture", LINE_USER_ID: "fixture" }, new Date("2026-08-08T15:00:00Z"));
    expect(fake.dryEvents.filter((event) => event.kind === "new_slot")).toHaveLength(0);
    expect(fake.dryEvents.filter((event) => event.kind === "available")).toHaveLength(5);
    expect(fake.dryEvents[0].message).toContain("新しく追加された枠です");
  });

  it("confirms removal only after two observations and preserves the record", async () => {
    const fake = fakeDb(initialState([...labels4, label5]));
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      if (String(input).includes("catalog/product") && !String(input).includes("overrides")) return productPayload(labels4);
      if (String(input).includes("catalog/product/overrides")) return soldOut();
      throw new Error("unexpected_external_fetch");
    });
    const env = { DB: fake.db, DRY_RUN: "true", TARGET_PAGE_URL };
    const first = new Date("2026-08-08T15:00:00Z");
    await runOnce(env, first);
    const removedKey = stableSlotKey(label5, first)!;
    expect(fake.getState().slots[removedKey].active).toBe(true);
    expect(fake.dryEvents.filter((event) => event.kind === "removed_confirmed")).toHaveLength(0);
    await runOnce(env, new Date(first.getTime() + 5 * 60_000));
    expect(fake.getState().slots[removedKey]).toMatchObject({ active: false, missing_observation_count: 2, status: "MISSING" });
    expect(fake.dryEvents.filter((event) => event.kind === "removed_confirmed")).toHaveLength(1);
  });

  it("does not delete canonical slots on a zero-slot anomaly", async () => {
    const fake = fakeDb(initialState());
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ defaultOptionsOverrides: { pricesOverrides: { optionsChoicesWithModifiersAndTaxes: [] } } }), { status: 200, headers: { "content-type": "application/json" } }));
    await runOnce({ DB: fake.db, DRY_RUN: "true", TARGET_PAGE_URL }, new Date("2026-08-08T15:00:00Z"));
    expect(Object.keys(fake.getState().slots)).toHaveLength(4);
    expect(fake.getState().slot_set_anomaly).toBe("container_missing");
    expect(fake.dryEvents.filter((event) => event.kind === "structural_change")).toHaveLength(1);
  });
});
