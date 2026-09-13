import { n as readState, o as writeState } from "./state-Bo1YB6hJ.mjs";
import { a as serversToRows, n as parseMcpServersJson, r as resolveServersEnv } from "./mcp-convert-QL_5hLe8.mjs";
import { i as serverNameOf, t as isMcpEntry } from "./mcp-entry-Be8hx6aP.mjs";
import { join } from "node:path";
import { access, readFile, readdir, stat } from "node:fs/promises";
import { watch } from "node:fs";
//#region src/catalog.ts
/** 从完整 tool name 解析 server 段（与 src/index.ts serverOf 一致）。 */
function serverOfMcp(name) {
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
* 关键词全文检索 top-K（P3 网关定稿：加权 B）。
* 打分（bench `.scratch/mvt-5-search-bench.mjs` 实测定稿，加权 B）：
* 工具裸名 substring 15 / server 名 substring 3 / 描述 substring 6 /
* 参数名命中 3 / 公名 haystack（server/bare 拼接）substring 兜底 +1。
* substring 而非 token 精确命中：中文连写（“读文件”）不切分也能命中。
* 返回按分数降序（同分按 server、name 字典序稳定）的命中数组。
*/
function searchCatalog(catalog, query, limit = 8, scopedTo) {
	const terms = String(query).toLowerCase().split(/[\s,，。、/\\|]+/).filter(Boolean);
	if (terms.length === 0) return [];
	const pool = scopedTo !== void 0 ? Object.entries(catalog).filter(([s]) => s === scopedTo) : Object.entries(catalog);
	const scored = [];
	for (const [server, serverInfo] of pool) for (const tool of serverInfo.tools) {
		const bare = tool.name.split("__").pop() ?? tool.name;
		const nameHay = `${server}/${bare}`.toLowerCase();
		const descHay = String(tool.description ?? "").toLowerCase();
		const paramHay = [...paramNamesOf(tool.parameters)].join(" ");
		const serverHay = String(server).toLowerCase();
		let score = 0;
		for (const term of terms) {
			if (bare.toLowerCase().includes(term)) score += 15;
			if (serverHay.includes(term)) score += 3;
			if (descHay.includes(term)) score += 6;
			if (paramHay.includes(term)) score += 3;
			if (nameHay.includes(term)) score += 1;
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
function listServer(catalog, server, offset = 0, limit = 20) {
	const start = Math.max(0, Math.floor(Number(offset) || 0));
	const size = Math.min(200, Math.max(1, Math.floor(Number(limit) || 20)));
	const serverInfo = catalog[server];
	if (!serverInfo) return {
		found: false,
		hasSnapshot: false,
		tools: [],
		totalCount: 0,
		fetchedAt: null,
		source: null
	};
	const totalCount = serverInfo.tools.length;
	return {
		found: true,
		hasSnapshot: true,
		tools: serverInfo.tools.slice(start, start + size).map((tool) => ({
			name: tool.name,
			description: tool.description
		})),
		totalCount,
		fetchedAt: serverInfo.fetchedAt ?? null,
		source: serverInfo.source ?? null
	};
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
					const server = serverOfMcp(name);
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
	const server = serverOfMcp(fullName);
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
export { searchCatalog as _, setToolDisabled as a, projectServerName as c, remountWorkspace as d, scanWorkspaceMcp as f, saveCatalog as g, loadCatalog as h, loadDisabledTools as i, projectServerOwner as l, listServer as m, installToolDisableFilter as n, getActiveWorkspace as o, messageOf as p, isToolDisabled as r, installProjectMcp as s, disabledToolsOf as t, rebuildOwnersFromState as u, serverOfMcp as v, snapshotFromSchemas as y };
