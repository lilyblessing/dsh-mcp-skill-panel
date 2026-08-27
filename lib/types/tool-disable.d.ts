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
/**
 * 常开装配过滤：把用户禁用的 MCP 工具从模型工具目录剔除。
 * 项目表按当前会话工作区匹配（context.agent.session.header.cwd），
 * 会话工作区不等于项目所属区时该项目工具本就不会挂载可见（由 project-mcp 过滤），
 * 这里对全局表无条件生效、对项目表按 owner===cwd 生效。
 */
export declare function installToolDisableFilter(ctx: Context): () => void;
