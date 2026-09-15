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
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Entry } from '@deepseek-ai/cordis-plugin-loader'
import { scopeOf } from '@deepseek-ai/dsh-scope'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { Catalog, SearchHit } from './catalog'
import { searchCatalog, listServer } from './catalog'
import { isToolDisabled } from './tool-disable'
import type { PresetMcpRow, PresetMcpClientConfig } from './preset-mcp'

/** 空闲回收器扫描周期（ms）。 */
const REAPER_INTERVAL_MS = 10_000
/** waitRegistered 轮询间隔（ms）。 */
const REGISTER_POLL_MS = 50
/** 默认注册 / 调用超时：60s。 */
const DEFAULT_TOOL_TIMEOUT_MS = 60_000

/**
 * 归一化 mcp_call 的 tool 参数（2026-08-22 修补）：模型可能把 mcp_search 返回的
 * 注册全名（mcp__<server>__<tool>）直接填入 tool，无条件拼接会生成双重前缀。
 * 规则：以 mcp__ 开头视为注册全名形态 → 循环剥离本 server 前缀（兼容嵌套重复）；
 * 剥完仍以 mcp__ 开头 → 传的是其他 server 的注册全名或格式异常 → 快速失败
 * （避免在 waitRegistered 白等满 toolCallTimeoutMs，默认 60s、mimo-image 300s）。
 * 注：远端工具裸名恰好以 mcp__ 开头属生态外的病态命名，会被误判，可接受。
 */
export function normalizeToolName(serverName: string, toolName: string): string {
  const prefix = `mcp__${serverName}__`
  let name = toolName
  if (name.startsWith('mcp__')) {
    while (name.startsWith(prefix)) name = name.slice(prefix.length)
    if (name.startsWith('mcp__')) {
      throw new Error(
        `mcp_call: tool 参数疑似其他 MCP server 的注册全名（${JSON.stringify(toolName)}，server="${serverName}"）；请传该 server 上的裸名（如 understand_image，不带 mcp__ 前缀）`,
      )
    }
  }
  return name
}

/**
 * 归一化 mcp_call 的 arguments 参数（2026-08-24 修补）：type:'json' 参数的编译产物
 * 不带 type 标注，模型直连 Tool call 时倾向把参数字典填成 JSON 字符串（实测 flash 与
 * mimo 两系均会出现）。这里循环安全解析为对象后再透传：
 * - 值以 { / [ 开头 → 直接按容器 JSON 解析；
 * - 值以 " 开头（引号包裹层）→ 解包后若内层仍是容器形态才继续剥，防止误改合法标量入参；
 * - 解析失败或非字典形态 → 保留原值交由远端给出可读错误。
 */
export function normalizeArguments(raw: unknown): unknown {
  let value: unknown = raw ?? {}
  let depth = 0
  while (typeof value === 'string' && depth < 4) {
    const trimmed = value.trim()
    if (trimmed.length === 0) return {}
    const head = trimmed.charCodeAt(0)
    const isContainerJson = head === 123 /* { */ || head === 91 /* [ */
    const isQuotedJson = head === 34 /* " */
    if (!isContainerJson && !isQuotedJson) break
    let parsed: unknown
    try {
      parsed = JSON.parse(trimmed)
    } catch {
      break
    }
    if (parsed !== null && typeof parsed === 'object') {
      return parsed
    }
    // 解出标量：仅「引号包裹层 + 内层仍为容器形态」才继续剥，其余视为字面量入参
    const inner = typeof parsed === 'string' ? parsed.trim() : ''
    const innerLooksContainer = inner.startsWith('{') || inner.startsWith('[')
    if (!isQuotedJson || !innerLooksContainer) break
    value = parsed
    depth++
  }
  return value
}

/** 预设行直通用最小信息（= preset-mcp.ts PresetMcpRow，type-only import 零运行时依赖）。 */
export type PresetMcpRowInfo = PresetMcpRow

/**
 * 控制层依赖：由 src/index.ts 在 apply 里构建并注入。这些 helper 封闭了
 * 插件对 catalog 内存态、catalog.json 持久化、loader entry 反查、state.json
 * AI-owner 标记的读写 —— 这样控制层不反向依赖 index.ts（避免循环依赖）。
 */
export interface McpControlCtx {
  /** 空闲回收窗口（ms）。 */
  keepAliveMs: number
  /** mcp_search 缺省 top-K。 */
  searchLimitDefault: number
  /** mcp_search top-K 上限。 */
  searchLimitMax: number
  /** 能力摘要表（Config.serverSummary）。 */
  serverSummary: Record<string, string>

  /** 当前内存 catalog。 */
  getCatalog(): Catalog
  /** 替换内存 catalog（快照 / 增量后）。 */
  setCatalog(catalog: Catalog): void
  /** 把内存 catalog 持久化到 catalog.json。 */
  persistCatalog(): Promise<void>

  /** 按 serverName 反查 loader entry；无则 undefined。 */
  resolveEntry(serverName: string): Entry | undefined
  /** server 自己的注册/调用超时（读 entry config 的 toolCallTimeoutMs，缺省回退）。 */
  serverTimeoutMs(serverName: string): number

  /**
   * rc.1 standing 组合预设行定位（0.5.6 直通调用）：按 serverName 找当前会话
   * preset 的 standing 行（compositionInventory+resolve+read，经 60s 缓存）。
   * 返回 undefined = preset 也无该 server，调用方回退「不在 loader 中」。
   * 调用方收到行后须自行判定 disabled/running（快照布尔，非 Entry 句柄，
   * 无 entry.update 通道；禁用的预设行拒绝调用并提示走面板）。
   * 与 presetTimeoutMs 共用同一行来源，见 index.ts 闭包。
   */
  resolvePresetRow?(serverName: string, agent: Agent | undefined): Promise<PresetMcpRowInfo | undefined>

  /**
   * rc.1 standing 组合兜底超时：loader 行缺 toolCallTimeoutMs 时从 preset 快照
   * 补读（与 resolvePresetRow 共行来源）。注意（WARN-3）：本函数无 agent 参数，
   * 恒用 roots[0]/list[0] 的 preset；多会话挂不同 preset 且同名 server 超时不
   * 同时会取错——只影响等待时长。直通分支的超时由调用方经 presetRow 直取，
   * 不走本函数，故不受影响。
   */
  presetTimeoutMs?(serverName: string): Promise<number | undefined>

  /**
   * P1 直读（2026-09-09）：按 serverName 取当前会话 preset 行的全量挂载配置
   * （与 resolvePresetRow 同一行来源/同一缓存条目；无行或 transport 不可挂载
   * 时返回 undefined，调用方回退原行为）。网关挂载（P4）用它重建 client 行。
   */
  resolvePresetConfig?(serverName: string, agent: Agent | undefined): Promise<PresetMcpClientConfig | undefined>

  /** AI-owner 标记：上次自动开启该 entry 的时间戳。 */
  setAiOwner(entryId: string, at: number): Promise<void>
  clearAiOwner(entryId: string): Promise<void>

  /** 对所有当前 enabled 的 server 重新快照（tools/change / 启动）。 */
  snapshotEnabled(): Promise<void>

  /**
   * 0.6.4：主动催一次 catalog 快照（按需能力表采集在等 catalog 出现时用）。
   * 与 `snapshotEnabled` 同一实现，只是暴露给采集等待循环按需调用。
   */
  requestSnapshot?(): Promise<void>

  /**
   * 0.6.0：按需采集某 server 的能力表（mcp_search 命中「已安装但没有快照」时用）。
   *
   * 实现由 index.ts 注入（拿得到 resolveScopeSchemas / snapshotFromSchemas /
   * persistCatalog 这套 IO），返回采集到的工具数；未采到返回 null。
   */
  collectInventory?(serverName: string): Promise<{ tools: number; joined: boolean } | null>

  /**
   * 0.6.2：把**调用方已经采到**的 schema 写入 catalog（按 serverName 过滤）。
   * 与 `collectInventory` 的区别：采集口径由调用方决定（命中视图的 scope），
   * 本函数只负责过滤 + 落盘。
   */
  storeInventory?(
    serverName: string,
    schemas: ReadonlyArray<{ name?: unknown; description?: unknown; parameters?: unknown }>,
  ): Promise<{ tools: number; joined: boolean } | null>

  /** 0.6.0：已安装（配置里存在该行）的 MCP server 清单，含用户关闭的。 */
  installedInventory?(): Array<{ server: string; open: boolean }>
}

/** 控制层共享状态：调用链（call / gatewayCall）与空闲回收器**是同一个对象**。
 * 0.5.9 教训：`aiEnabled` 曾一度只有 `call()` 分支登记，而 `mcp_call` 实际走
 * gatewayCall → 回收器集合恒空、永不回收。两个分支现在都写这一个对象。 */
interface ControllerState {
  refCounts: Map<string, number>
  lastUsed: Map<string, number>
  aiEnabled: Set<string>
}

export interface McpCallController {
  /** 保活启用：disabled 时开启并记录 AI owner。返回本次是否由 AI 开启。 */
  ensureEnabled(serverName: string): Promise<boolean>
  /** 该 server 当前是否由 AI 临时启用（mcp_call 保活中）——装配过滤据此保持其不可见。 */
  isAiEnabled(serverName: string): boolean
  /**
   * 0.6.0：按需把某个「已安装但没快照」的 server 拉起来采集一次能力表，然后放回关闭。
   * 让 mcp_search 对关着的 server 也能给出工具清单（rc.8 语义）。
   * `waitMs` 覆盖默认等待上限（关前补采用短上限，避免实例起不来时拖住关闭操作）。
   */
  fetchInventory(serverName: string, waitMs?: number): Promise<{ tools: number; joined: boolean } | null>
  /**
   * 用户手动打开该 server：清除 AI 临时启用标记（aiEnabled/引用计数/lastUsed +
   * state.json 的 ai owner），使其转为「用户打开」语义 —— 模型立即可见、回收器不再回收。
   */
  markUserEnabled(serverName: string): void
  /** 完整调用流程，返回给模型的文本结果（不会 throw，错误也转文本）。 */
  call(
    serverName: string,
    toolName: string,
    args: unknown,
    agent: Agent | undefined,
    signal: AbortSignal,
    explicitTimeoutMs?: number,
  ): Promise<string>
  /**
   * 网关透传流程（P2，与 call() 同态共享引用计数）：成功返文本，失败 throw
   *（isError→Error cause 保原始 result；超时/abort 原样；禁用/停用/miss 均
   * throw）。供网关 own 层双工具复用；call() 原行为不动。
   */
  gateway(
    serverName: string,
    toolName: string,
    args: unknown,
    agent: Agent | undefined,
    signal: AbortSignal,
    explicitTimeoutMs?: number,
  ): Promise<string>
  /** 启动空闲回收器；返回 disposer。 */
  startIdleReaper(): () => void
  /** 诊断视图：AI 启用的 server 及其引用计数。 */
  status(): Array<{ server: string; refCount: number; lastUsed: number }>
}

export function msgOf(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  if (error && typeof error === 'object') {
    try {
      const text = JSON.stringify(error)
      if (typeof text === 'string' && text.length > 0) return text
    } catch {
      /* 循环引用等序列化失败 → 回退 String */
    }
  }
  return String(error)
}

/** 从 execute 结果的 content 块抽取文本（防御式）。 */
function contentText(content: unknown): string {
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    if (block && typeof block === 'object') {
      const b = block as Record<string, unknown>
      if (b.type === 'text' && typeof b.text === 'string') parts.push(b.text)
      else if (typeof b.text === 'string') parts.push(b.text)
    }
  }
  return parts.join('\n').trim()
}

/** 可执行一个注册工具的最小视图（宿主 ctx 或调用方 agent ctx 的 tools 服务）。 */
interface ToolView {
  label: string
  tools: { get(name: string, scope?: object): unknown; execute(exec: unknown): Promise<unknown> } | undefined
  scope: object | undefined
}

/**
 * 组装候选工具视图（2026-08-24 scope 回归第二版修复）：dsh-tools 注册表的
 * scope 约定是「agent 对象」而非 `scopeOf(agent.ctx)` 的 ctx 标签——模型面的
 * schemas(exec.agent) / 执行面 get(name, agent) 均以 agent 对象为钥匙建立层级链，
 * session-boundary 下 MCP 工具注册进该链可达的作用域层；而旧实现用 scopeOf(agent.ctx)
 * 查询同一注册表，链条不达 → 全部「未在超时内注册」。现改为直接以 agent 对象为
 * 作用域钥匙，与模型面/执行面完全同构；无 agent 时退回全局视图。
 */
function collectToolViews(ctx: Context, agent: Agent | undefined): Array<ToolView> {
  const views: Array<ToolView> = []
  if (agent) views.push({ label: 'agent-object', tools: ctx.tools, scope: agent })
  views.push({ label: 'host-global', tools: ctx.tools, scope: undefined })
  return views
}

async function ensureEnabled(
  control: McpControlCtx,
  ctx: Context,
  state: ControllerState,
  serverName: string,
  entry: Entry,
): Promise<boolean> {
  const wasDisabled = entry.disabled
  const entryId = entry.id
  if (wasDisabled) {
    counters().wakeAdded += 1
    await entry.update({ disabled: false })
    state.aiEnabled.add(serverName)
    await control.setAiOwner(entryId, Date.now())
    ctx.logger.info?.(`mcp-skill-panel: AI enabled MCP server "${serverName}"`)
  } else {
    // 行本来就是开的 → 不做 AI 归属登记（回收器不应回收用户自己开着的行）。
    // 0.5.7/0.5.8 实测的「拉起了却没登记」若落在这里，计数会直接指认。
    counters().wakeSkippedAlreadyEnabled += 1
  }
  return wasDisabled
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
const INVENTORY_FAIL_TTL_MS = 5 * 60_000
const inventoryFailUntil = new Map<string, number>()

/**
 * 0.6.2：从「已确认注册了工具」的那个视图直接取 schema 快照。
 * 与 index.ts 的 `getSchemasView` 读同一份 dsh-tools 服务，只是**用命中视图自己的
 * scope**，避免换口径重读采空（0.6.1 实测的采空原因）。
 */
export function schemasOfView(view: ToolView | undefined): Array<{ name?: unknown; description?: unknown; parameters?: unknown }> {
  if (!view?.tools) return []
  try {
    const svc = view.tools as unknown as {
      schemas?: (scope?: object) => Array<{ name?: unknown; description?: unknown; parameters?: unknown }>
    }
    return svc.schemas?.(view.scope as object | undefined) ?? []
  } catch {
    return []
  }
}

/**
 * 0.6.3：能力表采集的逐阶段痕迹。
 *
 * 为什么必须加：0.6.0→0.6.2 连续两次"采空"，而外部只能看到两个布尔
 * （`probed:true` / `hasSnapshot:false`），无法判断卡在"等待注册"还是"读到 0 条 schema"。
 * 这里把每阶段的原始数字留下，`/debug` 的 `inventoryTrace` 直接可读。
 */
interface InventoryTrace {
  at: number
  requestedBy: string
  stage: string
  ms: number
  entryFound: boolean | null
  wasDisabled: boolean | null
  wakeAdded: boolean | null
  viewLabel: string | null
  viewScope: string | null
  schemaTotal: number | null
  schemaMatched: number | null
  stored: number | null
  error: string | null
}

const inventoryTrace = new Map<string, InventoryTrace>()

export function inventoryTraceDiag(): Record<string, InventoryTrace & { agoMs: number }> {
  const out: Record<string, InventoryTrace & { agoMs: number }> = {}
  for (const [server, row] of inventoryTrace) out[server] = { ...row, agoMs: Date.now() - row.at }
  return out
}

async function collectInventory(
  ctx: Context,
  caches: McpControlCtx,
  state: ControllerState,
  serverName: string,
  requestedBy = 'unknown',
  waitMs?: number,
): Promise<{ tools: number; joined: boolean } | null> {
  const t0 = Date.now()
  const trace: InventoryTrace = {
    at: t0,
    requestedBy,
    stage: 'start',
    ms: 0,
    entryFound: null,
    wasDisabled: null,
    wakeAdded: null,
    viewLabel: null,
    viewScope: null,
    schemaTotal: null,
    schemaMatched: null,
    stored: null,
    error: null,
  }
  inventoryTrace.set(serverName, trace)
  const mark = (stage: string): void => {
    trace.stage = stage
    trace.ms = Date.now() - t0
  }
  const stop = (stage: string, error: string): null => {
    mark(stage)
    trace.error = error
    return null
  }
  const until = inventoryFailUntil.get(serverName) ?? 0
  if (Date.now() < until) {
    return stop('skip:failCache', `retry after ${Math.ceil((until - Date.now()) / 1000)}s`)
  }
  const entry = caches.resolveEntry(serverName)
  trace.entryFound = entry !== undefined
  if (!entry) return stop('resolveEntry:none', 'no entry for server')
  // 用户本来就开着的行：直接采（无需拉起，也不改归属）
  const wasDisabled = entry.disabled === true
  trace.wasDisabled = wasDisabled
  const entryId = String(entry.id)
  let aiOwned = false
  try {
    aiOwned = await ensureEnabled(caches, ctx, state, serverName, entry)
    trace.wakeAdded = aiOwned
    mark('ensureEnabled')
  } catch (error) {
    inventoryFailUntil.set(serverName, Date.now() + INVENTORY_FAIL_TTL_MS)
    ctx.logger.warn?.(`mcp-skill-panel: inventory fetch enable "${serverName}" failed: ${msgOf(error)}`)
    return stop('ensureEnabled:ERR', msgOf(error))
  }
  state.refCounts.set(serverName, (state.refCounts.get(serverName) ?? 0) + 1)
  state.lastUsed.set(serverName, Date.now())
  let out: { tools: number; joined: boolean } | null = null
  try {
    mark('ensureEnabled → 等待 catalog 出现该 server（由 snapshotEnabled 采集）')
    // 0.6.4：**不再自建采集**。
    //
    // 0.6.0→0.6.3 三次"采空"的真实原因（0.6.3 的 inventoryTrace 一击定位）：
    // `waitRegistered` 用 `collectToolViews(ctx, undefined)` 取视图，而工具注册在
    // **agent scope**；mcp_search 的调用路径拿不到 agent ctx → 视图里永远没有该工具
    // → 白等满 60s 超时（trace: `viewLabel:null` + `未在 60000ms 内注册`），
    // 而同一时刻 scopeDiag 显示该 server 的工具**已经注册好**（57 个 MCP 工具）。
    //
    // 插件本来就有一条"从正确 scope 采集"的通路：`snapshotEnabled()`（挂 tools/change，
    // 0.6.1 起已覆盖 standing 行）。所以这里改为：拉起 → 等 catalog 自己长出该 server
    // （必要时主动催一次快照）→ 放回关闭。复用久经验证的采集链路，不再重复实现。
    // 先等一拍再判定：`mcp-client` 建立连接→注册工具是异步的，立刻判会撞上"尚无工具"
    // 的空窗；每次轮询先等、再催快照、最后判 catalog，语义最稳。
    const deadline = Date.now() + (waitMs !== undefined && waitMs > 0 ? waitMs : caches.serverTimeoutMs(serverName))
    let waited = 0
    for (;;) {
      await ctx.timeout(600)
      const snap = caches.getCatalog()[serverName]
      if (snap && snap.tools.length > 0) {
        out = { tools: snap.tools.length, joined: false }
        trace.stored = out.tools
        break
      }
      if (Date.now() >= deadline || waited > 80) break
      await caches.requestSnapshot?.()
      waited += 1
    }
    mark(`catalogWait(n=${out?.tools ?? 0}, polls=${waited})`)
    if (!out) {
      inventoryFailUntil.set(serverName, Date.now() + INVENTORY_FAIL_TTL_MS)
      stop('timeout', `catalog 未在 ${Date.now() - t0}ms 内出现 "${serverName}"（snapshotEnabled 未采到）`)
    }
  } catch (error) {
    inventoryFailUntil.set(serverName, Date.now() + INVENTORY_FAIL_TTL_MS)
    ctx.logger.warn?.(`mcp-skill-panel: inventory fetch "${serverName}" failed: ${msgOf(error)}`)
    stop('collect:ERR', msgOf(error))
  } finally {
    mark('done')
    const next = (state.refCounts.get(serverName) ?? 1) - 1
    if (next <= 0) state.refCounts.delete(serverName)
    else state.refCounts.set(serverName, next)
    // 采集完立刻放回用户设定（开着的不动；关着的回关并清 AI 归属）。
    if (wasDisabled && aiOwned && next <= 0) {
      try {
        const cur = caches.resolveEntry(serverName)
        if (cur && cur.id === entryId && !cur.disabled) await cur.update({ disabled: true })
        await caches.clearAiOwner(entryId).catch(() => undefined)
      } catch (error) {
        ctx.logger.warn?.(`mcp-skill-panel: inventory fetch restore "${serverName}" failed: ${msgOf(error)}`)
      } finally {
        state.aiEnabled.delete(serverName)
        state.refCounts.delete(serverName)
        state.lastUsed.delete(serverName)
      }
    }
  }
  return out
}

async function waitRegistered(
  ctx: Context,
  name: string,
  views: Array<ToolView>,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<ToolView | undefined> {
  const start = Date.now()
  return new Promise<ToolView | undefined>((resolve, reject) => {
    let settled = false
    let pollTimer: (() => void) | undefined
    let offTools: (() => boolean) | undefined
    let offAbort: (() => void) | undefined
    let offDispose: (() => void) | undefined
    const onAbort = () => finish(new Error('aborted'))
    const finish = (error?: Error, view?: ToolView) => {
      if (settled) return
      settled = true
      pollTimer?.()
      offTools?.()
      offAbort?.()
      offDispose?.()
      if (error) reject(error)
      else resolve(view)
    }
    const check = () => {
      if (settled) return
      for (const view of views) {
        if (!view.tools) continue
        try {
          // 0.6.0：`name` 以 `__` 结尾时按**前缀**判定（能力表采集用：采集方
          // 不需要预先知道该 server 上的任何工具名，只看它有没有注册出工具）。
          // `schemas` 不在 ToolView 声明的最小面上，故按需收窄读取（运行时由
          // dsh-tools 提供，与 index.ts 的 getSchemasView 同一服务）。
          const schemasOf = view.tools as unknown as {
            schemas?: (scope?: object) => Array<{ name?: unknown }>
          }
          const hit = name.endsWith('__')
            ? (schemasOf.schemas?.(view.scope as object | undefined) ?? []).some((s) =>
                String(s?.name ?? '').startsWith(name),
              )
            : Boolean(view.tools.get(name, view.scope as object | undefined))
          if (hit) {
            ctx.logger.info?.(`mcp-skill-panel: tool "${name}" resolved via view "${view.label}"`)
            return finish(undefined, view)
          }
        } catch {
          /* 该视图查询失败，换下一个 */
        }
      }
      if (Date.now() - start >= timeoutMs) {
        return finish(new Error(`tool "${name}" 未在 ${timeoutMs}ms 内注册`))
      }
      pollTimer = ctx.timeout(check, REGISTER_POLL_MS)
    }
    offTools = ctx.root.on('tools/change', () => check())
    // 上下文销毁 → 立即终局：此前无 dispose 监听时 Promise 永不 settle，会挂起 mcp_call。
    offDispose = ctx.effect(() => () => finish(new Error('context disposed')), 'mcp-skill-panel: waitRegistered')
    // 调用方中止（exec.signal）→ 立即终局。
    if (signal) {
      if (signal.aborted) {
        finish(new Error('aborted'))
        return
      }
      signal.addEventListener('abort', onAbort, { once: true })
      offAbort = () => signal.removeEventListener('abort', onAbort)
    }
    check()
  })
}

/**
 * 预设行直通执行（0.5.6）：已启用 standing 行的工具已在 tools 注册表 scope 层
 * （mcp-client 注册），无需 ensureEnabled。引用计数/lastUsed 照常记（回收器
 * startIdleReaper 经 resolveEntry 找不到预设行 entry 时仅清内存态，不碰运行时，
 * 见 mcpcall.ts:394-400 无 entry 分支）。失败不 restore（无 Entry 可恢复；
 * 预设行开关走面板 state.json 意图，不由单次调用翻转）。
 */
async function callViaPresetViews(
  ctx: Context,
  control: McpControlCtx,
  state: ControllerState,
  serverName: string,
  bareTool: string,
  name: string,
  args: unknown,
  agent: Agent | undefined,
  signal: AbortSignal,
  explicitTimeoutMs: number | undefined,
): Promise<string> {
  const timeoutMs = explicitTimeoutMs ?? control.serverTimeoutMs(serverName)
  state.refCounts.set(serverName, (state.refCounts.get(serverName) ?? 0) + 1)
  state.lastUsed.set(serverName, Date.now())
  try {
    const views = collectToolViews(ctx, agent)
    const view = await waitRegistered(ctx, name, views, timeoutMs, signal)
    const execTools = view!.tools!
    const result = (await execTools.execute({
      callId: `mcp-call-${randomUUID()}` as import('@deepseek-ai/dsh-llm').ToolCallId,
      name,
      arguments: args,
      agent,
      signal,
    })) as { isError?: boolean; error?: unknown; content?: unknown } | undefined
    state.lastUsed.set(serverName, Date.now())
    if (result && result.isError) {
      return `MCP ${serverName}.${bareTool} 调用失败：${msgOf((result as { error?: unknown }).error ?? 'unknown error')}`
    }
    const text = contentText(result ? (result as { content?: unknown }).content : undefined)
    return text.length > 0 ? text : `MCP ${serverName}.${bareTool} 无返回内容`
  } catch (error) {
    return `MCP ${serverName}.${bareTool} 调用异常：${msgOf(error)}（提示：tool 参数应传该 server 上的裸名；server/tool 是否存在可先 mcp_search 确认）`
  } finally {
    const next = (state.refCounts.get(serverName) ?? 1) - 1
    if (next <= 0) state.refCounts.delete(serverName)
    else state.refCounts.set(serverName, next)
  }
}

/**
 * 网关透传调用（P2，与 call() 并存）：与 callViaPresetViews 同执行链
 * （collectToolViews+waitRegistered+execute），但错误走 throw 而非文本。
 * call() 的恒文本契约（:175-182）不动；网关/双工具走本函数。
 *
 * 三抛：
 * - isError→throw（前缀 `MCP ${server}.${bare} 调用失败`，cause 保原始
 *   result 对象：content/structuredContent/error 均在 cause 上）；
 * - 注册超时（waitRegistered 原文 `tool "…" 未在 Xms 内注册`）与执行失败
 *   均原样 throw（message 沿用原文便 grep；调用方按 message 区分 code）；
 * - signal.aborted→AbortError 原样透传（waitRegistered onAbort / execute
 *   signal 同源，不包装）。
 * 前置 normalizeToolName 捕获（跨 server 全名 throw 原样透传，不进 try）。
 * WARN-2 下沉（2026-09-09）：arguments 归一化收进本函数（与 mcp_call wrapper
 * :789 同调 normalizeArguments），P4 网关双工具直调本函数即得 JSON 字符串
 * 兼容；call() 路径保持 wrapper 侧调用不变（双调幂等：对象原样透传同引用）。
 * finally 抄 refCount 对称（callViaPresetViews finally）；绝不调 restore
 * （无 Entry 可恢复，直通语义）；绝不新增 dispose.
 */
export interface GatewayCallOpts {
  signal: AbortSignal
  agent: Agent | undefined
  explicitTimeoutMs?: number
}

export async function gatewayCall(
  ctx: Context,
  control: McpControlCtx,
  state: GatewayCallState,
  serverName: string,
  bareIn: string,
  args: unknown,
  opts: GatewayCallOpts,
): Promise<string> {
  // 前置捕获：注册全名误传 fast-fail（:48-52 throw 原样透传，不进 try）
  const bareTool = normalizeToolName(serverName, bareIn)
  const name = `mcp__${serverName}__${bareTool}`
  // WARN-2 下沉：arguments 归一化（JSON 字符串→对象，对象同引用透传）
  const normArgs = normalizeArguments(args)
  const workspace = typeof opts.agent?.session?.header?.cwd === 'string' ? opts.agent.session.header.cwd : undefined
  if (isToolDisabled(name, workspace)) {
    throw new Error(`MCP 工具 ${serverName}.${bareTool} 已被禁用（请在 MCP 管理面板打开该工具后再调用）`)
  }
  // 定位失败=回退 miss 语义：此处保留 catch→undefined（P2 设计唯一允许的吞错）
  // B1（P5）：loader 常驻行优先——项目行（哈希重命名）/global 行只在 loader，
  // 永不在 preset；preset 行走直通。双路分发保证 D2 改道后 loader 行不 miss。
  const entry = control.resolveEntry(serverName)
  if (entry) {
    return callViaLoaderEntry(ctx, control, state, serverName, bareTool, name, normArgs, opts, entry)
  }
  const presetRow = control.resolvePresetRow
    ? await control.resolvePresetRow(serverName, opts.agent).catch(() => undefined)
    : undefined
  if (!presetRow) {
    throw new Error(`未知 MCP server：${serverName}（不在 loader 中）`)
  }
  if (presetRow.disabled) {
    throw new Error(`MCP server "${serverName}" 当前已停用（预设行 ${presetRow.rowId}），请在 MCP 管理面板打开后（新会话生效）再调用`)
  }
  const timeoutMs = opts.explicitTimeoutMs ?? presetRow.toolCallTimeoutMs ?? control.serverTimeoutMs(serverName)
  state.refCounts.set(serverName, (state.refCounts.get(serverName) ?? 0) + 1)
  state.lastUsed.set(serverName, Date.now())
  try {
    const views = collectToolViews(ctx, opts.agent)
    const view = await waitRegistered(ctx, name, views, timeoutMs, opts.signal)
    if (opts.signal.aborted) throw opts.signal.reason ?? new Error('aborted')
    const execTools = view!.tools!
    const result = (await execTools.execute({
      callId: `mcp-call-${randomUUID()}` as import('@deepseek-ai/dsh-llm').ToolCallId,
      name,
      arguments: normArgs,
      agent: opts.agent,
      signal: opts.signal,
    })) as { isError?: boolean; error?: unknown; content?: unknown; structuredContent?: unknown } | undefined
    state.lastUsed.set(serverName, Date.now())
    if (result && result.isError) {
      const failure = new Error(
        `MCP ${serverName}.${bareTool} 调用失败：${msgOf((result as { error?: unknown }).error ?? 'unknown error')}`,
      )
      ;(failure as Error & { cause?: unknown }).cause = result
      throw failure
    }
    const text = contentText(result ? (result as { content?: unknown }).content : undefined)
    if (text.length === 0) {
      throw new Error(`MCP ${serverName}.${bareTool} 无返回内容`)
    }
    return text
  } finally {
    const next = (state.refCounts.get(serverName) ?? 1) - 1
    if (next <= 0) state.refCounts.delete(serverName)
    else state.refCounts.set(serverName, next)
  }
}

/**
 * gatewayCall 共享的状态（P4 网关常驻复用）。
 * 0.5.9 起**必须含 `aiEnabled`**：gatewayCall 是 `mcp_call` 的实际执行分支，
 * 它拉起的行若不登记进这个集合，空闲回收器就永远看不到（实测 bug）。
 */
export type GatewayCallState = ControllerState

/**
 * B1（P5）：loader 常驻行执行分支（项目行/global 行/网关 gw- 行）。
 * 与 call() 的 loader 分支同语义但错误走 throw：ensureEnabled 开启→执行→
 * 失败且本次 AI 启用且无并发则 restore。超时=loader 行 toolCallTimeoutMs。
 */
async function callViaLoaderEntry(
  ctx: Context,
  control: McpControlCtx,
  state: GatewayCallState,
  serverName: string,
  bareTool: string,
  name: string,
  normArgs: unknown,
  opts: GatewayCallOpts,
  entry: Entry,
): Promise<string> {
  const entryId = entry.id
  const timeoutMs = opts.explicitTimeoutMs ?? control.serverTimeoutMs(serverName)
  let aiOwned = false
  try {
    aiOwned = await ensureEnabledGateway(control, ctx, state, serverName, entry)
  } catch (error) {
    throw new Error(`启用 MCP server "${serverName}" 失败：${msgOf(error)}`)
  }
  state.refCounts.set(serverName, (state.refCounts.get(serverName) ?? 0) + 1)
  state.lastUsed.set(serverName, Date.now())
  let failed = false
  try {
    const views = collectToolViews(ctx, opts.agent)
    const view = await waitRegistered(ctx, name, views, timeoutMs, opts.signal)
    if (opts.signal.aborted) throw opts.signal.reason ?? new Error('aborted')
    const execTools = view!.tools!
    const result = (await execTools.execute({
      callId: `mcp-call-${randomUUID()}` as import('@deepseek-ai/dsh-llm').ToolCallId,
      name,
      arguments: normArgs,
      agent: opts.agent,
      signal: opts.signal,
    })) as { isError?: boolean; error?: unknown; content?: unknown; structuredContent?: unknown } | undefined
    state.lastUsed.set(serverName, Date.now())
    if (result && result.isError) {
      failed = true
      const failure = new Error(
        `MCP ${serverName}.${bareTool} 调用失败：${msgOf((result as { error?: unknown }).error ?? 'unknown error')}`,
      )
      ;(failure as Error & { cause?: unknown }).cause = result
      throw failure
    }
    const text = contentText(result ? (result as { content?: unknown }).content : undefined)
    if (text.length === 0) {
      failed = true
      throw new Error(`MCP ${serverName}.${bareTool} 无返回内容`)
    }
    return text
  } catch (error) {
    failed = true
    throw error
  } finally {
    const next = (state.refCounts.get(serverName) ?? 1) - 1
    if (next <= 0) state.refCounts.delete(serverName)
    else state.refCounts.set(serverName, next)
    if (failed && aiOwned && next <= 0) void restoreGateway(control, ctx, state, serverName, entryId)
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
async function ensureEnabledGateway(
  control: McpControlCtx,
  ctx: Context,
  state: ControllerState,
  serverName: string,
  entry: Entry,
): Promise<boolean> {
  if (!entry.disabled) {
    counters().wakeSkippedAlreadyEnabled += 1
    return false // 行本来就是开的 → 非 AI 借用，回收器不接管
  }
  counters().wakeAdded += 1
  await entry.update({ disabled: false })
  state.aiEnabled.add(serverName)
  await control.setAiOwner(entry.id, Date.now()).catch(() => undefined)
  ctx.logger.info?.(`mcp-skill-panel: gateway enabled MCP server "${serverName}"`)
  return true
}

/**
 * gateway 分支的失败恢复（best-effort；失败即回关，不留半开）。
 * 0.5.9：同时清 `state.aiEnabled`/refCounts/lastUsed —— 否则回关后回收器下一轮
 * 仍把这个 server 当候选，`idleMs` 因 lastUsed 已被删而变成 `now-0` 的巨值，
 * 每轮白扫一次（无害但噪声）。调用方保证此时 refCount 已归零。
 */
async function restoreGateway(
  control: McpControlCtx,
  ctx: Context,
  state: GatewayCallState,
  serverName: string,
  entryId: string,
): Promise<void> {
  // 与 restore() 同构的竞态守卫：用户中途手动打开（markUserEnabled 清掉 aiEnabled）时，
  // 该 server 已转交用户管理，失败的这次 AI 调用不得再回关它（否则会关掉用户刚开的行）。
  // 引用计数等残留一并清掉。
  if (!state.aiEnabled.has(serverName)) {
    state.refCounts.delete(serverName)
    state.lastUsed.delete(serverName)
    return
  }
  try {
    const entry = control.resolveEntry(serverName)
    if (entry && entry.id === entryId && !entry.disabled) {
      await entry.update({ disabled: true })
    }
    await control.clearAiOwner(entryId).catch(() => undefined)
  } catch (error) {
    ctx.logger.warn?.(`mcp-skill-panel: gateway restore disabled for "${serverName}" failed: ${msgOf(error)}`)
  } finally {
    state.aiEnabled.delete(serverName)
    state.refCounts.delete(serverName)
    state.lastUsed.delete(serverName)
  }
}

/** 失败 / 无并发时恢复原状态：禁用并清 AI owner。 */
async function restore(
  control: McpControlCtx,
  ctx: Context,
  state: ControllerState,
  serverName: string,
  entryId: string,
): Promise<void> {
  // 用户中途手动打开（markUserEnabled）会清除 AI 标记 → 该 server 已转交用户管理，
  // 本次调用不再拥有它，绝不能恢复 disabled（否则关闭用户手动打开的 server，违反
  // 「用户启停不被模型干预」承诺）。引用计数等残留一并清掉。
  if (!state.aiEnabled.has(serverName)) {
    state.refCounts.delete(serverName)
    state.lastUsed.delete(serverName)
    return
  }
  try {
    const entry = control.resolveEntry(serverName)
    if (entry && entry.id === entryId && !entry.disabled) {
      await entry.update({ disabled: true })
    }
    await control.clearAiOwner(entryId)
  } catch (error) {
    ctx.logger.warn?.(`mcp-skill-panel: restore disabled for "${serverName}" failed: ${msgOf(error)}`)
  } finally {
    state.aiEnabled.delete(serverName)
    state.lastUsed.delete(serverName)
    state.refCounts.delete(serverName)
  }
}

/** 回收器单轮诊断快照（0.5.8）。历史教训：0.5.7 首次实测「临时拉起」时只看到
 * 最终没关，看不到回收器**每轮看到了什么、为什么跳过**，白跑一轮实验。此结构把
 * 判定输入（keepAliveMs / 候选集合 / 各自 refCount 与空闲时长）全部落成可读读数。 */
export interface ReaperRound {
  at: number
  keepAliveMs: number
  /** aiEnabled 里的候选（回收只对这一集合生效） */
  candidates: string[]
  decisions: Array<{ server: string; refCount: number; idleMs: number; action: string }>
}

/** /debug 只读曝光（模块级单例；零 secrets）。 */
export interface ReaperDiag {
  rounds: number
  /** 最近一轮（存储态不含 agoMs，读取时计算） */
  lastRound: ReaperRound | null
  everDisabled: string[]
}

let reaperDiag: ReaperDiag = { rounds: 0, lastRound: null, everDisabled: [] }

/**
 * 0.5.9 计数闸门（挂 globalThis，**不依赖模块实例**）。
 *
 * 为什么需要：0.5.7/0.5.8 实测出自相矛盾的现场——`mcp_call` 确实把休眠行拉起来了
 * （返回 `3*x**2`、面板 disabled=false），但 `controller.status()` 的 `aiOwned` 与
 * 回收器 `candidates` **同时为空**。两者共用同一个 state 对象，理论上不可能。
 * 可疑面只剩：调用走了另一条分支 / 另有控制器实例 / 中途被清了标记。
 * 这组计数器把每次分支决策记成可读数字，一轮实验即可判定。
 */
interface ControllerCounters {
  controllers: number
  callResolvedEntry: number
  callNoEntry: number
  callPresetBranch: number
  wakeAdded: number
  wakeSkippedAlreadyEnabled: number
  clearedByUser: number
  reaped: number
  reaperDroppedNoEntry: number
}

const COUNTER_KEY = '__dshMcpPanelControllerCounters__'

function counters(): ControllerCounters {
  const g = globalThis as unknown as Record<string, ControllerCounters | undefined>
  let c = g[COUNTER_KEY]
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
      reaperDroppedNoEntry: 0,
    }
    g[COUNTER_KEY] = c
  }
  return c
}

/** /debug 用：分支决策计数快照。 */
export function controllerCounters(): ControllerCounters {
  return { ...counters() }
}

/** 供 /debug 读取（每次刷新 agoMs，不参与逻辑判断）。 */
export function reaperDiagnostics(): ReaperDiag & { agoMs: number | null } {
  return {
    rounds: reaperDiag.rounds,
    lastRound: reaperDiag.lastRound,
    everDisabled: [...reaperDiag.everDisabled],
    agoMs: reaperDiag.lastRound ? Date.now() - reaperDiag.lastRound.at : null,
  }
}

function startIdleReaper(control: McpControlCtx, ctx: Context, state: ControllerState): () => void {
  return ctx.interval(() => {
    const now = Date.now()
    const keepAliveMs = control.keepAliveMs
    const decisions: ReaperRound['decisions'] = []
    for (const server of [...state.aiEnabled]) {
      const refCount = state.refCounts.get(server) ?? 0
      const last = state.lastUsed.get(server) ?? 0
      if (refCount > 0) {
        decisions.push({ server, refCount, idleMs: now - last, action: 'skip:refCount' })
        continue
      }
      if (now - last < keepAliveMs) {
        decisions.push({ server, refCount, idleMs: now - last, action: 'skip:keepAlive' })
        continue
      }
      const entry = control.resolveEntry(server)
      if (!entry) {
        decisions.push({ server, refCount, idleMs: now - last, action: 'drop:noEntry' })
        counters().reaperDroppedNoEntry += 1
        state.aiEnabled.delete(server)
        state.refCounts.delete(server)
        state.lastUsed.delete(server)
        continue
      }
      const entryId = entry.id
      decisions.push({ server, refCount, idleMs: now - last, action: 'reap' })
      void (async () => {
        try {
          if (!entry.disabled) await entry.update({ disabled: true })
          // 二次检查：await 让出事件循环期间可能有新 call() 接手（refCount 升到 1），
          // 此时放弃本轮回收，不清 owner 不打日志。
          if ((state.refCounts.get(server) ?? 0) > 0) return
          await control.clearAiOwner(entryId)
          if (!reaperDiag.everDisabled.includes(server)) reaperDiag.everDisabled.push(server)
          counters().reaped += 1
          ctx.logger.info?.(`mcp-skill-panel: idle-reaped MCP server "${server}"`)
        } catch (error) {
          ctx.logger.warn?.(`mcp-skill-panel: idle reaper disable "${server}" failed: ${msgOf(error)}`)
        } finally {
          // 仅在无新调用接手时才删除状态，防止把新 call() 的计数清掉。
          if ((state.refCounts.get(server) ?? 0) === 0) {
            state.aiEnabled.delete(server)
            state.refCounts.delete(server)
            state.lastUsed.delete(server)
          }
        }
      })()
    }
    reaperDiag = { ...reaperDiag, rounds: reaperDiag.rounds + 1, lastRound: { at: now, keepAliveMs, candidates: [...state.aiEnabled], decisions } }
  }, REAPER_INTERVAL_MS)
}

/**
 * 创建控制层控制器。`caches` 即控制层依赖（McpControlCtx），由 index.ts
 * 在 apply 里构建并封闭所有 IO。
 */
export function createMcpCallController(ctx: Context, caches: McpControlCtx): McpCallController {
  counters().controllers += 1
  const state: ControllerState = {
    refCounts: new Map<string, number>(),
    lastUsed: new Map<string, number>(),
    aiEnabled: new Set<string>(),
  }

  const controller: McpCallController = {
    /**
     * 网关透传入口（P2）：与 call() 同控制器共享引用计数态（state），但错误
     * 走 throw（gatewayCall），不进恒文本 call()。controller 外透出供网关
     * own 层双工具复用；call() 原行为不动。
     */
    async gateway(
      serverName: string,
      toolName: string,
      args: unknown,
      agent: Agent | undefined,
      signal: AbortSignal,
      explicitTimeoutMs?: number,
    ): Promise<string> {
      return gatewayCall(ctx, caches, state, serverName, toolName, args, { signal, agent, explicitTimeoutMs })
    },

    async ensureEnabled(serverName): Promise<boolean> {
      const entry = caches.resolveEntry(serverName)
      if (!entry) throw new Error(`unknown MCP server "${serverName}"`)
      return ensureEnabled(caches, ctx, state, serverName, entry)
    },

    isAiEnabled(serverName): boolean {
      return state.aiEnabled.has(serverName)
    },

    markUserEnabled(serverName): void {
      state.aiEnabled.delete(serverName)
      state.refCounts.delete(serverName)
      state.lastUsed.delete(serverName)
      const entry = caches.resolveEntry(serverName)
      if (entry) void caches.clearAiOwner(entry.id)
    },

    async fetchInventory(serverName, waitMs) {
      return collectInventory(ctx, caches, state, serverName, 'mcp_search', waitMs)
    },

    async call(serverName, toolName, args, agent, signal, explicitTimeoutMs) {
      const bareTool = normalizeToolName(serverName, toolName)
      const name = `mcp__${serverName}__${bareTool}`
      // 工具级禁用（面板指定关闭）：拒绝调用并给出明确提示（可经面板重新开启）。
      // 项目 MCP 按会话工作区判定（A 区禁用不影响 B 区）；全局 MCP 无条件生效。
      const workspace = typeof agent?.session?.header?.cwd === 'string' ? agent.session.header.cwd : undefined
      if (isToolDisabled(name, workspace)) {
        return `MCP 工具 ${serverName}.${bareTool} 已被禁用（请在 MCP 管理面板打开该工具后再调用）`
      }
      const entry = caches.resolveEntry(serverName)
      if (!entry) {
        counters().callNoEntry += 1
        // 0.5.6 预设行直通：rc.1 preset 行挂 standing 组合、不在 loader.entries()
        // 里（findMcpEntry miss）。此时按 serverName 找当前会话 preset 的 standing
        // 行：已启用的行（!disabled）其 mcp__* 工具已由 mcp-client 注册进 tools
        // 注册表 scope 层 → 跳过 ensureEnabled/restore（无 Entry 句柄可 update），
        // 直接走 collectToolViews+waitRegistered+execute 执行链。禁用的预设行
        // （disabled:true）无运行时启用通道（dsh-mcp-client 无 enable 导出，
        // standing Entry 句柄不可达），拒绝并提示走面板；preset 无此 server 则
        // 回退原「不在 loader 中」。
        const presetRow = caches.resolvePresetRow
          ? await caches.resolvePresetRow(serverName, agent).catch(() => undefined)
          : undefined
        if (presetRow) {
          // running 快照仅作错误提示增强：enabled 但实例未 running 时工具大概率
          // 未注册，waitRegistered 会等满超时；提前在文案里点出 running 供排查
          // （启动竞态下 transient 未 running 仍走等待，不硬拒绝，见 WARN-1）。
          if (presetRow.disabled) {
            return `MCP server "${serverName}" 当前已停用（预设行 ${presetRow.rowId}），请在 MCP 管理面板打开后（新会话生效）再调用`
          }
          const presetTimeout = presetRow.toolCallTimeoutMs
          const hint = presetRow.running ? '' : '（提示：该行已启用但实例暂未运行，若持续超时请在面板确认后重试）'
          const out = await callViaPresetViews(ctx, caches, state, serverName, bareTool, name, args, agent, signal, explicitTimeoutMs ?? presetTimeout)
          return out.startsWith(`MCP ${serverName}.${bareTool} 调用异常`) && hint ? `${out}${hint}` : out
        }
        return `未知 MCP server：${serverName}（不在 loader 中）`
      }
      const entryId = entry.id
      counters().callResolvedEntry += 1
      const presetTimeout = caches.presetTimeoutMs ? await caches.presetTimeoutMs(serverName).catch(() => undefined) : undefined
      const timeoutMs = explicitTimeoutMs ?? presetTimeout ?? caches.serverTimeoutMs(serverName)

      let aiOwned = false
      try {
        aiOwned = await ensureEnabled(caches, ctx, state, serverName, entry)
      } catch (error) {
        return `启用 MCP server "${serverName}" 失败：${msgOf(error)}`
      }
      state.refCounts.set(serverName, (state.refCounts.get(serverName) ?? 0) + 1)
      state.lastUsed.set(serverName, Date.now())

      let failed = false
      try {
        // 2026-08-24：多视图轮询（agent 作用域/全局 + 宿主作用域/全局），
        // 命中视图负责执行；未见任何视图注册时保持原有超时语义。
        const views = collectToolViews(ctx, agent)
        const view = await waitRegistered(ctx, name, views, timeoutMs, signal)
        // view 在 waitRegistered resolve 时必定存在（ToolView 已被解析）
        const execTools = view!.tools!
        const result = (await execTools.execute({
          callId: `mcp-call-${randomUUID()}` as import('@deepseek-ai/dsh-llm').ToolCallId,
          name,
          arguments: args,
          agent,
          signal,
        })) as { isError?: boolean; error?: unknown; content?: unknown } | undefined
        state.lastUsed.set(serverName, Date.now())
        if (result && result.isError) {
          failed = true
          return `MCP ${serverName}.${bareTool} 调用失败：${msgOf((result as { error?: unknown }).error ?? 'unknown error')}`
        }
        const text = contentText(result ? (result as { content?: unknown }).content : undefined)
        return text.length > 0 ? text : `MCP ${serverName}.${bareTool} 无返回内容`
      } catch (error) {
        failed = true
        return `MCP ${serverName}.${bareTool} 调用异常：${msgOf(error)}（提示：tool 参数应传该 server 上的裸名；server/tool 是否存在可先 mcp_search 确认）`
      } finally {
        const next = (state.refCounts.get(serverName) ?? 1) - 1
        if (next <= 0) state.refCounts.delete(serverName)
        else state.refCounts.set(serverName, next)
        // 本次 AI 启用的，失败且无并发 → 恢复原状态
        if (failed && aiOwned && next <= 0) void restore(caches, ctx, state, serverName, entryId)
      }
    },

    startIdleReaper() {
      return startIdleReaper(caches, ctx, state)
    },

    status() {
      const out: Array<{ server: string; refCount: number; lastUsed: number }> = []
      for (const server of state.aiEnabled) {
        out.push({ server, refCount: state.refCounts.get(server) ?? 0, lastUsed: state.lastUsed.get(server) ?? 0 })
      }
      out.sort((a, b) => a.server.localeCompare(b.server))
      return out
    },
  }

  return controller
}

/* ── mcp_search ─────────────────────────────────────────────────────────── */

function clampLimit(value: number | undefined, defaultValue: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return defaultValue
  return Math.min(Math.floor(value), max)
}

/** 摘要截断长度：mcp_search 空查询的输出 token 控制（P2-5）。 */
const SUMMARY_MAX_LEN = 80

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
function buildSummary(control: McpControlCtx): Array<{ server: string; summary: string; open: boolean; tools: number | null }> {
  const catalog = control.getCatalog()
  const installed = new Map<string, boolean>()
  for (const row of control.installedInventory?.() ?? []) installed.set(row.server, row.open)

  const servers = new Set<string>([...installed.keys(), ...Object.keys(catalog), ...Object.keys(control.serverSummary)])
  const lines: Array<{ server: string; summary: string; open: boolean; tools: number | null }> = []
  for (const server of servers) {
    const snap = catalog[server]
    const tools = snap ? snap.tools.length : null
    const configured = control.serverSummary[server]
    let summary: string
    if (configured !== undefined) {
      summary = configured
    } else if (tools && tools > 0) {
      const raw = String(snap?.tools?.[0]?.description ?? 'MCP server')
      summary = raw.length > SUMMARY_MAX_LEN ? `${raw.slice(0, SUMMARY_MAX_LEN)}…` : raw
    } else {
      summary = '（无工具快照：首次按需调用时会自动拉起并采集）'
    }
    lines.push({ server, summary, open: installed.get(server) ?? true, tools })
  }
  // 开着（模型已可见）的排前面，其余按名字
  lines.sort((a, b) => Number(b.open) - Number(a.open) || a.server.localeCompare(b.server))
  return lines
}

function registerMcpSearchTool(ctx: Context, control: McpControlCtx, controller: McpCallController): () => void {
  const definition = defineTool({
    name: 'mcp_search',
    description:
      '检索可用的 MCP 服务器与工具目录（只读，不执行）。四种用法：① 空参数 → server 清单（含已关闭的，标注开/关）；② server=X → 该 server 的**能力摘要**（工具总数 + 前 5 个名字预览，不返回全表，避免上下文膨胀）；③ query + server → 在 X 内按需检索，返回 top-K 命中（含完整 schema），**想找某个 server 上的具体工具就用这个**；④ query → 全目录关键词检索。查到工具名后用 mcp_call(server, tool, arguments) 调用；不知道工具名先用 ②/③，不要用 ② 拉全表（工具多时传 all:true 才会返回全表）。中文连写请用空格分词（如“搜索 网页”）。',
    parameters: {
      query: { type: 'string', description: '检索关键词，按工具名/描述/参数名打分（缺省 top-K 8，上限 10）；与 server 同传即在该 server 内检索' },
      server: { type: 'string', description: '目标 MCP server 名（见空查清单）。单独传 = 返回该 server 的能力摘要 + 前 5 个工具名预览' },
      all: { type: 'boolean', description: '仅在传 server 时有效：true = 返回该 server 的完整工具清单（分页，可能很大）。默认 false 只给摘要' },
      limit: { type: 'integer', description: '关键词 top-K（默认 8）或 server 页大小（默认 20，上限 50；配合 all:true 用）' },
      offset: { type: 'integer', description: 'server 页偏移（默认 0，仅 all:true 分支有效）' },
      topK: { type: 'integer', description: '关键词命中数（默认 8，与 limit 同义，显式优先）' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    execute: async (args, exec) => {
      const catalog = control.getCatalog()
      const query = typeof args.query === 'string' ? args.query.trim() : ''
      const server = typeof args.server === 'string' ? args.server.trim() : ''
      // P3 定稿：query 缺省 topK=8；server 页缺省 limit=20（上限 50）。
      const topK = clampLimit(
        typeof args.topK === 'number' ? args.topK : typeof args.limit === 'number' ? args.limit : undefined,
        8,
        10,
      )
      const pageLimit = clampLimit(typeof args.limit === 'number' ? args.limit : undefined, 20, 50)
      const offset = Math.max(0, Math.floor(Number(args.offset) || 0))
      // 按当前会话工作区过滤项目级禁用（全局禁用无条件生效）
      const workspace = typeof exec?.agent?.session?.header?.cwd === 'string' ? exec.agent.session.header.cwd : undefined
      const keep = (name: string): boolean => !isToolDisabled(name, workspace)

      // 0.6.8：`query + server` = **在该 server 内按需检索**。
      // 这是"上百个工具时模型怎么知道该调哪个"的正解：有界返回 top-K 命中（带 schema），
      // 而不是把全表灌进上下文（后者会让上下文先膨胀再收缩，破坏前缀缓存命中率）。
      if (server && query) {
        const hits: SearchHit[] = searchCatalog(catalog, query, topK, server).filter((hit) => keep(hit.tool.name))
        return toJson({
          ok: true,
          kind: 'search',
          server,
          query,
          count: hits.length,
          limit: topK,
          hits,
          hint: '命中即用 mcp_call（server + 裸工具名）调用；不够准就换关键词再搜，中文连写请用空格分词。',
        })
      }

      if (server) {
        const installedRows = control.installedInventory?.() ?? []
        const known = installedRows.find((row) => row.server === server)
        let page = listServer(catalog, server, offset, pageLimit)
        // 0.6.0：已安装但**没有工具**（用户关掉且从未运行过，或上次采集时后端还没起来）
        // → 临时拉起采集一次能力表。判据是"工具数为 0"而不仅是"无条目"：后端由用户
        // 手动启动时，首次采集可能采到空表，之后用户启动了必须还能补采（否则永远为 0）。
        let probed = false
        if (page.totalCount === 0 && known) {
          await controller.fetchInventory(server).catch(() => null)
          probed = true
          page = listServer(control.getCatalog(), server, offset, pageLimit)
        }
        if (!page.hasSnapshot && !known) {
          return toJson({
            ok: true,
            kind: 'list',
            server,
            found: false,
            installed: false,
            hasSnapshot: false,
            count: 0,
            totalCount: 0,
            offset,
            limit: pageLimit,
            tools: [],
            hint: `未知 server "${server}"，空查 mcp_search 看 server 清单；中文连写请用空格分词。`,
          })
        }
        const all = page.tools.filter((tool) => keep(tool.name))
        // 0.6.8：默认**不返回全表**（上百个工具的 server 会瞬间膨胀上下文）。
        // 默认给「总数 + 前 5 个名字预览 + 检索指引」；要全表须显式 all:true（此时才分页返回）。
        if (args.all !== true) {
          const preview = all.slice(0, 5).map((tool) => ({ name: tool.name, description: tool.description }))
          return toJson({
            ok: true,
            kind: 'summary',
            server,
            found: true,
            installed: true,
            open: known?.open ?? true,
            hasSnapshot: page.hasSnapshot,
            probed,
            // 摘要分支的 `count` = **该 server 的工具总数**。曾误用 `all.length`
            // （受默认页大小 20 截断）→ 27 个工具的 server 报 20，误导模型判规模。
            count: page.totalCount,
            totalCount: page.totalCount,
            preview,
            hint: page.hasSnapshot
              ? `共 ${page.totalCount} 个工具，此处只预览 ${preview.length} 个。用 query + server 检索具体能力（推荐，按需且不占上下文）；确需完整清单请传 all: true。`
              : `该 server 已安装但当前没有工具（未运行或采集未成功）。可直接 mcp_call 调用它——中间层会临时拉起；若持续失败请在面板打开它后重试。`,
          })
        }
        return toJson({
          ok: true,
          kind: 'list',
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
          hint: '已按 all:true 返回全表（分页）。工具多时优先改用 query + server 检索，避免上下文膨胀。',
        })
      }

      if (query) {
        const hits: SearchHit[] = searchCatalog(catalog, query, topK).filter((hit) => keep(hit.tool.name))
        return toJson({ ok: true, kind: 'search', query, count: hits.length, limit: topK, hits })
      }

      const servers = buildSummary(control)
      const openCount = servers.filter((s) => s.open).length
      const text = [
        `已安装 ${servers.length} 个 MCP server（${openCount} 个已打开并对模型可见，${servers.length - openCount} 个已关闭——关闭的对模型不可见，但可经 mcp_call 按需临时拉起）。`,
        ...servers.map((s) => `- ${s.server} [${s.open ? '开' : '关'}]${s.tools === null ? '' : ` (${s.tools} 工具)`}: ${s.summary}`),
      ].join('\n')
      return toJson({ ok: true, kind: 'summary', summary: text, servers, count: servers.length })
    },
  })
  return ctx.tools.register(definition)
}

/** 把运行时对象投影为 JsonValue（工具 schema 本身是 JSON，转换是安全的）。 */
function toJson(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue
}

/* ── mcp_call ───────────────────────────────────────────────────────────── */

function registerMcpCallTool(ctx: Context, controller: McpCallController): () => void {
  const definition = defineTool({
    name: 'mcp_call',
    description:
      '调用一个 MCP 服务器上的工具。知道工具名直接调（server + 裸 tool 名），不知道先用 mcp_search 关键词搜。参数透传给远端工具。',
    parameters: {
      server: { type: 'string', required: true, description: 'MCP 服务器名（见 mcp_search 摘要）' },
      tool: { type: 'string', required: true, description: '该 server 上的工具名（裸名，如 understand_image；误传注册全名 mcp__<server>__<tool> 会自动归一化）' },
      arguments: { type: 'json', description: '传给远端工具的参数字典；必须传 JSON 对象本身，不要传 JSON 字符串（兼容：误传字符串会自动解析）' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    execute: (args, exec) => {
      // P5 改道（D2）：走 gateway() 透传分支（loader 行 + preset 行双路），错误 throw→
      // 恒文本契约：catch 转文本（W1 映射表：miss/disabled/isError/empty/timeout/abort/
      // normalize 各分支 message 沿用 gatewayCall 原文，前缀 `MCP 调用异常：` 统一）。
      // 2026-08-24：模型可能把 arguments 填成 JSON 字符串（见 normalizeArguments 注释），先归一化再透传
      return controller
        .gateway(args.server, args.tool, normalizeArguments(args.arguments), exec.agent, exec.signal)
        .catch((error: unknown) => `MCP 调用异常：${msgOf(error)}`)
    },
  })
  return ctx.tools.register(definition)
}

/**
 * 注册 mcp_search + mcp_call 两个模型工具。`controller` 必须是调用方持有的唯一
 * 控制层实例（与空闲回收器共享同一引用计数/owner 状态），否则回收与调用不同步。
 * 返回合并 disposer。
 */
export function installMcpControlTools(ctx: Context, control: McpControlCtx, controller: McpCallController): () => void {
  return ctx.effect(() => {
    const disposers: Array<() => void> = []
    try {
      disposers.push(registerMcpSearchTool(ctx, control, controller))
      disposers.push(registerMcpCallTool(ctx, controller))
    } catch (error) {
      for (const d of disposers) d()
      throw error
    }
    return () => {
      for (const d of disposers) d()
    }
  }, 'mcp-skill-panel: mcp control tools')
}
