/**
 * 预设组合文件的文本操作与启停意图物化。
 *
 * 运行期禁止写 agent.cordis.yml（dsh-agent-presets 的 {mtimeMs,size} stamp 检测会
 * 触发 standing 重挂事故），因此 toggle 只写 state.json，由 syncPresetFiles 在
 * 插件 apply（启动早期、standing 未挂载）时物化到预设文件 —— 此时写文件安全。
 * 本模块为纯文本操作，可被 selftest 覆盖。
 */
import type { Context } from '@deepseek-ai/cordis';
/**
 * 在组合文件中对 `- id: <rowId>` 行做 `  <key>: <value>` 标记的插入/移除。
 * 逐行文本编辑，保留注释与 !!js 表达式原样（loader 的 yaml.dump 会丢注释，故不用）。
 */
export declare function setRowFlag(text: string, rowId: string, key: string, value: boolean): string;
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
 * 启动早期物化：把状态文件里的 MCP 启停意图写入预设组合文件。
 * 只在「没有任何 agent 在跑」时执行 —— 有会话时写文件会触发
 * dsh-agent-presets 的 stamp 重挂（旧实例不 dispose → serverName 冲突事故）。
 */
export declare function syncPresetFiles(ctx: Context): Promise<number>;
