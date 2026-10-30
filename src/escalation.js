// Escalation worker. Notifications are SIMULATED: they are only written to the
// escalations table and shown in the UI. No email is ever sent.
const db = require('./db');
const { view } = require('./sla');

function runEscalation(now = new Date()) {
  const rows = db.prepare(
    `SELECT t.*, a.name AS agent_name, a.team AS team
     FROM tickets t LEFT JOIN agents a ON a.id = t.agent_id
     WHERE t.status != 'resolved' AND t.paused_at IS NULL`).all();
  const exists = db.prepare('SELECT 1 FROM escalations WHERE ticket_id=? AND kind=? AND level=? AND due_ref=?');
  const insert = db.prepare(
    'INSERT INTO escalations (ticket_id, kind, level, due_ref, message, simulated, at) VALUES (?,?,?,?,?,1,?)');
  let created = 0;

  for (const t of rows) {
    const v = view(t, now);
    const checks = [['resolution', v.resolution_status, t.resolution_due]];
    if (!t.first_response_at) checks.push(['response', v.response_status, t.response_due]);
    for (const [kind, status, due] of checks) {
      if (status === 'on_track') continue;
      const level = status === 'breached' ? 'CRITICAL' : 'WARNING';
      if (exists.get(t.id, kind, level, due)) continue; // already escalated for this deadline
      const who = level === 'CRITICAL'
        ? `the ${t.team || 'support'} team manager`
        : (t.agent_name || 'the unassigned queue');
      const msg = `${kind} SLA ${status === 'breached' ? 'BREACHED' : 'at risk'} on ticket #${t.id} (${t.priority}). Would notify ${who}.`;
      insert.run(t.id, kind, level, due, msg, now.toISOString());
      db.prepare('INSERT INTO ticket_history (ticket_id, event, detail, at) VALUES (?,?,?,?)')
        .run(t.id, 'escalated', `${level}: ${msg} [SIMULATED]`, now.toISOString());
      created++;
    }
  }
  return created;
}

module.exports = { runEscalation };
