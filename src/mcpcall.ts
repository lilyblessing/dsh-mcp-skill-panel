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
}

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
    await entry.update({ disabled: false })
    state.aiEnabled.add(serverName)
    await control.setAiOwner(entryId, Date.now())
    ctx.logger.info?.(`mcp-skill-panel: AI enabled MCP server "${serverName}"`)
  }
  return wasDisabled
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
          if (Boolean(view.tools.get(name, view.scope as object | undefined))) {
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

/** gatewayCall 共享的引用计数态（与 ControllerState 同形；P4 网关常驻复用）。 */
export interface GatewayCallState {
  refCounts: Map<string, number>
  lastUsed: Map<string, number>
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

function startIdleReaper(control: McpControlCtx, ctx: Context, state: ControllerState): () => void {
  return ctx.interval(() => {
    const now = Date.now()
    for (const server of [...state.aiEnabled]) {
      const refCount = state.refCounts.get(server) ?? 0
      if (refCount > 0) continue
      const last = state.lastUsed.get(server) ?? 0
      if (now - last < control.keepAliveMs) continue
      const entry = control.resolveEntry(server)
      if (!entry) {
        state.aiEnabled.delete(server)
        state.refCounts.delete(server)
        state.lastUsed.delete(server)
        continue
      }
      const entryId = entry.id
      void (async () => {
        try {
          if (!entry.disabled) await entry.update({ disabled: true })
          // 二次检查：await 让出事件循环期间可能有新 call() 接手（refCount 升到 1），
          // 此时放弃本轮回收，不清 owner 不打日志。
          if ((state.refCounts.get(server) ?? 0) > 0) return
          await control.clearAiOwner(entryId)
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
  }, REAPER_INTERVAL_MS)
}

/**
 * 创建控制层控制器。`caches` 即控制层依赖（McpControlCtx），由 index.ts
 * 在 apply 里构建并封闭所有 IO。
 */
export function createMcpCallController(ctx: Context, caches: McpControlCtx): McpCallController {
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

function buildSummary(control: McpControlCtx): Array<{ server: string; summary: string }> {
  const catalog = control.getCatalog()
  // 只列「配置了 serverSummary 或 catalog 有快照」的 server（此前硬编码作者机器上的
  // cheatengine/mimo-image/chrome/calcmcp 摘要，本机没装这些 server 的用户会看到误导条目）。
  const merged: Record<string, string> = { ...control.serverSummary }
  const lines: Array<{ server: string; summary: string }> = []
  const seen = new Set<string>()
  for (const [server, summary] of Object.entries(merged)) {
    if (seen.has(server)) continue
    seen.add(server)
    lines.push({ server, summary })
  }
  // 补上 catalog 里有但 summary 没写的 server（截断长描述，避免输出膨胀）
  for (const server of Object.keys(catalog)) {
    if (seen.has(server)) continue
    seen.add(server)
    const first = catalog[server]?.tools?.[0]
    const raw = first ? String(first.description) : 'MCP server'
    const summary = raw.length > SUMMARY_MAX_LEN ? `${raw.slice(0, SUMMARY_MAX_LEN)}…` : raw
    lines.push({ server, summary })
  }
  lines.sort((a, b) => a.server.localeCompare(b.server))
  return lines
}

function registerMcpSearchTool(ctx: Context, control: McpControlCtx): () => void {
  const definition = defineTool({
    name: 'mcp_search',
    description:
      '检索可用的 MCP 服务器与工具目录。三层：空参数返回 server 清单（无 schema）；传 server 列出该服务器工具（分页，无 schema）；传 query 做关键词 top-K 全文检索（命中返回完整 schema）。知道工具名可直接 mcp_call，不知道先用关键词搜。中文连写请用空格分词（如“搜索 网页”）。',
    parameters: {
      query: { type: 'string', description: '检索关键词，按工具名/描述/参数名打分（缺省 top-K 8，上限 10）' },
      server: { type: 'string', description: '列出指定 MCP server 的全部工具（分页，无 schema）' },
      limit: { type: 'integer', description: '关键词 top-K（默认 8）或 server 页大小（默认 20，上限 50）' },
      offset: { type: 'integer', description: 'server 页偏移（默认 0，仅 server 分支有效）' },
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

      if (server) {
        const page = listServer(catalog, server, offset, pageLimit)
        if (!page) {
          return toJson({
            ok: true,
            kind: 'list',
            server,
            found: false,
            count: 0,
            totalCount: 0,
            offset,
            limit: pageLimit,
            tools: [],
            hint: `未知 server "${server}"，空查 mcp_search 看 server 清单；工具多时改 query + server 缩小范围；中文连写请用空格分词。`,
          })
        }
        const tools = page.tools.filter((tool) => keep(tool.name))
        return toJson({
          ok: true,
          kind: 'list',
          server,
          found: true,
          count: tools.length,
          totalCount: page.totalCount,
          offset,
          limit: pageLimit,
          tools,
          hint: '工具多时改 query + server 缩小范围；中文连写请用空格分词。',
        })
      }

      if (query) {
        const hits: SearchHit[] = searchCatalog(catalog, query, topK).filter((hit) => keep(hit.tool.name))
        return toJson({ ok: true, kind: 'search', query, count: hits.length, limit: topK, hits })
      }

      const servers = buildSummary(control)
      const text = servers.map((s) => `- ${s.server}: ${s.summary}`).join('\n')
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
      // 2026-08-24：模型可能把 arguments 填成 JSON 字符串（见 normalizeArguments 注释），先归一化再透传
      return controller.call(args.server, args.tool, normalizeArguments(args.arguments), exec.agent, exec.signal)
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
      disposers.push(registerMcpSearchTool(ctx, control))
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
