import Schema from "@deepseek-ai/schemastery";
import { scopeOf } from "@deepseek-ai/dsh-scope";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { defineTool } from "@deepseek-ai/dsh-tools";

//#region src/catalog.ts
/**
* 从 tools.schemas(scope) 的结果里，按 `mcp__<serverName>__` 前缀抽取该 server
* 的全部工具条目。name 是完整工具 id；参数取原样 JSON Schema。
*/
function snapshotFromSchemas(schemas, serverName) {
	const prefix = `mcp__${serverName}__`;
	const out = [];
	for (const schema of schemas) {
		const name$1 = String(schema?.name ?? "");
		if (!name$1.startsWith(prefix)) continue;
		out.push({
			name: name$1,
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
	const json$1 = JSON.stringify(catalog, null, 2);
	await fsp.writeFile(`${file}.tmp`, json$1, {
		encoding: "utf8",
		mode: 384
	});
	await fsp.rename(`${file}.tmp`, file);
}

//#endregion
//#region src/filter.ts
const MCP_TOOL_PREFIX = "mcp__";
function installMcpVisibilityFilter(ctx) {
	return ctx.effect(() => {
		const off = ctx.root.on("system-prompt/assemble", (assembly, _context, next) => {
			if (assembly && Array.isArray(assembly.tools)) assembly.tools = assembly.tools.filter((tool) => !String(tool.name ?? "").startsWith(MCP_TOOL_PREFIX));
			return next();
		});
		return off;
	}, "mcp-skill-panel: mcp visibility filter");
}

//#endregion
//#region src/mcpcall.ts
/** 空闲回收器扫描周期（ms）。 */
const REAPER_INTERVAL_MS = 1e4;
/** waitRegistered 轮询间隔（ms）。 */
const REGISTER_POLL_MS = 50;
function msgOf(error) {
	return error instanceof Error ? error.message : String(error);
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
const DEFAULT_SUMMARY = {
	cheatengine: "游戏进程内存读写与调试",
	"mimo-image": "图片理解与描述（多模态模型）",
	chrome: "浏览器自动化（导航/点击/截图/控制台/上传下载）",
	calcmcp: "数学计算（numpy / scipy 数值与符号计算）"
};
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
async function waitRegistered(control, ctx, name$1, scopeKey, timeoutMs) {
	const start = Date.now();
	return new Promise((resolve, reject) => {
		let settled = false;
		let pollTimer;
		let offTools;
		const finish = (error) => {
			if (settled) return;
			settled = true;
			pollTimer?.();
			offTools?.();
			if (error) reject(error);
			else resolve();
		};
		const check = () => {
			if (settled) return;
			let found = false;
			try {
				found = Boolean(ctx.tools.get(name$1, scopeKey));
			} catch {
				found = false;
			}
			if (found) return finish();
			if (Date.now() - start >= timeoutMs) return finish(new Error(`tool "${name$1}" 未在 ${timeoutMs}ms 内注册`));
			pollTimer = ctx.timeout(check, REGISTER_POLL_MS);
		};
		offTools = ctx.root.on("tools/change", () => check());
		check();
	});
}
/** 失败 / 无并发时恢复原状态：禁用并清 AI owner。 */
async function restore(control, ctx, state, serverName, entryId) {
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
			const refCount = state.refCounts.get(server) ?? 0;
			if (refCount > 0) continue;
			const last = state.lastUsed.get(server) ?? 0;
			if (now - last < control.keepAliveMs) continue;
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
					await control.clearAiOwner(entryId);
					ctx.logger.info?.(`mcp-skill-panel: idle-reaped MCP server "${server}"`);
				} catch (error) {
					ctx.logger.warn?.(`mcp-skill-panel: idle reaper disable "${server}" failed: ${msgOf(error)}`);
				} finally {
					state.aiEnabled.delete(server);
					state.refCounts.delete(server);
					state.lastUsed.delete(server);
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
	const controller = {
		async ensureEnabled(serverName) {
			const entry = caches.resolveEntry(serverName);
			if (!entry) throw new Error(`unknown MCP server "${serverName}"`);
			return ensureEnabled(caches, ctx, state, serverName, entry);
		},
		waitRegistered(name$1, scopeKey, timeoutMs) {
			return waitRegistered(caches, ctx, name$1, scopeKey, timeoutMs);
		},
		async call(serverName, toolName, args, agent, signal, explicitTimeoutMs) {
			const name$1 = `mcp__${serverName}__${toolName}`;
			const scopeKey = agent ? scopeOf(agent.ctx) : void 0;
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
				await waitRegistered(caches, ctx, name$1, scopeKey, timeoutMs);
				const result = await ctx.tools.execute({
					callId: `mcp-call-${randomUUID()}`,
					name: name$1,
					arguments: args,
					agent,
					signal
				});
				state.lastUsed.set(serverName, Date.now());
				if (result && result.isError) {
					failed = true;
					return `MCP ${serverName}.${toolName} 调用失败：${msgOf(result.error ?? "unknown error")}`;
				}
				const text = contentText(result ? result.content : void 0);
				return text.length > 0 ? text : `MCP ${serverName}.${toolName} 无返回内容`;
			} catch (error) {
				failed = true;
				return `MCP ${serverName}.${toolName} 调用异常：${msgOf(error)}`;
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
	return controller;
}
function clampLimit(value, defaultValue, max) {
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return defaultValue;
	return Math.min(Math.floor(value), max);
}
function buildSummary(control) {
	const catalog = control.getCatalog();
	const merged = {
		...DEFAULT_SUMMARY,
		...control.serverSummary
	};
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
		lines.push({
			server,
			summary: first ? `${first.description}` : "MCP server"
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
		execute: async (args) => {
			const catalog = control.getCatalog();
			const query = typeof args.query === "string" ? args.query.trim() : "";
			const server = typeof args.server === "string" ? args.server.trim() : "";
			const limit = clampLimit(typeof args.limit === "number" ? args.limit : void 0, control.searchLimitDefault, control.searchLimitMax);
			if (server) {
				const tools = listServer(catalog, server) ?? [];
				return toJson({
					ok: true,
					kind: "list",
					server,
					found: listServer(catalog, server) !== void 0,
					count: tools.length,
					tools
				});
			}
			if (query) {
				const hits = searchCatalog(catalog, query, limit);
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
			const text = servers.map((s) => `- ${s.server}: ${s.summary}`).join("\n");
			return toJson({
				ok: true,
				kind: "summary",
				summary: text,
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
				description: "该 server 上的工具名"
			},
			arguments: {
				type: "json",
				description: "传给远端工具的参数字典"
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
			return controller.call(args.server, args.tool, args.arguments ?? {}, exec.agent, exec.signal);
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
//#region src/index.ts
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
	cacheTtlMs: Schema.number().min(0),
	autoManage: Schema.boolean().description("MCP 中间层控制（模型经 mcp_search/mcp_call 统一使用 MCP）").default(false),
	keepAliveMs: Schema.number().min(1e3).description("MCP 保活空闲回收窗口（ms）").default(3e4),
	searchLimitDefault: Schema.number().min(1).description("mcp_search 缺省 top-K").default(5),
	searchLimitMax: Schema.number().min(1).description("mcp_search top-K 上限").default(10),
	serverSummary: Schema.dict(Schema.string()).description("MCP 能力摘要表（serverName → 一句话）")
});
const API_PREFIX = "/api/mcp-skill-panel";
/** 旧前缀（0.3.1 及以前为 /api/runtime-inventory），保留兼容 */
const LEGACY_API_PREFIX = "/api/runtime-inventory";
const DISABLE_KEY = "disable-model-invocation";
/** 分域缓存 TTL：事件驱动失效为主，TTL 只是兜底（事件丢失场景） */
const DOMAIN_TTL_MS = 6e4;
/** skill toggle 后等待 watcher 失效 catalog 的最长时间 */
const SKILL_TOGGLE_CONFIRM_MS = 5e3;
/** 已确认的 skill 状态在 collectState 中覆盖 snapshot 旧值的有效期 */
const CONFIRMED_SKILL_TTL_MS = 6e4;
/**

* 最近一次 toggle 确认过的 skill 状态（name → modelInvocable）。

* 服务端轮询用 skills.get 实时读文件确认，早于 snapshot 的发现缓存失效，

* 用它覆盖 collectState 里的陈旧 candidate 值。

*/
const confirmedSkills = /* @__PURE__ */ new Map();
function delay(ms) {
	return new Promise((resolve) => {
		setTimeout(resolve, ms);
	});
}
function tokenEstimate(parameters) {
	try {
		return Math.max(1, Math.round(JSON.stringify(parameters ?? {}).length / 4));
	} catch {
		return 1;
	}
}
function serverOf(name$1) {
	if (!name$1.startsWith("mcp__")) return null;
	const rest = name$1.slice(5);
	const at = rest.indexOf("__");
	if (at < 0) return null;
	return rest.slice(0, at);
}
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
	if (value && flagAt < 0) {
		lines.splice(idx + 1, 0, `  ${key}: true`);
		return lines.join(nl);
	}
	if (!value && flagAt >= 0) {
		lines.splice(idx + flagAt, 1);
		return lines.join(nl);
	}
	return text;
}
/** SKILL.md frontmatter 的 disable-model-invocation 键注入/移除（kebab-case 是唯一合法形式）。 */
function setSkillFlag(text, value) {
	const nl = lineSep(text);
	const has = new RegExp(`^${DISABLE_KEY}:\\s*true\\s*$`, "m").test(text);
	if (value && !has) {
		const m = /^---\s*(\r?\n)/.exec(text);
		if (!m) throw new Error("skill file has no frontmatter block");
		return text.slice(0, m.index + m[0].length) + `${DISABLE_KEY}: true${nl}` + text.slice(m.index + m[0].length);
	}
	if (!value && has) return text.replace(new RegExp(`^${DISABLE_KEY}:\\s*true\\s*${nl}`, "m"), "");
	return text;
}
/** 组合文件中某行当前 disabled 状态：行块内有 disabled 键 → true/false；无键 → null。 */
function rowDisabledState(text, rowId) {
	const lines = text.split(/\r?\n/);
	const rowRe = new RegExp(`^-\\s*id:\\s*${escapeRegExp(rowId)}\\s*$`);
	const idx = lines.findIndex((line) => rowRe.test(line));
	if (idx < 0) return null;
	let end = idx + 1;
	while (end < lines.length && !/^-\s*id:/.test(lines[end])) end += 1;
	const flagRe = /^\s*disabled:\s*(true|false)\s*$/;
	for (let i = idx + 1; i < end; i += 1) {
		const m = flagRe.exec(lines[i]);
		if (m) return m[1] === "true";
	}
	return null;
}
const LEGACY_STATE_DIR = join(homedir(), ".dsh", "dsh-runtime-inventory");
const STATE_DIR = join(homedir(), ".dsh", "dsh-mcp-skill-panel");
const STATE_FILE = join(STATE_DIR, "state.json");
/** 私有 catalog 持久化目录与文件（P1）。 */
const CATALOG_DIR = STATE_DIR;
const CATALOG_FILE = join(CATALOG_DIR, "catalog.json");
/** mcp_call 注册/调用的默认超时（读 entry config toolCallTimeoutMs，缺省回退）。 */
const DEFAULT_TOOL_TIMEOUT_MS = 6e4;
/** tools/change 后增量快照的去抖窗口。 */
const CATALOG_SNAPSHOT_DEBOUNCE_MS = 150;
async function readState() {
	try {
		return JSON.parse(await readFile(STATE_FILE, "utf8"));
	} catch {
		try {
			const legacy = join(LEGACY_STATE_DIR, "state.json");
			const text = await readFile(legacy, "utf8");
			await mkdir(STATE_DIR, { recursive: true });
			await rename(legacy, STATE_FILE);
			return JSON.parse(text);
		} catch {
			return {};
		}
	}
}
async function writeState(state) {
	await mkdir(STATE_DIR, { recursive: true });
	await writeFile(`${STATE_FILE}.tmp`, JSON.stringify(state, null, 2), "utf8");
	await rename(`${STATE_FILE}.tmp`, STATE_FILE);
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
			if (cur !== entry.lastApplied) continue;
			const curBool = cur === true;
			if (curBool !== entry.desired) try {
				text = setRowFlag(text, rowId, "disabled", entry.desired);
				changed = true;
				materialized += 1;
			} catch {
				continue;
			}
			next[rowId] = {
				desired: entry.desired,
				lastApplied: curBool
			};
		}
		if (changed) await writeFile(file, text, "utf8");
		mcp[file] = next;
	}
	await writeState(state);
	return materialized;
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
/** 从 loader entries 反查某 serverName 对应的 mcp 行（serverName 取自 config）。 */
function findMcpEntry(ctx, serverName) {
	for (const entry of ctx.loader.entries()) {
		if (entry.options.group) continue;
		const cfg = entry.options.config;
		const isMcp = entry.options.name === "@deepseek-ai/dsh-mcp-client" || cfg !== null && typeof cfg === "object" && "serverName" in cfg;
		if (!isMcp) continue;
		const name$1 = String(cfg?.serverName ?? entry.options.id);
		if (name$1 === serverName) return entry;
	}
	return void 0;
}
/** server 自己的注册/调用超时阈值。 */
function serverTimeoutMs(ctx, serverName) {
	const entry = findMcpEntry(ctx, serverName);
	const raw = entry?.options?.config;
	const t = raw?.toolCallTimeoutMs;
	return typeof t === "number" && Number.isFinite(t) && t > 0 ? t : DEFAULT_TOOL_TIMEOUT_MS;
}
function sameToolList(a, b) {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i += 1) if (a[i].name !== b[i].name || a[i].description !== b[i].description) return false;
	return true;
}
/** 原子写回 catalog.json；失败保留 dirty 标记以在下次重试。 */
async function persistCatalog(next, runtime) {
	if (runtime.persisting) return;
	if (!runtime.dirty) return;
	runtime.persisting = true;
	try {
		await saveCatalog(CATALOG_DIR, runtime.catalog);
		runtime.dirty = false;
	} catch (error) {
		const ctx = next();
		ctx.logger.warn?.(`mcp-skill-panel: catalog persist failed: ${messageOf(error)}`);
	} finally {
		runtime.persisting = false;
		if (runtime.dirty) persistCatalog(next, runtime);
	}
}
/** 取任一 live agent 的 scope 的 schema 视图（preset 层共享，任一 agent 即可）。 */
function liveSchemas(ctx) {
	const agent = resolveAgent(ctx, void 0);
	const scopeKey = agent ? scopeOf(agent.ctx) : void 0;
	return scopeKey ? ctx.tools.schemas(scopeKey) : ctx.tools.schemas();
}
/** 对所有当前 enabled 的 mcp server 重新快照。 */
async function snapshotEnabled(ctx, runtime) {
	const next = { ...runtime.catalog };
	let changed = false;
	const schemas = liveSchemas(ctx);
	for (const entry of ctx.loader.entries()) {
		if (entry.options.group) continue;
		const cfg = entry.options.config;
		const isMcp = entry.options.name === "@deepseek-ai/dsh-mcp-client" || cfg !== null && typeof cfg === "object" && "serverName" in cfg;
		if (!isMcp) continue;
		if (entry.disabled) continue;
		const serverName = String(cfg?.serverName ?? entry.options.id);
		let tools;
		try {
			tools = snapshotFromSchemas(schemas, serverName);
		} catch {
			continue;
		}
		const prev = next[serverName];
		if (prev && prev.source === "live" && sameToolList(prev.tools, tools)) continue;
		if (tools.length === 0 && prev && prev.tools.length > 0 && prev.source === "cached") continue;
		next[serverName] = {
			tools,
			fetchedAt: Date.now(),
			source: "live"
		};
		changed = true;
	}
	runtime.catalog = next;
	if (changed) {
		runtime.dirty = true;
		persistCatalog(() => ctx, runtime);
	}
}
/** 对单个 server 做一次实时快照（惰性采集兜底）。 */
async function snapshotServer(ctx, runtime, serverName) {
	const next = { ...runtime.catalog };
	let tools;
	try {
		tools = snapshotFromSchemas(liveSchemas(ctx), serverName);
	} catch {
		return;
	}
	if (tools.length === 0) {
		const prev$1 = runtime.catalog[serverName];
		if (prev$1 && prev$1.tools.length > 0) return;
	}
	const prev = runtime.catalog[serverName];
	if (prev && prev.source === "live" && sameToolList(prev.tools, tools)) return;
	next[serverName] = {
		tools,
		fetchedAt: Date.now(),
		source: "live"
	};
	runtime.catalog = next;
	runtime.dirty = true;
	persistCatalog(() => ctx, runtime);
}
/** 构建控制层依赖（McpControlCtx）：封闭 catalog/loader/state 的 IO。 */
function buildMcpControl(ctx, runtime, config) {
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
		snapshotServer: (serverName) => snapshotServer(ctx, runtime, serverName),
		snapshotEnabled: () => snapshotEnabled(ctx, runtime)
	};
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
		const server = serverOf(String(schema.name ?? ""));
		if (!server) continue;
		const entry = byServer.get(server) ?? {
			tools: 0,
			tokens: 0
		};
		entry.tools += 1;
		entry.tokens += tokenEstimate(schema.parameters);
		byServer.set(server, entry);
		mcpToolsTotal += 1;
		mcpTokensTotal += tokenEstimate(schema.parameters);
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
	const hit = caches.mcpAggregates.get(key);
	if (hit && Date.now() - hit.at < DOMAIN_TTL_MS) return hit.value;
	let schemas = [];
	try {
		schemas = scopeKey ? ctx.tools.schemas(scopeKey) : ctx.tools.schemas();
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
async function collectMcp(deps, sessionId) {
	const { ctx } = deps;
	const errors = [];
	const agent = resolveAgent(ctx, sessionId);
	const scopeKey = agent ? scopeOf(agent.ctx) : void 0;
	const cwd = agent?.session?.header?.cwd ?? void 0;
	const { byServer, mcpToolsTotal, mcpTokensTotal } = getMcpAggregate(ctx, deps.caches, scopeKey, errors);
	const mcp = [];
	try {
		for (const entry of ctx.loader.entries()) {
			if (entry.options.group) continue;
			const cfg = entry.options.config;
			const isMcp = entry.options.name === "@deepseek-ai/dsh-mcp-client" || cfg !== null && typeof cfg === "object" && "serverName" in cfg;
			if (!isMcp) continue;
			const serverName = String(cfg?.serverName ?? entry.options.id);
			const agg = byServer.get(serverName);
			const liveTools = agg?.tools ?? 0;
			const running = entry.fiber !== void 0;
			const disabled = entry.disabled;
			const catalogInfo = deps.catalogRuntime.catalog[serverName];
			const displayTools = liveTools > 0 ? liveTools : catalogInfo?.tools.length ?? 0;
			const displayTokens = liveTools > 0 ? agg?.tokens ?? 0 : catalogInfo?.tools.reduce((sum, t) => sum + tokenEstimate(t.parameters), 0) ?? 0;
			const status = disabled ? "disabled" : running ? liveTools > 0 ? "active" : "idle" : "failed";
			mcp.push({
				entryId: entry.id,
				rowId: entry.options.id,
				serverName,
				transport: cfg?.transport ? String(cfg.transport) : null,
				disabled,
				running,
				tools: displayTools,
				tokens: displayTokens,
				status
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
			const modelInvocable = confirmed && Date.now() - confirmed.at < CONFIRMED_SKILL_TTL_MS ? confirmed.modelInvocable : summary.invocation?.modelInvocable !== false;
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
async function toggleMcp(deps, entryId, disabled) {
	const { ctx } = deps;
	const entry = ctx.loader.resolve(entryId);
	const rowId = entry.options.id;
	await entry.update({ disabled });
	const tree = entry.parent?.tree;
	const file = tree?.filename;
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
		disabled,
		running: entry.fiber !== void 0,
		persisted,
		file: file ?? null
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
	while (Date.now() < deadline) {
		const after = await ctx.skills.get(skillName, {
			scope: agent,
			cwd
		});
		if (after && after.invocation?.modelInvocable === !disabled) {
			confirmed = true;
			break;
		}
		await delay(80);
	}
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
function messageOf(error) {
	return error instanceof Error ? error.message : String(error);
}
function json(res, code, body) {
	res.statusCode = code;
	res.setHeader("content-type", "application/json");
	res.end(JSON.stringify(body));
}
function readBody(req) {
	return new Promise((resolve) => {
		let body = "";
		req.on("data", (chunk) => {
			body += String(chunk);
		});
		req.on("end", () => resolve(body));
	});
}
function queryParam(url, key) {
	const m = new RegExp(`[?&]${key}=([^&]+)`).exec(url);
	return m ? decodeURIComponent(m[1]) : void 0;
}
function makeRoutes(ctx, caches, catalogRuntime, config = {}) {
	const deps = {
		ctx,
		caches,
		catalogRuntime
	};
	const { mcpCache, skillsCache, invalidateMcp, invalidateSkills } = caches;
	const cachedMcp = (sessionId) => {
		const key = sessionId ?? "*";
		const hit = mcpCache.get(key);
		if (hit && Date.now() - hit.at < DOMAIN_TTL_MS) return hit.promise;
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
		const hit = skillsCache.get(key);
		if (hit && Date.now() - hit.at < DOMAIN_TTL_MS) return hit.promise;
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
			handler: (req, res) => {
				if (req.method !== "GET") {
					json(res, 405, {
						ok: false,
						error: "method-not-allowed"
					});
					return;
				}
				const url = req.url ?? "";
				const sessionId = queryParam(url, "session");
				const part = queryParam(url, "part") ?? "all";
				const respond = (state) => json(res, 200, {
					ok: true,
					state
				});
				const fail = (error) => json(res, 500, {
					ok: false,
					error: messageOf(error)
				});
				if (part === "mcp") {
					cachedMcp(sessionId).then(respond, fail);
					return;
				}
				if (part === "skills") {
					cachedSkills(sessionId).then(respond, fail);
					return;
				}
				Promise.all([cachedMcp(sessionId), cachedSkills(sessionId)]).then(([mcp, skills]) => respond({
					...mcp,
					...skills,
					errors: [...mcp.errors, ...skills.errors]
				})).catch(fail);
			}
		},
		{
			kind: "exact",
			path: `${API_PREFIX}/mcp/toggle`,
			handler: (req, res) => {
				if (req.method !== "POST") {
					json(res, 405, {
						ok: false,
						error: "method-not-allowed"
					});
					return;
				}
				readBody(req).then((body) => JSON.parse(body || "{}")).then((parsed) => {
					if (!parsed.entryId) throw new Error("entryId is required");
					return toggleMcp(deps, parsed.entryId, Boolean(parsed.disabled));
				}).then((result) => {
					invalidateMcp();
					json(res, 200, {
						ok: true,
						...result
					});
				}).catch((error) => json(res, 400, {
					ok: false,
					error: messageOf(error)
				}));
			}
		},
		{
			kind: "exact",
			path: `${API_PREFIX}/skill/toggle`,
			handler: (req, res) => {
				if (req.method !== "POST") {
					json(res, 405, {
						ok: false,
						error: "method-not-allowed"
					});
					return;
				}
				readBody(req).then((body) => JSON.parse(body || "{}")).then(async (parsed) => {
					if (!parsed.name) throw new Error("name is required");
					return toggleSkill(deps, parsed.name, Boolean(parsed.disabled), parsed.session);
				}).then((result) => {
					invalidateSkills();
					json(res, 200, {
						ok: true,
						...result
					});
				}).catch((error) => json(res, 400, {
					ok: false,
					error: messageOf(error)
				}));
			}
		}
	];
	return [...routes, ...routes.map((route) => ({
		...route,
		path: route.path.replace(API_PREFIX, LEGACY_API_PREFIX)
	}))];
}
function createDomainCaches() {
	const mcpCache = /* @__PURE__ */ new Map();
	const skillsCache = /* @__PURE__ */ new Map();
	const mcpAggregates = /* @__PURE__ */ new Map();
	return {
		mcpCache,
		skillsCache,
		mcpAggregates,
		invalidateMcp: () => {
			mcpCache.clear();
			mcpAggregates.clear();
		},
		invalidateSkills: () => skillsCache.clear()
	};
}
function apply(ctx, config = {}) {
	syncPresetFiles(ctx).then((count) => {
		if (count > 0) ctx.logger.info(`runtime-inventory: materialized ${count} MCP row state(s) into preset composition`);
	}, (error) => {
		ctx.logger.warn(`runtime-inventory: preset sync skipped: ${messageOf(error)}`);
	});
	const catalogRuntime = {
		catalog: {},
		dirty: false,
		persisting: false
	};
	loadCatalog(CATALOG_DIR).then((catalog) => {
		catalogRuntime.catalog = catalog;
	}, () => {
		catalogRuntime.catalog = {};
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
		const off = ctx.root.on("tools/change", () => {
			if (scheduled) return;
			scheduled = true;
			ctx.timeout(() => {
				scheduled = false;
				snapshotEnabled(ctx, catalogRuntime);
			}, CATALOG_SNAPSHOT_DEBOUNCE_MS);
		});
		return off;
	}, "mcp-skill-panel: catalog snapshot");
	snapshotEnabled(ctx, catalogRuntime).catch(() => {});
	ctx.inject(["webServer"], (httpCtx) => {
		httpCtx.effect(() => {
			const routes = makeRoutes(httpCtx, caches, catalogRuntime, config);
			const disposers = routes.map((route) => httpCtx.webServer.register(route));
			return () => {
				for (const dispose of disposers) dispose();
			};
		}, "runtime-inventory: routes");
	});
	if (config.autoManage) {
		const control = buildMcpControl(ctx, catalogRuntime, config);
		const controller = createMcpCallController(ctx, control);
		ctx.effect(() => {
			const disposers = [];
			disposers.push(installMcpVisibilityFilter(ctx));
			disposers.push(installMcpControlTools(ctx, control, controller));
			const offReaper = controller.startIdleReaper();
			disposers.push(() => offReaper());
			return () => {
				for (let i = disposers.length - 1; i >= 0; i -= 1) disposers[i]();
			};
		}, "mcp-skill-panel: autoManage control");
	}
}

//#endregion
export { Config, apply, inject, makeRoutes, name, rowDisabledState, setRowFlag, setSkillFlag, syncPresetFiles };