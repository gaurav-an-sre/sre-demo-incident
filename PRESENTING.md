# Presenting this demo

*The companion to `WALKTHROUGH.md`. That one explains what the system is; this one is what you say
while it runs, what you admit before anyone catches it, and what you'd build next.*

---

## 1. Limitations — say these before you're asked

- **The evidence is fixture data, and it is friendly.** The deploy record's `diff_summary` names the
  suspect function, `pool.ts` carries a comment marking the bug, and the metrics fixture ships an
  `anomalies` block that states the deploy correlation outright with a confidence score. The demo
  shows the agent doing *correlation and explanation* well; it does not prove it would find a bug
  nobody had already labelled. The honest version of the claim is: "this shows the workflow, not the
  difficulty."
- **Recovery is asserted by the same simulation that caused the failure.** After `restart_service`,
  the metrics tool starts returning healthy numbers because the simulation state flipped — nothing
  independently measures that the service is genuinely fine. In production, "did it recover?" must
  be measured by something the agent doesn't control.
- **The mutating actions run without approval.** `restart_service`, and the PagerDuty
  acknowledge/annotate/resolve writes, all happen unilaterally. Resolving a real incident is the one
  that would matter most in production: nothing stops the agent closing a page on a service that is
  still broken. Gating those behind a hook is the first thing I'd add.
- **PagerDuty is real; everything it's reacting to is not.** The incident lifecycle touches an actual
  account, but the alert that "caused" it is a JSON fixture you created by hand beforehand. Say that,
  rather than letting the live PagerDuty page imply live monitoring.
- **One service, one root cause, one hypothesis path.** No competing explanations, no ranking, no
  "actually it was two things".
- **The postmortem's numbers are as good as the fixtures.** The revenue impact is a figure from the
  alert annotation, not a computed one.

None of these are hard to fix, and each maps to a real extension — which is the next section.

## 2. Extending it live

Ordered by how quickly they can be demonstrated:

1. **Gate the mutating tools behind a hook** — `restart_service` and, more importantly, the
   PagerDuty resolve — so they require human approval. The single highest-value change, and small.
2. **Add a Slack MCP subagent** that posts the triage summary to the incident channel the moment
   phase 1 finishes. That's the thing an on-call engineer would actually feel.
3. **Parallel hypothesis agents** — fan out "it's the deploy", "it's the dependency", "it's
   capacity" as concurrent cloud agents and have a fourth adjudicate. Rejected hypotheses with
   evidence are what make the accepted one credible.
4. **Real Prometheus/Grafana behind the same tool interface.** The tool signatures don't change,
   only their implementations — which is the argument for defining tools this way in the first
   place.
5. **A verification step that isn't an agent** — measure recovery independently instead of trusting
   the restart, and make the PagerDuty resolve conditional on that measurement, so "resolved" is a
   measurement rather than a claim.
6. **A DAG task runner** for the phases, so independent work runs concurrently and failures retry
   per-node.

## 3. Demo run of show (~12 minutes)

| Time | What you do | What you say |
|---|---|---|
| 0:00 | Show `simulation/data/alerts/checkout-latency.json` | "2:04 AM. P1. Checkout is failing, $12k a minute. This is where the pager goes off." |
| 0:30 | Show the four data directories, and your PagerDuty incident sitting in `triggered` | "Four tools — metrics, logs, deploys, runbooks. Correlating these at 2am is the whole job. And the page is real." |
| 1:00 | `pnpm demo` | Let it run. Narrate the tool calls as they stream. |
| 1:30 | Phase 0 / PagerDuty tab | Refresh it: the incident is now **acknowledged**, with a note on it. "That's my actual on-call account, not a mock." |
| 2:30 | Phase 1 output | "It confirmed P1, put the deploy at 01:15 next to the first pool warning at 01:30, and categorised it as a deploy regression." |
| 4:30 | Phase 2 output | "Now it's in the code. Missing line in `releaseConnection`. Note the evidence chain — deploy, to code, to log, to metric." |
| 6:30 | Phase 3 output | "It reads the runbook first, restarts, then re-checks the metrics. And it says what's *still* broken — a restart is a mitigation, not a fix." |
| 8:30 | Phase 4 / Notion page + PagerDuty tab | "Postmortem written while the evidence is still on screen, with assigned action items — and the page resolves itself with a link to it." |
| 10:00 | Walk `src/orchestrator.ts`, `definitions.ts`, `mcp/servers.ts` | Custom tools, four subagents, MCP scoped per role, streaming. |
| 11:00 | Trade-offs and limitations | Use section 1 above. Get there before they do. |

**Presenter notes.** Create the PagerDuty test incident *before* you start, and keep the PagerDuty
web UI open in a second tab — the acknowledge and the resolve are the two moments the room can see
land in a real system. Run `pnpm demo:dry-run` once beforehand to confirm the terminal renders
properly, and keep it as the fallback if the network fails: it tells the same story with no API key
and simulated PagerDuty calls. If Notion isn't set up, phase 4 outputs markdown instead and nothing
breaks. Have `pool.ts` open in a third tab so you can jump straight to the missing line the moment
the investigator names it.

## 4. Questions they'll ask

**"Why not one agent with one big prompt?"**
Different phases need different rules. Triage must not speculate; investigation must cite file paths;
the postmortem must be blameless prose. One prompt containing all of that gets you an agent that's
mediocre at each. Subagents also let me scope capability — only the writer can reach Notion, and
only the on-call and writer subagents can touch PagerDuty, so triage cannot accidentally resolve an
incident.

**"How do you stop it doing something dangerous?"**
Today: seven of the eight custom tools are read-only, and the agent has no shell or network beyond
them and the two MCP servers, so the blast radius is one restart plus the incident lifecycle. That's
a good default but it isn't a control — the real answer is a hook gating the mutating tools behind
human approval, which is my first extension.

**"How do you know the fix worked?"**
Right now, I don't — the agent re-reads metrics that the same simulation flipped to healthy, and
then resolves a real PagerDuty incident on the strength of them. I'd call that the weakest part of
the demo, and it's sharper now that the resolve is real. In production, recovery has to be measured
by something the agent can't influence, and the resolve should be conditional on that measurement,
not on a sentence the agent wrote.

**"Would this work on a real incident?"**
The workflow would, and one end of it already does — the PagerDuty half is production software. The
custom tools are thin adapters over Prometheus, Loki and ArgoCD, and swapping them doesn't touch the
agent design. What's untested here is difficulty: my fixtures point at the answer.
The next thing I'd build is an evaluation over real past incidents, to find out how often it's right.

**"What's the actual value — the agent, or the automation?"**
The correlation and the document. A script could fetch four APIs; it couldn't read `pool.ts`, notice
the missing line, connect it to a WARN 15 minutes after a deploy, and then write a blameless
postmortem about it. And the postmortem is the deliverable that most teams silently skip.
