import { config } from "dotenv";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runIncidentPipeline } from "./orchestrator.js";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const envPath = join(projectRoot, ".env");

if (existsSync(envPath)) {
  config({ path: envPath });
} else {
  config();
}

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");

const apiKey = process.env.CURSOR_API_KEY?.trim() ?? "";
const model = process.env.CURSOR_MODEL?.trim() || "composer-2.5";
const notionToken = process.env.NOTION_TOKEN?.trim();
const notionParentPageId = process.env.NOTION_PARENT_PAGE_ID?.trim();
const pagerDutyApiKey = process.env.PAGERDUTY_USER_API_KEY?.trim();
const pagerDutyApiHost = process.env.PAGERDUTY_API_HOST?.trim();
const pagerDutyServiceName = process.env.PAGERDUTY_SERVICE_NAME?.trim();
const pagerDutyIncidentId = process.env.PAGERDUTY_INCIDENT_ID?.trim();

if (!dryRun && !apiKey) {
  console.log("No CURSOR_API_KEY found — running in dry-run mode.");
  console.log(`Checked .env at: ${envPath}`);
  console.log(`File exists: ${existsSync(envPath)}`);
  console.log("");
  console.log("Fix:");
  console.log("  1. Open .env in the project root (same folder as package.json)");
  console.log("  2. Set: CURSOR_API_KEY=your_key_here");
  console.log("     (no spaces around =, no quotes needed)");
  console.log("  3. Save the file, then run: pnpm demo");
  console.log("");
  console.log("Or export in your terminal:");
  console.log("  export CURSOR_API_KEY=your_key_here && pnpm demo");
  console.log("");
}

await runIncidentPipeline({
  apiKey,
  model,
  dryRun: dryRun || !apiKey,
  notionToken,
  notionParentPageId,
  pagerDutyApiKey,
  pagerDutyApiHost,
  pagerDutyServiceName,
  pagerDutyIncidentId,
});
