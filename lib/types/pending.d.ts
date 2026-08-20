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
import type { Context } from '@deepseek-ai/cordis';
import type { McpCallController } from './mcpcall';
/** 单个待生效项（key = entryId）。 */
export interface PendingMcpEntry {
    entryId: string;
    file: string | null;
    rowId: string;
    disabled: boolean;
}
/** 待生效队列（进程内存态；重启后由 state.json.desired + syncPresetFiles 承接）。 */
export declare const pendingMcp: Map<string, PendingMcpEntry>;
export interface PendingDeps {
    ctx: Context;
    controller?: McpCallController;
}
/**
 * 应用整条待生效队列：对每项 entry.update(desired)；用户启用方向 markUserEnabled
 * （清 AI 标记 → 转为「用户打开」语义，回收器不再回收）。成功即从队列清除；
 * 失败保留（下个边界重试）。返回实际应用数。调用方负责收尾 single invalidateMcp。
 */
export declare function applyPendingMcp(deps: PendingDeps): Promise<number>;
/** 当前待生效项数量（面板/诊断用）。 */
export declare function pendingMcpCount(): number;
