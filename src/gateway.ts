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
import type { McpControlCtx } from './mcpcall'
import { messageOf } from './util'

/** 网关行 entryId 前缀（连字符；冒号是 EntryTree.sep 不可用，见 B4）。 */
export const GATEWAY_ENTRY_PREFIX = 'gw-mcp-'

/** 网关行 entryId ↔ serverName 双向映射（B4 三键落字）。 */
export function gatewayEntryId(serverName: string): string {
  return `${GATEWAY_ENTRY_PREFIX}${serverName}`
}

export function gatewayServerOfEntryId(entryId: string): string | null {
  if (!entryId.startsWith(GATEWAY_ENTRY_PREFIX)) return null
  return entryId.slice(GATEWAY_ENTRY_PREFIX.length)
}

/** 网关挂载态（常驻，随 autoManage 开关创建/释放）。 */
export interface GatewayState {
  /** restrict 返回的 disposer（逐个 lift 可回滚）。 */
  restrictDisposers: Array<() => void>
  /** 当前网关拉起的 server（serverName → mount 时间）。 */
  mounts: Map<string, number>
  /** serverName → loader entryId（B2：卸载逐个 loader.remove 用）。 */
  entryIds: Map<string, string>
  /** 最近一次自检结果（/debug 可读，面板不展示 secrets）。 */
  lastCheck: { at: number; ok: boolean; detail: string } | null
  /** 并发 guard：ensureOpenMounts 单飞（W3）。 */
  syncing: boolean
}

/** 空网关态。 */
export function createGatewayState(): GatewayState {
  return { restrictDisposers: [], mounts: new Map(), entryIds: new Map(), lastCheck: null, syncing: false }
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
 * - loader 已有同名 server 行（官方行/项目行/global 行启用中，网关让路）→ 'skip-official'
 *  （B3：rc.1 下 standing 行不在 loader.entries，判据=loader 同 serverName 行存在；
 *   standing 行与网关行是否同 scope 抛错互斥未经现网实证，不假设——让路即不建第二实例）；
 * - 已有同名 mount → 'reuse'（防 #3984 `already in use` / #4798 重复注册）；
 * - 否则 'mount'。
 */
export function decideMount(
  serverName: string,
  presetConfig: { serverName: string } | undefined,
  presetDisabled: boolean,
  mounted: ReadonlyMap<string, number>,
  hasLoaderRow = false,
): 'mount' | 'reuse' | 'skip' | 'skip-official' {
  if (!presetConfig) return 'skip'
  if (presetDisabled) return 'skip'
  if (hasLoaderRow) return 'skip-official'
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

/** 释放网关挂载态：restrict disposer 逐个 lift + loader gw- 行逐个 remove + 清 mounts（B2）。 */
export function disposeGatewayState(ctx: Context, state: GatewayState): void {
  for (const dispose of state.restrictDisposers.splice(0)) {
    try {
      dispose()
    } catch (error) {
      ctx.logger.warn?.(`mcp-skill-panel: gateway restrict lift failed: ${messageOf(error)}`)
    }
  }
  // B2：gw- 行建在 loader root 树，不在插件 fiber 内，fiber unwind 不回收——逐个 remove
  //（同步体 fire-and-forget；彻底清理由下次 ensureOpenMounts 的 reuse/mount 覆盖）。
  for (const [serverName, entryId] of [...state.entryIds]) {
    try {
      void (ctx.loader.remove(entryId) as unknown as Promise<unknown>)?.catch?.(() => undefined)
    } catch {
      /* 行已失效，忽略（disposeWorkspace 同语义） */
    }
    state.entryIds.delete(serverName)
  }
  state.mounts.clear()
}

/** 同步释放（applyAutoManage 同步体内/卸载兜底共用；remove fire-and-forget）。 */
export function disposeGatewayStateSync(ctx: Context, state: GatewayState): void {
  disposeGatewayState(ctx, state)
}

export interface GatewayDeps {
  ctx: Context
  /** 预留控制层依赖（当前 ensureOpenMounts 经 listPresetMcpRows 直读，未用；占位见 NIT-2）。 */
  control: McpControlCtx
  state: GatewayState
}

/** ensureOpenMounts 结果计数（W3 lastCheck detail 同格式）。 */
export interface EnsureOpenMountsResult {
  mounted: string[]
  reused: string[]
  skipped: string[]
  skippedOfficial: string[]
  errors: Array<{ server: string; error: string }>
}

/**
 * 网关常驻挂载（P5）：open 的 preset 行经 loader.create 自托管拉起 dsh-mcp-client。
 *
 * 真值表（B3）：
 * - preset 无行/不可挂载（config undefined）→ skipped（回退旧直通语义）；
 * - preset 行 disabled → skipped（拒绝语义归 gatewayCall）；
 * - loader 已有同名 server 行 → skippedOfficial（网关让路，不建第二实例）；
 * - mounts 已有同名 → reused；
 * - 否则 loader.create({id: gw-mcp-<server>, name, config, disabled:false}) → mounted/errors。
 *
 * 单飞（W3）：syncing guard + 顶层 try/finally；一家失败记 errors 不抛（一家挂不拖全家）。
 * preset 选择（W4）：调用方 agent 优先，无则 roots[0]/list[0]（与 cachedPresetRow 同规则）；
 * listPresetMcpRows 按 presetId 全量列出行，挂载逐行决策。
 */
export async function ensureOpenMounts(deps: GatewayDeps, presetId?: string): Promise<EnsureOpenMountsResult> {
  const { ctx, control, state } = deps
  const out: EnsureOpenMountsResult = { mounted: [], reused: [], skipped: [], skippedOfficial: [], errors: [] }
  if (state.syncing) return out
  state.syncing = true
  try {
    let pid = presetId
    if (!pid) {
      try {
        const live = ctx.agents.roots()[0] ?? ctx.agents.list()[0]
        pid = live ? (ctx.agentPresets.composedPreset(live.ctx) ?? undefined) : undefined
      } catch {
        pid = undefined
      }
    }
    if (!pid) {
      state.lastCheck = { at: Date.now(), ok: true, detail: 'mounted=0 reused=0 skipped=0 skippedOfficial=0 errors=0 (no preset)' }
      return out
    }
    const { listPresetMcpRows } = await import('./preset-mcp')
    const { isMcpEntry, serverNameOf } = await import('./mcp-entry')
    const { MCP_CLIENT_NAME } = await import('./mcp-convert')
    let rows: Array<{ serverName: string; disabled: boolean; config?: import('./preset-mcp').PresetMcpClientConfig }> = []
    try {
      rows = (await listPresetMcpRows(ctx, pid)).rows
    } catch (error) {
      state.lastCheck = { at: Date.now(), ok: false, detail: `listPreset failed: ${messageOf(error)}` }
      return out
    }
    // loader 同 serverName 行集合（B3 让路判据；只读一次）
    const loaderServers = new Set<string>()
    try {
      for (const entry of ctx.loader.entries()) {
        if (!isMcpEntry(entry)) continue
        loaderServers.add(serverNameOf(entry))
      }
    } catch {
      /* loader 不可读 → 视为空集，逐行挂载失败再记 errors */
    }
    for (const row of rows) {
      const decision = decideMount(row.serverName, row.config, row.disabled, state.mounts, loaderServers.has(row.serverName))
      if (decision === 'skip') {
        out.skipped.push(row.serverName)
        continue
      }
      if (decision === 'skip-official') {
        out.skippedOfficial.push(row.serverName)
        continue
      }
      if (decision === 'reuse') {
        out.reused.push(row.serverName)
        continue
      }
      // mount：config 必存在（decideMount 已保证），loader.create 先挂载后记账。
      // EntryOptions 类型作 Omit<EntryOptions,'id'>（tree.ts:97），运行时 ensureId
      // 容忍显式 id（routes.ts:406 / project-mcp.ts:217 先例）——此处 as 显式标注。
      const entryId = gatewayEntryId(row.serverName)
      try {
        await ctx.loader.create({ id: entryId, name: MCP_CLIENT_NAME, config: { ...row.config }, disabled: false } as Parameters<Context['loader']['create']>[0])
        state.mounts.set(row.serverName, Date.now())
        state.entryIds.set(row.serverName, entryId)
        out.mounted.push(row.serverName)
      } catch (error) {
        out.errors.push({ server: row.serverName, error: messageOf(error) })
        ctx.logger.warn?.(`mcp-skill-panel: gateway mount "${row.serverName}" failed: ${messageOf(error)}`)
      }
    }
    const ok = out.errors.length === 0
    state.lastCheck = {
      at: Date.now(),
      ok,
      detail: `mounted=${out.mounted.length} reused=${out.reused.length} skipped=${out.skipped.length} skippedOfficial=${out.skippedOfficial.length} errors=${out.errors.length}`,
    }
    return out
  } finally {
    state.syncing = false
  }
}
