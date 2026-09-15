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
import Schema from '@deepseek-ai/schemastery'
import { scopeOf } from '@deepseek-ai/dsh-scope'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Entry } from '@deepseek-ai/cordis-plugin-loader'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Catalog, CatalogEntry } from './catalog'
import { snapshotFromSchemas, loadCatalog, saveCatalog } from './catalog'
import { installMcpVisibilityFilter } from './filter'
import type { McpControlCtx, McpCallController } from './mcpcall'
import { createMcpCallController, installMcpControlTools } from './mcpcall'

export { normalizeToolName, normalizeArguments, msgOf } from './mcpcall'
import { isMcpEntry, serverNameOf, mcpEntryConfig } from './mcp-entry'
import type { McpView, SkillsView, McpRow, SkillRow } from './shared-types'
import { createDomainCaches, getSchemasView, resolveCollectScopeKey, type DomainCaches } from './collect'
import { listPresetMcpRows } from './preset-mcp'
import { makeRoutes } from './routes'
import { readState, writeState, setStateAiOwner, clearStateAiOwner, stateAutoManageByRoute, stateMiddleLayerHides } from './state'
import { installRouteServices, resolveRoute, routeDecision, type ModelRoute, type RouteDecision, type RouteServices } from './model-route'
import { syncPresetFiles } from './preset'
import { applyPendingMcp } from './pending'
import { installProjectMcp, rebuildOwnersFromState } from './project-mcp'
import { loadDisabledTools, installToolDisableFilter } from './tool-disable'
import { messageOf } from './util'

export type { McpView, SkillsView, McpRow, SkillRow } from './shared-types'
export type { DomainCaches } from './collect'
// schemas 视图合并 + 状态徽标判定（selftest 回归护栏）
export { mergeSchemas, computeStatus } from './collect'
// 预设文件文本操作（selftest 回归护栏 + 潜在外部复用）
export { setRowFlag, setSkillFlag, rowDisabledState, syncPresetFiles, isValidSkillName, buildSkillMd } from './preset'
// 项目 MCP 扫描（selftest 回归护栏：根目录先读、子目录覆盖的去重规则）
export { scanWorkspaceMcp } from './project-mcp'
// 项目 MCP 运行时装配（外部复用/端到端验证：手动安装、按工作空间重扫、owner 查询）
export { installProjectMcp, remountWorkspace, projectServerOwner, projectServerName } from './project-mcp'
export { readState, writeState, stateMiddleLayerHides, stateAutoManageByRoute, stateToolBudget } from './state'
// P1 会话边界：待生效队列与边界应用入口（selftest 直接测构建产物行为）
export { applyPendingMcp, pendingMcp, pendingMcpCount, type PendingMcpEntry } from './pending'
// 工具级禁用作用域（selftest 回归护栏：全局 vs 项目工作区隔离）
export { loadDisabledTools, setToolDisabled, setToolsDisabledBulk, isToolDisabled, disabledToolsOf } from './tool-disable'
// rc.1 standing 组合 preset 行解析（selftest 回归护栏：parsePresetMcpText 文本抽取 + mcp-anki 例外）
export { parsePresetMcpText } from './preset-mcp'
// 按模型分流（selftest 回归护栏：三级回退 + 查表优先级）
export { resolveRoute, routeDecision, routeKey, type ModelRoute, type RouteDecision } from './model-route'
// 中间层控制工具名（面板/诊断展示；命名前缀铁律见 mcpcall.ts）
export { MCP_SEARCH_TOOL, MCP_CALL_TOOL, CONTROL_TOOL_NAMES } from './mcpcall'

export const name = 'runtime-inventory'

export const inject = ['fs', 'skills', 'tools', 'agents', 'agentPresets', 'loader', 'systemPrompt', 'timer']

export interface Config {
  /**
   * 形态 2（中间层代理）：停用的 MCP 对模型隐藏、经 mcp_search/mcp_call 按需调用；
   * 用户打开的 MCP 保持模型可见。默认 false（现状，纯面板）。
   */
  autoManage?: boolean
  /** 保活回收窗口（ms）。默认 30_000。 */
  keepAliveMs?: number
  /** mcp_search 缺省 top-K。默认 5。 */
  searchLimitDefault?: number
  /** mcp_search top-K 上限。默认 10。 */
  searchLimitMax?: number
  /** 能力摘要表（mcp_search 空查询时返回）。 */
  serverSummary?: Record<string, string>
}

export const Config: Schema<Config> = Schema.object({
  autoManage: Schema.boolean().description('MCP 中间层控制（停用的 MCP 经 mcp_search/mcp_call 按需调用）').default(false),
  keepAliveMs: Schema.number().min(1000).description('MCP 保活空闲回收窗口（ms）').default(30_000),
  searchLimitDefault: Schema.number().min(1).description('mcp_search 缺省 top-K').default(5),
  searchLimitMax: Schema.number().min(1).description('mcp_search top-K 上限').default(10),
  serverSummary: Schema.dict(Schema.string()).description('MCP 能力摘要表（serverName → 一句话）'),
})

/** 私有 catalog 持久化目录（与 state.ts 同目录 ~/.dsh/dsh-mcp-skill-panel）。 */
const CATALOG_DIR = join(homedir(), '.dsh', 'dsh-mcp-skill-panel')
/** mcp_call 注册/调用的默认超时（读 entry config toolCallTimeoutMs，缺省回退）。 */
const DEFAULT_TOOL_TIMEOUT_MS = 60_000
/** tools/change 后增量快照的去抖窗口。 */
const CATALOG_SNAPSHOT_DEBOUNCE_MS = 150
/** catalog 持久化写盘防抖（P1-3）：tools/change 风暴期合并写盘。 */
const CATALOG_PERSIST_DEBOUNCE_MS = 300

/** part=all（缺省）时的完整响应 */
export type RuntimeState = McpView & SkillsView

/* ── catalog 采集（P1） ───────────────────────────────────────────────── */

/** 私有 catalog 内存态 + 持久化。 */
export interface CatalogRuntime {
  catalog: Catalog
  dirty: boolean
  persisting: boolean
  /** 磁盘加载是否已完成（完成前跳过采集，防止空快照覆盖磁盘 last-good）。 */
  loaded: boolean
  /** AI 中间层总开关当前值（面板可动态切换）。 */
  autoManage: boolean
  /** 按模型覆盖表当前值（键 provider 或 provider/model）。 */
  autoManageByRoute: Record<string, boolean>
  /** 中间层生效时隐藏哪些 server：'disabled'=仅手动停用的（默认）；'all'=全部。 */
  middleLayerHides: 'disabled' | 'all'
  /** 中间层是否已实际挂载（总开关关但有 true 覆盖项时仍会挂载）。 */
  autoManageMounted: boolean
  /**
   * 动态应用 AI 中间层配置（过滤 + 控制工具 + 回收器）。
   * 挂载条件 = 总开关 on 或覆盖表里存在 true 项；具体某次装配是否生效
   * 由 {@link CatalogRuntime.decisionFor} 按模型路由决定。
   */
  applyAutoManage: (on: boolean, byRoute?: Record<string, boolean>, hides?: 'disabled' | 'all') => void
  /** 某 agent（缺省=当前解析不到）当前的中间层判定，面板与诊断共用。 */
  decisionFor: (agent: Agent | undefined) => RouteDecision
  /** 可选服务 holder（sessionProjections / agentDefaultModel），路由解析用。 */
  routeServices: RouteServices
  /** 最近一次成功写盘时间（防抖合并用）。 */
  lastPersistAt: number | null
  /** 防抖挂起的写盘 timer（ctx.timeout 创建，ctx 销毁自动清理）。 */
  persistTimer: (() => void) | undefined
  /** 停用态 token 估算缓存（P2-6）：fetchedAt 不变则复用。 */
  tokenCache: Map<string, { fetchedAt: number; tokens: number }>
  /** 诊断计数（debug 端点输出，定位采集链路问题用）。 */
  diag: {
    toolsChangeEvents: number
    snapshots: number
    lastError: string | null
    lastAt: number | null
    lastMcpTools: number | null
    lastSchemasTotal: number | null
    lastScope: boolean | null
    lastAgentRoots: number | null
    lastAgentList: number | null
    loadedAt: number | null
    loadedServers: number | null
  }
}

/** 从 loader entries 反查某 serverName 对应的 mcp 行（serverName 取自 config）。 */
function findMcpEntry(ctx: Context, serverName: string): Entry | undefined {
  for (const entry of ctx.loader.entries()) {
    if (!isMcpEntry(entry)) continue
    if (serverNameOf(entry) === serverName) return entry
  }
  return undefined
}

/** server 自己的注册/调用超时阈值。 */
function serverTimeoutMs(ctx: Context, serverName: string): number {
  const entry = findMcpEntry(ctx, serverName)
  if (!entry) return DEFAULT_TOOL_TIMEOUT_MS
  const t = mcpEntryConfig(entry)?.toolCallTimeoutMs
  return typeof t === 'number' && Number.isFinite(t) && t > 0 ? t : DEFAULT_TOOL_TIMEOUT_MS
}

function sameToolList(a: CatalogEntry[], b: CatalogEntry[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i += 1) {
    if (a[i].name !== b[i].name || a[i].description !== b[i].description) return false
  }
  return true
}

/** 原子写回 catalog.json；失败保留 dirty 标记以在下次重试。
 * P1-3：写盘后 CATALOG_PERSIST_DEBOUNCE_MS 内的新变更延迟合并（ctx.timeout 绑 ctx，
 * 卸载自动清理）；正在写盘时置 dirty 排队（finally 补一次）。 */
async function persistCatalog(next: () => Context, runtime: CatalogRuntime): Promise<void> {
  if (runtime.persisting) {
    // 正在写盘中：置 dirty 排队（finally 会补一次），而不是丢弃本次变更。
    runtime.dirty = true
    return
  }
  if (!runtime.dirty) return
  const ctx = next()
  if (runtime.lastPersistAt !== null && Date.now() - runtime.lastPersistAt < CATALOG_PERSIST_DEBOUNCE_MS) {
    runtime.persistTimer?.()
    runtime.persistTimer = ctx.timeout(() => {
      runtime.persistTimer = undefined
      void persistCatalog(next, runtime)
    }, CATALOG_PERSIST_DEBOUNCE_MS)
    return
  }
  runtime.persisting = true
  try {
    await saveCatalog(CATALOG_DIR, runtime.catalog)
    runtime.dirty = false
    runtime.lastPersistAt = Date.now()
  } catch (error) {
    ctx.logger.warn(`mcp-skill-panel: catalog persist failed: ${messageOf(error)}`)
  } finally {
    runtime.persisting = false
    if (runtime.dirty) void persistCatalog(next, runtime)
  }
}

/**
 * 解析 scope 并取 schema 视图（preset 层共享，任一 standing 即可）。
 *
 * 关键坑（v0.4.1 + 2026-08-27）：HTTP/apply ctx 下 agents/standingKeyFor 视图
 * 受限（roots/list 空或服务不可解析）。统一走 collect.resolveCollectScopeKey 的
 * 进程级缓存：apply 早期预热一次，快照与面板路径共用同一 standing scope key。
 */
async function resolveScopeSchemas(
  ctx: Context,
  caches: DomainCaches,
): Promise<Array<{ name?: unknown; description?: unknown; parameters?: unknown }>> {
  const scopeKey = await resolveCollectScopeKey(ctx, undefined)
  if (scopeKey === undefined) return []
  return getSchemasView(ctx, caches, scopeKey, 500)
}

/** 对所有当前 enabled 的 mcp server 重新快照。 */
async function snapshotEnabled(ctx: Context, runtime: CatalogRuntime, caches: DomainCaches): Promise<void> {
  runtime.diag.snapshots += 1
  // 磁盘 last-good 尚未加载完成：跳过采集，避免空快照覆盖磁盘好数据。
  if (!runtime.loaded) {
    runtime.diag.lastAt = Date.now()
    runtime.diag.lastError = 'skipped: catalog not loaded yet'
    return
  }
  try {
    const next = { ...runtime.catalog }
    let changed = false
    // 诊断：记录 apply ctx 下 agents/standing 的解析现场
    let rootsCount = 0
    let listCount = 0
    try {
      rootsCount = ctx.agents.roots().length
      listCount = ctx.agents.list().length
    } catch {
      rootsCount = -1
      listCount = -1
    }
    runtime.diag.lastAgentRoots = rootsCount
    runtime.diag.lastAgentList = listCount
    const schemas = await resolveScopeSchemas(ctx, caches)
    runtime.diag.lastSchemasTotal = schemas.length
    let mcpTools = 0
    for (const schema of schemas) {
      if (String(schema.name ?? '').startsWith('mcp__')) mcpTools += 1
    }
    runtime.diag.lastMcpTools = mcpTools
    runtime.diag.lastScope = mcpTools > 0
    for (const entry of ctx.loader.entries()) {
      if (!isMcpEntry(entry)) continue
      if (entry.disabled) continue
      const serverName = serverNameOf(entry)
      let tools: CatalogEntry[]
      try {
        tools = snapshotFromSchemas(schemas, serverName)
      } catch {
        continue // 采集失败：last-good，保留旧快照
      }
      const prev = next[serverName]
      if (prev && prev.source === 'live' && sameToolList(prev.tools, tools)) continue
      // last-good（v0.4.6 加强）：空采集（tools 为空）一律不写盘 —— 无论 prev 是否存在。
      // 原守卫只在 prev 有数据时保留，但 prev 因外部清空/时序丢失后，空快照会续写污染
      // last-good（0.4.5 实测：某次快照 loader 视图为空 → prune 清空 → 空快照续写）。
      if (tools.length === 0) continue
      next[serverName] = { tools, fetchedAt: Date.now(), source: 'live' }
      changed = true
    }
    // 失效清理（v0.4.5 → v0.4.6 修复）：
    // 保护：loader 视图为空（组合未挂载 / 启动时序 / realm 隔离异常）时跳过 prune，
    // 绝不删除 last-good —— 0.4.5 曾因 alive 集合为空把 catalog 全部清空并写盘。
    const alive = new Set<string>()
    for (const entry of ctx.loader.entries()) {
      if (!isMcpEntry(entry)) continue
      alive.add(serverNameOf(entry))
    }
    if (alive.size > 0) {
      for (const key of Object.keys(next)) {
        if (!alive.has(key)) {
          delete next[key]
          changed = true
        }
      }
    }
    runtime.catalog = next
    if (changed) {
      runtime.dirty = true
      void persistCatalog(() => ctx, runtime)
    }
    runtime.diag.lastAt = Date.now()
    runtime.diag.lastError = null
  } catch (error) {
    runtime.diag.lastError = messageOf(error)
    runtime.diag.lastAt = Date.now()
  }
}

/** 构建控制层依赖（McpControlCtx）：封闭 catalog/loader/state 的 IO。 */
function buildMcpControl(ctx: Context, runtime: CatalogRuntime, config: Config, caches: DomainCaches): McpControlCtx {
  // 默认值与 Config schema 的 .default() 一致：schema 生效后 config 必有值，
  // ?? 是「config 未经 schema 直接传入」时的防御性兜底（P2-10 收敛说明）。
  // preset 超时缓存（presetId+serverName → 超时/ms，有效 60s）：inventory+resolve+read
  // 每次 mcp_call 都做太重，key 含 presetId（切 preset 即换 key，天然失效）。
  const presetTimeoutCache = new Map<string, { at: number; timeout: number | undefined }>()
  return {
    keepAliveMs: config.keepAliveMs ?? 30_000,
    searchLimitDefault: config.searchLimitDefault ?? 5,
    searchLimitMax: config.searchLimitMax ?? 10,
    serverSummary: config.serverSummary ?? {},
    getCatalog: () => runtime.catalog,
    setCatalog: (catalog) => {
      runtime.catalog = catalog
    },
    persistCatalog: () => persistCatalog(() => ctx, runtime),
    resolveEntry: (serverName) => findMcpEntry(ctx, serverName),
    serverTimeoutMs: (serverName) => serverTimeoutMs(ctx, serverName),
    presetTimeoutMs: async (serverName) => {
      // rc.1 standing 组合兜底（窄场景）：仅 loader 有行但缺 toolCallTimeoutMs 时补读；
      // loader 无行的 mcp_call 预设行仍返回「不在 loader 中」（预设行直通是后续修复）。
      try {
        const agent = ctx.agents.roots()[0] ?? ctx.agents.list()[0]
        const presetId = agent ? (ctx.agentPresets.composedPreset(agent.ctx) ?? null) : null
        if (!presetId) return undefined
        const key = `${presetId}\0${serverName}`
        const hit = presetTimeoutCache.get(key)
        if (hit && Date.now() - hit.at < 60_000) return hit.timeout
        const { rows } = await listPresetMcpRows(ctx, presetId)
        const timeout = rows.find((r) => r.serverName === serverName)?.toolCallTimeoutMs
        presetTimeoutCache.set(key, { at: Date.now(), timeout })
        return timeout
      } catch {
        return undefined
      }
    },
    setAiOwner: (entryId, at) => setStateAiOwner(entryId, at),
    clearAiOwner: (entryId) => clearStateAiOwner(entryId),
    snapshotEnabled: () => snapshotEnabled(ctx, runtime, caches),
  }
}

/* ── 插件主体 ──────────────────────────────────────────────────────────── */

export function apply(ctx: Context, config: Config = {}): void {
  // 启动早期加载 MCP 工具级禁用集合（memory Map，装配过滤同步读）。
  // 注意：加载是异步的，首个装配回合前禁用表可能未就绪（毫秒级窗口）；
  // 失败必须留日志（否则用户以为已禁用、实际全放行）。
  void loadDisabledTools().catch((error: unknown) => {
    ctx.logger.warn(`mcp-skill-panel: 加载工具级禁用表失败: ${messageOf(error)}`)
  })

  // HMR/热重载兜底：从 state.json 反向重建项目 MCP owner 映射（防项目工具
  // 在下次 session-start 前短暂按全局展示/禁用作用域错判）。
  void rebuildOwnersFromState(ctx).catch((error: unknown) => {
    ctx.logger.warn(`mcp-skill-panel: 重建项目 MCP owner 映射失败: ${messageOf(error)}`)
  })

  // 启动早期物化 MCP 启停意图（仅当无会话在跑时；有会话则下次重启再物化）。
  // 不阻塞 apply；失败只记日志，不拖累插件挂载。
  void syncPresetFiles(ctx).then(
    (count) => {
      if (count > 0) ctx.logger.info(`runtime-inventory: materialized ${count} MCP row state(s) into preset composition`)
    },
    (error: unknown) => {
      ctx.logger.warn(`runtime-inventory: preset sync skipped: ${messageOf(error)}`)
    },
  )

  // 私有 catalog 内存态（面板联动 + 中间层共用）：采集对两种模式都启用（只读、
  // 无模型影响），autoManage=false 时仅面板停用态显示目录工具数。
  const catalogRuntime: CatalogRuntime = {
    catalog: {},
    dirty: false,
    persisting: false,
    loaded: false,
    // 初始值由下方 applyAutoManage 赋值（control/controller 构建后）
    autoManage: false,
    autoManageByRoute: {},
    middleLayerHides: 'disabled',
    autoManageMounted: false,
    applyAutoManage: () => {},
    decisionFor: () => ({ on: false, source: 'master', route: undefined }),
    routeServices: {},
    lastPersistAt: null,
    persistTimer: undefined,
    tokenCache: new Map(),
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
      loadedServers: null,
    },
  }
  // 启动早期加载持久化 catalog（last-good 兜底）；失败置空不阻塞。
  void loadCatalog(CATALOG_DIR).then(
    (catalog) => {
      catalogRuntime.catalog = catalog
      catalogRuntime.loaded = true
      catalogRuntime.diag.loadedAt = Date.now()
      catalogRuntime.diag.loadedServers = Object.keys(catalog).length
    },
    () => {
      catalogRuntime.catalog = {}
      catalogRuntime.loaded = true
      catalogRuntime.diag.loadedAt = Date.now()
      catalogRuntime.diag.loadedServers = 0
    },
  )

  // 分域缓存 + 事件驱动失效。事件在 root ctx emit（tools/change 来自工具注册表、
  // skills/change 来自 skill registry），必须挂 root 监听才能收到；用 ctx.effect
  // 确保插件卸载时解除监听（root 上的监听不随 fiber 自动清理）。
  const caches = createDomainCaches()
  ctx.effect(
    () => {
      const offTools = ctx.root.on('tools/change', caches.invalidateMcp)
      const offLoader = ctx.root.on('loader/partial-dispose', caches.invalidateMcp)
      const offSkills = ctx.root.on('skills/change', caches.invalidateSkills)
      return () => {
        offTools()
        offLoader()
        offSkills()
      }
    },
    'runtime-inventory: cache invalidation',
  )

  // tools/change 增量采集：对 enabled server 重新快照（含 mcp_call 临时启用后）。
  ctx.effect(() => {
    let scheduled = false
    const off = ctx.root.on(
      'tools/change',
      () => {
        catalogRuntime.diag.toolsChangeEvents += 1
        if (scheduled) return
        scheduled = true
        ctx.timeout(() => {
          scheduled = false
          void snapshotEnabled(ctx, catalogRuntime, caches)
        }, CATALOG_SNAPSHOT_DEBOUNCE_MS)
      },
    )
    return off
  }, 'mcp-skill-panel: catalog snapshot')

  // 初始快照（可能还没有 agent，mcp__* 会在后续增量补全）。
  void snapshotEnabled(ctx, catalogRuntime, caches).catch(() => {})

  // ── 项目级（工作空间）MCP：.dsh/mcps/**/mcp.json → 惰性挂载 + 常开可见性过滤 ──
  // 仅该项目会话可见（过滤按会话 cwd），独立于 autoManage；插件卸载时整体释放。
  const disposeProjectMcp = installProjectMcp(ctx)
  ctx.effect(
    () => () => disposeProjectMcp(),
    'mcp-skill-panel: project mcp teardown',
  )

  // ── 工具级禁用过滤（常开）：用户禁用的 MCP 工具从模型目录剔除 ──
  const disposeToolFilter = installToolDisableFilter(ctx)
  ctx.effect(
    () => () => disposeToolFilter(),
    'mcp-skill-panel: tool disable teardown',
  )

  // ── 形态 2（中间层代理）：动态开关 ──────────────────────────────────────
  // 控制层（catalog/loader/state 的 IO 封装）常驻构建，零副作用；过滤 + 工具 +
  // 回收器按 autoManage 开关动态挂载/卸载（面板 /config 端点可切换，state.json
  // 持久化，config 仅作初始默认）。
  const control: McpControlCtx = buildMcpControl(ctx, catalogRuntime, config, caches)
  const controller = createMcpCallController(ctx, control)
  // 装配可见性（v0.4.2+）：每回合构建一次 server → 可见性 Map（单次 loader 遍历），
  // 过滤时 O(1) 查表。用户打开的 server 可见（disabled=false 且非 AI 临时启用）；
  // 停用或 AI 临时启用的 server 对模型过滤，经 mcp_search/mcp_call 按需调用。
  const buildVisibility = (): ReadonlyMap<string, boolean> => {
    const map = new Map<string, boolean>()
    for (const entry of ctx.loader.entries()) {
      if (!isMcpEntry(entry)) continue
      const serverName = serverNameOf(entry)
      map.set(serverName, !entry.disabled && !controller.isAiEnabled(serverName))
    }
    return map
  }
  // 按模型分流：可选服务 holder + 每次装配的判定入口。
  const routeServices = installRouteServices(ctx)
  catalogRuntime.routeServices = routeServices
  catalogRuntime.decisionFor = (agent: Agent | undefined): RouteDecision =>
    routeDecision(resolveRoute(routeServices, agent), catalogRuntime.autoManage, catalogRuntime.autoManageByRoute)
  const gateFor = (agent: Agent | undefined): { on: boolean; hideAll: boolean } => ({
    on: catalogRuntime.decisionFor(agent).on,
    hideAll: catalogRuntime.middleLayerHides === 'all',
  })

  let autoDisposers: Array<() => void> = []
  catalogRuntime.applyAutoManage = (on: boolean, byRoute?: Record<string, boolean>, hides?: 'disabled' | 'all') => {
    for (const d of autoDisposers) d()
    autoDisposers = []
    catalogRuntime.autoManage = on
    if (byRoute !== undefined) catalogRuntime.autoManageByRoute = byRoute
    if (hides !== undefined) catalogRuntime.middleLayerHides = hides
    // 挂载条件不是「总开关 on」而是「有任何模型可能用到」：总开关关 + grok:true
    // 也要挂，否则覆盖项永远无法生效（工具注册表是进程级的一份）。
    const needed = on || Object.values(catalogRuntime.autoManageByRoute).some((value) => value === true)
    catalogRuntime.autoManageMounted = false
    if (!needed) return
    const disposers: Array<() => void> = []
    try {
      disposers.push(installMcpVisibilityFilter(ctx, buildVisibility, gateFor))
      disposers.push(installMcpControlTools(ctx, control, controller))
      const offReaper = controller.startIdleReaper()
      disposers.push(() => offReaper())
    } catch (error) {
      for (const d of disposers) d()
      catalogRuntime.autoManage = false
      ctx.logger.warn(`mcp-skill-panel: autoManage enable failed: ${messageOf(error)}`)
      return
    }
    autoDisposers = disposers
    catalogRuntime.autoManageMounted = true
  }
  // 插件卸载兜底：释放当前挂载的中间层（effect disposer 手动调用后 fiber 卸载不再重复）。
  ctx.effect(
    () => () => {
      for (const d of autoDisposers) d()
    },
    'mcp-skill-panel: autoManage teardown',
  )
  // 初始：config 默认 → state.json 的面板值覆盖（异步，立即生效）。
  catalogRuntime.applyAutoManage(Boolean(config.autoManage), {}, 'disabled')
  void readState().then((state) => {
    const master = typeof state.config?.autoManage === 'boolean' ? state.config.autoManage : Boolean(config.autoManage)
    const byRoute = stateAutoManageByRoute(state)
    const hides = stateMiddleLayerHides(state)
    catalogRuntime.applyAutoManage(master, byRoute, hides)
    const overrides = Object.keys(byRoute).length
    ctx.logger.info(
      `mcp-skill-panel: autoManage = ${master}, hides = ${hides}` +
        `${overrides > 0 ? ` (+${overrides} per-model override(s))` : ''} (from panel state)`,
    )
  })

  // P1 会话边界生效（v0.5.0）：next-session 模式下，新会话首次请求前应用待生效队列。
  // agent/session-start 是 Scoped<Agent> 的 emit，root 监听可收到；应用失败保留队列，
  // 由下次边界或「立即应用」端点重试。entry.update 触发 tools/change → 新会话前缀自建
  // （无缓存可破坏）。immediate 模式不产生待办，此监听零副作用。
  ctx.effect(() => {
    let guard = false
    const off = ctx.root.on(
      'agent/session-start',
      () => {
        if (guard) return
        guard = true
        void applyPendingMcp({ ctx, controller })
          .then((count) => {
            if (count > 0) {
              caches.invalidateMcp()
              ctx.logger.info(`runtime-inventory: applied ${count} pending MCP change(s) at session boundary`)
            }
          })
          .catch((error: unknown) => {
            ctx.logger.warn(`runtime-inventory: session-boundary apply failed: ${messageOf(error)}`)
          })
          .finally(() => {
            guard = false
          })
      },
    )
    return off
  }, 'runtime-inventory: session-boundary apply')

  ctx.inject(['webServer'], (httpCtx) => {
    httpCtx.effect(() => {
      const routes = makeRoutes(httpCtx, caches, catalogRuntime, config, controller, () => snapshotEnabled(httpCtx, catalogRuntime, caches))
      const disposers = routes.map((route) => httpCtx.webServer.register(route))
      return () => {
        for (const dispose of disposers) dispose()
      }
    }, 'runtime-inventory: routes')
  })
}
