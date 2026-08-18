/** 每个预设文件（key=文件绝对路径）→ 每个 mcp 行 → 意图与上次物化状态。 */
export interface McpRowState {
    /** toggle 时用户意图：是否停用 */
    desired: boolean;
    /** toggle 时该行在文件中的实际状态（true/false/null=无 disabled 键） */
    lastApplied: boolean | null;
}
export type StateFile = {
    mcp?: Record<string, Record<string, McpRowState>>;
    /** AI 自动启用标记（mcp_call 保活启用）：entryId → 上次启用时间。 */
    ai?: Record<string, {
        at: number;
    }>;
    /** 面板可写的插件配置（autoManage 开关等），优先于 cordis config。 */
    config?: {
        autoManage?: boolean;
    };
};
export declare function readState(): Promise<StateFile>;
export declare function writeState(state: StateFile): Promise<void>;
/** AI-owner 标记读写：state.json 的 ai 段（entryId → {at}）。 */
export declare function setStateAiOwner(entryId: string, at: number): Promise<void>;
export declare function clearStateAiOwner(entryId: string): Promise<void>;
