/**
 * 行级读数判定（纯函数；**零宿主依赖**，可独立 selftest）。
 *
 * 从 collect.ts 拆出（0.7.1）：这两个函数决定面板卡片的徽标与 tools/tokens 数字，
 * 是「故障现场有没有被目录快照伪装成健康」的唯一判据 —— 放在 collect.ts 里时，
 * selftest 必须 import 整个包入口，而入口会连带加载 @deepseek-ai/* 宿主包
 * （仓库 node_modules 侧不完整 → ERR_MODULE_NOT_FOUND：@deepseek-ai/dsh-home-paths，
 * 经 dsh-agent-presets 传入），于是这两条最该被回归护栏盯住的纯逻辑反而测不到。
 *
 * 拆出后：产物 lib/row-display-*.mjs 无任何 import，selftest 可直接加载。
 */
import type { McpRow } from './shared-types'

/** 行状态徽标判定（纯函数，selftest 表驱动回归）。
 * 语义（2026-08-27 发布前独立审查修正）：active/idle 以 **liveTools**（真实注册）
 * 为准——displayTools 含 catalog 快照兜底，用它判定 active 会掩盖「scope 解析
 * 失败但 catalog 有旧快照」的故障现场（面板显示健康而实际工具未注册）。
 * displayTools 仅用于 tools/tokens 数值展示与停用态回填。
 */
export function computeStatus(disabled: boolean, running: boolean, liveTools: number): McpRow['status'] {
  if (disabled) return 'disabled'
  if (!running) return 'failed'
  return liveTools > 0 ? 'active' : 'idle'
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
export function rowDisplay(
  disabled: boolean,
  running: boolean,
  liveTools: number,
  catalogTools: number,
): { displayTools: number; unregistered: boolean } {
  const unregistered = !disabled && running && liveTools <= 0
  if (unregistered) return { displayTools: 0, unregistered }
  return { displayTools: liveTools > 0 ? liveTools : catalogTools, unregistered }
}
