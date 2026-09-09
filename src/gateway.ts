/**
 * 网关常驻 standing 隔离挂载（P4）。
 *
 * MVT-4/5 已验证配方（`.scratch/mvt-4-gateway.mjs:85-150` /
 * `.scratch/mvt-5-live.mjs:13-86`）的产品化：
 * - 常驻层：open 的 MCP 经 `resolvePresetConfig` 全量配置自托管拉起
 *   dsh-mcp-client（与 preset 官方行同 serverName 互斥：官方行启用时网关
 *   让路，见 ensureOpenMounts）；
 * - 隔离层：子 scope `restrict({ deny: [...] })` 滤掉继承面全部 `mcp__*`，
 *   own 层只留模型面双工具（`installMcpControlTools` 已在插件 ctx 注册，
 *   本模块只负责 deny 视野隔离 + 自检断言）。
 *
 * 红线：
 * - 绝不手动 dispose standing/own（靠 fiber unwind；#1079 旧代指针教训）；
 * - 绝不在运行时写预设文件（事故 5.1 铁律；意图链 routes/pending/preset 不动）；
 * - secrets 不回面板（BLOCK-2；config 只在 host 侧流转）。
 */
import type { Context } from '@deepseek-ai/cordis'
import { messageOf } from './util'

/** 网关挂载态（常驻，随 autoManage 开关创建/释放）。 */
export interface GatewayState {
  /** restrict 返回的 disposer（逐个 lift 可回滚）。 */
  restrictDisposers: Array<() => void>
  /** 当前网关拉起的 server（serverName → mount 时间）。 */
  mounts: Map<string, number>
  /** 最近一次自检结果（/debug 可读，面板不展示 secrets）。 */
  lastCheck: { at: number; ok: boolean; detail: string } | null
}

/** 空网关态。 */
export function createGatewayState(): GatewayState {
  return { restrictDisposers: [], mounts: new Map(), lastCheck: null }
}

/**
 * 子 scope 视野隔离：在给定 tools 服务上 deny 除双工具外的全部继承 `mcp__*` 名。
 * deny 表调用方传入（动态表：`view(standingKey).visible` 快照，见 MVT-5 R3-2）。
 * 未知名按 dsh-tools 语义抛错——调用方须只传已知 global 名（MVT-4 R2-2）。
 */
export function isolateChildScope(
  childTools: { restrict(filter: { deny: string[] }): () => void },
  inheritMcpNames: string[],
): () => void {
  return childTools.restrict({ deny: [...inheritMcpNames] })
}

/**
 * open 行网关挂载决策（纯逻辑，可自测）：
 * - preset 行缺失/不可挂载（config undefined）→ 'skip'（回退旧直通语义）；
 * - preset 行 disabled → 'skip'（拒绝语义归 gatewayCall，前置已判定）；
 * - 已有同名 mount → 'reuse'（防 #3984 `already in use` / #4798 重复注册）；
 * - 否则 'mount'。
 */
export function decideMount(
  serverName: string,
  presetConfig: { serverName: string } | undefined,
  presetDisabled: boolean,
  mounted: ReadonlyMap<string, number>,
): 'mount' | 'reuse' | 'skip' {
  if (!presetConfig) return 'skip'
  if (presetDisabled) return 'skip'
  if (mounted.has(serverName)) return 'reuse'
  return 'mount'
}

/**
 * 网关自检断言（MVT-4 ASSERT-A/A2 产品化）：child 可见面恒为双工具。
 * 纯逻辑：visible 名单由调用方传入（`tools.view(childKey).visible.keys()`），
 * 本函数只做集合比对，不碰运行时。
 */
export function checkChildVisible(visibleNames: readonly string[]): { ok: boolean; detail: string } {
  const sorted = [...visibleNames].sort()
  const ok = sorted.length === 2 && sorted[0] === 'mcp_call' && sorted[1] === 'mcp_search'
  return {
    ok,
    detail: ok ? 'child visible == [mcp_call, mcp_search]' : `child visible unexpected: ${JSON.stringify(sorted)}`,
  }
}

/** 释放网关挂载态：restrict disposer 逐个 lift + 清 mounts（不碰 standing 本体）。 */
export function disposeGatewayState(ctx: Context, state: GatewayState): void {
  for (const dispose of state.restrictDisposers.splice(0)) {
    try {
      dispose()
    } catch (error) {
      ctx.logger.warn?.(`mcp-skill-panel: gateway restrict lift failed: ${messageOf(error)}`)
    }
  }
  state.mounts.clear()
}
