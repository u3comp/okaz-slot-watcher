import { describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough, Readable } from "node:stream";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";

// The executable is intentionally JavaScript so Windows can run it directly
// with the project-local Node/Wrangler runtime.
// @ts-ignore no declaration file is needed for this executable test adapter.
import { createTailJsonFrameParser, extractGroupIdFromTailEnvelope, formatCliResultLines, identifyCreatedVersion, inspectTailEnvelope, parseCliOptions, parseSecretNamesJson, runCapturePipeline, stopProcess } from "../capture-worker/capture-group-id.mjs";

type FakeChild = EventEmitter & {
  stdout: Readable;
  stderr: Readable;
  stdin: { end: (value?: string) => void };
  exitCode: number | null;
  signalCode: string | null;
  killSignals: string[];
  kill: (signal: string) => boolean;
};

function fakeChild({
  lines = [],
  chunks,
  stdoutOpen = false,
  stderrOpen = false,
  initialExitCode = null,
  killMode = "term-closes",
}: {
  lines?: string[];
  chunks?: string[];
  stdoutOpen?: boolean;
  stderrOpen?: boolean;
  initialExitCode?: number | null;
  killMode?: "term-closes" | "force-closes" | "never-closes";
} = {}): FakeChild {
  const child = new EventEmitter() as FakeChild;
  const outputChunks = chunks ?? lines.map((line) => `${line}\n`);
  child.stdout = stdoutOpen ? new Readable({ read() {} }) : Readable.from(outputChunks);
  if (stdoutOpen && outputChunks.length > 0) {
    queueMicrotask(() => {
      for (const chunk of outputChunks) child.stdout.push(chunk);
    });
  }
  child.stderr = stderrOpen ? new PassThrough() : Readable.from([]);
  child.stdin = { end: () => undefined };
  child.exitCode = initialExitCode;
  child.signalCode = null;
  child.killSignals = [];
  child.kill = (signal: string) => {
    child.killSignals.push(signal);
    const closes = killMode === "term-closes" || (killMode === "force-closes" && signal === "SIGKILL");
    if (closes) {
      queueMicrotask(() => {
        child.signalCode = signal;
        child.emit("close", null, signal);
      });
    }
    return true;
  };
  return child;
}

type Outcome = { code: number; stdout?: string };

function adapterFor(tail: FakeChild, outcomes: Record<string, Outcome | Outcome[]> = {}) {
  const calls: Array<{ command: string; args: string[]; stdin: string }> = [];
  const take = (key: string): Outcome => {
    const configured = outcomes[key];
    if (Array.isArray(configured)) return configured.shift() ?? { code: 1, stdout: "" };
    return configured ?? { code: 0, stdout: "[]" };
  };
  const adapter = {
    calls,
    spawnProcess: () => tail,
    command: async (command: string, args: string[], stdin = "") => {
      calls.push({ command, args, stdin });
      return take(`${command}:${args.join(" ")}`);
    },
    wranglerCommand: async (args: string[], stdin = "") => {
      calls.push({ command: "wrangler", args, stdin });
      return take(`wrangler:${args.join(" ")}`);
    },
  };
  return adapter;
}

const envelope = () => readFileSync(new URL("./fixtures/tail-envelope.jsonl", import.meta.url), "utf8").trim();
const prettyEnvelope = () => readFileSync(new URL("./fixtures/tail-envelope-wrangler-4.118.0-pretty.json", import.meta.url), "utf8");
const probeEnvelope = () => readFileSync(new URL("./fixtures/tail-envelope-wrangler-4.118.0-probe.json", import.meta.url), "utf8");
const operationId = "22222222-2222-4222-8222-222222222222";
const tag = `line-group-id-secret-${operationId}`;
const message = `Add LINE_GROUP_ID secret version ${operationId}; do not deploy`;
const oldVersion = "11111111-1111-4111-8111-111111111111";
const newVersion = "33333333-3333-4333-8333-333333333333";

function successfulApplyOutcomes(): Record<string, Outcome | Outcome[]> {
  return {
    "gh:secret list --repo u3comp/okaz-slot-watcher --json name": { code: 0, stdout: '[{"name":"DISCORD_WEBHOOK_URL"}]' },
    "wrangler:secret list --format json --config wrangler.production.toml": { code: 0, stdout: '[{"name":"LINE_USER_ID","type":"secret_text"}]' },
    "wrangler:versions list --json --config wrangler.production.toml": [
      { code: 0, stdout: JSON.stringify([{ id: oldVersion, annotations: { "workers/tag": "old", "workers/message": "old" } }]) },
      { code: 0, stdout: JSON.stringify([
        { id: newVersion, annotations: { "workers/tag": tag, "workers/message": message } },
        { id: oldVersion, annotations: { "workers/tag": "old", "workers/message": "old" } },
      ]) },
    ],
    "gh:secret set LINE_GROUP_ID --repo u3comp/okaz-slot-watcher": { code: 0 },
    [`wrangler:versions secret put LINE_GROUP_ID --tag ${tag} --message ${message} --config wrangler.production.toml`]: { code: 0, stdout: "human-readable output without a version identifier" },
  };
}

function parseFramedObjects(chunks: string[]) {
  const objects: unknown[] = [];
  const parser = createTailJsonFrameParser((value: unknown) => objects.push(value));
  for (const chunk of chunks) parser.push(chunk);
  return { objects, parserState: parser.finish() };
}

describe("Wrangler 4.118.0 multiline Tail framing", () => {
  it("parses the four-space pretty JSON fixture and ignores braces and escaped quotes inside strings", () => {
    const { objects, parserState } = parseFramedObjects([prettyEnvelope()]);
    expect(objects).toHaveLength(1);
    expect(parserState.capture_event_unparseable).toBe(false);
    expect(inspectTailEnvelope(objects[0])).toMatchObject({
      valid_tail_envelope_seen: true,
      worker_invocation_seen: true,
      capture_event_seen: true,
      group_id: "group-envelope-fixture",
      outcome: "ok",
      http_status: 200,
    });
  });

  it("parses every two-chunk split boundary and a one-character-at-a-time stream", () => {
    const fixture = prettyEnvelope();
    for (let split = 0; split <= fixture.length; split += 1) {
      const { objects } = parseFramedObjects([fixture.slice(0, split), fixture.slice(split)]);
      expect(objects).toHaveLength(1);
      expect(inspectTailEnvelope(objects[0]).group_id).toBe("group-envelope-fixture");
    }
    const characterChunks = [...fixture];
    const { objects } = parseFramedObjects(characterChunks);
    expect(objects).toHaveLength(1);
    expect(inspectTailEnvelope(objects[0]).group_id).toBe("group-envelope-fixture");
  });

  it("parses consecutive envelopes, CRLF, and safe non-JSON Wrangler warnings", () => {
    const probe = probeEnvelope().replaceAll("\n", "\r\n");
    const capture = prettyEnvelope().replaceAll("\n", "\r\n");
    const { objects } = parseFramedObjects([`safe warning without data\r\n${probe}${capture}`]);
    expect(objects).toHaveLength(2);
    expect(inspectTailEnvelope(objects[0])).toMatchObject({ worker_invocation_seen: true, capture_event_seen: false, http_status: 200 });
    expect(inspectTailEnvelope(objects[1])).toMatchObject({ capture_event_seen: true, group_id: "group-envelope-fixture" });
  });

  it("fails closed for invalid or truncated JSON without returning raw data", () => {
    const invalid = parseFramedObjects(["warning {ignored}\n{not-json}\n"]);
    expect(invalid.objects).toHaveLength(0);
    const truncated = parseFramedObjects(['{\n  "outcome": "ok",\n  "logs": [{"message":["{\\"event\\":\\"line_group_id_capture\\""]}]']);
    expect(truncated.objects).toHaveLength(0);
    expect(truncated.parserState.capture_event_unparseable).toBe(true);
  });
});

describe("executable Capture pipeline", () => {
  it("uses Wrangler 4.118.0 commands that expose the required read-only and version metadata flags", () => {
    const wrangler = path.join(process.cwd(), "node_modules", "wrangler", "bin", "wrangler.js");
    const version = spawnSync(process.execPath, [wrangler, "--version"], { cwd: process.cwd(), encoding: "utf8" });
    expect(version.status).toBe(0);
    expect(version.stdout.trim()).toBe("4.118.0");
    const secretList = spawnSync(process.execPath, [wrangler, "secret", "list", "--help"], { cwd: process.cwd(), encoding: "utf8" });
    expect(secretList.status).toBe(0);
    expect(secretList.stdout).toContain("--format");
    expect(secretList.stdout).toContain("--config");
    const secretPut = spawnSync(process.execPath, [wrangler, "versions", "secret", "put", "--help"], { cwd: process.cwd(), encoding: "utf8" });
    expect(secretPut.status).toBe(0);
    expect(secretPut.stdout).toContain("--tag");
    expect(secretPut.stdout).toContain("--message");
    const versionList = spawnSync(process.execPath, [wrangler, "versions", "list", "--help"], { cwd: process.cwd(), encoding: "utf8" });
    expect(versionList.status).toBe(0);
    expect(versionList.stdout).toContain("--json");
  });

  it("parses the real Wrangler envelope logs[].message[] and takes the first event", () => {
    expect(extractGroupIdFromTailEnvelope(envelope())).toBe("group-envelope-fixture");
  });

  it("parses the 600-second default and enforces the 60-to-900-second CLI range", () => {
    expect(parseCliOptions([])).toEqual({ apply: false, probe: false, timeoutSeconds: 600 });
    expect(parseCliOptions(["--apply", "--timeout-seconds", "600"])).toEqual({ apply: true, probe: false, timeoutSeconds: 600 });
    expect(parseCliOptions(["--probe", "--timeout-seconds", "60"])).toEqual({ apply: false, probe: true, timeoutSeconds: 60 });
    expect(parseCliOptions(["--timeout-seconds", "900"])).toEqual({ apply: false, probe: false, timeoutSeconds: 900 });
    for (const args of [
      ["--timeout-seconds", "59"],
      ["--timeout-seconds", "901"],
      ["--timeout-seconds", "1.5"],
      ["--timeout-seconds"],
      ["--apply", "--probe"],
      ["--unknown"],
    ]) {
      expect(() => parseCliOptions(args)).toThrow("invalid_arguments");
    }

    const executable = path.join(process.cwd(), "capture-worker", "capture-group-id.mjs");
    const invalidRun = spawnSync(process.execPath, [executable, "--timeout-seconds", "59"], { cwd: process.cwd(), encoding: "utf8" });
    expect(invalidRun.status).toBe(2);
    expect(invalidRun.stdout.trim().split(/\r?\n/)).toEqual(["capture_status=invalid_arguments", "tail_stopped=false"]);
    expect(invalidRun.stderr).toBe("");
  });

  it("formats only allowlisted status fields and never leaks raw or secret-like values", () => {
    const sensitive = {
      status: "worker_invocation_seen",
      tail_stopped: true,
      worker_invocation_seen: true,
      valid_tail_envelope_seen: true,
      capture_event_seen: false,
      http_status: 200,
      group_id: "group-sensitive-fixture",
      user_id: "user-sensitive-fixture",
      token: "token-sensitive-fixture",
      raw: "raw-sensitive-fixture",
    };
    const captureOutput = formatCliResultLines(sensitive).join("\n");
    const probeOutput = formatCliResultLines(sensitive, { probe: true }).join("\n");
    for (const output of [captureOutput, probeOutput]) {
      expect(output).not.toContain("group-sensitive-fixture");
      expect(output).not.toContain("user-sensitive-fixture");
      expect(output).not.toContain("token-sensitive-fixture");
      expect(output).not.toContain("raw-sensitive-fixture");
    }
  });

  it("Probe mode recognizes one healthy invocation and performs zero Secret commands", async () => {
    const adapter = adapterFor(fakeChild({ chunks: [...probeEnvelope()] }));
    const result = await runCapturePipeline({
      workerRoot: process.cwd(),
      configPath: "wrangler.production.toml",
      adapter,
      probe: true,
      timeoutMs: 1000,
    });
    expect(result).toEqual({
      status: "worker_invocation_seen",
      tail_stopped: true,
      worker_invocation_seen: true,
      valid_tail_envelope_seen: true,
      capture_event_seen: false,
      http_status: 200,
    });
    expect(adapter.calls).toEqual([]);
  });

  it("Probe mode fails closed if a capture event appears and still performs zero Secret commands", async () => {
    const adapter = adapterFor(fakeChild({ chunks: [prettyEnvelope()] }));
    const result = await runCapturePipeline({
      workerRoot: process.cwd(),
      configPath: "wrangler.production.toml",
      adapter,
      probe: true,
      apply: true,
      timeoutMs: 1000,
    });
    expect(result).toEqual({
      status: "probe_capture_event_seen",
      tail_stopped: true,
      worker_invocation_seen: true,
      valid_tail_envelope_seen: true,
      capture_event_seen: true,
      http_status: 200,
    });
    expect(adapter.calls).toEqual([]);
  });

  it("parses only names from the actual secret list JSON shape", () => {
    expect(parseSecretNamesJson('[{"name":"LINE_USER_ID","type":"secret_text"}]')).toEqual(["LINE_USER_ID"]);
    expect(() => parseSecretNamesJson("not-json")).toThrow("secret_list_json_invalid");
  });

  it("identifies exactly one newly tagged version", () => {
    const before = [{ id: oldVersion, annotations: { "workers/tag": "old", "workers/message": "old" } }];
    const after = [{ id: newVersion, annotations: { "workers/tag": tag, "workers/message": message } }, ...before];
    expect(identifyCreatedVersion(before, after, tag, message)).toBe(newVersion);
    expect(identifyCreatedVersion(before, [...after, { id: "44444444-4444-4444-8444-444444444444", annotations: { "workers/tag": tag, "workers/message": message } }], tag, message)).toBeUndefined();
  });

  it("captures without applying secrets in default mode", async () => {
    const child = fakeChild({ lines: [envelope()] });
    const adapter = adapterFor(child);
    const result = await runCapturePipeline({ workerRoot: process.cwd(), configPath: "wrangler.production.toml", adapter, timeoutMs: 1000 });
    expect(result).toEqual({
      status: "captured",
      tail_stopped: true,
      worker_invocation_seen: true,
      valid_tail_envelope_seen: true,
      capture_event_seen: true,
      applied: false,
    });
    expect(JSON.stringify(result)).not.toContain("group-envelope-fixture");
    expect(adapter.calls).toEqual([]);
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
    expect(child.listenerCount("close")).toBe(0);
    expect(child.listenerCount("exit")).toBe(0);
    expect(child.stdout.destroyed).toBe(true);
    expect(child.stderr.destroyed).toBe(true);
  });

  it("uses deployed secret list JSON and identifies the new Version without parsing put stdout", async () => {
    const adapter = adapterFor(fakeChild({ lines: [envelope()] }), successfulApplyOutcomes());
    const result = await runCapturePipeline({
      workerRoot: process.cwd(),
      configPath: "wrangler.production.toml",
      adapter,
      apply: true,
      timeoutMs: 1000,
      operationId,
    });
    expect(result).toEqual({
      status: "secrets_set",
      tail_stopped: true,
      worker_invocation_seen: true,
      valid_tail_envelope_seen: true,
      capture_event_seen: true,
      cloudflare_version_id: newVersion,
    });
    expect(adapter.calls.some((call) => call.command === "wrangler" && call.args.join(" ") === "secret list --format json --config wrangler.production.toml")).toBe(true);
    expect(adapter.calls.filter((call) => call.command === "wrangler" && call.args.slice(0, 2).join(" ") === "versions list")).toHaveLength(2);
    const secretCalls = adapter.calls.filter((call) => call.args.includes("LINE_GROUP_ID"));
    expect(secretCalls.every((call) => !call.args.includes("group-envelope-fixture"))).toBe(true);
    expect(secretCalls.every((call) => call.stdin === "group-envelope-fixture" || call.stdin === "")).toBe(true);
  });

  it("stops before writes when the secret list command or JSON parser fails", async () => {
    for (const cloudflareResult of [{ code: 1, stdout: "" }, { code: 0, stdout: "not-json" }]) {
      const adapter = adapterFor(fakeChild({ lines: [envelope()] }), {
        "gh:secret list --repo u3comp/okaz-slot-watcher --json name": { code: 0, stdout: "[]" },
        "wrangler:secret list --format json --config wrangler.production.toml": cloudflareResult,
      });
      const result = await runCapturePipeline({ workerRoot: process.cwd(), configPath: "wrangler.production.toml", adapter, apply: true, timeoutMs: 1000, operationId });
      expect(["cloudflare_secret_list_failed", "secret_list_json_invalid"]).toContain(result.status);
      expect(adapter.calls.filter((call) => call.args.includes("set") || call.args.includes("put"))).toHaveLength(0);
    }
  });

  it("records an unverified Cloudflare Version and only removes the GitHub secret", async () => {
    const outcomes = successfulApplyOutcomes();
    outcomes["wrangler:versions list --json --config wrangler.production.toml"] = [
      { code: 0, stdout: JSON.stringify([{ id: oldVersion, annotations: {} }]) },
      { code: 0, stdout: JSON.stringify([{ id: newVersion, annotations: {} }, { id: oldVersion, annotations: {} }]) },
    ];
    outcomes["gh:secret delete LINE_GROUP_ID --repo u3comp/okaz-slot-watcher"] = { code: 0 };
    const adapter = adapterFor(fakeChild({ lines: [envelope()] }), outcomes);
    const result = await runCapturePipeline({ workerRoot: process.cwd(), configPath: "wrangler.production.toml", adapter, apply: true, timeoutMs: 1000, operationId });
    expect(result).toEqual({
      status: "partial_cloudflare_secret_version_unverified",
      tail_stopped: true,
      worker_invocation_seen: true,
      valid_tail_envelope_seen: true,
      capture_event_seen: true,
      github_secret_cleanup_confirmed: true,
    });
    expect(adapter.calls.filter((call) => call.command === "gh" && call.args.includes("delete"))).toHaveLength(1);
    expect(adapter.calls.filter((call) => call.command === "wrangler" && call.args.includes("delete"))).toHaveLength(0);
  });

  it("rolls back a GitHub-only partial setup without retrying", async () => {
    const outcomes = successfulApplyOutcomes();
    outcomes[`wrangler:versions secret put LINE_GROUP_ID --tag ${tag} --message ${message} --config wrangler.production.toml`] = { code: 1, stdout: "" };
    outcomes["gh:secret delete LINE_GROUP_ID --repo u3comp/okaz-slot-watcher"] = { code: 0 };
    const adapter = adapterFor(fakeChild({ lines: [envelope()] }), outcomes);
    const result = await runCapturePipeline({ workerRoot: process.cwd(), configPath: "wrangler.production.toml", adapter, apply: true, timeoutMs: 1000, operationId });
    expect(result.status).toBe("partial_secret_state_rolled_back");
    expect(adapter.calls.filter((call) => call.args.includes("set"))).toHaveLength(1);
    expect(adapter.calls.filter((call) => call.args.includes("delete"))).toHaveLength(1);
  });
});

describe("tail child lifecycle", () => {
  it("recognizes an already closed process", async () => {
    const child = fakeChild({ initialExitCode: 0 });
    expect(await stopProcess(child, { gracefulTimeoutMs: 5, forceTimeoutMs: 5 })).toBe(true);
    expect(child.killSignals).toEqual([]);
  });

  it("waits for close after SIGTERM", async () => {
    const child = fakeChild({ killMode: "term-closes" });
    expect(await stopProcess(child, { gracefulTimeoutMs: 5, forceTimeoutMs: 5 })).toBe(true);
    expect(child.killSignals).toEqual(["SIGTERM"]);
  });

  it("uses SIGKILL only after a silent SIGTERM and confirms close", async () => {
    const child = fakeChild({ killMode: "force-closes" });
    expect(await stopProcess(child, { gracefulTimeoutMs: 5, forceTimeoutMs: 5 })).toBe(true);
    expect(child.killSignals).toEqual(["SIGTERM", "SIGKILL"]);
  });

  it("returns false if forced termination never closes and has no exit code", async () => {
    const child = fakeChild({ killMode: "never-closes" });
    expect(await stopProcess(child, { gracefulTimeoutMs: 5, forceTimeoutMs: 5 })).toBe(false);
    expect(child.killSignals).toEqual(["SIGTERM", "SIGKILL"]);
  });

  it("drains and releases stderr even when stdout ends first", async () => {
    const child = fakeChild({ lines: ["not-json"], stderrOpen: true });
    const adapter = adapterFor(child);
    const result = await runCapturePipeline({ workerRoot: process.cwd(), configPath: "wrangler.production.toml", adapter, timeoutMs: 1000 });
    expect(result).toEqual({
      status: "tail_disconnected",
      tail_stopped: true,
      worker_invocation_seen: false,
      valid_tail_envelope_seen: false,
      capture_event_seen: false,
    });
    expect(child.stderr.listenerCount("data")).toBe(0);
    expect(child.stderr.destroyed).toBe(true);
  });

  it("reports timeout using the real stop result", async () => {
    const child = fakeChild({ stdoutOpen: true });
    const result = await runCapturePipeline({
      workerRoot: process.cwd(),
      configPath: "wrangler.production.toml",
      adapter: adapterFor(child),
      timeoutMs: 5,
      stopGracefulTimeoutMs: 5,
      stopForceTimeoutMs: 5,
    });
    expect(result).toEqual({
      status: "timeout_no_worker_invocation",
      tail_stopped: true,
      worker_invocation_seen: false,
      valid_tail_envelope_seen: false,
      capture_event_seen: false,
    });
  });

  it("distinguishes an invocation without capture from an unparseable capture event", async () => {
    const withoutCapture = await runCapturePipeline({
      workerRoot: process.cwd(),
      configPath: "wrangler.production.toml",
      adapter: adapterFor(fakeChild({ chunks: [probeEnvelope()], stdoutOpen: true })),
      timeoutMs: 5,
      stopGracefulTimeoutMs: 5,
      stopForceTimeoutMs: 5,
    });
    expect(withoutCapture).toEqual({
      status: "timeout_worker_invocation_without_capture",
      tail_stopped: true,
      worker_invocation_seen: true,
      valid_tail_envelope_seen: true,
      capture_event_seen: false,
    });

    const truncatedCapture = [
      '{\n    "outcome": "ok",\n    "logs": [{"message": ["{\\"event\\":\\"line_group_id_capture\\""]}],\n',
    ];
    const unparseable = await runCapturePipeline({
      workerRoot: process.cwd(),
      configPath: "wrangler.production.toml",
      adapter: adapterFor(fakeChild({ chunks: truncatedCapture, stdoutOpen: true })),
      timeoutMs: 5,
      stopGracefulTimeoutMs: 5,
      stopForceTimeoutMs: 5,
    });
    expect(unparseable).toEqual({
      status: "timeout_capture_event_unparseable",
      tail_stopped: true,
      worker_invocation_seen: false,
      valid_tail_envelope_seen: false,
      capture_event_seen: false,
    });
  });

  it("performs zero secret writes when the tail cannot be stopped", async () => {
    const child = fakeChild({ lines: [envelope()], killMode: "never-closes" });
    const adapter = adapterFor(child, successfulApplyOutcomes());
    const result = await runCapturePipeline({
      workerRoot: process.cwd(),
      configPath: "wrangler.production.toml",
      adapter,
      apply: true,
      timeoutMs: 1000,
      stopGracefulTimeoutMs: 5,
      stopForceTimeoutMs: 5,
      operationId,
    });
    expect(result).toEqual({
      status: "tail_stop_failed",
      tail_stopped: false,
      worker_invocation_seen: true,
      valid_tail_envelope_seen: true,
      capture_event_seen: true,
    });
    expect(adapter.calls).toHaveLength(0);
  });
});
