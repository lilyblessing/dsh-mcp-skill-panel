import Schema from "@deepseek-ai/schemastery";
import { scopeOf } from "@deepseek-ai/dsh-scope";
import { readFile, writeFile } from "node:fs/promises";

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
const DEFAULT_TTL_MS = 3e4;
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
		lines.splice(idx + 1 + flagAt, 1);
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
function resolveAgent(ctx, sessionId) {
	if (sessionId) {
		const byId = ctx.agents.get(sessionId);
		if (byId) return byId;
	}
	const roots = ctx.agents.roots();
	if (roots.length > 0) return roots[0];
	return ctx.agents.list()[0];
}
async function collectState(deps, sessionId) {
	const { ctx } = deps;
	const errors = [];
	const agent = resolveAgent(ctx, sessionId);
	const scopeKey = agent ? scopeOf(agent.ctx) : void 0;
	const cwd = agent?.session?.header?.cwd ?? void 0;
	let schemas = [];
	try {
		schemas = scopeKey ? ctx.tools.schemas(scopeKey) : ctx.tools.schemas();
	} catch (error) {
		errors.push(`tools.schemas: ${messageOf(error)}`);
	}
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
	const skills = [];
	let skillsModelVisible = 0;
	try {
		const snapshot = await ctx.skills.snapshot({
			scope: agent,
			cwd
		});
		for (const summary of snapshot.skills) {
			const modelInvocable = summary.invocation?.modelInvocable !== false;
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
	let preset = null;
	try {
		if (agent) preset = ctx.agentPresets.composedPreset(agent.ctx) ?? null;
	} catch {
		preset = null;
	}
	return {
		sessionId: agent ? agent.id : null,
		preset,
		cwd: cwd ?? null,
		mcp,
		mcpTotal: mcp.length,
		mcpDisabled: mcp.filter((row) => row.disabled).length,
		mcpToolsTotal,
		mcpTokensTotal,
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
	let persisted = false;
	if (typeof file === "string" && file.length > 0) try {
		const text = await readFile(file, "utf8");
		const next = setRowFlag(text, rowId, "disabled", disabled);
		if (next !== text) {
			await writeFile(file, next, "utf8");
			persisted = true;
		} else persisted = true;
	} catch (error) {
		throw new Error(`persist ${file}: ${messageOf(error)}`);
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
	return {
		name: skillName,
		disabled,
		modelInvocable: !disabled,
		path: def.path
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
function makeRoutes(ctx, config = {}) {
	const deps = {
		ctx,
		cacheTtlMs: config.cacheTtlMs ?? DEFAULT_TTL_MS
	};
	const cache = /* @__PURE__ */ new Map();
	let stateVersion = 0;
	const state = (sessionId) => {
		const key = sessionId ?? "*";
		const cached = cache.get(key);
		if (cached && Date.now() - cached.at < deps.cacheTtlMs) return cached.promise;
		const promise = collectState(deps, sessionId).then((value) => {
			stateVersion += 1;
			return value;
		}).catch((error) => {
			cache.delete(key);
			throw error;
		});
		cache.set(key, {
			at: Date.now(),
			promise
		});
		return promise;
	};
	const invalidate = () => cache.clear();
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
				const sessionId = queryParam(req.url ?? "", "session");
				state(sessionId).then((value) => json(res, 200, {
					ok: true,
					state: value
				}), (error) => json(res, 500, {
					ok: false,
					error: messageOf(error)
				}));
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
					invalidate();
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
					invalidate();
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
function apply(ctx, config = {}) {
	ctx.inject(["webServer"], (httpCtx) => {
		httpCtx.effect(() => {
			const routes = makeRoutes(httpCtx, config);
			const disposers = routes.map((route) => httpCtx.webServer.register(route));
			return () => {
				for (const dispose of disposers) dispose();
			};
		}, "runtime-inventory: routes");
	});
}

//#endregion
export { Config, apply, inject, makeRoutes, name, setRowFlag, setSkillFlag };