/**
 * 项目级（工作空间）MCP 运行时：读取 <workspace>/.dsh/mcps 下所有子目录的 mcp.json，
 * 惰性挂载 dsh-mcp-client 行到 loader 根树，并按「当前会话工作空间」过滤可见性，
 * 实现「仅该项目会话可见」。
 *
 * 工作空间 = 会话 cwd（用户约定：只认这个文件夹，不做 .git 向上查找）；
 * 根目录下没有 .dsh/mcps 目录 → 该工作空间没有项目 MCP。
 * 读取规则：<root>/.dsh/mcps/mcp.json 与所有子目录下（`**`）的 mcp.json
 * 都读，按 serverName 去重：先读根目录 json，子目录 json 覆盖根目录。
 *
 * 2026-08-27 实测确认的框架约束：
 * - dsh-mcp-client 的 serverName 按 ctx.root 全局唯一（activeServerNames WeakMap），
 *   跨工作空间同 serverName 只能挂第一个实例，后续冲突跳过并告警。
 * - agent 的 scope key 已被 preset standing key 绑定（bindScopeParent 对已绑定 key
 *   抛错），无法再绑项目作用域 → 严格「按会话作用域挂载」被框架锁死；
 *   因此挂载到 loader 根树（对面板枚举/启停/catalog 完全复用），「仅项目会话可见」
 *   由本模块的常开过滤（system-prompt/assemble 按会话 cwd）实现。
 * - 根树 backing 文件 cordis.yml 每次启动被重置为 []，create 触发的 tree.write 无害。
 * - 已知限制：插件 HMR 重载后 projectOwners 内存表清空（挂载的 projmcp-* 行仍在
 *   根树），在下次会话进入该工作空间前项目行会短暂按全局展示；生产中无 HMR 无此现象。
 */
import type { Context } from '@deepseek-ai/cordis'
import type { PromptAssembly } from '@deepseek-ai/dsh-system-prompt'
import { watch, type FSWatcher } from 'node:fs'
import { access, readFile, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { McpServers, McpRowConfig } from './mcp-convert'
import { parseMcpServersJson, resolveServersEnv, serversToRows } from './mcp-convert'
import { serverOfMcp } from './catalog'
import { readState } from './state'
import { messageOf } from './util'

/** 工作空间根下项目 MCP 的固定目录。 */
const MCPS_DIR = '.dsh/mcps'
/** watcher 去抖窗口（合并文件批量写）。 */
const RESCAN_DEBOUNCE_MS = 200

/** serverName → 所属工作空间根（仅本项目 MCP 行；全局行不在表内）。 */
const projectOwners = new Map<string, string>()
/** 最近一次会话进入的工作空间（随会话切换更新；面板添加项目 MCP 的目标工作区）。 */
let activeWorkspace: string | null = null

/** 查询某 serverName 是否为本项目 MCP 行及其所属工作空间（collect/面板集成用）。 */
export function projectServerOwner(serverName: string): string | undefined {
  return projectOwners.get(serverName)
}

/** 最近一次会话进入的工作空间（add project 目标 + 面板展示当前工作区）。 */
export function getActiveWorkspace(): string | null {
  return activeWorkspace
}

/** 路径比较：Windows 下忽略大小写（同一路径大小写不同视为同一工作区）。 */
function strEquals(a: string, b: string | null | undefined, mode?: 'ignorecase'): boolean {
  if (typeof b !== 'string') return false
  return mode === 'ignorecase' ? a.toLowerCase() === b.toLowerCase() : a === b
}

interface WorkspaceState {
  root: string
  /** serverName → loader entryId。 */
  entries: Map<string, string>
  watcher: FSWatcher | undefined
}

const workspaces = new Map<string, WorkspaceState>()

/* ── 文件系统发现 ─────────────────────────────────────────────────────── */

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

/** 递归收集 `dir` 下所有子目录（含 dir 本身）的 mcp.json：根目录文件在前、子目录按路径序。 */
async function collectMcpJsonFiles(dir: string, out: string[]): Promise<void> {
  if (await fileExists(join(dir, 'mcp.json'))) out.push(join(dir, 'mcp.json'))
  let names: string[] = []
  try {
    const entries = await readdir(dir, { withFileTypes: true })
    names = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort()
  } catch {
    return
  }
  for (const name of names) await collectMcpJsonFiles(join(dir, name), out)
}

/**
 * 扫描工作空间的项目 MCP 配置：根目录 mcp.json 优先，子目录覆盖（后写覆盖先写）。
 * 目录不存在 → 空。解析错误经 warn 回调上报、跳过该文件。
 * 纯文件系统逻辑（不依赖 ctx），可被 selftest 用临时目录覆盖。
 */
export async function scanWorkspaceMcp(root: string, warn?: (message: string) => void): Promise<McpServers> {
  const mcpsDir = join(root, MCPS_DIR)
  if (!(await isDirectory(mcpsDir))) return {}
  const files: string[] = []
  await collectMcpJsonFiles(mcpsDir, files)
  const servers: McpServers = {}
  for (const file of files) {
    let text: string
    try {
      text = await readFile(file, 'utf8')
    } catch (error) {
      warn?.(`读取项目 MCP 配置失败 ${file}: ${messageOf(error)}`)
      continue
    }
    const parsed = parseMcpServersJson(text)
    for (const error of parsed.errors) warn?.(`${file}: ${error}`)
    // 后写覆盖先写（根目录文件先被收集，子目录在后 → 子目录覆盖根目录）
    for (const [name, server] of Object.entries(parsed.servers)) servers[name] = server
  }
  return servers
}

/* ── 挂载 / 卸载 ──────────────────────────────────────────────────────── */

/** 工作空间根的稳定 id 前缀（djb2 hash，避免跨工作空间 entry id 冲突）。 */
function projectIdPrefix(root: string): string {
  let hash = 5381
  for (let i = 0; i < root.length; i += 1) hash = ((hash << 5) + hash + root.charCodeAt(i)) >>> 0
  return `projmcp-${hash.toString(16).padStart(8, '0')}`
}

/**
 * 项目 MCP 的 serverName 重命名：追加<路径哈希 8 位 hex>后缀。
 *
 * 背景（2026-08-27 用户需求）：不同工作区可能配置「同 serverName 但路径参数不同」
 * 的项目 MCP（如各自 codegraph 指向不同仓库）。dsh-mcp-client 的 serverName 全进程
 * 唯一，同名会互相挤占 → 后挂载的工作区会拿到前者的路径配置、调用必然失败。
 * 给 serverName 追加确定性路径后缀后，不同工作区 = 不同 serverName = 各自独立实例。
 *
 * 形态：`<原名>-<8位hex>`（如 codegraph-e5f6a7b8，原名领先更可读）。
 * 约束：serverName 限 `[A-Za-z0-9_-]{1,32}`,后缀 8 位 hex + 分隔符 `-`;
 * 原名超过 23 字符时截断尾部（保留头部可读性），总长收敛到 ≤32。
 */
export function projectServerName(root: string, name: string): string {
  let hash = 5381
  for (let i = 0; i < root.length; i += 1) hash = ((hash << 5) + hash + root.charCodeAt(i)) >>> 0
  const suffix = `${hash.toString(16).padStart(8, '0')}`
  return `${name.slice(0, 23)}-${suffix}`
}

/** 对比配置变化（loader.update 的 diff 需要；JSON 序列化足够判等）。 */
function configChanged(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) !== JSON.stringify(b)
}

/**
 * 项目 MCP 行构建：原始 mcpServers 配置 → dsh-mcp-client 行，
 * 并把 serverName 重命名为带路径哈希前缀（不同工作区同名 server 拆成独立实例）。
 * entry id 仍由 projectIdPrefix（同样含路径 hash）保证跨工作区唯一，无需重复缀加。
 */
function buildRows(root: string, servers: McpServers): McpRowConfig[] {
  const rows = serversToRows(resolveServersEnv(servers), projectIdPrefix(root))
  for (const row of rows) {
    const raw = String(row.config.serverName ?? '')
    row.config.serverName = projectServerName(root, raw)
  }
  return rows
}

/** 按行集合同步该工作空间已挂载的条目：删多出的、更新变化的、新建缺的。
 * 应用 state.json 的 projectMcp 禁用意图（面板开关 → 重启/热更新后保持）。 */
async function syncRows(ctx: Context, state: WorkspaceState, rows: McpRowConfig[]): Promise<void> {
  const wanted = new Map(rows.map((row) => [String(row.config.serverName), row]))
  // state 内存缓存：每次 sync 读一次，成本可忽略（面板 toggle 也走同一缓存）
  const stateFile = await readState().catch(() => undefined)
  const intentOf = (serverName: string): boolean => Boolean(stateFile?.projectMcp?.[state.root]?.[serverName])
  // 删除已不再需要的行
  for (const [serverName, entryId] of [...state.entries]) {
    if (wanted.has(serverName)) continue
    try {
      await ctx.loader.remove(entryId)
    } catch (error) {
      ctx.logger.warn?.(`mcp-skill-panel: 卸载项目 MCP "${serverName}" 失败: ${messageOf(error)}`)
    }
    state.entries.delete(serverName)
    projectOwners.delete(serverName)
  }
  for (const [serverName, row] of wanted) {
    const existingId = state.entries.get(serverName)
    if (existingId) {
      try {
        const entry = ctx.loader.resolve(existingId)
        const wantDisabled = intentOf(serverName)
        if (entry && (configChanged(entry.options.config, row.config) || Boolean(entry.disabled) !== wantDisabled)) {
          await ctx.loader.update(existingId, { ...row, disabled: wantDisabled })
        }
      } catch (error) {
        ctx.logger.warn?.(`mcp-skill-panel: 更新项目 MCP "${serverName}" 失败: ${messageOf(error)}`)
      }
      continue
    }
    // serverName 全进程唯一：其他工作空间已占 → 跳过并告警（框架硬约束）
    const otherOwner = projectOwners.get(serverName)
    if (otherOwner !== undefined && otherOwner !== state.root) {
      ctx.logger.warn?.(
        `mcp-skill-panel: 项目 MCP "${serverName}"（${state.root}）与工作空间 ${otherOwner} 重名，已跳过（serverName 全进程唯一）`,
      )
      continue
    }
    try {
      await ctx.loader.create({ ...row, disabled: intentOf(serverName) })
      state.entries.set(serverName, row.id)
      projectOwners.set(serverName, state.root)
    } catch (error) {
      ctx.logger.warn?.(`mcp-skill-panel: 挂载项目 MCP "${serverName}" 失败: ${messageOf(error)}`)
    }
  }
}

/** 卸载某工作空间的全部项目 MCP 条目并停 watcher。 */
async function disposeWorkspace(ctx: Context, root: string): Promise<void> {
  const state = workspaces.get(root)
  if (!state) return
  workspaces.delete(root)
  state.watcher?.close()
  for (const [serverName, entryId] of [...state.entries]) {
    try {
      await ctx.loader.remove(entryId)
    } catch {
      /* 行已失效，忽略 */
    }
    projectOwners.delete(serverName)
  }
  state.entries.clear()
}

/** 会话进入工作空间时：无 .dsh/mcps → 卸载；有 → 扫描并按需挂载。
 * 记录「最近进入的工作空间」（活动工作区，随会话切换更新）。 */
async function ensureWorkspace(ctx: Context, root: string): Promise<void> {
  // 会话切换即刷新活动工作区（即使该目录没有项目 MCP，也是当前所处工作区）
  activeWorkspace = root
  if (!(await isDirectory(join(root, MCPS_DIR)))) {
    await disposeWorkspace(ctx, root)
    return
  }
  const servers = await scanWorkspaceMcp(root, (msg) => ctx.logger.warn?.(`mcp-skill-panel: ${msg}`))
  const rows = buildRows(root, servers)
  let state = workspaces.get(root)
  if (!state) {
    state = { root, entries: new Map(), watcher: undefined }
    workspaces.set(root, state)
  }
  await syncRows(ctx, state, rows)
  if (!state.watcher) {
    try {
      state.watcher = watch(join(root, MCPS_DIR), { recursive: true }, () => {
        void refresh(ctx, root, state!)
      })
    } catch (error) {
      ctx.logger.warn?.(`mcp-skill-panel: 无法监视 ${join(root, MCPS_DIR)}: ${messageOf(error)}`)
    }
  }
}

/** watcher 触发的重扫：配置/目录变化后按新集合同步（热更新）。 */
async function refresh(ctx: Context, root: string, state: WorkspaceState): Promise<void> {
  if (!(await isDirectory(join(root, MCPS_DIR)))) {
    await disposeWorkspace(ctx, root)
    return
  }
  const servers = await scanWorkspaceMcp(root, (msg) => ctx.logger.warn?.(`mcp-skill-panel: ${msg}`))
  await syncRows(ctx, state, buildRows(root, servers))
}

/* ── 可见性过滤（常开，独立于 autoManage） ────────────────────────────── */

/**
 * 常开过滤：项目 MCP 工具仅在本工作空间会话的装配结果中可见。
 * 非项目 MCP 工具不在此处理（交给 autoManage 的过滤器）。
 */
function installProjectMcpVisibility(ctx: Context): () => void {
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
          const workspace = typeof cwd === 'string' ? cwd : null
          assembly.tools = assembly.tools.filter((tool) => {
            const name = String(tool?.name ?? '')
            if (!name.startsWith('mcp__')) return true
            const server = serverOfMcp(name)
            // 畸形工具名保守保留，不误伤
            if (server === null) return true
            const owner = projectOwners.get(server)
            // 非项目 MCP：交给 autoManage 过滤器
            if (owner === undefined) return true
            // 项目 MCP：仅本项目（活动工作空间）会话可见；无会话上下文时隐藏
            // Windows 路径大小写不敏感（c:\ 与 C:\ 视为同一工作区）
            return workspace !== null && strEquals(workspace, owner, 'ignorecase')
          })
        }
        return next()
      },
    )
    return off
  }, 'mcp-skill-panel: project mcp visibility')
}

/** 安装项目 MCP 运行时：会话挂载 + 常开过滤。返回整体释放函数。 */
export function installProjectMcp(ctx: Context): () => void {
  const disposers: Array<() => void> = []
  disposers.push(
    ctx.effect(() => {
      const off = ctx.root.on('agent/session-start', (payload: { agent?: { session?: { header?: { cwd?: unknown } } } }) => {
        const cwd = payload?.agent?.session?.header?.cwd
        if (typeof cwd !== 'string' || cwd.length === 0) return
        void ensureWorkspace(ctx, cwd).catch((error) => {
          ctx.logger.warn?.(`mcp-skill-panel: 项目 MCP 挂载失败（${cwd}）: ${messageOf(error)}`)
        })
      })
      return off
    }, 'mcp-skill-panel: project mcp session hook'),
  )
  disposers.push(installProjectMcpVisibility(ctx))
  return () => {
    for (const dispose of disposers) dispose()
  }
}

/** 面板添加/外部修改项目 MCP 文件后，强制重扫该工作空间并同步挂载（幂等）。 */
export async function remountWorkspace(ctx: Context, root: string): Promise<void> {
  await ensureWorkspace(ctx, root)
}
