import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { SDKCustomTool } from "@cursor/sdk";

const ROOT = process.cwd();
const DATA = join(ROOT, "simulation", "data");
const STATE_FILE = join(ROOT, ".simulation-state.json");

interface SimulationState {
  service_restarted: boolean;
  restarted_at: string | null;
  incident_status: "firing" | "mitigated" | "resolved";
}

function loadState(): SimulationState {
  if (!existsSync(STATE_FILE)) {
    return { service_restarted: false, restarted_at: null, incident_status: "firing" };
  }
  return JSON.parse(readFileSync(STATE_FILE, "utf-8"));
}

function saveState(state: SimulationState) {
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf-8"));
}

export function createIncidentTools(): Record<string, SDKCustomTool> {
  return {
    get_alert: {
      description:
        "Fetch the currently firing alert for an incident. Returns alert metadata, severity, and annotations.",
      inputSchema: {
        type: "object",
        properties: {
          alert_id: { type: "string", description: "Alert identifier (optional)" },
        },
      },
      async execute() {
        const alert = readJson(join(DATA, "alerts", "checkout-latency.json"));
        return JSON.stringify(alert, null, 2);
      },
    },

    get_metrics: {
      description:
        "Fetch time-series metrics for a service during the incident window. Includes latency percentiles, error rate, and connection pool stats.",
      inputSchema: {
        type: "object",
        properties: {
          service: { type: "string", description: "Service name (e.g. checkout-service)" },
        },
        required: ["service"],
      },
      async execute({ service }) {
        const metrics = readJson<Record<string, unknown>>(
          join(DATA, "metrics", `${service}.json`),
        );
        const state = loadState();
        if (state.service_restarted) {
          return JSON.stringify(
            {
              ...metrics,
              post_restart: {
                restarted_at: state.restarted_at,
                p99_ms: 380,
                error_rate_pct: 0.4,
                pool_available: 48,
                note: "Metrics recovered after service restart",
              },
            },
            null,
            2,
          );
        }
        return JSON.stringify(metrics, null, 2);
      },
    },

    get_logs: {
      description:
        "Fetch structured log entries for a service. Filter by level (INFO, WARN, ERROR, CRITICAL).",
      inputSchema: {
        type: "object",
        properties: {
          service: { type: "string", description: "Service name" },
          level: {
            type: "string",
            description: "Minimum log level filter",
            enum: ["INFO", "WARN", "ERROR", "CRITICAL"],
          },
          limit: { type: "number", description: "Max entries to return (default 20)" },
        },
        required: ["service"],
      },
      async execute({ service, level, limit }) {
        const data = readJson<{ entries: Array<{ level: string }> }>(
          join(DATA, "logs", `${service}.json`),
        );
        const levels = ["INFO", "WARN", "ERROR", "CRITICAL"];
        const minIdx = level ? levels.indexOf(level as string) : 0;
        const filtered = data.entries.filter(
          (e) => levels.indexOf(e.level) >= minIdx,
        );
        const max = typeof limit === "number" ? limit : 20;
        return JSON.stringify({ service, entries: filtered.slice(-max) }, null, 2);
      },
    },

    get_deploy_history: {
      description:
        "Fetch recent deployment history for a service. Includes version, deployer, changed files, and diff summaries.",
      inputSchema: {
        type: "object",
        properties: {
          service: { type: "string", description: "Service name" },
          hours: { type: "number", description: "Lookback window in hours (default 24)" },
        },
        required: ["service"],
      },
      async execute({ service }) {
        const deploys = readJson(join(DATA, "deploys", `${service}.json`));
        return JSON.stringify(deploys, null, 2);
      },
    },

    get_service_status: {
      description:
        "Get current health status of a service including pool stats, error rate, and version.",
      inputSchema: {
        type: "object",
        properties: {
          service: { type: "string", description: "Service name" },
        },
        required: ["service"],
      },
      async execute({ service }) {
        const state = loadState();
        const deploys = readJson<{ deploys: Array<{ version: string; status: string }> }>(
          join(DATA, "deploys", `${service}.json`),
        );
        const current = deploys.deploys.find((d) => d.status === "degraded") ??
          deploys.deploys[deploys.deploys.length - 2];

        if (state.service_restarted) {
          return JSON.stringify(
            {
              service,
              version: current.version,
              status: "healthy",
              error_rate_pct: 0.4,
              pool: { available: 48, in_use: 2, max: 50 },
              restarted_at: state.restarted_at,
              note: "Service recovered after pod restart",
            },
            null,
            2,
          );
        }

        return JSON.stringify(
          {
            service,
            version: current.version,
            status: "degraded",
            error_rate_pct: 23.1,
            pool: { available: 0, in_use: 50, max: 50 },
            incident_status: state.incident_status,
          },
          null,
          2,
        );
      },
    },

    restart_service: {
      description:
        "Restart a service by rolling its pods. Use when connection pool is exhausted or service is unresponsive. This is a mitigation, not a permanent fix.",
      inputSchema: {
        type: "object",
        properties: {
          service: { type: "string", description: "Service name to restart" },
          reason: { type: "string", description: "Reason for restart" },
        },
        required: ["service", "reason"],
      },
      async execute({ service, reason }) {
        const now = new Date().toISOString();
        saveState({
          service_restarted: true,
          restarted_at: now,
          incident_status: "mitigated",
        });
        return JSON.stringify(
          {
            action: "restart",
            service,
            reason,
            restarted_at: now,
            status: "mitigated",
            message: `Rolled 8 pods for ${service}. Connection pool reset. Error rate dropping.`,
          },
          null,
          2,
        );
      },
    },

    read_runbook: {
      description: "Read the incident runbook for a service.",
      inputSchema: {
        type: "object",
        properties: {
          service: { type: "string", description: "Service name" },
        },
        required: ["service"],
      },
      async execute({ service }) {
        const path = join(ROOT, "simulation", "runbooks", `${service}.md`);
        return readFileSync(path, "utf-8");
      },
    },

    read_source_file: {
      description:
        "Read a source file from the checkout-service codebase to investigate the root cause.",
      inputSchema: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Relative path within simulation/checkout-service/",
          },
        },
        required: ["path"],
      },
      async execute({ path: filePath }) {
        const full = join(ROOT, "simulation", "checkout-service", filePath as string);
        return readFileSync(full, "utf-8");
      },
    },
  };
}

export function resetSimulationState() {
  if (existsSync(STATE_FILE)) {
    writeFileSync(
      STATE_FILE,
      JSON.stringify(
        { service_restarted: false, restarted_at: null, incident_status: "firing" },
        null,
        2,
      ),
    );
  }
}
