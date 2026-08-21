/**
 * 延迟生效（P1 会话边界）：MCP 启停意图的待生效队列。
 *
 * next-session 模式下 toggle 不立即 entry.update（避免中途改 tools 前缀 → 缓存 miss），
 * 只写 state.json.desired 并进入本模块的 pendingMcp 内存队列；在边界统一应用：
 * - 实时：新会话 `agent/session-start`（首次请求前）调用 applyPendingMcp
 * - 兜底：DSH 重启后由 syncPresetFiles() 从 state.json 物化到预设组合（既有路径）
 * - 强制：面板「立即应用待生效变更」端点同样调用 applyPendingMcp
 *
 * immediate 模式不经过本队列（toggleMcp 直接 entry.update）。
 */
import { readFile } from 'node:fs/promises'
import type { Context } from '@deepseek-ai/cordis'
import type { Entry } from '@deepseek-ai/cordis-plugin-loader'
import { isMcpEntry, serverNameOf } from './mcp-entry'
import type { McpCallController } from './mcpcall'
import { rowDisabledState } from './preset'
import { readState, writeState, type StateFile } from './state'
import { messageOf } from './util'

/** 单个待生效项（key = entryId）。 */
export interface PendingMcpEntry {
  entryId: string
  file: string | null
  rowId: string
  disabled: boolean
}

/** 待生效队列（进程内存态；重启后由 state.json.desired + syncPresetFiles 承接）。 */
export const pendingMcp = new Map<string, PendingMcpEntry>()

export interface PendingDeps {
  ctx: Context
  controller?: McpCallController
}

/**
 * 应用整条待生效队列：对每项 entry.update(desired)；用户启用方向 markUserEnabled
 * （清 AI 标记 → 转为「用户打开」语义，回收器不再回收）。成功即从队列清除；
 * 失败保留（下个边界重试）。返回实际应用数。调用方负责收尾 single invalidateMcp。
 */
export async function applyPendingMcp(deps: PendingDeps): Promise<number> {
  const { ctx } = deps
  let applied = 0
  // ① 内存队列（本进程内 next-session 记下的意图）
  for (const [entryId, pending] of [...pendingMcp.entries()]) {
    try {
      // loader.resolve 需要完整嵌套 id；行不存在/非 MCP 行时视为已失效，直接清队列
      const entry = ctx.loader.resolve(entryId) as Entry
      if (!isMcpEntry(entry)) {
        pendingMcp.delete(entryId)
        continue
      }
      await entry.update({ disabled: pending.disabled })
      if (!pending.disabled && deps.controller) {
        deps.controller.markUserEnabled(serverNameOf(entry))
      }
      pendingMcp.delete(entryId)
      applied += 1
      ctx.logger.info?.(`mcp-skill-panel: applied pending toggle ${entryId} → disabled=${pending.disabled}`)
    } catch (error) {
      ctx.logger.warn?.(`mcp-skill-panel: pending apply "${entryId}" failed: ${messageOf(error)}`)
      // 保留待办，下个边界重试
    }
  }
  // ② state.json 残留兜底：重启/热重载后内存队列为空，但 desired 与 live 仍可能不一致
  //   （syncPresetFiles 因「有 agent 在跑」跳过物化等）。把 desired 应用到 live；
  //   预设文件被外部改过（cur !== lastApplied）的行尊重现状、放弃管理并清除残留
  //   （与 syncPresetFiles 同语义，防止「Apply pending now」点击后遗留无效徽标）。
  //   运行期仍不写预设文件（事故 5.1 铁律）：重启后由 syncPresetFiles 物化闭环。
  applied += await applyStateResidue(deps, await readState().catch(() => undefined))
  return applied
}

/**
 * state.json 残留补齐（见 applyPendingMcp ②）。只改 live（entry.update），
 * 不动 preset 文件与 lastApplied（lastApplied 语义 = 文件上次状态，供物化判定）。
 */
async function applyStateResidue(deps: PendingDeps, state: StateFile | undefined): Promise<number> {
  const { ctx } = deps
  const mcp = state?.mcp
  if (!mcp || Object.keys(mcp).length === 0) return 0
  let applied = 0
  let residueCleared = false
  for (const entry of ctx.loader.entries()) {
    if (!isMcpEntry(entry)) continue
    if (pendingMcp.has(entry.id)) continue
    const tree = entry.parent?.tree as { filename?: string } | undefined
    const file = tree?.filename
    if (typeof file !== 'string' || file.length === 0) continue
    const rowState = mcp[file]?.[entry.options.id]
    if (!rowState || typeof rowState.desired !== 'boolean') continue
    if (rowState.desired === entry.disabled) continue
    let text: string
    try {
      text = await readFile(file, 'utf8')
    } catch {
      // 文件已不存在：无法判定，跳过（不动 state）
      continue
    }
    const cur = rowDisabledState(text, entry.options.id)
    if (cur !== rowState.lastApplied) {
      // 预设文件被外部/其他途径改过：尊重现状，放弃对该行的管理并清除残留
      delete mcp[file][entry.options.id]
      if (Object.keys(mcp[file]).length === 0) delete mcp[file]
      residueCleared = true
      ctx.logger.info?.(`mcp-skill-panel: state-residue ${entry.id}: preset file externally modified, dropping row`)
      continue
    }
    try {
      await entry.update({ disabled: rowState.desired })
      if (!rowState.desired && deps.controller) {
        deps.controller.markUserEnabled(serverNameOf(entry))
      }
      applied += 1
      ctx.logger.info?.(`mcp-skill-panel: applied state-residue toggle ${entry.id} → disabled=${rowState.desired}`)
    } catch (error) {
      ctx.logger.warn?.(`mcp-skill-panel: state-residue apply "${entry.id}" failed: ${messageOf(error)}`)
    }
  }
  if (residueCleared) await writeState(state ?? {}).catch(() => undefined)
  return applied
}

/** 当前待生效项数量（面板/诊断用）。 */
export function pendingMcpCount(): number {
  return pendingMcp.size
}
