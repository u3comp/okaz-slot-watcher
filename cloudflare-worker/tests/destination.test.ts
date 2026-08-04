import { describe, expect, it, vi } from "vitest";

import { deliverPending, lineDestinationStatus, resolveLineDestination, type State } from "../src/index";

describe("LINE destination routing", () => {
  it("defaults to the existing personal destination", () => {
    expect(resolveLineDestination(undefined, "personal-fixture", "group-fixture")).toEqual({
      mode: "personal",
      destinationId: "personal-fixture",
    });
  });

  it("selects personal or group without exposing the other ID", () => {
    expect(resolveLineDestination("personal", "personal-fixture", "group-fixture").destinationId).toBe("personal-fixture");
    expect(resolveLineDestination("group", "personal-fixture", "group-fixture").destinationId).toBe("group-fixture");
  });

  it("fails closed for invalid or missing configuration", () => {
    expect(() => resolveLineDestination("unexpected", "personal-fixture", "group-fixture")).toThrow("line_destination_mode_invalid");
    expect(() => resolveLineDestination("group", "personal-fixture", undefined)).toThrow("line_group_destination_missing");
    expect(() => resolveLineDestination("personal", undefined, "group-fixture")).toThrow("line_personal_destination_missing");
  });

  it("allows a manual override only for test callers", () => {
    expect(resolveLineDestination("personal", "personal-fixture", "group-fixture", "group").mode).toBe("group");
    expect(() => resolveLineDestination("personal", "personal-fixture", "group-fixture", "invalid" as "configured")).toThrow();
  });

  it("health status exposes only mode and configured booleans", () => {
    expect(lineDestinationStatus({ LINE_DESTINATION_MODE: "group", LINE_USER_ID: "p", LINE_GROUP_ID: "g" } as never)).toEqual({
      line_destination_mode: "group",
      line_user_id_configured: true,
      line_group_id_configured: true,
    });
  });

  it("Cloudflare delivery uses the group destination without requiring LINE_USER_ID", async () => {
    const state: State = {
      schema_version: 2,
      slots: {},
      consecutive_total_failures: 0,
      outage_notified: false,
      pending_notifications: [{
        id: "pending-fixture",
        kind: "test",
        message: "routing fixture",
        channels: { discord: true, line: false },
      }],
      updated_at_jst: "2026-08-05T00:00:00",
    };
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      const payload = JSON.parse(String(init?.body)) as { to: string };
      expect(payload.to).toBe("group-fixture");
      return new Response("", { status: 200 });
    });
    await deliverPending({
      DB: {} as D1Database,
      LINE_ENABLED: "true",
      LINE_DESTINATION_MODE: "group",
      LINE_CHANNEL_ACCESS_TOKEN: "token-fixture",
      LINE_GROUP_ID: "group-fixture",
    }, state, true, new Date("2026-08-05T00:00:00Z"));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(state.pending_notifications).toEqual([]);
    fetchMock.mockRestore();
  });
});
