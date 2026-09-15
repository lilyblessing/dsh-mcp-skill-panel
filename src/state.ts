/**
 * state.json 持久化（~/.dsh/dsh-mcp-skill-panel/state.json）。
 *
 * 存放 MCP 行启停意图（mcp 段）、AI 临时启用标记（ai 段）与面板配置（config 段）。
 * 内存态 + 写队列合并（P1-4）：启动加载一次，高频写（mcp_call 连击的 ai 标记）
 * 串行合并落盘，避免每次读+写各一次文件 IO。
 */
import { homedir } from 'node:os'
import { join } from 'node:path'
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises'

const LEGACY_STATE_DIR = join(homedir(), '.dsh', 'dsh-runtime-inventory')
const STATE_DIR = join(homedir(), '.dsh', 'dsh-mcp-skill-panel')
const STATE_FILE = join(STATE_DIR, 'state.json')

/** 每个预设文件（key=文件绝对路径）→ 每个 mcp 行 → 意图与上次物化状态。 */
export interface McpRowState {
  /** toggle 时用户意图：是否停用 */
  desired: boolean
  /** toggle 时该行在文件中的实际状态（true/false/null=无 disabled 键） */
  lastApplied: boolean | null
  /**
   * 0.7.0：面板"更多配置"改过的挂载配置意图（键值形态，见 preset.EDITABLE_CONFIG_KEYS）。
   * 运行期只写这里（安全）；由 syncPresetFiles 在启动早期物化进预设行的 `config:` 块。
   * `appliedYaml` 记录**上次已物化**的值（YAML 文本形态），相等即无需重写 ——
   * 既幂等又能在配置变更后自动重写。
   */
  config?: Record<string, unknown>
  /** 上次物化时的 YAML 文本（`key: value` 逐行 join），用于跳过重复写入 */
  configAppliedYaml?: string
}

export type StateFile = {
  mcp?: Record<string, Record<string, McpRowState>>
  /** 项目级 MCP 启停意图（工作空间 → serverName → 是否停用）；重启后由 syncRows 应用。 */
  projectMcp?: Record<string, Record<string, boolean>>
  /** 全局 MCP 工具级禁用（serverName → 禁用的工具全名 mcp__<server>__<tool>）；跨工作区生效。 */
  toolDisabled?: Record<string, string[]>
  /** 项目级 MCP 工具禁用（工作空间 → serverName → 禁用工具全名）；仅该工作区生效。 */
  projectToolDisabled?: Record<string, Record<string, string[]>>
  /** AI 自动启用标记（mcp_call 保活启用）：entryId → 上次启用时间。 */
  ai?: Record<string, { at: number }>
  /** 面板可写的插件配置（autoManage 开关、生效时机等），优先于 cordis config。 */
  config?: {
    autoManage?: boolean
    applyMode?: ApplyMode
    /**
     * 工具预算（面板红线提示用，如 grok 的 350 上限）；缺省不提示。
     * 与其它面板可写值一样只落 state.json（**不**进 cordis Config）。
     */
    toolBudget?: number
    /**
     * AI 中间层的按模型覆盖表（P3b）。键为 `provider`（整个 provider）或
     * `provider/model`（精确到模型）；值 true=启用中间层、false=禁用。
     * 查表顺序 provider/model → provider → autoManage 总开关。
     * 空表 = 旧行为（只看总开关），所以升级零配置零行为变化。
     *
     * 挂载条件（评审 §3-I / §3-G 第 5 条）：总开关 on **或**表里存在 true 项。
     * 否则「总开关关 + grok:true」的配置永远不会挂载，覆盖项形同虚设。
     */
    autoManageByRoute?: Record<string, boolean>
    /**
     * 中间层生效时隐藏哪些 MCP server（P3b）：
     * - 'disabled'（默认，旧行为）：只隐藏用户手动停用的 server。手动启用的
     *   server 仍直接可见（memory 高灵敏召回、filesystem 直接读写的用法）。
     * - 'all'：对命中中间层的模型隐藏**全部** MCP server 的工具，一律经
     *   dsh_mcp_search / dsh_mcp_call 按需取用。server 保持挂载运行 ——
     *   这正是「grok 走中间层、claude 直连全部工具」能同时成立的原因：
     *   停用 server 会连 claude 一起看不到，而这里只改装配可见性。
     */
    middleLayerHides?: 'disabled' | 'all'
  }
}

/** 生效时机：immediate=立即（默认，下轮生效）；next-session=记意图、新会话/重启生效。 */
export type ApplyMode = 'immediate' | 'next-session'

/** 当前生效时机（缺省 immediate）。 */
export function stateApplyMode(state: StateFile): ApplyMode {
  return state.config?.applyMode === 'next-session' ? 'next-session' : 'immediate'
}

/** 工具预算（>0 的有限数才有效，否则视为未设置）。 */
export function stateToolBudget(state: StateFile): number | undefined {
  const value = state.config?.toolBudget
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined
}

/**
 * 按模型覆盖表（缺省空表 = 只看总开关）。
 * 非布尔值/空键一律丢弃：损坏的 state.json 不得把某个模型静默切到中间层。
 */
export function stateAutoManageByRoute(state: StateFile): Record<string, boolean> {
  const table = state.config?.autoManageByRoute
  if (!table || typeof table !== 'object') return {}
  const out: Record<string, boolean> = {}
  for (const [key, value] of Object.entries(table)) {
    if (typeof value === 'boolean' && key.length > 0) out[key] = value
  }
  return out
}

/**
 * 中间层隐藏范围（缺省 'disabled' = 旧行为）。
 * 只有显式 'all' 才切换：非法值不得变成 all —— 那会让所有命中中间层的模型
 * 突然失去全部 MCP 直连工具（静默的大范围行为变化）。
 */
export function stateMiddleLayerHides(state: StateFile): 'disabled' | 'all' {
  return state.config?.middleLayerHides === 'all' ? 'all' : 'disabled'
}

let stateCache: StateFile | null = null
let stateDirty = false
let stateWriteChain: Promise<void> = Promise.resolve()

export async function readState(): Promise<StateFile> {
  if (stateCache) return stateCache
  let parsed: StateFile
  try {
    parsed = JSON.parse(await readFile(STATE_FILE, 'utf8')) as StateFile
  } catch {
    // 0.2.0 改名迁移：旧状态目录（dsh-runtime-inventory）有数据则搬过来
    try {
      const legacy = join(LEGACY_STATE_DIR, 'state.json')
      const text = await readFile(legacy, 'utf8')
      await mkdir(STATE_DIR, { recursive: true })
      await rename(legacy, STATE_FILE)
      parsed = JSON.parse(text) as StateFile
    } catch {
      parsed = {}
    }
  }
  stateCache = parsed
  return parsed
}

export async function writeState(state: StateFile): Promise<void> {
  stateCache = state
  stateDirty = true
  stateWriteChain = stateWriteChain
    .catch(() => {})
    .then(async () => {
      if (!stateDirty) return
      stateDirty = false
      const current = stateCache ?? state
      await mkdir(STATE_DIR, { recursive: true })
      await writeFile(`${STATE_FILE}.tmp`, JSON.stringify(current, null, 2), 'utf8')
      await rename(`${STATE_FILE}.tmp`, STATE_FILE)
    })
  await stateWriteChain
}

/** AI-owner 标记读写：state.json 的 ai 段（entryId → {at}）。 */
export async function setStateAiOwner(entryId: string, at: number): Promise<void> {
  const state = await readState()
  state.ai ??= {}
  state.ai[entryId] = { at }
  await writeState(state)
}

export async function clearStateAiOwner(entryId: string): Promise<void> {
  const state = await readState()
  if (!state.ai || !(entryId in state.ai)) return
  delete state.ai[entryId]
  await writeState(state)
}
