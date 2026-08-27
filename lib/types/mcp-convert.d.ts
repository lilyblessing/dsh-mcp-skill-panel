/**
 * mcpServers JSON → dsh-mcp-client 行 的纯转换模块。
 *
 * 用户从其它 harness（Claude Code / Codex / Roo 等）复制的 `.mcp.json` 是
 * `{ "mcpServers": { <name>: { command|url, args, env, cwd, headers } } }` JSON
 * 形态。本模块把它解析并转换为 `@deepseek-ai/dsh-mcp-client` 插件行：
 * - transport 推断：显式 `type`/`transport` 优先（"http"/"sse" 归一 streamable-http），
 *   否则有 `command` → stdio、有 `url` → streamable-http；
 * - serverName 校验：dsh-mcp-client 要求 `[A-Za-z0-9_-]{1,32}`；
 * - `${VAR}` 环境变量占位：全局 YAML 形态 → `!!js` 模板表达式（loader 加载时求值），
 *   运行时挂载形态 → 挂载时解析 `process.env`（缺失保留占位符，让远端报可见错误）。
 *
 * 纯逻辑、零依赖（仅类型），可被 scripts/selftest 用构建产物直接覆盖。
 */
/** 单个 MCP server 的规范化配置（与 dsh-mcp-client 的 config 形状对齐）。 */
export interface McpServerConfig {
    serverName: string;
    transport: 'stdio' | 'streamable-http';
    command?: string;
    args?: string[];
    env?: Record<string, string>;
    cwd?: string;
    url?: string;
    headers?: Record<string, string>;
    toolCallTimeoutMs?: number;
}
/** serverName → 配置（JSON 键即 serverName）。 */
export type McpServers = Record<string, McpServerConfig>;
/** dsh-mcp-client 插件行（loader entry 形状）。 */
export interface McpRowConfig {
    id: string;
    name: string;
    config: Record<string, unknown>;
}
/** 解析结果：合法 server + 逐条错误。 */
export interface ParseResult {
    servers: McpServers;
    errors: string[];
}
/** dsh-mcp-client 的插件包名。 */
export declare const MCP_CLIENT_NAME = "@deepseek-ai/dsh-mcp-client";
/**
 * 解析 mcpServers JSON 文本。
 * 同时接受 `{ "mcpServers": {...} }` 与直接 `{ <name>: {...} }` 两种形态。
 */
export declare function parseMcpServersJson(text: string): ParseResult;
/** 字符串是否含 `${VAR}` 环境变量占位。 */
export declare function hasEnvRef(value: string): boolean;
/** 把含 `${VAR}` 的字符串转成 JS 模板字面量文本（`!!js` 表达式体）。 */
export declare function toJsTemplate(value: string): string;
/** 运行时解析 `${VAR}` → process.env 值；缺失的保留占位符原样（远端报可见错误）。 */
export declare function resolveEnvRefs(value: string): string;
/** 递归解析对象内所有字符串值的 ${VAR}（挂载时调用）。 */
export declare function resolveServersEnv(servers: McpServers): McpServers;
/** 把 McpServers 转成 dsh-mcp-client 插件行（loader entry 形状）。 */
export declare function serversToRows(servers: McpServers, idPrefix?: string): McpRowConfig[];
/** 生成全局 profile 可追加的 `- insert:` patch 块（dsh-mcp-client 行，!!js 环境插值）。 */
export declare function serversToPatchYaml(servers: McpServers): string;
