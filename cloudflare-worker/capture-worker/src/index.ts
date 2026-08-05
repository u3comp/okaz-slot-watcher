export interface CaptureEnv {
  LINE_CHANNEL_SECRET?: string;
}

export interface CaptureSession {
  captured: boolean;
  seenEventIds: Set<string>;
}

export interface GroupCaptureEvent {
  event: "line_group_id_capture";
  group_id: string;
}

export function createCaptureSession(): CaptureSession {
  return { captured: false, seenEventIds: new Set<string>() };
}

const MAX_BODY_BYTES = 128 * 1024;

function constantTimeEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left[index] ^ right[index];
  return difference === 0;
}

function decodeBase64(value: string): Uint8Array | undefined {
  try {
    const binary = atob(value);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    return undefined;
  }
}

async function verifySignature(secret: string, body: Uint8Array, signature: string): Promise<boolean> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const expected = new Uint8Array(await crypto.subtle.sign("HMAC", key, body as unknown as ArrayBuffer));
  const supplied = decodeBase64(signature);
  return Boolean(supplied && constantTimeEqual(expected, supplied));
}

export function extractGroupId(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const events = (payload as { events?: unknown }).events;
  if (!Array.isArray(events)) return undefined;
  for (const event of events) {
    if (!event || typeof event !== "object") continue;
    const source = (event as { source?: unknown }).source;
    if (!source || typeof source !== "object") continue;
    if ((source as { type?: unknown }).type !== "group") continue;
    const groupId = (source as { groupId?: unknown }).groupId;
    if (typeof groupId === "string" && groupId.length > 0) return groupId;
  }
  return undefined;
}

function response(status: number, body?: string): Response {
  return new Response(body, { status, headers: { "cache-control": "no-store" } });
}

function emitGroupCaptureEvent(groupId: string): void {
  // This is the only intentional log line. A local `wrangler tail` process
  // consumes the dedicated machine-readable event; ordinary webhook content,
  // user IDs, and message text are never logged.
  const event: GroupCaptureEvent = { event: "line_group_id_capture", group_id: groupId };
  console.log(JSON.stringify(event));
}

export async function handleCaptureRequest(
  request: Request,
  env: CaptureEnv,
  session = createCaptureSession(),
): Promise<Response> {
  if (request.method !== "POST") return response(405);
  if (!env.LINE_CHANNEL_SECRET) return response(503);
  const signature = request.headers.get("x-line-signature");
  if (!signature) return response(401);
  const body = new Uint8Array(await request.arrayBuffer());
  if (body.byteLength > MAX_BODY_BYTES) return response(413);
  if (!(await verifySignature(env.LINE_CHANNEL_SECRET, body, signature))) return response(401);

  let payload: unknown;
  try {
    payload = JSON.parse(new TextDecoder().decode(body)) as unknown;
  } catch {
    return response(400);
  }
  if (session.captured) return response(200, "ok");
  const events = payload && typeof payload === "object" && Array.isArray((payload as { events?: unknown }).events)
    ? (payload as { events: unknown[] }).events
    : [];
  for (const event of events) {
    const eventId = event && typeof event === "object" && typeof (event as { webhookEventId?: unknown }).webhookEventId === "string"
      ? (event as { webhookEventId: string }).webhookEventId
      : undefined;
    if (eventId && session.seenEventIds.has(eventId)) continue;
    if (eventId) session.seenEventIds.add(eventId);
    const groupId = extractGroupId({ events: [event] });
    if (!groupId) continue;
    session.captured = true;
    emitGroupCaptureEvent(groupId);
    return response(200, "ok");
  }
  return response(200, "ok");
}

export default {
  async fetch(request: Request, env: CaptureEnv): Promise<Response> {
    // Isolates may be recreated between requests, so this default path only
    // provides best-effort duplicate suppression. The local orchestrator is
    // the authoritative one-shot stop condition.
    return handleCaptureRequest(request, env);
  },
};
