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
