import { spawn as nodeSpawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";
import path from "node:path";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const GROUP_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const CAPTURE_EVENT_MARKER = "line_group_id_capture";
const DEFAULT_TIMEOUT_SECONDS = 600;
const MIN_TIMEOUT_SECONDS = 60;
const MAX_TIMEOUT_SECONDS = 900;
const MAX_TAIL_FRAME_CHARS = 1_048_576;

function parseJson(value) {
  if (typeof value !== "string") return value;
  try { return JSON.parse(value); } catch { return undefined; }
}

export function extractGroupIdFromTailEnvelope(input) {
  const envelope = parseJson(input);
  if (!envelope || typeof envelope !== "object" || !Array.isArray(envelope.logs)) return undefined;
  for (const log of envelope.logs) {
    if (!log || typeof log !== "object" || !Array.isArray(log.message)) continue;
    for (const message of log.message) {
      const event = parseJson(message);
      if (!event || typeof event !== "object") continue;
      if (event.event !== "line_group_id_capture" || typeof event.group_id !== "string") continue;
      if (GROUP_ID_PATTERN.test(event.group_id)) return event.group_id;
    }
  }
  return undefined;
}

function captureEventDetails(envelope) {
  let captureEventSeen = false;
  let captureEventUnparseable = false;
  let groupId;
  if (!envelope || typeof envelope !== "object" || !Array.isArray(envelope.logs)) {
    return { captureEventSeen, captureEventUnparseable, groupId };
  }
  for (const log of envelope.logs) {
    if (!log || typeof log !== "object" || !Array.isArray(log.message)) continue;
    for (const message of log.message) {
      const parsed = parseJson(message);
      if (!parsed || typeof parsed !== "object") {
        if (typeof message === "string" && message.includes(CAPTURE_EVENT_MARKER)) captureEventUnparseable = true;
        continue;
      }
      if (parsed.event !== "line_group_id_capture") continue;
      captureEventSeen = true;
      if (typeof parsed.group_id === "string" && GROUP_ID_PATTERN.test(parsed.group_id) && !groupId) {
        groupId = parsed.group_id;
      } else if (!groupId) {
        captureEventUnparseable = true;
      }
    }
  }
  return { captureEventSeen, captureEventUnparseable, groupId };
}

function httpStatusFromEnvelope(envelope) {
  const candidates = [
    envelope?.event?.response?.status,
    envelope?.event?.response?.statusCode,
    envelope?.response?.status,
    envelope?.response?.statusCode,
  ];
  return candidates.find((value) => Number.isInteger(value) && value >= 100 && value <= 599);
}

export function inspectTailEnvelope(input) {
  const envelope = parseJson(input);
  if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) {
    return {
      valid_tail_envelope_seen: false,
      worker_invocation_seen: false,
      capture_event_seen: false,
      capture_event_unparseable: false,
    };
  }
  const validTailEnvelope = typeof envelope.outcome === "string" && Array.isArray(envelope.logs);
  const workerInvocation = validTailEnvelope && envelope.event && typeof envelope.event === "object" && envelope.event.request && typeof envelope.event.request === "object";
  const capture = captureEventDetails(envelope);
  return {
    valid_tail_envelope_seen: validTailEnvelope,
    worker_invocation_seen: Boolean(workerInvocation),
    capture_event_seen: capture.captureEventSeen,
    capture_event_unparseable: capture.captureEventUnparseable,
    group_id: capture.groupId,
    outcome: typeof envelope.outcome === "string" ? envelope.outcome : undefined,
    http_status: httpStatusFromEnvelope(envelope),
  };
}

export function createTailJsonFrameParser(onObject, { maxFrameChars = MAX_TAIL_FRAME_CHARS } = {}) {
  let frame = "";
  let stack = [];
  let inString = false;
  let escaped = false;
  let linePrefixIsWhitespace = true;
  let captureEventUnparseable = false;

  const resetFrame = () => {
    frame = "";
    stack = [];
    inString = false;
    escaped = false;
  };

  const markInvalidFrame = () => {
    if (frame.includes(CAPTURE_EVENT_MARKER)) captureEventUnparseable = true;
    resetFrame();
  };

  const emitFrame = () => {
    try {
      const parsed = JSON.parse(frame);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) onObject(parsed);
    } catch {
      if (frame.includes(CAPTURE_EVENT_MARKER)) captureEventUnparseable = true;
    }
    resetFrame();
    linePrefixIsWhitespace = true;
  };

  const push = (value) => {
    const text = String(value);
    for (const char of text) {
      if (stack.length === 0) {
        if (char === "\n") {
          linePrefixIsWhitespace = true;
          continue;
        }
        if (char === "\r" || char === " " || char === "\t") continue;
        if (char === "{" && linePrefixIsWhitespace) {
          frame = "{";
          stack = ["{"];
          inString = false;
          escaped = false;
          linePrefixIsWhitespace = false;
          continue;
        }
        linePrefixIsWhitespace = false;
        continue;
      }

      frame += char;
      if (frame.length > maxFrameChars) {
        markInvalidFrame();
        linePrefixIsWhitespace = false;
        continue;
      }
      if (inString) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === '"') inString = false;
        continue;
      }
      if (char === '"') {
        inString = true;
        continue;
      }
      if (char === "{" || char === "[") {
        stack.push(char);
        continue;
      }
      if (char === "}" || char === "]") {
        const expected = char === "}" ? "{" : "[";
        if (stack.at(-1) !== expected) {
          markInvalidFrame();
          linePrefixIsWhitespace = false;
          continue;
        }
        stack.pop();
        if (stack.length === 0) emitFrame();
      }
    }
  };

  const finish = () => {
    if (frame) markInvalidFrame();
    return { capture_event_unparseable: captureEventUnparseable };
  };

  return { push, finish };
}

export function parseCliOptions(argv) {
  let apply = false;
  let probe = false;
  let timeoutSeconds = DEFAULT_TIMEOUT_SECONDS;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--apply") {
      apply = true;
      continue;
    }
    if (arg === "--probe") {
      probe = true;
      continue;
    }
    if (arg === "--timeout-seconds") {
      const value = argv[index + 1];
      if (!value || !/^\d+$/.test(value)) throw new Error("invalid_arguments");
      timeoutSeconds = Number(value);
      index += 1;
      continue;
    }
    throw new Error("invalid_arguments");
  }
  if (apply && probe) throw new Error("invalid_arguments");
  if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < MIN_TIMEOUT_SECONDS || timeoutSeconds > MAX_TIMEOUT_SECONDS) {
    throw new Error("invalid_arguments");
  }
  return { apply, probe, timeoutSeconds };
}

function projectWrangler(workerRoot) {
  return { command: process.execPath, prefix: [path.join(workerRoot, "node_modules", "wrangler", "bin", "wrangler.js")] };
}

function defaultSpawn(command, args, options) {
  return nodeSpawn(command, args, { ...options, stdio: ["pipe", "pipe", "pipe"] });
}

function processHasStopped(child) {
  return child.exitCode !== null || child.signalCode !== null;
}

function waitForProcessStop(child, timeoutMs) {
  if (processHasStopped(child)) return Promise.resolve(true);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (stopped) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.removeListener("close", onStop);
      child.removeListener("exit", onStop);
      resolve(stopped || processHasStopped(child));
    };
    const onStop = () => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    child.once("close", onStop);
    child.once("exit", onStop);
  });
}

export async function stopProcess(child, { gracefulTimeoutMs = 2000, forceTimeoutMs = 2000 } = {}) {
  if (!child || processHasStopped(child)) return true;
  try {
    if (child.kill("SIGTERM") === false) return false;
  } catch {
    return false;
  }
  if (await waitForProcessStop(child, gracefulTimeoutMs)) return true;
  try {
    if (child.kill("SIGKILL") === false) return false;
  } catch {
    return false;
  }
  return waitForProcessStop(child, forceTimeoutMs);
}

function commandResult(child, stdinValue) {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const onStdout = (chunk) => { stdout += String(chunk); };
    const onStderr = (chunk) => { stderr += String(chunk); };
    const finish = (code) => {
      if (settled) return;
      settled = true;
      child.stdout?.removeListener("data", onStdout);
      child.stderr?.removeListener("data", onStderr);
      child.removeListener("error", onError);
      child.removeListener("close", onClose);
      resolve({ code, stdout, stderr });
    };
    const onError = () => finish(1);
    const onClose = (code) => finish(code ?? 1);
    child.stdout?.on("data", onStdout);
    child.stderr?.on("data", onStderr);
    child.once("error", onError);
    child.once("close", onClose);
    try {
      child.stdin?.end(stdinValue);
    } catch {
      finish(1);
    }
  });
}

export function parseSecretNamesJson(output) {
  const parsed = parseJson(output);
  if (!Array.isArray(parsed)) throw new Error("secret_list_json_invalid");
  const names = [];
  for (const item of parsed) {
    if (!item || typeof item !== "object" || typeof item.name !== "string") {
      throw new Error("secret_list_json_invalid");
    }
    names.push(item.name);
  }
  return names;
}

export function parseVersionListJson(output) {
  const parsed = parseJson(output);
  const items = Array.isArray(parsed) ? parsed : parsed && typeof parsed === "object" && Array.isArray(parsed.versions) ? parsed.versions : undefined;
  if (!items) throw new Error("version_list_json_invalid");
  return items.map((item) => {
    if (!item || typeof item !== "object" || typeof item.id !== "string" || !UUID_PATTERN.test(item.id)) {
      throw new Error("version_list_json_invalid");
    }
    return item;
  });
}

function versionAnnotation(version, key) {
  const annotations = version.annotations;
  if (annotations && typeof annotations === "object" && typeof annotations[key] === "string") return annotations[key];
  if (key === "workers/tag" && typeof version.tag === "string") return version.tag;
  if (key === "workers/message" && typeof version.message === "string") return version.message;
  return undefined;
}

export function identifyCreatedVersion(before, after, tag, message) {
  const beforeIds = new Set(before.map((version) => version.id));
  const candidates = after.filter((version) => (
    !beforeIds.has(version.id)
    && versionAnnotation(version, "workers/tag") === tag
    && versionAnnotation(version, "workers/message") === message
  ));
  return candidates.length === 1 ? candidates[0].id : undefined;
}

export function createProcessAdapter({ spawnProcess = defaultSpawn, workerRoot }) {
  const wrangler = projectWrangler(workerRoot);
  const command = (name, args, stdin = "") => commandResult(spawnProcess(name, args, { cwd: workerRoot }), stdin);
  const wranglerCommand = (args, stdin = "") => commandResult(spawnProcess(wrangler.command, [...wrangler.prefix, ...args], { cwd: workerRoot }), stdin);
  return { spawnProcess, command, wranglerCommand };
}

async function readSecretNames(adapter, repository, configPath) {
  const github = await adapter.command("gh", ["secret", "list", "--repo", repository, "--json", "name"]);
  if (github.code !== 0) return { ok: false, reason: "github_secret_list_failed" };
  const cloudflare = await adapter.wranglerCommand(["secret", "list", "--format", "json", "--config", configPath]);
  if (cloudflare.code !== 0) return { ok: false, reason: "cloudflare_secret_list_failed" };
  try {
    return { ok: true, github: parseSecretNamesJson(github.stdout), cloudflare: parseSecretNamesJson(cloudflare.stdout) };
  } catch {
    return { ok: false, reason: "secret_list_json_invalid" };
  }
}

async function readVersions(adapter, configPath) {
  const result = await adapter.wranglerCommand(["versions", "list", "--json", "--config", configPath]);
  if (result.code !== 0) return { ok: false, reason: "cloudflare_versions_list_failed" };
  try {
    return { ok: true, versions: parseVersionListJson(result.stdout) };
  } catch {
    return { ok: false, reason: "cloudflare_versions_json_invalid" };
  }
}

export async function runCapturePipeline({
  workerName = "line-group-id-endpoint",
  repository = "u3comp/okaz-slot-watcher",
  workerRoot,
  configPath,
  tailConfigPath = path.join(workerRoot, "capture-worker", "wrangler.toml"),
  timeoutMs = DEFAULT_TIMEOUT_SECONDS * 1000,
  stopGracefulTimeoutMs = 2000,
  stopForceTimeoutMs = 2000,
  apply = false,
  probe = false,
  adapter = createProcessAdapter({ workerRoot }),
  operationId = randomUUID(),
} = {}) {
  const tail = adapter.spawnProcess(
    process.execPath,
    [path.join(workerRoot, "node_modules", "wrangler", "bin", "wrangler.js"), "tail", workerName, "--format", "json", "--config", tailConfigPath],
    { cwd: workerRoot },
  );
  let groupId;
  let timedOut = false;
  let timeoutHandle;
  let removeTailReaderListeners = () => undefined;
  let finishTailReader = () => undefined;
  let tailStopped = false;
  const tailState = {
    worker_invocation_seen: false,
    valid_tail_envelope_seen: false,
    capture_event_seen: false,
    capture_event_unparseable: false,
    healthy_probe_seen: false,
    http_status: undefined,
  };
  const drainStderr = () => undefined;
  tail.stderr?.on("data", drainStderr);
  try {
    const readTail = new Promise((resolve) => {
      let settled = false;
      let readerFinished = false;
      const decoder = new StringDecoder("utf8");
      const finish = (outcome) => {
        if (settled) return;
        settled = true;
        resolve(outcome);
      };
      const parser = createTailJsonFrameParser((envelope) => {
        if (settled) return;
        const observed = inspectTailEnvelope(envelope);
        tailState.worker_invocation_seen ||= observed.worker_invocation_seen;
        tailState.valid_tail_envelope_seen ||= observed.valid_tail_envelope_seen;
        tailState.capture_event_seen ||= observed.capture_event_seen;
        tailState.capture_event_unparseable ||= observed.capture_event_unparseable;
        if (observed.http_status !== undefined) tailState.http_status = observed.http_status;
        if (observed.group_id) groupId = observed.group_id;

        if (probe) {
          if (tailState.capture_event_seen) finish({ kind: "probe_capture_event_seen" });
          else if (observed.worker_invocation_seen && observed.outcome === "ok" && observed.http_status === 200) {
            tailState.healthy_probe_seen = true;
            finish({ kind: "probe_success" });
          }
        } else if (groupId) {
          finish({ kind: "capture" });
        }
      });
      const onData = (chunk) => {
        if (!settled) parser.push(typeof chunk === "string" ? chunk : decoder.write(chunk));
      };
      const finalizeReader = () => {
        if (readerFinished) return;
        readerFinished = true;
        parser.push(decoder.end());
        const parserState = parser.finish();
        tailState.capture_event_unparseable ||= parserState.capture_event_unparseable;
      };
      const onEnd = () => {
        if (settled) return;
        finalizeReader();
        finish({ kind: "disconnected" });
      };
      const onError = () => finish({ kind: "disconnected" });
      tail.stdout?.on("data", onData);
      tail.stdout?.once("end", onEnd);
      tail.stdout?.once("close", onEnd);
      tail.stdout?.once("error", onError);
      if (!tail.stdout) finish({ kind: "disconnected" });
      finishTailReader = finalizeReader;
      removeTailReaderListeners = () => {
        tail.stdout?.removeListener("data", onData);
        tail.stdout?.removeListener("end", onEnd);
        tail.stdout?.removeListener("close", onEnd);
        tail.stdout?.removeListener("error", onError);
      };
    });
    const timeout = new Promise((resolve) => {
      timeoutHandle = setTimeout(() => resolve({ timeout: true }), timeoutMs);
    });
    const outcome = await Promise.race([readTail, timeout]);
    if (outcome && typeof outcome === "object" && outcome.timeout === true) timedOut = true;
    else if (outcome?.kind === "probe_capture_event_seen") tailState.capture_event_seen = true;
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
    removeTailReaderListeners();
    finishTailReader();
    tailStopped = await stopProcess(tail, {
      gracefulTimeoutMs: stopGracefulTimeoutMs,
      forceTimeoutMs: stopForceTimeoutMs,
    });
    tail.stderr?.removeListener("data", drainStderr);
    tail.stdout?.destroy();
    tail.stderr?.destroy();
  }

  const diagnostics = {
    worker_invocation_seen: tailState.worker_invocation_seen,
    valid_tail_envelope_seen: tailState.valid_tail_envelope_seen,
    capture_event_seen: tailState.capture_event_seen,
  };
  const result = (status, extra = {}) => ({ status, tail_stopped: tailStopped, ...diagnostics, ...extra });
  if (!tailStopped) return result("tail_stop_failed");
  if (probe) {
    if (tailState.capture_event_seen) return result("probe_capture_event_seen", { http_status: tailState.http_status });
    if (tailState.healthy_probe_seen) {
      return result("worker_invocation_seen", { http_status: 200 });
    }
    if (tailState.capture_event_unparseable) return result("timeout_capture_event_unparseable");
    if (tailState.worker_invocation_seen) return result("timeout_worker_invocation_without_capture", { http_status: tailState.http_status });
    return result(timedOut ? "timeout_no_worker_invocation" : "tail_disconnected");
  }
  if (!groupId) {
    if (!timedOut) return result("tail_disconnected");
    if (tailState.capture_event_unparseable) return result("timeout_capture_event_unparseable");
    if (tailState.worker_invocation_seen) return result("timeout_worker_invocation_without_capture");
    return result("timeout_no_worker_invocation");
  }
  if (!apply) return result("captured", { applied: false });

  const names = await readSecretNames(adapter, repository, configPath);
  if (!names.ok) return result(names.reason);
  if (names.github.includes("LINE_GROUP_ID") || names.cloudflare.includes("LINE_GROUP_ID")) {
    return result("secret_already_exists");
  }
  const before = await readVersions(adapter, configPath);
  if (!before.ok) return result(before.reason);

  const github = await adapter.command("gh", ["secret", "set", "LINE_GROUP_ID", "--repo", repository], groupId);
  if (github.code !== 0) return result("github_secret_set_failed");

  const tag = `line-group-id-secret-${operationId}`;
  const message = `Add LINE_GROUP_ID secret version ${operationId}; do not deploy`;
  const cloudflare = await adapter.wranglerCommand([
    "versions", "secret", "put", "LINE_GROUP_ID",
    "--tag", tag,
    "--message", message,
    "--config", configPath,
  ], groupId);
  if (cloudflare.code !== 0) {
    const rollback = await adapter.command("gh", ["secret", "delete", "LINE_GROUP_ID", "--repo", repository]);
    return result(rollback.code === 0 ? "partial_secret_state_rolled_back" : "partial_secret_state");
  }

  const after = await readVersions(adapter, configPath);
  const versionId = after.ok ? identifyCreatedVersion(before.versions, after.versions, tag, message) : undefined;
  if (!versionId) {
    const rollback = await adapter.command("gh", ["secret", "delete", "LINE_GROUP_ID", "--repo", repository]);
    return result("partial_cloudflare_secret_version_unverified", {
      github_secret_cleanup_confirmed: rollback.code === 0,
    });
  }
  return result("secrets_set", { cloudflare_version_id: versionId });
}

export function formatCliResultLines(result, { probe = false } = {}) {
  if (probe) {
    return [
      `probe_status=${result.status}`,
      `tail_stopped=${result.tail_stopped === true}`,
      `http_status=${result.http_status ?? "unavailable"}`,
      `capture_event_seen=${result.capture_event_seen === true}`,
    ];
  }
  return [
    `capture_status=${result.status}`,
    `tail_stopped=${result.tail_stopped === true}`,
    `worker_invocation_seen=${result.worker_invocation_seen === true}`,
    `valid_tail_envelope_seen=${result.valid_tail_envelope_seen === true}`,
    `capture_event_seen=${result.capture_event_seen === true}`,
  ];
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = parseCliOptions(process.argv.slice(2));
    const workerRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    const result = await runCapturePipeline({
      workerName: process.env.CAPTURE_WORKER_NAME || "line-group-id-endpoint",
      repository: process.env.GITHUB_REPOSITORY || "u3comp/okaz-slot-watcher",
      workerRoot,
      configPath: path.join(workerRoot, "wrangler.production.toml"),
      apply: options.apply,
      probe: options.probe,
      timeoutMs: options.timeoutSeconds * 1000,
    });
    // Never print IDs, raw Tail data, request details, or child output.
    for (const line of formatCliResultLines(result, { probe: options.probe })) console.log(line);
  } catch {
    console.log("capture_status=invalid_arguments");
    console.log("tail_stopped=false");
    process.exitCode = 2;
  }
}
