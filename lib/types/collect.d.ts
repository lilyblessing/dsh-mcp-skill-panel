/**
 * 数据收集：MCP 清单（loader 行 × schema 聚合）与 Skill 清单（目录快照）。
 *
 * 从 index.ts 拆出（可维护性批次 P1-1）：collectMcp / collectSkills / 聚合缓存 /
 * 分域缓存句柄。依赖方向：本模块只被 routes.ts / index.ts 消费。
 */
import type { Context } from '@deepseek-ai/cordis';
import type { McpView, SkillsView } from './shared-types';
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
    invalidateMcp: () => void;
    invalidateSkills: () => void;
}
export declare function createDomainCaches(): DomainCaches;
/** 写时清理过期条目（P2-8）：分域缓存 / 聚合 / 已确认 skill 的 Map 长期运行不膨胀。 */
export declare function pruneExpired<T>(map: Map<T, {
    at: number;
}>, now: number): void;
export declare function resolveAgent(ctx: Context, sessionId: string | undefined): import("@deepseek-ai/dsh-agent").Agent;
/** MCP 工具聚合结果：per-server 工具数 + token 估算。tools/change 间隙复用，跳过 schemas 深克隆。 */
export interface McpAggregate {
    byServer: Map<string, {
        tools: number;
        tokens: number;
    }>;
    mcpToolsTotal: number;
    mcpTokensTotal: number;
}
declare function collectMcp(deps: Deps, sessionId: string | undefined): Promise<McpView>;
declare function collectSkills(deps: Deps, sessionId: string | undefined): Promise<SkillsView>;
export { collectMcp, collectSkills };
