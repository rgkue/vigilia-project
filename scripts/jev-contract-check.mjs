const baseUrl = process.env.VIGILIA_BASE_URL ?? "http://127.0.0.1:5173";
const appOrigin = new URL(baseUrl).origin;
const endpoint = new URL("/api/jev", appOrigin);
const checks = [];

function record(name, passed) {
  checks.push({ name, passed });
}

const statusResponse = await fetch(endpoint, { headers: { Accept: "application/json" } });
let statusPayload;
try {
  statusPayload = await statusResponse.json();
} catch {
  statusPayload = null;
}
record(
  "GET reports Jev model and configuration state",
  statusResponse.status === 200
    && statusPayload?.model === "typesafe-ai/jev"
    && typeof statusPayload?.configured === "boolean"
    && typeof statusPayload?.zdrRequired === "boolean",
);

const foreignOriginResponse = await fetch(endpoint, {
  method: "POST",
  headers: {
    Accept: "application/json",
    "Content-Type": "application/json",
    Origin: "https://cross-origin.invalid",
  },
  body: JSON.stringify({ caseId: "vig-demo-01" }),
});
record("POST rejects a foreign Origin before evaluation", foreignOriginResponse.status === 403);

const unsupportedMethodResponse = await fetch(endpoint, { method: "PUT" });
record("unsupported methods return 405", unsupportedMethodResponse.status === 405);

const invalidPayloadResponse = await fetch(endpoint, {
  method: "POST",
  headers: {
    Accept: "application/json",
    "Content-Type": "application/json",
    Origin: appOrigin,
  },
  body: "{",
});
record(
  "invalid JSON never reaches Jev",
  invalidPayloadResponse.status === 400,
);

const unknownCaseResponse = await fetch(endpoint, {
  method: "POST",
  headers: {
    Accept: "application/json",
    "Content-Type": "application/json",
    Origin: appOrigin,
  },
  body: JSON.stringify({ caseId: "not-an-approved-fixture" }),
});
record("unlisted cases never reach Jev", unknownCaseResponse.status === 400);

for (const check of checks) {
  console.log(`${check.passed ? "PASS" : "FAIL"} ${check.name}`);
}

if (checks.some((check) => !check.passed)) process.exitCode = 1;
