//#region src/mcp-convert.d.ts
var [McpServerConfig] = [
	0,
	() => [Record, Record],
	[
		"",
		"",
		"",
		"",
		"",
		"",
		"",
		"",
		"",
		"",
		""
	]
];
var [McpServers] = [
	1,
	() => [McpServerConfig, Record],
	["", ""]
];
var [McpRowConfig] = [
	2,
	() => [Record],
	[
		"",
		"",
		"",
		""
	]
];
var [ParseResult] = [
	3,
	() => [McpServers],
	[
		"",
		"",
		""
	]
];
var [MCP_CLIENT_NAME] = [
	4,
	() => [],
	[]
];
var [parseMcpServersJson] = [
	5,
	() => [ParseResult],
	["", ""]
];
var [hasEnvRef] = [
	6,
	() => [],
	[""]
];
var [toJsTemplate] = [
	7,
	() => [],
	[""]
];
var [resolveEnvRefs] = [
	8,
	() => [],
	[""]
];
var [resolveServersEnv] = [
	9,
	() => [McpServers, McpServers],
	[
		"",
		"",
		""
	]
];
var [serversToRows] = [
	10,
	() => [McpServers, McpRowConfig],
	[
		"",
		"",
		"",
		""
	]
];
var [serversToPatchYaml] = [
	11,
	() => [McpServers],
	["", ""]
];
//#endregion
export { MCP_CLIENT_NAME, McpRowConfig, McpServerConfig, McpServers, ParseResult, hasEnvRef, parseMcpServersJson, resolveEnvRefs, resolveServersEnv, serversToPatchYaml, serversToRows, toJsTemplate };
