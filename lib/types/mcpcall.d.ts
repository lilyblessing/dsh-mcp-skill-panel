import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { Entry } from '@deepseek-ai/cordis-plugin-loader';
import type { Catalog } from './catalog';
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
    /** 轮询 + 事件加速等待某工具注册；signal 中止 / 上下文销毁时立即终局。 */
    waitRegistered(name: string, scopeKey: object | undefined, timeoutMs: number, signal?: AbortSignal): Promise<void>;
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
