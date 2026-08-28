# SRE Incident Response — Cursor SDK Demo

**Alert → Triage → Investigation → Remediation → Postmortem**

A working prototype that demonstrates how Cursor SDK agents automate the full SRE incident lifecycle — from a 2am P1 alert through root cause analysis to a blameless postmortem in Notion.

## The Problem

At 2:04 AM, checkout latency spikes. The on-call engineer stares at four different tools — dashboards, logs, deploy history, runbooks — trying to correlate signals while customers can't check out. After a restart, everyone goes back to bed. Days later, someone writes the postmortem from memory.

This demo shows how **programmatic Cursor SDK agents** can do that correlation, investigation, and documentation automatically.

## Architecture

```
┌─────────────┐     ┌──────────────────────────────────────────────────┐
│   Alert     │────▶│           Cursor SDK Orchestrator                │
│  (PagerDuty)│     │                                                  │
└─────────────┘     │  ┌─────────────┐  ┌──────────────────┐          │
                    │  │ Triage Agent│  │ Investigator Agent│          │
┌─────────────┐     │  │ (subagent)  │  │   (subagent)      │          │
│  Metrics    │◀───▶│  └──────┬──────┘  └────────┬─────────┘          │
│  Logs       │     │         │                   │                    │
│  Deploys    │     │  Custom SDK Tools           │                    │
│  Runbooks   │     │  ├─ get_alert              │                    │
└─────────────┘     │  ├─ get_metrics             │                    │
                    │  ├─ get_logs                │                    │
┌─────────────┐     │  ├─ get_deploy_history      │                    │
│  Service    │◀───▶│  ├─ restart_service         │                    │
│  (simulated)│     │  └─ read_source_file        │                    │
└─────────────┘     │                             ▼                    │
                    │                  ┌──────────────────┐          │
┌─────────────┐     │                  │ Postmortem Writer │          │
│   Notion    │◀────│                  │   (subagent)      │          │
│  (via MCP)  │     │                  └──────────────────┘          │
└─────────────┘     └──────────────────────────────────────────────────┘
```

### Key Cursor SDK Features Demonstrated

| Feature | How It's Used |
|---------|---------------|
| **Custom Tools** | Simulated observability APIs (metrics, logs, deploys, restart) |
| **Subagents** | Specialized triage, investigation, and postmortem agents |
| **MCP Integration** | Notion MCP for postmortems; PagerDuty MCP for incident lifecycle |
| **Streaming** | Real-time event stream during demo for visibility |
| **Multi-step orchestration** | Sequential phases with context passing between agents |

## The Incident Story

**INC-2026-0847** — Checkout service degradation

1. **01:15 UTC** — Deploy `v2.14.3` changes connection pool handling
2. **01:45 UTC** — Pool utilization climbs, latency starts spiking
3. **02:04 UTC** — P1 alert fires: p99 latency 9.2s, 23% error rate
4. **02:08 UTC** — SDK agents triage across 4 signal sources
5. **02:12 UTC** — Root cause found: connection leak in `pool.ts`
6. **02:15 UTC** — Service restarted, error rate drops to 0.4%
7. **02:20 UTC** — Postmortem written to Notion with action items

## Quick Start

### Prerequisites

- Node.js 22.13+
- [Cursor API key](https://cursor.com/dashboard/integrations)
- (Optional) [Notion integration token](https://www.notion.so/my-integrations)
- (Optional) [PagerDuty API key](https://support.pagerduty.com/docs/api-access-keys) + [uv](https://docs.astral.sh/uv/) for PagerDuty MCP (`uvx`)

### Setup

```bash
git clone https://github.com/gaurav-an-sre/sre-demo-incident.git
cd sre-demo-incident
pnpm install
cp .env.example .env
# Edit .env with your CURSOR_API_KEY
```

### Run the Demo

```bash
# Dry run (no API key needed — shows the full flow with simulated agent output)
pnpm demo:dry-run

# Live demo with Cursor SDK agents
pnpm demo
```

### Notion Integration

1. Create a Notion integration at https://www.notion.so/my-integrations
2. Share a parent page with your integration
3. Set in `.env`:
   ```
   NOTION_TOKEN=ntn_your_token_here
   NOTION_PARENT_PAGE_ID=your_page_id
   ```

### PagerDuty Integration

PagerDuty is wired via the [official PagerDuty MCP server](https://github.com/PagerDuty/pagerduty-mcp-server).

1. Install `uv` (provides `uvx`): https://docs.astral.sh/uv/getting-started/installation/
2. Create a PagerDuty **User API Token** (needs read + write for acknowledge/resolve)
3. Add to `.env`:
   ```
   PAGERDUTY_USER_API_KEY=your_token_here
   # EU accounts only:
   PAGERDUTY_API_HOST=https://api.eu.pagerduty.com
   # Optional: target a specific incident
   PAGERDUTY_INCIDENT_ID=Q0XXXX
   PAGERDUTY_SERVICE_NAME=checkout-service
   ```

**What the agent does in PagerDuty:**
- **Phase 0:** `list_incidents` → `get_incident` → acknowledge
- **Triage/Remediate:** `add_note_to_incident` with findings
- **Postmortem:** `manage_incidents` resolve + link incident ID in Notion

For the interview demo, create a test incident in PagerDuty titled "Checkout service high latency" before running `pnpm demo`.

## Demo Script 

1. **Set the scene** (30s): "It's 2am. Checkout is down. Four tools, no correlation."
2. **Show the alert** (30s): Point at `simulation/data/alerts/checkout-latency.json`
3. **Run `pnpm demo`** (10min): Watch agents stream through triage → investigate → remediate → postmortem
4. **Walk architecture** (5min): Custom tools, subagents, MCP, orchestration
5. **Show Notion output** (2min): Incident page + postmortem with action items
6. **Discuss trade-offs** (5min): See below

## Design Decisions & Trade-offs

| Decision | Rationale | Trade-off |
|----------|-----------|-----------|
| Local agents + custom tools | Fast iteration, no VM spin-up for demo | Not production-scale; cloud agents better for parallel fan-out |
| Simulated observability data | Reproducible demo, no real infra needed | Less impressive than live Prometheus/Grafana |
| Sequential phases | Clear narrative for interview demo | Slower than parallel investigation |
| Notion via MCP | Shows real enterprise doc workflow | Requires user setup; falls back to markdown |
| Connection pool leak scenario | Classic, relatable SRE story | Deliberately simple root cause |

## Project Structure

```
├── src/
│   ├── index.ts              # CLI entry point
│   ├── orchestrator.ts       # Multi-phase agent pipeline
│   ├── logger.ts             # Demo-friendly terminal output
│   ├── tools/
│   │   └── incident-tools.ts # Custom SDK tools (observability APIs)
│   └── agents/
│       └── definitions.ts    # Subagent definitions
├── simulation/
│   ├── checkout-service/     # Service with deliberate pool.ts bug
│   ├── data/                   # Alerts, metrics, logs, deploys
│   └── runbooks/               # SRE runbooks
└── .cursor/
    ├── agents/                 # File-based subagent definitions
    └── mcp.json                # Notion MCP config
```

## Extending Live

Ideas for the "extend it live" portion of the interview:

- Add a **Slack MCP** subagent for on-call notifications
- Switch to **cloud agents** for parallel investigation across services
- Add **hooks** to gate `restart_service` behind approval
- Wire up real **Prometheus/Grafana** via MCP instead of simulated data
- Add a **DAG task runner** pattern from the Cursor cookbook

## License

MIT
