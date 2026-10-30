// SLA engine: pure functions, no database access, so it is easy to test.
const AT_RISK_RATIO = 0.75; // at risk once 75% of the allowed time has elapsed
const STATUSES = ['open', 'in_progress', 'waiting', 'resolved', 'reopened'];

const addMins = (d, m) => new Date(new Date(d).getTime() + m * 60000);
const minsBetween = (a, b) => (new Date(b) - new Date(a)) / 60000;

function fail(message, status = 400) {
  const e = new Error(message);
  e.status = status;
  return e;
}

// Deadline = start + policy target + total time spent paused ("Waiting on customer").
function computeDeadlines(t, policy) {
  const paused = t.paused_total_mins || 0;
  return {
    response_due: addMins(t.created_at, policy.first_response_mins + paused).toISOString(),
    resolution_due: addMins(t.resolution_start || t.created_at, policy.resolution_mins + paused).toISOString(),
  };
}

// doneAt = when it was responded to / resolved (null while still open)
function slaStatus(start, due, doneAt = null, now = new Date()) {
  const end = new Date(doneAt || now);
  const total = new Date(due) - new Date(start);
  const elapsed = end - new Date(start);
  if (elapsed > total) return 'breached';
  if (!doneAt && elapsed >= total * AT_RISK_RATIO) return 'at_risk';
  return 'on_track';
}

const RANK = { on_track: 0, at_risk: 1, breached: 2 };

// Adds computed SLA info to a ticket row. A paused ticket's clock is frozen at paused_at.
function view(t, now = new Date()) {
  const eff = t.paused_at ? new Date(t.paused_at) : now;
  const response_status = slaStatus(t.created_at, t.response_due, t.first_response_at, eff);
  const resolution_status = slaStatus(t.resolution_start || t.created_at, t.resolution_due, t.resolved_at, eff);
  const overall = RANK[response_status] >= RANK[resolution_status] ? response_status : resolution_status;
  return {
    response_status,
    resolution_status,
    overall,
    mins_to_response: t.first_response_at ? null : minsBetween(eff, t.response_due),
    mins_to_resolution: t.resolved_at ? null : minsBetween(eff, t.resolution_due),
  };
}

// Returns the column updates for a status change (or throws a 400 error).
function applyStatusChange(t, next, policy, now = new Date()) {
  if (!STATUSES.includes(next)) throw fail('Invalid status');
  if (next === 'open') throw fail('A ticket cannot be moved back to "open"; use "reopened" for resolved tickets');
  if (next === t.status) throw fail(`Ticket is already ${next}`);
  if (t.status === 'resolved' && next !== 'reopened') throw fail('Resolved tickets can only be reopened');
  if (next === 'reopened' && t.status !== 'resolved') throw fail('Only resolved tickets can be reopened');

  const nowIso = now.toISOString();
  const u = { status: next };
  if (t.status === 'waiting') { // resuming: add the paused time to the deadline
    u.paused_total_mins = (t.paused_total_mins || 0) + minsBetween(t.paused_at, now);
    u.paused_at = null;
  }
  if (next === 'waiting') u.paused_at = nowIso;
  if (['in_progress', 'waiting', 'resolved'].includes(next) && !t.first_response_at) u.first_response_at = nowIso;
  if (next === 'resolved') u.resolved_at = nowIso;
  if (next === 'reopened') { // resolution clock restarts
    u.resolved_at = null;
    u.resolution_start = nowIso;
    u.paused_total_mins = 0;
  }
  const d = computeDeadlines({ ...t, ...u }, policy);
  if (!t.first_response_at && u.first_response_at) u.response_due = d.response_due;
  u.resolution_due = d.resolution_due;
  return u;
}

// Priority change: deadlines are recalculated from the original start time.
// A first-response deadline that was already met is frozen.
function applyPriorityChange(t, newPriority, policy) {
  if (t.status === 'resolved') throw fail('Cannot change the priority of a resolved ticket');
  if (t.priority === newPriority) throw fail(`Ticket already has priority ${newPriority}`);
  const d = computeDeadlines(t, policy);
  const u = { priority: newPriority, resolution_due: d.resolution_due };
  if (!t.first_response_at) u.response_due = d.response_due;
  return u;
}

module.exports = { AT_RISK_RATIO, STATUSES, addMins, minsBetween, fail, computeDeadlines, slaStatus, view, applyStatusChange, applyPriorityChange };
