import { describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { readFileSync } from "node:fs";

// The executable is intentionally JavaScript so Windows can run it directly
// with the project-local Node/Wrangler runtime.
// @ts-ignore no declaration file is needed for this executable test adapter.
import { extractGroupIdFromTailEnvelope, runCapturePipeline } from "../capture-worker/capture-group-id.mjs";

function fakeTail(lines: string[], delayed = false) {
  const child = new EventEmitter() as EventEmitter & { stdout: Readable; stderr: Readable; stdin: { end: (value?: string) => void }; exitCode: number | null; signalCode: string | null; killed?: boolean; kill: (signal: string) => boolean };
  child.stdout = delayed ? new Readable({ read() {} }) : Readable.from(lines.map((line) => `${line}\n`));
  child.stderr = Readable.from([]);
  child.stdin = { end: () => undefined };
  child.exitCode = null;
  child.signalCode = null;
  child.kill = () => { child.killed = true; child.exitCode = 0; child.stdout.destroy(); queueMicrotask(() => child.emit("close", 0)); return true; };
  return child;
}

function adapterFor(lines: string[], outcomes: Record<string, { code: number; stdout?: string }> = {}) {
  const calls: Array<{ command: string; args: string[]; stdin: string }> = [];
  let tail = fakeTail(lines);
  const adapter = {
    calls,
    spawnProcess: () => tail,
    command: async (command: string, args: string[], stdin = "") => {
      calls.push({ command, args, stdin });
      const key = `${command}:${args.join(" ")}`;
      return outcomes[key] ?? { code: 0, stdout: "[]" };
    },
    wranglerCommand: async (args: string[], stdin = "") => {
      calls.push({ command: "wrangler", args, stdin });
      const key = `wrangler:${args.join(" ")}`;
      return outcomes[key] ?? { code: 0, stdout: "[]" };
    },
  };
  return { adapter, setTail: (value: ReturnType<typeof fakeTail>) => { tail = value; } };
}

describe("executable Capture pipeline", () => {
  it("parses the real Wrangler envelope logs[].message[] and takes the first event", () => {
    const line = readFileSync(new URL("./fixtures/tail-envelope.jsonl", import.meta.url), "utf8").trim();
    expect(extractGroupIdFromTailEnvelope(line)).toBe("group-envelope-fixture");
  });

  it("captures through the process adapter without printing or applying secrets in default mode", async () => {
    const line = readFileSync(new URL("./fixtures/tail-envelope.jsonl", import.meta.url), "utf8").trim();
    const { adapter } = adapterFor([line]);
    const result = await runCapturePipeline({ workerRoot: process.cwd(), configPath: "wrangler.production.toml", adapter, timeoutMs: 1000 });
    expect(result).toEqual({ status: "captured", tail_stopped: true, applied: false });
    expect(adapter.calls).toEqual([]);
  });

  it("passes the captured value only through stdin and never as an argument", async () => {
    const line = readFileSync(new URL("./fixtures/tail-envelope.jsonl", import.meta.url), "utf8").trim();
    const { adapter } = adapterFor([line], {
      "gh:secret list --repo u3comp/okaz-slot-watcher --json name": { code: 0, stdout: "[]" },
      "wrangler:versions secret list --config wrangler.production.toml": { code: 0, stdout: "[]" },
      "gh:secret set LINE_GROUP_ID --repo u3comp/okaz-slot-watcher": { code: 0 },
      "wrangler:versions secret put LINE_GROUP_ID --config wrangler.production.toml": { code: 0, stdout: "version 11111111-1111-4111-8111-111111111111" },
    });
    const result = await runCapturePipeline({ workerRoot: process.cwd(), configPath: "wrangler.production.toml", adapter, apply: true, timeoutMs: 1000 });
    expect(result.status).toBe("secrets_set");
    const secretCalls = adapter.calls.filter((call) => call.args.includes("LINE_GROUP_ID"));
    expect(secretCalls.every((call) => !call.args.includes("group-envelope-fixture"))).toBe(true);
    expect(secretCalls.filter((call) => call.command === "gh" || call.command === "wrangler").every((call) => call.stdin === "group-envelope-fixture" || call.stdin === "")).toBe(true);
  });

  it("stops safely on timeout and tail disconnect", async () => {
    const timeoutChild = fakeTail([], true);
    const timeoutAdapter = adapterFor([]);
    timeoutAdapter.setTail(timeoutChild);
    const timeout = await runCapturePipeline({ workerRoot: process.cwd(), configPath: "wrangler.production.toml", adapter: timeoutAdapter.adapter, timeoutMs: 5 });
    expect(timeout).toEqual({ status: "timeout", tail_stopped: true });
    const disconnect = await runCapturePipeline({ workerRoot: process.cwd(), configPath: "wrangler.production.toml", adapter: adapterFor(["not-json"]).adapter, timeoutMs: 1000 });
    expect(disconnect).toEqual({ status: "tail_disconnected", tail_stopped: true });
  });

  it("rolls back a GitHub-only partial setup without retrying", async () => {
    const line = readFileSync(new URL("./fixtures/tail-envelope.jsonl", import.meta.url), "utf8").trim();
    const { adapter } = adapterFor([line], {
      "gh:secret list --repo u3comp/okaz-slot-watcher --json name": { code: 0, stdout: "[]" },
      "wrangler:versions secret list --config wrangler.production.toml": { code: 0, stdout: "[]" },
      "gh:secret set LINE_GROUP_ID --repo u3comp/okaz-slot-watcher": { code: 0 },
      "wrangler:versions secret put LINE_GROUP_ID --config wrangler.production.toml": { code: 1, stdout: "" },
      "gh:secret delete LINE_GROUP_ID --repo u3comp/okaz-slot-watcher": { code: 0 },
    });
    const result = await runCapturePipeline({ workerRoot: process.cwd(), configPath: "wrangler.production.toml", adapter, apply: true, timeoutMs: 1000 });
    expect(result.status).toBe("partial_secret_state_rolled_back");
    expect(adapter.calls.filter((call) => call.args.includes("secret") && call.args.includes("set")).length).toBe(1);
    expect(adapter.calls.filter((call) => call.args.includes("secret") && call.args.includes("delete")).length).toBe(1);
  });
});
