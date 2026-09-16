/**
 * preset 行句柄来源（0.5.7）—— 模型侧可见性 / 面板开关 / mcp_call 唤醒的公共咽喉。
 *
 * 背景与断点（2026-09-13 实测取证，详见 README 变更日志 v0.6.0 的
 * 「preset 行句柄 + 临时拉起闭环 + 已安装能力表」一节）：
 * dsh 0.1.2-rc.1 起 preset 行挂在 standing 组合，**不在 `ctx.loader.entries()`
 * 也不在 `ctx.loader.resolve()` 可达域**（resolve 恒抛 "cannot resolve entry"）。
 * 0.5.5/0.5.6 因此把所有 preset 行逻辑降级成「快照读取 + 意图排队」：
 * `listPresetMcpRows` 走 `agentPresets.compositionInventory()` 与 preset 文件文本，
 * 只读得到 `enabled`/`fiberState` 快照，**拿不到 Entry 句柄**。后果是三处通路
 * 同时断裂（同一根因）：
 *   1. `buildVisibility` 遍历 `ctx.loader.entries()` → 表为空 → filter.ts 的
 *      `?? true` 兜底放行 → **可见性层整体空转，MCP 工具全部照原样进上下文**；
 *   2. `toggleMcp` 的 `entry.update({disabled})` 无句柄 → 只写 state.json.desired
 *      意图 → `applyPendingMcp` 仍 resolve 失败 → **面板开关永不生效**；
 *   3. `mcp_call` 的 `resolveEntry` miss → 走 `presetRow.disabled` 分支直接 throw
 *      「当前已停用…请先在面板打开」 → **关着的 MCP 叫不醒**（无法临时拉起）。
 *
 * 解法：dsh 0.1.5-rc.2 公开了 standing 组合的 EntryTree 读取口：
 *   `standingMountFor(agentCtx) -> { presetId, fiber, tree: EntryTree, key }`
 *   `livePresetMounts(within?)   -> PresetMount[]`（模块级注册表，无需 agent）
 * `PresetTree extends Include`（agent-presets lib/index.js:634-643），即一棵带
 * `resolve()` / `entries()` 的真 EntryTree；行 id 形如
 * `include:agent-presets:mcp-filesystem`，行的 `disabled` 与 inventory 的
 * `enabled === false` 一一对应（实测 10/10 一致），故 rc.8 时代的
 * `entry.update({ disabled })` 语义**原样复活**。
 *
 * ⚠️ 模块身份（本文件成立的前提）：`mounted` 是 dsh-agent-presets 的**模块私有**
 * WeakMap，`livePresetMounts()` 只有当本插件的 `@deepseek-ai/dsh-agent-presets`
 * 与宿主组合解析到**同一份实例**时才看得到挂载。实测：宿主侧走 `NODE_PATH` 的
 * `node_modules/.pnpm/node_modules` 影子树 → 0.1.5-rc.2
 * (`...@deepseek-ai+dsh-agent-pres_fc9bf98ae5865ea9f109f84a7d78519a`)；面板从
 * 自身 node_modules 向上走解析到同一份（探针 presets.url 实证）。
 * **若升级 DSH 后 `presetMounts()` 恒返回 []，第一嫌疑就是这份实例错位**——
 * 由 `/debug` 的 `standingDiag` 直接可见，不要靠猜。
 *
 * 边界：本模块只做「定位 + 句柄交付」，不改任何状态；写操作只发生在调用方
 * （routes 的 entry.update / mcpcall 的 ensureEnabled）。
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Entry } from '@deepseek-ai/cordis-plugin-loader'
import * as agentPresets from '@deepseek-ai/dsh-agent-presets'
import { isMcpEntry, serverNameOf } from './mcp-entry'

/** standing 组合的挂载描述（只取本插件用到的字段）。 */
export interface StandingMount {
  presetId?: string
  tree?: StandingTree
}

/** standing 组合的 EntryTree（PresetTree extends Include 的公开子集）。 */
export interface StandingTree {
  entries(): Iterable<Entry>
  resolve?(id: string): Entry
}

/**
 * dsh-agent-presets 的读取面。全部可选：宿主版本落后（< 0.1.5-rc.2）时这些函数
 * 不存在，面板整体降级为 0.5.6 行为（可见性不过滤、开关只记意图），不崩。
 */
const api = agentPresets as unknown as {
  livePresetMounts?: (within?: unknown) => StandingMount[]
  standingMountFor?: (agentCtx: Context) => StandingMount | undefined
}

/** 诊断快照（/debug standingDiag 用；不参与任何逻辑判断）。 */
let diag: {
  apiAvailable: boolean
  apiError: string | null
  mountsSeen: number
  lastPresetIds: string[]
  lastRowCount: number
} = { apiAvailable: false, apiError: null, mountsSeen: 0, lastPresetIds: [], lastRowCount: 0 }

/**
 * 全进程所有 preset 的 standing 挂载（**无 agent 参数**，装配同步路径也可用）。
 * 过滤掉没有 tree / tree 无 entries() 的项（防御畸形挂载）。
 */
export function presetMounts(): StandingMount[] {
  if (typeof api.livePresetMounts !== 'function') {
    diag = { ...diag, apiAvailable: false, apiError: 'livePresetMounts not exported by host dsh-agent-presets' }
    return []
  }
  try {
    const raw = api.livePresetMounts()
    const out: StandingMount[] = []
    for (const m of Array.isArray(raw) ? raw : []) {
      const tree = m?.tree
      if (!tree || typeof tree.entries !== 'function') continue
      out.push(m)
    }
    diag = { ...diag, apiAvailable: true, apiError: null, mountsSeen: out.length, lastPresetIds: out.map((m) => String(m.presetId ?? '')) }
    return out
  } catch (error) {
    diag = { ...diag, apiAvailable: true, apiError: error instanceof Error ? error.message : String(error) }
    return []
  }
}

/**
 * 在 standing 树里按 serverName 找 MCP 行。先遍历 `livePresetMounts()`；
 * 无挂载且给了 agentCtx 时再用 `standingMountFor(agentCtx)` 兜一次
 * （带 agent 的调用方更精确，但不依赖它——RC.4 会话无挂载时为 undefined）。
 * 命中规则与 loader 侧一致（isMcpEntry + serverNameOf），两条路径同语义。
 */
export function findStandingEntryByServer(serverName: string, agentCtx?: Context): Entry | undefined {
  const mounts = presetMounts()
  if (mounts.length === 0 && agentCtx !== undefined && typeof api.standingMountFor === 'function') {
    try {
      const mount = api.standingMountFor(agentCtx)
      if (mount?.tree && typeof mount.tree.entries === 'function') mounts.push(mount)
    } catch {
      /* agentCtx 未挂 preset（如子代理会话）→ 忽略 */
    }
  }
  for (const mount of mounts) {
    for (const entry of safeEntries(mount.tree)) {
      if (!isMcpEntry(entry)) continue
      if (serverNameOf(entry) === serverName) return entry
    }
  }
  return undefined
}

/** 在 standing 树里按长 entryId 找行（toggleMcp 直传 entryId 时用）。 */
export function findStandingEntryById(entryId: string): Entry | undefined {
  for (const mount of presetMounts()) {
    for (const entry of safeEntries(mount.tree)) {
      if (String(entry.id) === entryId) return entry
    }
  }
  return undefined
}

/** 全部 standing MCP 行（可见性层用：需同时覆盖 open 与 closed 两种行）。 */
export function standingMcpEntries(): Entry[] {
  const out: Entry[] = []
  for (const mount of presetMounts()) {
    for (const entry of safeEntries(mount.tree)) {
      if (!isMcpEntry(entry)) continue
      out.push(entry)
    }
  }
  diag = { ...diag, lastRowCount: out.length }
  return out
}

/** 一行 MCP 的安装态摘要（mcp_search 的「已安装能力表」用）。 */
export interface InstalledMcpRow {
  serverName: string
  entryId: string
  /** 用户在面板的开关：true = 开着（模型可见、运行中） */
  open: boolean
  /** 该行有实例句柄（standing 树里可 resolve） */
  hasEntry: boolean
}

/**
 * 全部**已安装**的 MCP server（含用户关闭的），供 mcp_search 列能力表。
 *
 * 与 `standingMcpEntries()` 的差别：这里只要"配置里存在这一行"就算已安装，
 * 不要求它有运行实例 —— 这正是 rc.8 语义里「关着的 server 仍应可被检索到」的落点
 * （0.5.7 之前关掉的行既不在 loader 也不在 catalog，模型完全看不到它存在）。
 */
export function installedMcpRows(): InstalledMcpRow[] {
  const out: InstalledMcpRow[] = []
  for (const entry of standingMcpEntries()) {
    out.push({
      serverName: serverNameOf(entry),
      entryId: String(entry.id),
      open: entry.disabled !== true,
      hasEntry: true,
    })
  }
  out.sort((a, b) => a.serverName.localeCompare(b.serverName))
  return out
}

/** entries() 迭代器防御：挂载途中树可能重建，抛错时按空树处理并记诊断。 */
function safeEntries(tree: StandingTree | undefined): Entry[] {  if (!tree) return []
  try {
    const it = tree.entries()
    return Array.isArray(it) ? it : [...it]
  } catch (error) {
    diag = { ...diag, apiError: error instanceof Error ? error.message : String(error) }
    return []
  }
}

/** /debug 诊断读数（只读快照，外部改不到内部状态）。 */
export function standingDiag(): typeof diag {
  return { ...diag }
}
