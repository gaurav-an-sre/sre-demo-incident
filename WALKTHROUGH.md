# INC-2026-0847 — a walkthrough

## 1. The problem

It's 2:04 AM. An alert fires: checkout p99 latency has been over the 5-second threshold for ten
minutes and 23% of requests are failing. Customers cannot pay. The annotation on the alert puts the
revenue impact at about **$12k per minute**.

The on-call engineer now does something that has nothing to do with engineering skill and everything
to do with tab management. They open **four tools**:

- the **dashboard**, to see how bad it is and when it started;
- the **logs**, to find an error pattern in thousands of lines;
- the **deploy history**, to ask the only question that matters first — *what changed?*;
- the **runbook**, to remember what the team agreed to do about this last time.

Nothing is hard about any one of those steps. What's hard is doing all four at 2am, holding the
timestamps in your head, and noticing that the pool utilisation warning at 01:30 lines up with a
deploy at 01:15. That correlation *is* the job, and it's the part a tired human is worst at.

Then two more things go wrong, and every SRE in the room will recognise both:

- The engineer acknowledges the PagerDuty incident, restarts the service, the errors stop, everyone
  goes back to bed — and the actual bug is still in production, waiting for the next traffic peak.
- The postmortem gets written days later, from memory, by someone reconstructing timestamps from
  Slack scrollback and the PagerDuty timeline. If it gets written at all.

**This demo automates the correlation, the root-cause reasoning, the PagerDuty incident lifecycle, and
the documentation — and keeps a human in the loop for the decision that matters.**

## 2. Why this problem

- **It's universal.** Every company with a production system has this exact 2am. No industry
  context needed for the audience to follow it.
- **It's genuinely agent-shaped.** Reading four heterogeneous data sources and forming an
  explanation is what an LLM is actually good at, and it's precisely the part that doesn't scale
  with more humans.
- **It has a written-down right answer.** The runbook already says what to do. The gap isn't
  knowledge, it's execution under pressure at 2am.
- **The output is a document**, and documents are where incident response quietly fails. An agent
  that writes the postmortem *while the evidence is still on screen* is solving a real
  organisational problem, not a technical one.

## 3. The incident, end to end

| Time (UTC) | What happened |
|---|---|
| 01:15:43 | `jchen` deploys **v2.14.3** — "Optimize payment-gateway connection pooling for Black Friday prep". Touches `pool.ts`, `handler.ts`, `production.yaml`. |
| 01:16:02 | Service pre-warms 50 payment-gateway connections. Everything looks fine. |
| 01:30:12 | First WARN: pool utilisation 75% (38/50). Nobody is watching; there's no alert on this. |
| 01:45 | p99 crosses 1.2s, error rate 1.2%, pool down to 30 available. |
| 01:55 | p99 5.2s, errors 12.4%, **2 connections left**. |
| 02:00 | Pool fully exhausted — 0 available, 50 in use. `PoolExhaustedError`. |
| 02:04:17 | **P1 alert fires** in monitoring. PagerDuty incident opens; `payments-primary` is paged at 02:05:30. 23% error rate; p99 was 7.8s at 02:00 and keeps climbing to 12.5s by 02:20 as throughput collapses from 340 rps to 110. |

The bug is a single missing line in `simulation/checkout-service/src/pool.ts`:

```ts
releaseConnection(conn: PooledConnection): void {
  const idx = this.connections.findIndex((c) => c.id === conn.id);
  if (idx === -1) {
    throw new Error("pool.releaseConnection: connection not in pool");
  }
  // Missing: this.connections[idx].inUse = false;
}
```

Connections are only leaked on the **error path** — when the payment gateway returns a failure. So
the leak rate is proportional to the payment failure rate, which is why it took 30 minutes to become
visible and why it never showed up in staging. The service doesn't crash. It slowly runs out of the
one resource nobody has an alert on.

**A restart fixes the symptom in 90 seconds and fixes nothing at all.** That distinction is the
point of phase 3.

## 4. The architecture

```
   PagerDuty incident  ─────┐
   (real, via MCP)          │
                            ▼
   alert JSON  ─────────────┤
   (simulated)              │
                            ▼
                 ┌──────────────────────────────────────┐
                 │   Agent.create()                     │   one long-lived agent =
                 │   "SRE Incident Commander"           │   one incident, one context
                 │                                      │
   custom  ─────▶│   local.customTools  (8 tools)       │
   tools         │   agents:            (4 subagents)   │◀─── .cursor/agents/*.md
                 │   mcpServers:        (PagerDuty,     │     via settingSources
                 │                       Notion)        │
                 └──────────────────────────────────────┘
                            │
   phase 0  pagerduty    ───┤  → pagerduty-oncall   → list_incidents, get_incident,
   phase 1  triage       ───┤                          manage_incidents, add_note_to_incident
   phase 2  investigate  ───┤  → triage-agent        → get_alert, get_metrics, get_logs,
   phase 3  remediate    ───┤                          get_deploy_history, get_service_status
   phase 4  postmortem   ───┘  → investigator-agent  → read_source_file, read_runbook
                            │    postmortem-writer    → Notion MCP + PagerDuty resolve
                            ▼
              PagerDuty: acknowledged → annotated → resolved
              Notion: incident page + linked postmortem (with PagerDuty incident link)
```

**One agent, five phases, four subagents.** The commander agent persists across all phases, so
each phase inherits the context of the one before it — and each phase's output is also passed
explicitly into the next prompt, so the chain is visible in the transcript rather than implied.

**PagerDuty is the real on-call system; the custom tools are the simulated observability stack.**
That split is deliberate: PagerDuty MCP handles the incident lifecycle your company actually runs
(acknowledge, annotate, resolve), while the eight custom tools stand in for Grafana, Loki, and
ArgoCD so the demo works on a laptop without a GCP bill. In production on GCP you'd replace the
custom tools with Monitoring and Logging APIs and keep PagerDuty exactly as it is here.

**Why subagents instead of one big prompt.** Each has a different job and a different definition of
"done": the PagerDuty on-call agent owns the incident record; the triage agent is told *be specific
with timestamps, do not speculate beyond the data*; the investigator is told *reference specific file
paths and line numbers*; the postmortem writer is told *blameless style, specific and actionable*.
Separating them means each gets a focused instruction set and its own tool surface — and the
PagerDuty and Notion MCP servers are scoped to the subagents that actually need them, not granted
globally.

**Custom tools are the interesting part of the SDK here.** The agent has no shell and no network —
it can only see production through eight tools I defined:

| Tool | Stands in for |
|---|---|
| `get_alert` | Alertmanager / the monitoring alert payload (PagerDuty is separate, via MCP) |
| `get_metrics` | Prometheus / Grafana |
| `get_logs` | Loki / Splunk / Datadog |
| `get_deploy_history` | ArgoCD / Spinnaker / CI |
| `get_service_status` | Kubernetes / health endpoints |
| `read_runbook` | Confluence / the team wiki |
| `read_source_file` | the codebase |
| `restart_service` | **the only custom tool that mutates simulated production** |

Seven custom tools are read-only. One mutates the simulation. **PagerDuty MCP** is a separate
surface — `manage_incidents` and `add_note_to_incident` change your real PagerDuty account when
`--enable-write-tools` is on. That asymmetry is deliberate and it's the thing to point at when
someone asks about safety: simulated prod has one mutating tool; PagerDuty writes are scoped to the
on-call and postmortem subagents only.

## 5. What the five phases actually do

**Phase 0 — PagerDuty intake** *(when `PAGERDUTY_USER_API_KEY` is set).* The `pagerduty-oncall`
subagent calls the official [PagerDuty MCP server](https://github.com/PagerDuty/pagerduty-mcp-server):
`list_incidents` to find the triggered checkout incident, `get_incident` for details, then
`manage_incidents` to **acknowledge** it and `add_note_to_incident` with "SDK agent engaged —
starting automated triage". This is the moment the demo stops being a script and touches a real
system of record. For the interview, create a test incident in PagerDuty before you run `pnpm demo`.

**Phase 1 — Triage.** The triage subagent pulls all four signal sources and produces a structured
report: confirmed severity, a degradation timeline, the top three correlated signals *with
timestamps*, a cause category (deploy regression / dependency failure / capacity), and a recommended
action. If PagerDuty is configured, it also adds a triage summary note to the incident. Note what it
is **not** asked to do: guess the bug. Triage is about narrowing, not solving.

**Phase 2 — Investigation.** The investigator subagent takes the triage report and goes into the
code — it reads the changed files from the suspect deploy and connects the log stack traces to the
code path. It must produce an **evidence chain**: deploy → code change → log pattern → metric
pattern. It also has to state whether a restart alone is sufficient, or whether a code fix is
required. That single question is what separates a mitigation from a resolution.

**Phase 3 — Remediation.** Reads the runbook first, then calls `restart_service`, then re-checks
`get_service_status` and `get_metrics` to confirm the pool recovered (0 available → 48 available,
error rate 23% → 0.4%). If PagerDuty is configured, adds a mitigation note to the incident. Finally
states plainly what is *still broken*. The pending `v2.14.4` hotfix in the deploy history is the
reminder that the incident isn't actually over.

**Phase 4 — Postmortem.** The writer subagent gets the full context from all prior phases. It
**resolves the PagerDuty incident** via `manage_incidents` with a final resolution note, then writes
two Notion pages via MCP: an incident record (including the PagerDuty incident ID/link) and a linked
blameless postmortem with impact, timeline, root cause with code references, what went well, what
went poorly, and **assigned action items with due dates**. If Notion isn't configured it emits the
same document as markdown instead — the demo never hard-fails on someone else's API.

## 6. Which Cursor SDK features this exercises, and where

| Feature | Where | Why it matters here |
|---|---|---|
| `Agent.create({ local: { customTools } })` | `src/orchestrator.ts` | Gives the model a bounded, typed view of "production" instead of a shell |
| `agents: subagents` | `src/agents/definitions.ts` | Four role-specialised agents: on-call, triage, investigator, postmortem writer |
| `settingSources: ["project"]` | `src/orchestrator.ts` | Picks up the file-based agent definitions in `.cursor/agents/` — the same ones a human would use in the IDE |
| `mcpServers` (PagerDuty) | `src/mcp/servers.ts` | Real on-call system: acknowledge, annotate, resolve. Official `pagerduty-mcp` via `uvx` |
| `mcpServers` (Notion) | `src/mcp/servers.ts` | Real document system of record for the postmortem |
| `mcpServers: ["pagerduty"]` / `["notion"]` scoping | `src/agents/definitions.ts` | MCP capability granted per subagent, not globally — triage can't accidentally resolve an incident |
| `agent.send()` → `run.stream()` → `run.wait()` | `src/orchestrator.ts` | Live tool-call visibility during the demo, and the audit trail afterwards |
| Multi-phase context passing | `src/orchestrator.ts` | Five prompts against one durable agent, each seeded with the last phase's output |
| `--dry-run` | `src/index.ts` | The whole narrative runs with no API key, including simulated PagerDuty tool calls |

The `mcpServers: ["notion", "pagerduty"]` scoping on the postmortem writer is worth calling out
explicitly: only the on-call and postmortem subagents can reach PagerDuty; only the postmortem writer
can reach Notion. The triage and investigator agents work entirely through custom tools and cannot
write to either external system.
## 7. Design decisions and trade-offs

| Decision | Why | What it costs |
|---|---|---|
| Local agents with custom tools | Fast, cheap, and every tool call is visible live | No parallel fan-out; cloud agents would be better for investigating several services at once |
| Simulated observability + real PagerDuty | Reproducible triage narrative plus a live "this touched my on-call account" moment | Two setup steps: Cursor API key + PagerDuty token + `uvx` |
| PagerDuty MCP with `--enable-write-tools` | Acknowledge/resolve must be real for the demo to mean anything | Writes to your PagerDuty account — use a test incident, not production blindly |
| Sequential phases | The narrative is legible — you can watch it think | Slower than running triage hypotheses in parallel |
| MCP scoped per subagent | On-call writes can't leak into investigation | More configuration than a single global MCP block |
| Notion via MCP, with markdown fallback | Shows a real document workflow ending in the system of record | Requires setup, so the fallback path is the one that always works |
| Simulated observability data | Reproducible on a laptop, on a plane, in an interview | Less impressive than live Prometheus, and the data can't surprise the agent |
| Connection-pool leak as the scenario | Universally recognised, and genuinely subtle: only leaks on the error path | Deliberately a single root cause — real incidents are often two things at once |
