import chalk from "chalk";

export type Phase =
  | "alert"
  | "triage"
  | "investigate"
  | "remediate"
  | "postmortem"
  | "complete";

const phaseColors: Record<Phase, (s: string) => string> = {
  alert: chalk.red.bold,
  triage: chalk.yellow.bold,
  investigate: chalk.cyan.bold,
  remediate: chalk.magenta.bold,
  postmortem: chalk.green.bold,
  complete: chalk.white.bold,
};

export function banner(text: string) {
  const line = "═".repeat(60);
  console.log(chalk.gray(`\n${line}`));
  console.log(chalk.white.bold(`  ${text}`));
  console.log(chalk.gray(`${line}\n`));
}

export function phase(phaseName: Phase, text: string) {
  const label = phaseColors[phaseName](`[${phaseName.toUpperCase()}]`);
  console.log(`${label} ${text}`);
}

export function info(text: string) {
  console.log(chalk.blue("  →"), text);
}

export function success(text: string) {
  console.log(chalk.green("  ✓"), text);
}

export function warn(text: string) {
  console.log(chalk.yellow("  ⚠"), text);
}

export function error(text: string) {
  console.log(chalk.red("  ✗"), text);
}

export function toolCall(name: string, status: string) {
  const icon = status === "completed" ? chalk.green("●") : chalk.gray("○");
  console.log(`  ${icon} ${chalk.dim("tool:")} ${name} ${chalk.dim(`(${status})`)}`);
}

export function assistantText(text: string) {
  const lines = text.trim().split("\n");
  for (const line of lines) {
    console.log(chalk.white(`  ${line}`));
  }
}

export function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
