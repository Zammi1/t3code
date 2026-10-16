// Stand-in for wa-agent's `wa` MCP stdio server in tests. Answers each tool
// with a canned result from the scenario and appends every call to a log, so
// tests can prove which tools ran. It also exposes the bridge's mutating
// tools, which the adapter must never call.
import * as NodeFS from "node:fs";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const ALL_TOOLS = [
  "status",
  "list_chats",
  "find_chat",
  "read_chat",
  "search_messages",
  "list_people",
  "set_person",
  "set_away",
  "set_instructions",
  "sales_stats",
  "set_outcome",
  "list_files",
  "get_file",
  "send_file",
  "ask_assistant",
  "send_message",
];

export async function run(scenario) {
  const tools = ALL_TOOLS.filter((name) => name !== "ask_assistant" || !process.env.WA_MCP_NESTED);
  const server = new Server({ name: "wa", version: "1.0.0" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((name) => ({ name, inputSchema: { type: "object" } })),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args = {} } = request.params;
    NodeFS.appendFileSync(
      scenario.log,
      `${JSON.stringify({
        name,
        args,
        nested: process.env.WA_MCP_NESTED ?? null,
        source: process.env.WA_MCP_SOURCE ?? null,
        inheritedSecret: process.env.T3_FAKE_SECRET ?? null,
      })}\n`,
    );
    if (!tools.includes(name))
      return { content: [{ type: "text", text: `no tool ${name}` }], isError: true };
    if (scenario.delayMs) await new Promise((resolve) => setTimeout(resolve, scenario.delayMs));
    const answer = scenario.tools?.[name] ?? { text: `unexpected tool ${name}`, isError: true };
    return { content: [{ type: "text", text: answer.text }], isError: answer.isError === true };
  });
  await server.connect(new StdioServerTransport());
}
