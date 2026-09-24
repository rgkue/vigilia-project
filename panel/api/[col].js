import { db, init, authorized } from '../lib/db.js';

const S = (v, n) => String(v ?? '').slice(0, n);
const TABLES = {
  tasks: {
    list: 'SELECT id, ord, phase, title, status, assignee FROM tasks ORDER BY ord',
    out: (r) => ({ id: r.id, order: r.ord, phase: r.phase, title: r.title, status: r.status, assignee: r.assignee }),
    upsert: 'INSERT INTO tasks (id, ord, phase, title, status, assignee) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET ord=excluded.ord, phase=excluded.phase, title=excluded.title, status=excluded.status, assignee=excluded.assignee',
    args: (t) => [S(t.id, 60), Number(t.order) || 0, S(t.phase, 60), S(t.title, 300), S(t.status || 'Pendiente', 20), S(t.assignee, 60)],
    valid: (t) => t.id && t.title,
  },
  branches: {
    list: 'SELECT id, name, reason, created_by, created_at FROM branches ORDER BY created_at DESC',
    out: (r) => ({ id: r.id, name: r.name, reason: r.reason, by: r.created_by, createdAt: r.created_at }),
    upsert: 'INSERT OR REPLACE INTO branches (id, name, reason, created_by, created_at) VALUES (?, ?, ?, ?, ?)',
    args: (b) => [S(b.id, 60), S(b.name, 120), S(b.reason, 600), S(b.by, 60), S(b.createdAt, 40) || new Date().toISOString()],
    valid: (b) => b.id && b.name && b.reason,
  },
};

export default async function handler(req, res) {
  const col = String(req.query.col);
  const T = Object.hasOwn(TABLES, col) ? TABLES[col] : null;
  if (!T) return res.status(404).json({ error: 'ruta' });
  res.setHeader('Cache-Control', 'no-store');
  try {
    await init();
    if (req.method === 'GET') {
      const r = await db.execute(T.list);
      return res.status(200).json(r.rows.map(T.out));
    }
    if (!authorized(req)) return res.status(401).json({ error: 'clave' });
    if (req.method === 'PUT') {
      const body = req.body || {};
      if (!T.valid(body)) return res.status(400).json({ error: 'datos' });
      await db.execute({ sql: T.upsert, args: T.args(body) });
      return res.status(200).json({ ok: true });
    }
    if (req.method === 'DELETE') {
      await db.execute({ sql: `DELETE FROM ${col} WHERE id = ?`, args: [S(req.query.id, 60)] });
      return res.status(200).json({ ok: true });
    }
    return res.status(405).json({ error: 'metodo' });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'servidor' });
  }
}
