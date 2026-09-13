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
/** 展示用读数判定（0.7.1 诚实上报；纯函数，selftest 表驱动回归）。
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
//#endregion
export { computeStatus, rowDisplay };
