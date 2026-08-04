import type { GroupCaptureEvent } from "./src/index";

export interface CaptureTransfer {
  setGitHubSecret?: (groupId: string) => Promise<void>;
  setCloudflareSecret?: (groupId: string) => Promise<void>;
}

export interface CaptureResult {
  transferred: boolean;
  reason?: "captured" | "timeout" | "tail_disconnected" | "invalid_event" | "transfer_failed";
}

function parseCaptureLine(line: string): string | undefined {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (!value || typeof value !== "object") return undefined;
  const event = value as Partial<GroupCaptureEvent>;
  if (event.event !== "line_group_id_capture" || typeof event.group_id !== "string") return undefined;
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(event.group_id)) return undefined;
  return event.group_id;
}

export async function captureGroupIdFromTail(
  lines: AsyncIterable<string>,
  transfer: CaptureTransfer,
  signal?: AbortSignal,
): Promise<CaptureResult> {
  try {
    for await (const line of lines) {
      if (signal?.aborted) return { transferred: false, reason: "timeout" };
      const groupId = parseCaptureLine(line);
      if (!groupId) continue;
      try {
        if (transfer.setGitHubSecret) await transfer.setGitHubSecret(groupId);
        if (transfer.setCloudflareSecret) await transfer.setCloudflareSecret(groupId);
      } catch {
        // The value remains only in this call stack; callers must stop without
        // retrying or logging it when either destination setup fails.
        return { transferred: false, reason: "transfer_failed" };
      }
      return { transferred: true, reason: "captured" };
    }
    return { transferred: false, reason: "tail_disconnected" };
  } catch {
    return { transferred: false, reason: "tail_disconnected" };
  }
}

export function createTailLineStream(lines: Iterable<string>): AsyncIterable<string> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const line of lines) yield line;
    },
  };
}
