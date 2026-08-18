/**
 * MCP loader entry 判定与 serverName 提取（DRY 收敛）。
 *
 * 「某行是不是 MCP 行 + 它的 serverName 是什么」在 collectMcp / snapshotEnabled /
 * findMcpEntry / buildVisibility / toggleMcp 中重复 4+ 次，统一收敛到本模块。
 * 纯逻辑、零依赖（仅类型），可被 selftest 覆盖。
 */
import type { Entry } from '@deepseek-ai/cordis-plugin-loader';
/** dsh-mcp-client 行的 config 形状（只取本插件关心的字段）。 */
export interface McpEntryConfig {
    serverName?: unknown;
    transport?: unknown;
    toolCallTimeoutMs?: unknown;
}
/** 判定 loader entry 是否为 MCP 行（dsh-mcp-client 或带 serverName 配置的行）。 */
export declare function isMcpEntry(entry: Entry): boolean;
/** 取 MCP 行的 serverName（config.serverName 缺省回落 entry id）。 */
export declare function serverNameOf(entry: Entry): string;
/** 取 MCP 行的 config（供 transport / toolCallTimeoutMs 读取）。 */
export declare function mcpEntryConfig(entry: Entry): McpEntryConfig | null;
