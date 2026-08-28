import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Agent, type SDKAgent, type SDKMessage } from "@cursor/sdk";
import { subagents } from "./agents/definitions.js";
import { buildMcpServers } from "./mcp/servers.js";
import { createIncidentTools, resetSimulationState } from "./tools/incident-tools.js";
import * as log from "./logger.js";

export interface OrchestratorOptions {
  apiKey: string;
  model: string;
  dryRun: boolean;
  notionToken?: string;
  notionParentPageId?: string;
  pagerDutyApiKey?: string;
  pagerDutyApiHost?: string;
  pagerDutyServiceName?: string;
  pagerDutyIncidentId?: string;
}

interface PhaseResult {
  phase: string;
  output: string;
}

async function streamRun(
  agent: SDKAgent,
  prompt: string,
  phaseName: log.Phase,
): Promise<string> {
  log.phase(phaseName, "Agent working...");
  const run = await agent.send(prompt);
  let output = "";

  for await (const event of run.stream()) {
    handleStreamEvent(event, phaseName);

    if (event.type === "assistant") {
      for (const block of event.message.content) {
        if (block.type === "text") {
          output += block.text;
        }
      }
    }
  }

  const result = await run.wait();
  if (result.status !== "finished") {
    log.warn(`Run ended with status: ${result.status}`);
  }

  return output.trim();
}

function handleStreamEvent(event: SDKMessage, phaseName: log.Phase) {
  if (event.type === "status") {
    log.info(`status: ${event.status}`);
  }
  if (event.type === "tool_call" && event.status !== "running") {
    log.toolCall(event.name, event.status);
  }
  if (event.type === "assistant") {
    for (const block of event.message.content) {
      if (block.type === "text" && block.text.trim()) {
        // Stream partial text in dim for live demo effect
        const preview = block.text.trim().slice(0, 120);
        if (preview.length > 0) {
          process.stdout.write(`\r  ${preview}${preview.length >= 120 ? "..." : ""}`.padEnd(80));
        }
      }
    }
  }
}

function loadAlert() {
  const path = join(process.cwd(), "simulation", "data", "alerts", "checkout-latency.json");
  return JSON.parse(readFileSync(path, "utf-8"));
}

async function runDryRun(): Promise<void> {
  const alert = loadAlert();
  log.banner("SRE Incident Response — Dry Run (no Cursor API key)");
  log.phase("alert", `🚨 ${alert.alert_name} — ${alert.severity}`);
  log.info(`Service: ${alert.service}`);
  log.info(`Fired: ${alert.fired_at}`);
  log.info(alert.description);
  log.info(`Impact: ${alert.annotations.summary}`);

  await log.sleep(1000);

  log.phase("alert", "PagerDuty — fetching open incidents...");
  log.toolCall("pagerduty:list_incidents", "completed");
  log.toolCall("pagerduty:get_incident", "completed");
  log.toolCall("pagerduty:manage_incidents", "completed");
  log.success("Acknowledged PagerDuty incident #INC-2026-0847");

  await log.sleep(1000);

  log.phase("triage", "Correlating signals across 4 tools...");
  log.toolCall("get_alert", "completed");
  log.toolCall("get_metrics", "completed");
  log.toolCall("get_logs", "completed");
  log.toolCall("get_deploy_history", "completed");

  log.assistantText(`
Triage Summary:
- Severity: P1 confirmed
- Degradation started ~01:45 UTC, 30min after deploy v2.14.3
- Connection pool exhausted (0/50 available) correlates with latency spike
- Error logs show "connection leaked" and "PoolExhaustedError"
- Likely cause: deploy regression in connection pool management`);

  await log.sleep(1500);

  log.phase("investigate", "Analyzing root cause...");
  log.toolCall("read_source_file", "completed");
  log.toolCall("read_source_file", "completed");

  log.assistantText(`
Root Cause: v2.14.3 removed connection release on error path in pool.ts:releaseConnection()
Mechanism: Failed payments leak connections → pool exhausts → 503s
Evidence: Deploy at 01:15 → pool warnings at 01:30 → exhaustion at 01:48 → alert at 02:04
Fix needed: Code fix in pool.ts + restart for immediate recovery`);

  await log.sleep(1500);

  log.phase("remediate", "Executing mitigation...");
  log.toolCall("restart_service", "completed");
  log.toolCall("pagerduty:add_note_to_incident", "completed");
  log.success("Service restarted — error rate dropping to 0.4%");

  await log.sleep(1000);

  log.phase("postmortem", "Writing postmortem...");
  log.toolCall("pagerduty:manage_incidents", "completed");
  log.success("PagerDuty incident resolved");
  log.warn("Notion MCP not configured — outputting markdown postmortem");
  log.assistantText(`
# Postmortem: INC-2026-0847 Checkout Service Degradation

**Duration:** 01:45 - 02:25 UTC (40 min) | **Impact:** ~$480k revenue at risk
**Root Cause:** Connection pool leak in v2.14.3 pool.ts releaseConnection()

## Action Items
1. [ ] Fix pool.ts connection release bug — @jchen — 2026-08-29
2. [ ] Add pool exhaustion alert — @sre-team — 2026-09-01
3. [ ] Integration test for error-path release — @jchen — 2026-09-05`);

  log.phase("complete", "Incident pipeline complete (dry run)");
  log.info("Set CURSOR_API_KEY to run with live Cursor SDK agents");
}

export async function runIncidentPipeline(opts: OrchestratorOptions): Promise<void> {
  resetSimulationState();

  if (opts.dryRun || !opts.apiKey) {
    await runDryRun();
    return;
  }

  const alert = loadAlert();
  const mcpServers = buildMcpServers({
    notionToken: opts.notionToken,
    pagerDutyApiKey: opts.pagerDutyApiKey,
    pagerDutyApiHost: opts.pagerDutyApiHost,
  });
  const results: PhaseResult[] = [];
  const serviceName = opts.pagerDutyServiceName ?? alert.service;
  const incidentHint = opts.pagerDutyIncidentId
    ? `Use PagerDuty incident ID: ${opts.pagerDutyIncidentId}`
    : `Look for open incidents related to service "${serviceName}" or title containing "checkout" / "latency"`;

  log.banner("SRE Incident Response — Cursor SDK Agent Pipeline");
  if (opts.pagerDutyApiKey) {
    log.success("PagerDuty MCP enabled");
  }
  if (opts.notionToken) {
    log.success("Notion MCP enabled");
  }
  log.phase("alert", `🚨 ${alert.alert_name} — ${alert.severity}`);
  log.info(`Incident: ${alert.incident_id}`);
  log.info(`Service: ${alert.service} | Fired: ${alert.fired_at}`);
  log.info(alert.annotations.summary);
  await log.sleep(2000);

  await using agent = await Agent.create({
    apiKey: opts.apiKey,
    name: "SRE Incident Commander",
    model: { id: opts.model },
    local: {
      cwd: process.cwd(),
      customTools: createIncidentTools(),
      settingSources: ["project"],
    },
    agents: subagents,
    mcpServers,
  });

  // Phase 0: PagerDuty alert intake
  let pagerDutyOutput = "";
  if (opts.pagerDutyApiKey) {
    log.banner("Phase 0: PagerDuty — Acknowledge on-call incident");
    pagerDutyOutput = await streamRun(
      agent,
      `A PagerDuty alert just woke up on-call. Handle initial incident intake.

Simulated alert context:
${JSON.stringify(alert, null, 2)}

${incidentHint}

Use the pagerduty-oncall subagent and PagerDuty MCP tools to:
1. list_incidents for open/triggered incidents (statuses: triggered, acknowledged)
2. get_incident for the matching checkout/latency incident
3. manage_incidents to acknowledge the incident (status: acknowledged)
4. add_note_to_incident with: "SDK agent engaged — starting automated triage"

Return: PagerDuty incident ID, title, status, service, and assigned escalation policy.`,
      "alert",
    );
    results.push({ phase: "pagerduty", output: pagerDutyOutput });
    console.log();
    log.assistantText(pagerDutyOutput.slice(0, 1500));
    await log.sleep(1500);
  }

  // Phase 1: Triage
  log.banner("Phase 1: Triage — Correlating observability signals");
  const triageOutput = await streamRun(
    agent,
    `An incident alert just fired. Perform initial triage for ${alert.service}.

Alert details:
${JSON.stringify(alert, null, 2)}
${pagerDutyOutput ? `\nPagerDuty context:\n${pagerDutyOutput}` : ""}

Use the triage-agent subagent to correlate data from all observability tools.
Check: metrics, logs, deploy history, and current service status.
${opts.pagerDutyApiKey ? "Add a PagerDuty note summarizing triage findings via add_note_to_incident." : ""}
Produce a structured triage report.`,
    "triage",
  );
  results.push({ phase: "triage", output: triageOutput });
  console.log();
  log.assistantText(triageOutput.slice(0, 2000));
  await log.sleep(1500);

  // Phase 2: Investigation
  log.banner("Phase 2: Investigation — Root cause analysis");
  const investigateOutput = await streamRun(
    agent,
    `Based on triage findings, perform root cause analysis.

Triage report:
${triageOutput}

Use the investigator-agent subagent to:
1. Examine the suspect deploy's changed files
2. Read pool.ts and handler.ts in simulation/checkout-service/
3. Connect log stack traces to the code bug

Produce a detailed root cause analysis with evidence chain.`,
    "investigate",
  );
  results.push({ phase: "investigate", output: investigateOutput });
  console.log();
  log.assistantText(investigateOutput.slice(0, 2000));
  await log.sleep(1500);

  // Phase 3: Remediation
  log.banner("Phase 3: Remediation — Mitigate customer impact");
  const remediateOutput = await streamRun(
    agent,
    `The service is still degraded. Take immediate mitigation action.

Root cause analysis:
${investigateOutput}
${pagerDutyOutput ? `\nPagerDuty incident:\n${pagerDutyOutput}` : ""}

1. Read the runbook for checkout-service
2. Restart the service using restart_service to recover the connection pool
3. Verify recovery with get_service_status and get_metrics
${opts.pagerDutyApiKey ? "4. add_note_to_incident with mitigation summary (restart completed, error rate recovering)" : "4."}
Summarize what was done and what permanent fix is still needed`,
    "remediate",
  );
  results.push({ phase: "remediate", output: remediateOutput });
  console.log();
  log.assistantText(remediateOutput.slice(0, 1500));
  await log.sleep(1500);

  // Phase 4: Postmortem
  log.banner("Phase 4: Postmortem — Document in Notion");
  const postmortemPrompt = opts.notionToken
    ? `Write the incident record and postmortem to Notion.

${opts.notionParentPageId ? `Create pages under Notion parent page ID: ${opts.notionParentPageId}` : "Search for or create an 'SRE Incidents' parent page in Notion."}

Use the postmortem-writer subagent.
${opts.pagerDutyApiKey ? "Include the PagerDuty incident URL/ID in the Notion page. Resolve the PagerDuty incident via manage_incidents (status: resolved) and add a final resolution note." : ""}

Full incident context:
Alert: ${JSON.stringify(alert)}
${pagerDutyOutput ? `PagerDuty: ${pagerDutyOutput}` : ""}
Triage: ${triageOutput}
Root Cause: ${investigateOutput}
Remediation: ${remediateOutput}`
    : `Write a complete postmortem document as markdown (Notion is not configured).

Use the postmortem-writer subagent style but output markdown directly.
${opts.pagerDutyApiKey ? "Resolve the PagerDuty incident via manage_incidents (status: resolved) and add a resolution note with root cause + action items." : ""}

Full incident context:
Alert: ${JSON.stringify(alert)}
${pagerDutyOutput ? `PagerDuty: ${pagerDutyOutput}` : ""}
Triage: ${triageOutput}
Root Cause: ${investigateOutput}
Remediation: ${remediateOutput}`;

  const postmortemOutput = await streamRun(agent, postmortemPrompt, "postmortem");
  results.push({ phase: "postmortem", output: postmortemOutput });
  console.log();
  log.assistantText(postmortemOutput.slice(0, 2500));

  log.banner("Incident Pipeline Complete");
  log.success(`Processed ${results.length} phases`);
  log.info("PagerDuty → Triage → Investigation → Remediation → Postmortem");
  if (opts.pagerDutyApiKey) {
    log.success("PagerDuty incident lifecycle managed via MCP");
  } else {
    log.warn("Set PAGERDUTY_USER_API_KEY to integrate with your PagerDuty account");
  }
  if (opts.notionToken) {
    log.success("Postmortem written to Notion");
  } else {
    log.warn("Set NOTION_TOKEN to write postmortem to Notion automatically");
  }
}
