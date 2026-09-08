import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { Entry } from '@deepseek-ai/cordis-plugin-loader';
import type { Catalog } from './catalog';
import type { PresetMcpRow } from './preset-mcp';
/**
 * 归一化 mcp_call 的 tool 参数（2026-08-22 修补）：模型可能把 mcp_search 返回的
 * 注册全名（mcp__<server>__<tool>）直接填入 tool，无条件拼接会生成双重前缀。
 * 规则：以 mcp__ 开头视为注册全名形态 → 循环剥离本 server 前缀（兼容嵌套重复）；
 * 剥完仍以 mcp__ 开头 → 传的是其他 server 的注册全名或格式异常 → 快速失败
 * （避免在 waitRegistered 白等满 toolCallTimeoutMs，默认 60s、mimo-image 300s）。
 * 注：远端工具裸名恰好以 mcp__ 开头属生态外的病态命名，会被误判，可接受。
 */
export declare function normalizeToolName(serverName: string, toolName: string): string;
/**
 * 归一化 mcp_call 的 arguments 参数（2026-08-24 修补）：type:'json' 参数的编译产物
 * 不带 type 标注，模型直连 Tool call 时倾向把参数字典填成 JSON 字符串（实测 flash 与
 * mimo 两系均会出现）。这里循环安全解析为对象后再透传：
 * - 值以 { / [ 开头 → 直接按容器 JSON 解析；
 * - 值以 " 开头（引号包裹层）→ 解包后若内层仍是容器形态才继续剥，防止误改合法标量入参；
 * - 解析失败或非字典形态 → 保留原值交由远端给出可读错误。
 */
export declare function normalizeArguments(raw: unknown): unknown;
/** 预设行直通用最小信息（= preset-mcp.ts PresetMcpRow，type-only import 零运行时依赖）。 */
export type PresetMcpRowInfo = PresetMcpRow;
/**
 * 控制层依赖：由 src/index.ts 在 apply 里构建并注入。这些 helper 封闭了
 * 插件对 catalog 内存态、catalog.json 持久化、loader entry 反查、state.json
 * AI-owner 标记的读写 —— 这样控制层不反向依赖 index.ts（避免循环依赖）。
 */
export interface McpControlCtx {
    /** 空闲回收窗口（ms）。 */
    keepAliveMs: number;
    /** mcp_search 缺省 top-K。 */
    searchLimitDefault: number;
    /** mcp_search top-K 上限。 */
    searchLimitMax: number;
    /** 能力摘要表（Config.serverSummary）。 */
    serverSummary: Record<string, string>;
    /** 当前内存 catalog。 */
    getCatalog(): Catalog;
    /** 替换内存 catalog（快照 / 增量后）。 */
    setCatalog(catalog: Catalog): void;
    /** 把内存 catalog 持久化到 catalog.json。 */
    persistCatalog(): Promise<void>;
    /** 按 serverName 反查 loader entry；无则 undefined。 */
    resolveEntry(serverName: string): Entry | undefined;
    /** server 自己的注册/调用超时（读 entry config 的 toolCallTimeoutMs，缺省回退）。 */
    serverTimeoutMs(serverName: string): number;
    /**
     * rc.1 standing 组合预设行定位（0.5.6 直通调用）：按 serverName 找当前会话
     * preset 的 standing 行（compositionInventory+resolve+read，经 60s 缓存）。
     * 返回 undefined = preset 也无该 server，调用方回退「不在 loader 中」。
     * 调用方收到行后须自行判定 disabled/running（快照布尔，非 Entry 句柄，
     * 无 entry.update 通道；禁用的预设行拒绝调用并提示走面板）。
     * 与 presetTimeoutMs 共用同一行来源，见 index.ts 闭包。
     */
    resolvePresetRow?(serverName: string, agent: Agent | undefined): Promise<PresetMcpRowInfo | undefined>;
    /**
     * rc.1 standing 组合兜底超时：loader 行缺 toolCallTimeoutMs 时从 preset 快照
     * 补读（与 resolvePresetRow 共行来源）。注意（WARN-3）：本函数无 agent 参数，
     * 恒用 roots[0]/list[0] 的 preset；多会话挂不同 preset 且同名 server 超时不
     * 同时会取错——只影响等待时长。直通分支的超时由调用方经 presetRow 直取，
     * 不走本函数，故不受影响。
     */
    presetTimeoutMs?(serverName: string): Promise<number | undefined>;
    /** AI-owner 标记：上次自动开启该 entry 的时间戳。 */
    setAiOwner(entryId: string, at: number): Promise<void>;
    clearAiOwner(entryId: string): Promise<void>;
    /** 对所有当前 enabled 的 server 重新快照（tools/change / 启动）。 */
    snapshotEnabled(): Promise<void>;
}
export interface McpCallController {
    /** 保活启用：disabled 时开启并记录 AI owner。返回本次是否由 AI 开启。 */
    ensureEnabled(serverName: string): Promise<boolean>;
    /** 该 server 当前是否由 AI 临时启用（mcp_call 保活中）——装配过滤据此保持其不可见。 */
    isAiEnabled(serverName: string): boolean;
    /**
     * 用户手动打开该 server：清除 AI 临时启用标记（aiEnabled/引用计数/lastUsed +
     * state.json 的 ai owner），使其转为「用户打开」语义 —— 模型立即可见、回收器不再回收。
     */
    markUserEnabled(serverName: string): void;
    /** 完整调用流程，返回给模型的文本结果（不会 throw，错误也转文本）。 */
    call(serverName: string, toolName: string, args: unknown, agent: Agent | undefined, signal: AbortSignal, explicitTimeoutMs?: number): Promise<string>;
    /** 启动空闲回收器；返回 disposer。 */
    startIdleReaper(): () => void;
    /** 诊断视图：AI 启用的 server 及其引用计数。 */
    status(): Array<{
        server: string;
        refCount: number;
        lastUsed: number;
    }>;
}
export declare function msgOf(error: unknown): string;
/**
 * 创建控制层控制器。`caches` 即控制层依赖（McpControlCtx），由 index.ts
 * 在 apply 里构建并封闭所有 IO。
 */
export declare function createMcpCallController(ctx: Context, caches: McpControlCtx): McpCallController;
/**
 * 注册 mcp_search + mcp_call 两个模型工具。`controller` 必须是调用方持有的唯一
 * 控制层实例（与空闲回收器共享同一引用计数/owner 状态），否则回收与调用不同步。
 * 返回合并 disposer。
 */
export declare function installMcpControlTools(ctx: Context, control: McpControlCtx, controller: McpCallController): () => void;
