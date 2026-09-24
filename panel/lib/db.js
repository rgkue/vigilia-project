import { createClient } from '@libsql/client';
import { timingSafeEqual } from 'node:crypto';

export const db = createClient({ url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN });

const PHASES = ['Fundamentos', 'Núcleo del sistema', 'Entrega'];
const SEED = [
[0,'Definir el contrato de datos: formato del evento de ingreso y de la respuesta del agente'],
[0,'Crear la estructura del repositorio y el archivo README base'],
[0,'Crear las tablas de SQLite y el script de datos de prueba (5 casos: póliza vigente, vencida, en carencia, con preexistencia y asegurado inexistente)'],
[1,'Endpoint POST /webhook/ingreso que reciba el evento de ingreso'],
[1,'Reglas exactas en código: vigencia, estado de pago y período de carencia'],
[1,'Agente con Claude: cruzar motivo de ingreso con preexistencias, asignar nivel de alerta y redactar un mensaje por destinatario'],
[1,'Notificaciones simultáneas a Slack (admisiones y gestor de casos) y registro en la base de datos'],
[1,'Pruebas con los casos de prueba'],
[2,'Despliegue con enlace público (hacerlo temprano, aunque sea la versión básica)'],
[2,'README con ejemplo de comando curl y aclaración de que la alerta es administrativa'],
[2,'Probar el enlace público y enviar el correo con los dos entregables']];

let ready;
export function init() {
  ready ??= (async () => {
    await db.batch([
      'CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, ord INTEGER, phase TEXT, title TEXT, status TEXT, assignee TEXT)',
      'CREATE TABLE IF NOT EXISTS branches (id TEXT PRIMARY KEY, name TEXT, reason TEXT, created_by TEXT, created_at TEXT)',
      'CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT)',
    ], 'write');
    const m = await db.execute("SELECT v FROM meta WHERE k = 'seeded'");
    if (!m.rows.length) {
      await db.batch([
        ...SEED.map((s, i) => ({
          sql: "INSERT OR IGNORE INTO tasks VALUES (?, ?, ?, ?, 'Pendiente', '')",
          args: ['t' + String(i + 1).padStart(2, '0'), i + 1, PHASES[s[0]], s[1]],
        })),
        "INSERT OR IGNORE INTO meta VALUES ('seeded', '1')",
      ], 'write');
    }
  })().catch((e) => { ready = undefined; throw e; });
  return ready;
}

export function authorized(req) {
  const k = process.env.TEAM_KEY || '';
  const a = Buffer.from(k), b = Buffer.from(String(req.headers['x-team-key'] || ''));
  return k.length > 0 && a.length === b.length && timingSafeEqual(a, b);
}
