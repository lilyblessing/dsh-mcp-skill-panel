import Schema from "@deepseek-ai/schemastery";
import { scopeOf } from "@deepseek-ai/dsh-scope";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";

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
/** 从完整 tool name 解析 server 段（与 catalog.serverOfMcp 一致，保持本模块零依赖）。 */
function serverOfMcp(name$1) {
	if (!name$1.startsWith(MCP_TOOL_PREFIX)) return null;
	const rest = name$1.slice(MCP_TOOL_PREFIX.length);
	const at = rest.indexOf("__");
	if (at < 0) return null;
	return rest.slice(0, at);
}
function installMcpVisibilityFilter(ctx, buildVisibility) {
	return ctx.effect(() => {
		const off = ctx.root.on("system-prompt/assemble", (assembly, _context, next) => {
			if (assembly && Array.isArray(assembly.tools)) {
				const visibility = buildVisibility();
				assembly.tools = assembly.tools.filter((tool) => {
					const name$1 = String(tool.name ?? "");
					if (!name$1.startsWith(MCP_TOOL_PREFIX)) return true;
					const server = serverOfMcp(name$1);
					return server === null ? true : visibility.get(server) ?? true;
				});
			}
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
async function waitRegistered(control, ctx, name$1, scopeKey, timeoutMs, signal) {
	const start = Date.now();
	return new Promise((resolve, reject) => {
		let settled = false;
		let pollTimer;
		let offTools;
		let offAbort;
		let offDispose;
		const onAbort = () => finish(new Error("aborted"));
		const finish = (error) => {
			if (settled) return;
			settled = true;
			pollTimer?.();
			offTools?.();
			offAbort?.();
			offDispose?.();
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
		offDispose = ctx.effect(() => () => finish(new Error("context disposed")), "mcp-skill-panel: waitRegistered");
		if (signal) {
			if (signal.aborted) {
				finish(new Error("aborted"));
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
		waitRegistered(name$1, scopeKey, timeoutMs, signal) {
			return waitRegistered(caches, ctx, name$1, scopeKey, timeoutMs, signal);
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
				await waitRegistered(caches, ctx, name$1, scopeKey, timeoutMs, signal);
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
//#region src/state.ts
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
//#region src/collect.ts
/** 分域缓存 TTL：事件驱动失效为主，TTL 只是兜底（事件丢失场景） */
const DOMAIN_TTL_MS = 6e4;
/** 已确认的 skill 状态在 collectState 中覆盖 snapshot 旧值的有效期 */
const CONFIRMED_SKILL_TTL_MS = 6e4;
/** skill toggle 确认轮询间隔（ctx.timeout，随 ctx 生命周期）。 */
const SKILL_TOGGLE_POLL_MS = 80;
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
/** 写时清理过期条目（P2-8）：分域缓存 / 聚合 / 已确认 skill 的 Map 长期运行不膨胀。 */
function pruneExpired(map, now) {
	for (const [key, entry] of map) if (now - entry.at >= DOMAIN_TTL_MS) map.delete(key);
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
	pruneExpired(caches.mcpAggregates, Date.now());
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
	const mcp = [];
	const state = await readState().catch(() => void 0);
	try {
		for (const entry of ctx.loader.entries()) {
			if (!isMcpEntry(entry)) continue;
			const serverName = serverNameOf(entry);
			const agg = byServer.get(serverName);
			const liveTools = agg?.tools ?? 0;
			const running = entry.fiber !== void 0;
			const disabled = entry.disabled;
			const tree = entry.parent?.tree;
			const rowFile = tree?.filename;
			const rowDesired = typeof rowFile === "string" && rowFile.length > 0 ? state?.mcp?.[rowFile]?.[entry.options.id]?.desired : void 0;
			const catalogInfo = deps.catalogRuntime.catalog[serverName];
			const displayTools = liveTools > 0 ? liveTools : catalogInfo?.tools.length ?? 0;
			const displayTokens = liveTools > 0 ? agg?.tokens ?? 0 : catalogTokens(deps.catalogRuntime, serverName, catalogInfo);
			const status = disabled ? "disabled" : running ? liveTools > 0 ? "active" : "idle" : "failed";
			const transportRaw = mcpEntryConfig(entry)?.transport;
			mcp.push({
				entryId: entry.id,
				rowId: entry.options.id,
				serverName,
				transport: transportRaw ? String(transportRaw) : null,
				disabled,
				running,
				tools: displayTools,
				tokens: displayTokens,
				status,
				modelVisible: !disabled && !(deps.catalogRuntime.autoManage && (deps.controller?.isAiEnabled(serverName) ?? false)),
				desired: rowDesired,
				pending: rowDesired !== void 0 ? rowDesired !== disabled : false
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
		if (!m) return text;
		return `---${m[1]}${DISABLE_KEY}: true${m[1]}${text.slice(m[0].length)}`;
	}
	if (!value && has) return text.replace(new RegExp(`^\\s*${DISABLE_KEY}:\\s*true\\s*\\r?\\n?`, "m"), "");
	return text;
}
/** 读取某行当前是否带 disabled: true（true/false/null=无标记）。 */
function rowDisabledState(text, rowId) {
	const lines = text.split(/\r?\n/);
	const rowRe = new RegExp(`^-\\s*id:\\s*${escapeRegExp(rowId)}\\s*$`);
	const idx = lines.findIndex((line) => rowRe.test(line));
	if (idx < 0) return null;
	let end = idx + 1;
	while (end < lines.length && !/^-\s*id:/.test(lines[end])) end += 1;
	const block = lines.slice(idx, end);
	const flagLine = block.find((line) => /^\s*disabled:\s*(true|false)\s*$/.test(line));
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

//#endregion
//#region src/pending.ts
/** 待生效队列（进程内存态；重启后由 state.json.desired + syncPresetFiles 承接）。 */
const pendingMcp = /* @__PURE__ */ new Map();
/**
* 应用整条待生效队列：对每项 entry.update(desired)；用户启用方向 markUserEnabled
* （清 AI 标记 → 转为「用户打开」语义，回收器不再回收）。成功即从队列清除；
* 失败保留（下个边界重试）。返回实际应用数。调用方负责收尾 single invalidateMcp。
*/
async function applyPendingMcp(deps) {
	const { ctx } = deps;
	if (pendingMcp.size === 0) return 0;
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
	return applied;
}

//#endregion
//#region src/routes.ts
const API_PREFIX = "/api/mcp-skill-panel";
/** 旧前缀（0.3.1 及以前为 /api/runtime-inventory），保留兼容 */
const LEGACY_API_PREFIX = "/api/runtime-inventory";
/** skill toggle 后等待 watcher 失效 catalog 的最长时间 */
const SKILL_TOGGLE_CONFIRM_MS = 5e3;
/** 进程级随机令牌：写操作（启停/config）要求客户端在 x-panel-token 头携带；

* 阻断跨源 / DNS-rebinding 对本地控制端点的盲写。GET 只读保持开放。 */
const PANEL_TOKEN = randomBytes(32).toString("hex");
/** readBody 体积上限：防无界 body 累积（本地 DoS 向量）。 */
const MAX_BODY_BYTES = 64 * 1024;
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
				reject(new Error(`body exceeds ${MAX_BODY_BYTES} bytes`));
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
		if (guardPosts && req.method === "POST" && !tokenOk(req)) {
			json(res, 401, {
				ok: false,
				error: "unauthorized"
			});
			return;
		}
		handle(entry.method, entry.run)(req, res);
	};
}
async function toggleMcp(deps, entryId, disabled, applyMode) {
	const { ctx } = deps;
	const mode = applyMode ?? stateApplyMode(await readState());
	const entry = ctx.loader.resolve(entryId);
	if (!isMcpEntry(entry)) throw new Error(`entry "${entryId}" is not an MCP row`);
	const rowId = entry.options.id;
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
	while (Date.now() < deadline) {
		const after = await ctx.skills.get(skillName, {
			scope: agent,
			cwd
		});
		if (after && after.invocation?.modelInvocable === !disabled) {
			confirmed = true;
			break;
		}
		await ctx.timeout(SKILL_TOGGLE_POLL_MS);
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
		pruneExpired(skillsCache, Date.now());
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
				for (const item of toggles) {
					if (!item?.entryId) throw new Error("entryId is required in every toggle item");
					results.push(await toggleMcp(deps, item.entryId, Boolean(item.disabled), applyMode));
				}
				invalidateMcp();
				return {
					results,
					count: results.length
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
		}
	];
	return [...routes, ...routes.map((route) => ({
		...route,
		path: route.path.replace(API_PREFIX, LEGACY_API_PREFIX)
	}))];
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
/** tools.schemas 短窗口复用（P1-2）：覆盖「聚合失效 + 采集」两次调用间隔。 */
const SCHEMAS_CACHE_WINDOW_MS = 500;
/** catalog 持久化写盘防抖（P1-3）：tools/change 风暴期合并写盘。 */
const CATALOG_PERSIST_DEBOUNCE_MS = 300;
/** 从 loader entries 反查某 serverName 对应的 mcp 行（serverName 取自 config）。 */
function findMcpEntry(ctx, serverName) {
	for (const entry of ctx.loader.entries()) {
		if (!isMcpEntry(entry)) continue;
		if (serverNameOf(entry) === serverName) return entry;
	}
	return void 0;
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
/** tools.schemas 短窗口复用缓存（P1-2）：tools/change 风暴期内「聚合失效 + 采集」

* 两次调用共享一次 schemas（95 schema 深克隆），窗口 + scopeKey 引用匹配。 */
let schemasCache = null;
/**

* 解析 scope 并取 schema 视图（preset 层共享，任一 standing 即可）。

*

* 关键坑（v0.4.1 实测）：apply ctx（bundle 插件行挂载 ctx）下 `ctx.agents` 解析到

* 空实例（realm 隔离，roots/list 均为 0）——从 apply ctx 直接 resolveAgent 永远拿不到

* agent，catalog 采集恒为空并可能空写盘覆盖 last-good。因此 agent 不可得时

* fallback 到 `agentPresets.standingKeyFor()`（注册表查询，不依赖 agent 实例）。

*/
async function resolveScopeSchemas(ctx) {
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
	const now = Date.now();
	if (schemasCache && schemasCache.scopeKey === scopeKey && now - schemasCache.at < SCHEMAS_CACHE_WINDOW_MS) return schemasCache.schemas;
	const schemas = ctx.tools.schemas(scopeKey);
	schemasCache = {
		at: now,
		scopeKey,
		schemas
	};
	return schemas;
}
/** 本地 resolveAgent：避免 collect.ts 的依赖方向（本文件已 import collect）。 */
function resolveAgentLocal(ctx) {
	const roots = ctx.agents.roots();
	if (roots.length > 0) return roots[0];
	return ctx.agents.list()[0];
}
/** 对所有当前 enabled 的 mcp server 重新快照。 */
async function snapshotEnabled(ctx, runtime) {
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
		const schemas = await resolveScopeSchemas(ctx);
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
		snapshotEnabled: () => snapshotEnabled(ctx, runtime)
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
		const off = ctx.root.on("tools/change", () => {
			catalogRuntime.diag.toolsChangeEvents += 1;
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
	const control = buildMcpControl(ctx, catalogRuntime, config);
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
		const off = ctx.root.on("agent/session-start", () => {
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
		return off;
	}, "runtime-inventory: session-boundary apply");
	ctx.inject(["webServer"], (httpCtx) => {
		httpCtx.effect(() => {
			const routes = makeRoutes(httpCtx, caches, catalogRuntime, config, controller, () => snapshotEnabled(httpCtx, catalogRuntime));
			const disposers = routes.map((route) => httpCtx.webServer.register(route));
			return () => {
				for (const dispose of disposers) dispose();
			};
		}, "runtime-inventory: routes");
	});
}

//#endregion
export { Config, apply, inject, name, rowDisabledState, setRowFlag, setSkillFlag };