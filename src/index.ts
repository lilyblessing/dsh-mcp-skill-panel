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
import type { Catalog, CatalogEntry } from './catalog'
import { snapshotFromSchemas, loadCatalog, saveCatalog } from './catalog'
import { installMcpVisibilityFilter } from './filter'
import type { McpControlCtx, McpCallController } from './mcpcall'
import { createMcpCallController, installMcpControlTools } from './mcpcall'
import { isMcpEntry, serverNameOf, mcpEntryConfig } from './mcp-entry'
import type { McpView, SkillsView, McpRow, SkillRow } from './shared-types'
import { createDomainCaches, type DomainCaches } from './collect'
import { makeRoutes } from './routes'
import { readState, writeState, setStateAiOwner, clearStateAiOwner } from './state'
import { syncPresetFiles } from './preset'
import { messageOf } from './util'

export type { McpView, SkillsView, McpRow, SkillRow } from './shared-types'
export type { DomainCaches } from './collect'
// 预设文件文本操作（selftest 回归护栏 + 潜在外部复用）
export { setRowFlag, setSkillFlag, rowDisabledState } from './preset'

export const name = 'runtime-inventory'

export const inject = ['fs', 'skills', 'tools', 'agents', 'agentPresets', 'loader', 'systemPrompt', 'timer']

export interface Config {
  /** @deprecated 0.3.0 起分域缓存由事件驱动失效，TTL 为常量；保留字段仅为向后兼容 */
  cacheTtlMs?: number
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
  cacheTtlMs: Schema.number().min(0),
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
/** tools.schemas 短窗口复用（P1-2）：覆盖「聚合失效 + 采集」两次调用间隔。 */
const SCHEMAS_CACHE_WINDOW_MS = 500
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
  /** AI 中间层当前生效状态（面板开关可动态切换）。 */
  autoManage: boolean
  /** 动态切换 AI 中间层（过滤 + mcp_search/mcp_call + 回收器）。 */
  applyAutoManage: (on: boolean) => void
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

/** tools.schemas 短窗口复用缓存（P1-2）：tools/change 风暴期内「聚合失效 + 采集」
 * 两次调用共享一次 schemas（95 schema 深克隆），窗口 + scopeKey 引用匹配。 */
let schemasCache: {
  at: number
  scopeKey: unknown
  schemas: Array<{ name?: unknown; description?: unknown; parameters?: unknown }>
} | null = null

/**
 * 解析 scope 并取 schema 视图（preset 层共享，任一 standing 即可）。
 *
 * 关键坑（v0.4.1 实测）：apply ctx（bundle 插件行挂载 ctx）下 `ctx.agents` 解析到
 * 空实例（realm 隔离，roots/list 均为 0）——从 apply ctx 直接 resolveAgent 永远拿不到
 * agent，catalog 采集恒为空并可能空写盘覆盖 last-good。因此 agent 不可得时
 * fallback 到 `agentPresets.standingKeyFor()`（注册表查询，不依赖 agent 实例）。
 */
async function resolveScopeSchemas(
  ctx: Context,
): Promise<Array<{ name?: unknown; description?: unknown; parameters?: unknown }>> {
  let scopeKey: unknown
  try {
    const agent = resolveAgentLocal(ctx)
    scopeKey = agent ? scopeOf(agent.ctx) : undefined
  } catch {
    scopeKey = undefined
  }
  if (scopeKey === undefined) {
    try {
      scopeKey = await ctx.agentPresets.standingKeyFor()
    } catch {
      scopeKey = undefined
    }
  }
  if (scopeKey === undefined) return []
  const now = Date.now()
  if (schemasCache && schemasCache.scopeKey === scopeKey && now - schemasCache.at < SCHEMAS_CACHE_WINDOW_MS) {
    return schemasCache.schemas
  }
  const schemas = ctx.tools.schemas(scopeKey as Parameters<typeof ctx.tools.schemas>[0]) as Array<{
    name?: unknown
    description?: unknown
    parameters?: unknown
  }>
  schemasCache = { at: now, scopeKey, schemas }
  return schemas
}

/** 本地 resolveAgent：避免 collect.ts 的依赖方向（本文件已 import collect）。 */
function resolveAgentLocal(ctx: Context) {
  const roots = ctx.agents.roots()
  if (roots.length > 0) return roots[0]
  return ctx.agents.list()[0]
}

/** 对所有当前 enabled 的 mcp server 重新快照。 */
async function snapshotEnabled(ctx: Context, runtime: CatalogRuntime): Promise<void> {
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
    const schemas = await resolveScopeSchemas(ctx)
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
function buildMcpControl(ctx: Context, runtime: CatalogRuntime, config: Config): McpControlCtx {
  // 默认值与 Config schema 的 .default() 一致：schema 生效后 config 必有值，
  // ?? 是「config 未经 schema 直接传入」时的防御性兜底（P2-10 收敛说明）。
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
    setAiOwner: (entryId, at) => setStateAiOwner(entryId, at),
    clearAiOwner: (entryId) => clearStateAiOwner(entryId),
    snapshotEnabled: () => snapshotEnabled(ctx, runtime),
  }
}

/* ── 插件主体 ──────────────────────────────────────────────────────────── */

export function apply(ctx: Context, config: Config = {}): void {
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
    applyAutoManage: () => {},
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
          void snapshotEnabled(ctx, catalogRuntime)
        }, CATALOG_SNAPSHOT_DEBOUNCE_MS)
      },
    )
    return off
  }, 'mcp-skill-panel: catalog snapshot')

  // 初始快照（可能还没有 agent，mcp__* 会在后续增量补全）。
  void snapshotEnabled(ctx, catalogRuntime).catch(() => {})

  // ── 形态 2（中间层代理）：动态开关 ──────────────────────────────────────
  // 控制层（catalog/loader/state 的 IO 封装）常驻构建，零副作用；过滤 + 工具 +
  // 回收器按 autoManage 开关动态挂载/卸载（面板 /config 端点可切换，state.json
  // 持久化，config 仅作初始默认）。
  const control: McpControlCtx = buildMcpControl(ctx, catalogRuntime, config)
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
  let autoDisposers: Array<() => void> = []
  catalogRuntime.applyAutoManage = (on: boolean) => {
    for (const d of autoDisposers) d()
    autoDisposers = []
    catalogRuntime.autoManage = on
    if (!on) return
    const disposers: Array<() => void> = []
    try {
      disposers.push(installMcpVisibilityFilter(ctx, buildVisibility))
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
  }
  // 插件卸载兜底：释放当前挂载的中间层（effect disposer 手动调用后 fiber 卸载不再重复）。
  ctx.effect(
    () => () => {
      for (const d of autoDisposers) d()
    },
    'mcp-skill-panel: autoManage teardown',
  )
  // 初始：config 默认 → state.json 的面板值覆盖（异步，立即生效）。
  catalogRuntime.applyAutoManage(Boolean(config.autoManage))
  void readState().then((state) => {
    if (typeof state.config?.autoManage === 'boolean' && state.config.autoManage !== Boolean(config.autoManage)) {
      catalogRuntime.applyAutoManage(state.config.autoManage)
      ctx.logger.info(`mcp-skill-panel: autoManage = ${state.config.autoManage} (from panel state)`)
    }
  })

  ctx.inject(['webServer'], (httpCtx) => {
    httpCtx.effect(() => {
      const routes = makeRoutes(httpCtx, caches, catalogRuntime, config, controller, () => snapshotEnabled(httpCtx, catalogRuntime))
      const disposers = routes.map((route) => httpCtx.webServer.register(route))
      return () => {
        for (const dispose of disposers) dispose()
      }
    }, 'runtime-inventory: routes')
  })
}
