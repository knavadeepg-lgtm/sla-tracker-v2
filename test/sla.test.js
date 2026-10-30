const test = require('node:test');
const assert = require('node:assert');
const sla = require('../src/sla');

const policy = { first_response_mins: 60, resolution_mins: 240 };
const T0 = new Date('2026-01-01T09:00:00.000Z');
const at = (mins) => new Date(T0.getTime() + mins * 60000);
const base = () => ({
  status: 'open', priority: 'Critical', created_at: T0.toISOString(), resolution_start: T0.toISOString(),
  paused_total_mins: 0, paused_at: null, first_response_at: null, resolved_at: null,
  ...sla.computeDeadlines({ created_at: T0.toISOString(), resolution_start: T0.toISOString(), paused_total_mins: 0 }, policy),
});

// ---- deadline calculation ----
test('deadlines = created + policy targets', () => {
  const t = base();
  assert.equal(t.response_due, '2026-01-01T10:00:00.000Z');
  assert.equal(t.resolution_due, '2026-01-01T13:00:00.000Z');
});
test('paused time is added to deadlines', () => {
  const d = sla.computeDeadlines({ created_at: T0.toISOString(), paused_total_mins: 60 }, policy);
  assert.equal(d.resolution_due, '2026-01-01T14:00:00.000Z');
});

// ---- on track / at risk / breached ----
test('on track under 75% elapsed', () => assert.equal(sla.slaStatus(T0, at(240), null, at(120)), 'on_track'));
test('at risk from 75% elapsed', () => assert.equal(sla.slaStatus(T0, at(240), null, at(180)), 'at_risk'));
test('breached after deadline', () => assert.equal(sla.slaStatus(T0, at(240), null, at(241)), 'breached'));
test('finished on time is on track', () => assert.equal(sla.slaStatus(T0, at(240), at(200), at(900)), 'on_track'));
test('finished late is breached', () => assert.equal(sla.slaStatus(T0, at(240), at(300), at(900)), 'breached'));
test('view() combines response and resolution status', () => {
  const v = sla.view(base(), at(50)); // 50/60 min of response time used
  assert.equal(v.response_status, 'at_risk');
  assert.equal(v.resolution_status, 'on_track');
  assert.equal(v.overall, 'at_risk');
});

// ---- status changes ----
test('first move to in_progress records first response', () => {
  const u = sla.applyStatusChange(base(), 'in_progress', policy, at(30));
  assert.equal(u.first_response_at, at(30).toISOString());
});
test('waiting pauses the clock and resuming extends deadlines', () => {
  const t1 = { ...base(), ...sla.applyStatusChange(base(), 'in_progress', policy, at(10)) };
  const u2 = sla.applyStatusChange(t1, 'waiting', policy, at(60));
  assert.equal(u2.paused_at, at(60).toISOString());
  const t2 = { ...t1, ...u2 };
  assert.equal(sla.view(t2, at(500)).resolution_status, 'on_track'); // frozen while paused
  const u3 = sla.applyStatusChange(t2, 'in_progress', policy, at(120)); // paused for 60 mins
  assert.equal(u3.paused_total_mins, 60);
  assert.equal(u3.resolution_due, '2026-01-01T14:00:00.000Z');
  assert.equal(u3.paused_at, null);
});
test('resolve then reopen restarts the resolution clock', () => {
  const t1 = { ...base(), ...sla.applyStatusChange(base(), 'in_progress', policy, at(10)) };
  const t2 = { ...t1, ...sla.applyStatusChange(t1, 'resolved', policy, at(100)) };
  assert.equal(t2.resolved_at, at(100).toISOString());
  const u = sla.applyStatusChange(t2, 'reopened', policy, at(500));
  assert.equal(u.resolved_at, null);
  assert.equal(u.resolution_start, at(500).toISOString());
  assert.equal(u.resolution_due, at(740).toISOString());
  assert.equal(u.response_due, undefined); // met response deadline is frozen
});
test('invalid transitions are rejected', () => {
  assert.throws(() => sla.applyStatusChange(base(), 'open', policy), /cannot be moved back/);
  assert.throws(() => sla.applyStatusChange(base(), 'bogus', policy), /Invalid status/);
  assert.throws(() => sla.applyStatusChange(base(), 'reopened', policy), /Only resolved/);
  const resolved = { ...base(), status: 'resolved' };
  assert.throws(() => sla.applyStatusChange(resolved, 'in_progress', policy), /only be reopened/);
});

// ---- priority change ----
test('priority change recalculates from original created_at', () => {
  const normal = { first_response_mins: 480, resolution_mins: 4320 };
  const u = sla.applyPriorityChange(base(), 'Normal', normal);
  assert.equal(u.priority, 'Normal');
  assert.equal(u.resolution_due, new Date(T0.getTime() + 4320 * 60000).toISOString());
  assert.equal(u.response_due, new Date(T0.getTime() + 480 * 60000).toISOString());
});
test('priority change keeps an already-met response deadline', () => {
  const t = { ...base(), first_response_at: at(20).toISOString() };
  const u = sla.applyPriorityChange(t, 'Normal', { first_response_mins: 480, resolution_mins: 4320 });
  assert.equal(u.response_due, undefined);
});
test('priority change rejected for resolved or same priority', () => {
  assert.throws(() => sla.applyPriorityChange({ ...base(), status: 'resolved' }, 'Normal', policy), /resolved/);
  assert.throws(() => sla.applyPriorityChange(base(), 'Critical', policy), /already/);
});
