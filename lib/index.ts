import Schema from "@deepseek-ai/schemastery";
import { Context } from "@deepseek-ai/cordis";
import { Agent } from "@deepseek-ai/dsh-agent";
import "@deepseek-ai/cordis-plugin-loader";
//#region src/catalog.d.ts
var [CatalogEntry] = [
	14,
	() => [],
	[
		"",
		"",
		""
	]
];
var [CatalogServer] = [
	15,
	() => [CatalogEntry],
	[
		"",
		"",
		"",
		""
	]
];
var [Catalog] = [
	16,
	() => [CatalogServer, Record],
	["", ""]
];
//#endregion
//#region src/mcpcall.d.ts
var [normalizeToolName] = [
	7,
	() => [],
	["", ""]
];
var [normalizeArguments] = [
	8,
	() => [],
	[""]
];
var [McpCallController] = [
	10,
	() => [
		Promise,
		Agent,
		AbortSignal,
		Promise,
		Array
	],
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
		"",
		"",
		""
	]
];
var [msgOf] = [
	11,
	() => [],
	[""]
];
//#endregion
//#region src/shared-types.d.ts
var [McpStatus] = [
	33,
	() => [],
	[]
];
var [McpRow] = [
	34,
	() => [McpStatus, Array],
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
var [McpView] = [
	35,
	() => [McpRow],
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
		"",
		""
	]
];
var [SkillRow] = [
	36,
	() => [],
	[
		"",
		"",
		"",
		"",
		""
	]
];
var [SkillsView] = [
	37,
	() => [SkillRow],
	[
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
//#endregion
//#region src/collect.d.ts
var [DomainCaches] = [
	55,
	() => [
		McpView,
		Promise,
		Map,
		SkillsView,
		Promise,
		Map,
		McpAggregate,
		Map,
		Array,
		Map
	],
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
		"",
		"",
		"",
		"",
		"",
		"",
		""
	]
];
var [McpAggregate] = [
	71,
	() => [Map],
	[
		"",
		"",
		"",
		"",
		"",
		""
	]
];
//#endregion
//#region src/preset.d.ts
var [setRowFlag] = [
	43,
	() => [],
	[
		"",
		"",
		"",
		""
	]
];
var [setSkillFlag] = [
	44,
	() => [],
	["", ""]
];
var [isValidSkillName] = [
	45,
	() => [],
	[""]
];
var [buildSkillMd] = [
	46,
	() => [],
	[
		"",
		"",
		""
	]
];
var [rowDisabledState] = [
	47,
	() => [],
	["", ""]
];
var [syncPresetFiles] = [
	48,
	() => [Context, Promise],
	[
		"",
		"",
		""
	]
];
//#endregion
//#region src/mcp-convert.d.ts
var [McpServerConfig] = [
	74,
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
	75,
	() => [McpServerConfig, Record],
	["", ""]
];
//#endregion
//#region src/project-mcp.d.ts
var [projectServerOwner] = [
	64,
	() => [],
	[""]
];
var [scanWorkspaceMcp] = [
	66,
	() => [McpServers, Promise],
	[
		"",
		"",
		"",
		"",
		""
	]
];
var [projectServerName] = [
	67,
	() => [],
	["", ""]
];
var [installProjectMcp] = [
	68,
	() => [Context],
	["", ""]
];
var [remountWorkspace] = [
	69,
	() => [Context, Promise],
	[
		"",
		"",
		"",
		""
	]
];
//#endregion
//#region src/state.d.ts
var [McpRowState] = [
	25,
	() => [],
	["", ""]
];
var [StateFile] = [
	26,
	() => [
		McpRowState,
		Record,
		Record,
		Record,
		Record,
		Record,
		Record,
		Record,
		Record,
		ApplyMode
	],
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
var [ApplyMode] = [
	27,
	() => [],
	[]
];
var [readState] = [
	29,
	() => [StateFile, Promise],
	["", ""]
];
var [writeState] = [
	30,
	() => [StateFile, Promise],
	[
		"",
		"",
		""
	]
];
//#endregion
//#region src/pending.d.ts
var [PendingMcpEntry] = [
	38,
	() => [],
	[
		"",
		"",
		"",
		""
	]
];
var [pendingMcp] = [
	39,
	() => [PendingMcpEntry, Map],
	["", ""]
];
var [PendingDeps] = [
	40,
	() => [Context, McpCallController],
	[
		"",
		"",
		"",
		""
	]
];
var [applyPendingMcp] = [
	41,
	() => [PendingDeps, Promise],
	[
		"",
		"",
		""
	]
];
var [pendingMcpCount] = [
	42,
	() => [],
	[]
];
//#endregion
//#region src/tool-disable.d.ts
var [loadDisabledTools] = [
	59,
	() => [Promise],
	[""]
];
var [disabledToolsOf] = [
	60,
	() => [ReadonlySet],
	[
		"",
		"",
		""
	]
];
var [isToolDisabled] = [
	61,
	() => [],
	["", ""]
];
var [setToolDisabled] = [
	62,
	() => [Promise],
	[
		"",
		"",
		"",
		"",
		""
	]
];
//#endregion
//#region src/index.d.ts
var [name] = [
	0,
	() => [],
	[]
];
var [inject] = [
	1,
	() => [],
	[]
];
var [Config] = [
	2,
	() => [Record],
	[
		"",
		"",
		"",
		"",
		"",
		""
	]
];
var [Config] = [
	3,
	() => [Config, Schema],
	["", ""]
];
var [RuntimeState] = [
	4,
	() => [McpView, SkillsView],
	["", ""]
];
var [CatalogRuntime] = [
	5,
	() => [Catalog, Map],
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
		"",
		"",
		"",
		"",
		"",
		""
	]
];
var [apply] = [
	6,
	() => [Context, Config],
	[
		"",
		"",
		"",
		""
	]
];
//#endregion
export { CatalogRuntime, Config, DomainCaches, McpRow, McpView, PendingMcpEntry, RuntimeState, SkillRow, SkillsView, apply, applyPendingMcp, buildSkillMd, disabledToolsOf, inject, installProjectMcp, isToolDisabled, isValidSkillName, loadDisabledTools, msgOf, name, normalizeArguments, normalizeToolName, pendingMcp, pendingMcpCount, projectServerName, projectServerOwner, readState, remountWorkspace, rowDisabledState, scanWorkspaceMcp, setRowFlag, setSkillFlag, setToolDisabled, syncPresetFiles, writeState };
