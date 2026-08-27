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