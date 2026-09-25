import type { JevEvaluation } from "../types";

export interface JevStatus {
  configured: boolean;
  model: "typesafe-ai/jev";
  promotionEnds: string;
}

async function responseJson<T>(response: Response): Promise<T> {
  const body: unknown = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = body !== null && typeof body === "object" && "error" in body
      && typeof body.error === "string"
      ? body.error
      : `La evaluación de Jev respondió HTTP ${response.status}.`;
    throw new Error(message);
  }
  return body as T;
}

export async function loadJevStatus(): Promise<JevStatus> {
  const response = await fetch("/api/jev", { headers: { Accept: "application/json" } });
  return responseJson<JevStatus>(response);
}

export async function evaluateJevCase(caseId: string): Promise<JevEvaluation> {
  const response = await fetch("/api/jev", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ caseId }),
  });
  return responseJson<JevEvaluation>(response);
}
