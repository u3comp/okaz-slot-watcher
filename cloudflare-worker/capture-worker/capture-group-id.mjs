import { spawn as nodeSpawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import path from "node:path";

const UUID_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i;
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

async function collectLines(stream) {
  const reader = createInterface({ input: stream, crlfDelay: Infinity });
  return reader;
}

async function stopProcess(child) {
  if (!child || child.exitCode !== null || child.signalCode) return true;
  try { child.kill("SIGTERM"); } catch { return false; }
  const stopped = await Promise.race([
    new Promise((resolve) => child.once("close", () => resolve(true))),
    new Promise((resolve) => setTimeout(() => resolve(false), 2000)),
  ]);
  if (stopped) return true;
  try { child.kill("SIGKILL"); } catch { return false; }
  return true;
}

function commandResult(child, stdinValue) {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr?.on("data", (chunk) => { stderr += String(chunk); });
    child.once("error", () => resolve({ code: 1, stdout, stderr }));
    child.once("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
    if (child.stdin) { child.stdin.end(stdinValue); }
  });
}

function parseSecretNames(output) {
  const parsed = parseJson(output);
  if (Array.isArray(parsed)) return parsed.map((item) => typeof item === "string" ? item : item?.name).filter(Boolean);
  return output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
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
  const cloudflare = await adapter.wranglerCommand(["versions", "secret", "list", "--config", configPath]);
  if (cloudflare.code !== 0) return { ok: false, reason: "cloudflare_secret_list_failed" };
  return { ok: true, github: parseSecretNames(github.stdout), cloudflare: parseSecretNames(cloudflare.stdout) };
}

export async function runCapturePipeline({
  workerName = "line-group-id-endpoint",
  repository = "u3comp/okaz-slot-watcher",
  workerRoot,
  configPath,
  tailConfigPath = path.join(workerRoot, "capture-worker", "wrangler.toml"),
  timeoutMs = 120_000,
  apply = false,
  adapter = createProcessAdapter({ workerRoot }),
} = {}) {
  const tail = adapter.spawnProcess(
    process.execPath,
    [path.join(workerRoot, "node_modules", "wrangler", "bin", "wrangler.js"), "tail", workerName, "--format", "json", "--config", tailConfigPath],
    { cwd: workerRoot },
  );
  let groupId;
  let timedOut = false;
  try {
    const readTail = (async () => {
      const lines = await collectLines(tail.stdout);
      for await (const line of lines) {
        const found = extractGroupIdFromTailEnvelope(line);
        if (found) return found;
      }
      return undefined;
    })();
    const outcome = await Promise.race([
      readTail,
      new Promise((resolve) => setTimeout(() => resolve({ timeout: true }), timeoutMs)),
    ]);
    if (outcome && typeof outcome === "object" && outcome.timeout === true) timedOut = true;
    else groupId = outcome;
  } finally {
    await stopProcess(tail);
  }
  if (!groupId) return { status: timedOut ? "timeout" : "tail_disconnected", tail_stopped: true };
  if (!apply) return { status: "captured", tail_stopped: true, applied: false };

  const names = await readSecretNames(adapter, repository, configPath);
  if (!names.ok) return { status: names.reason, tail_stopped: true };
  if (names.github.includes("LINE_GROUP_ID") || names.cloudflare.includes("LINE_GROUP_ID")) {
    return { status: "secret_already_exists", tail_stopped: true };
  }
  const github = await adapter.command("gh", ["secret", "set", "LINE_GROUP_ID", "--repo", repository], groupId);
  if (github.code !== 0) return { status: "github_secret_set_failed", tail_stopped: true };
  const cloudflare = await adapter.wranglerCommand(["versions", "secret", "put", "LINE_GROUP_ID", "--config", configPath], groupId);
  if (cloudflare.code !== 0) {
    const rollback = await adapter.command("gh", ["secret", "delete", "LINE_GROUP_ID", "--repo", repository]);
    return { status: rollback.code === 0 ? "partial_secret_state_rolled_back" : "partial_secret_state", tail_stopped: true };
  }
  const versionId = cloudflare.stdout.match(UUID_PATTERN)?.[0];
  if (!versionId) {
    const rollback = await adapter.command("gh", ["secret", "delete", "LINE_GROUP_ID", "--repo", repository]);
    return { status: rollback.code === 0 ? "cloudflare_version_id_unavailable_rolled_back" : "partial_secret_state", tail_stopped: true };
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
