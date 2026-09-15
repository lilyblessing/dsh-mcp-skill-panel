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
    /**
     * 该 server 的**工具级启用数**：扣掉「工具级禁用」后仍会投放给模型的工具数
     * （tokensEnabled 为同口径的 token 估算）。批量禁用后这里立刻变化 —— 否则
     * 整个批量操作没有任何可见反馈。
     *
     * 口径边界（2026-09-16 移植裁量 F1，勿写成「实际进入上下文」）：谓词是
     * isToolDisabled + 会话工作区，与 system-prompt/assemble 的**工具级**过滤器同源，
     * 但它**不覆盖**另外两条隐藏路径：
     * - server 级可见性（AI 临时启用保活 / 面板自主隐藏 server）—— 这些 server 的
     *   工具仍被计入；
     * - project-mcp 的工作区过滤（非本工作区的项目行）。
     * 所以这是「工具级启用数」，不是「模型实际看到的工具数」。
     */
    toolsEnabled: number;
    /** {@link toolsEnabled} 同口径的 token 估算。 */
    tokensEnabled: number;
    status: McpStatus;
    /** 模型是否可见（autoManage 下：启用且非 AI 临时启用 → 可见；关闭模式下全部启用可见）。 */
    modelVisible: boolean;
    /**
     * 0.7.2：该行当前是「AI 经 mcp_call 临时启用」保活中的（autoManage 下为 true）。
     *
     * 为什么需要这个字段：卡片此前只有 `modelVisible`——用户手动启用的行同样 `modelVisible=true`，
     * 于是「用户打开」与「AI 临时打开」在外观上**分不清**。2026-09-14 实测事故里，模型误用面板
     * API 把 obsidian 行打开后，卡片与用户自己打开的行长得一模一样，没人能一眼看出这是 AI 干的。
     * AI 临时启用会写 state.json 的 ai 段（被回收器清除后才消失），故本字段也是审计痕迹。
     */
    aiOwned?: boolean;
    /** 宿主侧期望状态（next-session 模式下可能与 disabled 不同）。 */
    desired?: boolean;
    /** true = 已记录意图但尚未在运行时生效（待下次会话/重启）。 */
    pending?: boolean;
    /**
     * 0.7.1 诚实上报：行**启用且在跑**，但 live 注册的工具数为 0
     * （子进程起不来/空转：如 codegraph 缺 `.codegraph` 索引、端点不可达）。
     *
     * 此前这种行会回落显示 catalog 目录快照的工具数，于是"零注册"被渲染成
     * "4 个工具在跑"（假绿；2026-09-13 实测 codegraph）。带上本标记后 UI 显示
     * `failed` 且工具数为 0，目录快照退回 `toolList`（工具级禁用 UI 仍可用）。
     */
    unregistered?: boolean;
    /** 项目级 MCP 行：所属工作空间根（<workspace>/.dsh/mcps 所在目录）；缺省 = 全局行。 */
    workspace?: string;
    /**
     * 行来源（rc.1 standing 组合兜底新增）：
     * - 'live' = ctx.loader.entries() 真实行（可 toggle/entry.update）
     * - 'preset' = compositionInventory standing 快照行（rc.1 preset 行不在 loader.entries，
     *   开关走 state.json desired 意图 + 下次启动物化，面板置 pending）
     * - 'gateway' = P5 网关自托管 gw- 行（loader 常驻，entryId=gw-mcp-<server>；
     *   toggle 走 preset 意图分支，见 routes.ts toggleMcp 网关分支）
     */
    source?: 'live' | 'preset' | 'gateway';
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
    /**
     * 扣掉工具级禁用后的 MCP 工具总数 / token 估算（口径同 McpRow.toolsEnabled，
     * 见其注释：是「工具级启用数」，不是「实际进入上下文」）。
     */
    mcpToolsEnabledTotal: number;
    mcpTokensEnabledTotal: number;
    /**
     * 全部工具（含 read/edit/bash/skill 等非 MCP 工具）计数 —— 工具预算红线用。
     * 取数口径见 {@link toolsAllSource}；红线比较**只**用 toolsAllEnabled（与展示同源）。
     */
    toolsAllTotal: number;
    toolsAllEnabled: number;
    /**
     * 上面两个数的口径来源（2026-09-16 移植裁量 F2）：
     * - 'request' = 会话里**上一次已落盘请求**的装配后工具表（`requestHeader().tools`），
     *   已经是所有装配过滤器跑完的真值；有一轮延迟，且此口径下 total 与 enabled 同值；
     * - 'registry' = 回退到工具**注册表**视图（`ctx.tools.schemas()` 全量）：
     *   total 是注册表数、enabled 是注册表数减去被工具级禁用剔除的 MCP 工具数 —— 近似值。
     * UI 与 API 必须把该来源显示出来，不得把注册表口径说成请求面。
     */
    toolsAllSource: 'request' | 'registry';
    /** 工具预算（如 grok 的 350）；null = 未设置，不提示。 */
    toolBudget: number | null;
    /** AI 中间层总开关（面板开关）。 */
    autoManage: boolean;
    /** 按模型覆盖表（运行期当前值）：键为 provider 或 provider/model，值 true=启用中间层。 */
    autoManageByRoute: Record<string, boolean>;
    /**
     * 中间层是否已实际挂载（总开关关但存在 true 覆盖项时也会挂载）。
     * 与 {@link autoManageByRoute} 合看：任一模型判定 on ⇒ 本字段为 true（G2 不变量）。
     */
    autoManageMounted: boolean;
    /** 中间层生效时隐藏哪些 server：'disabled'=仅手动停用的；'all'=全部 MCP。 */
    middleLayerHides: 'disabled' | 'all';
    /**
     * 当前会话（或缺省 agent）实际生效的判定与依据 —— 面板顶部徽标用它显示
     * 「本会话：开启 · grok/grok-4.6（provider 项）」这类信息。
     * source='no-route' = 本次解析不出模型（诊断装配/服务缺失），已保守回退总开关。
     */
    autoManageActive: {
        on: boolean;
        source: 'model' | 'provider' | 'master' | 'no-route';
        provider: string | null;
        model: string | null;
    };
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
