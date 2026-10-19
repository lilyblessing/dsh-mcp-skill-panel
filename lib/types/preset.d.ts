/**
 * 预设组合的文本操作与启停意图物化。
 *
 * 0.1.7（2026-09-24）：预设改为**声明式**（一条 preset = 一条 declaration 行），
 * 没有独立的 agent.cordis.yml 可写 —— 因此物化目标从「预设组合文件」改为
 * **profile patch 的声明行 config**，且一律走官方写入面 `ctx.configEditor.edit`
 *（自带文件锁 + 原子写 + reconcileProfilePatches 热重载，官方 settings 即此法）。
 * 历史理由（已失效）：旧包用 `{mtimeMs,size}` stamp 检测预设文件变化，运行期写该
 * 文件会触发 standing 重挂而旧实例不清理 → 当时的对策是「只在启动早期、无会话时写文件」。
 * 现对策：**不直接写盘**，交给 configEditor（写盘 + 重挂由它按代际语义处理）。
 * 本模块的其余部分仍是纯文本操作，可被 selftest 覆盖（setRowFlag / setRowConfigKeys /
 * rowDisabledState 保留为纯函数与自测目标，0.1.7 起不再被 syncPresetFiles 调用）。
 */
import type { Context } from '@deepseek-ai/cordis';
/**
 * 在组合文件中对 `- id: <rowId>` 行做 `  <key>: <value>` 标记的插入/移除。
 * 逐行文本编辑，保留注释与 !!js 表达式原样（loader 的 yaml.dump 会丢注释，故不用）。
 *
 * 语义（2026-08-27 修复）：value=true 保证标记存在且为 true（已有 false 时反转）；
 * value=false 移除标记。此前 value=true 遇到已存在的 `disabled: false` 会原样返回
 * （只支持插入/删除不支持反转），导致物化失败后 lastApplied 与文件脱节，
 * 下次启动被误判「外部修改」而删掉 state 条目（obsidian 设置丢失事故）。
 */
export declare function setRowFlag(text: string, rowId: string, key: string, value: boolean): string;
/**
 * 0.6.0：在组合文件中对 `- id: <rowId>` 行做**任意标量键**的设置/删除（通用版 setRowFlag）。
 *
 * 为什么必须是文本编辑而不是 yaml.dump：预设文件里允许 `!!js` 表达式与注释，
 * dump 会丢掉它们（setRowFlag 的注释已记录这条）。
 *
 * 关键语义：**只改 config: 块内的同名键**，不碰行级键（disabled/name 等）。
 * 早先实现曾把 config 块挂到行级，本函数按缩进判别：
 *   - config: 行缩进记为 base；
 *   - 子键缩进 > base 即认为属于 config 块；
 *   - 键是标量（单行 `key: value`）才替换，多行值（`|` / 嵌套 map）保守跳过并报错，
 *     避免把用户的复杂配置改坏。
 *
 * @param set 要写入/覆盖的键（值须已序列化为 YAML 标量文本）
 * @param remove 要删除的键
 */
export declare function setRowConfigKeys(text: string, rowId: string, set: Record<string, string>, remove?: string[]): string;
/** 允许通过面板编辑的挂载配置键（与 mcp-convert.ts 的挂载形态一致）。 */
export declare const EDITABLE_CONFIG_KEYS: readonly ["transport", "command", "args", "env", "cwd", "url", "headers", "toolCallTimeoutMs", "failOnStartupError"];
/**
 * 0.6.0：把配置值序列化成**单行 YAML**（写入预设文件用）。
 *
 * 保守策略：只在确认安全时才裸写，其余一律单引号包裹（YAML 单引号里 `'` 需写成 `''`）。
 * 数组/对象用 flow 风格（与预设里既有的 `args: ['serve', '--mcp']` 一致）。
 * `!!js` 表达式写回**标签形态**（与 dsh 自己的 `represent` 一致），不退化成
 * `{ __jsExpr: ... }`：两者求值等价（`interpolate` 认 `__jsExpr` 键），但标签形态
 * 保住文件原有写法，改配置不会把用户的表达式写成另一种方言。
 */
export declare function configValueToYaml(value: unknown): string;
/** 把一组配置键/值转成 setRowConfigKeys 需要的「已序列化标量」形态。 */
export declare function configSetToYaml(set: Record<string, unknown>): Record<string, string>;
/** 把配置对象转成用于"是否已物化"比对的稳定文本（键排序，避免顺序抖动导致重复写）。 */
export declare function configKeysToYamlText(config: Record<string, unknown>): string;
/** SKILL.md frontmatter 的 disable-model-invocation 键注入/移除（kebab-case 是唯一合法形式）。 */
export declare function setSkillFlag(text: string, value: boolean): string;
/** skill 名是否合法（kebab-case，前端预校验与后端落盘共用）。 */
export declare function isValidSkillName(name: string): boolean;
/**
 * 生成 SKILL.md 文本：frontmatter（name/description）+ 正文。
 * description 用 JSON 双引号标量（合法 YAML，冒号/换行安全）；正文原样保留。
 */
export declare function buildSkillMd(name: string, description: string, body: string): string;
/** 读取某行当前是否带 disabled: true（true/false/null=无标记）。 */
export declare function rowDisabledState(text: string, rowId: string): boolean | null;
/**
 * 0.1.7 启动早期物化：把 state.json 的 MCP 启停/配置意图写进 **profile patch 的预设声明行**。
 *
 * 走官方写入面 `ctx.configEditor.edit`（config-editor：文件锁 + 原子写 +
 * reconcileProfilePatches 热重载；官方 settings 即此法）。声明式预设没有独立文件，
 * 故 state.mcp 的第一级键 = **预设声明行的 Loader 行 id**；找不到该声明行（含 0.1.5
 * 遗留的「预设文件路径」键）→ 跳过该键（死键不迁移、不猜）。
 *
 * 幂等（0.1.7 新增）：目标 `disabled` 与目标 config 键都已一致时**不调用 edit** ——
 * 每次 edit 都会触发该声明行的 reconcile/重挂，无谓的重挂正是要避免的事故形态
 *（W0 报告 §5-2 P10 护栏）。非 profile 场合（无 configEditor 服务）不写盘，返回 0。
 */
export declare function syncPresetFiles(ctx: Context): Promise<number>;
