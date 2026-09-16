/**
 * 数据收集：MCP 清单（loader 行 × schema 聚合）与 Skill 清单（目录快照）。
 *
 * 从 index.ts 拆出（可维护性批次 P1-1）：collectMcp / collectSkills / 聚合缓存 /
 * 分域缓存句柄。依赖方向：本模块只被 routes.ts / index.ts 消费。
 */
import type { Context } from '@deepseek-ai/cordis'
import { scopeOf } from '@deepseek-ai/dsh-scope'
import type { McpRow, McpView, SkillsView } from './shared-types'
import { isMcpEntry, serverNameOf, mcpEntryConfig } from './mcp-entry'
import { projectServerOwner, getActiveWorkspace } from './project-mcp'
import { disabledToolsOf, isToolDisabled } from './tool-disable'
import type { CatalogServer } from './catalog'
import { serverOfMcp } from './catalog'
import type { McpCallController } from './mcpcall'
import type { CatalogRuntime } from './index'
import { messageOf } from './util'
import { readState, stateAutoManageByRoute, stateToolBudget } from './state'
import { pendingMcp } from './pending'
import { listPresetMcpRows } from './preset-mcp'
import { gatewayServerOfEntryId } from './gateway'
import { computeStatus, modelVisibleScope, rowDisplay } from './row-display'
import { activeRouteView } from './model-route'

/** 分域缓存 TTL：事件驱动失效为主，TTL 只是兜底（事件丢失场景） */
export const DOMAIN_TTL_MS = 60_000
/** 已确认的 skill 状态在 collectState 中覆盖 snapshot 旧值的有效期 */
const CONFIRMED_SKILL_TTL_MS = 60_000
/** skill toggle 确认轮询间隔（ctx.timeout，随 ctx 生命周期）。 */
export const SKILL_TOGGLE_POLL_MS = 80

/**
 * 最近一次 toggle 确认过的 skill 状态（name → modelInvocable）。
 * 服务端轮询用 skills.get 实时读文件确认，早于 snapshot 的发现缓存失效，
 * 用它覆盖 collectState 里的陈旧 candidate 值。
 */
export const confirmedSkills = new Map<string, { modelInvocable: boolean; at: number }>()

/** Skill 行视图（host 内部使用；对外形状见 shared-types 的 SkillRow）。 */
export interface SkillView {
  name: string
  description: string
  source: string
  modelInvocable: boolean
  userInvocable: boolean
  path?: string
}

export interface Deps {
  ctx: Context
  caches: DomainCaches
  catalogRuntime: CatalogRuntime
  /** 中间层控制层（mcp_call 的 AI 启用标记查询/清除）。 */
  controller?: McpCallController
}

/** 分域缓存句柄：apply 创建，makeRoutes 消费，事件失效由 apply 订阅。 */
export interface DomainCaches {
  mcpCache: Map<string, { at: number; promise: Promise<McpView> }>
  skillsCache: Map<string, { at: number; promise: Promise<SkillsView> }>
  /** MCP 工具聚合缓存（per scope），tools/change 时随 mcpCache 一起清 */
  mcpAggregates: Map<object | null, { at: number; value: McpAggregate }>
  /** schemas 原始缓存（per scope），路径 A/B 共享同一份深克隆结果 */
  schemasCache: Map<object | null, { at: number; schemas: Array<{ name?: unknown; description?: unknown; parameters?: unknown }> }>
  invalidateMcp: () => void
  invalidateSkills: () => void
}

export function createDomainCaches(): DomainCaches {
  const mcpCache = new Map<string, { at: number; promise: Promise<McpView> }>()
  const skillsCache = new Map<string, { at: number; promise: Promise<SkillsView> }>()
  const mcpAggregates = new Map<object | null, { at: number; value: McpAggregate }>()
  const schemasCache = new Map<object | null, { at: number; schemas: Array<{ name?: unknown; description?: unknown; parameters?: unknown }> }>()
  return {
    mcpCache,
    skillsCache,
    mcpAggregates,
    schemasCache,
    invalidateMcp: () => {
      mcpCache.clear()
      mcpAggregates.clear()
      schemasCache.clear()
    },
    invalidateSkills: () => skillsCache.clear(),
  }
}

function tokenEstimate(parameters: unknown): number {
  try {
    return Math.max(1, Math.round(JSON.stringify(parameters ?? {}).length / 4))
  } catch {
    return 1
  }
}

/** 写时清理过期条目（P2-8）：分域缓存 / 聚合 / 已确认 skill 的 Map 长期运行不膨胀。 */
export function pruneExpired<T>(map: Map<T, { at: number }>, now: number): void {
  for (const [key, entry] of map) {
    if (now - entry.at >= DOMAIN_TTL_MS) map.delete(key)
  }
}

/**
 * 按 scope 共享的 schemas 原始缓存：路径 A（catalog 采集）与路径 B（面板聚合）
 * 共用同一份深克隆结果，避免 tools.change 风暴期内重复深克隆。
 * key = scopeKey ?? null；TTL 由调用方指定（路径 A 500ms，路径 B 60s）。
 */
export function getSchemasView(
  ctx: Context,
  caches: DomainCaches,
  scopeKey: object | undefined,
  ttlMs: number,
): Array<{ name?: unknown; description?: unknown; parameters?: unknown }> {
  const key = scopeKey ?? null
  const now = Date.now()
  // 轻量清理：删除超过 max(ttlMs, DOMAIN_TTL_MS) 的旧条目（防驻留）
  const maxTtl = Math.max(ttlMs, DOMAIN_TTL_MS)
  for (const [k, entry] of caches.schemasCache) {
    if (now - entry.at >= maxTtl) caches.schemasCache.delete(k)
  }
  const hit = caches.schemasCache.get(key)
  if (hit && now - hit.at < ttlMs) return hit.schemas
  const schemas: Array<{ name?: unknown; description?: unknown; parameters?: unknown }> = scopeKey
    ? ctx.tools.schemas(scopeKey as Parameters<typeof ctx.tools.schemas>[0])
    : ctx.tools.schemas()
  caches.schemasCache.set(key, { at: now, schemas })
  return schemas
}

export function resolveAgent(ctx: Context, sessionId: string | undefined) {
  if (sessionId) {
    // SessionId 是品牌类型；HTTP query 字符串需显式转换
    const byId = ctx.agents.get(sessionId as Parameters<typeof ctx.agents.get>[0])
    if (byId) return byId
  }
  const roots = ctx.agents.roots()
  if (roots.length > 0) return roots[0]
  return ctx.agents.list()[0]
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
let sharedScopeKey: object | undefined
/** scope key 解析来源（NIT-1：scopeDiag 现场取证用）：'agent' | 'standing' | null。 */
let sharedScopeKeySource: 'agent' | 'standing' | null = null

export async function resolveCollectScopeKey(ctx: Context, sessionId: string | undefined): Promise<object | undefined> {
  if (sharedScopeKey !== undefined) return sharedScopeKey
  try {
    const agent = resolveAgent(ctx, sessionId)
    if (agent) {
      const key = scopeOf(agent.ctx)
      if (key !== undefined) {
        sharedScopeKey = key
        sharedScopeKeySource = 'agent'
        return key
      }
    }
  } catch {
    /* fall through */
  }
  try {
    const key = await ctx.agentPresets.standingKeyFor()
    if (key !== undefined) {
      sharedScopeKey = key as object
      sharedScopeKeySource = 'standing'
      return key as object
    }
  } catch {
    /* ignore */
  }
  return sharedScopeKey
}

/** scope key 解析来源（/debug scopeDiag 展示用）。 */
export function scopeKeySource(): 'agent' | 'standing' | null {
  return sharedScopeKeySource
}

/** 行级读数判定已拆到 ./row-display（零宿主依赖，便于 selftest 独立加载）。 */
export { computeStatus, modelVisibleScope, rowDisplay } from './row-display'

function baseView(
  ctx: Context,
  agent: ReturnType<typeof resolveAgent>,
  cwd: string | undefined,
): Pick<McpView, 'sessionId' | 'preset' | 'cwd'> {
  let preset: string | null = null
  try {
    if (agent) preset = ctx.agentPresets.composedPreset(agent.ctx) ?? null
  } catch {
    preset = null
  }
  return { sessionId: agent ? agent.id : null, preset, cwd: cwd ?? null }
}

/** MCP 工具聚合结果：per-server 工具数 + token 估算。tools/change 间隙复用，跳过 schemas 深克隆。 */
export interface McpAggregate {
  byServer: Map<string, { tools: number; tokens: number }>
  mcpToolsTotal: number
  mcpTokensTotal: number
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
export function mergeSchemas(
  scoped: Array<{ name?: unknown; description?: unknown; parameters?: unknown }>,
  global: Array<{ name?: unknown; description?: unknown; parameters?: unknown }>,
): Array<{ name?: unknown; description?: unknown; parameters?: unknown }> {
  if (!global || global.length === 0) return scoped
  const seen = new Set<string>()
  for (const schema of scoped) seen.add(String(schema?.name ?? ''))
  const out = scoped.slice()
  for (const schema of global) {
    const name = String(schema?.name ?? '')
    if (name.length === 0 || seen.has(name)) continue
    seen.add(name)
    out.push(schema)
  }
  return out
}

function computeAggregate(schemas: Array<{ name?: string; parameters?: unknown }>): McpAggregate {
  const byServer = new Map<string, { tools: number; tokens: number }>()
  let mcpToolsTotal = 0
  let mcpTokensTotal = 0
  for (const schema of schemas) {
    const server = serverOfMcp(String(schema.name ?? ''))
    if (!server) continue
    const entry = byServer.get(server) ?? { tools: 0, tokens: 0 }
    entry.tools += 1
    const est = tokenEstimate(schema.parameters)
    entry.tokens += est
    byServer.set(server, entry)
    mcpToolsTotal += 1
    mcpTokensTotal += est
  }
  return { byServer, mcpToolsTotal, mcpTokensTotal }
}

/**
 * 按 scope 复用的 MCP 聚合缓存（C 项优化）：tools.schemas 深克隆 300+ 工具是
 * collectMcp 最重的一步；聚合结果在 tools/change 事件间隙直接复用，
 * TTL 只是事件丢失时的兜底。key = scopeKey（null 表示全局视图）。
 */
function getMcpAggregate(
  ctx: Context,
  caches: DomainCaches,
  scopeKey: object | undefined,
  errors: string[],
): McpAggregate {
  const key = scopeKey ?? null
  pruneExpired(caches.mcpAggregates, Date.now())
  const hit = caches.mcpAggregates.get(key)
  if (hit && Date.now() - hit.at < DOMAIN_TTL_MS) return hit.value
  let schemas: Array<{ name?: unknown; description?: unknown; parameters?: unknown }> = []
  try {
    schemas = getSchemasView(ctx, caches, scopeKey, DOMAIN_TTL_MS)
    // 合并全局视图（profile patch 层 server 注册在全局 realm，不在 agent scope）
    if (scopeKey) schemas = mergeSchemas(schemas, getSchemasView(ctx, caches, undefined, DOMAIN_TTL_MS))
  } catch (error) {
    errors.push(`tools.schemas: ${messageOf(error)}`)
  }
  const value = computeAggregate(schemas as Array<{ name?: string; parameters?: unknown }>)
  caches.mcpAggregates.set(key, { at: Date.now(), value })
  return value
}

/** 停用态 token 估算缓存（P2-6）：fetchedAt 不变则复用，避免每次面板请求
 * 对停用 server（如 cheatengine 173 工具）全量 JSON.stringify。 */
function catalogTokens(runtime: CatalogRuntime, serverName: string, info: CatalogServer | undefined): number {
  if (!info) return 0
  const hit = runtime.tokenCache.get(serverName)
  if (hit && hit.fetchedAt === info.fetchedAt) return hit.tokens
  const tokens = info.tools.reduce((sum, t) => sum + tokenEstimate(t.parameters), 0)
  runtime.tokenCache.set(serverName, { fetchedAt: info.fetchedAt, tokens })
  return tokens
}

/**
 * 行级**工具级启用数**：按禁用集合折算该 server 的工具数与 token 估算。
 *
 * 口径（2026-09-16 移植裁量 F1）：这是「工具级启用数」而**不是**「实际进入上下文的
 * 工具数」—— 与 installToolDisableFilter 同源（同一张表、同一套作用域分派），但
 * 不减 server 级可见性（AI 临时启用 / 面板隐藏 server）与 project-mcp 的工作区过滤。
 * 面板文案不得越界声明。
 */
function effectiveOf(
  toolList: Array<{ name: string; tokens: number }> | undefined,
  toolDisabled: ReadonlySet<string>,
  fallbackTools: number,
  fallbackTokens: number,
): { toolsEnabled: number; tokensEnabled: number } {
  // 工具目录不可得（scope 异常且无 catalog 快照）：退回整行值，宁可高估也不谎报 0。
  if (!toolList) return { toolsEnabled: fallbackTools, tokensEnabled: fallbackTokens }
  let toolsEnabled = 0
  let tokensEnabled = 0
  for (const tool of toolList) {
    if (toolDisabled.has(tool.name)) continue
    toolsEnabled += 1
    tokensEnabled += tool.tokens
  }
  return { toolsEnabled, tokensEnabled }
}

/**
 * 全部工具（含 read/edit/bash/skill 等非 MCP 工具）计数 —— 工具预算红线用。
 *
 * 口径（2026-09-16 移植裁量 F2，覆盖 PR 原文）：**优先取请求面真值** ——
 * 会话上一次已落盘请求的装配后工具表（`session.requestHeader()?.tools`，
 * EpochHeader.tools = Assembled tool schemas）。它已是全部装配过滤器（工具级禁用 /
 * server 级可见性 / project-mcp 工作区）跑完的结果，对 350 这类 provider 上限是
 * 正确的比较对象；代价是有一轮延迟（读到的是上一次请求）。
 *
 * 取不到（冷启动、无会话上下文、诊断装配）时回退**注册表**口径：PR 原式的
 * `schemas.length - (mcpToolsTotal - mcpToolsEnabledTotal)`。注册表视图不等于请求面
 * （不扣 server 级隐藏与项目工作区过滤），所以是近似值 —— 调用方必须把
 * `toolsAllSource` 透出到面板与 API，不得混同。
 */
function toolsAllCounts(
  agent: ReturnType<typeof resolveAgent>,
  schemas: Array<unknown>,
  mcpToolsTotal: number,
  mcpToolsEnabledTotal: number,
): { toolsAllTotal: number; toolsAllEnabled: number; toolsAllSource: 'request' | 'registry' } {
  try {
    const tools = agent?.session?.requestHeader()?.tools
    // 请求面真值：装配后已无「工具级禁用」可扣 → total 与 enabled 同值。
    if (Array.isArray(tools)) return { toolsAllTotal: tools.length, toolsAllEnabled: tools.length, toolsAllSource: 'request' }
  } catch {
    // header 折叠异常：静默回退注册表口径（下面就是回退路径）
  }
  return {
    toolsAllTotal: schemas.length,
    toolsAllEnabled: schemas.length - (mcpToolsTotal - mcpToolsEnabledTotal),
    toolsAllSource: 'registry',
  }
}

async function collectMcp(deps: Deps, sessionId: string | undefined): Promise<McpView> {
  const { ctx } = deps
  const errors: string[] = []
  const agent = resolveAgent(ctx, sessionId)
  const scopeKey = await resolveCollectScopeKey(ctx, sessionId)
  const cwd = agent?.session?.header?.cwd ?? undefined
  // 本次装配的中间层判定（与 filter.ts 的 gateFor 同源：同一份运行期读数 + 同一个
  // decisionFor(agent)）。行徽标必须按它折算，否则 hideAll 下的「模型可见」是假声明。
  const decision = deps.catalogRuntime.decisionFor(agent)
  const hideAllActive = deps.catalogRuntime.middleLayerHides === 'all' && decision.on

  // MCP：loader 行 × schema 聚合（聚合结果版本化复用）
  const { byServer, mcpToolsTotal, mcpTokensTotal } = getMcpAggregate(ctx, deps.caches, scopeKey, errors)
  // 共享 schemas 缓存（路径 A/B 同源）：构建 per-server 工具列表（面板工具级禁用用）。
  // 同样合并全局视图：patch 层 server（filesystem 等）的工具列表需要出现在面板。
  let schemas = getSchemasView(ctx, deps.caches, scopeKey, DOMAIN_TTL_MS)
  if (scopeKey) schemas = mergeSchemas(schemas, getSchemasView(ctx, deps.caches, undefined, DOMAIN_TTL_MS))
  const toolsByServer = new Map<string, Array<{ name: string; description: string; tokens: number }>>()
  // 工具级启用数（F1 口径，见 effectiveOf）：工具级禁用不改注册表，只在装配时剔除，
  // 所以面板必须按同一谓词（isToolDisabled，与 system-prompt/assemble 的工具级过滤同源）
  // 自己复算 —— 否则「禁用 400 个工具」后面板仍显示 450，整个批量禁用毫无反馈。
  let mcpToolsEnabledTotal = 0
  let mcpTokensEnabledTotal = 0
  for (const schema of schemas) {
    const name = String(schema?.name ?? '')
    if (!name.startsWith('mcp__')) continue
    const server = serverOfMcp(name)
    if (server === null) continue
    const tokens = tokenEstimate(schema?.parameters)
    if (!isToolDisabled(name, cwd)) {
      mcpToolsEnabledTotal += 1
      mcpTokensEnabledTotal += tokens
    }
    let list = toolsByServer.get(server)
    if (!list) {
      list = []
      toolsByServer.set(server, list)
    }
    list.push({ name, description: String(schema?.description ?? ''), tokens })
  }
  for (const list of toolsByServer.values()) list.sort((a, b) => a.name.localeCompare(b.name))
  // 工具预算红线的比较对象（口径来源见 toolsAllCounts，随 toolsAllSource 一并透出）
  const { toolsAllTotal, toolsAllEnabled, toolsAllSource } = toolsAllCounts(agent, schemas, mcpToolsTotal, mcpToolsEnabledTotal)

  const mcp: McpRow[] = []
  // P1 会话边界：读一次 state.json 的 desired 意图（延迟生效模式下与 live disabled 不同，
  // 驱动 UI「待生效」徽标）。readState 有内存缓存，成本忽略。
  const state = await readState().catch(() => undefined)
  try {
    for (const entry of ctx.loader.entries()) {
      if (!isMcpEntry(entry)) continue
      const serverName = serverNameOf(entry)
      // 项目级 MCP：面板始终展示（可开关、标注工作区）；模型可见性由
      // project-mcp 的 system-prompt/assemble 过滤按会话工作空间严格把控。
      const projectWorkspace = projectServerOwner(serverName)
      const agg = byServer.get(serverName)
      const liveTools = agg?.tools ?? 0
      const running = entry.fiber !== undefined
      const disabled = entry.disabled
      // P1 会话边界：该行在预设文件下的 desired 意图与待生效判定（desired !== live disabled）。
      const tree = entry.parent?.tree as { filename?: string } | undefined
      const rowFile = tree?.filename
      const rowDesired =
        typeof rowFile === 'string' && rowFile.length > 0 ? state?.mcp?.[rowFile]?.[entry.options.id]?.desired : undefined
      // 面板联动（P3）：停用/未挂载时优先显示 catalog 目录值（工具数与 token 估算），
      // 让用户看到「该 MCP 有哪些工具可用」而不只是 0
      const catalogInfo = deps.catalogRuntime.catalog[serverName]
      // 0.6.0 诚实上报：启用+在跑却零注册 → tools=0 + unregistered，不回落目录快照
      const disp = rowDisplay(disabled, running, liveTools, catalogInfo?.tools.length ?? 0)
      const displayTools = disp.displayTools
      const displayTokens =
        liveTools > 0 ? (agg?.tokens ?? 0) : catalogTokens(deps.catalogRuntime, serverName, catalogInfo)
      const status: McpRow['status'] = disp.unregistered ? 'failed' : computeStatus(disabled, running, liveTools)
      const transportRaw = mcpEntryConfig(entry)?.transport
      // 项目行查所属工作区的项目禁用表；全局行查全局表（disabledToolsOf 内部按 owner 分派）
      const toolDisabled = disabledToolsOf(serverName, projectWorkspace)
      let toolList = toolsByServer.get(serverName)
      if (!toolList && catalogInfo) {
        // 兜底：schemas 视图缺失该 server（scope 解析异常等）时用 catalog 快照
        // 构建工具列表（CatalogEntry.name 是全名 mcp__<server>__<tool>，
        // 与聚合产物和禁用表完全同构）。保证工具级禁用 UI 始终可用。
        toolList = catalogInfo.tools.map((tool) => ({
          name: String(tool.name ?? ''),
          description: String(tool.description ?? ''),
          tokens: tokenEstimate(tool.parameters),
        }))
      }
      const effective = effectiveOf(toolList, toolDisabled, displayTools, displayTokens)
      const aiOwned = deps.catalogRuntime.autoManage && (deps.controller?.isAiEnabled(serverName) ?? false)
      const scope = modelVisibleScope(disabled, aiOwned, hideAllActive)
      mcp.push({
        entryId: entry.id,
        rowId: entry.options.id,
        serverName,
        transport: transportRaw ? String(transportRaw) : null,
        disabled,
        running,
        tools: displayTools,
        tokens: displayTokens,
        toolsEnabled: effective.toolsEnabled,
        tokensEnabled: effective.tokensEnabled,
        toolList: toolList?.map((tool) => ({ name: tool.name, description: tool.description, disabled: toolDisabled.has(tool.name) })) ?? null,
        status,
        unregistered: disp.unregistered,
        // 模型直连可见 = 装配会投放该 server 的工具（含 hideAll 折算，见 modelVisibleScope）
        modelVisible: scope === 'direct',
        modelVisibleScope: scope,
        // 0.6.0：AI 临时启用可辨识（否则与"用户打开"外观相同，见 shared-types 注释）
        aiOwned,
        desired: rowDesired,
        pending: rowDesired !== undefined ? rowDesired !== disabled : false,
        workspace: projectWorkspace,
        // P5（B4/B5）：网关 gw- 行走 loader live 分支，source 标 'gateway'（toggle
        // 走 preset 意图分支，见 toggleMcp）；running 读 entry.fiber（意图≠现实）。
        source: gatewayServerOfEntryId(entry.id) !== null ? 'gateway' : 'live',
      })
    }
    mcp.sort((a, b) => a.serverName.localeCompare(b.serverName))
  } catch (error) {
    errors.push(`loader.entries: ${messageOf(error)}`)
  }

  // rc.1 standing 组合兜底（空面板修复A，2026-09-08）：preset 行挂 standing 组合，
  // 不在 ctx.loader.entries() 里时 mcp[] 为空。此时以当前会话 preset 的 standing
  // 快照行补行：开关走 state.json desired 意图（pending 徽标），pending.ts:state.json
  // 残留补齐负责下次启动/会话边界物化（syncPresetFiles 写 preset 文件）。
  // P5 网关（2026-09-10 现网需求）：loader 有网关行时 preset 关态行消失——用户要求
  // 所有安装的 MCP 都在面板列出（开+关均可见可开关）。补行改为始终执行，loader 已有
  // 同 serverName 的行（网关 gw- 行/官方行/项目行）优先，preset 快照只补缺席的 server。
  // 关态行 toggle 走原 preset 意图分支（routes.ts），不动；开意图物化（syncPresetFiles
  // 写 preset 文件）后下轮 ensureOpenMounts 挂载（最终一致，非即时）。去重键=serverName
  //（loader 行与 preset 快照同名并存时只留 loader 行）。
  try {
    // 当前会话 preset：缺 sessionId 时 roots[0]/list[0]（与 resolveAgent 同规则）
    const presetId = agent ? (ctx.agentPresets.composedPreset(agent.ctx) ?? null) : null
    if (presetId) {
      try {
        const { rows: presetRows } = await listPresetMcpRows(ctx, presetId)
        // 去重：loader 已有同 serverName 行（网关/官方/项目）时跳过 preset 快照。
        const liveServers = new Set(mcp.map((row) => row.serverName))
        for (const pr of presetRows) {
          if (liveServers.has(pr.serverName)) continue
          const projectWorkspace = projectServerOwner(pr.serverName)
          const agg = byServer.get(pr.serverName)
          const liveTools = agg?.tools ?? 0
          const rowDesired = state?.mcp?.[pr.file]?.[pr.rowId]?.desired
          const pendingHit = pendingMcp.get(pr.entryId)
          // 从未操作过的预设行：无 pending、无 desired → pending=false（首屏不挂徽标）；
          // toggle 后（pendingHit 或 desired≠live）才挂 pending。
          const pendingFlag = pendingHit ? pendingHit.disabled !== pr.disabled : rowDesired !== undefined ? rowDesired !== pr.disabled : false
          const catalogInfo = deps.catalogRuntime.catalog[pr.serverName]
          // 0.6.0 诚实上报：与 loader 路径同判据（启用+在跑却零注册 → failed + tools=0）
          const disp = rowDisplay(pr.disabled, pr.running, liveTools, catalogInfo?.tools.length ?? 0)
          const displayTools = disp.displayTools
          const displayTokens =
            liveTools > 0 ? (agg?.tokens ?? 0) : catalogTokens(deps.catalogRuntime, pr.serverName, catalogInfo)
          const status: McpRow['status'] = disp.unregistered ? 'failed' : computeStatus(pr.disabled, pr.running, liveTools)
          const toolDisabled = disabledToolsOf(pr.serverName, projectWorkspace)
          let toolList = toolsByServer.get(pr.serverName)
          if (!toolList && catalogInfo) {
            toolList = catalogInfo.tools.map((tool) => ({
              name: String(tool.name ?? ''),
              description: String(tool.description ?? ''),
              tokens: tokenEstimate(tool.parameters),
            }))
          }
          const effective = effectiveOf(toolList, toolDisabled, displayTools, displayTokens)
          const aiOwned = deps.catalogRuntime.autoManage && (deps.controller?.isAiEnabled(pr.serverName) ?? false)
          const scope = modelVisibleScope(pr.disabled, aiOwned, hideAllActive)
          mcp.push({
            entryId: pr.entryId,
            rowId: pr.rowId,
            serverName: pr.serverName,
            transport: pr.transport,
            disabled: pr.disabled,
            running: pr.running,
            tools: displayTools,
            tokens: displayTokens,
            toolsEnabled: effective.toolsEnabled,
            tokensEnabled: effective.tokensEnabled,
            toolList: toolList?.map((tool) => ({ name: tool.name, description: tool.description, disabled: toolDisabled.has(tool.name) })) ?? null,
            status,
            unregistered: disp.unregistered,
            modelVisible: scope === 'direct',
            modelVisibleScope: scope,
            // 0.6.0：与 loader 路径同判据（AI 临时启用可辨识）
            aiOwned,
            desired: rowDesired,
            pending: pendingFlag,
            workspace: projectWorkspace,
            source: 'preset',
            // BLOCK-2 修复（2026-09-09）：preset 快照行不再向 McpView 透出全量
            // 挂载 config。config 含求值后的 secrets（exa/mimo Authorization、
            // obsidian Bearer），而 /state 是无鉴权 GET（routes.ts:546），client
            // views.tsx 零消费该字段；P4 网关走 host 侧 resolvePresetConfig
            //（index.ts），根本不需要网络传输。
          })
        }
        mcp.sort((a, b) => a.serverName.localeCompare(b.serverName))
      } catch (error) {
        errors.push(`preset-mcp: ${messageOf(error)}`)
      }
    }
  } catch (error) {
    errors.push(`preset-mcp: ${messageOf(error)}`)
  }

  return {
    ...baseView(ctx, agent, cwd),
    mcp,
    mcpTotal: mcp.length,
    mcpDisabled: mcp.filter((row) => row.disabled).length,
    mcpToolsTotal,
    mcpTokensTotal,
    mcpToolsEnabledTotal,
    mcpTokensEnabledTotal,
    toolsAllTotal,
    toolsAllEnabled,
    toolsAllSource,
    toolBudget: stateToolBudget(state ?? {}) ?? null,
    autoManage: deps.catalogRuntime.autoManage,
    // P3b：按模型分流的三个运行期读数（**取运行时而非 state.json** —— 面板要与
    // 装配期 gate 读的是同一份值：hides 由 gateFor 直接读 runtime.middleLayerHides，
    // 覆盖表由 decisionFor 读 runtime.autoManageByRoute）。
    autoManageByRoute: { ...deps.catalogRuntime.autoManageByRoute },
    // 持久化读数（state.json 的用户意图）：与上面的运行期表合看，才能区分
    // 「已配置」与「已生效」。applyAutoManage 挂载失败时会清空运行期表而 state.json
    // 不动（index.ts 的 catch），只透出运行期会让覆盖卡一行都不显示 → 用户看不到也删不掉。
    autoManageByRoutePersisted: stateAutoManageByRoute(state ?? {}),
    autoManageMounted: deps.catalogRuntime.autoManageMounted,
    middleLayerHides: deps.catalogRuntime.middleLayerHides,
    // 面板**会话**的判定（顶部徽标：「跟随当前会话 / 面板绑定会话：开启 · grok/grok-4.6」）。
    // agent 缺省/服务缺失 → source='no-route'，此时 on 回退总开关（保守维持旧行为）。
    // 会话口径（0.6.0 会话透传后）：面板**可用时**随请求带 `?session=`（客户端 session-scope.ts），
    // host 就按该会话解析；取不到会话时 `/state` 不带 session、host 按 roots[0] 解析（=旧行为）。
    // 故文案必须以**回显的 sessionId** 为准：解析成功才可说「跟随当前会话」，否则只能说
    // 「面板绑定会话」——判据在 views.tsx 的 sessionConfirmed，不得无条件断言「本会话」。
    // 投影走 model-route.ts 的 activeRouteView：与 /models 的 active 是同一份实现
    // （面板「当前路由」高亮必须与生效依据同源，两处不得各写一遍）。
    autoManageActive: activeRouteView(decision),
    activeWorkspace: getActiveWorkspace(),
    errors,
  }
}

async function collectSkills(deps: Deps, sessionId: string | undefined): Promise<SkillsView> {
  const { ctx } = deps
  const errors: string[] = []
  const agent = resolveAgent(ctx, sessionId)
  const cwd = agent?.session?.header?.cwd ?? undefined

  // Skills
  const skills: SkillView[] = []
  let skillsModelVisible = 0
  try {
    const snapshot = await ctx.skills.snapshot({ scope: agent, cwd })
    for (const summary of snapshot.skills) {
      // toggle 确认值覆盖：snapshot 的 candidate 缓存可能落后于 watcher 失效
      // （skills.get 实时读文件已确认新值，snapshot 的发现缓存要等 watcher 200ms 生效）。
      // 60s 内确认过的 skill 以确认值为准，避免 UI 翻回 + state 缓存钉住旧值。
      const confirmed = confirmedSkills.get(summary.name)
      const modelInvocable =
        confirmed && Date.now() - confirmed.at < CONFIRMED_SKILL_TTL_MS ? confirmed.modelInvocable : summary.invocation?.modelInvocable !== false
      if (modelInvocable) skillsModelVisible += 1
      skills.push({
        name: summary.name,
        description: summary.description ?? '',
        source: summary.source ?? 'unknown',
        modelInvocable,
        userInvocable: summary.invocation?.userInvocable !== false,
      })
    }
  } catch (error) {
    errors.push(`skills.snapshot: ${messageOf(error)}`)
  }

  return {
    ...baseView(ctx, agent, cwd),
    skills,
    skillsTotal: skills.length,
    skillsModelVisible,
    errors,
  }
}

export { collectMcp, collectSkills }