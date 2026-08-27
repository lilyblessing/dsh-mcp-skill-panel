import Schema from "@deepseek-ai/schemastery";
import { scopeOf } from "@deepseek-ai/dsh-scope";
import { homedir } from "node:os";
import { basename, dirname, join, parse } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { access, mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import { watch } from "node:fs";
//#region src/catalog.ts
/** 从完整 tool name 解析 server 段（与 src/index.ts serverOf 一致）。 */
function serverOfMcp$1(name) {
	if (!name.startsWith("mcp__")) return null;
	const rest = name.slice(5);
	const at = rest.indexOf("__");
	if (at < 0) return null;
	return rest.slice(0, at);
}
/**
* 从 tools.schemas(scope) 的结果里，按 `mcp__<serverName>__` 前缀抽取该 server
* 的全部工具条目。name 是完整工具 id；参数取原样 JSON Schema。
*/
function snapshotFromSchemas(schemas, serverName) {
	const prefix = `mcp__${serverName}__`;
	const out = [];
	for (const schema of schemas) {
		const name = String(schema?.name ?? "");
		if (!name.startsWith(prefix)) continue;
		out.push({
			name,
			description: String(schema?.description ?? ""),
			parameters: schema?.parameters ?? {}
		});
	}
	out.sort((a, b) => a.name.localeCompare(b.name));
	return out;
}
/** 按空白 / 下划线 / 连字符切分小写化。 */
function tokenize(text) {
	return String(text).toLowerCase().split(/[\s_-]+/).filter(Boolean);
}
/** 从工具参数 JSON Schema 提取参数名集合（properties 键）。 */
function paramNamesOf(parameters) {
	const names = /* @__PURE__ */ new Set();
	if (parameters && typeof parameters === "object") {
		const props = parameters.properties;
		if (props && typeof props === "object") for (const key of Object.keys(props)) names.add(key.toLowerCase());
	}
	return names;
}
/**
* 关键词全文检索 top-K。
* 打分：工具名命中 3 / 工具名前缀 2 / 描述命中 2 / 描述前缀 1 / 参数名 1。
* 返回按分数降序（同分按 server、name 字典序稳定）的命中数组。
*/
function searchCatalog(catalog, query, limit = 5) {
	const tokens = tokenize(query);
	if (tokens.length === 0) return [];
	const scored = [];
	for (const [server, serverInfo] of Object.entries(catalog)) for (const tool of serverInfo.tools) {
		const nameTokens = tokenize(tool.name);
		const descTokens = tokenize(tool.description);
		const paramTokens = paramNamesOf(tool.parameters);
		let score = 0;
		for (const token of tokens) {
			if (nameTokens.includes(token)) score += 3;
			else if (nameTokens.some((t) => t.startsWith(token))) score += 2;
			if (descTokens.includes(token)) score += 2;
			else if (descTokens.some((t) => t.startsWith(token))) score += 1;
			if (paramTokens.has(token)) score += 1;
		}
		if (score > 0) scored.push({
			hit: {
				server,
				tool
			},
			score
		});
	}
	scored.sort((a, b) => b.score - a.score || a.hit.server.localeCompare(b.hit.server) || a.hit.tool.name.localeCompare(b.hit.tool.name));
	const k = Math.max(1, Math.floor(Number(limit) || 1));
	return scored.slice(0, k).map((s) => s.hit);
}
/**
* 列出某 server 的全部工具（精简：name + description）。
* 返回 undefined 表示该 server 不在 catalog 中。
*/
function listServer(catalog, server) {
	const serverInfo = catalog[server];
	if (!serverInfo) return void 0;
	return serverInfo.tools.map((tool) => ({
		name: tool.name,
		description: tool.description
	}));
}
/** catalog 文件路径：<dir>/catalog.json。 */
function catalogFileFor(dir) {
	return `${dir.replace(/[\\/]$/, "")}/catalog.json`;
}
/** 从目录加载 catalog；文件不存在 / 解析失败时返回空 catalog。 */
async function loadCatalog(dir) {
	try {
		const text = await import("node:fs/promises").then((fsp) => fsp.readFile(catalogFileFor(dir), "utf8"));
		const parsed = JSON.parse(text);
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
		return {};
	} catch {
		return {};
	}
}
/** 原子写回 catalog（tmp + rename，0600）。调用方负责 mkdir。 */
async function saveCatalog(dir, catalog) {
	const fsp = await import("node:fs/promises");
	await fsp.mkdir(dir, { recursive: true });
	const file = catalogFileFor(dir);
	const json = JSON.stringify(catalog, null, 2);
	await fsp.writeFile(`${file}.tmp`, json, {
		encoding: "utf8",
		mode: 384
	});
	await fsp.rename(`${file}.tmp`, file);
}
//#endregion
//#region src/filter.ts
const MCP_TOOL_PREFIX = "mcp__";
/** 从完整 tool name 解析 server 段（与 catalog.serverOfMcp 一致，保持本模块零依赖）。 */
function serverOfMcp(name) {
	if (!name.startsWith(MCP_TOOL_PREFIX)) return null;
	const rest = name.slice(5);
	const at = rest.indexOf("__");
	if (at < 0) return null;
	return rest.slice(0, at);
}
function installMcpVisibilityFilter(ctx, buildVisibility) {
	return ctx.effect(() => {
		return ctx.root.on("system-prompt/assemble", (assembly, _context, next) => {
			if (assembly && Array.isArray(assembly.tools)) {
				const visibility = buildVisibility();
				assembly.tools = assembly.tools.filter((tool) => {
					const name = String(tool.name ?? "");
					if (!name.startsWith(MCP_TOOL_PREFIX)) return true;
					const server = serverOfMcp(name);
					return server === null ? true : visibility.get(server) ?? true;
				});
			}
			return next();
		});
	}, "mcp-skill-panel: mcp visibility filter");
}
//#endregion
//#region src/state.ts
/**
* state.json 持久化（~/.dsh/dsh-mcp-skill-panel/state.json）。
*
* 存放 MCP 行启停意图（mcp 段）、AI 临时启用标记（ai 段）与面板配置（config 段）。
* 内存态 + 写队列合并（P1-4）：启动加载一次，高频写（mcp_call 连击的 ai 标记）
* 串行合并落盘，避免每次读+写各一次文件 IO。
*/
const LEGACY_STATE_DIR = join(homedir(), ".dsh", "dsh-runtime-inventory");
const STATE_DIR = join(homedir(), ".dsh", "dsh-mcp-skill-panel");
const STATE_FILE = join(STATE_DIR, "state.json");
/** 当前生效时机（缺省 immediate）。 */
function stateApplyMode(state) {
	return state.config?.applyMode === "next-session" ? "next-session" : "immediate";
}
let stateCache = null;
let stateDirty = false;
let stateWriteChain = Promise.resolve();
async function readState() {
	if (stateCache) return stateCache;
	let parsed;
	try {
		parsed = JSON.parse(await readFile(STATE_FILE, "utf8"));
	} catch {
		try {
			const legacy = join(LEGACY_STATE_DIR, "state.json");
			const text = await readFile(legacy, "utf8");
			await mkdir(STATE_DIR, { recursive: true });
			await rename(legacy, STATE_FILE);
			parsed = JSON.parse(text);
		} catch {
			parsed = {};
		}
	}
	stateCache = parsed;
	return parsed;
}
async function writeState(state) {
	stateCache = state;
	stateDirty = true;
	stateWriteChain = stateWriteChain.catch(() => {}).then(async () => {
		if (!stateDirty) return;
		stateDirty = false;
		const current = stateCache ?? state;
		await mkdir(STATE_DIR, { recursive: true });
		await writeFile(`${STATE_FILE}.tmp`, JSON.stringify(current, null, 2), "utf8");
		await rename(`${STATE_FILE}.tmp`, STATE_FILE);
	});
	await stateWriteChain;
}
/** AI-owner 标记读写：state.json 的 ai 段（entryId → {at}）。 */
async function setStateAiOwner(entryId, at) {
	const state = await readState();
	state.ai ??= {};
	state.ai[entryId] = { at };
	await writeState(state);
}
async function clearStateAiOwner(entryId) {
	const state = await readState();
	if (!state.ai || !(entryId in state.ai)) return;
	delete state.ai[entryId];
	await writeState(state);
}
//#endregion
//#region src/mcp-convert.ts
/** dsh-mcp-client 的 serverName 约束（存活实例全局唯一 + 命名长度）。 */
const SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;
/** `${VAR}` 环境变量占位（VAR 为 JS 标识符）。 */
const ENV_REF = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;
/** dsh-mcp-client 的插件包名。 */
const MCP_CLIENT_NAME = "@deepseek-ai/dsh-mcp-client";
function isPlainObject(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
function str(value) {
	return typeof value === "string" ? value : void 0;
}
/**
* 字符串数组：number/boolean 项强制转字符串（同行 harness 常见，如 args: [3000]），
* 其余非标量项跳过并记警告——不再静默清空整个数组。
*/
function strArray(value, warnings, label) {
	if (!Array.isArray(value)) return void 0;
	const out = [];
	for (const item of value) if (typeof item === "string") out.push(item);
	else if (typeof item === "number" || typeof item === "boolean") {
		out.push(String(item));
		warnings.push(`${label}: ${typeof item} 项已转为字符串 "${String(item)}"`);
	} else warnings.push(`${label}: 忽略非标量项（${Array.isArray(item) ? "array" : typeof item}）`);
	return out;
}
/**
* 字符串字典：number/boolean 值强制转字符串（如 env: { PORT: 3000 }），
* 其余非标量值跳过并记警告——不再静默清空整个字段。
*/
function strDict(value, warnings, label) {
	if (!isPlainObject(value)) return void 0;
	const out = {};
	for (const [key, item] of Object.entries(value)) if (typeof item === "string") out[key] = item;
	else if (typeof item === "number" || typeof item === "boolean") {
		out[key] = String(item);
		warnings.push(`${label}.${key}: ${typeof item} 值已转为字符串 "${String(item)}"`);
	} else warnings.push(`${label}.${key}: 忽略非标量值（${Array.isArray(item) ? "array" : typeof item}）`);
	return out;
}
/** 解析单个 server 配置；失败返回错误文案。 */
function parseServer(name, value, warnings) {
	if (!SERVER_NAME_PATTERN.test(name)) return { error: `server "${name}": serverName 需匹配 [A-Za-z0-9_-]{1,32}` };
	if (!isPlainObject(value)) return { error: `server "${name}": 配置需为对象` };
	const cfg = value;
	const explicit = String(cfg.type ?? cfg.transport ?? "").toLowerCase();
	const command = str(cfg.command);
	const url = str(cfg.url);
	let transport;
	if (explicit === "stdio" || explicit === "command") transport = "stdio";
	else if (explicit === "streamable-http" || explicit === "http" || explicit === "sse") transport = "streamable-http";
	else if (command !== void 0) transport = "stdio";
	else if (url !== void 0) transport = "streamable-http";
	if (transport === void 0) return { error: `server "${name}": 无法推断传输方式（需要 command=stdio 或 url=http）` };
	const toolCallTimeoutMs = typeof cfg.toolCallTimeoutMs === "number" && Number.isFinite(cfg.toolCallTimeoutMs) ? cfg.toolCallTimeoutMs : void 0;
	if (transport === "stdio") {
		if (command === void 0) return { error: `server "${name}": stdio 需要 command` };
		const label = `server "${name}"`;
		return {
			serverName: name,
			transport,
			command,
			args: strArray(cfg.args, warnings, `${label}.args`) ?? [],
			env: strDict(cfg.env, warnings, `${label}.env`) ?? {},
			cwd: str(cfg.cwd),
			toolCallTimeoutMs
		};
	}
	if (url === void 0) return { error: `server "${name}": http 需要 url` };
	return {
		serverName: name,
		transport,
		url,
		headers: strDict(cfg.headers, warnings, `server "${name}".headers`) ?? {},
		toolCallTimeoutMs
	};
}
/**
* 解析 mcpServers JSON 文本。
* 同时接受 `{ "mcpServers": {...} }` 与直接 `{ <name>: {...} }` 两种形态。
*/
function parseMcpServersJson(text) {
	let raw;
	try {
		raw = JSON.parse(text);
	} catch (error) {
		return {
			servers: {},
			errors: [`JSON 解析失败: ${error instanceof Error ? error.message : String(error)}`],
			warnings: []
		};
	}
	if (!isPlainObject(raw)) return {
		servers: {},
		errors: ["期望 JSON 对象（mcpServers 映射）"],
		warnings: []
	};
	const map = isPlainObject(raw.mcpServers) ? raw.mcpServers : raw;
	const servers = {};
	const errors = [];
	const warnings = [];
	for (const [name, value] of Object.entries(map)) {
		const parsed = parseServer(name, value, warnings);
		if ("error" in parsed) {
			errors.push(parsed.error);
			continue;
		}
		servers[name] = parsed;
	}
	return {
		servers,
		errors,
		warnings
	};
}
/** 字符串是否含 `${VAR}` 环境变量占位。 */
function hasEnvRef(value) {
	ENV_REF.lastIndex = 0;
	return ENV_REF.test(value);
}
/** 把含 `${VAR}` 的字符串转成 JS 模板字面量文本（`!!js` 表达式体）。 */
function toJsTemplate(value) {
	return `\`${value.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/'/g, "\\'").replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, "${process.env.$1}")}\``;
}
/** 运行时解析 `${VAR}` → process.env 值；缺失的保留占位符原样（远端报可见错误）。 */
function resolveEnvRefs(value) {
	return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name) => {
		const env = process.env[name];
		return env !== void 0 ? env : `\${${name}}`;
	});
}
/** 递归解析对象内所有字符串值的 ${VAR}（挂载时调用）。 */
function resolveServersEnv(servers) {
	const out = {};
	for (const [name, server] of Object.entries(servers)) {
		const copy = { ...server };
		if (copy.command !== void 0) copy.command = resolveEnvRefs(copy.command);
		if (copy.cwd !== void 0) copy.cwd = resolveEnvRefs(copy.cwd);
		if (copy.url !== void 0) copy.url = resolveEnvRefs(copy.url);
		if (copy.env) {
			const env = {};
			for (const [key, item] of Object.entries(copy.env)) env[key] = resolveEnvRefs(item);
			copy.env = env;
		}
		if (copy.headers) {
			const headers = {};
			for (const [key, item] of Object.entries(copy.headers)) headers[key] = resolveEnvRefs(item);
			copy.headers = headers;
		}
		if (copy.args) copy.args = copy.args.map((item) => resolveEnvRefs(item));
		out[name] = copy;
	}
	return out;
}
/** 把 McpServers 转成 dsh-mcp-client 插件行（loader entry 形状）。 */
function serversToRows(servers, idPrefix = "mcp") {
	const rows = [];
	for (const server of Object.values(servers)) {
		const config = {
			transport: server.transport,
			serverName: server.serverName
		};
		if (server.transport === "stdio") {
			config.command = server.command;
			if (server.args && server.args.length > 0) config.args = server.args;
			if (server.env && Object.keys(server.env).length > 0) config.env = server.env;
			if (server.cwd) config.cwd = server.cwd;
		} else {
			config.url = server.url;
			if (server.headers && Object.keys(server.headers).length > 0) config.headers = server.headers;
		}
		if (server.toolCallTimeoutMs !== void 0) config.toolCallTimeoutMs = server.toolCallTimeoutMs;
		rows.push({
			id: `${idPrefix}-${server.serverName}`,
			name: MCP_CLIENT_NAME,
			config
		});
	}
	return rows;
}
/** JSON 双引号字符串是合法 YAML 标量（内嵌转义由 JSON.stringify 处理）。 */
function yamlString(value) {
	return JSON.stringify(value);
}
/** 单个字符串值 → YAML 标量：含 ${VAR} → `!!js` 模板表达式；否则 JSON 字符串。 */
function yamlScalar(value) {
	if (!hasEnvRef(value)) return yamlString(value);
	return `!!js '${toJsTemplate(value).replace(/'/g, "''")}'`;
}
/** 迷你 YAML 序列化：对象/数组/字符串/数字/布尔（配置结构简单，无需完整 YAML 库）。 */
function emitYaml(obj, indent) {
	const out = [];
	for (const [key, value] of Object.entries(obj)) {
		if (value === void 0) continue;
		if (isPlainObject(value)) {
			out.push(`${indent}${key}:`);
			out.push(...emitYaml(value, `${indent}  `));
		} else if (Array.isArray(value)) {
			out.push(`${indent}${key}:`);
			for (const item of value) out.push(`${indent}  - ${yamlScalar(String(item))}`);
		} else if (typeof value === "string") out.push(`${indent}${key}: ${yamlScalar(value)}`);
		else out.push(`${indent}${key}: ${String(value)}`);
	}
	return out;
}
/** 生成全局 profile 可追加的 `- insert:` patch 块（dsh-mcp-client 行，!!js 环境插值）。 */
function serversToPatchYaml(servers) {
	const lines = [];
	for (const row of serversToRows(servers)) {
		lines.push("- insert:");
		lines.push(`    - id: ${row.id}`);
		lines.push(`      name: '${row.name.replace(/'/g, "''")}'`);
		lines.push("      config:");
		lines.push(...emitYaml(row.config, "        "));
	}
	return lines.join("\n") + "\n";
}
//#endregion
//#region src/mcp-entry.ts
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
//#region src/util.ts
/** 通用小工具（index / collect / routes 共用）。 */
/** 把未知错误投影为可读字符串（日志与 HTTP 错误响应）。 */
function messageOf(error) {
	return error instanceof Error ? error.message : String(error);
}
//#endregion
//#region src/project-mcp.ts
/** 工作空间根下项目 MCP 的固定目录。 */
const MCPS_DIR = ".dsh/mcps";
/** watcher 去抖窗口（合并文件批量写）。 */
const RESCAN_DEBOUNCE_MS = 200;
/** serverName → 所属工作空间根（仅本项目 MCP 行；全局行不在表内）。 */
const projectOwners = /* @__PURE__ */ new Map();
/** 最近一次会话进入的工作空间（随会话切换更新；面板添加项目 MCP 的目标工作区）。 */
let activeWorkspace = null;
/** 查询某 serverName 是否为本项目 MCP 行及其所属工作空间（collect/面板集成用）。 */
function projectServerOwner(serverName) {
	return projectOwners.get(serverName);
}
/** 最近一次会话进入的工作空间（add project 目标 + 面板展示当前工作区）。 */
function getActiveWorkspace() {
	return activeWorkspace;
}
/** 路径比较：Windows 下忽略大小写（同一路径大小写不同视为同一工作区）。 */
function strEquals$1(a, b, mode) {
	if (typeof b !== "string") return false;
	return mode === "ignorecase" ? a.toLowerCase() === b.toLowerCase() : a === b;
}
const workspaces = /* @__PURE__ */ new Map();
async function isDirectory(path) {
	try {
		return (await stat(path)).isDirectory();
	} catch {
		return false;
	}
}
async function fileExists(path) {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}
/** 递归收集 `dir` 下所有子目录（含 dir 本身）的 mcp.json：根目录文件在前、子目录按路径序。 */
async function collectMcpJsonFiles(dir, out) {
	if (await fileExists(join(dir, "mcp.json"))) out.push(join(dir, "mcp.json"));
	let names = [];
	try {
		names = (await readdir(dir, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
	} catch {
		return;
	}
	for (const name of names) await collectMcpJsonFiles(join(dir, name), out);
}
/**
* 扫描工作空间的项目 MCP 配置：根目录 mcp.json 优先，子目录覆盖（后写覆盖先写）。
* 目录不存在 → 空。解析错误经 warn 回调上报、跳过该文件。
* 纯文件系统逻辑（不依赖 ctx），可被 selftest 用临时目录覆盖。
*/
async function scanWorkspaceMcp(root, warn) {
	const mcpsDir = join(root, MCPS_DIR);
	if (!await isDirectory(mcpsDir)) return {};
	const files = [];
	await collectMcpJsonFiles(mcpsDir, files);
	const servers = {};
	for (const file of files) {
		let text;
		try {
			text = await readFile(file, "utf8");
		} catch (error) {
			warn?.(`读取项目 MCP 配置失败 ${file}: ${messageOf(error)}`);
			continue;
		}
		const parsed = parseMcpServersJson(text);
		for (const error of parsed.errors) warn?.(`${file}: ${error}`);
		for (const warning of parsed.warnings) warn?.(`${file}: ${warning}`);
		for (const [name, server] of Object.entries(parsed.servers)) servers[name] = server;
	}
	return servers;
}
/** 工作空间根的稳定 id 前缀（djb2 hash，避免跨工作空间 entry id 冲突）。 */
function projectIdPrefix(root) {
	let hash = 5381;
	for (let i = 0; i < root.length; i += 1) hash = (hash << 5) + hash + root.charCodeAt(i) >>> 0;
	return `projmcp-${hash.toString(16).padStart(8, "0")}`;
}
/**
* 项目 MCP 的 serverName 重命名：追加<路径哈希 8 位 hex>后缀。
*
* 背景（2026-08-27 用户需求）：不同工作区可能配置「同 serverName 但路径参数不同」
* 的项目 MCP（如各自 codegraph 指向不同仓库）。dsh-mcp-client 的 serverName 全进程
* 唯一，同名会互相挤占 → 后挂载的工作区会拿到前者的路径配置、调用必然失败。
* 给 serverName 追加确定性路径后缀后，不同工作区 = 不同 serverName = 各自独立实例。
*
* 形态：`<原名>-<8位hex>`（如 codegraph-e5f6a7b8，原名领先更可读）。
* 约束：serverName 限 `[A-Za-z0-9_-]{1,32}`,后缀 8 位 hex + 分隔符 `-`;
* 原名超过 23 字符时截断尾部（保留头部可读性），总长收敛到 ≤32。
*/
function projectServerName(root, name) {
	let hash = 5381;
	for (let i = 0; i < root.length; i += 1) hash = (hash << 5) + hash + root.charCodeAt(i) >>> 0;
	const suffix = `${hash.toString(16).padStart(8, "0")}`;
	return `${name.slice(0, 23)}-${suffix}`;
}
/** 对比配置变化（loader.update 的 diff 需要；JSON 序列化足够判等）。 */
function configChanged(a, b) {
	return JSON.stringify(a) !== JSON.stringify(b);
}
/**
* 项目 MCP 行构建：原始 mcpServers 配置 → dsh-mcp-client 行，
* 并把 serverName 重命名为带路径哈希前缀（不同工作区同名 server 拆成独立实例）。
* entry id 仍由 projectIdPrefix（同样含路径 hash）保证跨工作区唯一，无需重复缀加。
*/
function buildRows(root, servers) {
	const rows = serversToRows(resolveServersEnv(servers), projectIdPrefix(root));
	for (const row of rows) {
		const raw = String(row.config.serverName ?? "");
		row.config.serverName = projectServerName(root, raw);
	}
	return rows;
}
/** 按行集合同步该工作空间已挂载的条目：删多出的、更新变化的、新建缺的。
* 应用 state.json 的 projectMcp 禁用意图（面板开关 → 重启/热更新后保持）。 */
async function syncRows(ctx, state, rows) {
	const wanted = new Map(rows.map((row) => [String(row.config.serverName), row]));
	const stateFile = await readState().catch(() => void 0);
	const intentOf = (serverName) => Boolean(stateFile?.projectMcp?.[state.root]?.[serverName]);
	for (const [serverName, entryId] of [...state.entries]) {
		if (wanted.has(serverName)) continue;
		try {
			await ctx.loader.remove(entryId);
		} catch (error) {
			ctx.logger.warn?.(`mcp-skill-panel: 卸载项目 MCP "${serverName}" 失败: ${messageOf(error)}`);
		}
		state.entries.delete(serverName);
		projectOwners.delete(serverName);
	}
	for (const [serverName, row] of wanted) {
		const existingId = state.entries.get(serverName);
		if (existingId) {
			try {
				const entry = ctx.loader.resolve(existingId);
				const wantDisabled = intentOf(serverName);
				if (entry && (configChanged(entry.options.config, row.config) || Boolean(entry.disabled) !== wantDisabled)) await ctx.loader.update(existingId, {
					...row,
					disabled: wantDisabled
				});
			} catch (error) {
				ctx.logger.warn?.(`mcp-skill-panel: 更新项目 MCP "${serverName}" 失败: ${messageOf(error)}`);
			}
			continue;
		}
		try {
			await ctx.loader.create({
				...row,
				disabled: intentOf(serverName)
			});
			state.entries.set(serverName, row.id);
			projectOwners.set(serverName, state.root);
		} catch (error) {
			ctx.logger.warn?.(`mcp-skill-panel: 挂载项目 MCP "${serverName}" 失败: ${messageOf(error)}`);
		}
	}
}
/** 卸载某工作空间的全部项目 MCP 条目并停 watcher。 */
async function disposeWorkspace(ctx, root) {
	const state = workspaces.get(root);
	if (!state) return;
	workspaces.delete(root);
	if (state.refreshTimer) clearTimeout(state.refreshTimer);
	state.watcher?.close();
	for (const [serverName, entryId] of [...state.entries]) {
		try {
			await ctx.loader.remove(entryId);
		} catch {}
		projectOwners.delete(serverName);
	}
	state.entries.clear();
}
/** 会话进入工作空间时：无 .dsh/mcps → 卸载；有 → 扫描并按需挂载。
* 记录「最近进入的工作空间」（活动工作区，随会话切换更新）。 */
async function ensureWorkspace(ctx, root) {
	activeWorkspace = root;
	if (!await isDirectory(join(root, MCPS_DIR))) {
		await disposeWorkspace(ctx, root);
		return;
	}
	const rows = buildRows(root, await scanWorkspaceMcp(root, (msg) => ctx.logger.warn?.(`mcp-skill-panel: ${msg}`)));
	let state = workspaces.get(root);
	if (!state) {
		state = {
			root,
			entries: /* @__PURE__ */ new Map(),
			watcher: void 0,
			refreshTimer: void 0,
			refreshing: false
		};
		workspaces.set(root, state);
	}
	await syncRows(ctx, state, rows);
	if (!state.watcher) try {
		state.watcher = watch(join(root, MCPS_DIR), { recursive: true }, () => {
			if (state.refreshTimer) clearTimeout(state.refreshTimer);
			state.refreshTimer = setTimeout(() => {
				state.refreshTimer = void 0;
				refresh(ctx, root, state).catch((error) => {
					ctx.logger.warn?.(`mcp-skill-panel: 项目 MCP 热更新失败（${root}）: ${messageOf(error)}`);
				});
			}, RESCAN_DEBOUNCE_MS);
		});
	} catch (error) {
		ctx.logger.warn?.(`mcp-skill-panel: 无法监视 ${join(root, MCPS_DIR)}: ${messageOf(error)}`);
	}
}
/** watcher 触发的重扫：配置/目录变化后按新集合同步（热更新）。 */
async function refresh(ctx, root, state) {
	if (state.refreshing) return;
	state.refreshing = true;
	try {
		if (!await isDirectory(join(root, MCPS_DIR))) {
			await disposeWorkspace(ctx, root);
			return;
		}
		await syncRows(ctx, state, buildRows(root, await scanWorkspaceMcp(root, (msg) => ctx.logger.warn?.(`mcp-skill-panel: ${msg}`))));
	} finally {
		state.refreshing = false;
	}
}
/**
* 常开过滤：项目 MCP 工具仅在本工作空间会话的装配结果中可见。
* 非项目 MCP 工具不在此处理（交给 autoManage 的过滤器）。
*/
function installProjectMcpVisibility(ctx) {
	return ctx.effect(() => {
		return ctx.root.on("system-prompt/assemble", (assembly, context, next) => {
			if (assembly && Array.isArray(assembly.tools)) {
				if (projectOwners.size === 0) return next();
				const cwd = context?.agent?.session?.header?.cwd;
				const workspace = typeof cwd === "string" ? cwd : null;
				assembly.tools = assembly.tools.filter((tool) => {
					const name = String(tool?.name ?? "");
					if (!name.startsWith("mcp__")) return true;
					const server = serverOfMcp$1(name);
					if (server === null) return true;
					const owner = projectOwners.get(server);
					if (owner === void 0) return true;
					return workspace !== null && strEquals$1(workspace, owner, "ignorecase");
				});
			}
			return next();
		});
	}, "mcp-skill-panel: project mcp visibility");
}
/** 安装项目 MCP 运行时：会话挂载 + 常开过滤。返回整体释放函数。 */
function installProjectMcp(ctx) {
	const disposers = [];
	disposers.push(ctx.effect(() => {
		return ctx.root.on("agent/session-start", (payload) => {
			const cwd = payload?.agent?.session?.header?.cwd;
			if (typeof cwd !== "string" || cwd.length === 0) return;
			ensureWorkspace(ctx, cwd).catch((error) => {
				ctx.logger.warn?.(`mcp-skill-panel: 项目 MCP 挂载失败（${cwd}）: ${messageOf(error)}`);
			});
		});
	}, "mcp-skill-panel: project mcp session hook"));
	disposers.push(installProjectMcpVisibility(ctx));
	return () => {
		for (const dispose of disposers) dispose();
	};
}
/** 面板添加/外部修改项目 MCP 文件后，强制重扫该工作空间并同步挂载（幂等）。 */
async function remountWorkspace(ctx, root) {
	await ensureWorkspace(ctx, root);
}
/**
* HMR/热重载后从 state.json 反向重建 projectOwners 映射（幂等，已有数据时跳过）。
*
* 背景：projectOwners 是模块级内存表，插件 HMR 重载即清空，而 loader 根树上的
* projmcp-* 行仍然存在 → 期间项目工具短暂按全局展示、项目级禁用作用域错判。
* state.projectMcp（工作空间 → serverName → 禁用意图）保存了 owner 关系，
* 以 loader 存活行交叉验证后重建；watcher/entries 由下次 session-start 的
* ensureWorkspace 完整恢复。
*/
async function rebuildOwnersFromState(ctx) {
	if (projectOwners.size > 0) return;
	const map = (await readState().catch(() => void 0))?.projectMcp;
	if (!map) return;
	const live = /* @__PURE__ */ new Set();
	for (const entry of ctx.loader.entries()) if (isMcpEntry(entry)) live.add(serverNameOf(entry));
	for (const [workspace, servers] of Object.entries(map)) {
		if (!servers || typeof servers !== "object") continue;
		for (const serverName of Object.keys(servers)) if (live.has(serverName)) projectOwners.set(serverName, workspace);
	}
}
//#endregion
//#region src/tool-disable.ts
/** 全局禁用：serverName → 禁用的工具全名集合（mcp__<server>__<tool>）。 */
const disabledTools = /* @__PURE__ */ new Map();
/** 项目禁用：工作空间 → serverName → 禁用的工具全名集合。 */
const projectDisabledTools = /* @__PURE__ */ new Map();
/** 空集合兜底（避免每次查询分配新 Set）。 */
const EMPTY_SET = /* @__PURE__ */ new Set();
/** 启动/热更新时从 state.json 加载禁用集合（全局 + 项目两张表）。 */
async function loadDisabledTools() {
	disabledTools.clear();
	projectDisabledTools.clear();
	const state = await readState().catch(() => void 0);
	const globalMap = state?.toolDisabled;
	if (globalMap) {
		for (const [server, names] of Object.entries(globalMap)) if (Array.isArray(names)) disabledTools.set(server, new Set(names.filter((n) => typeof n === "string")));
	}
	const projectMap = state?.projectToolDisabled;
	if (projectMap) for (const [workspace, servers] of Object.entries(projectMap)) {
		if (!servers || typeof servers !== "object") continue;
		const perServer = /* @__PURE__ */ new Map();
		for (const [server, names] of Object.entries(servers)) if (Array.isArray(names)) perServer.set(server, new Set(names.filter((n) => typeof n === "string")));
		if (perServer.size > 0) projectDisabledTools.set(workspace, perServer);
	}
}
/** 某 server 的禁用工具集合（面板展示用；workspace=该 server 所属工作区，与 tableKeys 同源）。 */
function disabledToolsOf(serverName, workspace) {
	const owner = projectServerOwner(serverName);
	if (owner !== void 0) {
		const target = workspace ?? owner;
		return projectDisabledTools.get(target)?.get(serverName) ?? EMPTY_SET;
	}
	return disabledTools.get(serverName) ?? EMPTY_SET;
}
/**
* 工具全名是否被禁用（按当前会话工作区判定作用域）：
* - 全局表无条件生效；
* - 项目表只在「会话工作区 === 项目所属工作区」时生效（A 区禁用不影响 B 区）。
* workspace 缺省时仅全局表生效（无会话上下文的冷路径）。
*/
function isToolDisabled(fullName, workspace) {
	const server = serverOfMcp$1(fullName);
	if (server === null) return false;
	const owner = projectServerOwner(server);
	if (owner !== void 0) {
		if (workspace === void 0) return false;
		if (!strEquals(workspace, owner)) return false;
		return projectDisabledTools.get(owner)?.get(server)?.has(fullName) ?? false;
	}
	return disabledTools.get(server)?.has(fullName) ?? false;
}
/**
* 切换某工具禁用状态（面板）：
* - 项目 MCP server（projectServerOwner 有值）→ 写入所属工作区的项目表（仅该区生效）；
* - 全局 MCP server → 写入全局表。
* 同时更新内存 Map + 持久化到 state.json（原子合并写盘）。
* `persist: false`（selftest）只改内存，不动磁盘。
*/
async function setToolDisabled(serverName, fullName, disabled, persist = true) {
	const owner = projectServerOwner(serverName);
	if (owner !== void 0) {
		let perServer = projectDisabledTools.get(owner);
		if (disabled && !perServer) {
			perServer = /* @__PURE__ */ new Map();
			projectDisabledTools.set(owner, perServer);
		}
		if (perServer) {
			toggleInSet(perServer, serverName, fullName, disabled);
			if (perServer.size === 0) projectDisabledTools.delete(owner);
		}
		if (persist) {
			const state = await readState();
			state.projectToolDisabled ??= {};
			const serverMap = state.projectToolDisabled[owner] ??= {};
			toggleInList(serverMap, serverName, fullName, disabled);
			if (Object.keys(serverMap).length === 0) delete state.projectToolDisabled[owner];
			await writeState(state);
		}
	} else {
		toggleInSet(disabledTools, serverName, fullName, disabled);
		if (persist) {
			const state = await readState();
			state.toolDisabled ??= {};
			toggleInList(state.toolDisabled, serverName, fullName, disabled);
			await writeState(state);
		}
	}
}
/** 内存 Set 表的开关（serverName → Set<fullName>）。 */
function toggleInSet(table, serverName, fullName, disabled) {
	let set = table.get(serverName);
	if (disabled) {
		if (!set) {
			set = /* @__PURE__ */ new Set();
			table.set(serverName, set);
		}
		set.add(fullName);
	} else if (set) {
		set.delete(fullName);
		if (set.size === 0) table.delete(serverName);
	}
}
/** state.json 数组表的开关（serverName → string[]）。 */
function toggleInList(table, serverName, fullName, disabled) {
	const list = table[serverName] ??= [];
	const at = list.indexOf(fullName);
	if (disabled && at < 0) list.push(fullName);
	if (!disabled && at >= 0) list.splice(at, 1);
	if (list.length === 0) delete table[serverName];
}
/** Windows 路径比较忽略大小写（c:\ 与 C:\ 视为同一工作区）。 */
function strEquals(a, b) {
	return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}
/**
* 常开装配过滤：把用户禁用的 MCP 工具从模型工具目录剔除。
* 项目表按当前会话工作区匹配（context.agent.session.header.cwd），
* 会话工作区不等于项目所属区时该项目工具本就不会挂载可见（由 project-mcp 过滤），
* 这里对全局表无条件生效、对项目表按 owner===cwd 生效。
*/
function installToolDisableFilter(ctx) {
	return ctx.effect(() => {
		return ctx.root.on("system-prompt/assemble", (assembly, context, next) => {
			if (assembly && Array.isArray(assembly.tools)) {
				if (disabledTools.size === 0 && projectDisabledTools.size === 0) return next();
				const cwd = context?.agent?.session?.header?.cwd;
				const workspace = typeof cwd === "string" ? cwd : void 0;
				assembly.tools = assembly.tools.filter((tool) => {
					return !isToolDisabled(String(tool?.name ?? ""), workspace);
				});
			}
			return next();
		});
	}, "mcp-skill-panel: tool disable filter");
}
//#endregion
//#region src/mcpcall.ts
/**
* MCP 中间层控制层（P2）：保活启用 → 等注册 → 插件内执行 → 空闲回收。
*
* 模型面恒定 2 个工具：
*   mcp_search —— 检索私有 catalog（能力摘要 / 列表 / top-K 全文检索）
*   mcp_call   —— 保活启用指定 server → 执行工具 → 返回文本结果
*
* 控制层职责：
* - ensureEnabled：从 loader entries 反查 entry，disabled 时 update 开启并记录
*   AI owner（写 state.json 的 ai 段）。
* - waitRegistered：轮询 ctx.tools.get + tools/change 事件加速。
* - call：enable → waitRegistered → ctx.tools.execute。失败时若本次 AI 启用且
*   无并发则恢复 disabled 并清 owner。
* - 引用计数（Map<serverName, number>）+ 空闲回收器（ctx.interval 每 10s 扫描）。
*/
/** 空闲回收器扫描周期（ms）。 */
const REAPER_INTERVAL_MS = 1e4;
/** waitRegistered 轮询间隔（ms）。 */
const REGISTER_POLL_MS = 50;
/**
* 归一化 mcp_call 的 tool 参数（2026-08-22 修补）：模型可能把 mcp_search 返回的
* 注册全名（mcp__<server>__<tool>）直接填入 tool，无条件拼接会生成双重前缀。
* 规则：以 mcp__ 开头视为注册全名形态 → 循环剥离本 server 前缀（兼容嵌套重复）；
* 剥完仍以 mcp__ 开头 → 传的是其他 server 的注册全名或格式异常 → 快速失败
* （避免在 waitRegistered 白等满 toolCallTimeoutMs，默认 60s、mimo-image 300s）。
* 注：远端工具裸名恰好以 mcp__ 开头属生态外的病态命名，会被误判，可接受。
*/
function normalizeToolName(serverName, toolName) {
	const prefix = `mcp__${serverName}__`;
	let name = toolName;
	if (name.startsWith("mcp__")) {
		while (name.startsWith(prefix)) name = name.slice(prefix.length);
		if (name.startsWith("mcp__")) throw new Error(`mcp_call: tool 参数疑似其他 MCP server 的注册全名（${JSON.stringify(toolName)}，server="${serverName}"）；请传该 server 上的裸名（如 understand_image，不带 mcp__ 前缀）`);
	}
	return name;
}
/**
* 归一化 mcp_call 的 arguments 参数（2026-08-24 修补）：type:'json' 参数的编译产物
* 不带 type 标注，模型直连 Tool call 时倾向把参数字典填成 JSON 字符串（实测 flash 与
* mimo 两系均会出现）。这里循环安全解析为对象后再透传：
* - 值以 { / [ 开头 → 直接按容器 JSON 解析；
* - 值以 " 开头（引号包裹层）→ 解包后若内层仍是容器形态才继续剥，防止误改合法标量入参；
* - 解析失败或非字典形态 → 保留原值交由远端给出可读错误。
*/
function normalizeArguments(raw) {
	let value = raw ?? {};
	let depth = 0;
	while (typeof value === "string" && depth < 4) {
		const trimmed = value.trim();
		if (trimmed.length === 0) return {};
		const head = trimmed.charCodeAt(0);
		const isContainerJson = head === 123 || head === 91;
		const isQuotedJson = head === 34;
		if (!isContainerJson && !isQuotedJson) break;
		let parsed;
		try {
			parsed = JSON.parse(trimmed);
		} catch {
			break;
		}
		if (parsed !== null && typeof parsed === "object") return parsed;
		const inner = typeof parsed === "string" ? parsed.trim() : "";
		const innerLooksContainer = inner.startsWith("{") || inner.startsWith("[");
		if (!isQuotedJson || !innerLooksContainer) break;
		value = parsed;
		depth++;
	}
	return value;
}
function msgOf(error) {
	if (error instanceof Error) return error.message;
	if (typeof error === "string") return error;
	if (error && typeof error === "object") try {
		const text = JSON.stringify(error);
		if (typeof text === "string" && text.length > 0) return text;
	} catch {}
	return String(error);
}
/** 从 execute 结果的 content 块抽取文本（防御式）。 */
function contentText(content) {
	if (!Array.isArray(content)) return "";
	const parts = [];
	for (const block of content) if (block && typeof block === "object") {
		const b = block;
		if (b.type === "text" && typeof b.text === "string") parts.push(b.text);
		else if (typeof b.text === "string") parts.push(b.text);
	}
	return parts.join("\n").trim();
}
/**
* 组装候选工具视图（2026-08-24 scope 回归第二版修复）：dsh-tools 注册表的
* scope 约定是「agent 对象」而非 `scopeOf(agent.ctx)` 的 ctx 标签——模型面的
* schemas(exec.agent) / 执行面 get(name, agent) 均以 agent 对象为钥匙建立层级链，
* session-boundary 下 MCP 工具注册进该链可达的作用域层；而旧实现用 scopeOf(agent.ctx)
* 查询同一注册表，链条不达 → 全部「未在超时内注册」。现改为直接以 agent 对象为
* 作用域钥匙，与模型面/执行面完全同构；无 agent 时退回全局视图。
*/
function collectToolViews(ctx, agent) {
	const views = [];
	if (agent) views.push({
		label: "agent-object",
		tools: ctx.tools,
		scope: agent
	});
	views.push({
		label: "host-global",
		tools: ctx.tools,
		scope: void 0
	});
	return views;
}
async function ensureEnabled(control, ctx, state, serverName, entry) {
	const wasDisabled = entry.disabled;
	const entryId = entry.id;
	if (wasDisabled) {
		await entry.update({ disabled: false });
		state.aiEnabled.add(serverName);
		await control.setAiOwner(entryId, Date.now());
		ctx.logger.info?.(`mcp-skill-panel: AI enabled MCP server "${serverName}"`);
	}
	return wasDisabled;
}
async function waitRegistered(ctx, name, views, timeoutMs, signal) {
	const start = Date.now();
	return new Promise((resolve, reject) => {
		let settled = false;
		let pollTimer;
		let offTools;
		let offAbort;
		let offDispose;
		const onAbort = () => finish(/* @__PURE__ */ new Error("aborted"));
		const finish = (error, view) => {
			if (settled) return;
			settled = true;
			pollTimer?.();
			offTools?.();
			offAbort?.();
			offDispose?.();
			if (error) reject(error);
			else resolve(view);
		};
		const check = () => {
			if (settled) return;
			for (const view of views) {
				if (!view.tools) continue;
				try {
					if (Boolean(view.tools.get(name, view.scope))) {
						ctx.logger.info?.(`mcp-skill-panel: tool "${name}" resolved via view "${view.label}"`);
						return finish(void 0, view);
					}
				} catch {}
			}
			if (Date.now() - start >= timeoutMs) return finish(/* @__PURE__ */ new Error(`tool "${name}" 未在 ${timeoutMs}ms 内注册`));
			pollTimer = ctx.timeout(check, REGISTER_POLL_MS);
		};
		offTools = ctx.root.on("tools/change", () => check());
		offDispose = ctx.effect(() => () => finish(/* @__PURE__ */ new Error("context disposed")), "mcp-skill-panel: waitRegistered");
		if (signal) {
			if (signal.aborted) {
				finish(/* @__PURE__ */ new Error("aborted"));
				return;
			}
			signal.addEventListener("abort", onAbort, { once: true });
			offAbort = () => signal.removeEventListener("abort", onAbort);
		}
		check();
	});
}
/** 失败 / 无并发时恢复原状态：禁用并清 AI owner。 */
async function restore(control, ctx, state, serverName, entryId) {
	if (!state.aiEnabled.has(serverName)) {
		state.refCounts.delete(serverName);
		state.lastUsed.delete(serverName);
		return;
	}
	try {
		const entry = control.resolveEntry(serverName);
		if (entry && entry.id === entryId && !entry.disabled) await entry.update({ disabled: true });
		await control.clearAiOwner(entryId);
	} catch (error) {
		ctx.logger.warn?.(`mcp-skill-panel: restore disabled for "${serverName}" failed: ${msgOf(error)}`);
	} finally {
		state.aiEnabled.delete(serverName);
		state.lastUsed.delete(serverName);
		state.refCounts.delete(serverName);
	}
}
function startIdleReaper(control, ctx, state) {
	return ctx.interval(() => {
		const now = Date.now();
		for (const server of [...state.aiEnabled]) {
			if ((state.refCounts.get(server) ?? 0) > 0) continue;
			if (now - (state.lastUsed.get(server) ?? 0) < control.keepAliveMs) continue;
			const entry = control.resolveEntry(server);
			if (!entry) {
				state.aiEnabled.delete(server);
				state.refCounts.delete(server);
				state.lastUsed.delete(server);
				continue;
			}
			const entryId = entry.id;
			(async () => {
				try {
					if (!entry.disabled) await entry.update({ disabled: true });
					if ((state.refCounts.get(server) ?? 0) > 0) return;
					await control.clearAiOwner(entryId);
					ctx.logger.info?.(`mcp-skill-panel: idle-reaped MCP server "${server}"`);
				} catch (error) {
					ctx.logger.warn?.(`mcp-skill-panel: idle reaper disable "${server}" failed: ${msgOf(error)}`);
				} finally {
					if ((state.refCounts.get(server) ?? 0) === 0) {
						state.aiEnabled.delete(server);
						state.refCounts.delete(server);
						state.lastUsed.delete(server);
					}
				}
			})();
		}
	}, REAPER_INTERVAL_MS);
}
/**
* 创建控制层控制器。`caches` 即控制层依赖（McpControlCtx），由 index.ts
* 在 apply 里构建并封闭所有 IO。
*/
function createMcpCallController(ctx, caches) {
	const state = {
		refCounts: /* @__PURE__ */ new Map(),
		lastUsed: /* @__PURE__ */ new Map(),
		aiEnabled: /* @__PURE__ */ new Set()
	};
	return {
		async ensureEnabled(serverName) {
			const entry = caches.resolveEntry(serverName);
			if (!entry) throw new Error(`unknown MCP server "${serverName}"`);
			return ensureEnabled(caches, ctx, state, serverName, entry);
		},
		isAiEnabled(serverName) {
			return state.aiEnabled.has(serverName);
		},
		markUserEnabled(serverName) {
			state.aiEnabled.delete(serverName);
			state.refCounts.delete(serverName);
			state.lastUsed.delete(serverName);
			const entry = caches.resolveEntry(serverName);
			if (entry) caches.clearAiOwner(entry.id);
		},
		async call(serverName, toolName, args, agent, signal, explicitTimeoutMs) {
			const bareTool = normalizeToolName(serverName, toolName);
			const name = `mcp__${serverName}__${bareTool}`;
			if (isToolDisabled(name, typeof agent?.session?.header?.cwd === "string" ? agent.session.header.cwd : void 0)) return `MCP 工具 ${serverName}.${bareTool} 已被禁用（请在 MCP 管理面板打开该工具后再调用）`;
			const entry = caches.resolveEntry(serverName);
			if (!entry) return `未知 MCP server：${serverName}（不在 loader 中）`;
			const entryId = entry.id;
			const timeoutMs = explicitTimeoutMs ?? caches.serverTimeoutMs(serverName);
			let aiOwned = false;
			try {
				aiOwned = await ensureEnabled(caches, ctx, state, serverName, entry);
			} catch (error) {
				return `启用 MCP server "${serverName}" 失败：${msgOf(error)}`;
			}
			state.refCounts.set(serverName, (state.refCounts.get(serverName) ?? 0) + 1);
			state.lastUsed.set(serverName, Date.now());
			let failed = false;
			try {
				const result = await (await waitRegistered(ctx, name, collectToolViews(ctx, agent), timeoutMs, signal)).tools.execute({
					callId: `mcp-call-${randomUUID()}`,
					name,
					arguments: args,
					agent,
					signal
				});
				state.lastUsed.set(serverName, Date.now());
				if (result && result.isError) {
					failed = true;
					return `MCP ${serverName}.${bareTool} 调用失败：${msgOf(result.error ?? "unknown error")}`;
				}
				const text = contentText(result ? result.content : void 0);
				return text.length > 0 ? text : `MCP ${serverName}.${bareTool} 无返回内容`;
			} catch (error) {
				failed = true;
				return `MCP ${serverName}.${bareTool} 调用异常：${msgOf(error)}（提示：tool 参数应传该 server 上的裸名；server/tool 是否存在可先 mcp_search 确认）`;
			} finally {
				const next = (state.refCounts.get(serverName) ?? 1) - 1;
				if (next <= 0) state.refCounts.delete(serverName);
				else state.refCounts.set(serverName, next);
				if (failed && aiOwned && next <= 0) restore(caches, ctx, state, serverName, entryId);
			}
		},
		startIdleReaper() {
			return startIdleReaper(caches, ctx, state);
		},
		status() {
			const out = [];
			for (const server of state.aiEnabled) out.push({
				server,
				refCount: state.refCounts.get(server) ?? 0,
				lastUsed: state.lastUsed.get(server) ?? 0
			});
			out.sort((a, b) => a.server.localeCompare(b.server));
			return out;
		}
	};
}
function clampLimit(value, defaultValue, max) {
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return defaultValue;
	return Math.min(Math.floor(value), max);
}
/** 摘要截断长度：mcp_search 空查询的输出 token 控制（P2-5）。 */
const SUMMARY_MAX_LEN = 80;
function buildSummary(control) {
	const catalog = control.getCatalog();
	const merged = { ...control.serverSummary };
	const lines = [];
	const seen = /* @__PURE__ */ new Set();
	for (const [server, summary] of Object.entries(merged)) {
		if (seen.has(server)) continue;
		seen.add(server);
		lines.push({
			server,
			summary
		});
	}
	for (const server of Object.keys(catalog)) {
		if (seen.has(server)) continue;
		seen.add(server);
		const first = catalog[server]?.tools?.[0];
		const raw = first ? String(first.description) : "MCP server";
		const summary = raw.length > SUMMARY_MAX_LEN ? `${raw.slice(0, SUMMARY_MAX_LEN)}…` : raw;
		lines.push({
			server,
			summary
		});
	}
	lines.sort((a, b) => a.server.localeCompare(b.server));
	return lines;
}
function registerMcpSearchTool(ctx, control) {
	const definition = defineTool({
		name: "mcp_search",
		description: "检索可用的 MCP 服务器与工具目录。空参数返回能力摘要表；传 server 列出该服务器的全部工具；传 query 做关键词 top-K 全文检索（命中返回完整 schema）。",
		parameters: {
			query: {
				type: "string",
				description: "检索关键词，按工具名/描述/参数名打分"
			},
			server: {
				type: "string",
				description: "列出指定 MCP server 的全部工具"
			},
			limit: {
				type: "integer",
				description: "top-K 上限（默认 5，最大 10）"
			}
		},
		output: {
			schema: { type: "json" },
			render: (_args, value) => [{
				type: "text",
				text: JSON.stringify(value, null, 2)
			}]
		},
		execute: async (args, exec) => {
			const catalog = control.getCatalog();
			const query = typeof args.query === "string" ? args.query.trim() : "";
			const server = typeof args.server === "string" ? args.server.trim() : "";
			const limit = clampLimit(typeof args.limit === "number" ? args.limit : void 0, control.searchLimitDefault, control.searchLimitMax);
			const workspace = typeof exec?.agent?.session?.header?.cwd === "string" ? exec.agent.session.header.cwd : void 0;
			const keep = (name) => !isToolDisabled(name, workspace);
			if (server) {
				const result = listServer(catalog, server);
				const tools = (result ?? []).filter((tool) => keep(tool.name));
				return toJson({
					ok: true,
					kind: "list",
					server,
					found: result !== void 0,
					count: tools.length,
					tools
				});
			}
			if (query) {
				const hits = searchCatalog(catalog, query, limit).filter((hit) => keep(hit.tool.name));
				return toJson({
					ok: true,
					kind: "search",
					query,
					count: hits.length,
					limit,
					hits
				});
			}
			const servers = buildSummary(control);
			return toJson({
				ok: true,
				kind: "summary",
				summary: servers.map((s) => `- ${s.server}: ${s.summary}`).join("\n"),
				servers,
				count: servers.length
			});
		}
	});
	return ctx.tools.register(definition);
}
/** 把运行时对象投影为 JsonValue（工具 schema 本身是 JSON，转换是安全的）。 */
function toJson(value) {
	return JSON.parse(JSON.stringify(value));
}
function registerMcpCallTool(ctx, controller) {
	const definition = defineTool({
		name: "mcp_call",
		description: "调用一个 MCP 服务器上的工具。自动保活启用目标 server（用完按 keepAliveMs 空闲回收），等待注册后在下层执行。参数透传给远端工具。",
		parameters: {
			server: {
				type: "string",
				required: true,
				description: "MCP 服务器名（见 mcp_search 摘要）"
			},
			tool: {
				type: "string",
				required: true,
				description: "该 server 上的工具名（裸名，如 understand_image；误传注册全名 mcp__<server>__<tool> 会自动归一化）"
			},
			arguments: {
				type: "json",
				description: "传给远端工具的参数字典；必须传 JSON 对象本身，不要传 JSON 字符串（兼容：误传字符串会自动解析）"
			}
		},
		output: {
			schema: { type: "string" },
			render: (_args, value) => [{
				type: "text",
				text: value
			}]
		},
		execute: (args, exec) => {
			return controller.call(args.server, args.tool, normalizeArguments(args.arguments), exec.agent, exec.signal);
		}
	});
	return ctx.tools.register(definition);
}
/**
* 注册 mcp_search + mcp_call 两个模型工具。`controller` 必须是调用方持有的唯一
* 控制层实例（与空闲回收器共享同一引用计数/owner 状态），否则回收与调用不同步。
* 返回合并 disposer。
*/
function installMcpControlTools(ctx, control, controller) {
	return ctx.effect(() => {
		const disposers = [];
		try {
			disposers.push(registerMcpSearchTool(ctx, control));
			disposers.push(registerMcpCallTool(ctx, controller));
		} catch (error) {
			for (const d of disposers) d();
			throw error;
		}
		return () => {
			for (const d of disposers) d();
		};
	}, "mcp-skill-panel: mcp control tools");
}
//#endregion
//#region src/collect.ts
/** 分域缓存 TTL：事件驱动失效为主，TTL 只是兜底（事件丢失场景） */
const DOMAIN_TTL_MS = 6e4;
/**
* 最近一次 toggle 确认过的 skill 状态（name → modelInvocable）。
* 服务端轮询用 skills.get 实时读文件确认，早于 snapshot 的发现缓存失效，
* 用它覆盖 collectState 里的陈旧 candidate 值。
*/
const confirmedSkills = /* @__PURE__ */ new Map();
function createDomainCaches() {
	const mcpCache = /* @__PURE__ */ new Map();
	const skillsCache = /* @__PURE__ */ new Map();
	const mcpAggregates = /* @__PURE__ */ new Map();
	const schemasCache = /* @__PURE__ */ new Map();
	return {
		mcpCache,
		skillsCache,
		mcpAggregates,
		schemasCache,
		invalidateMcp: () => {
			mcpCache.clear();
			mcpAggregates.clear();
			schemasCache.clear();
		},
		invalidateSkills: () => skillsCache.clear()
	};
}
function tokenEstimate(parameters) {
	try {
		return Math.max(1, Math.round(JSON.stringify(parameters ?? {}).length / 4));
	} catch {
		return 1;
	}
}
/** 写时清理过期条目（P2-8）：分域缓存 / 聚合 / 已确认 skill 的 Map 长期运行不膨胀。 */
function pruneExpired(map, now) {
	for (const [key, entry] of map) if (now - entry.at >= 6e4) map.delete(key);
}
/**
* 按 scope 共享的 schemas 原始缓存：路径 A（catalog 采集）与路径 B（面板聚合）
* 共用同一份深克隆结果，避免 tools.change 风暴期内重复深克隆。
* key = scopeKey ?? null；TTL 由调用方指定（路径 A 500ms，路径 B 60s）。
*/
function getSchemasView(ctx, caches, scopeKey, ttlMs) {
	const key = scopeKey ?? null;
	const now = Date.now();
	const maxTtl = Math.max(ttlMs, DOMAIN_TTL_MS);
	for (const [k, entry] of caches.schemasCache) if (now - entry.at >= maxTtl) caches.schemasCache.delete(k);
	const hit = caches.schemasCache.get(key);
	if (hit && now - hit.at < ttlMs) return hit.schemas;
	const schemas = scopeKey ? ctx.tools.schemas(scopeKey) : ctx.tools.schemas();
	caches.schemasCache.set(key, {
		at: now,
		schemas
	});
	return schemas;
}
function resolveAgent(ctx, sessionId) {
	if (sessionId) {
		const byId = ctx.agents.get(sessionId);
		if (byId) return byId;
	}
	const roots = ctx.agents.roots();
	if (roots.length > 0) return roots[0];
	return ctx.agents.list()[0];
}
function baseView(ctx, agent, cwd) {
	let preset = null;
	try {
		if (agent) preset = ctx.agentPresets.composedPreset(agent.ctx) ?? null;
	} catch {
		preset = null;
	}
	return {
		sessionId: agent ? agent.id : null,
		preset,
		cwd: cwd ?? null
	};
}
function computeAggregate(schemas) {
	const byServer = /* @__PURE__ */ new Map();
	let mcpToolsTotal = 0;
	let mcpTokensTotal = 0;
	for (const schema of schemas) {
		const server = serverOfMcp$1(String(schema.name ?? ""));
		if (!server) continue;
		const entry = byServer.get(server) ?? {
			tools: 0,
			tokens: 0
		};
		entry.tools += 1;
		const est = tokenEstimate(schema.parameters);
		entry.tokens += est;
		byServer.set(server, entry);
		mcpToolsTotal += 1;
		mcpTokensTotal += est;
	}
	return {
		byServer,
		mcpToolsTotal,
		mcpTokensTotal
	};
}
/**
* 按 scope 复用的 MCP 聚合缓存（C 项优化）：tools.schemas 深克隆 300+ 工具是
* collectMcp 最重的一步；聚合结果在 tools/change 事件间隙直接复用，
* TTL 只是事件丢失时的兜底。key = scopeKey（null 表示全局视图）。
*/
function getMcpAggregate(ctx, caches, scopeKey, errors) {
	const key = scopeKey ?? null;
	pruneExpired(caches.mcpAggregates, Date.now());
	const hit = caches.mcpAggregates.get(key);
	if (hit && Date.now() - hit.at < 6e4) return hit.value;
	let schemas = [];
	try {
		schemas = getSchemasView(ctx, caches, scopeKey, DOMAIN_TTL_MS);
	} catch (error) {
		errors.push(`tools.schemas: ${messageOf(error)}`);
	}
	const value = computeAggregate(schemas);
	caches.mcpAggregates.set(key, {
		at: Date.now(),
		value
	});
	return value;
}
/** 停用态 token 估算缓存（P2-6）：fetchedAt 不变则复用，避免每次面板请求
* 对停用 server（如 cheatengine 173 工具）全量 JSON.stringify。 */
function catalogTokens(runtime, serverName, info) {
	if (!info) return 0;
	const hit = runtime.tokenCache.get(serverName);
	if (hit && hit.fetchedAt === info.fetchedAt) return hit.tokens;
	const tokens = info.tools.reduce((sum, t) => sum + tokenEstimate(t.parameters), 0);
	runtime.tokenCache.set(serverName, {
		fetchedAt: info.fetchedAt,
		tokens
	});
	return tokens;
}
async function collectMcp(deps, sessionId) {
	const { ctx } = deps;
	const errors = [];
	const agent = resolveAgent(ctx, sessionId);
	const scopeKey = agent ? scopeOf(agent.ctx) : void 0;
	const cwd = agent?.session?.header?.cwd ?? void 0;
	const { byServer, mcpToolsTotal, mcpTokensTotal } = getMcpAggregate(ctx, deps.caches, scopeKey, errors);
	const schemas = getSchemasView(ctx, deps.caches, scopeKey, DOMAIN_TTL_MS);
	const toolsByServer = /* @__PURE__ */ new Map();
	for (const schema of schemas) {
		const name = String(schema?.name ?? "");
		if (!name.startsWith("mcp__")) continue;
		const server = serverOfMcp$1(name);
		if (server === null) continue;
		let list = toolsByServer.get(server);
		if (!list) {
			list = [];
			toolsByServer.set(server, list);
		}
		list.push({
			name,
			description: String(schema?.description ?? "")
		});
	}
	for (const list of toolsByServer.values()) list.sort((a, b) => a.name.localeCompare(b.name));
	const mcp = [];
	const state = await readState().catch(() => void 0);
	try {
		for (const entry of ctx.loader.entries()) {
			if (!isMcpEntry(entry)) continue;
			const serverName = serverNameOf(entry);
			const projectWorkspace = projectServerOwner(serverName);
			const agg = byServer.get(serverName);
			const liveTools = agg?.tools ?? 0;
			const running = entry.fiber !== void 0;
			const disabled = entry.disabled;
			const rowFile = (entry.parent?.tree)?.filename;
			const rowDesired = typeof rowFile === "string" && rowFile.length > 0 ? state?.mcp?.[rowFile]?.[entry.options.id]?.desired : void 0;
			const catalogInfo = deps.catalogRuntime.catalog[serverName];
			const displayTools = liveTools > 0 ? liveTools : catalogInfo?.tools.length ?? 0;
			const displayTokens = liveTools > 0 ? agg?.tokens ?? 0 : catalogTokens(deps.catalogRuntime, serverName, catalogInfo);
			const status = disabled ? "disabled" : running ? liveTools > 0 ? "active" : "idle" : "failed";
			const transportRaw = mcpEntryConfig(entry)?.transport;
			const toolDisabled = disabledToolsOf(serverName, projectWorkspace);
			const toolList = toolsByServer.get(serverName);
			mcp.push({
				entryId: entry.id,
				rowId: entry.options.id,
				serverName,
				transport: transportRaw ? String(transportRaw) : null,
				disabled,
				running,
				tools: displayTools,
				tokens: displayTokens,
				toolList: toolList?.map((tool) => ({
					name: tool.name,
					description: tool.description,
					disabled: toolDisabled.has(tool.name)
				})) ?? null,
				status,
				modelVisible: !disabled && !(deps.catalogRuntime.autoManage && (deps.controller?.isAiEnabled(serverName) ?? false)),
				desired: rowDesired,
				pending: rowDesired !== void 0 ? rowDesired !== disabled : false,
				workspace: projectWorkspace
			});
		}
	} catch (error) {
		errors.push(`loader.entries: ${messageOf(error)}`);
	}
	mcp.sort((a, b) => a.serverName.localeCompare(b.serverName));
	return {
		...baseView(ctx, agent, cwd),
		mcp,
		mcpTotal: mcp.length,
		mcpDisabled: mcp.filter((row) => row.disabled).length,
		mcpToolsTotal,
		mcpTokensTotal,
		autoManage: deps.catalogRuntime.autoManage,
		activeWorkspace: getActiveWorkspace(),
		errors
	};
}
async function collectSkills(deps, sessionId) {
	const { ctx } = deps;
	const errors = [];
	const agent = resolveAgent(ctx, sessionId);
	const cwd = agent?.session?.header?.cwd ?? void 0;
	const skills = [];
	let skillsModelVisible = 0;
	try {
		const snapshot = await ctx.skills.snapshot({
			scope: agent,
			cwd
		});
		for (const summary of snapshot.skills) {
			const confirmed = confirmedSkills.get(summary.name);
			const modelInvocable = confirmed && Date.now() - confirmed.at < 6e4 ? confirmed.modelInvocable : summary.invocation?.modelInvocable !== false;
			if (modelInvocable) skillsModelVisible += 1;
			skills.push({
				name: summary.name,
				description: summary.description ?? "",
				source: summary.source ?? "unknown",
				modelInvocable,
				userInvocable: summary.invocation?.userInvocable !== false
			});
		}
	} catch (error) {
		errors.push(`skills.snapshot: ${messageOf(error)}`);
	}
	return {
		...baseView(ctx, agent, cwd),
		skills,
		skillsTotal: skills.length,
		skillsModelVisible,
		errors
	};
}
//#endregion
//#region src/preset.ts
const DISABLE_KEY = "disable-model-invocation";
function escapeRegExp(value) {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
/** 新行分隔符：跟随原文件。 */
function lineSep(text) {
	return text.includes("\r\n") ? "\r\n" : "\n";
}
/**
* 在组合文件中对 `- id: <rowId>` 行做 `  <key>: <value>` 标记的插入/移除。
* 逐行文本编辑，保留注释与 !!js 表达式原样（loader 的 yaml.dump 会丢注释，故不用）。
*
* 语义（2026-08-27 修复）：value=true 保证标记存在且为 true（已有 false 时反转）；
* value=false 移除标记。此前 value=true 遇到已存在的 `disabled: false` 会原样返回
* （只支持插入/删除不支持反转），导致物化失败后 lastApplied 与文件脱节，
* 下次启动被误判「外部修改」而删掉 state 条目（obsidian 设置丢失事故）。
*/
function setRowFlag(text, rowId, key, value) {
	const nl = lineSep(text);
	const lines = text.split(/\r?\n/);
	const rowRe = new RegExp(`^-\\s*id:\\s*${escapeRegExp(rowId)}\\s*$`);
	const idx = lines.findIndex((line) => rowRe.test(line));
	if (idx < 0) throw new Error(`row "- id: ${rowId}" not found in composition file`);
	let end = idx + 1;
	while (end < lines.length && !/^-\s*id:/.test(lines[end])) end += 1;
	const block = lines.slice(idx, end);
	const flagRe = new RegExp(`^\\s*${escapeRegExp(key)}:\\s*(true|false)\\s*$`);
	const flagAt = block.findIndex((line) => flagRe.test(line));
	if (flagAt >= 0) {
		if (value) {
			if (/:\s*false\s*$/.test(block[flagAt])) {
				lines.splice(idx + flagAt, 1, `  ${key}: true`);
				return lines.join(nl);
			}
			return text;
		}
		lines.splice(idx + flagAt, 1);
		return lines.join(nl);
	}
	if (value) {
		lines.splice(idx + 1, 0, `  ${key}: true`);
		return lines.join(nl);
	}
	return text;
}
/** SKILL.md frontmatter 的 disable-model-invocation 键注入/移除（kebab-case 是唯一合法形式）。 */
function setSkillFlag(text, value) {
	lineSep(text);
	const has = new RegExp(`^${DISABLE_KEY}:\\s*true\\s*$`, "m").test(text);
	if (value && !has) {
		const m = /^---\s*(\r?\n)/.exec(text);
		if (!m) return text;
		return `---${m[1]}${DISABLE_KEY}: true${m[1]}${text.slice(m[0].length)}`;
	}
	if (!value && has) return text.replace(new RegExp(`^\\s*${DISABLE_KEY}:\\s*true\\s*\\r?\\n?`, "m"), "");
	return text;
}
/** dsh-skill-filesystem 的 skill 名约束：kebab-case（非合法名会被发现层丢弃）。 */
const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** skill 名是否合法（kebab-case，前端预校验与后端落盘共用）。 */
function isValidSkillName(name) {
	return SKILL_NAME_PATTERN.test(name);
}
/**
* 生成 SKILL.md 文本：frontmatter（name/description）+ 正文。
* description 用 JSON 双引号标量（合法 YAML，冒号/换行安全）；正文原样保留。
*/
function buildSkillMd(name, description, body) {
	const nl = "\n";
	return `---${nl}name: ${name}${nl}description: ${JSON.stringify(description)}${nl}---${nl}${nl}${body.replace(/\s+$/, "")}${nl}`;
}
/** 读取某行当前是否带 disabled: true（true/false/null=无标记）。 */
function rowDisabledState(text, rowId) {
	const lines = text.split(/\r?\n/);
	const rowRe = new RegExp(`^-\\s*id:\\s*${escapeRegExp(rowId)}\\s*$`);
	const idx = lines.findIndex((line) => rowRe.test(line));
	if (idx < 0) return null;
	let end = idx + 1;
	while (end < lines.length && !/^-\s*id:/.test(lines[end])) end += 1;
	const flagLine = lines.slice(idx, end).find((line) => /^\s*disabled:\s*(true|false)\s*$/.test(line));
	if (!flagLine) return null;
	return /:\s*true\s*$/.test(flagLine);
}
/**
* 启动早期物化：把状态文件里的 MCP 启停意图写入预设组合文件。
* 只在「没有任何 agent 在跑」时执行 —— 有会话时写文件会触发
* dsh-agent-presets 的 stamp 重挂（旧实例不 dispose → serverName 冲突事故）。
*/
async function syncPresetFiles(ctx) {
	if (ctx.agents.list().length > 0) return 0;
	const state = await readState();
	const mcp = state.mcp;
	if (!mcp || Object.keys(mcp).length === 0) return 0;
	let materialized = 0;
	for (const [file, rows] of Object.entries(mcp)) {
		let text;
		try {
			text = await readFile(file, "utf8");
		} catch {
			continue;
		}
		let changed = false;
		const next = {};
		for (const [rowId, entry] of Object.entries(rows)) {
			const cur = rowDisabledState(text, rowId);
			if (cur !== entry.lastApplied) {
				next[rowId] = {
					desired: entry.desired,
					lastApplied: cur
				};
				continue;
			}
			if (cur === true !== entry.desired) try {
				text = setRowFlag(text, rowId, "disabled", entry.desired);
				changed = true;
				materialized += 1;
			} catch {
				continue;
			}
			next[rowId] = {
				desired: entry.desired,
				lastApplied: entry.desired
			};
		}
		if (changed) {
			const tmp = `${file}.tmp`;
			await writeFile(tmp, text, "utf8");
			await rename(tmp, file);
		}
		mcp[file] = next;
	}
	await writeState(state);
	return materialized;
}
//#endregion
//#region src/pending.ts
/**
* 延迟生效（P1 会话边界）：MCP 启停意图的待生效队列。
*
* next-session 模式下 toggle 不立即 entry.update（避免中途改 tools 前缀 → 缓存 miss），
* 只写 state.json.desired 并进入本模块的 pendingMcp 内存队列；在边界统一应用：
* - 实时：新会话 `agent/session-start`（首次请求前）调用 applyPendingMcp
* - 兜底：DSH 重启后由 syncPresetFiles() 从 state.json 物化到预设组合（既有路径）
* - 强制：面板「立即应用待生效变更」端点同样调用 applyPendingMcp
*
* immediate 模式不经过本队列（toggleMcp 直接 entry.update）。
*/
/** 待生效队列（进程内存态；重启后由 state.json.desired + syncPresetFiles 承接）。 */
const pendingMcp = /* @__PURE__ */ new Map();
/**
* 应用整条待生效队列：对每项 entry.update(desired)；用户启用方向 markUserEnabled
* （清 AI 标记 → 转为「用户打开」语义，回收器不再回收）。成功即从队列清除；
* 失败保留（下个边界重试）。返回实际应用数。调用方负责收尾 single invalidateMcp。
*/
async function applyPendingMcp(deps) {
	const { ctx } = deps;
	let applied = 0;
	for (const [entryId, pending] of [...pendingMcp.entries()]) try {
		const entry = ctx.loader.resolve(entryId);
		if (!isMcpEntry(entry)) {
			pendingMcp.delete(entryId);
			continue;
		}
		await entry.update({ disabled: pending.disabled });
		if (!pending.disabled && deps.controller) deps.controller.markUserEnabled(serverNameOf(entry));
		pendingMcp.delete(entryId);
		applied += 1;
		ctx.logger.info?.(`mcp-skill-panel: applied pending toggle ${entryId} → disabled=${pending.disabled}`);
	} catch (error) {
		ctx.logger.warn?.(`mcp-skill-panel: pending apply "${entryId}" failed: ${messageOf(error)}`);
	}
	applied += await applyStateResidue(deps, await readState().catch(() => void 0));
	return applied;
}
/**
* state.json 残留补齐（见 applyPendingMcp ②）。只改 live（entry.update），
* 不动 preset 文件与 lastApplied（lastApplied 语义 = 文件上次状态，供物化判定）。
*/
async function applyStateResidue(deps, state) {
	const { ctx } = deps;
	const mcp = state?.mcp;
	if (!mcp || Object.keys(mcp).length === 0) return 0;
	let applied = 0;
	let residueCleared = false;
	const byFile = /* @__PURE__ */ new Map();
	for (const entry of ctx.loader.entries()) {
		if (!isMcpEntry(entry)) continue;
		if (pendingMcp.has(entry.id)) continue;
		const file = (entry.parent?.tree)?.filename;
		if (typeof file !== "string" || file.length === 0) continue;
		const rowState = mcp[file]?.[entry.options.id];
		if (!rowState || typeof rowState.desired !== "boolean") continue;
		if (rowState.desired === entry.disabled) continue;
		let bucket = byFile.get(file);
		if (!bucket) {
			bucket = [];
			byFile.set(file, bucket);
		}
		bucket.push({
			entry,
			rowState
		});
	}
	for (const [file, entries] of byFile) {
		let text;
		try {
			text = await readFile(file, "utf8");
		} catch {
			continue;
		}
		let fileCleared = false;
		for (const { entry, rowState } of entries) {
			const cur = rowDisabledState(text, entry.options.id);
			if (cur !== rowState.lastApplied) {
				rowState.lastApplied = cur;
				fileCleared = true;
				ctx.logger.info?.(`mcp-skill-panel: state-residue ${entry.id}: preset file externally modified, aligning lastApplied`);
				continue;
			}
			try {
				await entry.update({ disabled: rowState.desired });
				if (!rowState.desired && deps.controller) deps.controller.markUserEnabled(serverNameOf(entry));
				applied += 1;
				ctx.logger.info?.(`mcp-skill-panel: applied state-residue toggle ${entry.id} → disabled=${rowState.desired}`);
			} catch (error) {
				ctx.logger.warn?.(`mcp-skill-panel: state-residue apply "${entry.id}" failed: ${messageOf(error)}`);
			}
		}
		if (fileCleared) residueCleared = true;
	}
	if (residueCleared) await writeState(state ?? {}).catch(() => void 0);
	return applied;
}
/** 当前待生效项数量（面板/诊断用）。 */
function pendingMcpCount() {
	return pendingMcp.size;
}
//#endregion
//#region src/routes.ts
/**
* HTTP 路由层：控制动作（toggleMcp/toggleSkill）与全部 /api/mcp-skill-panel/* 端点。
*
* 从 index.ts 拆出（可维护性批次 P1-1），并收敛端点样板（P2-6）：
* defineHandler 统一 method 校验 / 异步错误响应 / {ok:true,...} 包装。
*/
const API_PREFIX = "/api/mcp-skill-panel";
/** 旧前缀（0.3.1 及以前为 /api/runtime-inventory），保留兼容 */
const LEGACY_API_PREFIX = "/api/runtime-inventory";
/** skill toggle 后等待 watcher 失效 catalog 的最长时间 */
const SKILL_TOGGLE_CONFIRM_MS = 5e3;
/** 进程级随机令牌：写操作（启停/config）要求客户端在 x-panel-token 头携带；
* 阻断跨源 / DNS-rebinding 对本地控制端点的盲写。GET 只读保持开放。 */
const PANEL_TOKEN = randomBytes(32).toString("hex");
/** readBody 体积上限：防无界 body 累积（本地 DoS 向量）。 */
const MAX_BODY_BYTES = 65536;
function json(res, code, body) {
	res.statusCode = code;
	res.setHeader("content-type", "application/json");
	res.end(JSON.stringify(body));
}
function ok(res, data) {
	json(res, 200, {
		ok: true,
		...data
	});
}
function readBody(req) {
	return new Promise((resolve, reject) => {
		let body = "";
		const onData = (chunk) => {
			body += String(chunk);
			if (Buffer.byteLength(body, "utf8") > MAX_BODY_BYTES) {
				req.destroy();
				reject(/* @__PURE__ */ new Error(`body exceeds ${MAX_BODY_BYTES} bytes`));
			}
		};
		const onEnd = () => {
			cleanup();
			resolve(body);
		};
		const onError = (error) => {
			cleanup();
			reject(error);
		};
		const cleanup = () => {
			req.off("data", onData);
			req.off("end", onEnd);
			req.off("error", onError);
		};
		req.on("data", onData);
		req.on("end", onEnd);
		req.on("error", onError);
	});
}
function queryParam(url, key) {
	const m = new RegExp(`[?&]${key}=([^&]+)`).exec(url);
	return m ? decodeURIComponent(m[1]) : void 0;
}
/** 写操作 token 校验（x-panel-token === 本进程随机令牌）。 */
function tokenOk(req) {
	return req.headers["x-panel-token"] === PANEL_TOKEN;
}
/** 端点样板：method 校验 + 异步执行 + {ok:true} 包装 + 统一错误码（POST 参数错 400 / GET 服务错 500）。
* guarded=true 时要求 x-panel-token 匹配（写操作鉴权）。 */
function handle(method, run, guarded = false) {
	return (req, res) => {
		if (req.method !== method) {
			json(res, 405, {
				ok: false,
				error: "method-not-allowed"
			});
			return;
		}
		if (guarded && !tokenOk(req)) {
			json(res, 401, {
				ok: false,
				error: "unauthorized"
			});
			return;
		}
		Promise.resolve(run(req)).then((data) => ok(res, data)).catch((error) => json(res, method === "POST" ? 400 : 500, {
			ok: false,
			error: messageOf(error)
		}));
	};
}
/**
* 同 path 多 method 路由：webServer 的 exact 路由按 path 唯一（同 path 重复注册
* 会中断后续注册），因此 GET+POST 共存的端点必须合并为单个 handler 内部分发。
*/
function handleAny(entries, guardPosts = false) {
	return (req, res) => {
		const entry = entries.find((e) => e.method === req.method);
		if (!entry) {
			json(res, 405, {
				ok: false,
				error: "method-not-allowed"
			});
			return;
		}
		handle(entry.method, entry.run, guardPosts)(req, res);
	};
}
async function toggleMcp(deps, entryId, disabled, applyMode) {
	const { ctx } = deps;
	const mode = applyMode ?? stateApplyMode(await readState());
	const entry = ctx.loader.resolve(entryId);
	if (!isMcpEntry(entry)) throw new Error(`entry "${entryId}" is not an MCP row`);
	const rowId = entry.options.id;
	const serverName = serverNameOf(entry);
	const projectWorkspace = projectServerOwner(serverName);
	if (projectWorkspace !== void 0) {
		if (!disabled && deps.controller) deps.controller.markUserEnabled(serverName);
		const state = await readState();
		state.projectMcp ??= {};
		state.projectMcp[projectWorkspace] ??= {};
		state.projectMcp[projectWorkspace][serverName] = disabled;
		await writeState(state);
		await entry.update({ disabled });
		return {
			entryId,
			rowId,
			serverName,
			disabled,
			running: entry.fiber !== void 0,
			persisted: true,
			workspace: projectWorkspace,
			applied: true,
			pending: false
		};
	}
	const deferred = mode === "next-session";
	if (deferred) pendingMcp.set(entryId, {
		entryId,
		file: (entry.parent?.tree)?.filename ?? null,
		rowId,
		disabled
	});
	else {
		pendingMcp.delete(entryId);
		await entry.update({ disabled });
		if (!disabled && deps.controller) deps.controller.markUserEnabled(serverNameOf(entry));
	}
	const file = (entry.parent?.tree)?.filename;
	let fileState = null;
	if (typeof file === "string" && file.length > 0) try {
		fileState = rowDisabledState(await readFile(file, "utf8"), rowId);
	} catch {
		fileState = null;
	}
	let persisted = false;
	if (typeof file === "string" && file.length > 0) {
		const state = await readState();
		state.mcp ??= {};
		state.mcp[file] ??= {};
		state.mcp[file][rowId] = {
			desired: disabled,
			lastApplied: fileState
		};
		await writeState(state);
		persisted = true;
	}
	return {
		entryId,
		rowId,
		serverName,
		disabled,
		running: entry.fiber !== void 0,
		persisted,
		file: file ?? null,
		applied: !deferred,
		pending: deferred
	};
}
async function toggleSkill(deps, skillName, disabled, sessionId) {
	const { ctx } = deps;
	const agent = resolveAgent(ctx, sessionId);
	const cwd = agent?.session?.header?.cwd;
	const def = await ctx.skills.get(skillName, {
		scope: agent,
		cwd
	});
	if (!def?.path) throw new Error(`skill "${skillName}" has no file path (${def?.source ?? "unknown source"})`);
	const text = await readFile(def.path, "utf8");
	const next = setSkillFlag(text, disabled);
	if (next !== text) await writeFile(def.path, next, "utf8");
	const deadline = Date.now() + SKILL_TOGGLE_CONFIRM_MS;
	let confirmed = false;
	let wait = 80;
	while (Date.now() < deadline) {
		const after = await ctx.skills.get(skillName, {
			scope: agent,
			cwd
		});
		if (after && after.invocation?.modelInvocable === !disabled) {
			confirmed = true;
			break;
		}
		const remaining = deadline - Date.now();
		if (remaining <= 0) break;
		await ctx.timeout(Math.min(wait, remaining));
		wait = Math.min(wait * 2, 1e3);
	}
	pruneExpired(confirmedSkills, Date.now());
	if (confirmed) confirmedSkills.set(skillName, {
		modelInvocable: !disabled,
		at: Date.now()
	});
	return {
		name: skillName,
		disabled,
		modelInvocable: !disabled,
		path: def.path,
		confirmed
	};
}
/**
* 路由写文件队列：串行化 appendGlobalPatch / writeProjectMcp 的「读-改-写」。
* 并发 POST（或多会话同时添加）若各自以旧内容为基底写盘，
* 先写者的内容会被后写者整体覆盖丢失 → 全部走同一 Promise 链。
*/
let fileWriteChain = Promise.resolve();
/**
* 定位 profile 的用户 patch 层（<profile>/cordis.patch.yml）。
* 根树 backing 文件是 <profile>/cordis.yml（每次启动重置为 []），
* patch 与其同目录；从任一 root 树 entry 的 tree.filename 反推。
*/
function profilePatchPath(ctx) {
	for (const entry of ctx.loader.entries()) {
		const file = (entry.parent?.tree)?.filename;
		if (typeof file === "string" && basename(file) === "cordis.yml") return join(dirname(file), "cordis.patch.yml");
	}
	throw new Error("无法定位 profile 补丁文件 cordis.patch.yml（未找到 cordis.yml 根树；请确认 profile 已正常挂载后重试）");
}
/** 已存在检查：loader 存活行或 patch 文本里已有同 id。 */
function existingRowIds(ctx, patchText) {
	const ids = /* @__PURE__ */ new Set();
	for (const entry of ctx.loader.entries()) {
		if (!isMcpEntry(entry)) continue;
		ids.add(String(entry.options.id));
	}
	for (const line of patchText.split(/\r?\n/)) {
		const m = /^\s*-?\s*id:\s*([^\s]+)\s*$/.exec(line);
		if (m) ids.add(m[1]);
	}
	return ids;
}
/** 追加 `- insert:` patch 块到 profile cordis.patch.yml（串行排队 + 原子写 + 跟随原换行风格）。 */
function appendGlobalPatch(ctx, yamlBlock) {
	const run = fileWriteChain.then(async () => {
		const file = profilePatchPath(ctx);
		const existing = await readFile(file, "utf8").catch(() => "");
		const sep = existing.includes("\r\n") ? "\r\n" : "\n";
		const next = (existing.length > 0 && !existing.endsWith("\n") ? existing + sep : existing) + yamlBlock.replace(/\r?\n/g, sep);
		await writeFile(`${file}.tmp`, next, "utf8");
		await rename(`${file}.tmp`, file);
		return { file };
	});
	fileWriteChain = run.catch(() => void 0);
	return run;
}
/** 把 servers 合并写入 <workspace>/.dsh/mcps/mcp.json（新建 server 覆盖同名旧值；读-改-写串行化）。 */
function writeProjectMcp(workspace, servers) {
	const run = fileWriteChain.then(async () => {
		const mcpsDir = join(workspace, ".dsh", "mcps");
		const file = join(mcpsDir, "mcp.json");
		await mkdir(mcpsDir, { recursive: true });
		let existing = {};
		try {
			const parsed = JSON.parse(await readFile(file, "utf8"));
			if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) existing = parsed;
		} catch {}
		let map = {};
		if (existing.mcpServers && typeof existing.mcpServers === "object" && !Array.isArray(existing.mcpServers)) map = existing.mcpServers;
		for (const [name, server] of Object.entries(servers)) map[name] = server;
		const payload = {
			...existing,
			mcpServers: map
		};
		await writeFile(`${file}.tmp`, JSON.stringify(payload, null, 2), "utf8");
		await rename(`${file}.tmp`, file);
		return { file };
	});
	fileWriteChain = run.catch(() => void 0);
	return run;
}
/** 全局添加：写入 profile patch + 立即挂载到 loader（粘贴即用，重启由 patch 承接）。 */
async function addGlobalMcp(ctx, servers) {
	const file = profilePatchPath(ctx);
	const existingIds = existingRowIds(ctx, await readFile(file, "utf8").catch(() => ""));
	const toAdd = /* @__PURE__ */ new Map();
	const skipped = [];
	for (const row of serversToRows(servers)) {
		if (existingIds.has(row.id)) {
			skipped.push(String(row.config.serverName));
			continue;
		}
		toAdd.set(row.id, row);
	}
	const rows = [...toAdd.values()];
	if (rows.length === 0) return {
		file,
		added: 0,
		skipped
	};
	const mounted = [];
	for (const row of rows) try {
		await ctx.loader.create(row);
		mounted.push(row);
	} catch (error) {
		skipped.push(String(row.config.serverName));
		ctx.logger.warn?.(`mcp-skill-panel: 全局 MCP "${row.config.serverName}" 挂载失败: ${messageOf(error)}`);
	}
	if (mounted.length === 0) return {
		file,
		added: 0,
		skipped
	};
	await appendGlobalPatch(ctx, serversToPatchYaml(serversFromRows(mounted)));
	return {
		file,
		added: mounted.length,
		skipped
	};
}
/** 从已挂载行重建 McpServers（落盘 patch 用；避免把未挂载成功的行写进去）。 */
function serversFromRows(rows) {
	const servers = {};
	for (const row of rows) {
		const config = row.config;
		servers[config.serverName] = config;
	}
	return servers;
}
async function pathExists(path) {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}
/**
* 解析 skill 的项目根：与 dsh-skill-filesystem 的 findProjectRoot 一致 ——
* 从 cwd 向上找最近含 .git 的目录，找不到退化为 cwd 本身。
* （skill 的项目发现走这个规则，MCP 的工作空间规则是裸 cwd，两者不同。）
*/
async function resolveSkillProjectRoot(cwd) {
	let current = cwd;
	for (;;) {
		if (await pathExists(join(current, ".git"))) return current;
		const parent = parse(current).root;
		if (current === parent) return cwd;
		current = dirname(current);
	}
}
/** 添加 skill：name/description/body → <root>/skills/<name>/SKILL.md（存在即拒绝）。 */
async function addSkill(name, description, body, target, workspace) {
	if (!isValidSkillName(name)) throw new Error(`技能名 "${name}" 需为 kebab-case（小写字母/数字/连字符）`);
	if (description.trim().length === 0) throw new Error("描述不能为空");
	if (body.trim().length === 0) throw new Error("指令（正文）不能为空");
	let base;
	if (target === "global") base = join(homedir(), ".dsh", "skills");
	else {
		if (typeof workspace !== "string" || workspace.length === 0) throw new Error("project 目标需要 workspace（当前会话工作空间）");
		base = join(await resolveSkillProjectRoot(workspace), ".dsh", "skills");
	}
	const dir = join(base, name);
	if (await pathExists(dir)) throw new Error(`技能已存在：${dir}`);
	await mkdir(dir, { recursive: true });
	const file = join(dir, "SKILL.md");
	try {
		await writeFile(file, buildSkillMd(name, description, body), {
			encoding: "utf8",
			flag: "wx"
		});
	} catch (error) {
		if (error.code === "EEXIST") throw new Error(`技能已存在：${dir}`);
		throw error;
	}
	return { path: file };
}
function makeRoutes(ctx, caches, catalogRuntime, config = {}, controller, triggerSnapshot) {
	const deps = {
		ctx,
		caches,
		catalogRuntime,
		controller
	};
	const { mcpCache, skillsCache, invalidateMcp, invalidateSkills } = caches;
	const cachedMcp = (sessionId) => {
		const key = sessionId ?? "*";
		pruneExpired(mcpCache, Date.now());
		const hit = mcpCache.get(key);
		if (hit && Date.now() - hit.at < 6e4) return hit.promise;
		const promise = collectMcp(deps, sessionId).catch((error) => {
			mcpCache.delete(key);
			throw error;
		});
		mcpCache.set(key, {
			at: Date.now(),
			promise
		});
		return promise;
	};
	const cachedSkills = (sessionId) => {
		const key = sessionId ?? "*";
		pruneExpired(skillsCache, Date.now());
		const hit = skillsCache.get(key);
		if (hit && Date.now() - hit.at < 6e4) return hit.promise;
		const promise = collectSkills(deps, sessionId).catch((error) => {
			skillsCache.delete(key);
			throw error;
		});
		skillsCache.set(key, {
			at: Date.now(),
			promise
		});
		return promise;
	};
	const routes = [
		{
			kind: "exact",
			path: `${API_PREFIX}/state`,
			handler: handle("GET", async (req) => {
				const url = req.url ?? "";
				const sessionId = queryParam(url, "session");
				const part = queryParam(url, "part") ?? "all";
				if (part === "mcp") return { state: await cachedMcp(sessionId) };
				if (part === "skills") return { state: await cachedSkills(sessionId) };
				const [mcp, skills] = await Promise.all([cachedMcp(sessionId), cachedSkills(sessionId)]);
				return { state: {
					...mcp,
					...skills,
					errors: [...mcp.errors, ...skills.errors]
				} };
			})
		},
		{
			kind: "exact",
			path: `${API_PREFIX}/mcp/toggle`,
			handler: handle("POST", async (req) => {
				const parsed = JSON.parse(await readBody(req) || "{}");
				if (!parsed.entryId) throw new Error("entryId is required");
				const applyMode = stateApplyMode(await readState());
				const result = await toggleMcp(deps, parsed.entryId, Boolean(parsed.disabled), applyMode);
				invalidateMcp();
				return result;
			}, true)
		},
		{
			kind: "exact",
			path: `${API_PREFIX}/mcp/toggleBatch`,
			handler: handle("POST", async (req) => {
				const parsed = JSON.parse(await readBody(req) || "{}");
				const toggles = Array.isArray(parsed.toggles) ? parsed.toggles : [];
				if (toggles.length === 0) throw new Error("toggles array is required (non-empty)");
				const applyMode = stateApplyMode(await readState());
				const results = [];
				let failed = 0;
				for (const item of toggles) {
					if (!item?.entryId) throw new Error("entryId is required in every toggle item");
					try {
						results.push(await toggleMcp(deps, item.entryId, Boolean(item.disabled), applyMode));
					} catch (error) {
						failed += 1;
						results.push({
							entryId: item.entryId,
							ok: false,
							error: messageOf(error)
						});
					}
				}
				invalidateMcp();
				return {
					results,
					count: results.length,
					failed
				};
			}, true)
		},
		{
			kind: "exact",
			path: `${API_PREFIX}/mcp/applyPending`,
			handler: handle("POST", async () => {
				const applied = await applyPendingMcp(deps);
				invalidateMcp();
				return { applied };
			}, true)
		},
		{
			kind: "exact",
			path: `${API_PREFIX}/skill/toggle`,
			handler: handle("POST", async (req) => {
				const parsed = JSON.parse(await readBody(req) || "{}");
				if (!parsed.name) throw new Error("name is required");
				const result = await toggleSkill(deps, parsed.name, Boolean(parsed.disabled), parsed.session);
				invalidateSkills();
				return result;
			}, true)
		},
		{
			kind: "exact",
			path: `${API_PREFIX}/skill/add`,
			handler: handle("POST", async (req) => {
				const parsed = JSON.parse(await readBody(req) || "{}");
				if (typeof parsed.name !== "string" || parsed.name.trim().length === 0) throw new Error("name is required");
				if (typeof parsed.description !== "string") throw new Error("description is required");
				if (typeof parsed.body !== "string") throw new Error("body is required");
				const target = parsed.target === "project" ? "project" : "global";
				let workspace = typeof parsed.workspace === "string" && parsed.workspace.length > 0 ? parsed.workspace : void 0;
				if (!workspace) workspace = resolveAgent(ctx, void 0)?.session?.header?.cwd;
				const result = await addSkill(parsed.name, parsed.description, parsed.body, target, workspace);
				const agent = resolveAgent(ctx, void 0);
				const cwd = agent?.session?.header?.cwd;
				const deadline = Date.now() + SKILL_TOGGLE_CONFIRM_MS;
				let confirmed = false;
				let wait = 80;
				while (Date.now() < deadline) {
					if (await ctx.skills.get(parsed.name, {
						scope: agent,
						cwd
					}).catch(() => void 0)) {
						confirmed = true;
						break;
					}
					const remaining = deadline - Date.now();
					if (remaining <= 0) break;
					await ctx.timeout(Math.min(wait, remaining));
					wait = Math.min(wait * 2, 1e3);
				}
				pruneExpired(confirmedSkills, Date.now());
				if (confirmed) confirmedSkills.set(parsed.name, {
					modelInvocable: true,
					at: Date.now()
				});
				invalidateSkills();
				return {
					target,
					...result,
					confirmed
				};
			}, true)
		},
		{
			kind: "exact",
			path: `${API_PREFIX}/config`,
			handler: handleAny([{
				method: "GET",
				run: async () => {
					const state = await readState();
					return {
						autoManage: catalogRuntime.autoManage,
						applyMode: stateApplyMode(state),
						configAutoManage: config.autoManage ?? null
					};
				}
			}, {
				method: "POST",
				run: async (req) => {
					const parsed = JSON.parse(await readBody(req) || "{}");
					const state = await readState();
					state.config ??= {};
					if (typeof parsed.autoManage === "boolean") state.config.autoManage = parsed.autoManage;
					if (parsed.applyMode === "immediate" || parsed.applyMode === "next-session") state.config.applyMode = parsed.applyMode;
					await writeState(state);
					if (typeof parsed.autoManage === "boolean") catalogRuntime.applyAutoManage(parsed.autoManage);
					return {
						autoManage: catalogRuntime.autoManage,
						applyMode: stateApplyMode(state)
					};
				}
			}], true)
		},
		{
			kind: "exact",
			path: `${API_PREFIX}/token`,
			handler: handle("GET", async () => ({ token: PANEL_TOKEN }))
		},
		{
			kind: "exact",
			path: `${API_PREFIX}/debug`,
			handler: handle("GET", async () => {
				const catalog = {};
				for (const [server, info] of Object.entries(catalogRuntime.catalog)) catalog[server] = {
					tools: info.tools.length,
					fetchedAt: info.fetchedAt,
					source: info.source
				};
				return {
					diag: catalogRuntime.diag,
					catalog
				};
			})
		},
		{
			kind: "exact",
			path: `${API_PREFIX}/debug/collect`,
			handler: handle("POST", async () => {
				await triggerSnapshot();
				return { diag: catalogRuntime.diag };
			}, true)
		},
		{
			kind: "exact",
			path: `${API_PREFIX}/mcp/toolToggle`,
			handler: handle("POST", async (req) => {
				const parsed = JSON.parse(await readBody(req) || "{}");
				if (typeof parsed.serverName !== "string" || parsed.serverName.length === 0) throw new Error("serverName is required");
				if (typeof parsed.toolName !== "string" || parsed.toolName.length === 0) throw new Error("toolName is required");
				await setToolDisabled(parsed.serverName, parsed.toolName, Boolean(parsed.disabled));
				invalidateMcp();
				return {
					serverName: parsed.serverName,
					toolName: parsed.toolName,
					disabled: Boolean(parsed.disabled),
					disabledTools: [...disabledToolsOf(parsed.serverName)]
				};
			}, true)
		},
		{
			kind: "exact",
			path: `${API_PREFIX}/mcp/preview`,
			handler: handle("POST", async (req) => {
				const parsed = JSON.parse(await readBody(req) || "{}");
				if (typeof parsed.json !== "string" || parsed.json.trim().length === 0) throw new Error("json is required");
				const { servers, errors, warnings } = parseMcpServersJson(parsed.json);
				if (errors.length > 0) throw new Error(errors.join("；"));
				if (Object.keys(servers).length === 0) throw new Error("未解析出任何 MCP server");
				return {
					names: Object.keys(servers),
					yaml: serversToPatchYaml(servers),
					warnings
				};
			}, true)
		},
		{
			kind: "exact",
			path: `${API_PREFIX}/mcp/add`,
			handler: handle("POST", async (req) => {
				const parsed = JSON.parse(await readBody(req) || "{}");
				if (typeof parsed.json !== "string" || parsed.json.trim().length === 0) throw new Error("json is required");
				const target = parsed.target === "project" ? "project" : "global";
				const { servers, errors, warnings } = parseMcpServersJson(parsed.json);
				if (errors.length > 0) throw new Error(`转换失败：${errors.join("；")}`);
				if (Object.keys(servers).length === 0) throw new Error("没有可添加的 MCP server");
				if (target === "global") {
					const result = await addGlobalMcp(ctx, servers);
					if (result.added === 0) throw new Error(`全部跳过（已存在或挂载失败）：${result.skipped.join("、") || "未知原因"}`);
					invalidateMcp();
					return {
						target,
						...result,
						warnings
					};
				}
				let workspace = typeof parsed.workspace === "string" && parsed.workspace.length > 0 ? parsed.workspace : void 0;
				if (!workspace) workspace = getActiveWorkspace() ?? resolveAgent(ctx, void 0)?.session?.header?.cwd;
				if (typeof workspace !== "string" || workspace.length === 0) throw new Error("project 目标需要 workspace（当前会话工作空间）");
				const written = await writeProjectMcp(workspace, servers);
				await remountWorkspace(ctx, workspace);
				invalidateMcp();
				return {
					target: "project",
					...written,
					workspace,
					added: Object.keys(servers).length,
					warnings
				};
			}, true)
		}
	];
	return [...routes, ...routes.map((route) => ({
		...route,
		path: route.path.replace(API_PREFIX, LEGACY_API_PREFIX)
	}))];
}
//#endregion
//#region src/index.ts
/**
* dsh-mcp-skill-panel — Host 半区入口
*
* 设置页「MCP 与技能管理面板」的数据与控制面：
* - MCP 页：枚举 loader 预设子树中的 mcp-* 行 + tools.schemas(scope) 聚合工具数/token，
*   启停 = loader entry.update({disabled})（实时生效）。
* - Skill 页：skills.snapshot/get 枚举目录，启停 = SKILL.md frontmatter
*   `disable-model-invocation: true` 注入/移除（watcher 实时失效 catalog）。
*
* 本文件只保留：Config / catalog 采集 / 中间层装配 / 生命周期。数据收集与路由见
* collect.ts / routes.ts，状态持久化见 state.ts / preset.ts，控制层见 mcpcall.ts。
*
* Phase A 实测结论（2026-08-15，动态探针验证）：
* - ctx.loader.entries() 枚举全部行（含嵌套预设行，id 如 include:agent-presets:mcp-cheatengine）
* - loader.resolve() 需要完整嵌套 id；entry.update({disabled}) 实时 dispose/restart
* - 预设树（PresetTree）write() 是 no-op → loader.update 不写盘
* - tools.schemas(scope) 必须传 scopeOf(agent.ctx)（agent 对象/standingKey 会落回全局视图）
* - skill 文件经 skills.get(name, {scope, cwd}).path 定位；改 frontmatter 由
*   dsh-skill-filesystem 的 chokidar watcher 实时失效
*
* MCP 持久化（v0.1.1 修复，2026-08-15）：
* 运行期禁止写 agent.cordis.yml —— dsh-agent-presets 的 ensureStanding 用
* {mtimeMs, size} stamp 检测预设文件变化，变化时删除 standing 记录并重挂，
* 但旧 standing 的 fiber/scope 不 dispose → 旧 mcp-client 实例的 serverName
* 仍占用 → 新挂载全部 "already in use" → 会话创建/resume 失败（实测事故）。
* 持久化改为：toggle 只写插件自己的状态文件（~/.dsh/dsh-mcp-skill-panel/state.json），
* 插件 apply 时（启动早期、standing 未挂载）再物化到预设文件 —— 此时写文件安全。
*/
const name = "runtime-inventory";
const inject = [
	"fs",
	"skills",
	"tools",
	"agents",
	"agentPresets",
	"loader",
	"systemPrompt",
	"timer"
];
const Config = Schema.object({
	autoManage: Schema.boolean().description("MCP 中间层控制（停用的 MCP 经 mcp_search/mcp_call 按需调用）").default(false),
	keepAliveMs: Schema.number().min(1e3).description("MCP 保活空闲回收窗口（ms）").default(3e4),
	searchLimitDefault: Schema.number().min(1).description("mcp_search 缺省 top-K").default(5),
	searchLimitMax: Schema.number().min(1).description("mcp_search top-K 上限").default(10),
	serverSummary: Schema.dict(Schema.string()).description("MCP 能力摘要表（serverName → 一句话）")
});
/** 私有 catalog 持久化目录（与 state.ts 同目录 ~/.dsh/dsh-mcp-skill-panel）。 */
const CATALOG_DIR = join(homedir(), ".dsh", "dsh-mcp-skill-panel");
/** mcp_call 注册/调用的默认超时（读 entry config toolCallTimeoutMs，缺省回退）。 */
const DEFAULT_TOOL_TIMEOUT_MS = 6e4;
/** tools/change 后增量快照的去抖窗口。 */
const CATALOG_SNAPSHOT_DEBOUNCE_MS = 150;
/** catalog 持久化写盘防抖（P1-3）：tools/change 风暴期合并写盘。 */
const CATALOG_PERSIST_DEBOUNCE_MS = 300;
/** 从 loader entries 反查某 serverName 对应的 mcp 行（serverName 取自 config）。 */
function findMcpEntry(ctx, serverName) {
	for (const entry of ctx.loader.entries()) {
		if (!isMcpEntry(entry)) continue;
		if (serverNameOf(entry) === serverName) return entry;
	}
}
/** server 自己的注册/调用超时阈值。 */
function serverTimeoutMs(ctx, serverName) {
	const entry = findMcpEntry(ctx, serverName);
	if (!entry) return DEFAULT_TOOL_TIMEOUT_MS;
	const t = mcpEntryConfig(entry)?.toolCallTimeoutMs;
	return typeof t === "number" && Number.isFinite(t) && t > 0 ? t : DEFAULT_TOOL_TIMEOUT_MS;
}
function sameToolList(a, b) {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i += 1) if (a[i].name !== b[i].name || a[i].description !== b[i].description) return false;
	return true;
}
/** 原子写回 catalog.json；失败保留 dirty 标记以在下次重试。
* P1-3：写盘后 CATALOG_PERSIST_DEBOUNCE_MS 内的新变更延迟合并（ctx.timeout 绑 ctx，
* 卸载自动清理）；正在写盘时置 dirty 排队（finally 补一次）。 */
async function persistCatalog(next, runtime) {
	if (runtime.persisting) {
		runtime.dirty = true;
		return;
	}
	if (!runtime.dirty) return;
	const ctx = next();
	if (runtime.lastPersistAt !== null && Date.now() - runtime.lastPersistAt < CATALOG_PERSIST_DEBOUNCE_MS) {
		runtime.persistTimer?.();
		runtime.persistTimer = ctx.timeout(() => {
			runtime.persistTimer = void 0;
			persistCatalog(next, runtime);
		}, CATALOG_PERSIST_DEBOUNCE_MS);
		return;
	}
	runtime.persisting = true;
	try {
		await saveCatalog(CATALOG_DIR, runtime.catalog);
		runtime.dirty = false;
		runtime.lastPersistAt = Date.now();
	} catch (error) {
		ctx.logger.warn(`mcp-skill-panel: catalog persist failed: ${messageOf(error)}`);
	} finally {
		runtime.persisting = false;
		if (runtime.dirty) persistCatalog(next, runtime);
	}
}
/**
* 解析 scope 并取 schema 视图（preset 层共享，任一 standing 即可）。
*
* 关键坑（v0.4.1 实测）：apply ctx（bundle 插件行挂载 ctx）下 `ctx.agents` 解析到
* 空实例（realm 隔离，roots/list 均为 0）——从 apply ctx 直接 resolveAgent 永远拿不到
* agent，catalog 采集恒为空并可能空写盘覆盖 last-good。因此 agent 不可得时
* fallback 到 `agentPresets.standingKeyFor()`（注册表查询，不依赖 agent 实例）。
*/
async function resolveScopeSchemas(ctx, caches) {
	let scopeKey;
	try {
		const agent = resolveAgentLocal(ctx);
		scopeKey = agent ? scopeOf(agent.ctx) : void 0;
	} catch {
		scopeKey = void 0;
	}
	if (scopeKey === void 0) try {
		scopeKey = await ctx.agentPresets.standingKeyFor();
	} catch {
		scopeKey = void 0;
	}
	if (scopeKey === void 0) return [];
	return getSchemasView(ctx, caches, scopeKey, 500);
}
/** 本地 resolveAgent：避免 collect.ts 的依赖方向（本文件已 import collect）。 */
function resolveAgentLocal(ctx) {
	const roots = ctx.agents.roots();
	if (roots.length > 0) return roots[0];
	return ctx.agents.list()[0];
}
/** 对所有当前 enabled 的 mcp server 重新快照。 */
async function snapshotEnabled(ctx, runtime, caches) {
	runtime.diag.snapshots += 1;
	if (!runtime.loaded) {
		runtime.diag.lastAt = Date.now();
		runtime.diag.lastError = "skipped: catalog not loaded yet";
		return;
	}
	try {
		const next = { ...runtime.catalog };
		let changed = false;
		let rootsCount = 0;
		let listCount = 0;
		try {
			rootsCount = ctx.agents.roots().length;
			listCount = ctx.agents.list().length;
		} catch {
			rootsCount = -1;
			listCount = -1;
		}
		runtime.diag.lastAgentRoots = rootsCount;
		runtime.diag.lastAgentList = listCount;
		const schemas = await resolveScopeSchemas(ctx, caches);
		runtime.diag.lastSchemasTotal = schemas.length;
		let mcpTools = 0;
		for (const schema of schemas) if (String(schema.name ?? "").startsWith("mcp__")) mcpTools += 1;
		runtime.diag.lastMcpTools = mcpTools;
		runtime.diag.lastScope = mcpTools > 0;
		for (const entry of ctx.loader.entries()) {
			if (!isMcpEntry(entry)) continue;
			if (entry.disabled) continue;
			const serverName = serverNameOf(entry);
			let tools;
			try {
				tools = snapshotFromSchemas(schemas, serverName);
			} catch {
				continue;
			}
			const prev = next[serverName];
			if (prev && prev.source === "live" && sameToolList(prev.tools, tools)) continue;
			if (tools.length === 0) continue;
			next[serverName] = {
				tools,
				fetchedAt: Date.now(),
				source: "live"
			};
			changed = true;
		}
		const alive = /* @__PURE__ */ new Set();
		for (const entry of ctx.loader.entries()) {
			if (!isMcpEntry(entry)) continue;
			alive.add(serverNameOf(entry));
		}
		if (alive.size > 0) {
			for (const key of Object.keys(next)) if (!alive.has(key)) {
				delete next[key];
				changed = true;
			}
		}
		runtime.catalog = next;
		if (changed) {
			runtime.dirty = true;
			persistCatalog(() => ctx, runtime);
		}
		runtime.diag.lastAt = Date.now();
		runtime.diag.lastError = null;
	} catch (error) {
		runtime.diag.lastError = messageOf(error);
		runtime.diag.lastAt = Date.now();
	}
}
/** 构建控制层依赖（McpControlCtx）：封闭 catalog/loader/state 的 IO。 */
function buildMcpControl(ctx, runtime, config, caches) {
	return {
		keepAliveMs: config.keepAliveMs ?? 3e4,
		searchLimitDefault: config.searchLimitDefault ?? 5,
		searchLimitMax: config.searchLimitMax ?? 10,
		serverSummary: config.serverSummary ?? {},
		getCatalog: () => runtime.catalog,
		setCatalog: (catalog) => {
			runtime.catalog = catalog;
		},
		persistCatalog: () => persistCatalog(() => ctx, runtime),
		resolveEntry: (serverName) => findMcpEntry(ctx, serverName),
		serverTimeoutMs: (serverName) => serverTimeoutMs(ctx, serverName),
		setAiOwner: (entryId, at) => setStateAiOwner(entryId, at),
		clearAiOwner: (entryId) => clearStateAiOwner(entryId),
		snapshotEnabled: () => snapshotEnabled(ctx, runtime, caches)
	};
}
function apply(ctx, config = {}) {
	loadDisabledTools().catch((error) => {
		ctx.logger.warn(`mcp-skill-panel: 加载工具级禁用表失败: ${messageOf(error)}`);
	});
	rebuildOwnersFromState(ctx).catch((error) => {
		ctx.logger.warn(`mcp-skill-panel: 重建项目 MCP owner 映射失败: ${messageOf(error)}`);
	});
	syncPresetFiles(ctx).then((count) => {
		if (count > 0) ctx.logger.info(`runtime-inventory: materialized ${count} MCP row state(s) into preset composition`);
	}, (error) => {
		ctx.logger.warn(`runtime-inventory: preset sync skipped: ${messageOf(error)}`);
	});
	const catalogRuntime = {
		catalog: {},
		dirty: false,
		persisting: false,
		loaded: false,
		autoManage: false,
		applyAutoManage: () => {},
		lastPersistAt: null,
		persistTimer: void 0,
		tokenCache: /* @__PURE__ */ new Map(),
		diag: {
			toolsChangeEvents: 0,
			snapshots: 0,
			lastError: null,
			lastAt: null,
			lastMcpTools: null,
			lastSchemasTotal: null,
			lastScope: null,
			lastAgentRoots: null,
			lastAgentList: null,
			loadedAt: null,
			loadedServers: null
		}
	};
	loadCatalog(CATALOG_DIR).then((catalog) => {
		catalogRuntime.catalog = catalog;
		catalogRuntime.loaded = true;
		catalogRuntime.diag.loadedAt = Date.now();
		catalogRuntime.diag.loadedServers = Object.keys(catalog).length;
	}, () => {
		catalogRuntime.catalog = {};
		catalogRuntime.loaded = true;
		catalogRuntime.diag.loadedAt = Date.now();
		catalogRuntime.diag.loadedServers = 0;
	});
	const caches = createDomainCaches();
	ctx.effect(() => {
		const offTools = ctx.root.on("tools/change", caches.invalidateMcp);
		const offLoader = ctx.root.on("loader/partial-dispose", caches.invalidateMcp);
		const offSkills = ctx.root.on("skills/change", caches.invalidateSkills);
		return () => {
			offTools();
			offLoader();
			offSkills();
		};
	}, "runtime-inventory: cache invalidation");
	ctx.effect(() => {
		let scheduled = false;
		return ctx.root.on("tools/change", () => {
			catalogRuntime.diag.toolsChangeEvents += 1;
			if (scheduled) return;
			scheduled = true;
			ctx.timeout(() => {
				scheduled = false;
				snapshotEnabled(ctx, catalogRuntime, caches);
			}, CATALOG_SNAPSHOT_DEBOUNCE_MS);
		});
	}, "mcp-skill-panel: catalog snapshot");
	snapshotEnabled(ctx, catalogRuntime, caches).catch(() => {});
	const disposeProjectMcp = installProjectMcp(ctx);
	ctx.effect(() => () => disposeProjectMcp(), "mcp-skill-panel: project mcp teardown");
	const disposeToolFilter = installToolDisableFilter(ctx);
	ctx.effect(() => () => disposeToolFilter(), "mcp-skill-panel: tool disable teardown");
	const control = buildMcpControl(ctx, catalogRuntime, config, caches);
	const controller = createMcpCallController(ctx, control);
	const buildVisibility = () => {
		const map = /* @__PURE__ */ new Map();
		for (const entry of ctx.loader.entries()) {
			if (!isMcpEntry(entry)) continue;
			const serverName = serverNameOf(entry);
			map.set(serverName, !entry.disabled && !controller.isAiEnabled(serverName));
		}
		return map;
	};
	let autoDisposers = [];
	catalogRuntime.applyAutoManage = (on) => {
		for (const d of autoDisposers) d();
		autoDisposers = [];
		catalogRuntime.autoManage = on;
		if (!on) return;
		const disposers = [];
		try {
			disposers.push(installMcpVisibilityFilter(ctx, buildVisibility));
			disposers.push(installMcpControlTools(ctx, control, controller));
			const offReaper = controller.startIdleReaper();
			disposers.push(() => offReaper());
		} catch (error) {
			for (const d of disposers) d();
			catalogRuntime.autoManage = false;
			ctx.logger.warn(`mcp-skill-panel: autoManage enable failed: ${messageOf(error)}`);
			return;
		}
		autoDisposers = disposers;
	};
	ctx.effect(() => () => {
		for (const d of autoDisposers) d();
	}, "mcp-skill-panel: autoManage teardown");
	catalogRuntime.applyAutoManage(Boolean(config.autoManage));
	readState().then((state) => {
		if (typeof state.config?.autoManage === "boolean" && state.config.autoManage !== Boolean(config.autoManage)) {
			catalogRuntime.applyAutoManage(state.config.autoManage);
			ctx.logger.info(`mcp-skill-panel: autoManage = ${state.config.autoManage} (from panel state)`);
		}
	});
	ctx.effect(() => {
		let guard = false;
		return ctx.root.on("agent/session-start", () => {
			if (guard) return;
			guard = true;
			applyPendingMcp({
				ctx,
				controller
			}).then((count) => {
				if (count > 0) {
					caches.invalidateMcp();
					ctx.logger.info(`runtime-inventory: applied ${count} pending MCP change(s) at session boundary`);
				}
			}).catch((error) => {
				ctx.logger.warn(`runtime-inventory: session-boundary apply failed: ${messageOf(error)}`);
			}).finally(() => {
				guard = false;
			});
		});
	}, "runtime-inventory: session-boundary apply");
	ctx.inject(["webServer"], (httpCtx) => {
		httpCtx.effect(() => {
			const disposers = makeRoutes(httpCtx, caches, catalogRuntime, config, controller, () => snapshotEnabled(httpCtx, catalogRuntime, caches)).map((route) => httpCtx.webServer.register(route));
			return () => {
				for (const dispose of disposers) dispose();
			};
		}, "runtime-inventory: routes");
	});
}
//#endregion
export { Config, apply, applyPendingMcp, buildSkillMd, disabledToolsOf, inject, installProjectMcp, isToolDisabled, isValidSkillName, loadDisabledTools, msgOf, name, normalizeArguments, normalizeToolName, pendingMcp, pendingMcpCount, projectServerName, projectServerOwner, readState, remountWorkspace, rowDisabledState, scanWorkspaceMcp, setRowFlag, setSkillFlag, setToolDisabled, syncPresetFiles, writeState };
