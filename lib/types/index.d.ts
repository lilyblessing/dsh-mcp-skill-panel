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
import type { Catalog } from './catalog';
import type { McpView, SkillsView } from './shared-types';
export type { McpView, SkillsView, McpRow, SkillRow } from './shared-types';
export type { DomainCaches } from './collect';
export { setRowFlag, setSkillFlag, rowDisabledState } from './preset';
export declare const name = "runtime-inventory";
export declare const inject: string[];
export interface Config {
    /** @deprecated 0.3.0 起分域缓存由事件驱动失效，TTL 为常量；保留字段仅为向后兼容 */
    cacheTtlMs?: number;
    /**
     * 形态 2（中间层代理）：停用的 MCP 对模型隐藏、经 mcp_search/mcp_call 按需调用；
     * 用户打开的 MCP 保持模型可见。默认 false（现状，纯面板）。
     */
    autoManage?: boolean;
    /** 保活回收窗口（ms）。默认 30_000。 */
    keepAliveMs?: number;
    /** mcp_search 缺省 top-K。默认 5。 */
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
    /** AI 中间层当前生效状态（面板开关可动态切换）。 */
    autoManage: boolean;
    /** 动态切换 AI 中间层（过滤 + mcp_search/mcp_call + 回收器）。 */
    applyAutoManage: (on: boolean) => void;
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
    };
}
export declare function apply(ctx: Context, config?: Config): void;
