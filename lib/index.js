import Schema from "@deepseek-ai/schemastery";
import { scopeOf } from "@deepseek-ai/dsh-scope";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

//#region src/index.ts
const name = "runtime-inventory";
const inject = [
	"fs",
	"skills",
	"tools",
	"agents",
	"agentPresets",
	"loader"
];
const Config = Schema.object({ cacheTtlMs: Schema.number().min(0) });
const API_PREFIX = "/api/runtime-inventory";
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
			const tools = agg?.tools ?? 0;
			const running = entry.fiber !== void 0;
			const disabled = entry.disabled;
			const status = disabled ? "disabled" : running ? tools > 0 ? "active" : "idle" : "failed";
			mcp.push({
				entryId: entry.id,
				rowId: entry.options.id,
				serverName,
				transport: cfg?.transport ? String(cfg.transport) : null,
				disabled,
				running,
				tools,
				tokens: agg?.tokens ?? 0,
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
function makeRoutes(ctx, caches, config = {}) {
	const deps = {
		ctx,
		caches
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
	return [
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
	ctx.inject(["webServer"], (httpCtx) => {
		httpCtx.effect(() => {
			const routes = makeRoutes(httpCtx, caches, config);
			const disposers = routes.map((route) => httpCtx.webServer.register(route));
			return () => {
				for (const dispose of disposers) dispose();
			};
		}, "runtime-inventory: routes");
	});
}

//#endregion
export { Config, apply, inject, makeRoutes, name, rowDisabledState, setRowFlag, setSkillFlag, syncPresetFiles };