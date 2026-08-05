import { describe, expect, it } from "vitest";

import { createCaptureSession, extractGroupId, handleCaptureRequest } from "../capture-worker/src/index";
import { captureGroupIdFromTail, createTailLineStream } from "../capture-worker/orchestrator";
import { dormantResponse } from "../dormant-worker/src/index";

async function signature(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const digest = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)));
  let binary = "";
  digest.forEach((byte) => { binary += String.fromCharCode(byte); });
  return btoa(binary);
}

describe("local Capture Worker", () => {
  it("keeps the method, secret, size, signature, and JSON failure contract", async () => {
    const secret = "capture-secret-fixture";
    expect((await handleCaptureRequest(new Request("https://capture.invalid", { method: "GET" }), { LINE_CHANNEL_SECRET: secret })).status).toBe(405);
    expect((await handleCaptureRequest(new Request("https://capture.invalid", { method: "POST", body: "{}" }), {})).status).toBe(503);
    expect((await handleCaptureRequest(new Request("https://capture.invalid", { method: "POST", body: "{}" }), { LINE_CHANNEL_SECRET: secret })).status).toBe(401);
    const oversized = "x".repeat((128 * 1024) + 1);
    expect((await handleCaptureRequest(
      new Request("https://capture.invalid", { method: "POST", body: oversized, headers: { "x-line-signature": await signature(secret, oversized) } }),
      { LINE_CHANNEL_SECRET: secret },
    )).status).toBe(413);
    const invalidJson = "not-json";
    expect((await handleCaptureRequest(
      new Request("https://capture.invalid", { method: "POST", body: invalidJson, headers: { "x-line-signature": await signature(secret, invalidJson) } }),
      { LINE_CHANNEL_SECRET: secret },
    )).status).toBe(400);
  });

  it("accepts only a signed group event and emits one dedicated event", async () => {
    const secret = "capture-secret-fixture";
    const body = JSON.stringify({ events: [{ webhookEventId: "event-1", source: { type: "group", groupId: "group-fixture" } }] });
    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => logs.push(args.join(" "));
    try {
    const response = await handleCaptureRequest(
      new Request("https://capture.invalid", { method: "POST", body, headers: { "x-line-signature": await signature(secret, body) } }),
      { LINE_CHANNEL_SECRET: secret },
    );
    expect(response.status).toBe(200);
    const responseText = await response.text();
    expect(responseText).toBe("ok");
    expect(responseText).not.toContain("group-fixture");
    expect(logs).toHaveLength(1);
    expect(JSON.parse(logs[0])).toEqual({ event: "line_group_id_capture", group_id: "group-fixture" });
    } finally {
      console.log = originalLog;
    }
  });

  it("rejects invalid signatures and returns 200 without logs for user events", async () => {
    const body = JSON.stringify({ events: [{ source: { type: "user", userId: "user-fixture" } }] });
    const invalid = await handleCaptureRequest(new Request("https://capture.invalid", { method: "POST", body, headers: { "x-line-signature": "bad" } }), { LINE_CHANNEL_SECRET: "secret" });
    expect(invalid.status).toBe(401);
    const validSignature = await signature("secret", body);
    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => logs.push(args.join(" "));
    try {
      const ignored = await handleCaptureRequest(new Request("https://capture.invalid", { method: "POST", body, headers: { "x-line-signature": validSignature } }), { LINE_CHANNEL_SECRET: "secret" });
      expect(ignored.status).toBe(200);
      expect(logs).toHaveLength(0);
    } finally {
      console.log = originalLog;
    }
  });

  it("returns 200 with no capture log for LINE verification events: []", async () => {
    const secret = "capture-secret-fixture";
    const body = JSON.stringify({ destination: "destination-fixture", events: [] });
    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => logs.push(args.join(" "));
    try {
      const response = await handleCaptureRequest(
        new Request("https://capture.invalid", { method: "POST", body, headers: { "x-line-signature": await signature(secret, body) } }),
        { LINE_CHANNEL_SECRET: secret },
      );
      expect(response.status).toBe(200);
      const responseText = await response.text();
      expect(responseText).toBe("ok");
      expect(responseText).not.toContain("destination-fixture");
      expect(logs).toHaveLength(0);
    } finally {
      console.log = originalLog;
    }
  });

  it("returns 200 with no capture log for room events", async () => {
    const secret = "capture-secret-fixture";
    const body = JSON.stringify({ events: [{ source: { type: "room", roomId: "room-fixture" } }] });
    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => logs.push(args.join(" "));
    try {
      const response = await handleCaptureRequest(
        new Request("https://capture.invalid", { method: "POST", body, headers: { "x-line-signature": await signature(secret, body) } }),
        { LINE_CHANNEL_SECRET: secret },
      );
      expect(response.status).toBe(200);
      expect(logs).toHaveLength(0);
    } finally {
      console.log = originalLog;
    }
  });

  it("extracts only a group source for local controlled transfer", () => {
    expect(extractGroupId({ events: [{ source: { type: "user", userId: "user-fixture" } }, { source: { type: "group", groupId: "group-fixture" } }] })).toBe("group-fixture");
    expect(extractGroupId({ events: [{ source: { type: "room", roomId: "room-fixture" } }] })).toBeUndefined();
  });

  it("does not accept a second event in the same capture session", async () => {
    const secret = "capture-secret-fixture";
    const session = createCaptureSession();
    const body = JSON.stringify({ events: [{ webhookEventId: "event-1", source: { type: "group", groupId: "group-fixture" } }] });
    const init = { method: "POST", body, headers: { "x-line-signature": await signature(secret, body) } } as RequestInit;
    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => logs.push(args.join(" "));
    try {
      expect((await handleCaptureRequest(new Request("https://capture.invalid", init), { LINE_CHANNEL_SECRET: secret }, session)).status).toBe(200);
      expect((await handleCaptureRequest(new Request("https://capture.invalid", init), { LINE_CHANNEL_SECRET: secret }, session)).status).toBe(200);
      expect(logs).toHaveLength(1);
    } finally {
      console.log = originalLog;
    }
  });

  it("uses the default exported fetch path", async () => {
    const secret = "capture-secret-fixture";
    const body = JSON.stringify({ events: [{ source: { type: "group", groupId: "group-fetch" } }] });
    const originalLog = console.log;
    const logs: string[] = [];
    console.log = (...args: unknown[]) => logs.push(args.join(" "));
    try {
      const response = await (await import("../capture-worker/src/index")).default.fetch(
        new Request("https://capture.invalid", { method: "POST", body, headers: { "x-line-signature": await signature(secret, body) } }),
        { LINE_CHANNEL_SECRET: secret },
      );
      expect(response.status).toBe(200);
      expect(logs).toHaveLength(1);
    } finally {
      console.log = originalLog;
    }
  });
});

describe("local Capture Orchestrator", () => {
  it("transfers the first valid group event without printing or persisting it", async () => {
    const calls: string[] = [];
    const result = await captureGroupIdFromTail(
      createTailLineStream(["noise", JSON.stringify({ event: "line_group_id_capture", group_id: "group-first" }), JSON.stringify({ event: "line_group_id_capture", group_id: "group-second" })]),
      { setGitHubSecret: async (id) => { calls.push(`github:${id}`); }, setCloudflareSecret: async (id) => { calls.push(`cloudflare:${id}`); } },
    );
    expect(result).toEqual({ transferred: true, reason: "captured" });
    expect(calls).toEqual(["github:group-first", "cloudflare:group-first"]);
  });

  it("does not transfer invalid or non-group events", async () => {
    const calls: string[] = [];
    const result = await captureGroupIdFromTail(createTailLineStream([JSON.stringify({ event: "other", group_id: "group-no" }), "not-json"]), { setGitHubSecret: async (id) => { calls.push(id); } });
    expect(result.reason).toBe("tail_disconnected");
    expect(calls).toEqual([]);
  });

  it("stops safely on tail timeout and transfer failure", async () => {
    const controller = new AbortController();
    controller.abort();
    const timeout = await captureGroupIdFromTail(createTailLineStream([JSON.stringify({ event: "line_group_id_capture", group_id: "group-timeout" })]), {}, controller.signal);
    expect(timeout.reason).toBe("timeout");
    const failure = await captureGroupIdFromTail(createTailLineStream([JSON.stringify({ event: "line_group_id_capture", group_id: "group-fail" })]), { setGitHubSecret: async () => { throw new Error("fixture"); } });
    expect(failure.reason).toBe("transfer_failed");
  });
});

describe("local dormant sink", () => {
  it("returns 200 for POST without reading or logging the body", async () => {
    const response = dormantResponse(new Request("https://capture.invalid", { method: "POST", body: "private-body" }));
    expect(response.status).toBe(200);
  });

  it("rejects non-POST requests", () => {
    expect(dormantResponse(new Request("https://capture.invalid", { method: "GET" })).status).toBe(405);
  });
});
