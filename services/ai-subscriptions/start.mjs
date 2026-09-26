import { spawn } from "node:child_process";
import { mkdir, access, writeFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { createServer as tcpServer } from "node:net";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { once } from "node:events";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = process.env.VIGILIA_SUBSCRIPTIONS_DATA_DIR;
const password = process.env.VIGILIA_OPENCODE_PASSWORD;
if (!root || !path.isAbsolute(root) || !password) throw new Error("Configura el directorio privado y la contraseña del conector.");
const directory = fileURLToPath(new URL(".", import.meta.url));
const resolved = path.resolve(root);
const repo = path.resolve(directory, "../..");
const relative = path.relative(repo, resolved);
if (!relative.startsWith("..") && !path.isAbsolute(relative)) throw new Error("Guarda las sesiones fuera del repositorio.");
const accountRoot = path.join(resolved, "personal-v1");
const revokedRoot = path.join(resolved, "revoked-v1");
await mkdir(accountRoot, { recursive: true, mode: 0o700 });
await mkdir(revokedRoot, { recursive: true, mode: 0o700 });
const workers = new Map();
const pending = new Map();
const revoked = new Set();
let closing = false;
const capacity = Number(process.env.VIGILIA_SUBSCRIPTIONS_MAX_WORKERS || 12);
if (!Number.isInteger(capacity) || capacity < 1 || capacity > 128) throw new Error("Límite de procesos inválido.");
const auth = Buffer.from("Basic " + Buffer.from(`opencode:${password}`).toString("base64"));
const cli = path.join(directory, "node_modules/opencode-ai/bin", process.platform === "win32" ? "opencode.exe" : "opencode");
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function freePort() {
  const listener = tcpServer();
  listener.listen(0, "127.0.0.1");
  await once(listener, "listening");
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  return port;
}
async function isRevoked(id) {
  if (revoked.has(id)) return true;
  try { await access(path.join(revokedRoot, id)); return true; } catch (error) { if (error.code === "ENOENT") return false; throw error; }
}
async function stop(worker) {
  if (!worker || worker.stopped) return;
  worker.stopped = true;
  if (workers.get(worker.id) === worker) workers.delete(worker.id);
  if (worker.child.exitCode === null && worker.child.signalCode === null) {
    const exited = once(worker.child, "exit").catch(() => {});
    worker.child.kill();
    await Promise.race([exited, sleep(3000)]);
    if (worker.child.exitCode === null && worker.child.signalCode === null) {
      worker.child.kill("SIGKILL");
      await exited;
    }
  }
}
async function launch(id) {
  if (closing) throw new Error("closing");
  if (await isRevoked(id)) throw new Error("revoked");
  if (workers.size >= capacity) {
    const idle = [...workers.values()].filter(w => !w.active && w.ready).sort((a,b) => a.lastUsed-b.lastUsed)[0];
    if (!idle) throw new Error("capacity");
    await stop(idle);
  }
  const userRoot = path.join(accountRoot, id);
  const workspace = path.join(userRoot, "workspace");
  await mkdir(workspace, { recursive: true, mode: 0o700 });
  const env = Object.fromEntries(["PATH", "Path", "SystemRoot", "SYSTEMROOT", "WINDIR", "LANG"].filter(key => process.env[key]).map(key => [key, process.env[key]]));
  for (const [name, subdir] of Object.entries({ HOME: "home", USERPROFILE: "home", APPDATA: "appdata", LOCALAPPDATA: "localappdata", TEMP: "temp", TMP: "temp", XDG_CONFIG_HOME: "config", XDG_DATA_HOME: "data", XDG_CACHE_HOME: "cache", XDG_STATE_HOME: "state" })) {
    env[name] = path.join(userRoot, subdir);
    await mkdir(env[name], { recursive: true, mode: 0o700 });
  }
  const childPassword = randomBytes(32).toString("hex");
  Object.assign(env, {
    OPENCODE_SERVER_PASSWORD: childPassword, OPENCODE_SERVER_USERNAME: "opencode",
    OPENCODE_DISABLE_CLAUDE_CODE: "true", OPENCODE_DISABLE_EXTERNAL_SKILLS: "true",
    OPENCODE_DISABLE_PROJECT_CONFIG: "true", OPENCODE_DISABLE_LSP_DOWNLOAD: "true",
    OPENCODE_CONFIG_CONTENT: JSON.stringify({
      enabled_providers: ["openai", "xai"], autoupdate: false, share: "disabled",
      permission: "deny", tools: { "*": false }, mcp: {},
      agent: { "vigilia-classifier": { mode: "primary", description: "Clasificación administrativa sin herramientas",
        steps: 1, permission: "deny", tools: { "*": false },
        prompt: "Clasifica únicamente el texto recibido. Responde JSON. No uses herramientas ni accedas a archivos." } }
    })
  });
  const port = await freePort();
  const child = spawn(cli, ["serve", "--hostname", "127.0.0.1", "--port", String(port)], { cwd: workspace, env, windowsHide: true, stdio: "ignore" });
  const worker = { id, child, port, active: 0, lastUsed: Date.now(), ready: false, stopped: false,
    authorization: "Basic " + Buffer.from(`opencode:${childPassword}`).toString("base64") };
  workers.set(id, worker);
  child.on("error", () => { worker.stopped = true; if (workers.get(id) === worker) workers.delete(id); });
  child.on("exit", () => { worker.stopped = true; if (workers.get(id) === worker) workers.delete(id); });
  try {
    for (let i = 0; i < 80; i++) {
      if (worker.stopped || await isRevoked(id)) throw new Error("unavailable");
      try {
        const response = await fetch(`http://127.0.0.1:${port}/global/health`, { headers: { authorization: worker.authorization }, signal: AbortSignal.timeout(500) });
        if (response.ok) { worker.ready = true; return worker; }
      } catch {}
      await sleep(150);
    }
    throw new Error("unavailable");
  } catch (error) { await stop(worker); throw error; }
}
// Serialize process creation so concurrent accounts cannot exceed the process budget.
let launches = Promise.resolve();
async function ensure(id) {
  if (closing) throw new Error("closing");
  if (await isRevoked(id)) throw new Error("revoked");
  const current = workers.get(id);
  if (current?.ready && !current.stopped) return current;
  if (!pending.has(id)) {
    const job = launches.then(() => launch(id));
    launches = job.catch(() => {});
    pending.set(id, job);
    job.finally(() => pending.delete(id)).catch(() => {});
  }
  return pending.get(id);
}
function reply(response, status, value) {
  if (!response.destroyed) response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }).end(JSON.stringify(value));
}
const server = createServer(async (request, response) => {
  const supplied = Buffer.from(request.headers.authorization || "");
  if (supplied.length !== auth.length || !timingSafeEqual(supplied, auth)) return reply(response, 401, { error: "unauthorized" });
  if (request.url === "/health" && request.method === "GET") return reply(response, 200, { protocol: "personal-v1" });
  if (request.url === "/shutdown" && request.method === "POST") {
    reply(response, 200, { stopping: true });
    void shutdown();
    return;
  }
  const match = /^\/accounts\/([a-f0-9]{64})(\/[^?]*)?$/.exec(request.url || "");
  if (!match) return reply(response, 404, { error: "not_found" });
  const [, id, route = ""] = match;
  let worker;
  const aborter = new AbortController();
  response.on("close", () => aborter.abort());
  try {
    if (!route && request.method === "DELETE") {
      revoked.add(id);
      await writeFile(path.join(revokedRoot, id), "revoked", { mode: 0o600 });
      const launching = pending.get(id);
      if (launching) await launching.catch(() => {});
      await stop(workers.get(id));
      const target = path.resolve(accountRoot, id);
      if (path.dirname(target) !== accountRoot) throw new Error("path");
      await rm(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      return reply(response, 200, { removed: true });
    }
    const allowed = (request.method === "GET" && ["/provider", "/provider/auth"].includes(route))
      || (request.method === "POST" && (/^\/provider\/(openai|xai)\/oauth\/(authorize|callback)$/.test(route) || route === "/session" || /^\/session\/[a-zA-Z0-9_-]+\/(message|abort)$/.test(route)))
      || (request.method === "DELETE" && /^\/session\/[a-zA-Z0-9_-]+$/.test(route));
    if (!allowed) return reply(response, 404, { error: "not_found" });
    const chunks = [];
    let size = 0;
    for await (const chunk of request) { size += chunk.length; if (size > 1_000_000) return reply(response, 413, { error: "too_large" }); chunks.push(chunk); }
    worker = await ensure(id);
    if (worker.stopped || await isRevoked(id)) throw new Error("revoked");
    worker.active++;
    const upstream = await fetch(`http://127.0.0.1:${worker.port}${route}`, {
      method: request.method, headers: { authorization: worker.authorization, "content-type": "application/json" },
      body: ["GET", "HEAD"].includes(request.method) ? undefined : Buffer.concat(chunks),
      signal: AbortSignal.any([aborter.signal, AbortSignal.timeout(550_000)]), redirect: "error"
    });
    const bytes = [];
    let received = 0;
    for await (const chunk of upstream.body) { received += chunk.length; if (received > 4_000_000) throw new Error("too_large"); bytes.push(chunk); }
    if (!response.destroyed) response.writeHead(upstream.status, { "content-type": "application/json", "cache-control": "no-store" }).end(Buffer.concat(bytes));
  } catch { reply(response, 503, { error: "connector_unavailable" }); }
  finally { if (worker) { worker.active = Math.max(0, worker.active - 1); worker.lastUsed = Date.now(); } }
});
server.requestTimeout = 560_000;
server.headersTimeout = 15_000;
const timer = setInterval(() => { for (const worker of workers.values()) if (worker.ready && !worker.active && Date.now()-worker.lastUsed > 900_000) void stop(worker); }, 60_000);
timer.unref();
const port = Number(process.env.VIGILIA_OPENCODE_PORT || 4096);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Puerto inválido.");
server.listen(port, "127.0.0.1", () => console.log(`Conector personal de Vigilia en 127.0.0.1:${port}.`));
async function shutdown() {
  if (closing) return;
  closing = true;
  server.close(); clearInterval(timer);
  await launches;
  await Promise.all([...workers.values()].map(stop));
  process.exit(0);
}
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => void shutdown());
