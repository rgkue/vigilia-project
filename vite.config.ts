import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ mode }) => {
  if (mode === "development") {
    const localEnv = loadEnv(mode, process.cwd(), "");
    const gatewayKey = localEnv.AI_GATEWAY_API_KEY;
    if (gatewayKey && !process.env.AI_GATEWAY_API_KEY) {
      process.env.AI_GATEWAY_API_KEY = gatewayKey;
    }
  }

  return {
    plugins: [react(), {
      name: "vigilia-jev-local-function",
      configureServer(server) {
        server.middlewares.use("/api/jev", async (request, response) => {
          try {
            const chunks: Uint8Array[] = [];
            for await (const chunk of request) {
              chunks.push(typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk);
            }
            const rawBody = new TextDecoder().decode(Buffer.concat(chunks));
            const requestHost = typeof request.headers.host === "string"
              ? request.headers.host
              : "localhost:5173";
            const localRequest = new Request(`http://${requestHost}/api/jev`, {
              method: request.method ?? "GET",
              headers: {
                ...(typeof request.headers.origin === "string" ? { origin: request.headers.origin } : {}),
                ...(typeof request.headers["x-forwarded-for"] === "string" ? { "x-forwarded-for": request.headers["x-forwarded-for"] } : {}),
                ...(typeof request.headers["content-type"] === "string" ? { "content-type": request.headers["content-type"] } : {}),
              },
              ...(request.method === "GET" || request.method === "HEAD" ? {} : { body: rawBody }),
            });
            const { handleJevRequest } = await import("./src/server/jevEvaluation");
            const result = await handleJevRequest(localRequest);
            response.statusCode = result.status;
            response.setHeader("Content-Type", "application/json; charset=utf-8");
            response.setHeader("Cache-Control", "no-store");
            response.end(await result.text());
          } catch {
            if (response.headersSent) return;
            response.statusCode = 500;
            response.setHeader("Content-Type", "application/json; charset=utf-8");
            response.end(JSON.stringify({ error: "La ruta local de Jev no pudo completar la solicitud." }));
          }
        });
      },
    }],
    server: { port: 5173 },
  };
});
