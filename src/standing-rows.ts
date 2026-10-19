/**
 * preset 行句柄来源（0.5.7；0.1.7 契约改造 2026-09-24）—— 模型侧可见性 / 面板开关 /
 * mcp_call 唤醒的公共咽喉。
 *
 * 背景与断点（2026-09-13 实测取证，详见 README 变更日志 v0.6.0 的
 * 「preset 行句柄 + 临时拉起闭环 + 已安装能力表」一节）：
 * dsh 0.1.2-rc.1 起 preset 行挂在 standing 组合，**不在 `ctx.loader.entries()`
 * 也不在 `ctx.loader.resolve()` 可达域**（resolve 恒抛 "cannot resolve entry"）。
 * 0.5.5/0.5.6 因此把所有 preset 行逻辑降级成「快照读取 + 意图排队」：
 * `listPresetMcpRows` 走 `agentPresets.compositionInventory()` 与预设文本，
 * 只读得到 `enabled`/`fiberState` 快照，**拿不到 Entry 句柄**。后果是三处通路
 * 同时断裂（同一根因）：
 *   1. `buildVisibility` 遍历 `ctx.loader.entries()` → 表为空 → filter.ts 的
 *      `?? true` 兜底放行 → **可见性层整体空转，MCP 工具全部照原样进上下文**；
 *   2. `toggleMcp` 的 `entry.update({disabled})` 无句柄 → 只写 state.json.desired
 *      意图 → `applyPendingMcp` 仍 resolve 失败 → **面板开关永不生效**；
 *   3. `mcp_call` 的 `resolveEntry` miss → 走 `presetRow.disabled` 分支直接 throw
 *      「当前已停用…请先在面板打开」 → **关着的 MCP 叫不醒**（无法临时拉起）。
 *
 * 解法：0.1.5-rc.2 起公开了 standing 组合的 EntryTree 读取口；
 * 0.1.7 由 `@deepseek-ai/dsh-agent-preset-registry` 提供**同一对**函数
 * （该包 src/index.ts 的 re-export，实现在 mount.ts）：
 *   `standingMountFor(agentCtx) -> { presetId, fiber, tree: EntryTree, key }`
 *   `livePresetMounts(within?)   -> PresetMount[]`（模块级注册表，无需 agent）
 * `PresetTree extends EntryTree`（registry mount.ts），即一棵带
 * `resolve()` / `entries()` 的真 EntryTree。
 *
 * ⚠️ 0.1.7 行 id 形态变了：standing 树里 `entry.id` 是**绝对** id
 * （`<owner entry id>:<rowId>`），而 `agentPresets.compositionInventory()` 给的是
 * **相对** id（registry 的 mountedCompositionRows 会剥掉 owner 前缀）。
 * 两者不再相等，故本模块的按 id 查找**两种形态都接受**（见 findStandingEntryById）。
 *
 * ⚠️ 模块身份（挂载来源，0.2.1-rc.2 起**改为实例级**）：
 * 0.2.0-rc.2 及更早：`mounts` 是 registry 包的**模块私有** Set，
 * `livePresetMounts()` 只有当本插件的该包与宿主组合解析到**同一份实例**时才看得到挂载。
 * 0.2.1-rc.2 起：模块级导出 livePresetMounts/standingMountFor 被移除，挂载改挂在
 * registry **实例**的 `generations` Map 上；插件入口经 `bindAgentPresetRegistry`
 * 注入 `ctx.get('agentPresets')` 实例，本模块从 `generations` 读取（见 presetMounts）。
 * **若升级 DSH 后 `presetMounts()` 恒返回 []，第一嫌疑就是实例未注入或错位**——
 * 由 `/debug` 的 `standingDiag`（apiVia / apiError 字段）直接可见，不要靠猜。
 *
 * 边界：本模块只做「定位 + 句柄交付」，不改任何状态；写操作只发生在调用方
 * （routes 的 entry.update / mcpcall 的 ensureEnabled）。
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Entry } from '@deepseek-ai/cordis-plugin-loader'
import * as agentPresets from '@deepseek-ai/dsh-agent-preset-registry'
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
 * `@deepseek-ai/dsh-agent-preset-registry` 的读取面。全部可选：
 * - 0.2.0-rc.2 及更早宿主：模块级导出 livePresetMounts/standingMountFor；
 * - 0.2.1-rc.2 起：模块级导出被移除，走下方 registryInstance（实例级）。
 * 两条路都不可用时面板降级为 0.5.6 行为（可见性不过滤、开关只记意图），不崩。
 */
const api = agentPresets as unknown as {
  livePresetMounts?: (within?: unknown) => StandingMount[]
  standingMountFor?: (agentCtx: Context) => StandingMount | undefined
}

/** 0.2.1-rc.2 registry 实例读取面（TS private 字段按运行时实态 cast）。 */
interface RegistryGeneration {
  mount?: { presetId?: string; tree?: StandingTree; fiber?: unknown }
  retired?: boolean
}
interface RegistryInstance {
  generations?: Map<unknown, RegistryGeneration>
  generationFor?: (ctx: unknown) => RegistryGeneration | undefined
}
let registryInstance: RegistryInstance | undefined
/** 由插件入口（index.ts apply）注入宿主 registry 实例；0.2.0- 老宿主可不调。 */
export function bindAgentPresetRegistry(instance: unknown): void {
  registryInstance = instance !== null && typeof instance === 'object' ? (instance as RegistryInstance) : undefined
}

/** 诊断快照（/debug standingDiag 用；不参与任何逻辑判断）。 */
let diag: {
  apiAvailable: boolean
  apiError: string | null
  /** 本次 presetMounts 实际走通的读取路径。 */
  apiVia: 'registryGenerations' | 'livePresetMounts' | 'none'
  mountsSeen: number
  lastPresetIds: string[]
  lastRowCount: number
} = { apiAvailable: false, apiError: null, apiVia: 'none', mountsSeen: 0, lastPresetIds: [], lastRowCount: 0 }

/**
 * 全进程所有 preset 的 standing 挂载（**无 agent 参数**，装配同步路径也可用）。
 * 三段式：0.2.1-rc.2 实例级 generations → 0.2.0- 模块级 livePresetMounts → 降级 []。
 * 过滤掉没有 tree / tree 无 entries() 的项（防御畸形挂载）。
 */
export function presetMounts(): StandingMount[] {
  // 路径 1（0.2.1-rc.2）：实例级 registry.generations（运行时普通 Map）。
  if (registryInstance?.generations instanceof Map) {
    try {
      const out: StandingMount[] = []
      for (const gen of registryInstance.generations.values()) {
        const tree = gen?.mount?.tree
        if (!tree || typeof tree.entries !== 'function') continue
        out.push({ presetId: gen?.mount?.presetId, tree })
      }
      // 空 = 宿主确实无挂载：直接返回，不要落到路径 2 混淆 apiVia 判定
      //（livePresetMounts 在 0.2.1 宿主本就不存在，空回退只会拖慢）。
      diag = { ...diag, apiAvailable: true, apiError: null, apiVia: 'registryGenerations', mountsSeen: out.length, lastPresetIds: out.map((m) => String(m.presetId ?? '')) }
      return out
    } catch (error) {
      diag = { ...diag, apiAvailable: true, apiError: error instanceof Error ? error.message : String(error) }
      // 枚举失败落回路径 2 再试一次（旧导出若在仍是可用来源）。
    }
  }
  // 路径 2（0.2.0-rc.2 及更早）：模块级 livePresetMounts。
  if (typeof api.livePresetMounts === 'function') {
    try {
      const raw = api.livePresetMounts()
      const out: StandingMount[] = []
      for (const m of Array.isArray(raw) ? raw : []) {
        const tree = m?.tree
        if (!tree || typeof tree.entries !== 'function') continue
        out.push(m)
      }
      diag = { ...diag, apiAvailable: true, apiError: null, apiVia: 'livePresetMounts', mountsSeen: out.length, lastPresetIds: out.map((m) => String(m.presetId ?? '')) }
      return out
    } catch (error) {
      diag = { ...diag, apiAvailable: true, apiError: error instanceof Error ? error.message : String(error) }
      return []
    }
  }
  // 路径 3：两条路都不可用 → 降级（可见性不过滤、开关只记意图），绝不 throw。
  diag = { ...diag, apiAvailable: false, apiVia: 'none', apiError: 'no registry access: agentPresets service not bound and livePresetMounts not exported', mountsSeen: 0, lastPresetIds: [] }
  return []
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
  if (mounts.length === 0 && agentCtx !== undefined && registryInstance && typeof registryInstance.generationFor === 'function') {
    try {
      const gen = registryInstance.generationFor(agentCtx)
      const tree = gen?.mount?.tree
      if (tree && typeof tree.entries === 'function') mounts.push({ presetId: gen?.mount?.presetId, tree })
    } catch { /* 未 join preset 的 agentCtx → 忽略 */ }
  }
  for (const mount of mounts) {
    for (const entry of safeEntries(mount.tree)) {
      if (!isMcpEntry(entry)) continue
      if (serverNameOf(entry) === serverName) return entry
    }
  }
  return undefined
}

/**
 * 在 standing 树里按行 id 找行（toggleMcp 直传 entryId 时用）。
 *
 * 0.1.7 两种 id 形态都接受：`entry.id` 是绝对 id（`<owner entry id>:<rowId>`），
 * 而 `compositionInventory()` / 面板 / state.json 给的是**相对** id（如
 * `mcp-filesystem`，见 registry mountedCompositionRows 剥前缀处）。形态变更后
 * 句柄不再失联，也兼容 state.json 里的历史长 id。
 */
export function findStandingEntryById(entryId: string): Entry | undefined {
  if (entryId.length === 0) return undefined
  for (const mount of presetMounts()) {
    for (const entry of safeEntries(mount.tree)) {
      if (String(entry.id) === entryId || String(entry.options.id) === entryId) return entry
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
