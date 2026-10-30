// Synthetic demo data only. No real customer data.
const db = require('./db');
const { computeDeadlines, addMins } = require('./sla');

const POLICIES = [
  ['Critical', 60, 240],
  ['High', 240, 1440],
  ['Normal', 480, 4320],
  ['Low', 1440, 10080],
];
const AGENTS = [
  ['Asha Rao', 'Billing'], ['Ben Carter', 'Billing'],
  ['Chen Wei', 'Technical'], ['Divya Nair', 'Technical'], ['Eli Moss', 'General'],
];
// [priority, category, ageMins, status, agentIdx, respondedAfterMins, resolvedAfterMins, pausedMinsAgo, description]
const TICKETS = [
  ['Critical', 'Billing', 20, 'open', 0, null, null, null, 'Duplicate charge on invoice'],
  ['Critical', 'Technical', 50, 'open', 2, null, null, null, 'Production API returning 500 errors'],
  ['Critical', 'Technical', 200, 'in_progress', 3, 15, null, null, 'Login service down for a user group'],
  ['Critical', 'Account', 400, 'in_progress', 4, 30, null, null, 'Account locked, cannot access dashboard'],
  ['Critical', 'General', 10, 'open', 4, null, null, null, 'Outage report from the sample customer'],
  ['High', 'Billing', 100, 'in_progress', 1, 30, null, null, 'Refund not received after 5 days'],
  ['High', 'Technical', 1200, 'in_progress', 2, 60, null, null, 'Export feature times out on large files'],
  ['High', 'Technical', 2000, 'in_progress', 3, 100, null, null, 'Webhook events arriving twice'],
  ['High', 'Account', 300, 'open', null, null, null, null, 'Request to change the account owner'],
  ['High', 'Billing', 3000, 'resolved', 0, 50, 1700, null, 'Wrong tax rate applied (resolved late)'],
  ['High', 'Account', 2000, 'reopened', 4, 40, null, null, 'Password reset email still not arriving (reopened)'],
  ['Normal', 'Billing', 120, 'open', 1, null, null, null, 'Question about invoice format'],
  ['Normal', 'General', 3500, 'in_progress', 4, 200, null, null, 'Feature request: dark mode'],
  ['Normal', 'Technical', 3000, 'waiting', 2, 100, null, 600, 'Waiting on customer logs for sync bug'],
  ['Normal', 'Billing', 6000, 'resolved', 1, 100, 3000, null, 'Update billing address (resolved on time)'],
  ['Low', 'General', 300, 'open', 4, null, null, null, 'How do I export my data?'],
  ['Low', 'Account', 9000, 'in_progress', 4, 500, null, null, 'Change notification preferences'],
  ['Low', 'Technical', 12000, 'open', null, null, null, null, 'Minor UI misalignment on settings page'],
];

function seed() {
  for (const tbl of ['escalations', 'ticket_history', 'tickets', 'agents', 'sla_policies']) {
    db.prepare(`DELETE FROM ${tbl}`).run();
  }

  const pol = {};
  for (const [priority, fr, res] of POLICIES) {
    db.prepare('INSERT INTO sla_policies (priority, first_response_mins, resolution_mins) VALUES (?,?,?)').run(priority, fr, res);
    pol[priority] = { first_response_mins: fr, resolution_mins: res };
  }
  const agentIds = AGENTS.map(([n, t]) => db.prepare('INSERT INTO agents (name, team) VALUES (?,?)').run(n, t).lastInsertRowid);

  const now = new Date();
  const hist = db.prepare('INSERT INTO ticket_history (ticket_id, event, detail, at) VALUES (?,?,?,?)');
  let n = 1;
  for (const [priority, category, age, status, agentIdx, respAfter, resolvedAfter, pausedAgo, description] of TICKETS) {
    const created = addMins(now, -age);
    const t = { created_at: created.toISOString(), resolution_start: created.toISOString(), paused_total_mins: 0 };
    if (status === 'reopened') t.resolution_start = addMins(now, -100).toISOString();
    const d = computeDeadlines(t, pol[priority]);
    const agent = agentIdx === null ? null : agentIds[agentIdx];
    const info = db.prepare(
      `INSERT INTO tickets (customer_ref, category, priority, description, status, agent_id, created_at, resolution_start,
        first_response_at, resolved_at, response_due, resolution_due, paused_at, paused_total_mins)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,0)`).run(
      `CUST-${String(100 + n * 7).padStart(4, '0')}`, category, priority, description, status, agent,
      t.created_at, t.resolution_start,
      respAfter == null ? null : addMins(created, respAfter).toISOString(),
      resolvedAfter == null ? null : addMins(created, resolvedAfter).toISOString(),
      d.response_due, d.resolution_due,
      pausedAgo == null ? null : addMins(now, -pausedAgo).toISOString());
    const id = info.lastInsertRowid;
    hist.run(id, 'created', `Ticket created with priority ${priority}. Response due ${d.response_due}, resolution due ${d.resolution_due}`, t.created_at);
    if (agent) hist.run(id, 'assigned', `Assigned to ${AGENTS[agentIdx][0]}`, addMins(created, 2).toISOString());
    if (status !== 'open') hist.run(id, 'status_changed', `Status set to ${status}`, addMins(created, respAfter || 5).toISOString());
    n++;
  }
  require('./escalation').runEscalation(now); // so the demo starts with simulated alerts
  return TICKETS.length;
}

module.exports = { seed };
if (require.main === module) console.log(`Seeded ${seed()} sample tickets, ${POLICIES.length} SLA policies, ${AGENTS.length} agents.`);
