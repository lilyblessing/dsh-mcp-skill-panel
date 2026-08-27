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
import { disabledToolsOf } from './tool-disable'
import type { CatalogServer } from './catalog'
import { serverOfMcp } from './catalog'
import type { McpCallController } from './mcpcall'
import type { CatalogRuntime } from './index'
import { messageOf } from './util'
import { readState } from './state'

/** 分域缓存 TTL：事件驱动失效为主，TTL 只是兜底（事件丢失场景） */
export const DOMAIN_TTL_MS = 60_000
/** 已确认的 skill 状态在 collectState 中覆盖 snapshot 旧值的有效期 */
export const CONFIRMED_SKILL_TTL_MS = 60_000
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
 * 解析面板数据收集的 scope key：agent 作用域优先，不可得时 fallback
 * `agentPresets.standingKeyFor()`（注册表查询，不依赖 agent 实例）。
 *
 * 关键坑（2026-08-27 实测）：HTTP 请求路径（routes 的 httpCtx）下
 * `agents.roots()/list()` 解析不到/解析到错误的 agent → scopeKey=undefined →
 * getSchemasView 落到全局视图，而全部 mcp 工具注册在 agent scope 的 schemas
 * 内 → 面板聚合恒为 0（工具数/工具列表/toolList 全缺，仅 catalog 回填文字仍在）。
 * 与 index.resolveScopeSchemas（快照路径）保持同一解析策略。
 */
export async function resolveCollectScopeKey(ctx: Context, sessionId: string | undefined): Promise<object | undefined> {
  try {
    const agent = resolveAgent(ctx, sessionId)
    if (agent) return scopeOf(agent.ctx)
  } catch {
    /* fall through */
  }
  try {
    return await ctx.agentPresets.standingKeyFor()
  } catch {
    return undefined
  }
}

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
 * 面板聚合需要「agent scope + 全局视图」并集：
 * profile patch 层（cordis.patch.yml）与根树直接创建的 server（如 filesystem、
 * web-fetch-http）工具注册在全局 realm，不在 agent scope 的 schemas 内，
 * 只查 scoped 会漏掉这些 server（面板显示无工具、无工具级禁用列表）。
 * 纯函数，selftest 可覆盖。
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

async function collectMcp(deps: Deps, sessionId: string | undefined): Promise<McpView> {
  const { ctx } = deps
  const errors: string[] = []
  const agent = resolveAgent(ctx, sessionId)
  const scopeKey = await resolveCollectScopeKey(ctx, sessionId)
  const cwd = agent?.session?.header?.cwd ?? undefined

  // MCP：loader 行 × schema 聚合（聚合结果版本化复用）
  const { byServer, mcpToolsTotal, mcpTokensTotal } = getMcpAggregate(ctx, deps.caches, scopeKey, errors)
  // 共享 schemas 缓存（路径 A/B 同源）：构建 per-server 工具列表（面板工具级禁用用）。
  // 同样合并全局视图：patch 层 server（filesystem 等）的工具列表需要出现在面板。
  let schemas = getSchemasView(ctx, deps.caches, scopeKey, DOMAIN_TTL_MS)
  if (scopeKey) schemas = mergeSchemas(schemas, getSchemasView(ctx, deps.caches, undefined, DOMAIN_TTL_MS))
  const toolsByServer = new Map<string, Array<{ name: string; description: string }>>()
  for (const schema of schemas) {
    const name = String(schema?.name ?? '')
    if (!name.startsWith('mcp__')) continue
    const server = serverOfMcp(name)
    if (server === null) continue
    let list = toolsByServer.get(server)
    if (!list) {
      list = []
      toolsByServer.set(server, list)
    }
    list.push({ name, description: String(schema?.description ?? '') })
  }
  for (const list of toolsByServer.values()) list.sort((a, b) => a.name.localeCompare(b.name))

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
      const displayTools = liveTools > 0 ? liveTools : catalogInfo?.tools.length ?? 0
      const displayTokens =
        liveTools > 0 ? (agg?.tokens ?? 0) : catalogTokens(deps.catalogRuntime, serverName, catalogInfo)
      const status: McpRow['status'] = disabled
        ? 'disabled'
        : running
          ? liveTools > 0
            ? 'active'
            : 'idle'
          : 'failed'
      const transportRaw = mcpEntryConfig(entry)?.transport
      // 项目行查所属工作区的项目禁用表；全局行查全局表（disabledToolsOf 内部按 owner 分派）
      const toolDisabled = disabledToolsOf(serverName, projectWorkspace)
      let toolList = toolsByServer.get(serverName)
      if (!toolList && catalogInfo) {
        // 兜底：schemas 视图缺失该 server（scope 解析异常等）时用 catalog 快照
        // 构建工具列表（CatalogEntry.name 是全名 mcp__<server>__<tool>，
        // 与聚合产物和禁用表完全同构）。保证工具级禁用 UI 始终可用。
        toolList = catalogInfo.tools.map((tool) => ({ name: String(tool.name ?? ''), description: String(tool.description ?? '') }))
      }
      mcp.push({
        entryId: entry.id,
        rowId: entry.options.id,
        serverName,
        transport: transportRaw ? String(transportRaw) : null,
        disabled,
        running,
        tools: displayTools,
        tokens: displayTokens,
        toolList: toolList?.map((tool) => ({ name: tool.name, description: tool.description, disabled: toolDisabled.has(tool.name) })) ?? null,
        status,
        modelVisible:
          !disabled &&
          !(deps.catalogRuntime.autoManage && (deps.controller?.isAiEnabled(serverName) ?? false)),
        desired: rowDesired,
        pending: rowDesired !== undefined ? rowDesired !== disabled : false,
        workspace: projectWorkspace,
      })
    }
  } catch (error) {
    errors.push(`loader.entries: ${messageOf(error)}`)
  }
  mcp.sort((a, b) => a.serverName.localeCompare(b.serverName))

  return {
    ...baseView(ctx, agent, cwd),
    mcp,
    mcpTotal: mcp.length,
    mcpDisabled: mcp.filter((row) => row.disabled).length,
    mcpToolsTotal,
    mcpTokensTotal,
    autoManage: deps.catalogRuntime.autoManage,
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