import { t as __exportAll } from "./rolldown-runtime-D7D4PA-g.mjs";
import { n as readState, o as writeState } from "./state-Bo1YB6hJ.mjs";
import { readFile, rename, writeFile } from "node:fs/promises";
//#region src/preset.ts
var preset_exports = /* @__PURE__ */ __exportAll({
	buildSkillMd: () => buildSkillMd,
	isValidSkillName: () => isValidSkillName,
	rowDisabledState: () => rowDisabledState,
	setRowFlag: () => setRowFlag,
	setSkillFlag: () => setSkillFlag,
	syncPresetFiles: () => syncPresetFiles
});
const DISABLE_KEY = "disable-model-invocation";
function escapeRegExp(value) {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
/** 新行分隔符：跟随原文件。 */
function lineSep(text) {
	return text.includes("\r\n") ? "\r\n" : "\n";
}
/**
* 在组合文件中对 `- id: <rowId>` 行做 `  <key>: <value>` 标记的插入/移除。
* 逐行文本编辑，保留注释与 !!js 表达式原样（loader 的 yaml.dump 会丢注释，故不用）。
*
* 语义（2026-08-27 修复）：value=true 保证标记存在且为 true（已有 false 时反转）；
* value=false 移除标记。此前 value=true 遇到已存在的 `disabled: false` 会原样返回
* （只支持插入/删除不支持反转），导致物化失败后 lastApplied 与文件脱节，
* 下次启动被误判「外部修改」而删掉 state 条目（obsidian 设置丢失事故）。
*/
function setRowFlag(text, rowId, key, value) {
	const nl = lineSep(text);
	const lines = text.split(/\r?\n/);
	const rowRe = new RegExp(`^-\\s*id:\\s*${escapeRegExp(rowId)}\\s*$`);
	const idx = lines.findIndex((line) => rowRe.test(line));
	if (idx < 0) throw new Error(`row "- id: ${rowId}" not found in composition file`);
	let end = idx + 1;
	while (end < lines.length && !/^-\s*id:/.test(lines[end])) end += 1;
	const block = lines.slice(idx, end);
	const flagRe = new RegExp(`^\\s*${escapeRegExp(key)}:\\s*(true|false)\\s*$`);
	const flagAt = block.findIndex((line) => flagRe.test(line));
	if (flagAt >= 0) {
		if (value) {
			if (/:\s*false\s*$/.test(block[flagAt])) {
				lines.splice(idx + flagAt, 1, `  ${key}: true`);
				return lines.join(nl);
			}
			return text;
		}
		lines.splice(idx + flagAt, 1);
		return lines.join(nl);
	}
	if (value) {
		lines.splice(idx + 1, 0, `  ${key}: true`);
		return lines.join(nl);
	}
	return text;
}
/** SKILL.md frontmatter 的 disable-model-invocation 键注入/移除（kebab-case 是唯一合法形式）。 */
function setSkillFlag(text, value) {
	lineSep(text);
	const has = new RegExp(`^${DISABLE_KEY}:\\s*true\\s*$`, "m").test(text);
	if (value && !has) {
		const m = /^---\s*(\r?\n)/.exec(text);
		if (!m) return text;
		return `---${m[1]}${DISABLE_KEY}: true${m[1]}${text.slice(m[0].length)}`;
	}
	if (!value && has) return text.replace(new RegExp(`^\\s*${DISABLE_KEY}:\\s*true\\s*\\r?\\n?`, "m"), "");
	return text;
}
/** dsh-skill-filesystem 的 skill 名约束：kebab-case（非合法名会被发现层丢弃）。 */
const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** skill 名是否合法（kebab-case，前端预校验与后端落盘共用）。 */
function isValidSkillName(name) {
	return SKILL_NAME_PATTERN.test(name);
}
/**
* 生成 SKILL.md 文本：frontmatter（name/description）+ 正文。
* description 用 JSON 双引号标量（合法 YAML，冒号/换行安全）；正文原样保留。
*/
function buildSkillMd(name, description, body) {
	const nl = "\n";
	return `---${nl}name: ${name}${nl}description: ${JSON.stringify(description)}${nl}---${nl}${nl}${body.replace(/\s+$/, "")}${nl}`;
}
/** 读取某行当前是否带 disabled: true（true/false/null=无标记）。 */
function rowDisabledState(text, rowId) {
	const lines = text.split(/\r?\n/);
	const rowRe = new RegExp(`^-\\s*id:\\s*${escapeRegExp(rowId)}\\s*$`);
	const idx = lines.findIndex((line) => rowRe.test(line));
	if (idx < 0) return null;
	let end = idx + 1;
	while (end < lines.length && !/^-\s*id:/.test(lines[end])) end += 1;
	const flagLine = lines.slice(idx, end).find((line) => /^\s*disabled:\s*(true|false)\s*$/.test(line));
	if (!flagLine) return null;
	return /:\s*true\s*$/.test(flagLine);
}
/**
* 启动早期物化：把状态文件里的 MCP 启停意图写入预设组合文件。
* 只在「没有任何 agent 在跑」时执行 —— 有会话时写文件会触发
* dsh-agent-presets 的 stamp 重挂（旧实例不 dispose → serverName 冲突事故）。
*/
async function syncPresetFiles(ctx) {
	if (ctx.agents.list().length > 0) return 0;
	const state = await readState();
	const mcp = state.mcp;
	if (!mcp || Object.keys(mcp).length === 0) return 0;
	let materialized = 0;
	for (const [file, rows] of Object.entries(mcp)) {
		let text;
		try {
			text = await readFile(file, "utf8");
		} catch {
			continue;
		}
		let changed = false;
		const next = {};
		for (const [rowId, entry] of Object.entries(rows)) {
			const cur = rowDisabledState(text, rowId);
			if (cur !== entry.lastApplied) {
				next[rowId] = {
					desired: entry.desired,
					lastApplied: cur
				};
				continue;
			}
			if (cur === true !== entry.desired) try {
				text = setRowFlag(text, rowId, "disabled", entry.desired);
				changed = true;
				materialized += 1;
			} catch {
				continue;
			}
			next[rowId] = {
				desired: entry.desired,
				lastApplied: entry.desired
			};
		}
		if (changed) {
			const tmp = `${file}.tmp`;
			await writeFile(tmp, text, "utf8");
			await rename(tmp, file);
		}
		mcp[file] = next;
	}
	await writeState(state);
	return materialized;
}
//#endregion
export { setRowFlag as a, rowDisabledState as i, isValidSkillName as n, setSkillFlag as o, preset_exports as r, syncPresetFiles as s, buildSkillMd as t };
