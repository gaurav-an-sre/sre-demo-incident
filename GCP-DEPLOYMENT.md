# Running this for real: Cloud Run + Cloud Monitoring + PagerDuty

*How the demo stops being a simulation. Same agent design, same tool interfaces — only the
implementations behind the tools change, which is the argument for having defined them as tools in
the first place.*

---

## 1. What changes, and why it's worth doing

Today the pipeline has one honest weakness (section 1 of `PRESENTING.md`): **recovery is asserted by
the same simulation that caused the failure.** `restart_service` flips `.simulation-state.json`, and
`get_metrics` obligingly starts returning healthy numbers. Nothing independent measures anything.

Moving to GCP fixes exactly that, and two other things with it:

| Today | On GCP |
|---|---|
| `restart_service` writes a JSON file | `gcloud run services update-traffic --to-revisions=checkout-v2-14-2=100` — a real, auditable, reversible rollback |
| Deploy history is a fixture | Cloud Run revisions **are** the deploy history |
| Recovery is claimed | Recovery is a Cloud Monitoring query over the post-rollback window, run by code the agent can't influence |
| The alert is a JSON file someone hands the agent | A Monitoring alert policy fires, PagerDuty pages, and **the page is what starts the pipeline** |

That last row is the one that changes the story you tell. Right now you run `pnpm demo`. On GCP,
nobody runs anything — an alert fires at 2am and the agent is already working by the time a human
opens their laptop.

## 2. Architecture

```
  Cloud Scheduler ──▶ Cloud Run Job: shopper          (traffic, every 60s)
                            │  POST /checkout
                            ▼
                  ┌──────────────────────────┐
                  │  Cloud Run: checkout-svc │  min=1 max=1  (see §4)
                  │  rev v2.14.2  (healthy)  │
                  │  rev v2.14.3  (leaky) ◀──┼── the "deploy" that causes the incident
                  └──────────────────────────┘
                       │              │
             structured logs      request metrics
                       ▼              ▼
                 Cloud Logging   Cloud Monitoring
                                      │  alert policy: p99 > 5s AND 5xx ratio > 5%
                                      ▼
                              PagerDuty  ◀── notification channel
                                      │  webhook subscription (v3)
                                      ▼
                  ┌──────────────────────────┐
                  │ Cloud Run: pd-webhook    │  verify signature, ack in <1s,
                  │                          │  enqueue and return 202
                  └──────────────────────────┘
                                      │  triggers execution
                                      ▼
                  ┌──────────────────────────┐
                  │ Cloud Run Job: orchestr. │  the existing four-phase pipeline
                  │  Agent.create(...)       │  runs for minutes, not seconds
                  └──────────────────────────┘
                     │        │         │
              Monitoring   Cloud Run   Notion MCP
              Logging      Admin API   PagerDuty API
              (read)       (rollback)  (note + resolve)
```

**Why the webhook and the orchestrator are separate services.** PagerDuty expects a webhook to
acknowledge within seconds and retries if you don't. The pipeline takes minutes. So the webhook
service does three things only — verify the signature, extract the incident id, trigger a Cloud Run
Job execution — and returns `202` immediately. The job is where the agent lives. Cloud Run Jobs also
have no request-timeout semantics to fight, which a long agent run would otherwise hit.

## 3. Component by component

| Component | GCP service | Notes |
|---|---|---|
| checkout-service | Cloud Run service | Needs an HTTP server added — see §4 |
| Traffic | Cloud Scheduler → Cloud Run Job | ~60 checkouts/min is enough to exhaust a 50-connection pool on schedule |
| Metrics | Cloud Monitoring | `run.googleapis.com/request_latencies` (p99) and `request_count` by `response_code_class` come free; pool depth needs a log-based metric (§5) |
| Logs | Cloud Logging | Free if the service logs structured JSON to stdout |
| Alerting | Monitoring alert policy | Two conditions, AND'd, so a latency blip alone doesn't page |
| Paging | PagerDuty notification channel | **Already wired on your branch** — the contract this design assumes is in §6 |
| Pipeline trigger | Cloud Run service `pd-webhook` | Signature verification is mandatory; the endpoint is public |
| Pipeline | Cloud Run Job `incident-orchestrator` | The existing `src/orchestrator.ts`, unchanged in shape |
| Secrets | Secret Manager | `CURSOR_API_KEY`, `NOTION_TOKEN`, `PD_API_TOKEN`, `PD_WEBHOOK_SECRET` |
| Container images | Artifact Registry | Two checkout images (v2.14.2, v2.14.3) built once, deployed as separate revisions |

## 4. The checkout service needs two changes before it can run

**(a) There is no HTTP server.** `simulation/checkout-service/src/handler.ts` exports
`processCheckout()` and `getPoolStats()` but nothing listens on a port, and the package has no
dependencies or start script. Cloud Run needs a container that serves `$PORT`. Minimum:

```ts
// src/server.ts
app.post("/checkout", async (_req, res) => res.json(await processCheckout(newOrderId())));
app.get("/healthz",  (_req, res) => res.json({ ok: true, version: VERSION }));
app.get("/pool",     (_req, res) => res.json(getPoolStats()));
```

plus a `Dockerfile` and a `start` script. `/healthz` must keep returning 200 while the pool is
exhausted — the whole point is that the service is *degraded*, not *down*, so Cloud Run must not
restart it out from under the incident.

**(b) The leak doesn't match the story, and on Cloud Run that will show.** The narrative — in the
deploy record, the code comment, and the walkthrough — says connections leak *on the error path
only*. The code leaks on every request: `releaseConnection()` never sets `inUse = false`, and
`processCheckout()` calls it on both branches. Against fixtures nobody notices. Against a real
service it's the difference between the pool exhausting after **50 requests** and after **~333**
(50 ÷ the 15% failure rate) — i.e. between "instant" and a believable 30-minute ramp. Make the code
match the story:

```diff
 releaseConnection(conn: PooledConnection): void {
   const idx = this.connections.findIndex((c) => c.id === conn.id);
   if (idx === -1) throw new Error("pool.releaseConnection: connection not in pool");
-  // Missing: this.connections[idx].inUse = false;
+  this.connections[idx].inUse = false;
 }
```

```diff
 if (!success) {
-  pool.releaseConnection(conn);          // v2.14.3: release removed on the error path
   return { status: "payment_failed" };
 }
```

Now the leak rate really is proportional to the payment failure rate, exactly as the postmortem
claims, and the ramp is tunable by changing the failure rate.

**(c) Pin the instance count: `--min-instances=1 --max-instances=1`.** This one is worth saying out
loud in the interview, because it's a genuine serverless observation: the connection pool lives in
process memory, so with autoscaling each instance gets its own pool and scale-to-zero *silently
fixes the leak*. Serverless can mask resource-exhaustion bugs until the one day traffic keeps every
instance warm. Pinning to a single instance is what makes the incident reproducible — and admitting
*why* you had to pin it is a better answer than pretending it wasn't a choice.

## 5. Signals

**Latency and errors** come free from Cloud Run:

```
run.googleapis.com/request_latencies    ALIGN_PERCENTILE_99, filtered to service_name
run.googleapis.com/request_count        grouped by response_code_class, ratio of 5xx to total
```

**Pool depth** is application state, so it needs to be exported. Cheapest path: log one structured
line per request and define a log-based distribution metric over it.

```ts
console.log(JSON.stringify({ severity: "INFO", message: "checkout", pool_available: stats.available }));
```

```
logging.googleapis.com/user/checkout_pool_available   ← value extractor: jsonPayload.pool_available
```

The alternative — OpenTelemetry to `custom.googleapis.com/*` — is more correct and more setup. For a
demo, the log-based metric is the right trade, and it's worth naming the trade when asked.

**Alert policy**, both conditions required, so a slow dependency alone doesn't page:

```
p99 request latency  > 5000ms   for 2 min   (production: 10 min)
5xx / total          > 5%       for 2 min
notification channel = PagerDuty
```

Use a **2-minute** duration for the demo. Production would be 10 minutes; two minutes is the
difference between a demo that pages while the room is watching and one that pages after everyone
has moved on. Say that you shortened it deliberately.

## 6. The PagerDuty contract

You've already built the wiring, so this is the interface the rest of the design assumes rather than
a proposal:

**Inbound (page → pipeline).** A PagerDuty **v3 webhook subscription** for `incident.triggered`
pointed at the `pd-webhook` Cloud Run service. The service must:

1. Verify `X-PagerDuty-Signature` — HMAC-SHA256 over the raw body with the subscription secret,
   compared with a constant-time compare. The endpoint is public and unauthenticated at the network
   level, so the signature *is* the authentication.
2. Extract `event.data.id` (the PD incident id) and the service name.
3. Trigger a Cloud Run Job execution with those as env overrides.
4. Return `202` — never wait for the pipeline.

**Outbound (pipeline → page).** Two write-backs, and the second is the interesting one:

- **After phase 1**, `POST /incidents/{id}/notes` with the triage summary. So the human who opens
  PagerDuty at 2am finds the correlation already done and attributed.
- **After the verification step**, and *only* if it passed, `PUT /incidents/{id}` → `status:
  resolved`, with a note linking the Notion postmortem. If verification fails, the incident stays
  open and the note says why. **An agent must never be able to resolve a page by asserting it fixed
  something** — resolution is downstream of a measurement, not of a sentence.

## 7. Rewiring the tools

The eight tool signatures don't change. Only what's behind them does — which is the payoff of having
given the agent tools instead of a shell:

| Tool | Today | On GCP |
|---|---|---|
| `get_alert` | reads a JSON fixture | PagerDuty REST `GET /incidents/{id}` |
| `get_metrics` | reads a JSON fixture | Monitoring `projects.timeSeries.list` over the incident window |
| `get_logs` | filters a JSON fixture | Logging `entries.list`, filter `resource.type="cloud_run_revision"` + severity |
| `get_deploy_history` | reads a JSON fixture | Cloud Run Admin API `revisions.list` (+ image tag → commit sha) |
| `get_service_status` | reads simulation state | `services.get` for traffic split, plus a live `GET /healthz` and `/pool` |
| `read_runbook` | local markdown | GCS object, or the Notion page the team actually maintains |
| `read_source_file` | local filesystem | repo baked into the job image, or GitHub contents API |
| `restart_service` | flips a JSON file | `services.updateTraffic` → 100% to the last-known-good revision |

Note `restart_service` becomes something better than a restart. A Cloud Run rollback is instant,
reversible, and leaves an audit trail — and unlike a pod restart it removes the bad code from the
serving path rather than resetting its symptoms. Rename it `rollback_traffic` and the agent's own
reasoning improves, because the tool name stops implying the wrong mental model.

## 8. Permissions, and the gate the demo doesn't have yet

A dedicated service account per workload, nothing shared:

| Workload | Roles |
|---|---|
| `checkout-svc` | none beyond default logging |
| `shopper` job | `run.invoker` on checkout-svc only |
| `pd-webhook` | `run.developer` scoped to *executing the orchestrator job* |
| `incident-orchestrator` | `monitoring.viewer`, `logging.viewer`, `run.viewer`, `secretmanager.secretAccessor`, and `run.admin` **scoped by IAM condition to the single checkout-svc resource** |

That last condition is the important one: the agent can shift traffic on exactly one service and
nothing else in the project. Every call it makes lands in Cloud Audit Logs with the SA identity.

**And that still isn't approval.** Least privilege bounds the blast radius; it doesn't put a human in
the loop. The production answer is that the agent *proposes* the rollback and the webhook service
posts it to PagerDuty or Slack as a button — the pipeline blocks until someone clicks. For the
interview, having both halves of that answer ("here's the bound, here's why the bound isn't
consent") is stronger than having either.

## 9. Measured recovery — the part that was fake

After the rollback, the pipeline **does not ask the agent whether it worked.** It runs a verification
step in plain code:

```
wait 3 minutes for the alignment window to fill, then query Monitoring:
  p99 over the post-rollback window        < 1000ms
  5xx ratio over the post-rollback window  < 1%
  checkout_pool_available                  > 40
  no new alert on the policy since the rollback
all four → resolved. any one fails → incident stays open, human stays paged.
```

Four signals, none of them produced by the agent, all queried from a system it has read-only access
to. This is the one place in the design where a model's opinion is deliberately not consulted, and
it's the thing to point at when someone asks how you'd trust this in production: **the agent
investigates and proposes; a deterministic check decides whether the incident is over.**

## 10. Cost and practicality

- Cloud Run with `min-instances=1` is the only meaningful cost — single-digit dollars a month at
  demo scale. Everything else (Scheduler, one log-based metric, one alert policy, Logging at this
  volume) sits inside free tiers.
- **The live incident takes ~15 minutes** from deploying the leaky revision to a PagerDuty page:
  the pool has to actually drain, then the alert duration has to elapse. That's too long to watch
  in an interview. Trigger it before you go in, or shorten the alert duration and raise the failure
  rate, and be explicit that you did.
- Deploy with a `Makefile` of `gcloud` commands, not Terraform. It's more legible on a screen share
  and there's nothing to explain. Say "Terraform in production" and move on.

## 11. Build order

Each step is demoable on its own, so a slip never leaves you with nothing:

1. `server.ts` + `Dockerfile`, deploy v2.14.2 to Cloud Run, hit `/checkout` from a browser.
2. Fix the leak semantics (§4b), build v2.14.3, deploy as a second revision. Watch `/pool` drain.
3. Scheduler + shopper job, so it drains without you.
4. Log-based metric + alert policy + PagerDuty channel → **the page fires by itself.** Stop here and
   you already have a much better demo than the fixtures.
5. `pd-webhook` service with signature verification, triggering the orchestrator job.
6. Swap the tool implementations to the real APIs, one at a time — the pipeline keeps running
   against fixtures for any tool not yet swapped.
7. The verification step and the PagerDuty resolve write-back.

## 12. What to say about the migration itself

> "The agent design didn't change. Eight tool signatures stayed identical; I replaced fixture reads
> with Monitoring, Logging and the Cloud Run Admin API behind them. That's the case for giving an
> agent a bounded tool surface instead of a shell — the same reason it's safe is the reason it's
> portable. The two things that *did* change are the ones I couldn't fake: the rollback is now a
> real traffic shift I have an audit log for, and 'did it recover' is a Monitoring query instead of
> a sentence the model wrote."
