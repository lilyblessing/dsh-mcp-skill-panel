/**
 * MCP 工具级禁用（常开）：在 server 级启停之上，按工具精确控制。
 *
 * 作用域（2026-08-27 按用户需求拆分）：
 * - 全局禁用（toolDisabled）：跨所有工作区生效，作用于全局 MCP server；
 * - 项目禁用（projectToolDisabled）：仅所属工作区生效，作用于项目级 MCP server。
 *   判断依据：某 server 是否项目 MCP（projectServerOwner 有值）→ 走项目表（key=该工作区）；
 *   否则为全局 MCP → 走全局表。用户在 A 工作区禁用的项目 MCP 工具不会影响 B 工作区。
 *
 * - 装配过滤常开：`system-prompt/assemble` 依据「当前会话工作区」把命中的 mcp__ 工具
 *   从模型目录剔除（项目表只匹配 owner===当前工作区的会话；全局表无条件生效）
 * - mcp_search / mcp_call 联动：检索不返回禁用工具、调用直接拒绝。
 *
 * 内存 Map 是装配过滤唯一数据源（同步读，零异步），由本模块维护并随 toggle 更新；
 * 实现为模块级单例，被 routes / mcpcall / filter 共享。
 */
import type { Context } from '@deepseek-ai/cordis'
import type { PromptAssembly } from '@deepseek-ai/dsh-system-prompt'
import { readState, writeState } from './state'
import { serverOfMcp } from './catalog'
import { projectServerOwner } from './project-mcp'

/** 全局禁用：serverName → 禁用的工具全名集合（mcp__<server>__<tool>）。 */
const disabledTools = new Map<string, Set<string>>()
/** 项目禁用：工作空间 → serverName → 禁用的工具全名集合。 */
const projectDisabledTools = new Map<string, Map<string, Set<string>>>()
/** 空集合兜底（避免每次查询分配新 Set）。 */
const EMPTY_SET: ReadonlySet<string> = new Set<string>()

/** 启动/热更新时从 state.json 加载禁用集合（全局 + 项目两张表）。 */
export async function loadDisabledTools(): Promise<void> {
  disabledTools.clear()
  projectDisabledTools.clear()
  const state = await readState().catch(() => undefined)
  const globalMap = state?.toolDisabled
  if (globalMap) {
    for (const [server, names] of Object.entries(globalMap)) {
      if (Array.isArray(names)) disabledTools.set(server, new Set(names.filter((n) => typeof n === 'string')))
    }
  }
  const projectMap = state?.projectToolDisabled
  if (projectMap) {
    for (const [workspace, servers] of Object.entries(projectMap)) {
      if (!servers || typeof servers !== 'object') continue
      const perServer = new Map<string, Set<string>>()
      for (const [server, names] of Object.entries(servers)) {
        if (Array.isArray(names)) perServer.set(server, new Set(names.filter((n) => typeof n === 'string')))
      }
      if (perServer.size > 0) projectDisabledTools.set(workspace, perServer)
    }
  }
}

/** 某 server 的禁用工具集合（面板展示用；workspace=该 server 所属工作区，与 tableKeys 同源）。 */
export function disabledToolsOf(serverName: string, workspace?: string): ReadonlySet<string> {
  const owner = projectServerOwner(serverName)
  if (owner !== undefined) {
    // 项目 MCP：指定工作区的项目表
    const target = workspace ?? owner
    return projectDisabledTools.get(target)?.get(serverName) ?? EMPTY_SET
  }
  return disabledTools.get(serverName) ?? EMPTY_SET
}

/**
 * 工具全名是否被禁用（按当前会话工作区判定作用域）：
 * - 全局表无条件生效；
 * - 项目表只在「会话工作区 === 项目所属工作区」时生效（A 区禁用不影响 B 区）。
 * workspace 缺省时仅全局表生效（无会话上下文的冷路径）。
 */
export function isToolDisabled(fullName: string, workspace?: string): boolean {
  const server = serverOfMcp(fullName)
  if (server === null) return false
  const owner = projectServerOwner(server)
  if (owner !== undefined) {
    if (workspace === undefined) return false
    if (!strEquals(workspace, owner)) return false
    return projectDisabledTools.get(owner)?.get(server)?.has(fullName) ?? false
  }
  return disabledTools.get(server)?.has(fullName) ?? false
}

/**
 * 切换某工具禁用状态（面板）：
 * - 项目 MCP server（projectServerOwner 有值）→ 写入所属工作区的项目表（仅该区生效）；
 * - 全局 MCP server → 写入全局表。
 * 同时更新内存 Map + 持久化到 state.json（原子合并写盘）。
 * `persist: false`（selftest）只改内存，不动磁盘。
 */
export async function setToolDisabled(serverName: string, fullName: string, disabled: boolean, persist = true): Promise<void> {
  const owner = projectServerOwner(serverName)
  if (owner !== undefined) {
    // 项目表：key = 项目所属工作区（与面板一致；忽略传入 workspace，以 owner 为准）
    let perServer = projectDisabledTools.get(owner)
    if (disabled && !perServer) {
      perServer = new Map()
      projectDisabledTools.set(owner, perServer)
    }
    if (perServer) {
      toggleInSet(perServer, serverName, fullName, disabled)
      if (perServer.size === 0) projectDisabledTools.delete(owner)
    }
    if (persist) {
      const state = await readState()
      state.projectToolDisabled ??= {}
      const serverMap = (state.projectToolDisabled[owner] ??= {})
      toggleInList(serverMap, serverName, fullName, disabled)
      if (Object.keys(serverMap).length === 0) delete state.projectToolDisabled[owner]
      await writeState(state)
    }
  } else {
    toggleInSet(disabledTools, serverName, fullName, disabled)
    if (persist) {
      const state = await readState()
      state.toolDisabled ??= {}
      toggleInList(state.toolDisabled, serverName, fullName, disabled)
      await writeState(state)
    }
  }
}

/** {@link resolveToolBulkTargets} 的结果：要么给出精确名单，要么给出拒绝原因。 */
export type ToolBulkTargets = { targets: string[]; ignored: string[] } | { error: string }

/**
 * 解析 `/mcp/toolBulk` 的 `toolNames` **三态**契约（纯函数，无 IO，可直测）。
 *
 * - `undefined`（字段缺失）= 该 server 面板视图里的**全部**工具 —— 只有这一种写法表示全部；
 * - 显式数组 = 精确集合：`[]` 是合法空操作（targets 为空，调用方据此跳过写盘）；
 *   非空则与 known 求交，**一条都不匹配即拒绝**（否则「以为批量禁用了，实际一条没动」）；
 * - 其它类型（字符串 / 数字 / 对象 / null / 含非字符串项的数组）= 拒绝：契约是工具全名数组，
 *   静默降级成「全部」会把一次客户端 bug 变成该 server 的全量持久化写入。
 *
 * 2026-09-16 修复（审查 BLOCK-1）：此前「非空数组 ? 交集 : 全部」，显式 `[]` 与任何非数组
 * 都落进「全部」——面板「按当前过滤」在过滤命中 0 项时天然发 `[]`，对 450 工具的 server
 * 就是一次性全量禁用，与用户意图相反且已写盘。
 * @param known - 该 server 当前已知的工具全名（调用方视图，顺序保留）。
 * @param toolNames - 客户端原始入参（未收窄，故为 unknown）。
 * @returns 精确名单 + 未识别名单，或拒绝原因（调用方转 400）。
 */
export function resolveToolBulkTargets(known: readonly string[], toolNames: unknown): ToolBulkTargets {
  const knownSet = new Set(known)
  if (toolNames === undefined) return { targets: [...known], ignored: [] }
  if (!Array.isArray(toolNames)) return { error: 'toolNames must be an array of tool full names' }
  const nonString = toolNames.findIndex((name) => typeof name !== 'string')
  if (nonString >= 0) {
    return { error: `toolNames must be an array of tool full names (item ${nonString} is not a string)` }
  }
  const names = [...new Set(toolNames as string[])]
  const nameSet = new Set(names)
  const targets = known.filter((name) => nameSet.has(name))
  const ignored = names.filter((name) => !knownSet.has(name))
  if (names.length > 0 && targets.length === 0) {
    // 显式点名却一条都不认识：报错而不是 no-op —— 名单多半是裸名 / 非本 server / 过期快照
    return { error: `toolNames matches none of the ${known.length} known tools on this server (bare names or a stale list?)` }
  }
  return { targets, ignored }
}

/**
 * 批量切换某 server 上一组工具的禁用状态（面板「全部禁用 / 全部启用 / 按过滤」）。
 *
 * 与逐个调用 {@link setToolDisabled} 的区别只在 IO：这里对 state.json 只做
 * **一次** 读-改-写。prompthelper 这种 450 工具的 server 逐个写会是 450 次
 * 合并写盘 + 450 次面板失效，实际不可用。
 *
 * 语义与单个开关完全一致（同一张表、同一套项目/全局作用域分派），所以批量与
 * 单点操作可以任意交替，不存在「批量模式」这种隐藏状态。
 * @param serverName - 目标 MCP server。
 * @param toolNames - 工具全名（mcp__<server>__<tool>）列表；非本 server 的条目忽略。
 * @param disabled - true=禁用这批，false=启用这批。
 * @param persist - false 时只改内存不落盘（selftest）。
 * @returns 实际发生变化的工具数。
 */
export async function setToolsDisabledBulk(
  serverName: string,
  toolNames: readonly string[],
  disabled: boolean,
  persist = true,
): Promise<number> {
  const prefix = `mcp__${serverName}__`
  // 只接受本 server 的注册全名：跨 server 的误传会污染禁用表且永不生效。
  const names = [...new Set(toolNames.filter((name) => typeof name === 'string' && name.startsWith(prefix)))]
  if (names.length === 0) return 0
  const owner = projectServerOwner(serverName)
  const before = disabledToolsOf(serverName, owner).size

  if (owner !== undefined) {
    let perServer = projectDisabledTools.get(owner)
    if (disabled && !perServer) {
      perServer = new Map()
      projectDisabledTools.set(owner, perServer)
    }
    if (perServer) {
      for (const name of names) toggleInSet(perServer, serverName, name, disabled)
      if (perServer.size === 0) projectDisabledTools.delete(owner)
    }
    if (persist) {
      const state = await readState()
      state.projectToolDisabled ??= {}
      const serverMap = (state.projectToolDisabled[owner] ??= {})
      for (const name of names) toggleInList(serverMap, serverName, name, disabled)
      if (Object.keys(serverMap).length === 0) delete state.projectToolDisabled[owner]
      await writeState(state)
    }
  } else {
    for (const name of names) toggleInSet(disabledTools, serverName, name, disabled)
    if (persist) {
      const state = await readState()
      state.toolDisabled ??= {}
      for (const name of names) toggleInList(state.toolDisabled, serverName, name, disabled)
      await writeState(state)
    }
  }
  return Math.abs(disabledToolsOf(serverName, owner).size - before)
}

/** 内存 Set 表的开关（serverName → Set<fullName>）。 */
function toggleInSet(table: Map<string, Set<string>>, serverName: string, fullName: string, disabled: boolean): void {
  let set = table.get(serverName)
  if (disabled) {
    if (!set) {
      set = new Set()
      table.set(serverName, set)
    }
    set.add(fullName)
  } else if (set) {
    set.delete(fullName)
    if (set.size === 0) table.delete(serverName)
  }
}

/** state.json 数组表的开关（serverName → string[]）。 */
function toggleInList(table: Record<string, string[]>, serverName: string, fullName: string, disabled: boolean): void {
  const list = (table[serverName] ??= [])
  const at = list.indexOf(fullName)
  if (disabled && at < 0) list.push(fullName)
  if (!disabled && at >= 0) list.splice(at, 1)
  if (list.length === 0) delete table[serverName]
}

/** Windows 路径比较忽略大小写（c:\ 与 C:\ 视为同一工作区）。 */
function strEquals(a: string, b: string): boolean {
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
}

/**
 * 常开装配过滤：把用户禁用的 MCP 工具从模型工具目录剔除。
 * 项目表按当前会话工作区匹配（context.agent.session.header.cwd），
 * 会话工作区不等于项目所属区时该项目工具本就不会挂载可见（由 project-mcp 过滤），
 * 这里对全局表无条件生效、对项目表按 owner===cwd 生效。
 */
export function installToolDisableFilter(ctx: Context): () => void {
  return ctx.effect(() => {
    const off = ctx.root.on(
      'system-prompt/assemble',
      (
        assembly: PromptAssembly,
        context: unknown,
        next: () => Promise<PromptAssembly>,
      ): Promise<PromptAssembly> => {
        if (assembly && Array.isArray(assembly.tools)) {
          // 快速通道：禁用表全空时零开销放行（默认场景，无 per-tool 解析）
          if (disabledTools.size === 0 && projectDisabledTools.size === 0) return next()
          const cwd = (context as { agent?: { session?: { header?: { cwd?: unknown } } } } | undefined)?.agent?.session?.header?.cwd
          const workspace = typeof cwd === 'string' ? cwd : undefined
          assembly.tools = assembly.tools.filter((tool) => {
            const name = String(tool?.name ?? '')
            return !isToolDisabled(name, workspace)
          })
        }
        return next()
      },
    )
    return off
  }, 'mcp-skill-panel: tool disable filter')
}