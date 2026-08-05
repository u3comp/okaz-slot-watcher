import { spawn as nodeSpawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import path from "node:path";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const GROUP_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

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
  timeoutMs = 120_000,
  stopGracefulTimeoutMs = 2000,
  stopForceTimeoutMs = 2000,
  apply = false,
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
  let lineReader;
  let tailStopped = false;
  const drainStderr = () => undefined;
  tail.stderr?.on("data", drainStderr);
  try {
    lineReader = createInterface({ input: tail.stdout, crlfDelay: Infinity });
    const readTail = (async () => {
      try {
        for await (const line of lineReader) {
          const found = extractGroupIdFromTailEnvelope(line);
          if (found) return found;
        }
      } catch {
        return undefined;
      }
      return undefined;
    })();
    const timeout = new Promise((resolve) => {
      timeoutHandle = setTimeout(() => resolve({ timeout: true }), timeoutMs);
    });
    const outcome = await Promise.race([readTail, timeout]);
    if (outcome && typeof outcome === "object" && outcome.timeout === true) timedOut = true;
    else groupId = outcome;
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
    lineReader?.close();
    tailStopped = await stopProcess(tail, {
      gracefulTimeoutMs: stopGracefulTimeoutMs,
      forceTimeoutMs: stopForceTimeoutMs,
    });
    tail.stderr?.removeListener("data", drainStderr);
    tail.stdout?.destroy();
    tail.stderr?.destroy();
  }

  if (!tailStopped) return { status: "tail_stop_failed", tail_stopped: false };
  if (!groupId) return { status: timedOut ? "timeout" : "tail_disconnected", tail_stopped: true };
  if (!apply) return { status: "captured", tail_stopped: true, applied: false };

  const names = await readSecretNames(adapter, repository, configPath);
  if (!names.ok) return { status: names.reason, tail_stopped: true };
  if (names.github.includes("LINE_GROUP_ID") || names.cloudflare.includes("LINE_GROUP_ID")) {
    return { status: "secret_already_exists", tail_stopped: true };
  }
  const before = await readVersions(adapter, configPath);
  if (!before.ok) return { status: before.reason, tail_stopped: true };

  const github = await adapter.command("gh", ["secret", "set", "LINE_GROUP_ID", "--repo", repository], groupId);
  if (github.code !== 0) return { status: "github_secret_set_failed", tail_stopped: true };

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
    return { status: rollback.code === 0 ? "partial_secret_state_rolled_back" : "partial_secret_state", tail_stopped: true };
  }

  const after = await readVersions(adapter, configPath);
  const versionId = after.ok ? identifyCreatedVersion(before.versions, after.versions, tag, message) : undefined;
  if (!versionId) {
    const rollback = await adapter.command("gh", ["secret", "delete", "LINE_GROUP_ID", "--repo", repository]);
    return {
      status: "partial_cloudflare_secret_version_unverified",
      tail_stopped: true,
      github_secret_cleanup_confirmed: rollback.code === 0,
    };
  }
  return { status: "secrets_set", tail_stopped: true, cloudflare_version_id: versionId };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const apply = process.argv.includes("--apply");
  const workerRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const result = await runCapturePipeline({
    workerName: process.env.CAPTURE_WORKER_NAME || "line-group-id-endpoint",
    repository: process.env.GITHUB_REPOSITORY || "u3comp/okaz-slot-watcher",
    workerRoot,
    configPath: path.join(workerRoot, "wrangler.production.toml"),
    apply,
  });
  // Never print IDs or child output. This status is intentionally coarse.
  console.log(`capture_status=${result.status}`);
  console.log(`tail_stopped=${result.tail_stopped === true}`);
}
