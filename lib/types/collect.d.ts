/**
 * 数据收集：MCP 清单（loader 行 × schema 聚合）与 Skill 清单（目录快照）。
 *
 * 从 index.ts 拆出（可维护性批次 P1-1）：collectMcp / collectSkills / 聚合缓存 /
 * 分域缓存句柄。依赖方向：本模块只被 routes.ts / index.ts 消费。
 */
import type { Context } from '@deepseek-ai/cordis';
import type { McpRow, McpView, SkillsView } from './shared-types';
import type { McpCallController } from './mcpcall';
import type { CatalogRuntime } from './index';
/** 分域缓存 TTL：事件驱动失效为主，TTL 只是兜底（事件丢失场景） */
export declare const DOMAIN_TTL_MS = 60000;
/** 已确认的 skill 状态在 collectState 中覆盖 snapshot 旧值的有效期 */
export declare const CONFIRMED_SKILL_TTL_MS = 60000;
/** skill toggle 确认轮询间隔（ctx.timeout，随 ctx 生命周期）。 */
export declare const SKILL_TOGGLE_POLL_MS = 80;
/**
 * 最近一次 toggle 确认过的 skill 状态（name → modelInvocable）。
 * 服务端轮询用 skills.get 实时读文件确认，早于 snapshot 的发现缓存失效，
 * 用它覆盖 collectState 里的陈旧 candidate 值。
 */
export declare const confirmedSkills: Map<string, {
    modelInvocable: boolean;
    at: number;
}>;
/** Skill 行视图（host 内部使用；对外形状见 shared-types 的 SkillRow）。 */
export interface SkillView {
    name: string;
    description: string;
    source: string;
    modelInvocable: boolean;
    userInvocable: boolean;
    path?: string;
}
export interface Deps {
    ctx: Context;
    caches: DomainCaches;
    catalogRuntime: CatalogRuntime;
    /** 中间层控制层（mcp_call 的 AI 启用标记查询/清除）。 */
    controller?: McpCallController;
}
/** 分域缓存句柄：apply 创建，makeRoutes 消费，事件失效由 apply 订阅。 */
export interface DomainCaches {
    mcpCache: Map<string, {
        at: number;
        promise: Promise<McpView>;
    }>;
    skillsCache: Map<string, {
        at: number;
        promise: Promise<SkillsView>;
    }>;
    /** MCP 工具聚合缓存（per scope），tools/change 时随 mcpCache 一起清 */
    mcpAggregates: Map<object | null, {
        at: number;
        value: McpAggregate;
    }>;
    /** schemas 原始缓存（per scope），路径 A/B 共享同一份深克隆结果 */
    schemasCache: Map<object | null, {
        at: number;
        schemas: Array<{
            name?: unknown;
            description?: unknown;
            parameters?: unknown;
        }>;
    }>;
    invalidateMcp: () => void;
    invalidateSkills: () => void;
}
export declare function createDomainCaches(): DomainCaches;
/** 写时清理过期条目（P2-8）：分域缓存 / 聚合 / 已确认 skill 的 Map 长期运行不膨胀。 */
export declare function pruneExpired<T>(map: Map<T, {
    at: number;
}>, now: number): void;
/**
 * 按 scope 共享的 schemas 原始缓存：路径 A（catalog 采集）与路径 B（面板聚合）
 * 共用同一份深克隆结果，避免 tools.change 风暴期内重复深克隆。
 * key = scopeKey ?? null；TTL 由调用方指定（路径 A 500ms，路径 B 60s）。
 */
export declare function getSchemasView(ctx: Context, caches: DomainCaches, scopeKey: object | undefined, ttlMs: number): Array<{
    name?: unknown;
    description?: unknown;
    parameters?: unknown;
}>;
export declare function resolveAgent(ctx: Context, sessionId: string | undefined): import("@deepseek-ai/dsh-agent").Agent;
export declare function resolveCollectScopeKey(ctx: Context, sessionId: string | undefined): Promise<object | undefined>;
/** scope key 解析来源（/debug scopeDiag 展示用）。 */
export declare function scopeKeySource(): 'agent' | 'standing' | null;
/** 行状态徽标判定（纯函数，selftest 表驱动回归）。
 * 语义（2026-08-27 发布前独立审查修正）：active/idle 以 **liveTools**（真实注册）
 * 为准——displayTools 含 catalog 快照兜底，用它判定 active 会掩盖「scope 解析
 * 失败但 catalog 有旧快照」的故障现场（面板显示健康而实际工具未注册）。
 * displayTools 仅用于 tools/tokens 数值展示与停用态回填。
 */
export declare function computeStatus(disabled: boolean, running: boolean, liveTools: number): McpRow['status'];
/** MCP 工具聚合结果：per-server 工具数 + token 估算。tools/change 间隙复用，跳过 schemas 深克隆。 */
export interface McpAggregate {
    byServer: Map<string, {
        tools: number;
        tokens: number;
    }>;
    mcpToolsTotal: number;
    mcpTokensTotal: number;
}
/**
 * 按 name 去重合并两个 schemas 视图（scoped 优先）。
 *
 * ⚠️ 2026-08-27 实测结论：`tools.schemas()`（无参全局视图）**不含任何 mcp__ 工具**
 * （全部 mcp 工具注册在 scope 层）→ 本合并当前环境恒为 no-op，属**防御性合并**：
 * 若未来出现联邦/全局作用域注册的 mcp 工具，此路径才生效。filesystem 等 patch 层
 * server 此前「无工具」的真正根因是 HTTP 路径 scope key 解析失败（3872206 共享缓存
 * 修复），与全局视图无关——维护时勿按旧注释误判为「全局 realm 有工具」。
 * 同名条目 scoped 优先（占位条目会压过全局完整 schema，当前两视图同源不触发）。
 */
export declare function mergeSchemas(scoped: Array<{
    name?: unknown;
    description?: unknown;
    parameters?: unknown;
}>, global: Array<{
    name?: unknown;
    description?: unknown;
    parameters?: unknown;
}>): Array<{
    name?: unknown;
    description?: unknown;
    parameters?: unknown;
}>;
declare function collectMcp(deps: Deps, sessionId: string | undefined): Promise<McpView>;
declare function collectSkills(deps: Deps, sessionId: string | undefined): Promise<SkillsView>;
export { collectMcp, collectSkills };
