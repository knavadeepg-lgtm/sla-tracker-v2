const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');
const db = require('./db');
const sla = require('./sla');
const { runEscalation } = require('./escalation');
const { seed } = require('./seed');

const CATEGORIES = ['Billing', 'Technical', 'Account', 'General'];
const app = express();

// Basic security: secure headers, body size limit, rate limiting, parameterised SQL, XSS-safe UI.
app.use(helmet({ contentSecurityPolicy: { useDefaults: true, directives: { 'upgrade-insecure-requests': null } } }));
app.use(express.json({ limit: '10kb' }));
app.use('/api', rateLimit({ windowMs: 60_000, limit: 600, message: { error: 'Too many requests, slow down' } }));
app.use(express.static(path.join(__dirname, '..', 'public')));
app.use('/vendor', express.static(path.join(__dirname, '..', 'node_modules', 'chart.js', 'dist')));

// ---------- helpers ----------
const wrap = (fn) => (req, res, next) => { try { fn(req, res); } catch (e) { next(e); } };
const SELECT = `SELECT t.*, a.name AS agent_name, a.team AS team FROM tickets t LEFT JOIN agents a ON a.id = t.agent_id`;
const getTicket = (id) => db.prepare(SELECT + ' WHERE t.id = ?').get(id);
const getPolicy = (p) => db.prepare('SELECT * FROM sla_policies WHERE priority = ?').get(p);
const enrich = (t, now = new Date()) => ({ ...t, ...sla.view(t, now) });
const log = (id, event, detail) =>
  db.prepare('INSERT INTO ticket_history (ticket_id, event, detail, at) VALUES (?,?,?,?)').run(id, event, detail, new Date().toISOString());
function update(id, fields) {
  const keys = Object.keys(fields); // keys come from our own code only, values are bound parameters
  if (!keys.length) return;
  db.prepare(`UPDATE tickets SET ${keys.map((k) => k + ' = ?').join(', ')} WHERE id = ?`).run(...keys.map((k) => fields[k]), id);
}
function needTicket(req) {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) throw sla.fail('Invalid ticket id');
  const t = getTicket(id);
  if (!t) throw sla.fail('Ticket not found', 404);
  return t;
}
const RANK = { on_track: 0, at_risk: 1, breached: 2 };

// ---------- routes ----------
app.get('/api/meta', wrap((req, res) => {
  res.json({
    agents: db.prepare('SELECT * FROM agents ORDER BY id').all(),
    policies: db.prepare('SELECT * FROM sla_policies ORDER BY first_response_mins').all(),
    categories: CATEGORIES,
    statuses: sla.STATUSES,
  });
}));

app.get('/api/tickets', wrap((req, res) => {
  const { team, priority, status, sla: slaFilter, dueBefore } = req.query;
  const now = new Date();
  let rows = db.prepare(SELECT).all().map((t) => enrich(t, now));
  if (team) rows = rows.filter((t) => t.team === team);
  if (priority) rows = rows.filter((t) => t.priority === priority);
  if (status) rows = rows.filter((t) => t.status === status);
  if (slaFilter) rows = rows.filter((t) => t.overall === slaFilter);
  if (dueBefore) {
    const d = new Date(dueBefore);
    if (isNaN(d)) throw sla.fail('dueBefore must be a valid date');
    rows = rows.filter((t) => t.status !== 'resolved' && new Date(t.resolution_due) <= d);
  }
  rows.sort((a, b) => RANK[b.overall] - RANK[a.overall] || new Date(a.resolution_due) - new Date(b.resolution_due));
  res.json(rows);
}));

app.post('/api/tickets', wrap((req, res) => {
  const b = req.body || {};
  const errs = [];
  const ref = String(b.customer_ref ?? '').trim();
  const desc = String(b.description ?? '').trim();
  if (!/^[A-Za-z0-9-]{3,20}$/.test(ref)) errs.push('customer_ref must be 3-20 letters/numbers/dashes (e.g. CUST-0042)');
  if (!CATEGORIES.includes(b.category)) errs.push(`category must be one of ${CATEGORIES.join(', ')}`);
  const policy = getPolicy(b.priority);
  if (!policy) errs.push('priority must match an existing SLA policy');
  if (desc.length < 5 || desc.length > 500) errs.push('description must be 5-500 characters');
  let agentId = null;
  if (b.agent_id !== undefined && b.agent_id !== null && b.agent_id !== '') {
    agentId = Number(b.agent_id);
    if (!db.prepare('SELECT 1 FROM agents WHERE id = ?').get(agentId)) errs.push('agent_id does not exist');
  }
  if (errs.length) throw sla.fail(errs.join('; '));

  const now = new Date().toISOString();
  const d = sla.computeDeadlines({ created_at: now, resolution_start: now, paused_total_mins: 0 }, policy);
  const info = db.prepare(
    `INSERT INTO tickets (customer_ref, category, priority, description, status, agent_id, created_at, resolution_start,
      response_due, resolution_due) VALUES (?,?,?,?, 'open', ?,?,?,?,?)`)
    .run(ref, b.category, b.priority, desc, agentId, now, now, d.response_due, d.resolution_due);
  const id = info.lastInsertRowid;
  log(id, 'created', `Ticket created with priority ${b.priority}. Response due ${d.response_due}, resolution due ${d.resolution_due}`);
  if (agentId) log(id, 'assigned', `Assigned to agent #${agentId}`);
  res.status(201).json(enrich(getTicket(id)));
}));

app.get('/api/tickets/:id', wrap((req, res) => {
  const t = needTicket(req);
  const history = db.prepare('SELECT * FROM ticket_history WHERE ticket_id = ? ORDER BY at, id').all(t.id);
  res.json({ ...enrich(t), history });
}));

app.patch('/api/tickets/:id/assign', wrap((req, res) => {
  const t = needTicket(req);
  const raw = req.body?.agent_id;
  let agent = null;
  if (raw !== null && raw !== undefined && raw !== '') {
    agent = db.prepare('SELECT * FROM agents WHERE id = ?').get(Number(raw));
    if (!agent) throw sla.fail('agent_id does not exist');
  }
  update(t.id, { agent_id: agent ? agent.id : null });
  log(t.id, 'assigned', agent ? `Assigned to ${agent.name} (${agent.team})` : 'Unassigned');
  res.json(enrich(getTicket(t.id)));
}));

app.patch('/api/tickets/:id/status', wrap((req, res) => {
  const t = needTicket(req);
  const next = req.body?.status;
  const u = sla.applyStatusChange(t, next, getPolicy(t.priority));
  update(t.id, u);
  log(t.id, 'status_changed', `${t.status} -> ${next}` +
    (next === 'waiting' ? ' (SLA clock paused)' : t.status === 'waiting' ? ' (SLA clock resumed, deadlines extended)' : '') +
    (next === 'reopened' ? ' (resolution clock restarted)' : ''));
  res.json(enrich(getTicket(t.id)));
}));

app.patch('/api/tickets/:id/priority', wrap((req, res) => {
  const t = needTicket(req);
  const policy = getPolicy(req.body?.priority);
  if (!policy) throw sla.fail('priority must match an existing SLA policy');
  const u = sla.applyPriorityChange(t, req.body.priority, policy);
  update(t.id, u);
  log(t.id, 'priority_changed', `${t.priority} -> ${req.body.priority}. SLA recalculated: resolution due ${t.resolution_due} -> ${u.resolution_due}`);
  res.json(enrich(getTicket(t.id)));
}));

app.get('/api/policies', wrap((req, res) => {
  res.json(db.prepare('SELECT * FROM sla_policies ORDER BY first_response_mins').all());
}));

app.put('/api/policies/:priority', wrap((req, res) => {
  const p = getPolicy(req.params.priority);
  if (!p) throw sla.fail('Policy not found', 404);
  const fr = Number(req.body?.first_response_mins);
  const rs = Number(req.body?.resolution_mins);
  if (!Number.isInteger(fr) || !Number.isInteger(rs) || fr < 1 || rs < 1 || fr > 100000 || rs > 100000)
    throw sla.fail('Targets must be whole minutes between 1 and 100000');
  if (fr > rs) throw sla.fail('First-response target cannot be longer than the resolution target');
  db.prepare('UPDATE sla_policies SET first_response_mins=?, resolution_mins=? WHERE priority=?').run(fr, rs, p.priority);
  res.json(getPolicy(p.priority)); // applies to NEW tickets and future recalculations only
}));

app.get('/api/dashboard', wrap((req, res) => {
  const now = new Date();
  const all = db.prepare(SELECT).all().map((t) => enrich(t, now));
  const open = all.filter((t) => t.status !== 'resolved');
  const avg = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
  const responded = all.filter((t) => t.first_response_at);
  const resolved = all.filter((t) => t.resolved_at);
  const breached = all.filter((t) => t.overall === 'breached');
  const agents = db.prepare('SELECT * FROM agents ORDER BY id').all();
  res.json({
    total: all.length,
    open: open.length,
    at_risk: open.filter((t) => t.overall === 'at_risk').length,
    breached: breached.length,
    compliance: all.length ? Math.round(((all.length - breached.length) / all.length) * 100) : 100,
    avg_response_mins: avg(responded.map((t) => sla.minsBetween(t.created_at, t.first_response_at))),
    avg_resolution_mins: avg(resolved.map((t) => sla.minsBetween(t.resolution_start, t.resolved_at))),
    workload: [
      ...agents.map((a) => ({
        name: a.name, team: a.team,
        open: open.filter((t) => t.agent_id === a.id).length,
        breached: open.filter((t) => t.agent_id === a.id && t.overall === 'breached').length,
      })),
      { name: 'Unassigned', team: '-', open: open.filter((t) => !t.agent_id).length, breached: open.filter((t) => !t.agent_id && t.overall === 'breached').length },
    ],
    health: { on_track: all.filter((t) => t.overall === 'on_track').length, at_risk: all.filter((t) => t.overall === 'at_risk').length, breached: breached.length },
    by_priority: ['Critical', 'High', 'Normal', 'Low'].map((p) => ({ priority: p, open: open.filter((t) => t.priority === p).length })),
  });
}));

app.get('/api/escalations', wrap((req, res) => {
  res.json(db.prepare('SELECT * FROM escalations ORDER BY at DESC, id DESC LIMIT 200').all());
}));
app.post('/api/escalations/run', wrap((req, res) => res.json({ created: runEscalation() })));
app.post('/api/demo/reset', wrap((req, res) => res.json({ seeded: seed() })));

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));
app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  const status = err.status || 500;
  if (status === 500) console.error(err);
  res.status(status).json({ error: status === 500 ? 'Internal server error' : err.message });
});

if (require.main === module) {
  if (!db.prepare('SELECT COUNT(*) AS c FROM sla_policies').get().c) seed();
  runEscalation();
  setInterval(runEscalation, 60_000); // escalation check every minute
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log(`SLA Tracker running at http://localhost:${PORT}`));
}
module.exports = app;
