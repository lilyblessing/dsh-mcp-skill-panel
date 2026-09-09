import { t as __exportAll } from "./rolldown-runtime-D7D4PA-g.mjs";
import { homedir } from "node:os";
import { join } from "node:path";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
//#region src/state.ts
/**
* state.json 持久化（~/.dsh/dsh-mcp-skill-panel/state.json）。
*
* 存放 MCP 行启停意图（mcp 段）、AI 临时启用标记（ai 段）与面板配置（config 段）。
* 内存态 + 写队列合并（P1-4）：启动加载一次，高频写（mcp_call 连击的 ai 标记）
* 串行合并落盘，避免每次读+写各一次文件 IO。
*/
var state_exports = /* @__PURE__ */ __exportAll({
	clearStateAiOwner: () => clearStateAiOwner,
	readState: () => readState,
	setStateAiOwner: () => setStateAiOwner,
	stateApplyMode: () => stateApplyMode,
	writeState: () => writeState
});
const LEGACY_STATE_DIR = join(homedir(), ".dsh", "dsh-runtime-inventory");
const STATE_DIR = join(homedir(), ".dsh", "dsh-mcp-skill-panel");
const STATE_FILE = join(STATE_DIR, "state.json");
/** 当前生效时机（缺省 immediate）。 */
function stateApplyMode(state) {
	return state.config?.applyMode === "next-session" ? "next-session" : "immediate";
}
let stateCache = null;
let stateDirty = false;
let stateWriteChain = Promise.resolve();
async function readState() {
	if (stateCache) return stateCache;
	let parsed;
	try {
		parsed = JSON.parse(await readFile(STATE_FILE, "utf8"));
	} catch {
		try {
			const legacy = join(LEGACY_STATE_DIR, "state.json");
			const text = await readFile(legacy, "utf8");
			await mkdir(STATE_DIR, { recursive: true });
			await rename(legacy, STATE_FILE);
			parsed = JSON.parse(text);
		} catch {
			parsed = {};
		}
	}
	stateCache = parsed;
	return parsed;
}
async function writeState(state) {
	stateCache = state;
	stateDirty = true;
	stateWriteChain = stateWriteChain.catch(() => {}).then(async () => {
		if (!stateDirty) return;
		stateDirty = false;
		const current = stateCache ?? state;
		await mkdir(STATE_DIR, { recursive: true });
		await writeFile(`${STATE_FILE}.tmp`, JSON.stringify(current, null, 2), "utf8");
		await rename(`${STATE_FILE}.tmp`, STATE_FILE);
	});
	await stateWriteChain;
}
/** AI-owner 标记读写：state.json 的 ai 段（entryId → {at}）。 */
async function setStateAiOwner(entryId, at) {
	const state = await readState();
	state.ai ??= {};
	state.ai[entryId] = { at };
	await writeState(state);
}
async function clearStateAiOwner(entryId) {
	const state = await readState();
	if (!state.ai || !(entryId in state.ai)) return;
	delete state.ai[entryId];
	await writeState(state);
}
//#endregion
export { state_exports as a, stateApplyMode as i, readState as n, writeState as o, setStateAiOwner as r, clearStateAiOwner as t };
