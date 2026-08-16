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
}

export type StateFile = {
  mcp?: Record<string, Record<string, McpRowState>>
  /** AI 自动启用标记（mcp_call 保活启用）：entryId → 上次启用时间。 */
  ai?: Record<string, { at: number }>
  /** 面板可写的插件配置（autoManage 开关等），优先于 cordis config。 */
  config?: { autoManage?: boolean }
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
