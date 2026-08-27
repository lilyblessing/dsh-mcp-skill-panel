/** 每个预设文件（key=文件绝对路径）→ 每个 mcp 行 → 意图与上次物化状态。 */
export interface McpRowState {
    /** toggle 时用户意图：是否停用 */
    desired: boolean;
    /** toggle 时该行在文件中的实际状态（true/false/null=无 disabled 键） */
    lastApplied: boolean | null;
}
export type StateFile = {
    mcp?: Record<string, Record<string, McpRowState>>;
    /** 项目级 MCP 启停意图（工作空间 → serverName → 是否停用）；重启后由 syncRows 应用。 */
    projectMcp?: Record<string, Record<string, boolean>>;
    /** 全局 MCP 工具级禁用（serverName → 禁用的工具全名 mcp__<server>__<tool>）；跨工作区生效。 */
    toolDisabled?: Record<string, string[]>;
    /** 项目级 MCP 工具禁用（工作空间 → serverName → 禁用工具全名）；仅该工作区生效。 */
    projectToolDisabled?: Record<string, Record<string, string[]>>;
    /** AI 自动启用标记（mcp_call 保活启用）：entryId → 上次启用时间。 */
    ai?: Record<string, {
        at: number;
    }>;
    /** 面板可写的插件配置（autoManage 开关、生效时机等），优先于 cordis config。 */
    config?: {
        autoManage?: boolean;
        applyMode?: ApplyMode;
    };
};
/** 生效时机：immediate=立即（默认，下轮生效）；next-session=记意图、新会话/重启生效。 */
export type ApplyMode = 'immediate' | 'next-session';
/** 当前生效时机（缺省 immediate）。 */
export declare function stateApplyMode(state: StateFile): ApplyMode;
export declare function readState(): Promise<StateFile>;
export declare function writeState(state: StateFile): Promise<void>;
/** AI-owner 标记读写：state.json 的 ai 段（entryId → {at}）。 */
export declare function setStateAiOwner(entryId: string, at: number): Promise<void>;
export declare function clearStateAiOwner(entryId: string): Promise<void>;
