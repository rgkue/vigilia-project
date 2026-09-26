// Uses only generated temporary directories and fake credentials; no inference or login.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm, access } from "node:fs/promises";
import { createServer } from "node:net";
import { once } from "node:events";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

test("broker isolates accounts, rejects stale generations and excludes legacy credentials", { timeout: 90000 }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "vigilia-isolation-"));
  const a = "a".repeat(64), b = "b".repeat(64);
  for (const [directory, provider] of [[path.join(root, "data", "opencode"), "xai"], [path.join(root, "personal-v1", a, "data", "opencode"), "openai"]]) {
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, "auth.json"), JSON.stringify({ [provider]: { type: "api", key: "fictitious-test-only-key" } }));
  }
  const listener = createServer(); listener.listen(0, "127.0.0.1"); await once(listener, "listening");
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  const env = Object.fromEntries(["PATH", "Path", "SystemRoot", "SYSTEMROOT", "WINDIR", "TEMP", "TMP"].filter(key => process.env[key]).map(key => [key, process.env[key]]));
  Object.assign(env, { VIGILIA_SUBSCRIPTIONS_DATA_DIR: root, VIGILIA_OPENCODE_PORT: String(port), VIGILIA_OPENCODE_PASSWORD: "fixture-broker-password" });
  const child = spawn(process.execPath, [fileURLToPath(new URL("./start.mjs", import.meta.url))], { env, windowsHide: true, stdio: "ignore" });
  const exited = once(child, "exit");
  const authorization = "Basic " + Buffer.from("opencode:fixture-broker-password").toString("base64");
  const call = (route, method = "GET") => fetch(`http://127.0.0.1:${port}${route}`, { method, headers: { authorization }, signal: AbortSignal.timeout(25000) });
  try {
    let ready = false;
    for (let i = 0; i < 50; i++) {
      try { if ((await call("/health")).ok) { ready = true; break; } } catch {}
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert(ready, "broker starts");
    assert.equal((await fetch(`http://127.0.0.1:${port}/health`)).status, 401);
    const [ra, rb] = await Promise.all([call(`/accounts/${a}/provider`), call(`/accounts/${b}/provider`)]);
    assert.equal(ra.status, 200); assert.equal(rb.status, 200);
    const [ca, cb] = await Promise.all([ra.json(), rb.json()]);
    assert(ca.connected.includes("openai"));
    assert(!ca.connected.includes("xai"));
    assert(!cb.connected.includes("openai") && !cb.connected.includes("xai"));
    assert.equal((await call(`/accounts/${a}`, "DELETE")).status, 200);
    await assert.rejects(access(path.join(root, "personal-v1", a)));
    assert.equal((await call(`/accounts/${a}/provider`)).status, 503);
    assert.equal((await call(`/accounts/${b}/provider`)).status, 200);
    assert.equal((await call(`/accounts/${b}/config`)).status, 404);
  } finally {
    // Graceful shutdown is HTTP-authenticated so Windows also cleans up child workers.
    await call("/shutdown", "POST").catch(() => child.kill("SIGTERM"));
    await exited;
    assert(path.basename(root).startsWith("vigilia-isolation-") && path.dirname(root) === path.resolve(tmpdir()));
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
