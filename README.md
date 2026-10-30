# Customer Service SLA Tracker (HACK-P368)

A service-ticket system that calculates response and resolution deadlines from configurable SLA policies, shows whether each ticket is **on track, at risk, or breached**, and raises **simulated** escalations when thresholds are crossed. Managers get a dashboard of open tickets, breaches, response/resolution times, and agent workload.

> **All data is synthetic.** Customer references like `CUST-0107` are fake. **Notifications are SIMULATED**: they are written to the database and shown in the UI, and no email is ever sent.

## Quick start
Requires Node.js 22.5 or newer.
live demo link:https://sla-tracker-v2.onrender.com/
```bash
npm install
npm start          # http://localhost:3000 (auto-seeds sample data on first run)
npm test           # unit tests for deadline calculation and status changes
npm run seed       # optional: reset the database to the demo data
```

Environment variables (all optional): `PORT` (default 3000), `DB_FILE` (default `./sla.db`).
There is no login in this prototype, so there are no test credentials.

## Features (mapped to the brief)
| Requirement | Where |
|---|---|
| Ticket creation (customer ref, category, priority, description, timestamp) | **New ticket** tab, `POST /api/tickets` |
| Configurable SLA rules, first-response and resolution targets | **SLA policies** tab (4 policies: Critical, High, Normal, Low) |
| Assignment to agent/team + status history | Ticket detail dialog, History timeline |
| On track / at risk / breached indicator | Colored badges everywhere |
| Escalation workflow (simulated) | Escalation worker runs every minute; **Escalations** tab |
| Dashboard: open, breaches, response time, resolution time, agent workload | **Dashboard** tab |
| Filters by team, priority, status, due date (+ SLA state) | **Tickets** tab |
| History of priority changes and SLA recalculations | Ticket detail -> History |
| Tests for deadline calculation and status changes | `test/sla.test.js` (15 tests) |

## How the SLA logic works (`src/sla.js`)
- `deadline = start + policy target + total paused time`
- **On track** below 75% of the allowed time, **At risk** from 75% to 100%, **Breached** once the deadline passes (or when a task was completed late).
- Each ticket has two clocks, first response and resolution. The ticket's overall status is the worse of the two.
- The SLA engine is pure functions with no database access, so it is easy to test.

## Business rules and simplifications
- **Business hours / weekends:** not modelled. The clock runs 24/7 (documented simplification; a business-hours calendar is future work).
- **Pauses:** moving to *Waiting on customer* freezes the clock. On resume, the paused time is added to the deadlines.
- **Reopened tickets:** only resolved tickets can be reopened. The resolution clock restarts from the reopen time. A first-response deadline that was already met is not changed.
- **Priority changes:** deadlines are recalculated from the original start time using the new policy. The change and the old/new due dates are written to the ticket history. A first-response deadline that was already met is frozen.
- **Policy edits** apply to new tickets and future recalculations. Existing deadlines are not rewritten.
- **First response** is recorded the first time a ticket moves to In progress, Waiting, or Resolved.

## Architecture
```
 Browser (HTML/CSS/vanilla JS + Chart.js)
        |  REST/JSON
        v
 Express API  (helmet, rate limit, validation)  ---- escalation worker (every 60 s)
        |                |
        v                v
  src/sla.js        SQLite (better-sqlite3): tickets, sla_policies, agents,
  (pure SLA logic)         ticket_history, escalations
```

## Security and validation
Input validation on every write endpoint with clear error messages, 10 KB body limit, rate limiting, `helmet` security headers (CSP), parameterised SQL queries, and HTML-escaped rendering in the UI.

## API
`GET /api/meta` · `GET/POST /api/tickets` · `GET /api/tickets/:id` · `PATCH /api/tickets/:id/{assign|status|priority}` · `GET /api/policies` · `PUT /api/policies/:priority` · `GET /api/dashboard` · `GET /api/escalations` · `POST /api/escalations/run` · `POST /api/demo/reset`

## Known limitations
- Notifications are simulated, not sent.
- No authentication or user roles.
- No business-hours calendar, holidays, or time zones.
- SQLite only. It suits a prototype, not a multi-server deployment.
- The UI polls every 30 seconds instead of using websockets.

## Future improvements
Business-hours calendar, real email/Slack integration, predictive breach risk, workload balancing, root-cause analytics, authentication.

## Demo script (3-5 minutes)
1. **Problem:** managers can't easily see which tickets are about to miss their SLA.
2. **Dashboard:** KPIs, workload chart, SLA health chart, simulated escalations.
3. **Tickets tab:** filter by *Breached*, then by team.
4. **New ticket:** create a Critical ticket and show the calculated deadlines.
5. **Ticket detail:** change the priority to Normal, see the deadline recalculated and logged in History.
6. **Waiting on customer -> In progress:** show the clock pause and the deadline extension.
7. **Escalations tab:** click *Run escalation check now*, showing the SIMULATED label.
8. **Terminal:** run `npm test` to show 15 passing tests.
