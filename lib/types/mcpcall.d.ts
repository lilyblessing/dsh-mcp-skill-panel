import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { Entry } from '@deepseek-ai/cordis-plugin-loader';
import type { Catalog } from './catalog';
import type { PresetMcpRow, PresetMcpClientConfig } from './preset-mcp';
/**
 * 中间层两个模型工具的注册名。
 *
 * 命名前缀铁律（2026-09-15，claude 400 取证）：**不得以 `mcp_` 开头**。
 * 实测 claude.ai 订阅网关把 `mcp_` 前缀的工具名当作 MCP connector 保留名，
 * 整个请求被拒为 HTTP 400 `invalid_request_error`，且错误文案被改写成
 * 「You're out of extra usage」（与配额无关，极具误导性）。
 * 证据：同一会话 16 秒内 486 工具（含本组）→400、484 工具（不含）→正常、
 * 486 →400；32 工具的最小集同样复现，与工具数量/体积无关。
 * 全部 session 统计：含本组 0/5 成功，不含本组 111/111 成功。
 */
export declare const MCP_SEARCH_TOOL = "dsh_mcp_search";
export declare const MCP_CALL_TOOL = "dsh_mcp_call";
/** 两个控制工具的名字集合（装配过滤按模型路由决定是否投放）。 */
export declare const CONTROL_TOOL_NAMES: ReadonlySet<string>;
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
 * 归一化 mcp_call 的 arguments 参数（2026-08-24 修补；2026-09-16 注释修正，审查 WARN-4）：
 * 起因是 `type:'json'` 参数的编译产物不带 type 标注，模型直连 Tool call 时倾向把参数字典
 * 填成 JSON 字符串（实测 flash 与 mimo 两系均会出现）。**该起因已消失**：参数自 2026-09-16
 * （0f4794a）起改 `type:'object' + additionalProperties`，字符串在进 execute 前即被参数校验拒绝，
 * 模型路径到不了这里 —— 本函数现在只服务**直调/内部路径**（gatewayCall 等）的兜底。
 * 这里循环安全解析为对象后再透传：
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
    /**
     * P1 直读（2026-09-09）：按 serverName 取当前会话 preset 行的全量挂载配置
     * （与 resolvePresetRow 同一行来源/同一缓存条目；无行或 transport 不可挂载
     * 时返回 undefined，调用方回退原行为）。网关挂载（P4）用它重建 client 行。
     */
    resolvePresetConfig?(serverName: string, agent: Agent | undefined): Promise<PresetMcpClientConfig | undefined>;
    /** AI-owner 标记：上次自动开启该 entry 的时间戳。 */
    setAiOwner(entryId: string, at: number): Promise<void>;
    clearAiOwner(entryId: string): Promise<void>;
    /** 对所有当前 enabled 的 server 重新快照（tools/change / 启动）。 */
    snapshotEnabled(): Promise<void>;
    /**
     * 0.6.4：主动催一次 catalog 快照（按需能力表采集在等 catalog 出现时用）。
     * 与 `snapshotEnabled` 同一实现，只是暴露给采集等待循环按需调用。
     */
    requestSnapshot?(): Promise<void>;
    /**
     * 0.6.0：按需采集某 server 的能力表（mcp_search 命中「已安装但没有快照」时用）。
     *
     * 实现由 index.ts 注入（拿得到 resolveScopeSchemas / snapshotFromSchemas /
     * persistCatalog 这套 IO），返回采集到的工具数；未采到返回 null。
     */
    collectInventory?(serverName: string): Promise<{
        tools: number;
        joined: boolean;
    } | null>;
    /**
     * 0.6.2：把**调用方已经采到**的 schema 写入 catalog（按 serverName 过滤）。
     * 与 `collectInventory` 的区别：采集口径由调用方决定（命中视图的 scope），
     * 本函数只负责过滤 + 落盘。
     */
    storeInventory?(serverName: string, schemas: ReadonlyArray<{
        name?: unknown;
        description?: unknown;
        parameters?: unknown;
    }>): Promise<{
        tools: number;
        joined: boolean;
    } | null>;
    /** 0.6.0：已安装（配置里存在该行）的 MCP server 清单，含用户关闭的。 */
    installedInventory?(): Array<{
        server: string;
        open: boolean;
    }>;
}
/** 控制层共享状态：调用链（call / gatewayCall）与空闲回收器**是同一个对象**。
 * 0.5.9 教训：`aiEnabled` 曾一度只有 `call()` 分支登记，而 `mcp_call` 实际走
 * gatewayCall → 回收器集合恒空、永不回收。两个分支现在都写这一个对象。 */
interface ControllerState {
    refCounts: Map<string, number>;
    lastUsed: Map<string, number>;
    aiEnabled: Set<string>;
}
export interface McpCallController {
    /** 保活启用：disabled 时开启并记录 AI owner。返回本次是否由 AI 开启。 */
    ensureEnabled(serverName: string): Promise<boolean>;
    /** 该 server 当前是否由 AI 临时启用（mcp_call 保活中）——装配过滤据此保持其不可见。 */
    isAiEnabled(serverName: string): boolean;
    /**
     * 0.6.0：按需把某个「已安装但没快照」的 server 拉起来采集一次能力表，然后放回关闭。
     * 让 mcp_search 对关着的 server 也能给出工具清单（rc.8 语义）。
     * `waitMs` 覆盖默认等待上限（关前补采用短上限，避免实例起不来时拖住关闭操作）。
     */
    fetchInventory(serverName: string, waitMs?: number): Promise<{
        tools: number;
        joined: boolean;
    } | null>;
    /**
     * 用户手动打开该 server：清除 AI 临时启用标记（aiEnabled/引用计数/lastUsed +
     * state.json 的 ai owner），使其转为「用户打开」语义 —— 模型立即可见、回收器不再回收。
     */
    markUserEnabled(serverName: string): void;
    /** 完整调用流程，返回给模型的文本结果（不会 throw，错误也转文本）。 */
    call(serverName: string, toolName: string, args: unknown, agent: Agent | undefined, signal: AbortSignal, explicitTimeoutMs?: number): Promise<string>;
    /**
     * 网关透传流程（P2，与 call() 同态共享引用计数）：成功返文本，失败 throw
     *（isError→Error cause 保原始 result；超时/abort 原样；禁用/停用/miss 均
     * throw）。供网关 own 层双工具复用；call() 原行为不动。
     */
    gateway(serverName: string, toolName: string, args: unknown, agent: Agent | undefined, signal: AbortSignal, explicitTimeoutMs?: number): Promise<string>;
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
/** 可执行一个注册工具的最小视图（宿主 ctx 或调用方 agent ctx 的 tools 服务）。 */
interface ToolView {
    label: string;
    tools: {
        get(name: string, scope?: object): unknown;
        execute(exec: unknown): Promise<unknown>;
    } | undefined;
    scope: object | undefined;
}
/**
 * 0.6.2：从「已确认注册了工具」的那个视图直接取 schema 快照。
 * 与 index.ts 的 `getSchemasView` 读同一份 dsh-tools 服务，只是**用命中视图自己的
 * scope**，避免换口径重读采空（0.6.1 实测的采空原因）。
 */
export declare function schemasOfView(view: ToolView | undefined): Array<{
    name?: unknown;
    description?: unknown;
    parameters?: unknown;
}>;
/**
 * 0.6.3：能力表采集的逐阶段痕迹。
 *
 * 为什么必须加：0.6.0→0.6.2 连续两次"采空"，而外部只能看到两个布尔
 * （`probed:true` / `hasSnapshot:false`），无法判断卡在"等待注册"还是"读到 0 条 schema"。
 * 这里把每阶段的原始数字留下，`/debug` 的 `inventoryTrace` 直接可读。
 */
interface InventoryTrace {
    at: number;
    requestedBy: string;
    stage: string;
    ms: number;
    entryFound: boolean | null;
    wasDisabled: boolean | null;
    wakeAdded: boolean | null;
    viewLabel: string | null;
    viewScope: string | null;
    schemaTotal: number | null;
    schemaMatched: number | null;
    stored: number | null;
    error: string | null;
}
export declare function inventoryTraceDiag(): Record<string, InventoryTrace & {
    agoMs: number;
}>;
/**
 * 网关透传调用（P2，与 call() 并存）：与 callViaPresetViews 同执行链
 * （collectToolViews+waitRegistered+execute），但错误走 throw 而非文本。
 * call() 的恒文本契约（:175-182）不动；网关/双工具走本函数。
 *
 * 三抛：
 * - isError→throw（前缀 `MCP ${server}.${bare} 调用失败`，cause 保原始
 *   result 对象：content/structuredContent/error 均在 cause 上）；
 * - 注册超时（waitRegistered 原文 `tool "…" 未在 Xms 内注册`）与执行失败
 *   均原样 throw（message 沿用原文便 grep；调用方按 message 区分 code）；
 * - signal.aborted→AbortError 原样透传（waitRegistered onAbort / execute
 *   signal 同源，不包装）。
 * 前置 normalizeToolName 捕获（跨 server 全名 throw 原样透传，不进 try）。
 * WARN-2 下沉（2026-09-09）：arguments 归一化收进本函数（与 mcp_call wrapper
 * :789 同调 normalizeArguments），P4 网关双工具直调本函数即得 JSON 字符串
 * 兼容；call() 路径保持 wrapper 侧调用不变（双调幂等：对象原样透传同引用）。
 * finally 抄 refCount 对称（callViaPresetViews finally）；绝不调 restore
 * （无 Entry 可恢复，直通语义）；绝不新增 dispose.
 */
export interface GatewayCallOpts {
    signal: AbortSignal;
    agent: Agent | undefined;
    explicitTimeoutMs?: number;
}
export declare function gatewayCall(ctx: Context, control: McpControlCtx, state: GatewayCallState, serverName: string, bareIn: string, args: unknown, opts: GatewayCallOpts): Promise<string>;
/**
 * gatewayCall 共享的状态（P4 网关常驻复用）。
 * 0.5.9 起**必须含 `aiEnabled`**：gatewayCall 是 `mcp_call` 的实际执行分支，
 * 它拉起的行若不登记进这个集合，空闲回收器就永远看不到（实测 bug）。
 */
export type GatewayCallState = ControllerState;
/** 回收器单轮诊断快照（0.5.8）。历史教训：0.5.7 首次实测「临时拉起」时只看到
 * 最终没关，看不到回收器**每轮看到了什么、为什么跳过**，白跑一轮实验。此结构把
 * 判定输入（keepAliveMs / 候选集合 / 各自 refCount 与空闲时长）全部落成可读读数。 */
export interface ReaperRound {
    at: number;
    keepAliveMs: number;
    /** aiEnabled 里的候选（回收只对这一集合生效） */
    candidates: string[];
    decisions: Array<{
        server: string;
        refCount: number;
        idleMs: number;
        action: string;
    }>;
}
/** /debug 只读曝光（模块级单例；零 secrets）。 */
export interface ReaperDiag {
    rounds: number;
    /** 最近一轮（存储态不含 agoMs，读取时计算） */
    lastRound: ReaperRound | null;
    everDisabled: string[];
}
/**
 * 0.5.9 计数闸门（挂 globalThis，**不依赖模块实例**）。
 *
 * 为什么需要：0.5.7/0.5.8 实测出自相矛盾的现场——`mcp_call` 确实把休眠行拉起来了
 * （返回 `3*x**2`、面板 disabled=false），但 `controller.status()` 的 `aiOwned` 与
 * 回收器 `candidates` **同时为空**。两者共用同一个 state 对象，理论上不可能。
 * 可疑面只剩：调用走了另一条分支 / 另有控制器实例 / 中途被清了标记。
 * 这组计数器把每次分支决策记成可读数字，一轮实验即可判定。
 */
interface ControllerCounters {
    controllers: number;
    callResolvedEntry: number;
    callNoEntry: number;
    callPresetBranch: number;
    wakeAdded: number;
    wakeSkippedAlreadyEnabled: number;
    clearedByUser: number;
    reaped: number;
    reaperDroppedNoEntry: number;
}
/** /debug 用：分支决策计数快照。 */
export declare function controllerCounters(): ControllerCounters;
/** 供 /debug 读取（每次刷新 agoMs，不参与逻辑判断）。 */
export declare function reaperDiagnostics(): ReaperDiag & {
    agoMs: number | null;
};
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
export {};
