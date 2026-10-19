/**
 * 延迟生效（P1 会话边界）：MCP 启停意图的待生效队列。
 *
 * next-session 模式下 toggle 不立即 entry.update（避免中途改 tools 前缀 → 缓存 miss），
 * 只写 state.json.desired 并进入本模块的 pendingMcp 内存队列；在边界统一应用：
 * - 实时：新会话 `agent/session-start`（首次请求前）调用 applyPendingMcp
 * - 兜底：DSH 重启后由 syncPresetFiles() 从 state.json 物化到 profile patch（既有路径）
 * - 强制：面板「立即应用待生效变更」端点同样调用 applyPendingMcp
 *
 * immediate 模式不经过本队列（toggleMcp 直接 entry.update）。
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Entry } from '@deepseek-ai/cordis-plugin-loader'
import { isMcpEntry, serverNameOf } from './mcp-entry'
import type { McpCallController } from './mcpcall'
import { isPresetDeclarationRow } from './preset-mcp'
import { findStandingEntryById } from './standing-rows'
import { readState, type StateFile } from './state'
import { messageOf } from './util'

/** 单个待生效项（key = entryId）。 */
export interface PendingMcpEntry {
  entryId: string
  /** 0.1.7：目标持久化键 = 预设**声明行的 Loader 行 id**（不再是预设文件路径）；
   * 反查不到所属声明行时为 null（只记内存意图，不落盘）。 */
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
 * 解析待生效意图对应的行句柄：loader 优先，preset 行回落 standing 树（0.5.7）。
 * 两者都 miss 才视为行已失效（调用方清队列）。
 */
function resolvePendingEntry(ctx: Context, entryId: string): Entry | undefined {
  try {
    const entry = ctx.loader.resolve(entryId) as Entry | undefined
    if (entry) return entry
  } catch {
    /* preset 行必然抛 "cannot resolve entry" → 走 standing 兜底 */
  }
  return findStandingEntryById(entryId)
}

/**
 * 应用整条待生效队列：对每项 entry.update(desired)；用户启用方向 markUserEnabled
 * （清 AI 标记 → 转为「用户打开」语义，回收器不再回收）。成功即从队列清除；
 * 失败保留（下个边界重试）。返回实际应用数。调用方负责收尾 single invalidateMcp。
 */
export async function applyPendingMcp(deps: PendingDeps): Promise<number> {
  const { ctx } = deps
  let applied = 0
  // 本次边界开始时的队列键快照：① 段应用成功后即从 pendingMcp 删除，
  // 故 ② 段不能再拿「当前队列」判重（会恒为 false → 残留分支把同一行回滚一次）。
  const queuedIds = new Set(pendingMcp.keys())
  // ① 内存队列（本进程内 next-session 记下的意图）
  for (const [entryId, pending] of [...pendingMcp.entries()]) {
    try {
      // loader.resolve 需要完整嵌套 id；行不存在/非 MCP 行时视为已失效，直接清队列。
      // 0.5.7：preset 行不在 loader 可达域，回落 standing 树句柄（否则意图永远应用不了）。
      const entry = resolvePendingEntry(ctx, entryId)
      if (!entry || !isMcpEntry(entry)) {
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
  //   （syncPresetFiles 的物化未覆盖该行等）。把 desired 应用到 live。
  //   0.1.7：不再有「预设文件被外部改过」这一分支 —— 预设没有独立文件，live 行即唯一
  //   事实源（desired === live 即视为无残留）。运行期仍不直接写 profile patch
  //   （持久化一律走 syncPresetFiles → configEditor，带文件锁 + reconcile）。
  applied += await applyStateResidue(deps, await readState().catch(() => undefined), queuedIds)
  return applied
}

/**
 * state.json 残留补齐（见 applyPendingMcp ②）。只改 live（entry.update），
 * 不动 state.json 与 lastApplied（lastApplied 语义 = 上次物化后的启停值，供物化判定）。
 * `queuedIds` = 本次边界开始时的内存队列键快照（① 段已消费并删除，故不能改用
 * pendingMcp 现值判重），命中即跳过，避免同一行被「应用 + 回滚」两次。
 */
async function applyStateResidue(
  deps: PendingDeps,
  state: StateFile | undefined,
  queuedIds: ReadonlySet<string>,
): Promise<number> {
  const { ctx } = deps
  const mcp = state?.mcp
  if (!mcp || Object.keys(mcp).length === 0) return 0
  let applied = 0
  // 0.1.7 键语义：state.mcp 第一级 = **预设声明行的 Loader 行 id**，第二级 = 行 id。
  // 旧版第一级是预设组合文件绝对路径 —— 那些键在本版找不到声明行，一律按死键忽略
  //（不猜、不迁移，见 README 变更日志 v0.7.0 的键语义说明）。
  // 旧实现按「文件」分组并在应用前比对文件现值；0.1.7 没有可读的预设文件，故不再有
  // 「外部改文件」判定 —— live 行即唯一事实源（desired 与 live 一致即无残留）。
  for (const [presetRowId, rows] of Object.entries(mcp)) {
    if (!isPresetDeclarationRow(ctx, presetRowId)) continue
    for (const [rowId, rowState] of Object.entries(rows ?? {})) {
      if (!rowState || typeof rowState.desired !== 'boolean') continue
      const entry = resolveRowEntry(ctx, rowId)
      if (!entry || !isMcpEntry(entry)) continue
      // 内存队列（本进程刚记的意图）优先，避免同一次边界里被残留分支重复处理。
      // 用边界开始时的快照判定（① 段已把队列项删掉，用现值会漏判 → 先应用后回滚）。
      const liveId = String(entry.id)
      const liveRowId = String(entry.options.id ?? '')
      if (queuedIds.has(liveId) || (liveRowId.length > 0 && queuedIds.has(liveRowId))) continue
      if (rowState.desired === entry.disabled) continue
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
  }
  return applied
}

/**
 * 行 id → live 行句柄：loader 优先，preset 行回落 standing 树（0.5.7 起 preset 行不在
 * loader 可达域）。0.1.7 的 standing 行 id 是绝对的，故 findStandingEntryById 两种形态都收。
 */
function resolveRowEntry(ctx: Context, rowId: string): Entry | undefined {
  try {
    const entry = ctx.loader.resolve(rowId) as Entry | undefined
    if (entry) return entry
  } catch {
    /* preset 行必然抛 "cannot resolve entry" → 走 standing 兜底 */
  }
  return findStandingEntryById(rowId)
}

/** 当前待生效项数量（面板/诊断用）。 */
export function pendingMcpCount(): number {
  return pendingMcp.size
}
