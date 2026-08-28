import "dotenv/config";
import { runIncidentPipeline } from "./orchestrator.js";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");

const apiKey = process.env.CURSOR_API_KEY ?? "";
const model = process.env.CURSOR_MODEL ?? "composer-2.5";
const notionToken = process.env.NOTION_TOKEN;
const notionParentPageId = process.env.NOTION_PARENT_PAGE_ID;

if (!dryRun && !apiKey) {
  console.log("No CURSOR_API_KEY found — running in dry-run mode.");
  console.log("Set CURSOR_API_KEY in .env to use live Cursor SDK agents.\n");
}

await runIncidentPipeline({
  apiKey,
  model,
  dryRun: dryRun || !apiKey,
  notionToken,
  notionParentPageId,
});
