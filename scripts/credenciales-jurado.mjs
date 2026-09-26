#!/usr/bin/env node
/**
 * Genera las credenciales de evaluación del jurado y las variables de Vercel de la instalación.
 *
 *   node scripts/credenciales-jurado.mjs --url https://vigilia-health.vercel.app
 *
 * Demo y Producción viven en la misma instalación (modo producción con VIGILIA_DEMO_ACCESS=true).
 * Escribe en entrega-privada/ (excluida de git):
 *   - vercel.env: pégalo en Vercel → Settings → Environment Variables (Production).
 *   - credenciales-jurado.md: texto para el correo al jurado.
 *   - qr-jurado-admin.png y qr-jurado-recepcion.png: QR para la app autenticadora.
 * Si ya hay credenciales generadas, las conserva (igual que la clave de IA y las URLs de Slack ya
 * rellenadas); --nuevas crea otras, lo que invalida las que ya enviaste o configuraste.
 */
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import QRCode from "qrcode";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "entrega-privada");
const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, value, index, all) => {
  if (value.startsWith("--")) pairs.push([value.slice(2), all[index + 1]?.startsWith("--") ? true : all[index + 1] ?? true]);
  return pairs;
}, []));

const appUrl = String(args.url ?? "").replace(/\/+$/, "");
if (!/^https:\/\/[^/]+$/.test(appUrl)) {
  console.error("Indica la dirección pública de la instalación: --url https://vigilia-health.vercel.app");
  process.exit(2);
}
// Valores ya generados (vercel.env actual o los archivos de la versión con dos instalaciones).
const previous = {};
if (!args.nuevas) {
  for (const name of ["vercel.env", "vercel-produccion.env"]) {
    const file = join(outDir, name);
    if (!existsSync(file)) continue;
    for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
      const match = line.match(/^([A-Z_]+)=(.*)$/);
      if (match && !match[2].startsWith("PEGA_AQUI") && !(match[1] in previous)) previous[match[1]] = match[2];
    }
  }
}
const keep = (name, fallback) => previous[name] || fallback;
const placeholder = (name, text) => previous[name] || text;

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
const otpauth = (id, secret) => `otpauth://totp/${encodeURIComponent(`Vigilia:${id}`)}?secret=${secret}&issuer=Vigilia&algorithm=SHA1&digits=6&period=30`;

const admin = {
  id: "JURADO-ADMIN",
  totp: keep("VIGILIA_JURY_ADMIN_TOTP", base32(randomBytes(20))),
  password: keep("VIGILIA_JURY_ADMIN_PASSWORD", `${readable(5)}-${readable(5)}-${readable(5)}-${readable(5)}`),
};
const reception = { id: "JURADO-RECEPCION", totp: keep("VIGILIA_JURY_EMPLOYEE_TOTP", base32(randomBytes(20))) };
const ingressToken = keep("VIGILIA_JURY_INGRESS_TOKEN", `vig_${randomBytes(30).toString("base64url")}`);
// Clave del webhook del modo Demo: se publica en el README para que el jurado pueda repetir la prueba.
const demoKey = typeof args["clave-demo"] === "string" ? args["clave-demo"] : keep("VIGILIA_KEY", "vigilia-jurado-2026");

const env = `# Instalación de Vigilia en Vercel (${appUrl}): modo Producción con el modo Demo dentro.
# Conserva DATABASE_URL, VIGILIA_SESSION_SECRET y VIGILIA_SECRET_ENCRYPTION_KEY que ya tiene el proyecto.
VIGILIA_MODE=production
VIGILIA_AI_APPROVED=true
# Modo Demo sin credenciales y webhook de demostración con clave pública
VIGILIA_DEMO_ACCESS=true
VIGILIA_KEY=${demoKey}
# Aseguradora y receptores de avisos simulados, conectados como integraciones
VIGILIA_SIMULATED_SYSTEMS=true
VIGILIA_SIMULATED_BASE_URL=${appUrl}/api/simulado
# Cuentas y token del jurado (modo Producción)
VIGILIA_JURY_ADMIN_PASSWORD=${admin.password}
VIGILIA_JURY_ADMIN_TOTP=${admin.totp}
VIGILIA_JURY_EMPLOYEE_TOTP=${reception.totp}
VIGILIA_JURY_INGRESS_TOKEN=${ingressToken}
# IA compartida del equipo (nunca la subas al repositorio)
VIGILIA_SHARED_AI_PROVIDER=ollama
VIGILIA_SHARED_AI_MODEL=gpt-oss:20b
VIGILIA_SHARED_AI_KEY=${placeholder("VIGILIA_SHARED_AI_KEY", "PEGA_AQUI_TU_CLAVE_DE_OLLAMA_CLOUD")}
# Avisos a Slack (URLs de tus Incoming Webhooks)
SLACK_ENABLED=true
SLACK_WEBHOOK_ADMISIONES=${placeholder("SLACK_WEBHOOK_ADMISIONES", "PEGA_AQUI_EL_WEBHOOK_DE_ADMISIONES")}
SLACK_WEBHOOK_GESTOR=${placeholder("SLACK_WEBHOOK_GESTOR", "PEGA_AQUI_EL_WEBHOOK_DEL_GESTOR")}
VITE_LIVE_INGRESS_ENABLED=true
`;

const sheet = `# Credenciales de evaluación · Vigilia (Reto 4)

Aplicación: ${appUrl}. Al abrirla eliges el modo; los dos usan la misma instalación y datos ficticios.

## 1. Modo Demo (recomendado para evaluar)
- Elige **Demo** y pulsa **Entrar modo Demo**: entras al instante, sin usuario ni contraseña.
- Webhook de prueba: \`POST ${appUrl}/api/webhook/ingreso\` con la cabecera \`X-Vigilia-Key: ${demoKey}\` (instrucciones en el README).

## 2. Modo Producción (cómo lo usaría un hospital)
Añade las cuentas a una app autenticadora (Google Authenticator, Microsoft Authenticator, Authy…) escaneando el QR adjunto o escribiendo la clave de configuración.

| Cuenta | ID de acceso | Clave TOTP (configuración manual) | Contraseña |
|---|---|---|---|
| Administración | \`${admin.id}\` | \`${admin.totp}\` | \`${admin.password}\` |
| Recepción | \`${reception.id}\` | \`${reception.totp}\` | No usa contraseña |

Cómo entrar: elige **Producción**, pulsa "No tengo mi gafete · escribir mi ID", escribe el ID, introduce el código de 6 dígitos de la app y, en Administración, la contraseña. Si un código es rechazado, espera al siguiente (cada código sirve una sola vez).

Webhook con la credencial de integración del HIS simulado:

\`\`\`
POST ${appUrl}/api/webhook/ingreso
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
writeFileSync(join(outDir, "vercel.env"), env);
writeFileSync(join(outDir, "credenciales-jurado.md"), sheet);
await QRCode.toFile(join(outDir, "qr-jurado-admin.png"), otpauth(admin.id, admin.totp), { width: 360, margin: 2 });
await QRCode.toFile(join(outDir, "qr-jurado-recepcion.png"), otpauth(reception.id, reception.totp), { width: 360, margin: 2 });
console.log(`Credenciales ${Object.keys(previous).length && !args.nuevas ? "actualizadas (se conservaron las existentes)" : "generadas"} en ${outDir}`);
console.log("1) Completa los PEGA_AQUI_... de vercel.env y pégalo en las variables del proyecto de Vercel.");
console.log("2) Envía credenciales-jurado.md y los dos QR al jurado junto con el enlace y el repositorio.");
