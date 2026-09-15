import { t as __exportAll } from "./rolldown-runtime-D7D4PA-g.mjs";
import { l as writeState, n as readState } from "./state-CGTco4Zg.mjs";
import { a as serversToRows, n as parseMcpServersJson, r as resolveServersEnv } from "./mcp-convert-QL_5hLe8.mjs";
import { i as serverNameOf, t as isMcpEntry } from "./mcp-entry-Be8hx6aP.mjs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { defineTool } from "@deepseek-ai/dsh-tools";
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
/**
* 解析 `/mcp/toolBulk` 的 `toolNames` **三态**契约（纯函数，无 IO，可直测）。
*
* - `undefined`（字段缺失）= 该 server 面板视图里的**全部**工具 —— 只有这一种写法表示全部；
* - 显式数组 = 精确集合：`[]` 是合法空操作（targets 为空，调用方据此跳过写盘）；
*   非空则与 known 求交，**一条都不匹配即拒绝**（否则「以为批量禁用了，实际一条没动」）；
* - 其它类型（字符串 / 数字 / 对象 / null / 含非字符串项的数组）= 拒绝：契约是工具全名数组，
*   静默降级成「全部」会把一次客户端 bug 变成该 server 的全量持久化写入。
*
* 2026-09-16 修复（审查 BLOCK-1）：此前「非空数组 ? 交集 : 全部」，显式 `[]` 与任何非数组
* 都落进「全部」——面板「按当前过滤」在过滤命中 0 项时天然发 `[]`，对 450 工具的 server
* 就是一次性全量禁用，与用户意图相反且已写盘。
* @param known - 该 server 当前已知的工具全名（调用方视图，顺序保留）。
* @param toolNames - 客户端原始入参（未收窄，故为 unknown）。
* @returns 精确名单 + 未识别名单，或拒绝原因（调用方转 400）。
*/
function resolveToolBulkTargets(known, toolNames) {
	const knownSet = new Set(known);
	if (toolNames === void 0) return {
		targets: [...known],
		ignored: []
	};
	if (!Array.isArray(toolNames)) return { error: "toolNames must be an array of tool full names" };
	const nonString = toolNames.findIndex((name) => typeof name !== "string");
	if (nonString >= 0) return { error: `toolNames must be an array of tool full names (item ${nonString} is not a string)` };
	const names = [...new Set(toolNames)];
	const nameSet = new Set(names);
	const targets = known.filter((name) => nameSet.has(name));
	const ignored = names.filter((name) => !knownSet.has(name));
	if (names.length > 0 && targets.length === 0) return { error: `toolNames matches none of the ${known.length} known tools on this server (bare names or a stale list?)` };
	return {
		targets,
		ignored
	};
}
/**
* 批量切换某 server 上一组工具的禁用状态（面板「全部禁用 / 全部启用 / 按过滤」）。
*
* 与逐个调用 {@link setToolDisabled} 的区别只在 IO：这里对 state.json 只做
* **一次** 读-改-写。prompthelper 这种 450 工具的 server 逐个写会是 450 次
* 合并写盘 + 450 次面板失效，实际不可用。
*
* 语义与单个开关完全一致（同一张表、同一套项目/全局作用域分派），所以批量与
* 单点操作可以任意交替，不存在「批量模式」这种隐藏状态。
* @param serverName - 目标 MCP server。
* @param toolNames - 工具全名（mcp__<server>__<tool>）列表；非本 server 的条目忽略。
* @param disabled - true=禁用这批，false=启用这批。
* @param persist - false 时只改内存不落盘（selftest）。
* @returns 实际发生变化的工具数。
*/
async function setToolsDisabledBulk(serverName, toolNames, disabled, persist = true) {
	const prefix = `mcp__${serverName}__`;
	const names = [...new Set(toolNames.filter((name) => typeof name === "string" && name.startsWith(prefix)))];
	if (names.length === 0) return 0;
	const owner = projectServerOwner(serverName);
	const before = disabledToolsOf(serverName, owner).size;
	if (owner !== void 0) {
		let perServer = projectDisabledTools.get(owner);
		if (disabled && !perServer) {
			perServer = /* @__PURE__ */ new Map();
			projectDisabledTools.set(owner, perServer);
		}
		if (perServer) {
			for (const name of names) toggleInSet(perServer, serverName, name, disabled);
			if (perServer.size === 0) projectDisabledTools.delete(owner);
		}
		if (persist) {
			const state = await readState();
			state.projectToolDisabled ??= {};
			const serverMap = state.projectToolDisabled[owner] ??= {};
			for (const name of names) toggleInList(serverMap, serverName, name, disabled);
			if (Object.keys(serverMap).length === 0) delete state.projectToolDisabled[owner];
			await writeState(state);
		}
	} else {
		for (const name of names) toggleInSet(disabledTools, serverName, name, disabled);
		if (persist) {
			const state = await readState();
			state.toolDisabled ??= {};
			for (const name of names) toggleInList(state.toolDisabled, serverName, name, disabled);
			await writeState(state);
		}
	}
	return Math.abs(disabledToolsOf(serverName, owner).size - before);
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
var mcpcall_exports = /* @__PURE__ */ __exportAll({
	CONTROL_TOOL_NAMES: () => CONTROL_TOOL_NAMES,
	MCP_CALL_TOOL: () => MCP_CALL_TOOL,
	MCP_SEARCH_TOOL: () => MCP_SEARCH_TOOL,
	buildSummaryHeader: () => buildSummaryHeader,
	controllerCounters: () => controllerCounters,
	createMcpCallController: () => createMcpCallController,
	gatewayCall: () => gatewayCall,
	installMcpControlTools: () => installMcpControlTools,
	inventoryTraceDiag: () => inventoryTraceDiag,
	msgOf: () => msgOf,
	normalizeArguments: () => normalizeArguments,
	normalizeToolName: () => normalizeToolName,
	reaperDiagnostics: () => reaperDiagnostics
});
/** 空闲回收器扫描周期（ms）。 */
const REAPER_INTERVAL_MS = 1e4;
/** waitRegistered 轮询间隔（ms）。 */
const REGISTER_POLL_MS = 50;
/**
* 中间层两个模型工具的注册名。
*
* 命名前缀铁律（2026-09-15，claude 400 取证）：**不得以 `mcp_` 开头**。
* 实测 claude.ai 订阅网关把 `mcp_` 前缀的工具名当作 MCP connector 保留名，
* 整个请求被拒为 HTTP 400 `invalid_request_error`，且错误文案被改写成
* 「You're out of extra usage」（与配额无关，极具误导性）。
* 证据：同一会话 16 秒内 486 工具（含本组）→400、484 工具（不含）→正常、
* 486 →400；32 工具的最小集同样复现，与工具数量/体积无关。
* 全部 session 统计：含本组 0/5 成功，不含本组 111/111 成功。
*/
const MCP_SEARCH_TOOL = "dsh_mcp_search";
const MCP_CALL_TOOL = "dsh_mcp_call";
/** 两个控制工具的名字集合（装配过滤按模型路由决定是否投放）。 */
const CONTROL_TOOL_NAMES = /* @__PURE__ */ new Set([MCP_SEARCH_TOOL, MCP_CALL_TOOL]);
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
		if (name.startsWith("mcp__")) throw new Error(`${MCP_CALL_TOOL}: tool 参数疑似其他 MCP server 的注册全名（${JSON.stringify(toolName)}，server="${serverName}"）；请传该 server 上的裸名（如 understand_image，不带 mcp__ 前缀）`);
	}
	return name;
}
/**
* 归一化 mcp_call 的 arguments 参数（2026-08-24 修补；2026-09-16 注释修正，审查 WARN-4）：
* 起因是 `type:'json'` 参数的编译产物不带 type 标注，模型直连 Tool call 时倾向把参数字典
* 填成 JSON 字符串（实测 flash 与 mimo 两系均会出现）。**该起因已消失**：参数自 2026-09-16
* （0f4794a）起改 `type:'object' + additionalProperties`，字符串在进 execute 前即被参数校验拒绝，
* 模型路径到不了这里 —— 本函数现在只服务**直调/内部路径**（gatewayCall 等）的兜底。
* 这里循环安全解析为对象后再透传：
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
		counters().wakeAdded += 1;
		await entry.update({ disabled: false });
		state.aiEnabled.add(serverName);
		await control.setAiOwner(entryId, Date.now());
		ctx.logger.info?.(`mcp-skill-panel: AI enabled MCP server "${serverName}"`);
	} else counters().wakeSkippedAlreadyEnabled += 1;
	return wasDisabled;
}
/**
* 0.6.0：按需采集某个「已安装但没有快照」server 的能力表。
*
* 使用场景：用户在面板关掉了某个 MCP，它从未运行过 → catalog 里没有它 →
* `mcp_search(server=X)` 原本只能回 `found:false`（P1 实验失败的现场）。
* 这里把它**临时拉起**（复用 `ensureEnabled`：真连接、真注册工具、登记 AI 归属）、
* 等工具注册后采一次 schema 快照写进 catalog，再**显式放回关闭**
* （不等回收器：搜索结果返回时它就该回到用户设定的状态）。
*
* 失败缓存（TTL 5 分钟）：server 起不来时避免模型每次搜索都卡满超时。
* 返回 null 表示"没采到"（未挂载 / 无工具 / 失败），调用方按无快照文案回。
*/
const INVENTORY_FAIL_TTL_MS = 3e5;
const inventoryFailUntil = /* @__PURE__ */ new Map();
const inventoryTrace = /* @__PURE__ */ new Map();
function inventoryTraceDiag() {
	const out = {};
	for (const [server, row] of inventoryTrace) out[server] = {
		...row,
		agoMs: Date.now() - row.at
	};
	return out;
}
async function collectInventory(ctx, caches, state, serverName, requestedBy = "unknown", waitMs) {
	const t0 = Date.now();
	const trace = {
		at: t0,
		requestedBy,
		stage: "start",
		ms: 0,
		entryFound: null,
		wasDisabled: null,
		wakeAdded: null,
		viewLabel: null,
		viewScope: null,
		schemaTotal: null,
		schemaMatched: null,
		stored: null,
		error: null
	};
	inventoryTrace.set(serverName, trace);
	const mark = (stage) => {
		trace.stage = stage;
		trace.ms = Date.now() - t0;
	};
	const stop = (stage, error) => {
		mark(stage);
		trace.error = error;
		return null;
	};
	const until = inventoryFailUntil.get(serverName) ?? 0;
	if (Date.now() < until) return stop("skip:failCache", `retry after ${Math.ceil((until - Date.now()) / 1e3)}s`);
	const entry = caches.resolveEntry(serverName);
	trace.entryFound = entry !== void 0;
	if (!entry) return stop("resolveEntry:none", "no entry for server");
	const wasDisabled = entry.disabled === true;
	trace.wasDisabled = wasDisabled;
	const entryId = String(entry.id);
	let aiOwned = false;
	try {
		aiOwned = await ensureEnabled(caches, ctx, state, serverName, entry);
		trace.wakeAdded = aiOwned;
		mark("ensureEnabled");
	} catch (error) {
		inventoryFailUntil.set(serverName, Date.now() + INVENTORY_FAIL_TTL_MS);
		ctx.logger.warn?.(`mcp-skill-panel: inventory fetch enable "${serverName}" failed: ${msgOf(error)}`);
		return stop("ensureEnabled:ERR", msgOf(error));
	}
	state.refCounts.set(serverName, (state.refCounts.get(serverName) ?? 0) + 1);
	state.lastUsed.set(serverName, Date.now());
	let out = null;
	try {
		mark("ensureEnabled → 等待 catalog 出现该 server（由 snapshotEnabled 采集）");
		const deadline = Date.now() + (waitMs !== void 0 && waitMs > 0 ? waitMs : caches.serverTimeoutMs(serverName));
		let waited = 0;
		for (;;) {
			await ctx.timeout(600);
			const snap = caches.getCatalog()[serverName];
			if (snap && snap.tools.length > 0) {
				out = {
					tools: snap.tools.length,
					joined: false
				};
				trace.stored = out.tools;
				break;
			}
			if (Date.now() >= deadline || waited > 80) break;
			await caches.requestSnapshot?.();
			waited += 1;
		}
		mark(`catalogWait(n=${out?.tools ?? 0}, polls=${waited})`);
		if (!out) {
			inventoryFailUntil.set(serverName, Date.now() + INVENTORY_FAIL_TTL_MS);
			stop("timeout", `catalog 未在 ${Date.now() - t0}ms 内出现 "${serverName}"（snapshotEnabled 未采到）`);
		}
	} catch (error) {
		inventoryFailUntil.set(serverName, Date.now() + INVENTORY_FAIL_TTL_MS);
		ctx.logger.warn?.(`mcp-skill-panel: inventory fetch "${serverName}" failed: ${msgOf(error)}`);
		stop("collect:ERR", msgOf(error));
	} finally {
		mark("done");
		const next = (state.refCounts.get(serverName) ?? 1) - 1;
		if (next <= 0) state.refCounts.delete(serverName);
		else state.refCounts.set(serverName, next);
		if (wasDisabled && aiOwned && next <= 0) try {
			const cur = caches.resolveEntry(serverName);
			if (cur && cur.id === entryId && !cur.disabled) await cur.update({ disabled: true });
			await caches.clearAiOwner(entryId).catch(() => void 0);
		} catch (error) {
			ctx.logger.warn?.(`mcp-skill-panel: inventory fetch restore "${serverName}" failed: ${msgOf(error)}`);
		} finally {
			state.aiEnabled.delete(serverName);
			state.refCounts.delete(serverName);
			state.lastUsed.delete(serverName);
		}
	}
	return out;
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
					const schemasOf = view.tools;
					if (name.endsWith("__") ? (schemasOf.schemas?.(view.scope) ?? []).some((s) => String(s?.name ?? "").startsWith(name)) : Boolean(view.tools.get(name, view.scope))) {
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
/**
* 预设行直通执行（0.5.6）：已启用 standing 行的工具已在 tools 注册表 scope 层
* （mcp-client 注册），无需 ensureEnabled。引用计数/lastUsed 照常记（回收器
* startIdleReaper 经 resolveEntry 找不到预设行 entry 时仅清内存态，不碰运行时，
* 见 mcpcall.ts:394-400 无 entry 分支）。失败不 restore（无 Entry 可恢复；
* 预设行开关走面板 state.json 意图，不由单次调用翻转）。
*/
async function callViaPresetViews(ctx, control, state, serverName, bareTool, name, args, agent, signal, explicitTimeoutMs) {
	const timeoutMs = explicitTimeoutMs ?? control.serverTimeoutMs(serverName);
	state.refCounts.set(serverName, (state.refCounts.get(serverName) ?? 0) + 1);
	state.lastUsed.set(serverName, Date.now());
	try {
		const result = await (await waitRegistered(ctx, name, collectToolViews(ctx, agent), timeoutMs, signal)).tools.execute({
			callId: `mcp-call-${randomUUID()}`,
			name,
			arguments: args,
			agent,
			signal
		});
		state.lastUsed.set(serverName, Date.now());
		if (result && result.isError) return `MCP ${serverName}.${bareTool} 调用失败：${msgOf(result.error ?? "unknown error")}`;
		const text = contentText(result ? result.content : void 0);
		return text.length > 0 ? text : `MCP ${serverName}.${bareTool} 无返回内容`;
	} catch (error) {
		return `MCP ${serverName}.${bareTool} 调用异常：${msgOf(error)}（提示：tool 参数应传该 server 上的裸名；server/tool 是否存在可先 ${MCP_SEARCH_TOOL} 确认）`;
	} finally {
		const next = (state.refCounts.get(serverName) ?? 1) - 1;
		if (next <= 0) state.refCounts.delete(serverName);
		else state.refCounts.set(serverName, next);
	}
}
async function gatewayCall(ctx, control, state, serverName, bareIn, args, opts) {
	const bareTool = normalizeToolName(serverName, bareIn);
	const name = `mcp__${serverName}__${bareTool}`;
	const normArgs = normalizeArguments(args);
	if (isToolDisabled(name, typeof opts.agent?.session?.header?.cwd === "string" ? opts.agent.session.header.cwd : void 0)) throw new Error(`MCP 工具 ${serverName}.${bareTool} 已被禁用（请在 MCP 管理面板打开该工具后再调用）`);
	const entry = control.resolveEntry(serverName);
	if (entry) return callViaLoaderEntry(ctx, control, state, serverName, bareTool, name, normArgs, opts, entry);
	const presetRow = control.resolvePresetRow ? await control.resolvePresetRow(serverName, opts.agent).catch(() => void 0) : void 0;
	if (!presetRow) throw new Error(`未知 MCP server：${serverName}（不在 loader 中）`);
	if (presetRow.disabled) throw new Error(`MCP server "${serverName}" 当前已停用（预设行 ${presetRow.rowId}），请在 MCP 管理面板打开后（新会话生效）再调用`);
	const timeoutMs = opts.explicitTimeoutMs ?? presetRow.toolCallTimeoutMs ?? control.serverTimeoutMs(serverName);
	state.refCounts.set(serverName, (state.refCounts.get(serverName) ?? 0) + 1);
	state.lastUsed.set(serverName, Date.now());
	try {
		const view = await waitRegistered(ctx, name, collectToolViews(ctx, opts.agent), timeoutMs, opts.signal);
		if (opts.signal.aborted) throw opts.signal.reason ?? /* @__PURE__ */ new Error("aborted");
		const result = await view.tools.execute({
			callId: `mcp-call-${randomUUID()}`,
			name,
			arguments: normArgs,
			agent: opts.agent,
			signal: opts.signal
		});
		state.lastUsed.set(serverName, Date.now());
		if (result && result.isError) {
			const failure = /* @__PURE__ */ new Error(`MCP ${serverName}.${bareTool} 调用失败：${msgOf(result.error ?? "unknown error")}`);
			failure.cause = result;
			throw failure;
		}
		const text = contentText(result ? result.content : void 0);
		if (text.length === 0) throw new Error(`MCP ${serverName}.${bareTool} 无返回内容`);
		return text;
	} finally {
		const next = (state.refCounts.get(serverName) ?? 1) - 1;
		if (next <= 0) state.refCounts.delete(serverName);
		else state.refCounts.set(serverName, next);
	}
}
/**
* B1（P5）：loader 常驻行执行分支（项目行/global 行/网关 gw- 行）。
* 与 call() 的 loader 分支同语义但错误走 throw：ensureEnabled 开启→执行→
* 失败且本次 AI 启用且无并发则 restore。超时=loader 行 toolCallTimeoutMs。
*/
async function callViaLoaderEntry(ctx, control, state, serverName, bareTool, name, normArgs, opts, entry) {
	const entryId = entry.id;
	const timeoutMs = opts.explicitTimeoutMs ?? control.serverTimeoutMs(serverName);
	let aiOwned = false;
	try {
		aiOwned = await ensureEnabledGateway(control, ctx, state, serverName, entry);
	} catch (error) {
		throw new Error(`启用 MCP server "${serverName}" 失败：${msgOf(error)}`);
	}
	state.refCounts.set(serverName, (state.refCounts.get(serverName) ?? 0) + 1);
	state.lastUsed.set(serverName, Date.now());
	let failed = false;
	try {
		const view = await waitRegistered(ctx, name, collectToolViews(ctx, opts.agent), timeoutMs, opts.signal);
		if (opts.signal.aborted) throw opts.signal.reason ?? /* @__PURE__ */ new Error("aborted");
		const result = await view.tools.execute({
			callId: `mcp-call-${randomUUID()}`,
			name,
			arguments: normArgs,
			agent: opts.agent,
			signal: opts.signal
		});
		state.lastUsed.set(serverName, Date.now());
		if (result && result.isError) {
			failed = true;
			const failure = /* @__PURE__ */ new Error(`MCP ${serverName}.${bareTool} 调用失败：${msgOf(result.error ?? "unknown error")}`);
			failure.cause = result;
			throw failure;
		}
		const text = contentText(result ? result.content : void 0);
		if (text.length === 0) {
			failed = true;
			throw new Error(`MCP ${serverName}.${bareTool} 无返回内容`);
		}
		return text;
	} catch (error) {
		failed = true;
		throw error;
	} finally {
		const next = (state.refCounts.get(serverName) ?? 1) - 1;
		if (next <= 0) state.refCounts.delete(serverName);
		else state.refCounts.set(serverName, next);
		if (failed && aiOwned && next <= 0) restoreGateway(control, ctx, state, serverName, entryId);
	}
}
/**
* gateway 透传分支的 ensureEnabled（0.5.9 修正）。
*
* 历史 bug（0.5.7/0.5.8 实测现场）：本函数原样**不碰 `state.aiEnabled`**，注释理由是
* 「网关行用户语义恒用户打开」。但 0.5.6 起 `mcp_call` 已改道 gateway 透传
* （见 registerMcpCallTool），于是 preset 行被 AI 拉起的每一次调用都落在这里 →
* 「行被真拉起、工具真执行」与「回收器集合永远为空、永不回收」同时成立。
* 实测指纹：`mcp_call` 未知 server 返回 `MCP 调用异常：未知 MCP server：…（不在 loader 中）`
* ——带 `MCP 调用异常：` 前缀即证明走的是 gatewayCall（`call()` 分支无此前缀），
* 而此时 `controller.status().aiOwned` 为空、回收器 `candidates` 为空。
*
* 现在统一到 `state.aiEnabled`：AI 借用的行用完即关；失败走 restoreGateway 立即回关。
* 用户自己打开的行不会进集合（见 markUserEnabled），语义不变。
*/
async function ensureEnabledGateway(control, ctx, state, serverName, entry) {
	if (!entry.disabled) {
		counters().wakeSkippedAlreadyEnabled += 1;
		return false;
	}
	counters().wakeAdded += 1;
	await entry.update({ disabled: false });
	state.aiEnabled.add(serverName);
	await control.setAiOwner(entry.id, Date.now()).catch(() => void 0);
	ctx.logger.info?.(`mcp-skill-panel: gateway enabled MCP server "${serverName}"`);
	return true;
}
/**
* gateway 分支的失败恢复（best-effort；失败即回关，不留半开）。
* 0.5.9：同时清 `state.aiEnabled`/refCounts/lastUsed —— 否则回关后回收器下一轮
* 仍把这个 server 当候选，`idleMs` 因 lastUsed 已被删而变成 `now-0` 的巨值，
* 每轮白扫一次（无害但噪声）。调用方保证此时 refCount 已归零。
*/
async function restoreGateway(control, ctx, state, serverName, entryId) {
	if (!state.aiEnabled.has(serverName)) {
		state.refCounts.delete(serverName);
		state.lastUsed.delete(serverName);
		return;
	}
	try {
		const entry = control.resolveEntry(serverName);
		if (entry && entry.id === entryId && !entry.disabled) await entry.update({ disabled: true });
		await control.clearAiOwner(entryId).catch(() => void 0);
	} catch (error) {
		ctx.logger.warn?.(`mcp-skill-panel: gateway restore disabled for "${serverName}" failed: ${msgOf(error)}`);
	} finally {
		state.aiEnabled.delete(serverName);
		state.refCounts.delete(serverName);
		state.lastUsed.delete(serverName);
	}
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
let reaperDiag = {
	rounds: 0,
	lastRound: null,
	everDisabled: []
};
const COUNTER_KEY = "__dshMcpPanelControllerCounters__";
function counters() {
	const g = globalThis;
	let c = g[COUNTER_KEY];
	if (!c) {
		c = {
			controllers: 0,
			callResolvedEntry: 0,
			callNoEntry: 0,
			callPresetBranch: 0,
			wakeAdded: 0,
			wakeSkippedAlreadyEnabled: 0,
			clearedByUser: 0,
			reaped: 0,
			reaperDroppedNoEntry: 0
		};
		g[COUNTER_KEY] = c;
	}
	return c;
}
/** /debug 用：分支决策计数快照。 */
function controllerCounters() {
	return { ...counters() };
}
/** 供 /debug 读取（每次刷新 agoMs，不参与逻辑判断）。 */
function reaperDiagnostics() {
	return {
		rounds: reaperDiag.rounds,
		lastRound: reaperDiag.lastRound,
		everDisabled: [...reaperDiag.everDisabled],
		agoMs: reaperDiag.lastRound ? Date.now() - reaperDiag.lastRound.at : null
	};
}
function startIdleReaper(control, ctx, state) {
	return ctx.interval(() => {
		const now = Date.now();
		const keepAliveMs = control.keepAliveMs;
		const decisions = [];
		for (const server of [...state.aiEnabled]) {
			const refCount = state.refCounts.get(server) ?? 0;
			const last = state.lastUsed.get(server) ?? 0;
			if (refCount > 0) {
				decisions.push({
					server,
					refCount,
					idleMs: now - last,
					action: "skip:refCount"
				});
				continue;
			}
			if (now - last < keepAliveMs) {
				decisions.push({
					server,
					refCount,
					idleMs: now - last,
					action: "skip:keepAlive"
				});
				continue;
			}
			const entry = control.resolveEntry(server);
			if (!entry) {
				decisions.push({
					server,
					refCount,
					idleMs: now - last,
					action: "drop:noEntry"
				});
				counters().reaperDroppedNoEntry += 1;
				state.aiEnabled.delete(server);
				state.refCounts.delete(server);
				state.lastUsed.delete(server);
				continue;
			}
			const entryId = entry.id;
			decisions.push({
				server,
				refCount,
				idleMs: now - last,
				action: "reap"
			});
			(async () => {
				try {
					if (!entry.disabled) await entry.update({ disabled: true });
					if ((state.refCounts.get(server) ?? 0) > 0) return;
					await control.clearAiOwner(entryId);
					if (!reaperDiag.everDisabled.includes(server)) reaperDiag.everDisabled.push(server);
					counters().reaped += 1;
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
		reaperDiag = {
			...reaperDiag,
			rounds: reaperDiag.rounds + 1,
			lastRound: {
				at: now,
				keepAliveMs,
				candidates: [...state.aiEnabled],
				decisions
			}
		};
	}, REAPER_INTERVAL_MS);
}
/**
* 创建控制层控制器。`caches` 即控制层依赖（McpControlCtx），由 index.ts
* 在 apply 里构建并封闭所有 IO。
*/
function createMcpCallController(ctx, caches) {
	counters().controllers += 1;
	const state = {
		refCounts: /* @__PURE__ */ new Map(),
		lastUsed: /* @__PURE__ */ new Map(),
		aiEnabled: /* @__PURE__ */ new Set()
	};
	return {
		/**
		* 网关透传入口（P2）：与 call() 同控制器共享引用计数态（state），但错误
		* 走 throw（gatewayCall），不进恒文本 call()。controller 外透出供网关
		* own 层双工具复用；call() 原行为不动。
		*/
		async gateway(serverName, toolName, args, agent, signal, explicitTimeoutMs) {
			return gatewayCall(ctx, caches, state, serverName, toolName, args, {
				signal,
				agent,
				explicitTimeoutMs
			});
		},
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
		async fetchInventory(serverName, waitMs) {
			return collectInventory(ctx, caches, state, serverName, MCP_SEARCH_TOOL, waitMs);
		},
		async call(serverName, toolName, args, agent, signal, explicitTimeoutMs) {
			const bareTool = normalizeToolName(serverName, toolName);
			const name = `mcp__${serverName}__${bareTool}`;
			if (isToolDisabled(name, typeof agent?.session?.header?.cwd === "string" ? agent.session.header.cwd : void 0)) return `MCP 工具 ${serverName}.${bareTool} 已被禁用（请在 MCP 管理面板打开该工具后再调用）`;
			const entry = caches.resolveEntry(serverName);
			if (!entry) {
				counters().callNoEntry += 1;
				const presetRow = caches.resolvePresetRow ? await caches.resolvePresetRow(serverName, agent).catch(() => void 0) : void 0;
				if (presetRow) {
					if (presetRow.disabled) return `MCP server "${serverName}" 当前已停用（预设行 ${presetRow.rowId}），请在 MCP 管理面板打开后（新会话生效）再调用`;
					const presetTimeout = presetRow.toolCallTimeoutMs;
					const hint = presetRow.running ? "" : "（提示：该行已启用但实例暂未运行，若持续超时请在面板确认后重试）";
					const out = await callViaPresetViews(ctx, caches, state, serverName, bareTool, name, args, agent, signal, explicitTimeoutMs ?? presetTimeout);
					return out.startsWith(`MCP ${serverName}.${bareTool} 调用异常`) && hint ? `${out}${hint}` : out;
				}
				return `未知 MCP server：${serverName}（不在 loader 中）`;
			}
			const entryId = entry.id;
			counters().callResolvedEntry += 1;
			const presetTimeout = caches.presetTimeoutMs ? await caches.presetTimeoutMs(serverName).catch(() => void 0) : void 0;
			const timeoutMs = explicitTimeoutMs ?? presetTimeout ?? caches.serverTimeoutMs(serverName);
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
				return `MCP ${serverName}.${bareTool} 调用异常：${msgOf(error)}（提示：tool 参数应传该 server 上的裸名；server/tool 是否存在可先 ${MCP_SEARCH_TOOL} 确认）`;
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
/**
* mcp_search 空查询的 server 清单（0.6.0 重写为「**已安装**」而非「在跑的」）。
*
* 关键修复动机（P1 实验实测）：原实现只遍历 catalog，而 catalog 只对**运行过的**
* 行采快照 → 用户关掉且从未运行过的 server 既不在 catalog、又不在 loader，
* 于是模型**完全不知道它存在**，「关着的 server 可被按需拉起」这条 rc.8 语义落空。
*
* 现在的数据源是「已安装行（standing 树，含关闭行）∪ catalog ∪ Config.serverSummary」：
* - 已安装行给出权威的开关状态（open/closed）；
* - 摘要优先取 `serverSummary` 配置，其次 catalog 里第一个工具的描述（截断）；
* - 无快照的行显式标注「无工具快照，首次按需调用时会自动拉起采集」。
*/
function buildSummary(control) {
	const catalog = control.getCatalog();
	const installed = /* @__PURE__ */ new Map();
	for (const row of control.installedInventory?.() ?? []) installed.set(row.server, row.open);
	const servers = /* @__PURE__ */ new Set([
		...installed.keys(),
		...Object.keys(catalog),
		...Object.keys(control.serverSummary)
	]);
	const lines = [];
	for (const server of servers) {
		const snap = catalog[server];
		const tools = snap ? snap.tools.length : null;
		const configured = control.serverSummary[server];
		let summary;
		if (configured !== void 0) summary = configured;
		else if (tools && tools > 0) {
			const raw = String(snap?.tools?.[0]?.description ?? "MCP server");
			summary = raw.length > SUMMARY_MAX_LEN ? `${raw.slice(0, SUMMARY_MAX_LEN)}…` : raw;
		} else summary = "（无工具快照：首次按需调用时会自动拉起并采集）";
		lines.push({
			server,
			summary,
			open: installed.get(server) ?? true,
			tools
		});
	}
	lines.sort((a, b) => Number(b.open) - Number(a.open) || a.server.localeCompare(b.server));
	return lines;
}
/**
* 空查（能力摘要表）的首行文案 —— 必须与本次装配的**实际可见性**同口径（G3）。
*
* - `hidesAll=false`（隐藏范围 = 仅手动停用）：手动启用的 server 确实对模型可见，
*   旧文案成立；
* - `hidesAll=true`（隐藏范围 = 全部）：命中中间层的模型一个 mcp__ 工具都拿不到，
*   此时 `[开]` 只表示「server 已挂载在跑」，**不代表对模型可见**。旧文案在这里
*   直接说谎（评审风险 7），故换口径。
*
* 抽成纯函数只为 selftest 能直接断言这条文案契约（不留「改完没人守」的窗口）。
* @param total - 已安装 server 数。
* @param openCount - 其中处于打开（已挂载）状态的数量。
* @param hidesAll - 中间层隐藏范围是否为 'all'。
*/
function buildSummaryHeader(total, openCount, hidesAll) {
	if (hidesAll) return `已安装 ${total} 个 MCP server（本会话的中间层隐藏范围=全部：MCP 工具一律不直连模型，全部经 ${MCP_SEARCH_TOOL} 检索 + ${MCP_CALL_TOOL} 按需取用；下表 [开]/[关] 只表示 server 是否已挂载在跑，与模型可见性无关 —— ${total} 个都可经 ${MCP_CALL_TOOL} 按需临时拉起）。`;
	return `已安装 ${total} 个 MCP server（${openCount} 个已打开并对模型可见，${total - openCount} 个已关闭——关闭的对模型不可见，但可经 ${MCP_CALL_TOOL} 按需临时拉起）。`;
}
function registerMcpSearchTool(ctx, control, controller) {
	const definition = defineTool({
		name: MCP_SEARCH_TOOL,
		description: `检索可用的 MCP 服务器与工具目录（只读，不执行）。四种用法：① 空参数 → server 清单（含已关闭的，按挂载态标开/关，并说明本会话的可见性口径）；② server=X → 该 server 的**能力摘要**（工具总数 + 前 5 个名字预览，不返回全表，避免上下文膨胀）；③ query + server → 在 X 内按需检索，返回 top-K 命中（含完整 schema），**想找某个 server 上的具体工具就用这个**；④ query → 全目录关键词检索。查到工具名后用 ${MCP_CALL_TOOL}(server, tool, arguments) 调用；不知道工具名先用 ②/③，不要用 ② 拉全表（工具多时传 all:true 才会返回全表）。中文连写请用空格分词（如“搜索 网页”）。`,
		parameters: {
			query: {
				type: "string",
				description: "检索关键词，按工具名/描述/参数名打分（缺省 top-K 8，上限 10）；与 server 同传即在该 server 内检索"
			},
			server: {
				type: "string",
				description: "目标 MCP server 名（见空查清单）。单独传 = 返回该 server 的能力摘要 + 前 5 个工具名预览"
			},
			all: {
				type: "boolean",
				description: "仅在传 server 时有效：true = 返回该 server 的完整工具清单（分页，可能很大）。默认 false 只给摘要"
			},
			limit: {
				type: "integer",
				description: "关键词 top-K（默认 8）或 server 页大小（默认 20，上限 50；配合 all:true 用）"
			},
			offset: {
				type: "integer",
				description: "server 页偏移（默认 0，仅 all:true 分支有效）"
			},
			topK: {
				type: "integer",
				description: "关键词命中数（默认 8，与 limit 同义，显式优先）"
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
			const topK = clampLimit(typeof args.topK === "number" ? args.topK : typeof args.limit === "number" ? args.limit : void 0, 8, 10);
			const pageLimit = clampLimit(typeof args.limit === "number" ? args.limit : void 0, 20, 50);
			const offset = Math.max(0, Math.floor(Number(args.offset) || 0));
			const workspace = typeof exec?.agent?.session?.header?.cwd === "string" ? exec.agent.session.header.cwd : void 0;
			const keep = (name) => !isToolDisabled(name, workspace);
			if (server && query) {
				const hits = searchCatalog(catalog, query, topK, server).filter((hit) => keep(hit.tool.name));
				return toJson({
					ok: true,
					kind: "search",
					server,
					query,
					count: hits.length,
					limit: topK,
					hits,
					hint: `命中即用 ${MCP_CALL_TOOL}（server + 裸工具名）调用；不够准就换关键词再搜，中文连写请用空格分词。`
				});
			}
			if (server) {
				const known = (control.installedInventory?.() ?? []).find((row) => row.server === server);
				let page = listServer(catalog, server, offset, pageLimit);
				let probed = false;
				if (page.totalCount === 0 && known) {
					await controller.fetchInventory(server).catch(() => null);
					probed = true;
					page = listServer(control.getCatalog(), server, offset, pageLimit);
				}
				if (!page.hasSnapshot && !known) return toJson({
					ok: true,
					kind: "list",
					server,
					found: false,
					installed: false,
					hasSnapshot: false,
					count: 0,
					totalCount: 0,
					offset,
					limit: pageLimit,
					tools: [],
					hint: `未知 server "${server}"，空查 ${MCP_SEARCH_TOOL} 看 server 清单；中文连写请用空格分词。`
				});
				const all = page.tools.filter((tool) => keep(tool.name));
				if (args.all !== true) {
					const preview = all.slice(0, 5).map((tool) => ({
						name: tool.name,
						description: tool.description
					}));
					return toJson({
						ok: true,
						kind: "summary",
						server,
						found: true,
						installed: true,
						open: known?.open ?? true,
						hasSnapshot: page.hasSnapshot,
						probed,
						count: page.totalCount,
						totalCount: page.totalCount,
						preview,
						hint: page.hasSnapshot ? `共 ${page.totalCount} 个工具，此处只预览 ${preview.length} 个。用 query + server 检索具体能力（推荐，按需且不占上下文）；确需完整清单请传 all: true。` : `该 server 已安装但当前没有工具（未运行或采集未成功）。可直接 ${MCP_CALL_TOOL} 调用它——中间层会临时拉起；若持续失败请在面板打开它后重试。`
					});
				}
				return toJson({
					ok: true,
					kind: "list",
					server,
					found: true,
					installed: true,
					open: known?.open ?? true,
					hasSnapshot: page.hasSnapshot,
					probed,
					count: all.length,
					totalCount: page.totalCount,
					offset,
					limit: pageLimit,
					tools: all,
					hint: "已按 all:true 返回全表（分页）。工具多时优先改用 query + server 检索，避免上下文膨胀。"
				});
			}
			if (query) {
				const hits = searchCatalog(catalog, query, topK).filter((hit) => keep(hit.tool.name));
				return toJson({
					ok: true,
					kind: "search",
					query,
					count: hits.length,
					limit: topK,
					hits
				});
			}
			const servers = buildSummary(control);
			const openCount = servers.filter((s) => s.open).length;
			return toJson({
				ok: true,
				kind: "summary",
				summary: [buildSummaryHeader(servers.length, openCount, control.middleLayerHides?.() === "all"), ...servers.map((s) => `- ${s.server} [${s.open ? "开" : "关"}]${s.tools === null ? "" : ` (${s.tools} 工具)`}: ${s.summary}`)].join("\n"),
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
		name: MCP_CALL_TOOL,
		description: `调用一个 MCP 服务器上的工具。知道工具名直接调（server + 裸 tool 名），不知道先用 ${MCP_SEARCH_TOOL} 关键词搜。参数透传给远端工具。`,
		parameters: {
			server: {
				type: "string",
				required: true,
				description: `MCP 服务器名（见 ${MCP_SEARCH_TOOL} 摘要）`
			},
			tool: {
				type: "string",
				required: true,
				description: "该 server 上的工具名（裸名，如 understand_image；误传注册全名 mcp__<server>__<tool> 会自动归一化）"
			},
			arguments: {
				type: "object",
				additionalProperties: true,
				description: "传给远端工具的参数字典；必须传 JSON 对象本身，不要传 JSON 字符串（字符串形态会被参数校验直接拒绝）"
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
			return controller.gateway(args.server, args.tool, normalizeArguments(args.arguments), exec.agent, exec.signal).catch((error) => `MCP 调用异常：${msgOf(error)}`);
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
			disposers.push(registerMcpSearchTool(ctx, control, controller));
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
export { serverOfMcp as A, projectServerOwner as C, messageOf as D, scanWorkspaceMcp as E, loadCatalog as O, projectServerName as S, remountWorkspace as T, resolveToolBulkTargets as _, createMcpCallController as a, getActiveWorkspace as b, inventoryTraceDiag as c, normalizeArguments as d, normalizeToolName as f, loadDisabledTools as g, isToolDisabled as h, buildSummaryHeader as i, snapshotFromSchemas as j, saveCatalog as k, mcpcall_exports as l, installToolDisableFilter as m, MCP_CALL_TOOL as n, gatewayCall as o, disabledToolsOf as p, MCP_SEARCH_TOOL as r, installMcpControlTools as s, CONTROL_TOOL_NAMES as t, msgOf as u, setToolDisabled as v, rebuildOwnersFromState as w, installProjectMcp as x, setToolsDisabledBulk as y };
