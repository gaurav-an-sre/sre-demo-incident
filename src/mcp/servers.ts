import type { McpServerConfig } from "@cursor/sdk";

export interface McpServerOptions {
  notionToken?: string;
  pagerDutyApiKey?: string;
  pagerDutyApiHost?: string;
}

export function buildMcpServers(
  opts: McpServerOptions,
): Record<string, McpServerConfig> | undefined {
  const servers: Record<string, McpServerConfig> = {};

  if (opts.notionToken) {
    servers.notion = {
      type: "stdio",
      command: "npx",
      args: ["-y", "@notionhq/notion-mcp-server"],
      env: {
        NOTION_TOKEN: opts.notionToken,
        OPENAPI_MCP_HEADERS: JSON.stringify({
          Authorization: `Bearer ${opts.notionToken}`,
          "Notion-Version": "2022-06-28",
        }),
      },
    };
  }

  if (opts.pagerDutyApiKey) {
    const env: Record<string, string> = {
      PAGERDUTY_USER_API_KEY: opts.pagerDutyApiKey,
    };
    if (opts.pagerDutyApiHost) {
      env.PAGERDUTY_API_HOST = opts.pagerDutyApiHost;
    }

    servers.pagerduty = {
      type: "stdio",
      command: "uvx",
      args: ["pagerduty-mcp", "--enable-write-tools"],
      env,
    };
  }

  return Object.keys(servers).length > 0 ? servers : undefined;
}
