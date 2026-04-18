import { createReadTools } from "./mcp-read-tools.js";
import { createWriteTools } from "./mcp-write-tools.js";

export function createTools(workspace, portFlag) {
  const tools = [...createReadTools(workspace), ...createWriteTools(workspace, portFlag)];
  return new Map(tools.map((tool) => [tool.name, tool]));
}
