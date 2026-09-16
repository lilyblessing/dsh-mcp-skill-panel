/**
 * MCP 工具级禁用（常开）：在 server 级启停之上，按工具精确控制。
 *
 * 作用域（2026-08-27 按用户需求拆分）：
 * - 全局禁用（toolDisabled）：跨所有工作区生效，作用于全局 MCP server；
 * - 项目禁用（projectToolDisabled）：仅所属工作区生效，作用于项目级 MCP server。
 *   判断依据：某 server 是否项目 MCP（projectServerOwner 有值）→ 走项目表（key=该工作区）；
 *   否则为全局 MCP → 走全局表。用户在 A 工作区禁用的项目 MCP 工具不会影响 B 工作区。
 *
 * - 装配过滤常开：`system-prompt/assemble` 依据「当前会话工作区」把命中的 mcp__ 工具
 *   从模型目录剔除（项目表只匹配 owner===当前工作区的会话；全局表无条件生效）
 * - mcp_search / mcp_call 联动：检索不返回禁用工具、调用直接拒绝。
 *
 * 内存 Map 是装配过滤唯一数据源（同步读，零异步），由本模块维护并随 toggle 更新；
 * 实现为模块级单例，被 routes / mcpcall / filter 共享。
 */
import type { Context } from '@deepseek-ai/cordis';
/** 启动/热更新时从 state.json 加载禁用集合（全局 + 项目两张表）。 */
export declare function loadDisabledTools(): Promise<void>;
/** 某 server 的禁用工具集合（面板展示用；workspace=该 server 所属工作区，与 tableKeys 同源）。 */
export declare function disabledToolsOf(serverName: string, workspace?: string): ReadonlySet<string>;
/**
 * 工具全名是否被禁用（按当前会话工作区判定作用域）：
 * - 全局表无条件生效；
 * - 项目表只在「会话工作区 === 项目所属工作区」时生效（A 区禁用不影响 B 区）。
 * workspace 缺省时仅全局表生效（无会话上下文的冷路径）。
 */
export declare function isToolDisabled(fullName: string, workspace?: string): boolean;
/**
 * 切换某工具禁用状态（面板）：
 * - 项目 MCP server（projectServerOwner 有值）→ 写入所属工作区的项目表（仅该区生效）；
 * - 全局 MCP server → 写入全局表。
 * 同时更新内存 Map + 持久化到 state.json（原子合并写盘）。
 * `persist: false`（selftest）只改内存，不动磁盘。
 */
export declare function setToolDisabled(serverName: string, fullName: string, disabled: boolean, persist?: boolean): Promise<void>;
/** {@link resolveToolBulkTargets} 的结果：要么给出精确名单，要么给出拒绝原因。 */
export type ToolBulkTargets = {
    targets: string[];
    ignored: string[];
} | {
    error: string;
};
/**
 * 解析 `/mcp/toolBulk` 的 `toolNames` **三态**契约（纯函数，无 IO，可直测）。
 *
 * - `undefined`（字段缺失）= 该 server 面板视图里的**全部**工具 —— 只有这一种写法表示全部；
 * - 显式数组 = 精确集合：`[]` 是合法空操作（targets 为空，调用方据此跳过写盘）；
 *   非空则与 known 求交，**一条都不匹配即拒绝**（否则「以为批量禁用了，实际一条没动」）；
 * - 其它类型（字符串 / 数字 / 对象 / null / 含非字符串项的数组）= 拒绝：契约是工具全名数组，
 *   静默降级成「全部」会把一次客户端 bug 变成该 server 的全量持久化写入。
 *
 * 2026-09-16 修复（审查 BLOCK-1）：此前「非空数组 ? 交集 : 全部」，显式 `[]` 与任何非数组
 * 都落进「全部」——面板「按当前过滤」在过滤命中 0 项时天然发 `[]`，对 450 工具的 server
 * 就是一次性全量禁用，与用户意图相反且已写盘。
 * @param known - 该 server 当前已知的工具全名（调用方视图，顺序保留）。
 * @param toolNames - 客户端原始入参（未收窄，故为 unknown）。
 * @returns 精确名单 + 未识别名单，或拒绝原因（调用方转 400）。
 */
export declare function resolveToolBulkTargets(known: readonly string[], toolNames: unknown): ToolBulkTargets;
/**
 * 批量切换某 server 上一组工具的禁用状态（面板「全部禁用 / 全部启用 / 按过滤」）。
 *
 * 与逐个调用 {@link setToolDisabled} 的区别只在 IO：这里对 state.json 只做
 * **一次** 读-改-写。prompthelper 这种 450 工具的 server 逐个写会是 450 次
 * 合并写盘 + 450 次面板失效，实际不可用。
 *
 * 语义与单个开关完全一致（同一张表、同一套项目/全局作用域分派），所以批量与
 * 单点操作可以任意交替，不存在「批量模式」这种隐藏状态。
 * @param serverName - 目标 MCP server。
 * @param toolNames - 工具全名（mcp__<server>__<tool>）列表；非本 server 的条目忽略。
 * @param disabled - true=禁用这批，false=启用这批。
 * @param persist - false 时只改内存不落盘（selftest）。
 * @returns 实际发生变化的工具数。
 */
export declare function setToolsDisabledBulk(serverName: string, toolNames: readonly string[], disabled: boolean, persist?: boolean): Promise<number>;
/**
 * 常开装配过滤：把用户禁用的 MCP 工具从模型工具目录剔除。
 * 项目表按当前会话工作区匹配（context.agent.session.header.cwd），
 * 会话工作区不等于项目所属区时该项目工具本就不会挂载可见（由 project-mcp 过滤），
 * 这里对全局表无条件生效、对项目表按 owner===cwd 生效。
 */
export declare function installToolDisableFilter(ctx: Context): () => void;
