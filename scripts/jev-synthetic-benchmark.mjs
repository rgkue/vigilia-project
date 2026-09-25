const baseUrl = process.env.VIGILIA_BASE_URL ?? "http://127.0.0.1:5173";
const endpoint = new URL("/api/jev", new URL(baseUrl).origin);
const parsedRepeats = Number.parseInt(process.env.JEV_BENCHMARK_REPEATS ?? "2", 10);
const repeats = Number.isInteger(parsedRepeats) && parsedRepeats >= 1 && parsedRepeats <= 3
  ? parsedRepeats
  : 2;

const scenarios = [
  {
    caseId: "vig-demo-01",
    accepts: (relations) => relations.every((relation) => relation === "NINGUNA" || relation === "PENDIENTE"),
    expectation: "sin relación positiva inferida; puede quedar pendiente",
  },
  {
    caseId: "vig-demo-04",
    accepts: (relations) => relations.includes("POSIBLE") && !relations.includes("DIRECTA"),
    expectation: "al menos una sugerencia posible, ninguna directa",
  },
];

function logResult(passed, name, detail = "") {
  console.log(`${passed ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
}

const statusResponse = await fetch(endpoint, { headers: { Accept: "application/json" } }).catch(() => null);
if (!statusResponse?.ok) {
  console.error("BLOCKED: no se pudo consultar el estado del endpoint local.");
  process.exitCode = 2;
} else {
  const status = await statusResponse.json().catch(() => null);
  if (status?.model !== "typesafe-ai/jev" || typeof status.configured !== "boolean") {
    console.error("BLOCKED: el endpoint devolvió un estado inesperado.");
    process.exitCode = 2;
  } else if (!status.configured) {
    console.log("SKIP Jev no tiene una credencial privada configurada; no se hizo ninguna llamada al modelo.");
  } else {
    const samples = new Map(scenarios.map(({ caseId }) => [caseId, []]));
    let failures = 0;

    for (const scenario of scenarios) {
      for (let repeat = 1; repeat <= repeats; repeat += 1) {
        const response = await fetch(endpoint, {
          method: "POST",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
            Origin: endpoint.origin,
          },
          body: JSON.stringify({ caseId: scenario.caseId }),
        }).catch(() => null);

        if (!response?.ok) {
          failures += 1;
          logResult(false, `${scenario.caseId} muestra ${repeat}/${repeats}`, `HTTP ${response?.status ?? "sin respuesta"}`);
          continue;
        }

        const payload = await response.json().catch(() => null);
        const suggestions = Array.isArray(payload?.suggestions) ? payload.suggestions : [];
        const relations = suggestions.map((item) => item?.relation);
        const validShape = payload?.model === "typesafe-ai/jev"
          && suggestions.length > 0
          && suggestions.every((item) => item?.source === "jev" && item?.reviewRequired === true);
        const meetsExpectation = validShape && scenario.accepts(relations);
        samples.get(scenario.caseId).push(relations);
        if (!meetsExpectation) failures += 1;
        logResult(
          meetsExpectation,
          `${scenario.caseId} muestra ${repeat}/${repeats}`,
          validShape ? `relaciones ${relations.join(", ")}; criterio: ${scenario.expectation}` : "formato de respuesta no válido",
        );
      }
    }

    for (const [caseId, runs] of samples) {
      if (runs.length < 2) continue;
      const stable = runs.every((relations) => JSON.stringify(relations) === JSON.stringify(runs[0]));
      logResult(stable, `${caseId} repetibilidad`, stable ? "mismo resultado en cada muestra" : "resultado variable entre muestras");
      if (!stable) failures += 1;
    }

    console.log("NOTA: benchmark de humo con dos escenarios ficticios; no demuestra exactitud clínica ni aprobación para producción.");
    if (failures > 0) process.exitCode = 1;
  }
}
