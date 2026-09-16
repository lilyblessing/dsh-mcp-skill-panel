/**
 * 网关常驻 standing 隔离挂载（P4）。
 *
 * MVT-4/5 已验证配方（`.scratch/mvt-4-gateway.mjs:85-150` /
 * `.scratch/mvt-5-live.mjs:13-86`）的产品化：
 * - 常驻层：open 的 MCP 经 `resolvePresetConfig` 全量配置自托管拉起
 *   dsh-mcp-client（与 preset 官方行同 serverName 互斥：官方行启用时网关
 *   让路，见 ensureOpenMounts）；
 * - 隔离层：子 scope `restrict({ deny: [...] })` 滤掉继承面全部 `mcp__*`，
 *   own 层只留模型面双工具（`installMcpControlTools` 已在插件 ctx 注册，
 *   本模块只负责 deny 视野隔离 + 自检断言）。
 *
 * 红线：
 * - 绝不手动 dispose standing/own（靠 fiber unwind；#1079 旧代指针教训）；
 * - 绝不在运行时写预设文件（事故 5.1 铁律；意图链 routes/pending/preset 不动）；
 * - secrets 不回面板（BLOCK-2；config 只在 host 侧流转）。
 */
import type { Context } from '@deepseek-ai/cordis';
import type { McpControlCtx } from './mcpcall';
/** 网关行 entryId 前缀（连字符；冒号是 EntryTree.sep 不可用，见 B4）。 */
export declare const GATEWAY_ENTRY_PREFIX = "gw-mcp-";
/** 网关行 entryId ↔ serverName 双向映射（B4 三键落字）。 */
export declare function gatewayEntryId(serverName: string): string;
export declare function gatewayServerOfEntryId(entryId: string): string | null;
/** 网关挂载态（常驻，随 autoManage 开关创建/释放）。 */
export interface GatewayState {
    /** restrict 返回的 disposer（逐个 lift 可回滚）。 */
    restrictDisposers: Array<() => void>;
    /** 当前网关拉起的 server（serverName → mount 时间）。 */
    mounts: Map<string, number>;
    /** serverName → loader entryId（B2：卸载逐个 loader.remove 用）。 */
    entryIds: Map<string, string>;
    /** 最近一次自检结果（/debug 可读，面板不展示 secrets）。 */
    lastCheck: {
        at: number;
        ok: boolean;
        detail: string;
    } | null;
    /** 并发 guard：ensureOpenMounts 单飞（W3）。 */
    syncing: boolean;
}
/** 空网关态。 */
export declare function createGatewayState(): GatewayState;
/**
 * 子 scope 视野隔离：在给定 tools 服务上 deny 除双工具外的全部继承 `mcp__*` 名。
 * deny 表调用方传入（动态表：`view(standingKey).visible` 快照，见 MVT-5 R3-2）。
 * 未知名按 dsh-tools 语义抛错——调用方须只传已知 global 名（MVT-4 R2-2）。
 */
export declare function isolateChildScope(childTools: {
    restrict(filter: {
        deny: string[];
    }): () => void;
}, inheritMcpNames: string[]): () => void;
/**
 * open 行网关挂载决策（纯逻辑，可自测）：
 * - preset 行缺失/不可挂载（config undefined）→ 'skip'（回退旧直通语义）；
 * - preset 行 disabled → 'skip'（拒绝语义归 gatewayCall，前置已判定）；
 * - loader 已有同名 server 行（官方行/项目行/global 行启用中，网关让路）→ 'skip-official'
 *  （B3：rc.1 下 standing 行不在 loader.entries，判据=loader 同 serverName 行存在；
 *   standing 行与网关行是否同 scope 抛错互斥未经现网实证，不假设——让路即不建第二实例）；
 * - 已有同名 mount → 'reuse'（防 #3984 `already in use` / #4798 重复注册）；
 * - 否则 'mount'。
 */
export declare function decideMount(serverName: string, presetConfig: {
    serverName: string;
} | undefined, presetDisabled: boolean, mounted: ReadonlyMap<string, number>, hasLoaderRow?: boolean): 'mount' | 'reuse' | 'skip' | 'skip-official';
/**
 * 网关自检断言（MVT-4 ASSERT-A/A2 产品化）：child 可见面恒为双工具。
 * 纯逻辑：visible 名单由调用方传入（`tools.view(childKey).visible.keys()`），
 * 本函数只做集合比对，不碰运行时。
 */
export declare function checkChildVisible(visibleNames: readonly string[]): {
    ok: boolean;
    detail: string;
};
/** 释放网关挂载态：restrict disposer 逐个 lift + loader gw- 行逐个 remove + 清 mounts（B2）。 */
export declare function disposeGatewayState(ctx: Context, state: GatewayState): void;
/** 同步释放（applyAutoManage 同步体内/卸载兜底共用；remove fire-and-forget）。 */
export declare function disposeGatewayStateSync(ctx: Context, state: GatewayState): void;
export interface GatewayDeps {
    ctx: Context;
    /** 预留控制层依赖（当前 ensureOpenMounts 经 listPresetMcpRows 直读，未用；占位见 NIT-2）。 */
    control: McpControlCtx;
    state: GatewayState;
    /**
     * 可注入行源/意图源（自测用；现网缺省走真实现）。
     * WARN-3（复审，2026-09-10）：自测读不到真 state.json（进程缓存）且 fake
     * compositionInventory 空行，必须可注入才能覆盖拆分支。
     */
    listRows?: (ctx: Context, presetId: string) => Promise<{
        rows: GatewayPresetRow[];
        presetPath: string;
    }>;
    readIntents?: () => Promise<Record<string, {
        desired?: boolean;
        lastApplied?: boolean | null;
    }>>;
}
/** ensureOpenMounts 行源最小形状（= preset-mcp.ts PresetMcpRow 子集）。 */
export interface GatewayPresetRow {
    serverName: string;
    rowId: string;
    file: string;
    disabled: boolean;
    config?: import('./preset-mcp').PresetMcpClientConfig;
}
/** ensureOpenMounts 结果计数（W3 lastCheck detail 同格式）。 */
export interface EnsureOpenMountsResult {
    mounted: string[];
    reused: string[];
    skipped: string[];
    skippedOfficial: string[];
    /** 关意图即拆：state.json desired=true 的已挂载行，本轮 remove 掉的名单。 */
    unmounted: string[];
    errors: Array<{
        server: string;
        error: string;
    }>;
}
/**
 * 网关常驻挂载（P5）：open 的 preset 行经 loader.create 自托管拉起 dsh-mcp-client。
 *
 * 真值表（B3）：
 * - preset 无行/不可挂载（config undefined）→ skipped（回退旧直通语义）；
 * - preset 行 disabled → skipped（拒绝语义归 gatewayCall）；
 * - loader 已有同名 server 行 → skippedOfficial（网关让路，不建第二实例）；
 * - mounts 已有同名 → reused；
 * - 否则 loader.create({id: gw-mcp-<server>, name, config, disabled:false}) → mounted/errors。
 *
 * 关意图即拆（WARN-3 补关链路，2026-09-10 现网实证）：
 * - toggle 网关行只写 state.json desired 意图（routes.ts 网关分支，不碰 live gw- 行）；
 * - 本轮先读 state，对「已挂载 mounts 中 desired=true（关意图）」的行逐个 loader.remove
 *   并清 mounts/entryIds 账，记 unmounted；意图链不动（state/pending 由 toggle 侧维护）。
 * - 开意图（desired=false/无意图）走正常挂载真值表；关→开即重挂。
 *
 * 单飞（W3）：syncing guard + 顶层 try/finally；一家失败记 errors 不抛（一家挂不拖全家）。
 * preset 选择（W4）：调用方 agent 优先，无则 roots[0]/list[0]（与 cachedPresetRow 同规则）；
 * listPresetMcpRows 按 presetId 全量列出行，挂载逐行决策。
 */
export declare function ensureOpenMounts(deps: GatewayDeps, presetId?: string): Promise<EnsureOpenMountsResult>;
