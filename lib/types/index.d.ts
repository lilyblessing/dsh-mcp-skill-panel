/**
 * dsh-mcp-skill-panel — Host 半区入口
 *
 * 设置页「MCP 与技能管理面板」的数据与控制面：
 * - MCP 页：枚举 loader 预设子树中的 mcp-* 行 + tools.schemas(scope) 聚合工具数/token，
 *   启停 = loader entry.update({disabled})（实时生效）。
 * - Skill 页：skills.snapshot/get 枚举目录，启停 = SKILL.md frontmatter
 *   `disable-model-invocation: true` 注入/移除（watcher 实时失效 catalog）。
 *
 * 本文件只保留：Config / catalog 采集 / 中间层装配 / 生命周期。数据收集与路由见
 * collect.ts / routes.ts，状态持久化见 state.ts / preset.ts，控制层见 mcpcall.ts。
 *
 * Phase A 实测结论（2026-08-15，动态探针验证）：
 * - ctx.loader.entries() 枚举全部行（含嵌套预设行，id 如 include:agent-presets:mcp-cheatengine）
 * - loader.resolve() 需要完整嵌套 id；entry.update({disabled}) 实时 dispose/restart
 * - 预设树（PresetTree）write() 是 no-op → loader.update 不写盘
 * - tools.schemas(scope) 必须传 scopeOf(agent.ctx)（agent 对象/standingKey 会落回全局视图）
 * - skill 文件经 skills.get(name, {scope, cwd}).path 定位；改 frontmatter 由
 *   dsh-skill-filesystem 的 chokidar watcher 实时失效
 *
 * MCP 持久化（v0.1.1 修复，2026-08-15）：
 * 运行期禁止写 agent.cordis.yml —— dsh-agent-presets 的 ensureStanding 用
 * {mtimeMs, size} stamp 检测预设文件变化，变化时删除 standing 记录并重挂，
 * 但旧 standing 的 fiber/scope 不 dispose → 旧 mcp-client 实例的 serverName
 * 仍占用 → 新挂载全部 "already in use" → 会话创建/resume 失败（实测事故）。
 * 持久化改为：toggle 只写插件自己的状态文件（~/.dsh/dsh-mcp-skill-panel/state.json），
 * 插件 apply 时（启动早期、standing 未挂载）再物化到预设文件 —— 此时写文件安全。
 */
import Schema from '@deepseek-ai/schemastery';
import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { Catalog } from './catalog';
export { normalizeToolName, normalizeArguments, msgOf, gatewayCall } from './mcpcall';
export type { GatewayCallOpts, GatewayCallState } from './mcpcall';
export { MCP_SEARCH_TOOL, MCP_CALL_TOOL, CONTROL_TOOL_NAMES } from './mcpcall';
export { buildSummaryHeader } from './mcpcall';
import type { McpView, SkillsView } from './shared-types';
import { type RouteDecision, type RouteServices } from './model-route';
export type { McpView, SkillsView, McpRow, SkillRow } from './shared-types';
export type { DomainCaches } from './collect';
export { mergeSchemas, computeStatus, rowDisplay } from './collect';
export { setRowFlag, setSkillFlag, rowDisabledState, syncPresetFiles, isValidSkillName, buildSkillMd } from './preset';
export { scanWorkspaceMcp } from './project-mcp';
export { installProjectMcp, remountWorkspace, projectServerOwner, projectServerName } from './project-mcp';
export { createGatewayState, isolateChildScope, decideMount, checkChildVisible, disposeGatewayState, disposeGatewayStateSync, ensureOpenMounts, gatewayEntryId, gatewayServerOfEntryId, GATEWAY_ENTRY_PREFIX } from './gateway';
export type { GatewayState, EnsureOpenMountsResult } from './gateway';
/** P5（D5）：/debug 只读网关挂载面（无 secrets）。模块级单例由 apply 赋值。 */
import type { GatewayState as GatewayStateType } from './gateway';
export declare function gatewayStateForDebug(): {
    mounted: string[];
    lastCheck: GatewayStateType['lastCheck'];
};
export declare function controllerStatusForDebug(): {
    aiOwned: Array<{
        server: string;
        refCount: number;
        lastUsed: number;
        idleMs: number;
    }>;
};
/** 0.6.3：能力表采集的逐阶段痕迹（/debug 的 inventoryTrace）。 */
export declare function inventoryTraceForDebug(): unknown;
export declare function ensureOpenMountsForDebug(): Promise<unknown>;
export { readState, writeState, stateAutoManageByRoute, stateMiddleLayerHides, stateToolBudget } from './state';
export { applyPendingMcp, pendingMcp, pendingMcpCount, type PendingMcpEntry } from './pending';
export { loadDisabledTools, setToolDisabled, setToolsDisabledBulk, isToolDisabled, disabledToolsOf, resolveToolBulkTargets } from './tool-disable';
export type { ToolBulkTargets } from './tool-disable';
export { parsePresetMcpText, findPresetRowByServerName, presetConfigOf } from './preset-mcp';
export type { PresetMcpRow, PresetMcpClientConfig, PresetMcpParsed } from './preset-mcp';
export { resolveRoute, routeDecision, routeKey, type ModelRoute, type RouteDecision } from './model-route';
export { activeRouteView, fetchProviderCatalog, modelsCacheFresh, type ActiveRouteView, type ProviderCatalogEntry } from './model-route';
export { modelsCatalog, __resetModelsCache } from './routes';
export { installMcpVisibilityFilter, type AssemblyGate } from './filter';
export declare const name = "runtime-inventory";
export declare const inject: string[];
export interface Config {
    /**
     * 形态 2（中间层代理）：停用的 MCP 对模型隐藏、经 mcp_search/mcp_call 按需调用；
     * 用户打开的 MCP 保持模型可见。默认 false（现状，纯面板）。
     */
    autoManage?: boolean;
    /** 保活回收窗口（ms）。默认 30_000。 */
    keepAliveMs?: number;
    /** mcp_search 缺省 top-K。默认 8（P3 网关定稿；线3 bench 平均 tok 最小拐点）。 */
    searchLimitDefault?: number;
    /** mcp_search top-K 上限。默认 10。 */
    searchLimitMax?: number;
    /** 能力摘要表（mcp_search 空查询时返回）。 */
    serverSummary?: Record<string, string>;
}
export declare const Config: Schema<Config>;
/** part=all（缺省）时的完整响应 */
export type RuntimeState = McpView & SkillsView;
/** 私有 catalog 内存态 + 持久化。 */
export interface CatalogRuntime {
    catalog: Catalog;
    dirty: boolean;
    persisting: boolean;
    /** 磁盘加载是否已完成（完成前跳过采集，防止空快照覆盖磁盘 last-good）。 */
    loaded: boolean;
    /** AI 中间层总开关当前值（面板可动态切换）。 */
    autoManage: boolean;
    /** 按模型覆盖表当前值（键为 provider 或 provider/model；P3b）。 */
    autoManageByRoute: Record<string, boolean>;
    /** 中间层生效时隐藏哪些 server：'disabled'=仅手动停用的（默认）；'all'=全部 MCP。 */
    middleLayerHides: 'disabled' | 'all';
    /**
     * 中间层是否**已实际挂载**（过滤 + 控制工具 + 回收器装上了）。
     *
     * 与 autoManage 总开关不是一回事：总开关关但覆盖表里有 true 项时仍会挂载
     * （见 {@link autoManageNeeded}）。G2 的不变量：任一会话 `decisionFor(agent).on`
     * 为真 ⇒ 本字段必为真；挂载失败时会被强制回落（见 applyAutoManage 的 catch）。
     */
    autoManageMounted: boolean;
    /**
     * 动态应用 AI 中间层配置（过滤 + 控制工具 + 回收器）。
     *
     * 挂载条件 = 总开关 on **或**覆盖表里存在 true 项（{@link autoManageNeeded}）；
     * 具体某次装配是否生效由 {@link CatalogRuntime.decisionFor} 按模型路由决定。
     * 省略 byRoute/hides 时沿用当前值（`/config` 部分字段更新用）。
     */
    applyAutoManage: (on: boolean, byRoute?: Record<string, boolean>, hides?: 'disabled' | 'all') => void;
    /**
     * 某 agent（缺省=当前解析不到）当前的中间层判定，面板与诊断共用。
     *
     * P3b：`routeDecision(resolveRoute(routeServices, agent), autoManage, autoManageByRoute)`
     * —— 三级回退解析出的模型（provider/model）先查精确项、再查 provider 项、最后回退总开关。
     * 服务缺失/诊断装配（无 agent）时静默降级，只走总开关（到位情况见 diag.routeServices）。
     */
    decisionFor: (agent: Agent | undefined) => RouteDecision;
    /**
     * 可选服务 holder（sessionProjections / agentDefaultModel / llm），路由解析用。
     * 漏掉任一服务时 resolveRoute 静默降级（只走剩下的回退级），故到位情况必须
     * 可见 —— 见 diag.routeServices（/debug 原样回显）。
     */
    routeServices: RouteServices;
    /** 最近一次成功写盘时间（防抖合并用）。 */
    lastPersistAt: number | null;
    /** 防抖挂起的写盘 timer（ctx.timeout 创建，ctx 销毁自动清理）。 */
    persistTimer: (() => void) | undefined;
    /** 停用态 token 估算缓存（P2-6）：fetchedAt 不变则复用。 */
    tokenCache: Map<string, {
        fetchedAt: number;
        tokens: number;
    }>;
    /** 诊断计数（debug 端点输出，定位采集链路问题用）。 */
    diag: {
        toolsChangeEvents: number;
        snapshots: number;
        lastError: string | null;
        lastAt: number | null;
        lastMcpTools: number | null;
        lastSchemasTotal: number | null;
        lastScope: boolean | null;
        lastAgentRoots: number | null;
        lastAgentList: number | null;
        loadedAt: number | null;
        loadedServers: number | null;
        /**
         * C1（评审风险 1）：路由服务（sessionProjections / agentDefaultModel / llm）
         * 是否**已到位**。三者任一缺失时按模型分流会静默降级为只看总开关（无报错），
         * 所以必须在 /debug 的返回里显式回显（/debug 的 `diag` 段原样回传本对象）。
         */
        routeServices: {
            projections: boolean;
            defaultModel: boolean;
            llm: boolean;
        };
        /**
         * P3b（评审 §6 风险 5 / G2）：中间层挂载态与路由配置的**当下**读数。
         * getter 而非快照 —— applyAutoManage 可被 /config 动态调用，/debug 每次读到的
         * 必须是当时的值。与 /debug 里并列的 `gateway.mounted`（网关实际拉起的行）配合，
         * 即可核对「needed 与网关挂载态一致」：mounted=true 时 gateway.mounted 才有意义。
         */
        middleware: {
            mounted: boolean;
            master: boolean;
            byRoute: Record<string, boolean>;
            hides: 'disabled' | 'all';
        };
    };
}
/**
 * 中间层是否需要挂载（P3b；评审 §3-G 第 5 条 / §3-I）。
 *
 * 挂载条件不是「总开关 on」而是「有任何模型可能用到」：总开关关 + `grok: true`
 * 也必须挂 —— 控制工具注册表是进程级的一份，不挂的话覆盖项永远无法生效
 * （被覆盖的模型会看到 dsh_mcp_search，但 preset 关态行拉不起来）。
 *
 * G2 一致性不变量（由 selftest 穷举 master × 覆盖表 × 模型验证）：
 * 任一会话 `routeDecision(...).on === true` ⇒ 本函数必为 true。
 * 两者读的是同一份输入（master + 覆盖表），所以只要挂载不失败就不会出现
 * 「gate 打开但网关没挂」；挂载失败时 applyAutoManage 会把覆盖表清空兜住。
 * @param master - 总开关（state.json 的 config.autoManage）。
 * @param byRoute - 覆盖表（键为 provider 或 provider/model）。
 * @returns 是否需要挂载中间层。
 */
export declare function autoManageNeeded(master: boolean, byRoute: Readonly<Record<string, boolean>>): boolean;
export declare function apply(ctx: Context, config?: Config): void;
