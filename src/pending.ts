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
import type { Context } from '@deepseek-ai/cordis'
import type { Entry } from '@deepseek-ai/cordis-plugin-loader'
import { isMcpEntry, serverNameOf } from './mcp-entry'
import type { McpCallController } from './mcpcall'
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
  if (pendingMcp.size === 0) return 0
  let applied = 0
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
  return applied
}

/** 当前待生效项数量（面板/诊断用）。 */
export function pendingMcpCount(): number {
  return pendingMcp.size
}
