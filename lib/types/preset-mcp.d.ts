/**
 * rc.1 standing 组合 preset 行读取（空面板修复A，2026-09-08）。
 *
 * 背景：dsh 0.1.2-rc.1 起 preset 行挂在 standing 组合（agent scope 树），不再进
 * `ctx.loader.entries()`（实证 host/agent loader 156 行零 MCP，而
 * `compositionInventory()` 显示 standard-mcp 10 行、filesystem fiberState=2 运行中）。
 * collectMcp 只扫 loader → mcp[]==0 空面板；mcp_call 也因 findMcpEntry miss 而
 * 报「不在 loader 中」。
 *
 * 本模块只经 `ctx.agentPresets` 服务读数（compositionInventory/resolve/read），
 * 不直连 `livePresetMounts` 模块实例（host 与面板各装一份，模块态不共享），
 * 不产生运行时新依赖（type-only import，tsdown external 无影响）。
 */
import type { Context } from '@deepseek-ai/cordis';
/** preset 文件文本解析出的单行 MCP 配置（key = 短 rowId，如 mcp-filesystem）。 */
export interface PresetMcpParsed {
    serverName: string;
    transport: string | null;
    toolCallTimeoutMs?: number;
}
/**
 * 解析 preset 组合文本，抽取全部 `mcp-*` 行的 serverName/transport/超时。
 * 纯文本正则（preset 文件结构稳定）：按 `^- id:` 切块，块内抓三个键。
 * 键锚定行首（防注释/长键误命中）；值允许可选双引号（YAML `"stdio"` 形态）。
 * 纯函数，可被 selftest 直接覆盖。
 */
export declare function parsePresetMcpText(text: string): Map<string, PresetMcpParsed>;
/** standing 组合中的一行 MCP（inventory 行 + preset 文本配置的合并）。 */
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
}
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
