const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const SLA_LABEL = { on_track: 'On track', at_risk: 'At risk', breached: 'Breached' };
const STATUS_LABEL = { open: 'Open', in_progress: 'In progress', waiting: 'Waiting on customer', resolved: 'Resolved', reopened: 'Reopened' };
let meta = null, current = 'dashboard', charts = {};

async function api(url, method = 'GET', body) {
  const r = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || 'Request failed');
  return j;
}
function toast(msg, isErr) {
  const t = $('#toast');
  t.textContent = msg; t.className = isErr ? 'err' : ''; t.hidden = false;
  clearTimeout(toast.t); toast.t = setTimeout(() => (t.hidden = true), 3500);
}
const guard = (fn) => async (...a) => { try { await fn(...a); } catch (e) { toast(e.message, true); } };

function fmtDur(m) {
  if (m == null) return '-';
  const a = Math.abs(Math.round(m)), d = Math.floor(a / 1440), h = Math.floor((a % 1440) / 60), mm = a % 60, p = [];
  if (d) p.push(d + 'd'); if (h) p.push(h + 'h'); if (!d) p.push(mm + 'm');
  return p.join(' ');
}
const timeLeft = (m) => (m == null ? '-' : m >= 0 ? `${fmtDur(m)} left` : `overdue ${fmtDur(m)}`);
const badge = (s) => `<span class="badge ${s}">${SLA_LABEL[s]}</span>`;
const fmtDate = (iso) => (iso ? new Date(iso).toLocaleString() : '-');
const opts = (arr, sel) => arr.map(([v, l]) => `<option value="${esc(v)}"${String(v) === String(sel) ? ' selected' : ''}>${esc(l)}</option>`).join('');

// ---------- navigation ----------
function showView(v) {
  current = v;
  document.querySelectorAll('main > section').forEach((s) => (s.hidden = s.id !== 'view-' + v));
  document.querySelectorAll('#nav button').forEach((b) => b.classList.toggle('active', b.dataset.view === v));
  refresh();
}
const refresh = guard(async () => {
  if (current === 'dashboard') await loadDashboard();
  if (current === 'tickets') await loadTickets();
  if (current === 'policies') await loadPolicies();
  if (current === 'esc') await loadEscalations();
});

// ---------- dashboard ----------
function draw(id, cfg) { charts[id]?.destroy(); charts[id] = new Chart($('#' + id), cfg); }
const escItem = (e) => `<div class="esc"><span class="lvl ${esc(e.level)}">${esc(e.level)}</span><div>${esc(e.message)}<small>${fmtDate(e.at)} &middot; SIMULATED notification</small></div></div>`;

async function loadDashboard() {
  const [d, esc_] = await Promise.all([api('/api/dashboard'), api('/api/escalations')]);
  $('#kpis').innerHTML = [
    ['Open tickets', d.open], ['At risk', d.at_risk, 'at_risk'], ['Breached', d.breached, 'breached'],
    ['SLA compliance', d.compliance + '%'], ['Avg first response', fmtDur(d.avg_response_mins)], ['Avg resolution time', fmtDur(d.avg_resolution_mins)],
  ].map(([l, v, c]) => `<div class="kpi ${c || ''}"><div class="v">${esc(v)}</div><div class="l">${l}</div></div>`).join('');
  draw('chartWork', { type: 'bar', data: { labels: d.workload.map((w) => w.name), datasets: [
    { label: 'Open', data: d.workload.map((w) => w.open - w.breached), backgroundColor: '#2457c5' },
    { label: 'Breached', data: d.workload.map((w) => w.breached), backgroundColor: '#d23b3b' }] },
    options: { maintainAspectRatio: false, scales: { x: { stacked: true }, y: { stacked: true, beginAtZero: true, ticks: { precision: 0 } } } } });
  draw('chartHealth', { type: 'doughnut', data: { labels: ['On track', 'At risk', 'Breached'], datasets: [{
    data: [d.health.on_track, d.health.at_risk, d.health.breached], backgroundColor: ['#1f9d55', '#d98a00', '#d23b3b'] }] },
    options: { maintainAspectRatio: false } });
  $('#dashEsc').innerHTML = esc_.slice(0, 6).map(escItem).join('') || '<p class="hint">No escalations yet.</p>';
}

// ---------- tickets ----------
async function loadTickets() {
  const p = new URLSearchParams();
  for (const [k, v] of new FormData($('#filters'))) if (v) p.set(k, v);
  if (p.get('dueBefore')) p.set('dueBefore', new Date(p.get('dueBefore')).toISOString());
  const rows = await api('/api/tickets?' + p);
  $('#ticketTable tbody').innerHTML = rows.map((t) => `<tr data-id="${t.id}">
    <td>${t.id}</td><td>${esc(t.customer_ref)}</td><td>${esc(t.category)}</td><td>${esc(t.priority)}</td>
    <td><span class="pill">${STATUS_LABEL[t.status]}</span></td>
    <td>${esc(t.team || '-')} / ${esc(t.agent_name || 'Unassigned')}</td>
    <td>${badge(t.overall)}</td><td>${t.status === 'waiting' ? 'paused' : timeLeft(t.mins_to_resolution)}</td>
    <td>${fmtDate(t.resolution_due)}</td></tr>`).join('') || '<tr><td colspan="9">No tickets match these filters.</td></tr>';
}
$('#ticketTable tbody').addEventListener('click', (e) => { const tr = e.target.closest('tr[data-id]'); if (tr) openDetail(tr.dataset.id); });
$('#filters').addEventListener('submit', (e) => { e.preventDefault(); refresh(); });
$('#filters').addEventListener('reset', () => setTimeout(refresh));

// ---------- ticket detail ----------
const openDetail = guard(async (id) => {
  const t = await api('/api/tickets/' + id);
  const dlg = $('#detail');
  const nextStatuses = t.status === 'resolved' ? ['reopened'] : ['in_progress', 'waiting', 'resolved'].filter((s) => s !== t.status);
  dlg.innerHTML = `
    <div class="dhead"><h3>Ticket #${t.id} &middot; ${esc(t.customer_ref)} ${badge(t.overall)}</h3><button class="secondary" id="dClose">Close</button></div>
    <p>${esc(t.description)}</p>
    <div class="dgrid">
      <div><small>Category / priority</small>${esc(t.category)} / ${esc(t.priority)}</div>
      <div><small>Status</small>${STATUS_LABEL[t.status]}${t.paused_at ? ' (SLA clock paused)' : ''}</div>
      <div><small>Created</small>${fmtDate(t.created_at)}</div>
      <div><small>Assigned</small>${esc(t.agent_name || 'Unassigned')} ${t.team ? '(' + esc(t.team) + ')' : ''}</div>
      <div><small>First response ${badge(t.response_status)}</small>${t.first_response_at ? 'Responded ' + fmtDate(t.first_response_at) : esc(timeLeft(t.mins_to_response))}<br>Due ${fmtDate(t.response_due)}</div>
      <div><small>Resolution ${badge(t.resolution_status)}</small>${t.resolved_at ? 'Resolved ' + fmtDate(t.resolved_at) : esc(t.paused_at ? 'paused' : timeLeft(t.mins_to_resolution))}<br>Due ${fmtDate(t.resolution_due)}</div>
    </div>
    <div class="controls">
      <div><label>Assign to <select id="dAgent"><option value="">Unassigned</option>${opts(meta.agents.map((a) => [a.id, `${a.name} (${a.team})`]), t.agent_id)}</select></label><button id="dAssign">Assign</button></div>
      <div><label>Change status <select id="dStatus">${opts(nextStatuses.map((s) => [s, STATUS_LABEL[s]]))}</select></label><button id="dStatusBtn">Update</button></div>
      ${t.status !== 'resolved' ? `<div><label>Change priority <select id="dPrio">${opts(meta.policies.map((p) => [p.priority, p.priority]), t.priority)}</select></label><button id="dPrioBtn">Change + recalculate SLA</button></div>` : ''}
    </div>
    <h3>History</h3>
    <ul class="timeline">${t.history.slice().reverse().map((h) => `<li><strong>${esc(h.event.replace('_', ' '))}</strong> ${esc(h.detail)}<small>${fmtDate(h.at)}</small></li>`).join('')}</ul>`;
  if (!dlg.open) dlg.showModal();
  const act = (btn, fn) => $(btn, dlg).addEventListener('click', guard(async () => { await fn(); toast('Saved'); await openDetail(id); refresh(); }));
  $('#dClose', dlg).addEventListener('click', () => dlg.close());
  act('#dAssign', () => api(`/api/tickets/${id}/assign`, 'PATCH', { agent_id: $('#dAgent', dlg).value || null }));
  act('#dStatusBtn', () => api(`/api/tickets/${id}/status`, 'PATCH', { status: $('#dStatus', dlg).value }));
  if ($('#dPrioBtn', dlg)) act('#dPrioBtn', () => api(`/api/tickets/${id}/priority`, 'PATCH', { priority: $('#dPrio', dlg).value }));
});

// ---------- new ticket ----------
$('#newForm').addEventListener('submit', guard(async (e) => {
  e.preventDefault();
  const body = Object.fromEntries(new FormData(e.target));
  const t = await api('/api/tickets', 'POST', body);
  toast(`Ticket #${t.id} created. Resolution due ${fmtDate(t.resolution_due)}`);
  e.target.reset();
  showView('tickets');
}));

// ---------- policies ----------
async function loadPolicies() {
  meta.policies = await api('/api/policies');
  $('#policyTable tbody').innerHTML = meta.policies.map((p) => `<tr data-p="${esc(p.priority)}"><td>${esc(p.priority)}</td>
    <td><input type="number" min="1" max="100000" value="${p.first_response_mins}" class="pf"></td>
    <td><input type="number" min="1" max="100000" value="${p.resolution_mins}" class="pr"></td>
    <td><button class="save">Save</button></td></tr>`).join('');
}
$('#policyTable tbody').addEventListener('click', guard(async (e) => {
  if (!e.target.classList.contains('save')) return;
  const tr = e.target.closest('tr');
  await api('/api/policies/' + encodeURIComponent(tr.dataset.p), 'PUT', { first_response_mins: Number($('.pf', tr).value), resolution_mins: Number($('.pr', tr).value) });
  toast('Policy saved');
}));

// ---------- escalations ----------
async function loadEscalations() {
  const list = await api('/api/escalations');
  $('#escList').innerHTML = list.map(escItem).join('') || '<p class="hint">No escalations yet.</p>';
}
$('#runEsc').addEventListener('click', guard(async () => { const r = await api('/api/escalations/run', 'POST'); toast(`${r.created} new simulated escalation(s)`); refresh(); }));
$('#resetDemo').addEventListener('click', guard(async () => { await api('/api/demo/reset', 'POST'); toast('Demo data reset'); await init(); showView('dashboard'); }));

// ---------- init ----------
async function init() {
  meta = await api('/api/meta');
  $('#fPriority').innerHTML = '<option value="">All</option>' + opts(meta.policies.map((p) => [p.priority, p.priority]));
  $('#fStatus').innerHTML = '<option value="">All</option>' + opts(meta.statuses.map((s) => [s, STATUS_LABEL[s]]));
  $('#nCategory').innerHTML = opts(meta.categories.map((c) => [c, c]));
  $('#nPriority').innerHTML = opts(meta.policies.map((p) => [p.priority, `${p.priority} (response ${fmtDur(p.first_response_mins)}, resolve ${fmtDur(p.resolution_mins)})`]), 'Normal');
  $('#nAgent').innerHTML = '<option value="">Unassigned</option>' + opts(meta.agents.map((a) => [a.id, `${a.name} (${a.team})`]));
}
$('#nav').addEventListener('click', (e) => { if (e.target.dataset.view) showView(e.target.dataset.view); });
init().then(refresh).catch((e) => toast(e.message, true));
setInterval(() => { if (!$('#detail').open) refresh(); }, 30000); // live statuses
