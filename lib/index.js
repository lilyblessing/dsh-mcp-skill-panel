import { _ as searchCatalog, a as setToolDisabled, c as projectServerName, d as remountWorkspace, f as scanWorkspaceMcp, g as saveCatalog, h as loadCatalog, i as loadDisabledTools, l as projectServerOwner, m as listServer, n as installToolDisableFilter, o as getActiveWorkspace, p as messageOf, r as isToolDisabled, s as installProjectMcp, t as disabledToolsOf, u as rebuildOwnersFromState, v as serverOfMcp$1, y as snapshotFromSchemas } from "./tool-disable-DdiHMPJt.mjs";
import { i as stateApplyMode, n as readState, o as writeState, r as setStateAiOwner, t as clearStateAiOwner } from "./state-Bo1YB6hJ.mjs";
import { a as serversToRows, i as serversToPatchYaml, n as parseMcpServersJson } from "./mcp-convert-QL_5hLe8.mjs";
import { i as serverNameOf, n as mcpEntryConfig, t as isMcpEntry } from "./mcp-entry-Be8hx6aP.mjs";
import { a as setRowFlag, i as rowDisabledState, n as isValidSkillName, o as setSkillFlag, s as syncPresetFiles, t as buildSkillMd } from "./preset-ByFnKr7g.mjs";
import { a as presetConfigOf, i as parsePresetMcpText, n as findPresetRowByServerName, r as listPresetMcpRows, t as findPresetRowByEntryId } from "./preset-mcp-DdSqV-ZF.mjs";
import Schema from "@deepseek-ai/schemastery";
import { homedir } from "node:os";
import { basename, dirname, join, parse } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { access, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import * as agentPresets from "@deepseek-ai/dsh-agent-presets";
import { scopeOf } from "@deepseek-ai/dsh-scope";
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
		return `MCP ${serverName}.${bareTool} 调用异常：${msgOf(error)}（提示：tool 参数应传该 server 上的裸名；server/tool 是否存在可先 mcp_search 确认）`;
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
	const workspace = typeof opts.agent?.session?.header?.cwd === "string" ? opts.agent.session.header.cwd : void 0;
	if (isToolDisabled(name, workspace)) throw new Error(`MCP 工具 ${serverName}.${bareTool} 已被禁用（请在 MCP 管理面板打开该工具后再调用）`);
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
			return collectInventory(ctx, caches, state, serverName, "mcp_search", waitMs);
		},
		async call(serverName, toolName, args, agent, signal, explicitTimeoutMs) {
			const bareTool = normalizeToolName(serverName, toolName);
			const name = `mcp__${serverName}__${bareTool}`;
			const workspace = typeof agent?.session?.header?.cwd === "string" ? agent.session.header.cwd : void 0;
			if (isToolDisabled(name, workspace)) return `MCP 工具 ${serverName}.${bareTool} 已被禁用（请在 MCP 管理面板打开该工具后再调用）`;
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
function registerMcpSearchTool(ctx, control, controller) {
	const definition = defineTool({
		name: "mcp_search",
		description: "检索可用的 MCP 服务器与工具目录（只读，不执行）。四种用法：① 空参数 → server 清单（含已关闭的，标注开/关）；② server=X → 该 server 的**能力摘要**（工具总数 + 前 5 个名字预览，不返回全表，避免上下文膨胀）；③ query + server → 在 X 内按需检索，返回 top-K 命中（含完整 schema），**想找某个 server 上的具体工具就用这个**；④ query → 全目录关键词检索。查到工具名后用 mcp_call(server, tool, arguments) 调用；不知道工具名先用 ②/③，不要用 ② 拉全表（工具多时传 all:true 才会返回全表）。中文连写请用空格分词（如“搜索 网页”）。",
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
					hint: "命中即用 mcp_call（server + 裸工具名）调用；不够准就换关键词再搜，中文连写请用空格分词。"
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
					hint: `未知 server "${server}"，空查 mcp_search 看 server 清单；中文连写请用空格分词。`
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
						count: all.length,
						totalCount: page.totalCount,
						preview,
						hint: page.hasSnapshot ? `共 ${page.totalCount} 个工具，此处只预览 ${preview.length} 个。用 query + server 检索具体能力（推荐，按需且不占上下文）；确需完整清单请传 all: true。` : `该 server 已安装但当前没有工具（未运行或采集未成功）。可直接 mcp_call 调用它——中间层会临时拉起；若持续失败请在面板打开它后重试。`
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
				summary: [`已安装 ${servers.length} 个 MCP server（${openCount} 个已打开并对模型可见，${servers.length - openCount} 个已关闭——关闭的对模型不可见，但可经 mcp_call 按需临时拉起）。`, ...servers.map((s) => `- ${s.server} [${s.open ? "开" : "关"}]${s.tools === null ? "" : ` (${s.tools} 工具)`}: ${s.summary}`)].join("\n"),
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
		description: "调用一个 MCP 服务器上的工具。知道工具名直接调（server + 裸 tool 名），不知道先用 mcp_search 关键词搜。参数透传给远端工具。",
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
//#region src/standing-rows.ts
/**
* dsh-agent-presets 的读取面。全部可选：宿主版本落后（< 0.1.5-rc.2）时这些函数
* 不存在，面板整体降级为 0.5.6 行为（可见性不过滤、开关只记意图），不崩。
*/
const api = agentPresets;
/** 诊断快照（/debug standingDiag 用；不参与任何逻辑判断）。 */
let diag = {
	apiAvailable: false,
	apiError: null,
	mountsSeen: 0,
	lastPresetIds: [],
	lastRowCount: 0
};
/**
* 全进程所有 preset 的 standing 挂载（**无 agent 参数**，装配同步路径也可用）。
* 过滤掉没有 tree / tree 无 entries() 的项（防御畸形挂载）。
*/
function presetMounts() {
	if (typeof api.livePresetMounts !== "function") {
		diag = {
			...diag,
			apiAvailable: false,
			apiError: "livePresetMounts not exported by host dsh-agent-presets"
		};
		return [];
	}
	try {
		const raw = api.livePresetMounts();
		const out = [];
		for (const m of Array.isArray(raw) ? raw : []) {
			const tree = m?.tree;
			if (!tree || typeof tree.entries !== "function") continue;
			out.push(m);
		}
		diag = {
			...diag,
			apiAvailable: true,
			apiError: null,
			mountsSeen: out.length,
			lastPresetIds: out.map((m) => String(m.presetId ?? ""))
		};
		return out;
	} catch (error) {
		diag = {
			...diag,
			apiAvailable: true,
			apiError: error instanceof Error ? error.message : String(error)
		};
		return [];
	}
}
/**
* 在 standing 树里按 serverName 找 MCP 行。先遍历 `livePresetMounts()`；
* 无挂载且给了 agentCtx 时再用 `standingMountFor(agentCtx)` 兜一次
* （带 agent 的调用方更精确，但不依赖它——RC.4 会话无挂载时为 undefined）。
* 命中规则与 loader 侧一致（isMcpEntry + serverNameOf），两条路径同语义。
*/
function findStandingEntryByServer(serverName, agentCtx) {
	const mounts = presetMounts();
	if (mounts.length === 0 && agentCtx !== void 0 && typeof api.standingMountFor === "function") try {
		const mount = api.standingMountFor(agentCtx);
		if (mount?.tree && typeof mount.tree.entries === "function") mounts.push(mount);
	} catch {}
	for (const mount of mounts) for (const entry of safeEntries(mount.tree)) {
		if (!isMcpEntry(entry)) continue;
		if (serverNameOf(entry) === serverName) return entry;
	}
}
/** 在 standing 树里按长 entryId 找行（toggleMcp 直传 entryId 时用）。 */
function findStandingEntryById(entryId) {
	for (const mount of presetMounts()) for (const entry of safeEntries(mount.tree)) if (String(entry.id) === entryId) return entry;
}
/** 全部 standing MCP 行（可见性层用：需同时覆盖 open 与 closed 两种行）。 */
function standingMcpEntries() {
	const out = [];
	for (const mount of presetMounts()) for (const entry of safeEntries(mount.tree)) {
		if (!isMcpEntry(entry)) continue;
		out.push(entry);
	}
	diag = {
		...diag,
		lastRowCount: out.length
	};
	return out;
}
/**
* 全部**已安装**的 MCP server（含用户关闭的），供 mcp_search 列能力表。
*
* 与 `standingMcpEntries()` 的差别：这里只要"配置里存在这一行"就算已安装，
* 不要求它有运行实例 —— 这正是 rc.8 语义里「关着的 server 仍应可被检索到」的落点
* （0.5.7 之前关掉的行既不在 loader 也不在 catalog，模型完全看不到它存在）。
*/
function installedMcpRows() {
	const out = [];
	for (const entry of standingMcpEntries()) out.push({
		serverName: serverNameOf(entry),
		entryId: String(entry.id),
		open: entry.disabled !== true,
		hasEntry: true
	});
	out.sort((a, b) => a.serverName.localeCompare(b.serverName));
	return out;
}
/** entries() 迭代器防御：挂载途中树可能重建，抛错时按空树处理并记诊断。 */
function safeEntries(tree) {
	if (!tree) return [];
	try {
		const it = tree.entries();
		return Array.isArray(it) ? it : [...it];
	} catch (error) {
		diag = {
			...diag,
			apiError: error instanceof Error ? error.message : String(error)
		};
		return [];
	}
}
/** /debug 诊断读数（只读快照，外部改不到内部状态）。 */
function standingDiag() {
	return { ...diag };
}
//#endregion
//#region src/gateway.ts
/** 网关行 entryId 前缀（连字符；冒号是 EntryTree.sep 不可用，见 B4）。 */
const GATEWAY_ENTRY_PREFIX = "gw-mcp-";
/** 网关行 entryId ↔ serverName 双向映射（B4 三键落字）。 */
function gatewayEntryId(serverName) {
	return `${GATEWAY_ENTRY_PREFIX}${serverName}`;
}
function gatewayServerOfEntryId(entryId) {
	if (!entryId.startsWith("gw-mcp-")) return null;
	return entryId.slice(7);
}
/** 空网关态。 */
function createGatewayState() {
	return {
		restrictDisposers: [],
		mounts: /* @__PURE__ */ new Map(),
		entryIds: /* @__PURE__ */ new Map(),
		lastCheck: null,
		syncing: false
	};
}
/**
* 子 scope 视野隔离：在给定 tools 服务上 deny 除双工具外的全部继承 `mcp__*` 名。
* deny 表调用方传入（动态表：`view(standingKey).visible` 快照，见 MVT-5 R3-2）。
* 未知名按 dsh-tools 语义抛错——调用方须只传已知 global 名（MVT-4 R2-2）。
*/
function isolateChildScope(childTools, inheritMcpNames) {
	return childTools.restrict({ deny: [...inheritMcpNames] });
}
/**
* open 行网关挂载决策（纯逻辑，可自测）：
* - preset 行缺失/不可挂载（config undefined）→ 'skip'（回退旧直通语义）；
* - preset 行 disabled → 'skip'（拒绝语义归 gatewayCall，前置已判定）；
* - loader 已有同名 server 行（官方行/项目行/global 行启用中，网关让路）→ 'skip-official'
*  （B3：rc.1 下 standing 行不在 loader.entries，判据=loader 同 serverName 行存在；
*   standing 行与网关行是否同 scope 抛错互斥未经现网实证，不假设——让路即不建第二实例）；
* - 已有同名 mount → 'reuse'（防 #3984 `already in use` / #4798 重复注册）；
* - 否则 'mount'。
*/
function decideMount(serverName, presetConfig, presetDisabled, mounted, hasLoaderRow = false) {
	if (!presetConfig) return "skip";
	if (presetDisabled) return "skip";
	if (hasLoaderRow) return "skip-official";
	if (mounted.has(serverName)) return "reuse";
	return "mount";
}
/**
* 网关自检断言（MVT-4 ASSERT-A/A2 产品化）：child 可见面恒为双工具。
* 纯逻辑：visible 名单由调用方传入（`tools.view(childKey).visible.keys()`），
* 本函数只做集合比对，不碰运行时。
*/
function checkChildVisible(visibleNames) {
	const sorted = [...visibleNames].sort();
	const ok = sorted.length === 2 && sorted[0] === "mcp_call" && sorted[1] === "mcp_search";
	return {
		ok,
		detail: ok ? "child visible == [mcp_call, mcp_search]" : `child visible unexpected: ${JSON.stringify(sorted)}`
	};
}
/** 释放网关挂载态：restrict disposer 逐个 lift + loader gw- 行逐个 remove + 清 mounts（B2）。 */
function disposeGatewayState(ctx, state) {
	for (const dispose of state.restrictDisposers.splice(0)) try {
		dispose();
	} catch (error) {
		ctx.logger.warn?.(`mcp-skill-panel: gateway restrict lift failed: ${messageOf(error)}`);
	}
	for (const [serverName, entryId] of [...state.entryIds]) {
		try {
			ctx.loader.remove(entryId)?.catch?.(() => void 0);
		} catch {}
		state.entryIds.delete(serverName);
	}
	state.mounts.clear();
}
/** 同步释放（applyAutoManage 同步体内/卸载兜底共用；remove fire-and-forget）。 */
function disposeGatewayStateSync(ctx, state) {
	disposeGatewayState(ctx, state);
}
/**
* 网关常驻挂载（P5）：open 的 preset 行经 loader.create 自托管拉起 dsh-mcp-client。
*
* 真值表（B3）：
* - preset 无行/不可挂载（config undefined）→ skipped（回退旧直通语义）；
* - preset 行 disabled → skipped（拒绝语义归 gatewayCall）；
* - loader 已有同名 server 行 → skippedOfficial（网关让路，不建第二实例）；
* - mounts 已有同名 → reused；
* - 否则 loader.create({id: gw-mcp-<server>, name, config, disabled:false}) → mounted/errors。
*
* 关意图即拆（WARN-3 补关链路，2026-09-10 现网实证）：
* - toggle 网关行只写 state.json desired 意图（routes.ts 网关分支，不碰 live gw- 行）；
* - 本轮先读 state，对「已挂载 mounts 中 desired=true（关意图）」的行逐个 loader.remove
*   并清 mounts/entryIds 账，记 unmounted；意图链不动（state/pending 由 toggle 侧维护）。
* - 开意图（desired=false/无意图）走正常挂载真值表；关→开即重挂。
*
* 单飞（W3）：syncing guard + 顶层 try/finally；一家失败记 errors 不抛（一家挂不拖全家）。
* preset 选择（W4）：调用方 agent 优先，无则 roots[0]/list[0]（与 cachedPresetRow 同规则）；
* listPresetMcpRows 按 presetId 全量列出行，挂载逐行决策。
*/
async function ensureOpenMounts(deps, presetId) {
	const { ctx, control, state } = deps;
	const out = {
		mounted: [],
		reused: [],
		skipped: [],
		skippedOfficial: [],
		unmounted: [],
		errors: []
	};
	if (state.syncing) return out;
	state.syncing = true;
	try {
		let pid = presetId;
		if (!pid) try {
			const live = ctx.agents.roots()[0] ?? ctx.agents.list()[0];
			pid = live ? ctx.agentPresets.composedPreset(live.ctx) ?? void 0 : void 0;
		} catch {
			pid = void 0;
		}
		if (!pid) {
			state.lastCheck = {
				at: Date.now(),
				ok: true,
				detail: "mounted=0 reused=0 skipped=0 skippedOfficial=0 unmounted=0 errors=0 (no preset)"
			};
			return out;
		}
		const { listPresetMcpRows } = await import("./preset-mcp-DdSqV-ZF.mjs").then((n) => n.o);
		const { isMcpEntry, serverNameOf } = await import("./mcp-entry-Be8hx6aP.mjs").then((n) => n.r);
		const { MCP_CLIENT_NAME } = await import("./mcp-convert-QL_5hLe8.mjs").then((n) => n.t);
		const { readState } = await import("./state-Bo1YB6hJ.mjs").then((n) => n.a);
		const listRows = deps.listRows ?? (async (c, pid2) => listPresetMcpRows(c, pid2));
		const readIntents = deps.readIntents ?? (async () => {
			const stateFile = await readState().catch(() => void 0);
			return (presetPathRef.current ? stateFile?.mcp?.[presetPathRef.current] : void 0) ?? {};
		});
		let rows = [];
		const presetPathRef = { current: "" };
		try {
			const listed = await listRows(ctx, pid);
			rows = listed.rows;
			presetPathRef.current = listed.presetPath;
		} catch (error) {
			state.lastCheck = {
				at: Date.now(),
				ok: false,
				detail: `listPreset failed: ${messageOf(error)}`
			};
			return out;
		}
		let intents = {};
		try {
			intents = await readIntents();
			for (const [serverName, entryId] of [...state.entryIds]) {
				if (!state.mounts.has(serverName)) {
					state.entryIds.delete(serverName);
					continue;
				}
				const row = rows.find((r) => r.serverName === serverName);
				if (!row) continue;
				if (intents[row.rowId]?.desired !== true) continue;
				try {
					await ctx.loader.remove(entryId);
				} catch (error) {
					const msg = messageOf(error);
					if (/not found|cannot resolve|no such|不存在|已失效|already removed/i.test(msg)) {} else {
						ctx.logger.warn?.(`mcp-skill-panel: gateway unmount "${serverName}" failed, retry next round: ${msg}`);
						continue;
					}
				}
				state.entryIds.delete(serverName);
				state.mounts.delete(serverName);
				out.unmounted.push(serverName);
			}
		} catch {}
		const loaderServers = /* @__PURE__ */ new Set();
		try {
			for (const entry of ctx.loader.entries()) {
				if (!isMcpEntry(entry)) continue;
				loaderServers.add(serverNameOf(entry));
			}
		} catch {}
		for (const row of rows) {
			if (intents[row.rowId]?.desired === true) {
				out.skipped.push(row.serverName);
				continue;
			}
			const decision = decideMount(row.serverName, row.config, row.disabled, state.mounts, loaderServers.has(row.serverName));
			if (decision === "skip") {
				out.skipped.push(row.serverName);
				continue;
			}
			if (decision === "skip-official") {
				out.skippedOfficial.push(row.serverName);
				continue;
			}
			if (decision === "reuse") {
				out.reused.push(row.serverName);
				continue;
			}
			const entryId = gatewayEntryId(row.serverName);
			try {
				await ctx.loader.create({
					id: entryId,
					name: MCP_CLIENT_NAME,
					config: { ...row.config },
					disabled: false
				});
				state.mounts.set(row.serverName, Date.now());
				state.entryIds.set(row.serverName, entryId);
				out.mounted.push(row.serverName);
			} catch (error) {
				out.errors.push({
					server: row.serverName,
					error: messageOf(error)
				});
				ctx.logger.warn?.(`mcp-skill-panel: gateway mount "${row.serverName}" failed: ${messageOf(error)}`);
			}
		}
		const ok = out.errors.length === 0;
		state.lastCheck = {
			at: Date.now(),
			ok,
			detail: `mounted=${out.mounted.length} reused=${out.reused.length} skipped=${out.skipped.length} skippedOfficial=${out.skippedOfficial.length} unmounted=${out.unmounted.length} errors=${out.errors.length}`
		};
		return out;
	} finally {
		state.syncing = false;
	}
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
* 解析待生效意图对应的行句柄：loader 优先，preset 行回落 standing 树（0.5.7）。
* 两者都 miss 才视为行已失效（调用方清队列）。
*/
function resolvePendingEntry(ctx, entryId) {
	try {
		const entry = ctx.loader.resolve(entryId);
		if (entry) return entry;
	} catch {}
	return findStandingEntryById(entryId);
}
/**
* 应用整条待生效队列：对每项 entry.update(desired)；用户启用方向 markUserEnabled
* （清 AI 标记 → 转为「用户打开」语义，回收器不再回收）。成功即从队列清除；
* 失败保留（下个边界重试）。返回实际应用数。调用方负责收尾 single invalidateMcp。
*/
async function applyPendingMcp(deps) {
	const { ctx } = deps;
	let applied = 0;
	for (const [entryId, pending] of [...pendingMcp.entries()]) try {
		const entry = resolvePendingEntry(ctx, entryId);
		if (!entry || !isMcpEntry(entry)) {
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
	for (const entry of [...ctx.loader.entries(), ...standingMcpEntries()]) {
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
//#region src/collect.ts
/** 分域缓存 TTL：事件驱动失效为主，TTL 只是兜底（事件丢失场景） */
const DOMAIN_TTL_MS = 6e4;
/** 已确认的 skill 状态在 collectState 中覆盖 snapshot 旧值的有效期 */
const CONFIRMED_SKILL_TTL_MS = 6e4;
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
/**
* 进程级共享的 scope key（standing 层）。
*
* 关键坑（2026-08-27 实测）：HTTP 请求路径（routes 的 httpCtx）下既解析不到
* agent（roots/list 空或非目标）也拿不到 agentPresets.standingKeyFor()（该服务
* 视图受限）→ scope key 恒 undefined → schemas 落入空视图，面板聚合全 0
* （filesystem 等「无工具」）。而 apply 早期 ctx 下 standingKeyFor() 可解析
* （快照路径一直正常，lastMcpTools=17）。
* 解法：scope key 在 apply 早期解析一次并缓存（进程级单例），所有路径复用。
*/
let sharedScopeKey;
/** scope key 解析来源（NIT-1：scopeDiag 现场取证用）：'agent' | 'standing' | null。 */
let sharedScopeKeySource = null;
async function resolveCollectScopeKey(ctx, sessionId) {
	if (sharedScopeKey !== void 0) return sharedScopeKey;
	try {
		const agent = resolveAgent(ctx, sessionId);
		if (agent) {
			const key = scopeOf(agent.ctx);
			if (key !== void 0) {
				sharedScopeKey = key;
				sharedScopeKeySource = "agent";
				return key;
			}
		}
	} catch {}
	try {
		const key = await ctx.agentPresets.standingKeyFor();
		if (key !== void 0) {
			sharedScopeKey = key;
			sharedScopeKeySource = "standing";
			return key;
		}
	} catch {}
	return sharedScopeKey;
}
/** scope key 解析来源（/debug scopeDiag 展示用）。 */
function scopeKeySource() {
	return sharedScopeKeySource;
}
/** 行状态徽标判定（纯函数，selftest 表驱动回归）。
* 语义（2026-08-27 发布前独立审查修正）：active/idle 以 **liveTools**（真实注册）
* 为准——displayTools 含 catalog 快照兜底，用它判定 active 会掩盖「scope 解析
* 失败但 catalog 有旧快照」的故障现场（面板显示健康而实际工具未注册）。
* displayTools 仅用于 tools/tokens 数值展示与停用态回填。
*/
function computeStatus(disabled, running, liveTools) {
	if (disabled) return "disabled";
	if (!running) return "failed";
	return liveTools > 0 ? "active" : "idle";
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
/**
* 按 name 去重合并两个 schemas 视图（scoped 优先）。
*
* ⚠️ 2026-08-27 实测结论：`tools.schemas()`（无参全局视图）**不含任何 mcp__ 工具**
* （全部 mcp 工具注册在 scope 层）→ 本合并当前环境恒为 no-op，属**防御性合并**：
* 若未来出现联邦/全局作用域注册的 mcp 工具，此路径才生效。filesystem 等 patch 层
* server 此前「无工具」的真正根因是 HTTP 路径 scope key 解析失败（3872206 共享缓存
* 修复），与全局视图无关——维护时勿按旧注释误判为「全局 realm 有工具」。
* 同名条目 scoped 优先（占位条目会压过全局完整 schema，当前两视图同源不触发）。
*/
function mergeSchemas(scoped, global) {
	if (!global || global.length === 0) return scoped;
	const seen = /* @__PURE__ */ new Set();
	for (const schema of scoped) seen.add(String(schema?.name ?? ""));
	const out = scoped.slice();
	for (const schema of global) {
		const name = String(schema?.name ?? "");
		if (name.length === 0 || seen.has(name)) continue;
		seen.add(name);
		out.push(schema);
	}
	return out;
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
		if (scopeKey) schemas = mergeSchemas(schemas, getSchemasView(ctx, caches, void 0, DOMAIN_TTL_MS));
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
	const scopeKey = await resolveCollectScopeKey(ctx, sessionId);
	const cwd = agent?.session?.header?.cwd ?? void 0;
	const { byServer, mcpToolsTotal, mcpTokensTotal } = getMcpAggregate(ctx, deps.caches, scopeKey, errors);
	let schemas = getSchemasView(ctx, deps.caches, scopeKey, DOMAIN_TTL_MS);
	if (scopeKey) schemas = mergeSchemas(schemas, getSchemasView(ctx, deps.caches, void 0, DOMAIN_TTL_MS));
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
			const status = computeStatus(disabled, running, liveTools);
			const transportRaw = mcpEntryConfig(entry)?.transport;
			const toolDisabled = disabledToolsOf(serverName, projectWorkspace);
			let toolList = toolsByServer.get(serverName);
			if (!toolList && catalogInfo) toolList = catalogInfo.tools.map((tool) => ({
				name: String(tool.name ?? ""),
				description: String(tool.description ?? "")
			}));
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
				workspace: projectWorkspace,
				source: gatewayServerOfEntryId(entry.id) !== null ? "gateway" : "live"
			});
		}
		mcp.sort((a, b) => a.serverName.localeCompare(b.serverName));
	} catch (error) {
		errors.push(`loader.entries: ${messageOf(error)}`);
	}
	try {
		const presetId = agent ? ctx.agentPresets.composedPreset(agent.ctx) ?? null : null;
		if (presetId) try {
			const { rows: presetRows } = await listPresetMcpRows(ctx, presetId);
			const liveServers = new Set(mcp.map((row) => row.serverName));
			for (const pr of presetRows) {
				if (liveServers.has(pr.serverName)) continue;
				const projectWorkspace = projectServerOwner(pr.serverName);
				const agg = byServer.get(pr.serverName);
				const liveTools = agg?.tools ?? 0;
				const rowDesired = state?.mcp?.[pr.file]?.[pr.rowId]?.desired;
				const pendingHit = pendingMcp.get(pr.entryId);
				const pendingFlag = pendingHit ? pendingHit.disabled !== pr.disabled : rowDesired !== void 0 ? rowDesired !== pr.disabled : false;
				const catalogInfo = deps.catalogRuntime.catalog[pr.serverName];
				const displayTools = liveTools > 0 ? liveTools : catalogInfo?.tools.length ?? 0;
				const displayTokens = liveTools > 0 ? agg?.tokens ?? 0 : catalogTokens(deps.catalogRuntime, pr.serverName, catalogInfo);
				const status = computeStatus(pr.disabled, pr.running, liveTools);
				const toolDisabled = disabledToolsOf(pr.serverName, projectWorkspace);
				let toolList = toolsByServer.get(pr.serverName);
				if (!toolList && catalogInfo) toolList = catalogInfo.tools.map((tool) => ({
					name: String(tool.name ?? ""),
					description: String(tool.description ?? "")
				}));
				mcp.push({
					entryId: pr.entryId,
					rowId: pr.rowId,
					serverName: pr.serverName,
					transport: pr.transport,
					disabled: pr.disabled,
					running: pr.running,
					tools: displayTools,
					tokens: displayTokens,
					toolList: toolList?.map((tool) => ({
						name: tool.name,
						description: tool.description,
						disabled: toolDisabled.has(tool.name)
					})) ?? null,
					status,
					modelVisible: !pr.disabled && !(deps.catalogRuntime.autoManage && (deps.controller?.isAiEnabled(pr.serverName) ?? false)),
					desired: rowDesired,
					pending: pendingFlag,
					workspace: projectWorkspace,
					source: "preset"
				});
			}
			mcp.sort((a, b) => a.serverName.localeCompare(b.serverName));
		} catch (error) {
			errors.push(`preset-mcp: ${messageOf(error)}`);
		}
	} catch (error) {
		errors.push(`preset-mcp: ${messageOf(error)}`);
	}
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
//#region src/routes.ts
/**
* HTTP 路由层：控制动作（toggleMcp/toggleSkill）与全部 /api/mcp-skill-panel/* 端点。
*
* 从 index.ts 拆出（可维护性批次 P1-1），并收敛端点样板（P2-6）：
* defineHandler 统一 method 校验 / 异步错误响应 / {ok:true,...} 包装。
*/
/**
* B4：网关行 serverName → 当前会话 preset 行定位（entryId 映射不到 preset entryId，
* 按 serverName 精确匹配；presetId 取当前会话 composedPreset，无会话返回 undefined）。
*/
async function findPresetRowByServerNameLike(ctx, serverName) {
	try {
		const { resolveAgent } = await import("./collect-D0sDRhuc.mjs");
		const agent = resolveAgent(ctx, void 0);
		const presetId = agent ? ctx.agentPresets.composedPreset(agent.ctx) ?? null : null;
		if (!presetId) return void 0;
		const row = await findPresetRowByServerName(ctx, presetId, serverName);
		if (!row) return void 0;
		return {
			presetId,
			row,
			presetPath: row.file
		};
	} catch {
		return;
	}
}
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
* guardPosts=true 时仅 POST 需要 x-panel-token（GET 只读端点始终开放，
* 与 0.4.7+「读端点开放、写操作鉴权」的设计一致；2026-08-27 修复：此前
* guardPosts 对 GET 也生效，/config 读取被锁 → 面板生效时机恒显示默认值）。
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
		handle(entry.method, entry.run, guardPosts && entry.method === "POST")(req, res);
	};
}
async function toggleMcp(deps, entryId, disabled, applyMode) {
	const { ctx } = deps;
	const mode = applyMode ?? stateApplyMode(await readState());
	let entry;
	try {
		entry = ctx.loader.resolve(entryId);
	} catch {
		entry = void 0;
	}
	if (!entry) entry = findStandingEntryById(entryId);
	if (!entry || gatewayServerOfEntryId(entryId) !== null) {
		const gwServer = gatewayServerOfEntryId(entryId);
		const found = (gwServer ? await findPresetRowByServerNameLike(ctx, gwServer).catch(() => void 0) : void 0) ?? await findPresetRowByEntryId(ctx, entryId).catch(() => void 0);
		if (found) {
			const state = await readState();
			state.mcp ??= {};
			state.mcp[found.presetPath] ??= {};
			let fileState = found.row.disabled;
			try {
				const { rowDisabledState } = await import("./preset-ByFnKr7g.mjs").then((n) => n.r);
				fileState = rowDisabledState(await readFile(found.presetPath, "utf8"), found.row.rowId);
			} catch {
				fileState = found.row.disabled;
			}
			state.mcp[found.presetPath][found.row.rowId] = {
				desired: disabled,
				lastApplied: fileState
			};
			await writeState(state);
			pendingMcp.set(entryId, {
				entryId,
				file: found.presetPath,
				rowId: found.row.rowId,
				disabled
			});
			if (!disabled && deps.controller) deps.controller.markUserEnabled(found.row.serverName);
			return {
				entryId,
				rowId: found.row.rowId,
				serverName: found.row.serverName,
				disabled,
				desired: disabled,
				running: found.row.running,
				persisted: true,
				file: found.presetPath,
				applied: false,
				pending: true,
				source: "gateway"
			};
		}
	}
	if (!entry) throw new Error(`entry "${entryId}" is not an MCP row`);
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
	if (deferred) {
		pendingMcp.set(entryId, {
			entryId,
			file: (entry.parent?.tree)?.filename ?? null,
			rowId,
			disabled
		});
		const presetFile = (entry.parent?.tree)?.filename;
		if (typeof presetFile === "string" && presetFile.length > 0) try {
			const st = await readState();
			st.mcp ??= {};
			st.mcp[presetFile] ??= {};
			let fileState = null;
			try {
				fileState = rowDisabledState(await readFile(presetFile, "utf8"), rowId);
			} catch {
				fileState = null;
			}
			st.mcp[presetFile][rowId] = {
				desired: disabled,
				lastApplied: fileState
			};
			await writeState(st);
		} catch (error) {
			ctx.logger.warn?.(`mcp-skill-panel: persist pending intent for "${entryId}" failed: ${messageOf(error)}`);
		}
	} else {
		pendingMcp.delete(entryId);
		if (disabled) {
			const presetSnapshot = deps.catalogRuntime.catalog[serverNameOf(entry)];
			if (!presetSnapshot || presetSnapshot.tools.length === 0) try {
				await deps.controller?.fetchInventory(serverNameOf(entry), 1500);
			} catch (error) {
				ctx.logger.warn?.(`mcp-skill-panel: pre-close inventory snapshot for "${serverNameOf(entry)}" failed: ${messageOf(error)}`);
			}
		}
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
/** 已存在检查：loader 存活行、standing 行或 patch 文本里已有同 id。 */
function existingRowIds(ctx, patchText) {
	const ids = /* @__PURE__ */ new Set();
	for (const entry of [...ctx.loader.entries(), ...standingMcpEntries()]) {
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
				let gateway;
				let controller;
				let inventory;
				try {
					const { gatewayStateForDebug, controllerStatusForDebug, inventoryTraceForDebug } = await import("./index.js");
					gateway = gatewayStateForDebug();
					controller = controllerStatusForDebug();
					inventory = inventoryTraceForDebug();
				} catch {
					gateway = void 0;
					controller = void 0;
				}
				let reaper;
				let counters;
				try {
					const { reaperDiagnostics, controllerCounters } = await import("./mcpcall-D1ec91Q6.mjs");
					reaper = reaperDiagnostics();
					counters = controllerCounters();
				} catch {
					reaper = void 0;
					counters = void 0;
				}
				const scopeDiag = { error: null };
				try {
					const scopeKey = await resolveCollectScopeKey(ctx, void 0);
					const scoped = scopeKey ? getSchemasView(ctx, caches, scopeKey, DOMAIN_TTL_MS) : [];
					const globalView = getSchemasView(ctx, caches, void 0, DOMAIN_TTL_MS);
					const mcpNames = (scopeKey ? mergeSchemas(scoped, globalView) : scoped).map((s) => String(s?.name ?? "")).filter((name) => name.startsWith("mcp__"));
					const scopedMcp = scoped.map((s) => String(s?.name ?? "")).filter((name) => name.startsWith("mcp__"));
					const globalMcp = globalView.map((s) => String(s?.name ?? "")).filter((name) => name.startsWith("mcp__"));
					scopeDiag.scopeKeyType = scopeKey ? typeof scopeKey : null;
					scopeDiag.scopeKeySource = scopeKeySource();
					scopeDiag.scopedTotal = scoped.length;
					scopeDiag.scopedMcpTools = scopedMcp.length;
					scopeDiag.globalTotal = globalView.length;
					scopeDiag.globalMcpTools = globalMcp.length;
					scopeDiag.mergedMcpTools = mcpNames.length;
					scopeDiag.scopedMcpSample = scopedMcp.slice(0, 20);
					scopeDiag.globalMcpSample = globalMcp.slice(0, 20);
				} catch (error) {
					scopeDiag.error = messageOf(error);
				}
				return {
					diag: catalogRuntime.diag,
					catalog,
					scopeDiag,
					standingDiag: standingDiag(),
					...controller ? { controllerStatus: controller } : {},
					...inventory !== void 0 ? { inventoryTrace: inventory } : {},
					...reaper !== void 0 ? { reaper } : {},
					...counters !== void 0 ? { counters } : {},
					...gateway ? { gateway } : {}
				};
			})
		},
		{
			kind: "exact",
			path: `${API_PREFIX}/debug/collect`,
			handler: handle("POST", async () => {
				try {
					const { ensureOpenMountsForDebug } = await import("./index.js");
					await ensureOpenMountsForDebug().catch(() => void 0);
				} catch {}
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
let debugGatewayState = null;
function gatewayStateForDebug() {
	if (!debugGatewayState) return {
		mounted: [],
		lastCheck: null
	};
	return {
		mounted: [...debugGatewayState.mounts.keys()].sort(),
		lastCheck: debugGatewayState.lastCheck
	};
}
/**
* 0.5.8：/debug 只读曝光「临时启用控制器」的内部状态。
*
* 取证教训（0.5.7 首次实测「拉起后是否自动回收」）：当时只有「最终没关」这一个
* 事实，看不到 aiEnabled 集合是否真的收下了这个 server，也看不到回收器每轮的
* 判定输入，导致一轮实验不可判。此函数与 `reaperDiagnostics()` 一起把那条链
* 全部落成读数：`aiOwned`（回收器唯一作用域）+ 每轮 keepAliveMs/候选/跳过原因。
*/
let debugControllerStatus = null;
function controllerStatusForDebug() {
	if (!debugControllerStatus) return { aiOwned: [] };
	const now = Date.now();
	return { aiOwned: debugControllerStatus().map((row) => ({
		...row,
		idleMs: now - row.lastUsed
	})) };
}
/** 0.6.3：能力表采集的逐阶段痕迹（/debug 的 inventoryTrace）。 */
function inventoryTraceForDebug() {
	return inventoryTraceDiag();
}
/** P5（W3）：/debug/collect 先挂载后快照的挂载入口（无 control 闭包时 no-op）。 */
let debugEnsureOpenMounts = null;
function ensureOpenMountsForDebug() {
	if (!debugEnsureOpenMounts) return Promise.resolve(void 0);
	return debugEnsureOpenMounts();
}
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
	searchLimitDefault: Schema.number().min(1).description("mcp_search 缺省 top-K").default(8),
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
	return findStandingEntryByServer(serverName);
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
* 关键坑（v0.4.1 + 2026-08-27）：HTTP/apply ctx 下 agents/standingKeyFor 视图
* 受限（roots/list 空或服务不可解析）。统一走 collect.resolveCollectScopeKey 的
* 进程级缓存：apply 早期预热一次，快照与面板路径共用同一 standing scope key。
*/
async function resolveScopeSchemas(ctx, caches) {
	const scopeKey = await resolveCollectScopeKey(ctx, void 0);
	if (scopeKey === void 0) return [];
	return getSchemasView(ctx, caches, scopeKey, 500);
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
		const rowsByName = /* @__PURE__ */ new Map();
		for (const entry of [...ctx.loader.entries(), ...standingMcpEntries()]) {
			if (!isMcpEntry(entry)) continue;
			if (!rowsByName.has(serverNameOf(entry))) rowsByName.set(serverNameOf(entry), entry);
		}
		for (const [serverName, entry] of rowsByName) {
			if (entry.disabled) continue;
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
		for (const entry of [...ctx.loader.entries(), ...standingMcpEntries()]) {
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
	const presetRowCache = /* @__PURE__ */ new Map();
	const cachedPresetRow = async (agent, serverName) => {
		try {
			const live = agent ?? ctx.agents.roots()[0] ?? ctx.agents.list()[0];
			const presetId = live ? ctx.agentPresets.composedPreset(live.ctx) ?? null : null;
			if (!presetId) return void 0;
			const key = `${presetId}\0${serverName}`;
			const hit = presetRowCache.get(key);
			if (hit && Date.now() - hit.at < 6e4) return hit.row;
			const row = await findPresetRowByServerName(ctx, presetId, serverName);
			presetRowCache.set(key, {
				at: Date.now(),
				row
			});
			if (presetRowCache.size > 500) {
				const oldest = presetRowCache.keys().next();
				if (!oldest.done) presetRowCache.delete(oldest.value);
			}
			return row;
		} catch {
			return;
		}
	};
	return {
		keepAliveMs: config.keepAliveMs ?? 3e4,
		searchLimitDefault: config.searchLimitDefault ?? 8,
		searchLimitMax: config.searchLimitMax ?? 10,
		serverSummary: config.serverSummary ?? {},
		getCatalog: () => runtime.catalog,
		setCatalog: (catalog) => {
			runtime.catalog = catalog;
		},
		persistCatalog: () => persistCatalog(() => ctx, runtime),
		resolveEntry: (serverName) => findMcpEntry(ctx, serverName),
		serverTimeoutMs: (serverName) => serverTimeoutMs(ctx, serverName),
		resolvePresetRow: async (serverName, agent) => cachedPresetRow(agent, serverName),
		resolvePresetConfig: async (serverName, agent) => {
			try {
				return (await cachedPresetRow(agent, serverName))?.config;
			} catch {
				return;
			}
		},
		presetTimeoutMs: async (serverName) => {
			try {
				return (await cachedPresetRow(void 0, serverName))?.toolCallTimeoutMs;
			} catch {
				return;
			}
		},
		setAiOwner: (entryId, at) => setStateAiOwner(entryId, at),
		clearAiOwner: (entryId) => clearStateAiOwner(entryId),
		snapshotEnabled: () => snapshotEnabled(ctx, runtime, caches),
		requestSnapshot: () => snapshotEnabled(ctx, runtime, caches),
		/**
		* 0.6.0：按需采集能力表（mcp_search 命中「已安装但无快照」的关闭行时）。
		* 行此刻已被调用方临时拉起，这里只负责采 schema 快照 + 落 catalog.json。
		*/
		collectInventory: async (serverName) => {
			const schemas = await resolveScopeSchemas(ctx, caches);
			const tools = snapshotFromSchemas(schemas, serverName);
			if (tools.length === 0) return null;
			runtime.catalog = {
				...runtime.catalog,
				[serverName]: {
					tools,
					fetchedAt: Date.now(),
					source: "live"
				}
			};
			runtime.dirty = true;
			persistCatalog(() => ctx, runtime);
			return {
				tools: tools.length,
				joined: false
			};
		},
		/** 0.6.0：已安装的 MCP server 清单（含用户关闭的，来自 standing 树）。 */
		installedInventory: () => installedMcpRows().map((row) => ({
			server: row.serverName,
			open: row.open
		})),
		/**
		* 0.6.2：由调用方（命中视图）采到的 schema 落 catalog —— **首选**采集路径。
		* 0.6.1 的采空 bug 正是口径不一致所致（见 mcpcall.ts collectInventory 注释），
		* 这里只做过滤与落盘，采集口径由调用方给定。
		*/
		storeInventory: async (serverName, schemas) => {
			const tools = snapshotFromSchemas(schemas, serverName);
			if (tools.length === 0) return null;
			runtime.catalog = {
				...runtime.catalog,
				[serverName]: {
					tools,
					fetchedAt: Date.now(),
					source: "live"
				}
			};
			runtime.dirty = true;
			persistCatalog(() => ctx, runtime);
			return {
				tools: tools.length,
				joined: false
			};
		}
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
		const put = (entry) => {
			if (!isMcpEntry(entry)) return;
			const serverName = serverNameOf(entry);
			const visible = !entry.disabled && !controller.isAiEnabled(serverName);
			const prev = map.get(serverName);
			map.set(serverName, prev === void 0 ? visible : prev && visible);
		};
		for (const entry of ctx.loader.entries()) put(entry);
		for (const entry of standingMcpEntries()) put(entry);
		return map;
	};
	let autoDisposers = [];
	const gatewayState = createGatewayState();
	debugGatewayState = gatewayState;
	debugControllerStatus = () => controller.status();
	debugEnsureOpenMounts = () => ensureOpenMounts({
		ctx,
		control,
		state: gatewayState
	});
	catalogRuntime.applyAutoManage = (on) => {
		for (const d of autoDisposers) d();
		autoDisposers = [];
		disposeGatewayStateSync(ctx, gatewayState);
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
		ensureOpenMounts({
			ctx,
			control,
			state: gatewayState
		}).catch((error) => {
			ctx.logger.warn(`mcp-skill-panel: gateway ensureOpenMounts failed: ${messageOf(error)}`);
		});
	};
	ctx.effect(() => () => {
		for (const d of autoDisposers) d();
		disposeGatewayStateSync(ctx, gatewayState);
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
export { Config, GATEWAY_ENTRY_PREFIX, confirmedSkills as a, apply, applyPendingMcp, buildSkillMd, pruneExpired as c, checkChildVisible, computeStatus, controllerStatusForDebug, createGatewayState, scopeKeySource as d, decideMount, disabledToolsOf, disposeGatewayState, disposeGatewayStateSync, ensureOpenMounts, ensureOpenMountsForDebug, controllerCounters as f, findPresetRowByServerName, reaperDiagnostics as g, gatewayCall, gatewayEntryId, gatewayServerOfEntryId, gatewayStateForDebug, inventoryTraceDiag as h, collectSkills as i, inject, installProjectMcp, inventoryTraceForDebug, isToolDisabled, isValidSkillName, isolateChildScope, resolveAgent as l, loadDisabledTools, installMcpControlTools as m, mergeSchemas, msgOf, DOMAIN_TTL_MS as n, name, normalizeArguments, normalizeToolName, createDomainCaches as o, createMcpCallController as p, parsePresetMcpText, pendingMcp, pendingMcpCount, presetConfigOf, projectServerName, projectServerOwner, collectMcp as r, readState, remountWorkspace, rowDisabledState, getSchemasView as s, scanWorkspaceMcp, setRowFlag, setSkillFlag, setToolDisabled, syncPresetFiles, CONFIRMED_SKILL_TTL_MS as t, resolveCollectScopeKey as u, writeState };
