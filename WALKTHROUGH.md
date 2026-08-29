# INC-2026-0847 — a walkthrough

*Read this before the demo. It explains the problem, the design, and exactly what you're about to
watch happen on screen.*

---

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

- The engineer restarts the service, the errors stop, everyone goes back to bed — and the actual bug
  is still in production, waiting for the next traffic peak.
- The postmortem gets written days later, from memory, by someone reconstructing timestamps from
  Slack scrollback. If it gets written at all.

**This demo automates the correlation, the root-cause reasoning, and the documentation — and keeps a
human in the loop for the decision that matters.**

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
| 02:04:17 | **P1 alert fires.** 23% error rate; p99 was 7.8s at 02:00 and keeps climbing to 12.5s by 02:20 as throughput collapses from 340 rps to 110. |

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
   alert JSON  ─────────────┐
                            ▼
                 ┌──────────────────────────────────────┐
                 │   Agent.create()                     │   one long-lived agent =
                 │   "SRE Incident Commander"           │   one incident, one context
                 │                                      │
   custom  ─────▶│   local.customTools  (8 tools)       │
   tools         │   agents:            (3 subagents)   │◀─── .cursor/agents/*.md
                 │   mcpServers:        (Notion)        │     via settingSources
                 └──────────────────────────────────────┘
                            │
   phase 1  triage       ───┤  → triage-agent      → get_alert, get_metrics, get_logs,
   phase 2  investigate  ───┤                        get_deploy_history, get_service_status
   phase 3  remediate    ───┤  → investigator-agent → read_source_file, read_runbook
   phase 4  postmortem   ───┘  → postmortem-writer  → Notion MCP
                            │
                            ▼
              Notion: incident page + linked postmortem
```

**One agent, four phases, three subagents.** The commander agent persists across all four phases, so
each phase inherits the context of the one before it — and each phase's output is also passed
explicitly into the next prompt, so the chain is visible in the transcript rather than implied.

**Why subagents instead of one big prompt.** Each has a different job and a different definition of
"done": the triage agent is told *be specific with timestamps, do not speculate beyond the data*;
the investigator is told *reference specific file paths and line numbers*; the postmortem writer is
told *blameless style, specific and actionable*. Separating them means each gets a focused
instruction set and its own tool surface, and it means you can point at one of them in the interview
and say "this one is the specialist that reads code".

**Custom tools are the interesting part of the SDK here.** The agent has no shell and no network —
it can only see production through eight tools I defined:

| Tool | Stands in for |
|---|---|
| `get_alert` | PagerDuty / Alertmanager |
| `get_metrics` | Prometheus / Grafana |
| `get_logs` | Loki / Splunk / Datadog |
| `get_deploy_history` | ArgoCD / Spinnaker / CI |
| `get_service_status` | Kubernetes / health endpoints |
| `read_runbook` | Confluence / the team wiki |
| `read_source_file` | the codebase |
| `restart_service` | **the only tool that changes anything** |

Seven are read-only. One mutates. That asymmetry is deliberate and it's the thing to point at when
someone asks about safety.

## 5. What the four phases actually do

**Phase 1 — Triage.** The triage subagent pulls all four signal sources and produces a structured
report: confirmed severity, a degradation timeline, the top three correlated signals *with
timestamps*, a cause category (deploy regression / dependency failure / capacity), and a recommended
action. Note what it is **not** asked to do: guess the bug. Triage is about narrowing, not solving.

**Phase 2 — Investigation.** The investigator subagent takes the triage report and goes into the
code — it reads the changed files from the suspect deploy and connects the log stack traces to the
code path. It must produce an **evidence chain**: deploy → code change → log pattern → metric
pattern. It also has to state whether a restart alone is sufficient, or whether a code fix is
required. That single question is what separates a mitigation from a resolution.

**Phase 3 — Remediation.** Reads the runbook first, then calls `restart_service`, then re-checks
`get_service_status` and `get_metrics` to confirm the pool recovered (0 available → 48 available,
error rate 23% → 0.4%), and finally states plainly what is *still broken*. The pending `v2.14.4`
hotfix in the deploy history is the reminder that the incident isn't actually over.

**Phase 4 — Postmortem.** The writer subagent gets the full context from all three prior phases and
writes two Notion pages via MCP: an incident record and a linked blameless postmortem with impact,
timeline, root cause with code references, what went well, what went poorly, and **assigned action
items with due dates**. If Notion isn't configured it emits the same document as markdown instead —
the demo never hard-fails on someone else's API.

## 6. Which Cursor SDK features this exercises, and where

| Feature | Where | Why it matters here |
|---|---|---|
| `Agent.create({ local: { customTools } })` | `src/orchestrator.ts` | Gives the model a bounded, typed view of "production" instead of a shell |
| `agents: subagents` | `src/agents/definitions.ts` | Three role-specialised agents with their own prompts and tools |
| `settingSources: ["project"]` | `src/orchestrator.ts` | Picks up the file-based agent definitions in `.cursor/agents/` — the same ones a human would use in the IDE |
| `mcpServers` (Notion) | `src/orchestrator.ts` | Real enterprise system of record, scoped to the one subagent that needs it |
| `agent.send()` → `run.stream()` → `run.wait()` | `src/orchestrator.ts` | Live tool-call visibility during the demo, and the audit trail afterwards |
| Multi-phase context passing | `src/orchestrator.ts` | Four prompts against one durable agent, each seeded with the last phase's output |
| `--dry-run` | `src/index.ts` | The whole narrative runs with no API key, so the demo cannot be killed by rate limits or wifi |

The `mcpServers: ["notion"]` scoping on the postmortem writer is worth calling out explicitly: the
triage and investigator agents **cannot** reach Notion at all. Capability is granted per role, not
globally.

## 7. Design decisions and trade-offs

| Decision | Why | What it costs |
|---|---|---|
| Local agents with custom tools | Fast, cheap, and every tool call is visible live | No parallel fan-out; cloud agents would be better for investigating several services at once |
| Simulated observability data | Reproducible on a laptop, on a plane, in an interview | Less impressive than live Prometheus, and the data can't surprise the agent |
| Sequential phases | The narrative is legible — you can watch it think | Slower than running triage hypotheses in parallel |
| One mutating tool, seven read-only | The blast radius of a wrong decision is exactly one restart | A real deployment needs approval gating on that tool, which this doesn't have yet |
| Notion via MCP, with markdown fallback | Shows a real document workflow ending in the system of record | Requires setup, so the fallback path is the one that always works |
| Connection-pool leak as the scenario | Universally recognised, and genuinely subtle: only leaks on the error path | Deliberately a single root cause — real incidents are often two things at once |


---

That's the system. For the limitations to state before you're asked, the timed run of show, the
prepared answers, and what you'd build next, see [`PRESENTING.md`](./PRESENTING.md).
