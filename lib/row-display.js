//#region src/row-display.ts
/** 行状态徽标判定（纯函数，selftest 表驱动回归）。
* 语义（2026-08-27 发布前独立审查修正）：active/idle 以 **liveTools**（真实注册）
* 为准——displayTools 含 catalog 快照兜底，用它判定 active 会掩盖「scope 解析
* 失败但 catalog 有旧快照」的故障现场（面板显示健康而实际工具未注册）。
* displayTools 仅用于 tools/tokens 数值展示与停用态回填。
*/
function computeStatus(disabled, running, liveTools) {
	if (disabled) return "disabled";
	if (!running) return "failed";
	return liveTools > 0 ? "active" : "idle";
}
/** 展示用读数判定（0.6.0 诚实上报；纯函数，selftest 表驱动回归）。
*
* 与 computeStatus 的区别：这里决定 tools/tokens **显示什么数字**。
* 此前两条路径都写成 `liveTools > 0 ? liveTools : catalogInfo?.tools.length ?? 0`，
* 于是「行启用且在跑、却一个工具都没注册」的故障现场被目录快照伪装成健康
* （2026-09-13 实测 codegraph：缺 `.codegraph` 索引 → 子进程空转零注册，
* 面板却渲染 running=true/tools=4，而 Host 注册表 mcp__* = 0，mcp_call 60s 超时）。
*
* 现在：**启用 + 在跑 + liveTools=0 → unregistered=true 且 tools=0**（不再回落目录快照），
* 目录快照只回落到 `toolList`（工具级禁用 UI 仍可用）。停用行照旧回落快照，
* 保留「该 server 有哪些工具可被 mcp_search 检索」的语义。
*/
function rowDisplay(disabled, running, liveTools, catalogTools) {
	const unregistered = !disabled && running && liveTools <= 0;
	if (unregistered) return {
		displayTools: 0,
		unregistered
	};
	return {
		displayTools: liveTools > 0 ? liveTools : catalogTools,
		unregistered
	};
}
/** 模型面可见性作用域判定（0.6.0 收口；纯函数，selftest 表驱动回归）。
*
* 起因（发布前独立审查 cbc-W1）：`modelVisible` 只扣「AI 临时启用」，**不扣**
* `middleLayerHides === 'all'` —— 而装配过滤在 `gate.on && gate.hideAll` 时把该
* server 的工具**全部**剔除（`filter.ts`）。于是 `'all'` + 本会话 gate 打开时，
* 卡片仍挂「模型可见」，与本次装配结果相反（同类失真本批已在能力摘要表
* `buildSummaryHeader` 上修过，行徽标漏了）。
*
* @param disabled - 该行是否停用（停用行不进装配）。
* @param aiOwned - 该行是否正被 AI 经 dsh_mcp_call 临时启用保活（对模型不可见）。
* @param hideAllActive - 中间层生效且隐藏范围为 `'all'`（等价于 filter.ts 的 `gate.on && gate.hideAll`）。
* @returns `'direct'`（进本次装配）/ `'via-middle-layer'`（不进装配，改经中间层取用）/ `'hidden'`。
*/
function modelVisibleScope(disabled, aiOwned, hideAllActive) {
	if (disabled || aiOwned) return "hidden";
	return hideAllActive ? "via-middle-layer" : "direct";
}
//#endregion
export { computeStatus, modelVisibleScope, rowDisplay };
