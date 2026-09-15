import { t as __exportAll } from "./rolldown-runtime-D7D4PA-g.mjs";
import { l as writeState, n as readState } from "./state-CGTco4Zg.mjs";
import { readFile, rename, writeFile } from "node:fs/promises";
//#region src/preset.ts
var preset_exports = /* @__PURE__ */ __exportAll({
	EDITABLE_CONFIG_KEYS: () => EDITABLE_CONFIG_KEYS,
	buildSkillMd: () => buildSkillMd,
	configKeysToYamlText: () => configKeysToYamlText,
	configSetToYaml: () => configSetToYaml,
	configValueToYaml: () => configValueToYaml,
	isValidSkillName: () => isValidSkillName,
	rowDisabledState: () => rowDisabledState,
	setRowConfigKeys: () => setRowConfigKeys,
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
/**
* 0.7.0：在组合文件中对 `- id: <rowId>` 行做**任意标量键**的设置/删除（通用版 setRowFlag）。
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
function setRowConfigKeys(text, rowId, set, remove = []) {
	const nl = lineSep(text);
	const lines = text.split(/\r?\n/);
	const rowRe = new RegExp(`^-\\s*id:\\s*${escapeRegExp(rowId)}\\s*$`);
	const idx = lines.findIndex((line) => rowRe.test(line));
	if (idx < 0) throw new Error(`row "- id: ${rowId}" not found in composition file`);
	const childIndent = (/^(\s*)/.exec(lines[idx])?.[1].length ?? 0) + 2;
	let end = idx + 1;
	while (end < lines.length && !/^-\s*id:/.test(lines[end])) end += 1;
	let configAt = -1;
	{
		const re = new RegExp(`^\\s{${childIndent}}config:\\s*$`);
		for (let i = idx + 1; i < end; i += 1) if (re.test(lines[i])) {
			configAt = i;
			break;
		}
	}
	/**
	* config 块的**直接子键缩进**（块内非空行取最小缩进）。
	* 教训：早先直接用 `childIndent + 2` 当键缩进并写成 `^\s{N}key:`，而 `\s{N}` 是
	* "恰好 N 个空白后紧跟 key" —— 该写法永远匹配不上真正的键行，导致每次都当新键
	* 插入（自测 ②「同键覆盖幂等」抓到的 bug）。取块内最小缩进才是稳健判定。
	*/
	const configKeyIndent = (from, limit) => {
		let min = -1;
		for (let i = from + 1; i < limit; i += 1) {
			const line = lines[i];
			if (line.trim().length === 0) continue;
			const indent = /^(\s*)/.exec(line)?.[1].length ?? 0;
			if (indent <= childIndent) break;
			if (min < 0 || indent < min) min = indent;
		}
		return min < 0 ? childIndent + 2 : min;
	};
	/** 在 config 块内按**直接子键**精确命中 `key:` 行（不做深度匹配，避免误伤嵌套同名键）。 */
	const findKey = (key, from, limit, keyIndent) => {
		const re = new RegExp(`^\\s{${keyIndent}}${escapeRegExp(key)}:`);
		for (let i = from + 1; i < limit; i += 1) {
			const line = lines[i];
			if (line.trim().length === 0) continue;
			const indent = /^(\s*)/.exec(line)?.[1].length ?? 0;
			if (indent <= childIndent) break;
			if (indent === keyIndent && re.test(line)) return i;
		}
		return -1;
	};
	/**
	* 一个键的**值区间**占几行：标题行 + 其后所有更深缩进的续行
	* （块映射 / 块序列 / 块标量的子行都属于这个键）。
	*
	* 2026-09-15 实测事故：早先覆盖时只替换标题行，`env:` 的 4 行块映射被遗留成孤儿 ——
	*   env: { MIMO_API_KEY: ... }      ← 新写的单行 flow
	*     MIMO_API_KEY: !!js "..."      ← 旧子行没人管
	* 整个组合文件就此变成非法 YAML（`bad indentation of a mapping entry (389:7)`），
	* 预设挂载失败 → 所有旧会话 resume 报错、新会话也建不出来。
	* 覆盖/删除都必须连着值区间一起动。
	*/
	const keyValueSpan = (at, limit, keyIndent) => {
		let span = 1;
		let i = at + 1;
		while (i < limit) {
			if (lines[i].trim().length === 0) {
				let j = i;
				while (j < limit && lines[j].trim().length === 0) j += 1;
				if (j >= limit) break;
				if ((/^(\s*)/.exec(lines[j])?.[1].length ?? 0) <= keyIndent) break;
				span += j - i;
				i = j;
				continue;
			}
			if ((/^(\s*)/.exec(lines[i])?.[1].length ?? 0) <= keyIndent) break;
			span += 1;
			i += 1;
		}
		return span;
	};
	/** config 块的最后一个内容行之后（空行不并入，避免把新键插到块外）。 */
	function configBlockEnd(from, limit) {
		let last = from + 1;
		for (let i = from + 1; i < limit; i += 1) {
			const line = lines[i];
			if (line.trim().length === 0) continue;
			if ((/^(\s*)/.exec(line)?.[1].length ?? 0) <= childIndent) break;
			last = i + 1;
		}
		return last;
	}
	if (configAt >= 0) for (const key of remove) {
		const blockEnd = configBlockEnd(configAt, end);
		const keyIndent = configKeyIndent(configAt, blockEnd);
		const at = findKey(key, configAt, blockEnd, keyIndent);
		if (at < 0) continue;
		const span = keyValueSpan(at, blockEnd, keyIndent);
		lines.splice(at, span);
		end -= span;
	}
	for (const [key, value] of Object.entries(set)) if (configAt >= 0) {
		const blockEnd = configBlockEnd(configAt, end);
		const keyIndent = configKeyIndent(configAt, blockEnd);
		const at = findKey(key, configAt, blockEnd, keyIndent);
		const line = `${" ".repeat(keyIndent)}${key}: ${value}`;
		if (at >= 0) {
			const span = keyValueSpan(at, blockEnd, keyIndent);
			lines.splice(at, span, line);
			end += 1 - span;
		} else {
			lines.splice(blockEnd, 0, line);
			end += 1;
		}
	} else {
		let lastContent = idx;
		for (let i = idx + 1; i < end; i += 1) if (lines[i].trim().length > 0) lastContent = i;
		lines.splice(lastContent + 1, 0, `${" ".repeat(childIndent)}config:`, `${" ".repeat(childIndent + 2)}${key}: ${value}`);
		end += 2;
		configAt = lastContent + 1;
	}
	return lines.join(nl);
}
/** 允许通过面板编辑的挂载配置键（与 mcp-convert.ts 的挂载形态一致）。 */
const EDITABLE_CONFIG_KEYS = [
	"transport",
	"command",
	"args",
	"env",
	"cwd",
	"url",
	"headers",
	"toolCallTimeoutMs",
	"failOnStartupError"
];
/**
* 未转义的普通标量可直接裸写的字符集。
* 首字符另有限制：不能是 `- ? : , [ ] { } # & * ! | > ' " % @ \`` 等 YAML 指示符开头
* （如 `--mcp` 会被当成块序列指示符的歧义区），这类一律加引号 ——
* 与预设里既有写法一致（`args: ['serve', '--mcp']`）。
*/
const PLAIN_SCALAR = /^[A-Za-z0-9_./\\:-]+$/;
const SAFE_FIRST = /^[A-Za-z0-9_./\\]/;
/**
* 裸写后会被解析成**非字符串**的标量形态。
*
* 预设组合按 `yaml.JSON_SCHEMA.extend(!!js)` 解析（cordis-plugin-include 的
* entryListSchema），于是 `300` 是 number、`true` 是 boolean、`~` 是 null、
* `.inf` 是 Infinity。env 这类值必须是字符串，裸写会**静默改类型**
* （实测：原始 `MIMO_TIMEOUT: '300'` 被物化成 `300`）。
* JSON_SCHEMA 不认 YAML 1.1 的 `yes/no/on/off`（实测仍为字符串），故无需为其加引号。
*/
const NON_STRING_SCALAR = /^(?:~|true|false|null|[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?|[-+]?0[xX][0-9a-fA-F]+|[-+]?0[oO][0-7]+|[-+]?0[bB][01]+|[-+]?\.(?:inf|nan))$/i;
/** 运行态的 `!!js` 表达式载体（cordis-plugin-include 的 construct 产物）。 */
function isJsExprObject(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value) && typeof value.__jsExpr === "string";
}
/**
* 0.7.0：把配置值序列化成**单行 YAML**（写入预设文件用）。
*
* 保守策略：只在确认安全时才裸写，其余一律单引号包裹（YAML 单引号里 `'` 需写成 `''`）。
* 数组/对象用 flow 风格（与预设里既有的 `args: ['serve', '--mcp']` 一致）。
* `!!js` 表达式写回**标签形态**（与 dsh 自己的 `represent` 一致），不退化成
* `{ __jsExpr: ... }`：两者求值等价（`interpolate` 认 `__jsExpr` 键），但标签形态
* 保住文件原有写法，改配置不会把用户的表达式写成另一种方言。
*/
function configValueToYaml(value) {
	if (typeof value === "boolean" || typeof value === "number") return String(value);
	if (isJsExprObject(value)) return `!!js ${JSON.stringify(value.__jsExpr)}`;
	if (Array.isArray(value)) return `[${value.map((v) => configValueToYaml(v)).join(", ")}]`;
	if (value !== null && typeof value === "object") return `{ ${Object.entries(value).map(([k, v]) => `${k}: ${configValueToYaml(v)}`).join(", ")} }`;
	const s = String(value ?? "");
	if (s.length > 0 && PLAIN_SCALAR.test(s) && SAFE_FIRST.test(s) && !NON_STRING_SCALAR.test(s)) return s;
	return `'${s.replace(/'/g, "''")}'`;
}
/** 把一组配置键/值转成 setRowConfigKeys 需要的「已序列化标量」形态。 */
function configSetToYaml(set) {
	const out = {};
	for (const [k, v] of Object.entries(set)) out[k] = configValueToYaml(v);
	return out;
}
/** 把配置对象转成用于"是否已物化"比对的稳定文本（键排序，避免顺序抖动导致重复写）。 */
function configKeysToYamlText(config) {
	return Object.keys(config).sort().map((k) => `${k}: ${configValueToYaml(config[k])}`).join("\n");
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
			let lastApplied = entry.lastApplied;
			if (cur !== entry.lastApplied) {
				lastApplied = cur;
				ctx.logger.info?.(`mcp-skill-panel: preset row ${rowId} externally modified (disabled ${String(entry.lastApplied)} → ${String(cur)}); keeping desired=${String(entry.desired)}, still materializing config`);
			} else {
				if (cur === true !== entry.desired) try {
					text = setRowFlag(text, rowId, "disabled", entry.desired);
					changed = true;
					materialized += 1;
				} catch {
					continue;
				}
				lastApplied = entry.desired;
			}
			let configAppliedYaml = entry.configAppliedYaml;
			if (entry.config && Object.keys(entry.config).length > 0) {
				const yamlText = configKeysToYamlText(entry.config);
				if (yamlText !== entry.configAppliedYaml) try {
					text = setRowConfigKeys(text, rowId, configSetToYaml(entry.config));
					changed = true;
					materialized += 1;
					configAppliedYaml = yamlText;
				} catch {}
			}
			next[rowId] = {
				desired: entry.desired,
				lastApplied,
				config: entry.config,
				configAppliedYaml
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
export { rowDisabledState as a, syncPresetFiles as c, preset_exports as i, buildSkillMd as n, setRowFlag as o, isValidSkillName as r, setSkillFlag as s, EDITABLE_CONFIG_KEYS as t };
