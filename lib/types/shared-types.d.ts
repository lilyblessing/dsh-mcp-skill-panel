/**
 * Host/Client 共享的类型定义（单一来源）。
 *
 * 面板视图形状（McpRow/McpView/SkillRow/SkillsView）同时被 host 的 collect.ts
 * 产出与 client 的 views.tsx 消费 —— 集中定义避免两端各自声明导致漂移
 * （v0.4.2 加 modelVisible/autoManage 时曾需要两边同步改）。
 * 纯类型文件：type-only import 不产生任何打包产物。
 */
export type McpStatus = 'active' | 'disabled' | 'idle' | 'failed';
export interface McpRow {
    entryId: string;
    rowId: string;
    serverName: string;
    transport: string | null;
    disabled: boolean;
    running: boolean;
    tools: number;
    tokens: number;
    status: McpStatus;
    /** 模型是否可见（autoManage 下：启用且非 AI 临时启用 → 可见；关闭模式下全部启用可见）。 */
    modelVisible: boolean;
    /** 宿主侧期望状态（next-session 模式下可能与 disabled 不同）。 */
    desired?: boolean;
    /** true = 已记录意图但尚未在运行时生效（待下次会话/重启）。 */
    pending?: boolean;
    /** 项目级 MCP 行：所属工作空间根（<workspace>/.dsh/mcps 所在目录）；缺省 = 全局行。 */
    workspace?: string;
    /** 该 server 的工具列表（面板工具级禁用用；null = 该 server 暂无工具目录）。 */
    toolList?: Array<{
        name: string;
        description: string;
        disabled: boolean;
    }> | null;
}
export interface McpView {
    sessionId: string | null;
    preset: string | null;
    cwd: string | null;
    /** 最近一次会话进入的工作空间（随会话切换更新；添加项目 MCP 的默认目标）。 */
    activeWorkspace: string | null;
    mcp: McpRow[];
    mcpTotal: number;
    mcpDisabled: number;
    mcpToolsTotal: number;
    mcpTokensTotal: number;
    /** AI 中间层当前是否生效（面板开关）。 */
    autoManage: boolean;
    errors: string[];
}
export interface SkillRow {
    name: string;
    description: string;
    source: string;
    modelInvocable: boolean;
    userInvocable: boolean;
}
export interface SkillsView {
    sessionId: string | null;
    preset: string | null;
    cwd: string | null;
    skills: SkillRow[];
    skillsTotal: number;
    skillsModelVisible: number;
    errors: string[];
}
