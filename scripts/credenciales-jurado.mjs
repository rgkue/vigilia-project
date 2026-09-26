#!/usr/bin/env node
/**
 * Genera las credenciales de evaluación del jurado y las variables de Vercel de ambas instalaciones.
 *
 *   node scripts/credenciales-jurado.mjs --demo-url https://vigilia-demo.vercel.app \
 *     --produccion-url https://vigilia-app.vercel.app
 *
 * Escribe en entrega-privada/ (excluida de git):
 *   - vercel-produccion.env y vercel-demo.env: pégalos en Vercel → Settings → Environment Variables.
 *   - credenciales-jurado.md: texto para el correo al jurado.
 *   - qr-jurado-admin.png y qr-jurado-recepcion.png: QR para la app autenticadora.
 * No sobrescribe una carpeta existente salvo con --forzar (cambiar los secretos invalida los anteriores).
 */
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import QRCode from "qrcode";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "entrega-privada");
const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, value, index, all) => {
  if (value.startsWith("--")) pairs.push([value.slice(2), all[index + 1]?.startsWith("--") ? true : all[index + 1] ?? true]);
  return pairs;
}, []));

const demoUrl = String(args["demo-url"] ?? "").replace(/\/+$/, "");
const productionUrl = String(args["produccion-url"] ?? "").replace(/\/+$/, "");
if (!/^https:\/\/[^/]+$/.test(demoUrl) || !/^https:\/\/[^/]+$/.test(productionUrl)) {
  console.error("Indica las dos direcciones públicas: --demo-url https://... --produccion-url https://...");
  process.exit(2);
}
if (existsSync(outDir) && !args.forzar) {
  console.error(`Ya existe ${outDir}. Usa --forzar solo si quieres reemplazar TODAS las credenciales del jurado.`);
  process.exit(3);
}

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const base32 = (bytes) => {
  let bits = 0, value = 0, output = "";
  for (const byte of bytes) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { output += BASE32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  return bits > 0 ? output + BASE32[(value << (5 - bits)) & 31] : output;
};
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789";
const readable = (length) => Array.from(randomBytes(length), (byte) => ALPHABET[byte % ALPHABET.length]).join("");
const fernetKey = () => randomBytes(32).toString("base64").replace(/\+/g, "-").replace(/\//g, "_");
const otpauth = (id, secret) => `otpauth://totp/${encodeURIComponent(`Vigilia:${id}`)}?secret=${secret}&issuer=Vigilia&algorithm=SHA1&digits=6&period=30`;

const admin = { id: "JURADO-ADMIN", totp: base32(randomBytes(20)), password: `${readable(5)}-${readable(5)}-${readable(5)}-${readable(5)}` };
const reception = { id: "JURADO-RECEPCION", totp: base32(randomBytes(20)) };
const ingressToken = `vig_${randomBytes(30).toString("base64url")}`;
// Clave del webhook demo: se publica en el README para que el jurado pueda repetir la prueba.
const demoKey = typeof args["clave-demo"] === "string" ? args["clave-demo"] : "vigilia-jurado-2026";

const shared = `# Enlaces del selector de modo (los dos proyectos usan los mismos valores)
VIGILIA_DEMO_URL=${demoUrl}
VIGILIA_PRODUCTION_URL=${productionUrl}
# IA compartida del equipo (nunca la subas al repositorio)
VIGILIA_SHARED_AI_PROVIDER=ollama
VIGILIA_SHARED_AI_MODEL=gpt-oss:20b
VIGILIA_SHARED_AI_KEY=PEGA_AQUI_TU_CLAVE_DE_OLLAMA_CLOUD
# Avisos a Slack (URLs de tus Incoming Webhooks)
SLACK_ENABLED=true
SLACK_WEBHOOK_ADMISIONES=PEGA_AQUI_EL_WEBHOOK_DE_ADMISIONES
SLACK_WEBHOOK_GESTOR=PEGA_AQUI_EL_WEBHOOK_DEL_GESTOR
VITE_LIVE_INGRESS_ENABLED=true
`;

const productionEnv = `# Proyecto de Vercel en modo PRODUCCIÓN (${productionUrl})
# Conserva DATABASE_URL, VIGILIA_SESSION_SECRET y VIGILIA_SECRET_ENCRYPTION_KEY que ya tiene el proyecto.
VIGILIA_MODE=production
VIGILIA_AI_APPROVED=true
VIGILIA_SIMULATED_SYSTEMS=true
VIGILIA_SIMULATED_BASE_URL=${productionUrl}/api/simulado
VIGILIA_JURY_ADMIN_PASSWORD=${admin.password}
VIGILIA_JURY_ADMIN_TOTP=${admin.totp}
VIGILIA_JURY_EMPLOYEE_TOTP=${reception.totp}
VIGILIA_JURY_INGRESS_TOKEN=${ingressToken}
${shared}`;

const demoEnv = `# Proyecto de Vercel en modo DEMO (${demoUrl})
VIGILIA_MODE=demo
DATABASE_URL=PEGA_AQUI_LA_CADENA_DE_CONEXION_DE_LA_BASE_vigilia_demo_EN_NEON
VIGILIA_SESSION_SECRET=${randomBytes(36).toString("base64url")}
VIGILIA_SECRET_ENCRYPTION_KEY=${fernetKey()}
VIGILIA_KEY=${demoKey}
${shared}`;

const sheet = `# Credenciales de evaluación · Vigilia (Reto 4)

Todos los datos de ambas instalaciones son ficticios.

## 1. Modo Demo (recomendado para evaluar)
- Enlace: ${demoUrl}
- Acceso: en "Credenciales sintéticas de demostración", pulsa **Usar QR del administrador demo** y luego **Simular inicio corporativo (demo)**. No necesita contraseña.
- Webhook de prueba: \`POST ${demoUrl}/api/webhook/ingreso\` con la cabecera \`X-Vigilia-Key: ${demoKey}\`.

## 2. Modo Producción (cómo lo usaría un hospital)
- Enlace: ${productionUrl}
- Añade las cuentas a una app autenticadora (Google Authenticator, Microsoft Authenticator, Authy…) escaneando el QR adjunto o escribiendo la clave de configuración.

| Cuenta | ID de acceso | Clave TOTP (configuración manual) | Contraseña |
|---|---|---|---|
| Administración | \`${admin.id}\` | \`${admin.totp}\` | \`${admin.password}\` |
| Recepción | \`${reception.id}\` | \`${reception.totp}\` | No usa contraseña |

Cómo entrar: pulsa "No tengo mi gafete · escribir mi ID", escribe el ID, introduce el código de 6 dígitos de la app y, en Administración, la contraseña. Si un código es rechazado, espera al siguiente (cada código sirve una sola vez).

Webhook con la credencial de integración del HIS simulado:

\`\`\`
POST ${productionUrl}/api/webhook/ingreso
X-Vigilia-Integration: sim-ingreso-his
Authorization: Bearer ${ingressToken}
\`\`\`

Cuerpo en el formato del HIS (Vigilia lo traduce con el mapeo configurado en Administración → Integraciones):

\`\`\`json
{"evento": {"id": "EVT-JURADO-001", "fecha": "2026-09-26T10:00:00-05:00"},
 "paciente": {"cedula": "8-100-100"}, "hospital": {"nombre": "Hospital Demo"},
 "atencion": {"motivo": "Crisis asmática con dificultad para respirar", "triage": 2}}
\`\`\`

Asegurados ficticios: 8-100-100 (asma leve), 8-200-200 (póliza vencida), 8-300-300 (en carencia), 8-400-400 (hipertensión y diabetes), 8-500-500 (pago atrasado), 9-999-999 (no existe).
`;

mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, "vercel-produccion.env"), productionEnv);
writeFileSync(join(outDir, "vercel-demo.env"), demoEnv);
writeFileSync(join(outDir, "credenciales-jurado.md"), sheet);
await QRCode.toFile(join(outDir, "qr-jurado-admin.png"), otpauth(admin.id, admin.totp), { width: 360, margin: 2 });
await QRCode.toFile(join(outDir, "qr-jurado-recepcion.png"), otpauth(reception.id, reception.totp), { width: 360, margin: 2 });
console.log(`Credenciales generadas en ${outDir}`);
console.log("1) Completa los PEGA_AQUI_... de los dos .env y pégalos en cada proyecto de Vercel.");
console.log("2) Envía credenciales-jurado.md y los dos QR al jurado junto con el enlace y el repositorio.");
