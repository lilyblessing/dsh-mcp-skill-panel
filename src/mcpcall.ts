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
import type { JsonValue } from '@deepseek-ai/dsh-tools'
import type { Catalog, SearchHit } from './catalog'
import { searchCatalog, listServer } from './catalog'

/** 空闲回收器扫描周期（ms）。 */
const REAPER_INTERVAL_MS = 10_000
/** waitRegistered 轮询间隔（ms）。 */
const REGISTER_POLL_MS = 50
/** 默认注册 / 调用超时：60s。 */
const DEFAULT_TOOL_TIMEOUT_MS = 60_000

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
  /** 轮询 + 事件加速等待某工具注册。 */
  waitRegistered(name: string, scopeKey: object | undefined, timeoutMs: number): Promise<void>
  /** 完整调用流程，返回给模型的文本结果（不会 throw，错误也转文本）。 */
  call(
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

function msgOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
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

const DEFAULT_SUMMARY: Record<string, string> = {
  cheatengine: '游戏进程内存读写与调试',
  'mimo-image': '图片理解与描述（多模态模型）',
  chrome: '浏览器自动化（导航/点击/截图/控制台/上传下载）',
  calcmcp: '数学计算（numpy / scipy 数值与符号计算）',
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
  control: McpControlCtx,
  ctx: Context,
  name: string,
  scopeKey: object | undefined,
  timeoutMs: number,
): Promise<void> {
  void control
  const start = Date.now()
  return new Promise<void>((resolve, reject) => {
    let settled = false
    let pollTimer: (() => void) | undefined
    let offTools: (() => boolean) | undefined
    const finish = (error?: Error) => {
      if (settled) return
      settled = true
      pollTimer?.()
      offTools?.()
      if (error) reject(error)
      else resolve()
    }
    const check = () => {
      if (settled) return
      let found = false
      try {
        found = Boolean(ctx.tools.get(name, scopeKey as import('@deepseek-ai/dsh-scope').ScopeKey | undefined))
      } catch {
        found = false
      }
      if (found) return finish()
      if (Date.now() - start >= timeoutMs) {
        return finish(new Error(`tool "${name}" 未在 ${timeoutMs}ms 内注册`))
      }
      pollTimer = ctx.timeout(check, REGISTER_POLL_MS)
    }
    offTools = ctx.root.on('tools/change', () => check())
    check()
  })
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
          await control.clearAiOwner(entryId)
          ctx.logger.info?.(`mcp-skill-panel: idle-reaped MCP server "${server}"`)
        } catch (error) {
          ctx.logger.warn?.(`mcp-skill-panel: idle reaper disable "${server}" failed: ${msgOf(error)}`)
        } finally {
          state.aiEnabled.delete(server)
          state.refCounts.delete(server)
          state.lastUsed.delete(server)
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

    waitRegistered(name, scopeKey, timeoutMs) {
      return waitRegistered(caches, ctx, name, scopeKey, timeoutMs)
    },

    async call(serverName, toolName, args, agent, signal, explicitTimeoutMs) {
      const name = `mcp__${serverName}__${toolName}`
      const scopeKey = agent ? scopeOf(agent.ctx) : undefined
      const entry = caches.resolveEntry(serverName)
      if (!entry) return `未知 MCP server：${serverName}（不在 loader 中）`
      const entryId = entry.id
      const timeoutMs = explicitTimeoutMs ?? caches.serverTimeoutMs(serverName)

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
        await waitRegistered(caches, ctx, name, scopeKey, timeoutMs)
        const result = await ctx.tools.execute({
          callId: `mcp-call-${randomUUID()}` as import('@deepseek-ai/dsh-llm').CallId,
          name,
          arguments: args,
          agent,
          signal,
        })
        state.lastUsed.set(serverName, Date.now())
        if (result && result.isError) {
          failed = true
          return `MCP ${serverName}.${toolName} 调用失败：${msgOf((result as { error?: unknown }).error ?? 'unknown error')}`
        }
        const text = contentText(result ? (result as { content?: unknown }).content : undefined)
        return text.length > 0 ? text : `MCP ${serverName}.${toolName} 无返回内容`
      } catch (error) {
        failed = true
        return `MCP ${serverName}.${toolName} 调用异常：${msgOf(error)}`
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
  const merged: Record<string, string> = { ...DEFAULT_SUMMARY, ...control.serverSummary }
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
      '检索可用的 MCP 服务器与工具目录。空参数返回能力摘要表；传 server 列出该服务器的全部工具；传 query 做关键词 top-K 全文检索（命中返回完整 schema）。',
    parameters: {
      query: { type: 'string', description: '检索关键词，按工具名/描述/参数名打分' },
      server: { type: 'string', description: '列出指定 MCP server 的全部工具' },
      limit: { type: 'integer', description: 'top-K 上限（默认 5，最大 10）' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    execute: async (args) => {
      const catalog = control.getCatalog()
      const query = typeof args.query === 'string' ? args.query.trim() : ''
      const server = typeof args.server === 'string' ? args.server.trim() : ''
      const limit = clampLimit(typeof args.limit === 'number' ? args.limit : undefined, control.searchLimitDefault, control.searchLimitMax)

      if (server) {
        const tools = listServer(catalog, server) ?? []
        return toJson({
          ok: true,
          kind: 'list',
          server,
          found: listServer(catalog, server) !== undefined,
          count: tools.length,
          tools,
        })
      }

      if (query) {
        const hits: SearchHit[] = searchCatalog(catalog, query, limit)
        return toJson({ ok: true, kind: 'search', query, count: hits.length, limit, hits })
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
      '调用一个 MCP 服务器上的工具。自动保活启用目标 server（用完按 keepAliveMs 空闲回收），等待注册后在下层执行。参数透传给远端工具。',
    parameters: {
      server: { type: 'string', required: true, description: 'MCP 服务器名（见 mcp_search 摘要）' },
      tool: { type: 'string', required: true, description: '该 server 上的工具名' },
      arguments: { type: 'json', description: '传给远端工具的参数字典' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    execute: (args, exec) => {
      return controller.call(args.server, args.tool, args.arguments ?? {}, exec.agent, exec.signal)
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
