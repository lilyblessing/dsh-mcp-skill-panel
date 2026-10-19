/**
 * standing 组合 preset 行读取（空面板修复A 0.5.5 + 预设直通 0.5.6，2026-09-08；
 * 0.1.7 契约改造 2026-09-24，见 README 变更日志 v0.7.0）。
 *
 * 背景：dsh 0.1.2-rc.1 起 preset 行挂在 standing 组合（agent scope 树），不再进
 * `ctx.loader.entries()`（实证 host/agent loader 156 行零 MCP，而当时的组合清单读
 * 数显示 standard-mcp 10 行、filesystem 运行中）。collectMcp 只扫 loader →
 * mcp[]==0 空面板（0.5.5 补行修复）；mcp_call 也因 findMcpEntry miss 而报
 * 「不在 loader 中」（0.5.6 直通修复见 mcpcall.ts call()）。
 *
 * 0.1.7 读数源变化（`@deepseek-ai/dsh-agent-preset-registry`）：
 * - `compositionInventory()` 不变（行清单：enabled/fiberState/moduleName）；
 * - 旧的 `resolve(id).path` + `read(id)` 已不存在 —— 声明式预设**没有独立文件**
 *   （registry README.zh.md：预设目录形态已判死），声明文本改由
 *   `readDocument(id).content` 提供（entry-list YAML 方言，parsePresetMcpText 可直读）；
 * - 持久化/定位键由「预设文件绝对路径」改为「**预设声明行的 Loader 行 id**」
 *   （如 `preset-standard-mcp`；声明行的 id 是 Loader 编辑地址，`config.id` 才是会话
 *   保存的 preset 标识符，见 agent-preset README.zh.md）。
 *
 * 本模块只经 `ctx.agentPresets` 服务读数 + `ctx.loader` 反查声明行，
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
    /** 组合行 id：0.1.7 起 `compositionInventory()` 给的是**相对** id（如 mcp-filesystem），
     * 而 standing 树里 `entry.id` 是绝对 id（`<owner id>:<rowId>`）—— 两者都按 id 匹配，
     * 见 standing-rows.findStandingEntryById。 */
    entryId: string;
    /** 预设声明内的短 id（如 mcp-filesystem；state.json 第二级键）。 */
    rowId: string;
    serverName: string;
    transport: string | null;
    toolCallTimeoutMs?: number;
    disabled: boolean;
    running: boolean;
    /**
     * 0.1.7：该行所属**预设声明行的 Loader 行 id**（如 `preset-standard-mcp`），
     * 作持久化与定位键（state.json mcp 段的第一级键）。
     * 反查不到时为 `''` —— 调用方按「不持久化」降级（绝不写 `''` 键）。
     */
    presetRowId: string;
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
 * preset id → 预设**声明行**的 Loader 行 id（如 `preset-standard-mcp`）。
 *
 * 0.1.7 没有「preset id → 声明行」的公开映射：声明行的 id 是 Loader 编辑地址，
 * `config.id` 才是会话保存的 preset 标识符（agent-preset README.zh.md:48）。
 * 这里按「config.id 相同」在**当前已加载的 profile 行**里反查，取首个命中。
 * 未命中返回 undefined（调用方走「不持久化」降级），不抛。
 */
export declare function presetDeclarationRowId(ctx: Context, presetId: string): string | undefined;
/**
 * 行 id（预设内的短 id，如 `mcp-filesystem`）→ 所属预设声明行的 Loader 行 id。
 *
 * 用在只知道 live 行、拿不到 presetId 的路径（toggleMcp 的 live/deferred 分支、
 * pending 的残留补齐、collect 的行意图读数）。判据是声明行 `config.plugins`
 * 里是否含该行 id：**恰好命中一处**才返回（多处命中=歧义，降级为 undefined，
 * 绝不猜——猜错会把 A 预设的意图写到 B 预设的声明行上）。
 */
export declare function presetDeclarationRowIdForRow(ctx: Context, rowId: string): string | undefined;
/**
 * 该 Loader 行 id 是否是**预设声明行**（声明插件行的 config 带 plugins 数组）。
 *
 * 用途：判断 state.json mcp 段的第一级键是否还是活的声明行 —— 0.1.5 的键是预设文件
 * 绝对路径（0.1.7 下找不到声明行），据此把旧键当死键忽略，不拿去猜行意图。
 */
export declare function isPresetDeclarationRow(ctx: Context, loaderRowId: string): boolean;
/**
 * 列出某 preset 在 standing 组合中的全部 MCP 行。
 * inventory 给 entryId/enabled/fiberState，声明文本（readDocument）给 serverName/transport/超时。
 */
export declare function listPresetMcpRows(ctx: Context, presetId: string): Promise<{
    rows: PresetMcpRow[];
    presetRowId: string;
}>;
/**
 * 按 entryId 反查其所属 preset 行（toggleMcp 预设兜底用）。
 * 逐 preset 找 entryId 命中，找到即 readDocument+parse 该 preset。
 */
export declare function findPresetRowByEntryId(ctx: Context, entryId: string): Promise<{
    presetId: string;
    row: PresetMcpRow;
    presetRowId: string;
} | undefined>;
