import { t as __exportAll } from "./rolldown-runtime-D7D4PA-g.mjs";
//#region src/mcp-entry.ts
var mcp_entry_exports = /* @__PURE__ */ __exportAll({
	isMcpEntry: () => isMcpEntry,
	mcpEntryConfig: () => mcpEntryConfig,
	serverNameOf: () => serverNameOf
});
/** 判定 loader entry 是否为 MCP 行（dsh-mcp-client 或带 serverName 配置的行）。 */
function isMcpEntry(entry) {
	if (entry.options.group) return false;
	const cfg = entry.options.config;
	return entry.options.name === "@deepseek-ai/dsh-mcp-client" || cfg !== null && typeof cfg === "object" && "serverName" in cfg;
}
/** 取 MCP 行的 serverName（config.serverName 缺省回落 entry id）。 */
function serverNameOf(entry) {
	const cfg = entry.options.config;
	return String(cfg?.serverName ?? entry.options.id);
}
/** 取 MCP 行的 config（供 transport / toolCallTimeoutMs 读取）。 */
function mcpEntryConfig(entry) {
	const cfg = entry.options.config;
	return cfg !== null && typeof cfg === "object" ? cfg : null;
}
//#endregion
export { serverNameOf as i, mcpEntryConfig as n, mcp_entry_exports as r, isMcpEntry as t };
