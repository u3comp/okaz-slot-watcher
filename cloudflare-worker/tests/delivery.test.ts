import { afterEach, describe, expect, it, vi } from "vitest";

import {
  deliverPending,
  isUuid,
  type Pending,
  preparePendingForDelivery,
  sendDiscord,
  sendLine,
  type State,
} from "../src/index";

const LINE_RETRY_KEY = "123e4567-e89b-42d3-a456-426614174000";

function stateWithPending(pending: Pending): State {
  return {
    schema_version: 2,
    slots: {},
    consecutive_total_failures: 0,
    outage_notified: false,
    pending_notifications: [pending],
    updated_at_jst: "2026-08-03T23:00:00",
  };
}

function pending(channels: { discord: boolean; line?: boolean } = { discord: false, line: false }): Pending {
  return {
    id: "production-notification-test-not-a-uuid",
    kind: "test",
    message: "notification test",
    channels,
  };
}

function deliveryEnv() {
  return {
    DB: {} as D1Database,
    LINE_ENABLED: "true",
    DISCORD_WEBHOOK_URL: "https://discord.invalid/api/webhooks/test?thread_id=123",
    LINE_CHANNEL_ACCESS_TOKEN: "line-token-fixture",
    LINE_USER_ID: "line-user-fixture",
  };
}

afterEach(() => vi.restoreAllMocks());

describe("LINE Retry-Key契約", () => {
  it("pending IDが非UUIDでも独立したUUID Retry-Keyを生成する", () => {
    const state = stateWithPending(pending());
    preparePendingForDelivery(state, true);
    const item = state.pending_notifications[0];
    expect(isUuid(item.line_retry_key)).toBe(true);
    expect(item.line_retry_key).not.toBe(item.id);
    expect(item.delivery?.line?.retry_key).toBe(item.line_retry_key);
  });

  it("再試行時に同一Retry-Keyを使用する", async () => {
    const state = stateWithPending(pending({ discord: true, line: false }));
    const retryKeys: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      retryKeys.push(new Headers(init?.headers).get("x-line-retry-key") ?? "");
      return new Response("temporary", { status: 500, headers: { "content-type": "text/plain" } });
    });
    await deliverPending(deliveryEnv(), state, true);
    await deliverPending(deliveryEnv(), state, true);
    expect(retryKeys).toHaveLength(2);
    expect(isUuid(retryKeys[0])).toBe(true);
    expect(retryKeys[1]).toBe(retryKeys[0]);
    expect(retryKeys[0]).not.toBe(state.pending_notifications[0].id);
    expect(state.pending_notifications[0].delivery?.line).toMatchObject({
      attempt_count: 2,
      last_attempt_at_utc: expect.any(String),
      last_http_status: 500,
      last_error_class: "http_error",
      last_error_name: "HTTP_500",
      last_error_message: "line_http_500",
      response_content_type: "text/plain",
      response_excerpt_hash: expect.stringMatching(/^[0-9a-f]{64}$/),
      response_excerpt: "temporary",
      permanent_failure: false,
      retry_key: retryKeys[0],
    });
  });

  it("HTTP 200を成功としてrequest IDを保存する", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", {
      status: 200,
      headers: { "content-type": "application/json", "x-line-request-id": "line-request-1" },
    }));
    const result = await sendLine("token", "user", "message", LINE_RETRY_KEY);
    expect(result).toMatchObject({ success: true, permanentFailure: false });
    expect(result.diagnostic).toMatchObject({ last_http_status: 200, x_line_request_id: "line-request-1", retry_key: LINE_RETRY_KEY });
  });

  it("HTTP 409とaccepted request IDを受理済み成功として扱う", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("already accepted", {
      status: 409,
      headers: {
        "content-type": "application/json",
        "x-line-request-id": "retry-request",
        "x-line-accepted-request-id": "accepted-request",
      },
    }));
    const result = await sendLine("token", "user", "message", LINE_RETRY_KEY);
    expect(result).toMatchObject({ success: true, permanentFailure: false });
    expect(result.diagnostic).toMatchObject({
      last_http_status: 409,
      x_line_request_id: "retry-request",
      x_line_accepted_request_id: "accepted-request",
    });
  });

  it.each([400, 401, 403])("HTTP %sをpermanent failureにする", async (status) => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("permanent", { status }));
    await expect(sendLine("token", "user", "message", LINE_RETRY_KEY)).resolves.toMatchObject({
      success: false,
      permanentFailure: true,
      diagnostic: { last_http_status: status, last_error_class: "http_error" },
    });
  });

  it.each([429, 500])("HTTP %sを再試行可能にする", async (status) => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("retryable", { status }));
    await expect(sendLine("token", "user", "message", LINE_RETRY_KEY)).resolves.toMatchObject({
      success: false,
      permanentFailure: false,
      diagnostic: { last_http_status: status, last_error_class: "http_error" },
    });
  });

  it("timeoutとnetwork exceptionを再試行可能にする", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new DOMException("timeout", "TimeoutError"));
    await expect(sendLine("token", "user", "message", LINE_RETRY_KEY)).resolves.toMatchObject({
      success: false, permanentFailure: false, diagnostic: { last_error_class: "timeout" },
    });
    fetchMock.mockRejectedValueOnce(new TypeError("network failed"));
    await expect(sendLine("token", "user", "message", LINE_RETRY_KEY)).resolves.toMatchObject({
      success: false, permanentFailure: false, diagnostic: { last_error_class: "network_exception" },
    });
  });

  it("3回到達後はLINEを再送しない", async () => {
    const state = stateWithPending(pending({ discord: true, line: false }));
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("retryable", { status: 500 }));
    await deliverPending(deliveryEnv(), state, true);
    await deliverPending(deliveryEnv(), state, true);
    await deliverPending(deliveryEnv(), state, true);
    await deliverPending(deliveryEnv(), state, true);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(state.pending_notifications[0].delivery?.line).toMatchObject({ attempt_count: 3, permanent_failure: true });
  });

  it("permanent failure後はLINEを再送しない", async () => {
    const state = stateWithPending(pending({ discord: true, line: false }));
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("bad request", { status: 400 }));
    await deliverPending(deliveryEnv(), state, true);
    await deliverPending(deliveryEnv(), state, true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(state.pending_notifications[0].delivery?.line).toMatchObject({ attempt_count: 1, permanent_failure: true });
  });

  it.each([301, 302, 307, 308])("HTTP %s redirectを追跡せずpermanent failureにする", async (status) => {
    let callCount = 0;
    let requestInit: RequestInit | undefined;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      callCount += 1;
      requestInit = init;
      return new Response("redirect-body", {
        status,
        headers: { location: "https://other.example.test/next?secret=value" },
      });
    });
    const result = await sendLine("token", "user", "message", LINE_RETRY_KEY);
    expect(callCount).toBe(1);
    expect(requestInit?.redirect).toBe("manual");
    expect(result).toMatchObject({
      success: false,
      permanentFailure: true,
      diagnostic: {
        last_http_status: status,
        last_error_class: "redirect_response",
        last_error_name: `HTTP_${status}`,
        last_error_message: `line_redirect_${status}`,
        redirect_status: status,
        redirect_location_present: true,
        redirect_host: "other.example.test",
      },
    });
    expect(JSON.stringify(result.diagnostic)).not.toContain("secret");
  });

  it("LINE redirectのLocationなしと同一hostをhostだけ保存する", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response("", { status: 301 }))
      .mockResolvedValueOnce(new Response("", { status: 302, headers: { location: "/next?token=hidden" } }));
    await expect(sendLine("token", "user", "message", LINE_RETRY_KEY)).resolves.toMatchObject({
      permanentFailure: true,
      diagnostic: { redirect_status: 301, redirect_location_present: false, redirect_host: undefined },
    });
    const sameHost = await sendLine("token", "user", "message", LINE_RETRY_KEY);
    expect(sameHost).toMatchObject({
      permanentFailure: true,
      diagnostic: { redirect_status: 302, redirect_location_present: true, redirect_host: "api.line.me" },
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(sameHost.diagnostic)).not.toContain("token=hidden");
  });
});

describe("Discord wait=true契約", () => {
  it("既存queryを維持してwait=trueを設定する", async () => {
    let requestedUrl = "";
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      requestedUrl = String(input);
      return new Response(JSON.stringify({ id: "message-id" }), { status: 200, headers: { "content-type": "application/json" } });
    });
    const result = await sendDiscord("https://discord.invalid/hook?thread_id=123&wait=false", "message");
    const url = new URL(requestedUrl);
    expect(url.searchParams.get("thread_id")).toBe("123");
    expect(url.searchParams.get("wait")).toBe("true");
    expect(result).toMatchObject({ success: true, diagnostic: { webhook_wait_confirmed: true } });
  });

  it.each([301, 302, 307, 308])("HTTP %s redirectを追跡せずpermanent failureにする", async (status) => {
    let callCount = 0;
    let requestedUrl = "";
    let requestInit: RequestInit | undefined;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      callCount += 1;
      requestedUrl = String(input);
      requestInit = init;
      return new Response("redirect-body", {
        status,
        headers: { location: "https://other.example.test/next?webhook_token=hidden" },
      });
    });
    const result = await sendDiscord("https://discord.invalid/api/webhooks/test?thread_id=123", "message");
    expect(callCount).toBe(1);
    expect(new URL(requestedUrl).searchParams.get("thread_id")).toBe("123");
    expect(new URL(requestedUrl).searchParams.get("wait")).toBe("true");
    expect(requestInit?.redirect).toBe("manual");
    expect(result).toMatchObject({
      success: false,
      permanentFailure: true,
      diagnostic: {
        last_http_status: status,
        last_error_class: "redirect_response",
        last_error_name: `HTTP_${status}`,
        last_error_message: `discord_redirect_${status}`,
        redirect_status: status,
        redirect_location_present: true,
        redirect_host: "other.example.test",
      },
    });
    expect(JSON.stringify(result.diagnostic)).not.toContain("webhook_token");
  });

  it("Discord redirectのLocationなしと同一hostをhostだけ保存する", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response("", { status: 301 }))
      .mockResolvedValueOnce(new Response("", { status: 302, headers: { location: "/next?token=hidden" } }));
    await expect(sendDiscord("https://discord.invalid/hook?thread_id=123", "message")).resolves.toMatchObject({
      permanentFailure: true,
      diagnostic: { redirect_status: 301, redirect_location_present: false, redirect_host: undefined },
    });
    const sameHost = await sendDiscord("https://discord.invalid/hook?thread_id=123", "message");
    expect(sameHost).toMatchObject({
      permanentFailure: true,
      diagnostic: { redirect_status: 302, redirect_location_present: true, redirect_host: "discord.invalid" },
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(sameHost.diagnostic)).not.toContain("token=hidden");
  });

  it("HTTP 200のメッセージオブジェクトを成功としてrequest IDを保存する", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ id: "message-id" }), {
      status: 200,
      headers: { "content-type": "application/json", "x-request-id": "discord-request-1" },
    }));
    const result = await sendDiscord("https://discord.invalid/hook", "message");
    expect(result).toMatchObject({ success: true, permanentFailure: false });
    expect(result.diagnostic).toMatchObject({ last_http_status: 200, discord_request_id: "discord-request-1", webhook_wait_confirmed: true });
  });

  it("HTTP 204を後方互換成功としwait未確認を記録する", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 204 }));
    await expect(sendDiscord("https://discord.invalid/hook", "message")).resolves.toMatchObject({
      success: true,
      diagnostic: { last_http_status: 204, webhook_wait_confirmed: false },
    });
  });

  it.each([400, 401, 403, 404])("HTTP %sをpermanent failureにする", async (status) => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("permanent", { status }));
    await expect(sendDiscord("https://discord.invalid/hook", "message")).resolves.toMatchObject({
      success: false,
      permanentFailure: true,
      diagnostic: { last_http_status: status, last_error_class: "http_error" },
    });
  });

  it.each([429, 500])("HTTP %sを再試行可能にする", async (status) => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("retryable", { status }));
    await expect(sendDiscord("https://discord.invalid/hook", "message")).resolves.toMatchObject({
      success: false,
      permanentFailure: false,
      diagnostic: { last_http_status: status, last_error_class: "http_error" },
    });
  });

  it("timeoutとnetwork exceptionを再試行可能にする", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new DOMException("timeout", "TimeoutError"));
    await expect(sendDiscord("https://discord.invalid/hook", "message")).resolves.toMatchObject({
      success: false, permanentFailure: false, diagnostic: { last_error_class: "timeout" },
    });
    fetchMock.mockRejectedValueOnce(new TypeError("network failed"));
    await expect(sendDiscord("https://discord.invalid/hook", "message")).resolves.toMatchObject({
      success: false, permanentFailure: false, diagnostic: { last_error_class: "network_exception" },
    });
  });

  it("3回到達後はDiscordを再送しない", async () => {
    const state = stateWithPending(pending({ discord: false }));
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("retryable", { status: 500 }));
    await deliverPending(deliveryEnv(), state, false);
    await deliverPending(deliveryEnv(), state, false);
    await deliverPending(deliveryEnv(), state, false);
    await deliverPending(deliveryEnv(), state, false);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(state.pending_notifications[0].delivery?.discord).toMatchObject({ attempt_count: 3, permanent_failure: true });
  });

  it("permanent failure後はDiscordを再送しない", async () => {
    const state = stateWithPending(pending({ discord: false }));
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("bad request", { status: 400 }));
    await deliverPending(deliveryEnv(), state, false);
    await deliverPending(deliveryEnv(), state, false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(state.pending_notifications[0].delivery?.discord).toMatchObject({ attempt_count: 1, permanent_failure: true });
  });
});

describe("チャネル別完了と安全化", () => {
  it("Discord成功後はLINEだけを再試行する", async () => {
    const state = stateWithPending(pending());
    let discordCalls = 0;
    let lineCalls = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      if (String(input).startsWith("https://api.line.me")) {
        lineCalls += 1;
        return new Response("retryable", { status: 500 });
      }
      discordCalls += 1;
      return new Response(JSON.stringify({ id: "message" }), { status: 200, headers: { "content-type": "application/json" } });
    });
    await deliverPending(deliveryEnv(), state, true);
    await deliverPending(deliveryEnv(), state, true);
    expect(discordCalls).toBe(1);
    expect(lineCalls).toBe(2);
    expect(state.pending_notifications[0].channels).toEqual({ discord: true, line: false });
    expect(state.pending_notifications[0].delivery?.discord).toMatchObject({
      attempt_count: 1,
      permanent_failure: false,
      webhook_wait_confirmed: true,
      completed_at_utc: expect.any(String),
    });
  });

  it("LINE成功後はDiscordだけを再試行する", async () => {
    const state = stateWithPending(pending());
    let discordCalls = 0;
    let lineCalls = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      if (String(input).startsWith("https://api.line.me")) {
        lineCalls += 1;
        return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
      }
      discordCalls += 1;
      return new Response("retryable", { status: 500 });
    });
    await deliverPending(deliveryEnv(), state, true);
    await deliverPending(deliveryEnv(), state, true);
    expect(discordCalls).toBe(2);
    expect(lineCalls).toBe(1);
    expect(state.pending_notifications[0].channels).toEqual({ discord: false, line: true });
  });

  it("両チャネル成功時だけpendingを削除する", async () => {
    const state = stateWithPending(pending());
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => (
      String(input).startsWith("https://api.line.me")
        ? new Response("{}", { status: 200, headers: { "content-type": "application/json" } })
        : new Response(JSON.stringify({ id: "message" }), { status: 200, headers: { "content-type": "application/json" } })
    ));
    await deliverPending(deliveryEnv(), state, true);
    expect(state.pending_notifications).toEqual([]);
  });

  it("Secret、URL、Token、User IDを診断excerptへ残さない", async () => {
    const sensitive = "authorization: Bearer super-secret token=token-value user_id=private-user https://discord.com/api/webhooks/123/private-token";
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(sensitive, { status: 400, headers: { "content-type": "text/plain" } }));
    const result = await sendDiscord("https://discord.invalid/hook", "message");
    const excerpt = result.diagnostic.response_excerpt ?? "";
    expect(excerpt).not.toContain("super-secret");
    expect(excerpt).not.toContain("token-value");
    expect(excerpt).not.toContain("private-user");
    expect(excerpt).not.toContain("/api/webhooks/");
    expect(result.diagnostic.response_excerpt_hash).toMatch(/^[0-9a-f]{64}$/);
  });
});
