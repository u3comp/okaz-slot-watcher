import { describe, expect, it } from "vitest";

import { createCaptureSession, extractGroupId, handleCaptureRequest } from "../capture-worker/src/index";
import { dormantResponse } from "../dormant-worker/src/index";

async function signature(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const digest = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)));
  let binary = "";
  digest.forEach((byte) => { binary += String.fromCharCode(byte); });
  return btoa(binary);
}

describe("local Capture Worker", () => {
  it("accepts only a signed group event and never returns the groupId", async () => {
    const secret = "capture-secret-fixture";
    const body = JSON.stringify({ events: [{ webhookEventId: "event-1", source: { type: "group", groupId: "group-fixture" } }] });
    const response = await handleCaptureRequest(
      new Request("https://capture.invalid", { method: "POST", body, headers: { "x-line-signature": await signature(secret, body) } }),
      { LINE_CHANNEL_SECRET: secret },
    );
    expect(response.status).toBe(200);
    const responseText = await response.text();
    expect(responseText).toBe("captured");
    expect(responseText).not.toContain("group-fixture");
  });

  it("rejects invalid signatures and ignores non-group events", async () => {
    const body = JSON.stringify({ events: [{ source: { type: "user", userId: "user-fixture" } }] });
    const invalid = await handleCaptureRequest(new Request("https://capture.invalid", { method: "POST", body, headers: { "x-line-signature": "bad" } }), { LINE_CHANNEL_SECRET: "secret" });
    expect(invalid.status).toBe(401);
    const validSignature = await signature("secret", body);
    const ignored = await handleCaptureRequest(new Request("https://capture.invalid", { method: "POST", body, headers: { "x-line-signature": validSignature } }), { LINE_CHANNEL_SECRET: "secret" });
    expect(ignored.status).toBe(204);
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
    expect((await handleCaptureRequest(new Request("https://capture.invalid", init), { LINE_CHANNEL_SECRET: secret }, session)).status).toBe(200);
    expect((await handleCaptureRequest(new Request("https://capture.invalid", init), { LINE_CHANNEL_SECRET: secret }, session)).status).toBe(204);
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
