/**
 * rc.1 standing 组合 preset 行读取（空面板修复A 0.5.5 + 预设直通 0.5.6，2026-09-08）。
 *
 * 背景：dsh 0.1.2-rc.1 起 preset 行挂在 standing 组合（agent scope 树），不再进
 * `ctx.loader.entries()`（实证 host/agent loader 156 行零 MCP，而
 * `compositionInventory()` 显示 standard-mcp 10 行、filesystem fiberState=2 运行中）。
 * collectMcp 只扫 loader → mcp[]==0 空面板（0.5.5 补行修复）；mcp_call 也因
 * findMcpEntry miss 而报「不在 loader 中」（0.5.6 直通修复见 mcpcall.ts call()）。
 *
 * 本模块只经 `ctx.agentPresets` 服务读数（compositionInventory/resolve/read），
 * 不直连 `livePresetMounts` 模块实例（host 与面板各装一份，模块态不共享），
 * 不产生运行时新依赖（type-only import，tsdown external 无影响）。
 */
import type { Context } from '@deepseek-ai/cordis';
/** preset 文件文本解析出的单行 MCP 配置（key = 短 rowId，如 mcp-filesystem）。
 *
 * P1 直读（2026-09-09）：除 serverName/transport/超时外，追加 dsh-mcp-client
 * 挂载所需的全键（command/args/env/cwd/url/headers/failOnStartupError）。
 * env/headers 的值是**求值后**的最终字符串（`!!js` 在解析时即用 process.env
 * 求值，与 loader 加载时语义一致；失败回落 ''）。transport 缺省时按
 * mcp-convert.ts:108-119 规则推断（有 command→stdio/有 url→http），推断不出
 * 才为 null（兼容旧行为）。
 */
export interface PresetMcpParsed {
    serverName: string;
    transport: string | null;
    toolCallTimeoutMs?: number;
    command?: string;
    args?: string[];
    env?: Record<string, string>;
    cwd?: string;
    url?: string;
    headers?: Record<string, string>;
    failOnStartupError?: boolean;
}
/**
 * 解析 preset 组合文本，抽取全部 `mcp-*` 行的 serverName/transport/超时/挂载全键。
 * 纯文本正则（preset 文件结构稳定）：按 `^- id:` 切块，块内抓 serverName/
 * transport/toolCallTimeoutMs/command/args/env/cwd/url/headers/failOnStartupError。
 * 键锚定行首（防注释/长键误命中）；值允许可选双引号（YAML `"stdio"` 形态）。
 * `!!js "..."` 表达式在解析时即求值（process.env 语义，与 loader 一致）。
 * transport 缺省按 mcp-convert.ts:108-119 推断（有 command→stdio/有 url→http）。
 * 纯函数，可被 selftest 直接覆盖。
 */
export declare function parsePresetMcpText(text: string): Map<string, PresetMcpParsed>;
/** standing 组合中的一行 MCP（inventory 行 + preset 文本配置的合并）。
 *
 * P1 直读（2026-09-09）：新增可选 `config`，为该行的 dsh-mcp-client 全量挂载
 * 配置（与 McpServerConfig 形状对齐的子集；`!!js`/`${VAR}` 已在解析时求值）。
 * 旧字段语义不变：disabled/running 仍是 inventory 快照。
 */
export interface PresetMcpRow {
    /** inventory 长 id（含 standing 前缀，如 include:agent-presets:mcp-filesystem）。 */
    entryId: string;
    /** preset 文件内短 id（如 mcp-filesystem；state.json row 键）。 */
    rowId: string;
    serverName: string;
    transport: string | null;
    toolCallTimeoutMs?: number;
    disabled: boolean;
    running: boolean;
    /** preset 组合文件绝对路径（state.json mcp 段的文件键）。 */
    file: string;
    /** 该行的 dsh-mcp-client 全量挂载配置（P1 直读新增；缺省=旧快照行）。 */
    config?: PresetMcpClientConfig;
}
/** dsh-mcp-client 行 config 全量子集（与 mcp-convert.ts McpServerConfig 对齐）。 */
export interface PresetMcpClientConfig {
    serverName: string;
    transport: 'stdio' | 'streamable-http';
    command?: string;
    args?: string[];
    env?: Record<string, string>;
    cwd?: string;
    url?: string;
    headers?: Record<string, string>;
    toolCallTimeoutMs?: number;
    failOnStartupError?: boolean;
}
/** 由 PresetMcpParsed 组装挂载 config（transport 归一失败/缺失时返回 undefined）。 */
export declare function presetConfigOf(parsed: PresetMcpParsed): PresetMcpClientConfig | undefined;
/**
 * 按 serverName 在某 preset 的 standing 行里定位（mcp_call 预设直调用，0.5.6）。
 * serverName 大小写敏感精确匹配（与 serverNameOf/config.serverName 同语义）；
 * preset 文本缺 serverName 键时按 fallbackServerName 回落（与 listPresetMcpRows
 * 同规则，覆盖 mcp-anki→anki-mcp 例外）。若重复取首行（上游保证唯一）。
 */
export declare function findPresetRowByServerName(ctx: Context, presetId: string, serverName: string): Promise<PresetMcpRow | undefined>;
/**
 * 列出某 preset 在 standing 组合中的全部 MCP 行。
 * inventory 给 entryId/enabled/fiberState，preset 文本给 serverName/transport/超时。
 */
export declare function listPresetMcpRows(ctx: Context, presetId: string): Promise<{
    rows: PresetMcpRow[];
    presetPath: string;
}>;
/**
 * 按长 entryId 反查其所属 preset 行（toggleMcp 预设兜底用）。
 * 逐 preset 找 entryId 命中，找到即 resolve+read+parse 该 preset。
 */
export declare function findPresetRowByEntryId(ctx: Context, entryId: string): Promise<{
    presetId: string;
    row: PresetMcpRow;
    presetPath: string;
} | undefined>;
