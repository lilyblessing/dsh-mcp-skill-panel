/**
 * MCP 与技能管理面板：MCP 服务器 / 技能 双标签页，统计头 + 卡片 + 启停开关。
 * 样式全部 JS 内联（宿主全局 CSS 可能覆盖注入的 class），颜色走 --dsw-alias-* 主题变量。
 * 视图形状类型来自 shared-types（与 host 单一来源，type-only import 不打包）。
 */
import React, { useCallback, useEffect, useState } from 'react'
import type { McpRow, McpView, SkillRow, SkillsView } from '../shared-types'
import { AddMcpModal } from './add-mcp'
import { AddSkillModal } from './add-skill'

interface Props {
  /** 由 locale 插槽注入：NS 字典的翻译函数 */
  t: (key: string, params?: Record<string, string | number>) => string
  close?: () => void
}

const C = {
  page: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: '12px',
    maxWidth: '760px',
    padding: '4px 2px',
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: '8px',
  },
  title: {
    margin: 0,
    fontSize: 18,
    fontWeight: 600,
    color: 'var(--dsw-alias-label-primary)',
  },
  meta: {
    margin: '2px 0 0',
    fontSize: 12,
    color: 'var(--dsw-alias-label-tertiary)',
  },
  refresh: {
    font: 'inherit',
    cursor: 'pointer',
    border: '1px solid var(--dsw-alias-border-l2)',
    background: 'var(--dsw-alias-bg-layer-1)',
    color: 'var(--dsw-alias-label-secondary)',
    borderRadius: 6,
    padding: '5px 12px',
    fontSize: 12,
  },
  tabs: {
    display: 'flex',
    gap: '18px',
    borderBottom: '1px solid var(--dsw-alias-border-l2)',
    alignItems: 'flex-end',
  },
  tab: (active: boolean): React.CSSProperties => ({
    font: 'inherit',
    cursor: 'pointer',
    background: 'transparent',
    border: 0,
    padding: '7px 1px 9px',
    fontSize: 13,
    lineHeight: '20px',
    color: active ? 'var(--dsw-alias-label-primary)' : 'var(--dsw-alias-label-tertiary)',
    borderBottom: active ? '2px solid var(--dsw-alias-label-primary)' : '2px solid transparent',
    marginBottom: -1,
  }),
  stats: {
    display: 'flex',
    gap: '8px',
    flexWrap: 'wrap' as const,
  },
  stat: {
    flex: '1 1 0',
    minWidth: 120,
    background: 'var(--dsw-alias-bg-layer-1)',
    border: '1px solid var(--dsw-alias-border-l2)',
    borderRadius: 8,
    padding: '10px 12px',
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 2,
  },
  statValue: {
    fontSize: 18,
    fontWeight: 600,
    color: 'var(--dsw-alias-label-primary)',
  },
  statLabel: {
    fontSize: 11,
    color: 'var(--dsw-alias-label-tertiary)',
  },
  card: {
    background: 'var(--dsw-alias-bg-layer-1)',
    border: '1px solid var(--dsw-alias-border-l2)',
    borderRadius: 8,
    padding: '10px 12px',
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 4,
  },
  cardTop: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: '8px',
  },
  cardTitle: {
    margin: 0,
    fontSize: 14,
    fontWeight: 600,
    color: 'var(--dsw-alias-label-primary)',
    display: 'flex',
    alignItems: 'center',
    gap: 8,
  },
  cardDesc: {
    margin: 0,
    fontSize: 12,
    color: 'var(--dsw-alias-label-secondary)',
    lineHeight: '18px',
  },
  cardMeta: {
    fontSize: 11,
    color: 'var(--dsw-alias-label-tertiary)',
  },
  badge: (color: string, bg: string): React.CSSProperties => ({
    fontSize: 11,
    lineHeight: '16px',
    padding: '0 7px',
    borderRadius: 999,
    color,
    background: bg,
    whiteSpace: 'nowrap' as const,
  }),
  toggle: (disabled: boolean): React.CSSProperties => ({
    font: 'inherit',
    cursor: 'pointer',
    border: 0,
    borderRadius: 6,
    padding: '4px 12px',
    fontSize: 12,
    // 反色文字 + 语义底色：运行中=红（点它停用），已停用=绿（点它启用），明暗主题均可读
    color: 'var(--dsw-alias-label-inverse, #fff)',
    background: disabled ? 'var(--dsw-alias-state-success-primary)' : 'var(--dsw-alias-state-error-primary)',
    whiteSpace: 'nowrap' as const,
  }),
  toggleDisabled: {
    opacity: 0.55,
    cursor: 'progress',
  } as React.CSSProperties,
  hint: {
    margin: 0,
    fontSize: 11,
    color: 'var(--dsw-alias-label-tertiary)',
  },
  error: {
    fontSize: 12,
    // v0.5.0 修复：早期用 state-error-primary 作文字色、secondary 作背景，这套令牌是
    // 「表面/色块」级同色系，文字糊进背景（实测不可读）。改 label-primary 文字 + 淡染背景
    color: 'var(--dsw-alias-label-primary)',
    background: 'color-mix(in srgb, var(--dsw-alias-state-error-primary) 14%, transparent)',
    borderLeft: '3px solid var(--dsw-alias-state-error-primary)',
    borderRadius: 6,
    padding: '8px 10px',
  },
  empty: {
    fontSize: 13,
    color: 'var(--dsw-alias-label-tertiary)',
    padding: '16px 0',
    textAlign: 'center' as const,
  },
  // P0 提示：会话中途开关致 Prompt Cache 失效的警示条（severe 时叠加 warnSevere 加深）。
  // 文字用 label-primary（主题文字前景），背景为语义色淡染 + 左侧语义色竖条——
  // 避免 primary/secondary 令牌同色系导致"同色不可读"（2026-08-20 实测踩坑）。
  warn: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: '8px',
    fontSize: 12,
    lineHeight: '18px',
    color: 'var(--dsw-alias-label-primary)',
    background: 'color-mix(in srgb, var(--dsw-alias-state-warn-primary) 16%, transparent)',
    borderLeft: '3px solid var(--dsw-alias-state-warn-primary)',
    borderRadius: 6,
    padding: '8px 10px',
  },
  warnSevere: {
    color: 'var(--dsw-alias-label-primary)',
    background: 'color-mix(in srgb, var(--dsw-alias-state-error-primary) 24%, transparent)',
    borderLeft: '3px solid var(--dsw-alias-state-error-primary)',
    fontWeight: 600,
  } as React.CSSProperties,
  warnDismiss: {
    font: 'inherit',
    cursor: 'pointer',
    border: 0,
    background: 'transparent',
    color: 'inherit',
    opacity: 0.85,
    padding: '2px 6px',
    borderRadius: 4,
    fontSize: 12,
    whiteSpace: 'nowrap' as const,
  },
  // 工具级控制：折叠开关 / 工具行 / 工具禁用开关
  toolToggleBtn: {
    font: 'inherit',
    cursor: 'pointer',
    border: 0,
    background: 'transparent',
    color: 'var(--dsw-alias-label-tertiary)',
    padding: '2px 2px',
    fontSize: 12,
    alignSelf: 'flex-start' as const,
  },
  // 0.6.0「更多配置」抽屉
  modalMask: {
    position: 'fixed' as const,
    inset: 0,
    background: 'rgba(0,0,0,0.45)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 1000,
  },
  modal: {
    // 2026-09-15 色彩修复：原先用了不存在的 --dsw-alias-bg-l1，恒回落 #1b1b1f，
    // 亮色主题下抽屉恒暗 + 输入框（fill-l1 未定义→透明）透出暗底，文字不可读。
    // 改与卡片同源的 bg-layer-1，随宿主主题走。
    background: 'var(--dsw-alias-bg-layer-1)',
    border: '1px solid var(--dsw-alias-border-l2)',
    borderRadius: 10,
    padding: 16,
    width: 'min(560px, 92vw)',
    maxHeight: '86vh',
    overflowY: 'auto' as const,
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 8,
  },
  cfgField: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 2,
  },
  cfgLabel: {
    fontSize: 12,
    color: 'var(--dsw-alias-label-tertiary)',
  },
  cfgInput: {
    font: 'inherit',
    fontSize: 13,
    padding: '4px 6px',
    borderRadius: 6,
    border: '1px solid var(--dsw-alias-border-l2)',
    // 输入槽用文字色淡染（主题自适应）；不用 fill-l1（宿主未定义即透明透底）。
    background: 'color-mix(in srgb, var(--dsw-alias-label-primary) 7%, transparent)',
    color: 'var(--dsw-alias-label-primary)',
  },
  cfgArea: {
    font: 'inherit',
    fontSize: 13,
    padding: '4px 6px',
    borderRadius: 6,
    border: '1px solid var(--dsw-alias-border-l2)',
    background: 'color-mix(in srgb, var(--dsw-alias-label-primary) 7%, transparent)',
    color: 'var(--dsw-alias-label-primary)',
    resize: 'vertical' as const,
  },
  toolList: {
    marginTop: 4,
    borderTop: '1px solid var(--dsw-alias-border-l2)',
    paddingTop: 6,
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 4,
    maxHeight: 220,
    overflowY: 'auto' as const,
  },
  toolRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    fontSize: 12,
  },
  toolName: {
    flex: '0 0 auto',
    color: 'var(--dsw-alias-label-primary)',
    fontWeight: 500,
  },
  toolDesc: {
    flex: 1,
    color: 'var(--dsw-alias-label-tertiary)',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap' as const,
  },
  toolSwitch: (disabled: boolean): React.CSSProperties => ({
    font: 'inherit',
    cursor: 'pointer',
    border: 0,
    borderRadius: 5,
    padding: '2px 10px',
    fontSize: 11,
    flex: '0 0 auto',
    color: 'var(--dsw-alias-label-inverse, #fff)',
    background: disabled ? 'var(--dsw-alias-state-success-primary)' : 'var(--dsw-alias-state-error-primary)',
    whiteSpace: 'nowrap' as const,
  }),
  // 0.6.0 工具预算卡（设置/清除按钮与输入槽，风格与既有 cfgInput 一致）
  budgetInput: {
    font: 'inherit',
    fontSize: 12,
    width: 76,
    padding: '3px 8px',
    borderRadius: 5,
    border: '1px solid var(--dsw-alias-border-l2)',
    // 与 cfgInput 同款：输入槽用文字色淡染（主题自适应），不用未定义的 fill-l1。
    background: 'color-mix(in srgb, var(--dsw-alias-label-primary) 7%, transparent)',
    color: 'var(--dsw-alias-label-primary)',
  },
  smallBtn: (busy: boolean): React.CSSProperties => ({
    font: 'inherit',
    cursor: busy ? 'default' : 'pointer',
    opacity: busy ? 0.55 : 1,
    border: '1px solid var(--dsw-alias-border-l2)',
    background: 'var(--dsw-alias-bg-layer-1)',
    color: 'var(--dsw-alias-label-secondary)',
    borderRadius: 5,
    padding: '3px 10px',
    fontSize: 11,
    whiteSpace: 'nowrap' as const,
  }),
  // 工具批量控制条（0.6.0 特性 1）：过滤框 + 全部/按过滤 的批量启停动作。
  // 450 工具的 server 不过滤没法用，所以过滤与批量是同一件工作流（先搜再全禁）。
  toolBar: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    flexWrap: 'wrap' as const,
    marginTop: 6,
  },
  toolFilterInput: {
    font: 'inherit',
    fontSize: 12,
    flex: '1 1 160px',
    minWidth: 120,
    padding: '3px 8px',
    borderRadius: 5,
    border: '1px solid var(--dsw-alias-border-l2)',
    // 与 cfgInput 同款：输入槽用文字色淡染（主题自适应），不用未定义的 fill-l1。
    background: 'color-mix(in srgb, var(--dsw-alias-label-primary) 7%, transparent)',
    color: 'var(--dsw-alias-label-primary)',
  },
  bulkBtn: (busy: boolean): React.CSSProperties => ({
    font: 'inherit',
    cursor: busy ? 'default' : 'pointer',
    opacity: busy ? 0.55 : 1,
    border: '1px solid var(--dsw-alias-border-l2)',
    background: 'var(--dsw-alias-bg-layer-1)',
    color: 'var(--dsw-alias-label-secondary)',
    borderRadius: 5,
    padding: '3px 10px',
    fontSize: 11,
    whiteSpace: 'nowrap' as const,
  }),
  // 分段控件（中间层隐藏范围 / 按模型覆盖三态共用）：选中态用主题自带的
  // ghost-active 令牌，不学 PR 原稿的 color-mix + info 系令牌（那一族宿主未定义，属 C 段）。
  routeRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '4px 0',
    fontSize: 12,
    borderTop: '1px solid var(--dsw-alias-border-l2)',
    flexWrap: 'wrap' as const,
  },
  routeName: {
    flex: '1 1 140px',
    color: 'var(--dsw-alias-label-primary)',
    fontWeight: 500,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  },
  routeSeg: (active: boolean): React.CSSProperties => ({
    font: 'inherit',
    cursor: 'pointer',
    border: '1px solid',
    borderRadius: 5,
    padding: '2px 9px',
    fontSize: 11,
    whiteSpace: 'nowrap' as const,
    fontWeight: active ? 600 : 400,
    color: active ? 'var(--dsw-alias-label-primary)' : 'var(--dsw-alias-label-tertiary)',
    background: active ? 'var(--dsw-alias-button-ghost-active-fill)' : 'transparent',
    borderColor: active ? 'var(--dsw-alias-button-ghost-active-border)' : 'var(--dsw-alias-border-l2)',
  }),
  // 批量动作结果回执（changed / ignoredToolNames）
  toolNote: {
    margin: 0,
    fontSize: 11,
    color: 'var(--dsw-alias-label-secondary)',
  },
}

function formatK(n: number): string {
  return n >= 1000 ? (n / 1000).toFixed(1).replace(/\.0$/, '') : String(n)
}

// P1 批量合并：MCP toggle 合并窗口（issue #1 建议 300~500ms，取 400ms）。
// 窗口内多次点击只在 flush 时发一次 toggleBatch → 服务端单次 invalidateMcp →
// N 次 toggle 收敛为 1 次 tools/change（1 次 Prompt Cache miss）。
const MCP_BATCH_DEBOUNCE_MS = 400
// P0 提示：大包阈值（工具 >50 或 token ~>10k 红字高亮，issue #1 P0）。
const CACHE_WARN_MAX_TOOLS = 50
const CACHE_WARN_MAX_TOKENS = 10_000
// P0 警示条自动消失时长（ms）。
const CACHE_WARN_AUTO_DISMISS_MS = 12_000

export function RuntimeInventorySection(props: Props): React.ReactElement {
  const { t } = props
  const [tab, setTab] = useState<'mcp' | 'skill'>('mcp')
  const [mcp, setMcp] = useState<McpView | null>(null)
  const [skills, setSkills] = useState<SkillsView | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<Record<string, boolean>>({})
  // P0 提示：瞬态警示条（text + severe 红字高亮），自动消失 + 可手动关闭
  const [warn, setWarn] = useState<{ text: string; severe: boolean } | null>(null)
  const warnTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null)
  const showWarn = useCallback(
    (text: string, severe: boolean) => {
      setWarn({ text, severe })
      if (warnTimer.current) clearTimeout(warnTimer.current)
      warnTimer.current = setTimeout(() => setWarn(null), CACHE_WARN_AUTO_DISMISS_MS)
    },
    [],
  )

  // 生效时机：immediate（默认）/ next-session
  const [applyMode, setApplyMode] = useState<'immediate' | 'next-session'>('immediate')
  // 添加 MCP 弹窗可见性
  const [showAdd, setShowAdd] = useState(false)
  // 创建技能弹窗可见性
  const [showAddSkill, setShowAddSkill] = useState(false)

  // 分域加载：MCP tab 只拉 MCP 数据（不触发 skill 目录发现），切 tab 时按需刷新。
  // 乱序防护：自增序号，过期响应直接丢弃（快速连点多个开关时慢响应不会覆盖新状态）。
  const mcpSeq = React.useRef(0)
  const skillsSeq = React.useRef(0)

  // P2-7：loadMcp/loadSkills 合并为通用加载器（seq guard + 错误处理单一实现）
  const load = useCallback((part: 'mcp' | 'skills') => {
    const ref = part === 'mcp' ? mcpSeq : skillsSeq
    const seq = ++ref.current
    setError(null)
    fetch(`/api/mcp-skill-panel/state?part=${part}`)
      .then((res) => res.json() as Promise<{ ok: boolean; state?: McpView | SkillsView; error?: string }>)
      .then((body) => {
        if (!body.ok || !body.state) throw new Error(body.error ?? 'bad response')
        if (seq !== ref.current) return
        if (part === 'mcp') setMcp(body.state as McpView)
        else setSkills(body.state as SkillsView)
      })
      .catch((err: unknown) => {
        if (seq === ref.current) setError(err instanceof Error ? err.message : String(err))
      })
  }, [])

  const loadMcp = useCallback(() => load('mcp'), [load])
  const loadSkills = useCallback(() => load('skills'), [load])

  useEffect(() => {
    // 初次挂载与每次切 tab：服务端有 60s 分域缓存兜底，成本低，换来切换即新鲜
    if (tab === 'mcp') loadMcp()
    else loadSkills()
  }, [tab, loadMcp, loadSkills])

  // 启动时拉取 applyMode（与 state 加载并行，互不阻塞）；失败回退 immediate
  useEffect(() => {
    fetch('/api/mcp-skill-panel/config')
      .then((r) => r.json() as Promise<{ ok: boolean; applyMode?: 'immediate' | 'next-session' }>)
      .then((b) => { if (b.ok && b.applyMode) setApplyMode(b.applyMode) })
      .catch(() => { /* 默认 immediate，静默回退 */ })
  }, [])

  // 派生：是否有任意 MCP 行处于 pending 状态
  const hasPending = Boolean(mcp?.mcp?.some((r) => r.pending))

  // 进程级 token：所有 POST 前取一次并缓存（服务端随机令牌，阻断跨源/DNS-rebinding
  // 对本地控制端点的盲写）。tokenPromise 缓存 Promise，无需重复请求。
  const tokenPromise = React.useRef<Promise<string | null> | null>(null)
  const ensureToken = useCallback(() => {
    if (!tokenPromise.current) {
      tokenPromise.current = fetch('/api/mcp-skill-panel/token')
        .then((r) => r.json() as Promise<{ token?: string }>)
        .then((b) => b?.token ?? null)
        .catch(() => null)
    }
    return tokenPromise.current
  }, [])

  const post = useCallback(
    async (path: string, payload: Record<string, unknown>, key: string, onOk: () => void) => {
      setBusy((prev) => ({ ...prev, [key]: true }))
      setError(null)
      const token = await ensureToken()
      const headers: Record<string, string> = { 'content-type': 'application/json' }
      if (token) headers['x-panel-token'] = token
      fetch(path, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
      })
        .then((res) => res.json() as Promise<{ ok: boolean; error?: string }>)
        .then((body) => {
          if (!body.ok) throw new Error(body.error ?? 'toggle failed')
          onOk()
        })
        .catch((err: unknown) => {
          setError(t('ri.toggleError', { error: err instanceof Error ? err.message : String(err) }))
          loadMcp()
          loadSkills()
        })
        .finally(() => setBusy((prev) => ({ ...prev, [key]: false })))
    },
    [t, loadMcp, loadSkills, ensureToken],
  )

  // P1 批量合并：MCP toggle 先入队，400ms 去抖窗口合并为一次 toggleBatch。
  // 队列按 entryId 去重（同窗口内同行连点取最后一次意图）；窗口内跨行点击合并，
  // 服务端单次 invalidateMcp → N 次 toggle 收敛为 1 次 Prompt Cache miss。
  const mcpBatch = React.useRef<Map<string, { entryId: string; rowId: string; disabled: boolean }>>(new Map())
  const mcpBatchTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null)

  const flushMcpBatch = useCallback(async () => {
    if (mcpBatchTimer.current) {
      clearTimeout(mcpBatchTimer.current)
      mcpBatchTimer.current = null
    }
    const items = Array.from(mcpBatch.current.values())
    mcpBatch.current.clear()
    if (items.length === 0) return
    const keys = items.map((it) => `mcp:${it.rowId}`)
    setBusy((prev) => {
      const next = { ...prev }
      for (const k of keys) next[k] = true
      return next
    })
    setError(null)
    const token = await ensureToken()
    const headers: Record<string, string> = { 'content-type': 'application/json' }
    if (token) headers['x-panel-token'] = token
    try {
      const res = await fetch('/api/mcp-skill-panel/mcp/toggleBatch', {
        method: 'POST',
        headers,
        body: JSON.stringify({ toggles: items.map(({ entryId, disabled }) => ({ entryId, disabled })) }),
      })
      const body = (await res.json()) as {
        ok: boolean
        error?: string
        failed?: number
        results?: Array<{ ok?: boolean; error?: string }>
      }
      if (!body.ok) throw new Error(body.error ?? 'batch toggle failed')
      if (body.failed && body.failed > 0) {
        const firstErr = body.results?.find((r) => r.ok === false)?.error
        setError(t('ri.toggleError', { error: `batch: ${body.failed} failed${firstErr ? ` — ${firstErr}` : ''}` }))
      }
      loadMcp()
    } catch (err) {
      setError(t('ri.toggleError', { error: err instanceof Error ? err.message : String(err) }))
      loadMcp()
      loadSkills()
    } finally {
      setBusy((prev) => {
        const next = { ...prev }
        for (const k of keys) next[k] = false
        return next
      })
    }
  }, [t, loadMcp, loadSkills, ensureToken])

  const toggleMcp = useCallback(
    (row: McpRow) => {
      // 生效时机感知：immediate 模式弹缓存失效警示，next-session 弹轻度提示
      if (applyMode === 'immediate') {
        showWarn(t('ri.cacheWarn'), row.tools > CACHE_WARN_MAX_TOOLS || row.tokens > CACHE_WARN_MAX_TOKENS)
      } else {
        showWarn(t('ri.applyDeferredHint'), false)
      }
      // 入队 + 重置去抖窗口（后续点击顺延到 400ms 后统一 flush）。
      // 有效状态取「待生效意图」（next-session 有 pending 时按钮翻转的是意图而非 live），
      // 让用户能通过 UI 逆向撤销待生效意图（TC8 修复）。
      const effDisabled = applyMode === 'next-session' && row.pending ? (row.desired ?? row.disabled) : row.disabled
      mcpBatch.current.set(row.entryId, { entryId: row.entryId, rowId: row.rowId, disabled: !effDisabled })
      if (mcpBatchTimer.current) clearTimeout(mcpBatchTimer.current)
      mcpBatchTimer.current = setTimeout(() => void flushMcpBatch(), MCP_BATCH_DEBOUNCE_MS)
    },
    [showWarn, flushMcpBatch, applyMode, t],
  )

  // 卸载清理：丢弃未 flush 的批量 toggle（否则 400ms 窗口内关面板会丢操作）并清提示定时器。
  // 必须置于 flushMcpBatch 定义之后注册 effect，避免渲染期 TDZ 引用未初始化的 const。
  useEffect(
    () => () => {
      if (warnTimer.current) clearTimeout(warnTimer.current)
      void flushMcpBatch()
    },
    [flushMcpBatch],
  )

  const toggleAutoManage = async () => {
    const next = !(mcp?.autoManage ?? false)
    // P0：autoManage 开关会瞬变 tools 注入量（如 96→40），同样提示缓存失效
    showWarn(t('ri.cacheWarn'), false)
    setBusy((prev) => ({ ...prev, autoManage: true }))
    setError(null)
    const token = await ensureToken()
    const headers: Record<string, string> = { 'content-type': 'application/json' }
    if (token) headers['x-panel-token'] = token
    fetch('/api/mcp-skill-panel/config', {
      method: 'POST',
      headers,
      body: JSON.stringify({ autoManage: next }),
    })
      .then((res) => res.json() as Promise<{ ok: boolean; autoManage?: boolean; error?: string }>)
      .then((body) => {
        if (!body.ok) throw new Error(body.error ?? 'config update failed')
        setMcp((prev) => (prev ? { ...prev, autoManage: Boolean(body.autoManage) } : prev))
        loadMcp()
      })
      .catch((err: unknown) => {
        setError(t('ri.toggleError', { error: err instanceof Error ? err.message : String(err) }))
      })
      .finally(() => setBusy((prev) => ({ ...prev, autoManage: false })))
  }

  const toggleSkill = (row: SkillRow) => {
    // P0：Skill 目录消息位于前缀首部，中途开关同样使该位置起全量 miss
    showWarn(t('ri.cacheWarn'), false)
    post(
      '/api/mcp-skill-panel/skill/toggle',
      { name: row.name, disabled: row.modelInvocable },
      `skill:${row.name}`,
      () => {
        // 乐观更新：立即翻转目标卡片（服务端会先确认 catalog 再返回，双重保障）
        setSkills((prev) =>
          prev
            ? {
                ...prev,
                skills: prev.skills.map((s) =>
                  s.name === row.name ? { ...s, modelInvocable: !row.modelInvocable, userInvocable: s.userInvocable } : s,
                ),
                skillsModelVisible: prev.skillsModelVisible + (row.modelInvocable ? -1 : 1),
              }
            : prev,
        )
        loadSkills()
      },
    )
  }

  // P2-9：useCallback 稳定引用，避免 McpPanel 每次渲染重建（状态徽标查表）
  const mcpStatus = useCallback(
    (row: McpRow): { label: string; color: string; bg: string; title?: string } => {
      // 0.6.0 诚实上报：启用+在跑但零注册（子进程起不来/空转）单独一档，
      // 不复用 statusIdle 的"No tools"，也不会再被目录快照伪装成 active。
      if (row.unregistered) {
        return {
          label: t('ri.statusUnregistered'),
          color: 'var(--dsw-alias-state-error-primary)',
          bg: 'var(--dsw-alias-state-error-secondary)',
          title: t('ri.statusUnregisteredHint'),
        }
      }
      switch (row.status) {
        case 'active':
          return { label: t('ri.statusActive'), color: 'var(--dsw-alias-state-success-primary)', bg: 'var(--dsw-alias-state-success-tertiary)' }
        case 'disabled':
          return { label: t('ri.statusDisabled'), color: 'var(--dsw-alias-label-tertiary)', bg: 'var(--dsw-alias-fill-l2, var(--dsw-alias-bg-layer-2))' }
        case 'idle':
          return { label: t('ri.statusIdle'), color: 'var(--dsw-alias-state-warn-primary)', bg: 'var(--dsw-alias-state-warn-tertiary)' }
        default:
          return { label: t('ri.statusFailed'), color: 'var(--dsw-alias-state-error-primary)', bg: 'var(--dsw-alias-state-error-secondary)' }
      }
    },
    [t],
  )

  const view = tab === 'mcp' ? mcp : skills

  return (
    <div style={C.page}>
      <div style={C.header}>
        <div>
          <h2 style={C.title}>{t('ri.nav')}</h2>
          <p style={C.meta}>
            {view ? `${t('ri.preset')}: ${view.preset ?? '—'} · ${t('ri.session')}: ${view.sessionId ?? '—'}` : ''}
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          {tab === 'mcp' && (
            <button type="button" style={C.refresh} onClick={() => setShowAdd(true)}>
              {t('ri.addMcp')}
            </button>
          )}
          {tab === 'skill' && (
            <button type="button" style={C.refresh} onClick={() => setShowAddSkill(true)}>
              {t('ri.addSkill')}
            </button>
          )}
          <button
            type="button"
            style={C.refresh}
            onClick={() => {
              // 手动刷新前先 flush 积压的批量 toggle，避免读到申请前状态
              void flushMcpBatch()
              if (tab === 'mcp') loadMcp()
              else loadSkills()
            }}
          >
            {t('ri.refresh')}
          </button>
        </div>
      </div>

      <div style={C.tabs} role="tablist">
        <button type="button" role="tab" aria-selected={tab === 'mcp'} style={C.tab(tab === 'mcp')} onClick={() => setTab('mcp')}>
          {t('ri.mcpTab')}
        </button>
        <button type="button" role="tab" aria-selected={tab === 'skill'} style={C.tab(tab === 'skill')} onClick={() => setTab('skill')}>
          {t('ri.skillTab')}
        </button>
      </div>

      {error && <div style={C.error}>{error}</div>}

      {warn && (
        <div style={{ ...C.warn, ...(warn.severe ? C.warnSevere : {}) }} role="status">
          <span>{warn.text}</span>
          <button
            type="button"
            style={C.warnDismiss}
            onClick={() => {
              if (warnTimer.current) clearTimeout(warnTimer.current)
              setWarn(null)
            }}
          >
            {t('ri.cacheWarnDismiss')}
          </button>
        </div>
      )}

      {!view && !error && <div style={C.empty}>{t('ri.loading')}</div>}

      {view && tab === 'mcp' && (
        <>
          <AutoManageCard
            on={(view as McpView).autoManage}
            hides={(view as McpView).middleLayerHides}
            mounted={(view as McpView).autoManageMounted}
            busy={Boolean(busy.autoManage)}
            t={t}
            onToggle={toggleAutoManage}
            loadMcp={loadMcp}
          />
          <RouteOverridesCard state={view as McpView} t={t} loadMcp={loadMcp} />
          <ApplyTimingCard
            applyMode={applyMode}
            hasPending={hasPending}
            busy={Boolean(busy.applyMode)}
            t={t}
            onModeChange={setApplyMode}
            loadMcp={loadMcp}
            ensureToken={ensureToken}
            setError={setError}
            showWarn={showWarn}
            setBusy={setBusy}
          />
          <McpPanel state={view as McpView} t={t} busy={busy} onToggle={toggleMcp} statusOf={mcpStatus} applyMode={applyMode} loadMcp={loadMcp} />
        </>
      )}

      {view && tab === 'skill' && <SkillPanel state={view as SkillsView} t={t} busy={busy} onToggle={toggleSkill} />}

      {showAdd && (
        <AddMcpModal
          t={t}
          workspace={mcp?.activeWorkspace ?? mcp?.cwd ?? null}
          onClose={() => setShowAdd(false)}
          onAdded={loadMcp}
        />
      )}

      {showAddSkill && (
        <AddSkillModal
          t={t}
          workspace={skills?.cwd ?? null}
          onClose={() => setShowAddSkill(false)}
          onAdded={loadSkills}
        />
      )}
    </div>
  )
}

/** P2-7：状态徽标小组件（替代散落的 C.badge span 样板）。 */
function Badge(props: { color: string; bg: string; children: React.ReactNode; title?: string }): React.ReactElement {
  return <span style={C.badge(props.color, props.bg)} title={props.title}>{props.children}</span>
}

function AutoManageCard(props: {
  on: boolean
  hides: 'disabled' | 'all'
  mounted: boolean
  busy: boolean
  t: Props['t']
  onToggle: () => void
  loadMcp: () => void
}): React.ReactElement {
  const { on, hides, mounted, busy, t, onToggle, loadMcp } = props
  const [hidesBusy, setHidesBusy] = useState(false)
  const [hidesErr, setHidesErr] = useState<string | null>(null)
  const setHides = useCallback(
    async (next: 'disabled' | 'all') => {
      if (next === hides) return
      setHidesBusy(true)
      setHidesErr(null)
      try {
        await panelPost('/api/mcp-skill-panel/config', { middleLayerHides: next })
        loadMcp()
      } catch (error) {
        setHidesErr(error instanceof Error ? error.message : String(error))
      } finally {
        setHidesBusy(false)
      }
    },
    [hides, loadMcp],
  )
  // 隐藏范围只在中间层**实际挂载**时才有意义，而挂载条件是「总开关开 或 覆盖表有 true 项」
  // —— 所以判据用 mounted（运行期读数），不用总开关 on：否则总开关关但覆盖项 true 时
  // 用户看不到也改不了这个开关。
  const showHides = on || mounted
  // 按钮与 MCP 卡片统一为「动作语义」配色（用户截图确认）：
  // 启用中=红「停用」、停用中=绿「启用」。注意 C.toggle 的参数语义是 disabled
  // （停用=绿），直接传 on 会得到相反效果 —— 必须反转传参 C.toggle(!on)。
  return (
    <div style={C.card}>
      <div style={C.cardTop}>
        <h3 style={C.cardTitle}>
          {t('ri.autoManageTitle')}
          <Badge
            color={on ? 'var(--dsw-alias-state-success-primary)' : 'var(--dsw-alias-label-tertiary)'}
            bg={on ? 'var(--dsw-alias-state-success-tertiary)' : 'var(--dsw-alias-bg-layer-2)'}
          >
            {on ? t('ri.autoManageOn') : t('ri.autoManageOff')}
          </Badge>
        </h3>
        <button
          type="button"
          style={{ ...C.toggle(!on), ...(busy ? C.toggleDisabled : {}) }}
          disabled={busy}
          onClick={onToggle}
        >
          {busy ? t('ri.pending') : on ? t('ri.disable') : t('ri.enable')}
        </button>
      </div>
      <p style={C.cardDesc}>{on ? t('ri.autoManageDescOn') : t('ri.autoManageDescOff')}</p>
      {/* 0.6.0 特性 5a：中间层隐藏范围。'all' 时连已启用的 server 也从模型面隐藏
          （server 保持运行，中间层未生效的模型照旧直连）。 */}
      {showHides && (
        <>
          <div style={{ ...C.routeRow, borderTop: 0 }}>
            <span style={C.routeName}>{t('ri.hidesLabel')}</span>
            <span style={{ display: 'flex', gap: 4 }}>
              <button
                type="button"
                style={{ ...C.routeSeg(hides === 'disabled'), ...(hidesBusy ? C.toggleDisabled : {}) }}
                disabled={hidesBusy}
                onClick={() => void setHides('disabled')}
              >
                {t('ri.hidesDisabled')}
              </button>
              <button
                type="button"
                style={{ ...C.routeSeg(hides === 'all'), ...(hidesBusy ? C.toggleDisabled : {}) }}
                disabled={hidesBusy}
                onClick={() => void setHides('all')}
              >
                {t('ri.hidesAll')}
              </button>
            </span>
          </div>
          <p style={C.hint}>{hides === 'all' ? t('ri.hidesDescAll') : t('ri.hidesDescDisabled')}</p>
          {hidesErr && <div style={C.error}>{hidesErr}</div>}
        </>
      )}
    </div>
  )
}

/**
 * 0.6.0 特性 4：按模型覆盖表（三态：跟随总开关 / 强制开 / 强制关）→ `config.autoManageByRoute`。
 *
 * 数据来源说明（本仓**没有** `/models` 端点，/config 只回显覆盖表）：行集合 = 覆盖表现有键
 * ∪ 当前会话路由（`autoManageActive.provider` 与 `provider/model`）。因此面板只保证「当前
 * 模型」与「已配置的键」可编辑；要为一个当前会话之外的模型预置规则，需先切到该模型。
 * 这比 PR 原稿（拉 provider 目录、每个 provider 一次 listModels 网络调用）少一条无鉴权
 * GET，见评审 WARN-3。
 */
function RouteOverridesCard(props: {
  state: McpView
  t: Props['t']
  loadMcp: () => void
}): React.ReactElement {
  const { state, t, loadMcp } = props
  const [busyKey, setBusyKey] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)

  const setOverride = useCallback(
    async (key: string, value: boolean | null) => {
      setBusyKey(key)
      setErr(null)
      try {
        // value=null → 后端删掉该项（= 跟随总开关），不会写 false 进表
        await panelPost('/api/mcp-skill-panel/config', { routeOverride: { key, value } })
        loadMcp()
      } catch (error) {
        setErr(error instanceof Error ? error.message : String(error))
      } finally {
        setBusyKey(null)
      }
    },
    [loadMcp],
  )

  // 当前值 = 运行期表优先，运行期没有该键时回落到**持久化**表：中间层挂载失败会把
  // 运行期表清空（index.ts 的 catch），此时只读运行期会让已配置的键显示成「跟随总开关」
  // 并诱导用户重设一次（见下面的 persistedOnly 标记）。
  const current = (key: string): boolean | null => {
    const value = state.autoManageByRoute[key]
    if (typeof value === 'boolean') return value
    const persisted = state.autoManageByRoutePersisted[key]
    return typeof persisted === 'boolean' ? persisted : null
  }
  // 「已持久化但当前不在运行期表里」= 该覆盖项本次没生效（挂载失败），必须显式标记。
  const persistedOnly = (key: string): boolean =>
    !(key in state.autoManageByRoute) && typeof state.autoManageByRoutePersisted[key] === 'boolean'

  const segment = (key: string): React.ReactElement => {
    const value = current(key)
    const disabled = busyKey === key
    const option = (label: string, target: boolean | null): React.ReactElement => (
      <button
        type="button"
        style={{ ...C.routeSeg(value === target), ...(disabled ? C.toggleDisabled : {}) }}
        disabled={disabled}
        onClick={() => {
          // 等值守卫（与「隐藏范围」setHides、「生效时机」switchMode 两处同类控件一致）：
          // 点已选中的那一段不再发请求 —— 后端只要收到 routeOverride 字段就会重挂中间层
          // （routes.ts 的 middlewareTouched → 该轮前缀缓存 miss），而结果逐字不变。
          // 对「跟随总开关」而言，本来就不存在的键点它同样不发删除请求。
          if (value === target) return
          void setOverride(key, target)
        }}
      >
        {label}
      </button>
    )
    return (
      <span style={{ display: 'flex', gap: 4 }}>
        {option(t('ri.routeInherit'), null)}
        {option(t('ri.routeOn'), true)}
        {option(t('ri.routeOff'), false)}
      </span>
    )
  }

  const active = state.autoManageActive
  // 当前路由行：provider 级与 provider/model 级各一行（命中优先级 model > provider）。
  const activeKeys = [active.provider, active.provider && active.model ? `${active.provider}/${active.model}` : null].filter(
    (key): key is string => typeof key === 'string' && key.length > 0,
  )
  // 行集合 = 当前路由键 ∪ 运行期覆盖表 ∪ **持久化**覆盖表。加最后一项是为了让
  // 「已配置但本次未生效」的键仍然可见、可删（否则挂载失败后用户既看不到也删不掉）。
  const keys = [
    ...new Set([
      ...activeKeys,
      ...Object.keys(state.autoManageByRoute),
      ...Object.keys(state.autoManageByRoutePersisted),
    ]),
  ]
  const sourceLabel =
    active.source === 'model'
      ? t('ri.routeSourceModel')
      : active.source === 'provider'
        ? t('ri.routeSourceProvider')
        : active.source === 'master'
          ? t('ri.routeSourceMaster')
          : t('ri.routeSourceNoRoute')
  const routeLabel = active.provider && active.model ? `${active.provider}/${active.model}` : t('ri.routeUnknown')
  // 诊断装配（无 agent）时 source='no-route'：必须显式说出来，否则用户看到
  // 「强制开」却没生效会以为是 bug（评审 §6-2 的隐藏风险）。
  const noRoute = active.source === 'no-route'

  return (
    <div style={C.card}>
      <div style={C.cardTop}>
        <h3 style={C.cardTitle}>
          {t('ri.routeTitle')}
          <Badge
            color={active.on ? 'var(--dsw-alias-state-success-primary)' : 'var(--dsw-alias-label-tertiary)'}
            bg={active.on ? 'var(--dsw-alias-state-success-tertiary)' : 'var(--dsw-alias-bg-layer-2)'}
          >
            {active.on ? t('ri.routeActiveOn') : t('ri.routeActiveOff')}
          </Badge>
          {noRoute && (
            <Badge color="var(--dsw-alias-state-warn-primary)" bg="var(--dsw-alias-state-warn-tertiary)" title={t('ri.routeNoRouteHint')}>
              {t('ri.routeSourceNoRoute')}
            </Badge>
          )}
        </h3>
      </div>
      <p style={C.cardDesc}>{t('ri.routeDesc')}</p>
      <p style={C.cardMeta}>
        {t('ri.routeActive', { state: sourceLabel, route: routeLabel })}
        {' · '}
        {state.autoManageMounted ? t('ri.routeMounted') : t('ri.routeNotMounted')}
        {/* 绑定会话 id：把上面那句「面板绑定会话」变成可核对的事实（面板是进程级全局
            组件，/state 不带 session → host 侧按 roots[0] 解析，多会话时未必是当前会话）。 */}
        {' · '}
        {t('ri.session')}: {state.sessionId ?? '—'}
      </p>
      {err && <div style={C.error}>{err}</div>}
      {keys.length === 0 && !err && <p style={C.cardMeta}>{t('ri.routeEmpty')}</p>}
      {keys.map((key, index) => (
        <div key={key} style={{ ...C.routeRow, ...(index === 0 ? { borderTop: 0 } : {}) }}>
          <span style={C.routeName} title={key}>
            {key}
            {activeKeys.includes(key) && (
              <>
                {' '}
                <span style={{ fontSize: 11, fontWeight: 400, color: 'var(--dsw-alias-label-tertiary)' }}>
                  · {t('ri.routeCurrent')}
                </span>
              </>
            )}
            {persistedOnly(key) && (
              <>
                {' '}
                <Badge
                  color="var(--dsw-alias-state-warn-primary)"
                  bg="var(--dsw-alias-state-warn-tertiary)"
                  title={t('ri.routePersistedHint')}
                >
                  {t('ri.routePersistedOnly')}
                </Badge>
              </>
            )}
          </span>
          {segment(key)}
        </div>
      ))}
    </div>
  )
}

function ApplyTimingCard(props: {
  applyMode: 'immediate' | 'next-session'
  hasPending: boolean
  busy: boolean
  t: Props['t']
  onModeChange: (mode: 'immediate' | 'next-session') => void
  loadMcp: () => void
  ensureToken: () => Promise<string | null>
  setError: (msg: string | null) => void
  showWarn: (text: string, severe: boolean) => void
  setBusy: React.Dispatch<React.SetStateAction<Record<string, boolean>>>
}): React.ReactElement {
  const { applyMode, hasPending, busy, t, onModeChange, loadMcp, ensureToken, setError, showWarn, setBusy } = props

  const switchMode = useCallback(async (mode: 'immediate' | 'next-session') => {
    if (mode === applyMode) return
    const token = await ensureToken()
    const headers: Record<string, string> = { 'content-type': 'application/json' }
    if (token) headers['x-panel-token'] = token
    fetch('/api/mcp-skill-panel/config', {
      method: 'POST',
      headers,
      body: JSON.stringify({ applyMode: mode }),
    })
      .then((r) => r.json() as Promise<{ ok: boolean; applyMode?: string; error?: string }>)
      .then((b) => {
        if (!b.ok) throw new Error(b.error ?? 'config update failed')
        onModeChange(mode)
        loadMcp()
      })
      .catch((err: unknown) => {
        setError(t('ri.toggleError', { error: err instanceof Error ? err.message : String(err) }))
      })
  }, [applyMode, ensureToken, onModeChange, loadMcp, setError, t])

  const applyPending = useCallback(async () => {
    // 「立即应用（知晓费用）」：强制把这批待办在当轮改变工具集 → 前缀失效、按 miss 计费。
    // 0.6.0：服务端要求 body 带 { confirm: true }（见 routes.ts 该端点的加固注释）——
    // 「用户已知晓费用」必须是显式动作，不能被裸 POST（模型/脚本）静默满足。
    // 这里先弹二次确认对话框（费用说明），用户点「确定」才发请求。
    if (!window.confirm(t('ri.applyPendingConfirm'))) return
    showWarn(t('ri.cacheWarn'), true)
    setBusy((prev) => ({ ...prev, applyMode: true }))
    setError(null)
    const token = await ensureToken()
    const headers: Record<string, string> = { 'content-type': 'application/json' }
    if (token) headers['x-panel-token'] = token
    fetch('/api/mcp-skill-panel/mcp/applyPending', {
      method: 'POST',
      headers,
      body: JSON.stringify({ confirm: true }),
    })
      .then((r) => r.json() as Promise<{ ok: boolean; applied?: number; error?: string }>)
      .then((b) => {
        if (!b.ok) throw new Error(b.error ?? 'applyPending failed')
        loadMcp()
        showWarn(t('ri.appliedPending', { n: b.applied ?? 0 }), false)
      })
      .catch((err: unknown) => {
        setError(t('ri.toggleError', { error: err instanceof Error ? err.message : String(err) }))
      })
      .finally(() => setBusy((prev) => ({ ...prev, applyMode: false })))
  }, [ensureToken, loadMcp, showWarn, setError, setBusy, t])

  const modeBtn = (mode: 'immediate' | 'next-session'): React.CSSProperties => ({
    font: 'inherit',
    cursor: 'pointer',
    border: '1px solid',
    borderRadius: 6,
    padding: '4px 12px',
    fontSize: 12,
    fontWeight: applyMode === mode ? 600 : 400,
    color: applyMode === mode
      ? 'var(--dsw-alias-label-primary)'
      : 'var(--dsw-alias-label-tertiary)',
    background: applyMode === mode
      ? 'color-mix(in srgb, var(--dsw-alias-state-info-primary, #4a90d9) 16%, transparent)'
      : 'transparent',
    borderColor: applyMode === mode
      ? 'var(--dsw-alias-state-info-primary, #4a90d9)'
      : 'var(--dsw-alias-border-l2)',
  })

  return (
    <div style={C.card}>
      <div style={C.cardTop}>
        <h3 style={C.cardTitle}>{t('ri.applyTiming')}</h3>
        <div style={{ display: 'flex', gap: 6 }}>
          <button type="button" style={modeBtn('immediate')} onClick={() => void switchMode('immediate')}>
            {t('ri.applyImmediate')}
          </button>
          <button type="button" style={modeBtn('next-session')} onClick={() => void switchMode('next-session')}>
            {t('ri.applyNextSession')}
          </button>
        </div>
      </div>
      <p style={{ ...C.cardDesc, whiteSpace: 'pre-line' }}>{t('ri.applyModeDesc')}</p>
      {applyMode === 'next-session' && hasPending && (
        <button
          type="button"
          style={{ ...C.toggle(true), ...(busy ? C.toggleDisabled : {}), alignSelf: 'flex-start', marginTop: 4 }}
          disabled={busy}
          onClick={() => void applyPending()}
        >
          {busy ? t('ri.pending') : t('ri.applyPendingBtn')}
        </button>
      )}
    </div>
  )
}

/** 进程级随机令牌的模块级缓存（工具级禁用端点用；令牌全程不变，复用免重复请求）。 */
let toolTokenPromise: Promise<string | null> | null = null
export function ensureToolToken(): Promise<string | null> {
  if (!toolTokenPromise) {
    toolTokenPromise = fetch('/api/mcp-skill-panel/token')
      .then((r) => r.json())
      .then((b) => (b && typeof b.token === 'string' ? b.token : null))
      .catch(() => null)
  }
  return toolTokenPromise
}

/** 带令牌的写端点 POST（工具预算等面板配置共用；无 x-panel-token 会被 401）。 */
async function panelPost<T extends { ok: boolean; error?: string }>(path: string, body: unknown): Promise<T> {
  const token = await ensureToolToken()
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (token) headers['x-panel-token'] = token
  const res = await fetch(path, { method: 'POST', headers, body: JSON.stringify(body) })
  const parsed = (await res.json()) as T
  if (!parsed.ok) throw new Error(parsed.error ?? `${path} failed`)
  return parsed
}

/**
 * 工具预算红线卡（provider 的单请求工具上限，如 grok 约 350）。
 *
 * 口径纪律（F2）：比较与展示用的是**同一个字段** `toolsAllEnabled`，并把它取自
 * 请求面还是注册表回退显式写在卡片上（`toolsAllSource`）—— 不得把注册表口径
 * 说成请求面真值。
 */
function BudgetCard(props: { state: McpView; t: Props['t']; loadMcp: () => void }): React.ReactElement {
  const { state, t, loadMcp } = props
  const [draft, setDraft] = useState<string>(state.toolBudget === null ? '' : String(state.toolBudget))
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const over = state.toolBudget !== null && state.toolsAllEnabled > state.toolBudget

  const save = useCallback(
    async (value: number | null) => {
      setBusy(true)
      setErr(null)
      try {
        await panelPost('/api/mcp-skill-panel/config', { toolBudget: value })
        loadMcp()
      } catch (error) {
        setErr(error instanceof Error ? error.message : String(error))
      } finally {
        setBusy(false)
      }
    },
    [loadMcp],
  )

  return (
    <div style={C.card}>
      <div style={C.cardTop}>
        <h3 style={C.cardTitle}>
          {t('ri.budgetLabel')}
          {state.toolBudget !== null && (
            <Badge
              color={over ? 'var(--dsw-alias-state-error-primary)' : 'var(--dsw-alias-state-success-primary)'}
              // 2026-09-16：PR 原用 state-error-tertiary 这个 alias，宿主题并未定义
              // （与 bg-l1 事故同类）→ 背景声明失效变透明。改用存在的 state-error-secondary。
              bg={over ? 'var(--dsw-alias-state-error-secondary)' : 'var(--dsw-alias-state-success-tertiary)'}
            >
              {over
                ? t('ri.budgetOver', { used: state.toolsAllEnabled, budget: state.toolBudget })
                : t('ri.budgetOk', { used: state.toolsAllEnabled, budget: state.toolBudget })}
            </Badge>
          )}
        </h3>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <input
            style={C.budgetInput}
            inputMode="numeric"
            placeholder="350"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
          />
          <button
            type="button"
            style={C.smallBtn(busy)}
            disabled={busy}
            onClick={() => {
              // 只想接受「纯正整数」形态：`Number.parseInt('350abc')` = 350、`'-5'` = -5、
              // 空串 = NaN —— 旧写法把这些一并以 null 发给后端，而后端的 `toolBudget: null`
              // 是**清除**语义（`delete state.config.toolBudget`），于是敲错一次就把已设预算
              // 静默删掉（评审 cbc-N5 / 子代理 NIT-2）。现在非法输入只提示、不发请求；
              // 清空预算只由「清除」按钮触发。
              const text = draft.trim()
              const parsed = Number(text)
              if (!/^\d+$/.test(text) || !Number.isFinite(parsed) || parsed <= 0) {
                setErr(t('ri.budgetInvalid'))
                return
              }
              void save(parsed)
            }}
          >
            {t('ri.budgetSet')}
          </button>
          <button
            type="button"
            style={C.smallBtn(busy)}
            disabled={busy}
            onClick={() => {
              setDraft('')
              void save(null)
            }}
          >
            {t('ri.budgetClear')}
          </button>
        </div>
      </div>
      <p style={C.cardDesc}>{t('ri.budgetHint')}</p>
      <p style={C.cardMeta}>
        {state.toolsAllSource === 'request' ? t('ri.budgetSourceRequest') : t('ri.budgetSourceRegistry')}
      </p>
      {err && <div style={C.error}>{err}</div>}
    </div>
  )
}

function McpPanel(props: {
  state: McpView
  t: Props['t']
  busy: Record<string, boolean>
  onToggle: (row: McpRow) => void
  statusOf: (row: McpRow) => { label: string; color: string; bg: string; title?: string }
  applyMode: 'immediate' | 'next-session'
  loadMcp: () => void
}): React.ReactElement {
  const { state, t, busy, onToggle, statusOf, applyMode, loadMcp } = props
  // 工具级禁用精简：每个 server 展开的工具下拉（已折叠/展开）
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  // 工具行禁用开关临时态（立即生效后由 loadMcp 校准）
  const [toolBusy, setToolBusy] = useState<Record<string, boolean>>({})
  const [toolErr, setToolErr] = useState<string | null>(null)
  // 0.6.0 特性 1：每 server 的工具过滤词（450 工具的 server 不过滤根本没法用）
  const [toolFilter, setToolFilter] = useState<Record<string, string>>({})
  // 批量动作进行中的 server（按钮防重入）
  const [bulkBusy, setBulkBusy] = useState<Record<string, boolean>>({})
  // 批量动作回执（已改动 N 条 / 有 K 条未识别）—— 没有它批量操作在 UI 上不可见
  const [toolNote, setToolNote] = useState<string | null>(null)
  // 0.6.0「更多配置」：点开哪一行（null = 关闭）
  const [cfgRow, setCfgRow] = useState<McpRow | null>(null)
  // 工具预算红线：与展示的数同源（toolsAllEnabled，口径见 BudgetCard）
  const overBudget = state.toolBudget !== null && state.toolsAllEnabled > state.toolBudget

  /**
   * 批量启停（`POST /mcp/toolBulk`）。
   *
   * 发参纪律 —— 后端 `resolveToolBulkTargets` 是三态契约：
   * - **省略** `toolNames` = 该 server 的全部工具（唯一的「全部」写法）；
   * - 显式数组 = 精确集合；`[]` 是合法空操作（不写盘、changed=0、仍 200）；
   * - 非数组 / 非空却一条都不匹配 = 400。
   *
   * 所以这里**永远**传显式全名数组，绝不让字段缺失：调用方算错名单的最坏后果是
   * 「一条都没动」，而不是「整个 server 被全量误禁并写盘」。
   */
  const toolBulk = useCallback(
    async (serverName: string, disabled: boolean, toolNames: string[]) => {
      setBulkBusy((prev) => ({ ...prev, [serverName]: true }))
      setToolErr(null)
      setToolNote(null)
      try {
        const body = await panelPost<{
          ok: boolean
          error?: string
          changed?: number
          ignoredToolNames?: string[]
        }>('/api/mcp-skill-panel/mcp/toolBulk', { serverName, disabled, toolNames })
        const changed = body.changed ?? 0
        const ignored = body.ignoredToolNames ?? []
        // changed = 真正翻转的条数（幂等点击可能为 0）；ignoredToolNames = 点名了但
        // 不在当前目录里的名字（60s 缓存过期 / 目录漂移），必须让用户看见。
        setToolNote(
          ignored.length > 0
            ? `${t('ri.toolBulkDone', { n: changed })} ${t('ri.toolBulkIgnored', { n: ignored.length })}`
            : t('ri.toolBulkDone', { n: changed }),
        )
        loadMcp()
      } catch (err) {
        setToolErr(err instanceof Error ? err.message : String(err))
        loadMcp()
      } finally {
        setBulkBusy((prev) => ({ ...prev, [serverName]: false }))
      }
    },
    [loadMcp, t],
  )

  const toolToggle = useCallback(async (row: McpRow, tool: NonNullable<McpRow['toolList']>[number]) => {
    const key = `${row.entryId}:${tool.name}`
    setToolBusy((prev) => ({ ...prev, [key]: true }))
    setToolErr(null)
    // 复用模块级 token 缓存（进程级随机令牌不变；避免每次点击多一次往返）
    const token = await ensureToolToken()
    const headers: Record<string, string> = { 'content-type': 'application/json' }
    if (token) headers['x-panel-token'] = token
    fetch('/api/mcp-skill-panel/mcp/toolToggle', {
      method: 'POST',
      headers,
      body: JSON.stringify({ serverName: row.serverName, toolName: tool.name, disabled: !tool.disabled }),
    })
      .then((res) => res.json() as Promise<{ ok: boolean; error?: string }>)
      .then((body) => {
        if (!body.ok) throw new Error(body.error ?? 'tool toggle failed')
        loadMcp()
      })
      .catch((err: unknown) => {
        setToolErr(err instanceof Error ? err.message : String(err))
        loadMcp()
      })
      .finally(() => setToolBusy((prev) => ({ ...prev, [key]: false })))
  }, [])

  return (
    <>
      <div style={C.stats}>
        <div style={C.stat}>
          <span style={C.statValue}>{state.mcpTotal}</span>
          <span style={C.statLabel}>{t('ri.statMcpServers', { n: state.mcpTotal })}</span>
        </div>
        <div style={C.stat}>
          <span style={C.statValue}>{state.mcpDisabled}</span>
          <span style={C.statLabel}>{t('ri.statMcpDisabled', { n: state.mcpDisabled })}</span>
        </div>
        {/* 有效统计（0.6.0，PR #17 特性 2）：分子是**工具级启用数**（扣掉工具级禁用），
            分母是该 server 注册的工具总数。注意口径边界 —— server 级隐藏（AI 临时启用 /
            中间层 hideAll）与 project-mcp 工作区过滤都不在这个数里，所以文案不说
            「实际进入上下文」。批量禁用后这里立刻变化，这是该操作唯一的可见反馈。 */}
        <div style={C.stat} title={t('ri.toolEnabledCaliber')}>
          <span style={C.statValue}>
            {state.mcpToolsEnabledTotal}
            {state.mcpToolsEnabledTotal !== state.mcpToolsTotal && (
              <span style={{ fontSize: 12, fontWeight: 400, color: 'var(--dsw-alias-label-tertiary)' }}>
                {' '}/ {state.mcpToolsTotal}
              </span>
            )}
          </span>
          <span style={C.statLabel}>
            {t('ri.statMcpToolsEffective', { enabled: state.mcpToolsEnabledTotal, total: state.mcpToolsTotal })}
          </span>
        </div>
        <div style={C.stat} title={t('ri.toolEnabledCaliber')}>
          <span style={C.statValue}>~{formatK(state.mcpTokensEnabledTotal)}k</span>
          <span style={C.statLabel}>
            {t('ri.statMcpTokensEffective', {
              enabled: formatK(state.mcpTokensEnabledTotal),
              total: formatK(state.mcpTokensTotal),
            })}
          </span>
        </div>
        {/* 工具预算（特性 3）：全部工具（含非 MCP），口径来源由 toolsAllSource 标注 */}
        <div style={C.stat}>
          <span style={{ ...C.statValue, color: overBudget ? 'var(--dsw-alias-state-error-primary)' : undefined }}>
            {state.toolsAllEnabled}
            {state.toolBudget !== null && (
              <span style={{ fontSize: 12, fontWeight: 400, color: 'var(--dsw-alias-label-tertiary)' }}>
                {' '}/ {state.toolBudget}
              </span>
            )}
          </span>
          <span style={C.statLabel}>{t('ri.statToolsAll', { n: state.toolsAllEnabled })}</span>
        </div>
      </div>
      <BudgetCard state={state} t={t} loadMcp={loadMcp} />
      {toolErr && <div style={C.error}>{toolErr}</div>}
      {toolNote && <p style={C.toolNote}>{toolNote}</p>}
      {state.mcp.length === 0 && <div style={C.empty}>{t('ri.empty')}</div>}
      {state.mcp.map((row) => {
        const st = statusOf(row)
        const isBusy = busy[`mcp:${row.rowId}`]
        // 有效状态：next-session 且有待生效意图时按意图显示/动作（按钮=翻转意图，可撤销）；
        // immediate 或无 pending 时 = live disabled（原行为）。
        const effDisabled = applyMode === 'next-session' && row.pending ? (row.desired ?? row.disabled) : row.disabled
        const isOpen = Boolean(expanded[row.entryId])
        const toolList = row.toolList ?? []
        // 过滤同时匹配工具名与描述：「和某个 use case 有关的工具」比记全名更常见。
        const filterText = toolFilter[row.entryId] ?? ''
        const needle = filterText.trim().toLowerCase()
        const filtered = needle.length > 0
        const visibleTools = filtered
          ? toolList.filter(
              (tool) => tool.name.toLowerCase().includes(needle) || tool.description.toLowerCase().includes(needle),
            )
          : toolList
        const isBulkBusy = Boolean(bulkBusy[row.serverName])
        // 批量发参：一律给**显式全名数组**（后端 toolNames 缺省 = 全部，绝不能让字段缺失）。
        // 「全部」= 本 server 的全量名单；「按当前过滤」= 筛出名单，筛出 0 项时天然是 []，
        // 即后端的合法空操作（不写盘、changed=0）。
        const allToolNames = toolList.map((tool) => tool.name)
        const filteredToolNames = visibleTools.map((tool) => tool.name)
        return (
          <div key={row.entryId} style={C.card}>
            <div style={C.cardTop}>
              <h3 style={C.cardTitle}>
                {row.serverName}
                <Badge color={st.color} bg={st.bg} title={st.title}>
                  {st.label}
                </Badge>
                {row.pending && (
                  <Badge color="var(--dsw-alias-state-warn-primary)" bg="var(--dsw-alias-state-warn-tertiary)">
                    {t('ri.pendingBadge')}
                  </Badge>
                )}
                {row.aiOwned && (
                  <Badge
                    color="var(--dsw-alias-state-warn-primary)"
                    bg="var(--dsw-alias-state-warn-tertiary)"
                    title={t('ri.aiOwnedHint')}
                  >
                    {t('ri.aiOwnedBadge')}
                  </Badge>
                )}
                {/* 模型面可见性三态（0.6.0 收口）：此前只看 row.modelVisible（= 启用且非
                    AI 临时启用），在 middleLayerHides='all' 且本会话 gate 打开时会把
                    「经中间层取用」误标成「模型可见」（filter.ts:82 已把工具全部剔除）。
                    停用行照旧不挂徽标（保持原行为）。 */}
                {!row.disabled &&
                  (row.modelVisibleScope === 'direct' ? (
                    <Badge color="var(--dsw-alias-state-info-primary, #4a90d9)" bg="var(--dsw-alias-state-info-tertiary, rgba(74,144,217,0.15))">
                      {t('ri.modelVisible')}
                    </Badge>
                  ) : row.modelVisibleScope === 'via-middle-layer' ? (
                    <Badge
                      color="var(--dsw-alias-state-info-primary, #4a90d9)"
                      bg="var(--dsw-alias-state-info-tertiary, rgba(74,144,217,0.15))"
                      title={t('ri.modelViaMiddleLayerHint')}
                    >
                      {t('ri.modelViaMiddleLayer')}
                    </Badge>
                  ) : (
                    <Badge color="var(--dsw-alias-label-tertiary)" bg="var(--dsw-alias-fill-l2, var(--dsw-alias-bg-layer-2))">
                      {t('ri.modelHidden')}
                    </Badge>
                  ))}
              </h3>
              <button
                type="button"
                style={{ ...C.toggle(effDisabled), ...(isBusy ? C.toggleDisabled : {}) }}
                disabled={isBusy}
                onClick={() => onToggle(row)}
              >
                {isBusy ? t('ri.pending') : effDisabled ? t('ri.enable') : t('ri.disable')}
              </button>
            </div>
            <div style={C.cardMeta}>
              {t('ri.toolsCount', { n: row.tools })} · {t('ri.tokensCount', { n: formatK(row.tokens) })}
              {row.transport ? ` · ${t('ri.transport')}: ${row.transport}` : ''}
              {row.workspace ? ` · ${t('ri.projectBadge')}: ${row.workspace}` : ''}
            </div>
            <p style={C.hint}>
              {row.pending
                ? t('ri.applyDeferredHint')
                : row.disabled
                  ? t('ri.toggleOnHint')
                  : t('ri.toggleOffHint')
              }
            </p>
            {toolList.length > 0 && (
              <>
                <button
                  type="button"
                  style={C.toolToggleBtn}
                  title={t('ri.toolEnabledCaliber')}
                  onClick={() => setExpanded((prev) => ({ ...prev, [row.entryId]: !prev[row.entryId] }))}
                >
                  {isOpen
                    ? `▾ ${t('ri.toolListHide')} (${row.toolsEnabled}/${toolList.length})`
                    : `▸ ${t('ri.toolListShow')} (${row.toolsEnabled}/${toolList.length})`}
                </button>                {isOpen && (
                  <>
                    {/* 0.6.0 特性 1：过滤 + 批量启停。「全部」作用于全量名单，「筛出的 N 个」
                        作用于当前过滤结果；有过滤词但 0 命中时后两个按钮禁用 —— 否则用户
                        会以为点下去做了点什么（实际只会是一次空操作）。 */}
                    <div style={C.toolBar}>
                      <input
                        style={C.toolFilterInput}
                        placeholder={t('ri.toolFilter')}
                        value={filterText}
                        onChange={(event) => setToolFilter((prev) => ({ ...prev, [row.entryId]: event.target.value }))}
                      />
                      <button
                        type="button"
                        style={C.bulkBtn(isBulkBusy)}
                        disabled={isBulkBusy}
                        onClick={() => void toolBulk(row.serverName, true, allToolNames)}
                      >
                        {t('ri.toolBulkDisableAll')}
                      </button>
                      <button
                        type="button"
                        style={C.bulkBtn(isBulkBusy)}
                        disabled={isBulkBusy}
                        onClick={() => void toolBulk(row.serverName, false, allToolNames)}
                      >
                        {t('ri.toolBulkEnableAll')}
                      </button>
                      {filtered && (
                        <>
                          <button
                            type="button"
                            style={C.bulkBtn(isBulkBusy || filteredToolNames.length === 0)}
                            disabled={isBulkBusy || filteredToolNames.length === 0}
                            onClick={() => void toolBulk(row.serverName, true, filteredToolNames)}
                          >
                            {t('ri.toolBulkDisableFiltered', { n: filteredToolNames.length })}
                          </button>
                          <button
                            type="button"
                            style={C.bulkBtn(isBulkBusy || filteredToolNames.length === 0)}
                            disabled={isBulkBusy || filteredToolNames.length === 0}
                            onClick={() => void toolBulk(row.serverName, false, filteredToolNames)}
                          >
                            {t('ri.toolBulkEnableFiltered', { n: filteredToolNames.length })}
                          </button>
                        </>
                      )}
                      <span style={{ fontSize: 11, color: 'var(--dsw-alias-label-tertiary)' }}>
                        {t('ri.toolEnabledOf', { enabled: row.toolsEnabled, total: toolList.length })}
                      </span>
                    </div>
                    <div style={C.toolList}>
                      {visibleTools.length === 0 && (
                        <div style={{ fontSize: 12, color: 'var(--dsw-alias-label-tertiary)' }}>{t('ri.toolNoMatch')}</div>
                      )}
                      {visibleTools.map((tool) => {
                        const tBusy = toolBusy[`${row.entryId}:${tool.name}`]
                        return (
                          <div key={tool.name} style={C.toolRow}>
                            <button
                              type="button"
                              style={{ ...C.toolSwitch(tool.disabled), ...(tBusy ? C.toggleDisabled : {}) }}
                              disabled={tBusy}
                              onClick={() => void toolToggle(row, tool)}
                            >
                              {tBusy ? t('ri.pending') : tool.disabled ? t('ri.enable') : t('ri.disable')}
                            </button>
                            <span style={C.toolName}>{tool.name.replace(/^mcp__[^_]+__/, '')}</span>
                            <span style={C.toolDesc}>{tool.description || '—'}</span>
                          </div>
                        )
                      })}
                    </div>
                  </>
                )}
              </>
            )}
            {/* 0.6.0：更多配置（cwd/command/args/env/url/headers…）。对 codegraph 这类
                按 cwd 认项目的 MCP 是必需入口 —— 缺 cwd 时表现为"行在跑却零工具"。 */}
            <button type="button" style={C.toolToggleBtn} onClick={() => setCfgRow(row)}>
              {t('ri.moreConfig')}
            </button>
          </div>
        )
      })}
      {cfgRow && (
        <RowConfigModal
          t={t}
          row={cfgRow}
          applyMode={applyMode}
          onClose={() => setCfgRow(null)}
          onSaved={() => {
            loadMcp()
          }}
        />
      )}
    </>
  )
}

/**
 * 0.6.0「更多配置」抽屉：编辑某个 MCP 行的挂载配置。
 *
 * 形态取三种字段的**字符串编辑**（args 每行一项、env/headers 每行 k=v），
 * 与后端 white-list（preset.EDITABLE_CONFIG_KEYS）一一对应：
 * cwd 缺失是 codegraph 类 MCP"零工具"的典型根因，所以 cwd 单独给一行显眼位置。
 *
 * 保存语义由后端三段式决定：热应用（即时生效）+ 意图落盘（重启不丢）+ 启动物化。
 */
function RowConfigModal(props: {
  t: Props['t']
  row: McpRow
  applyMode: 'immediate' | 'next-session'
  onClose: () => void
  onSaved: () => void
}): React.ReactElement {
  const { t, row, applyMode, onClose, onSaved } = props
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [transport, setTransport] = useState('stdio')
  const [command, setCommand] = useState('')
  const [argsText, setArgsText] = useState('')
  const [cwd, setCwd] = useState('')
  const [envText, setEnvText] = useState('')
  const [url, setUrl] = useState('')
  const [headersText, setHeadersText] = useState('')
  const [timeoutMs, setTimeoutMs] = useState('')
  const [failOnStartup, setFailOnStartup] = useState('')
  const [liveMissingCwd, setLiveMissingCwd] = useState(false)

  const authHeaders = useCallback(async (): Promise<Record<string, string>> => {
    const h: Record<string, string> = { 'content-type': 'application/json' }
    const token = await ensureToolToken()
    if (token) h['x-panel-token'] = token
    return h
  }, [])

  const applyConfig = useCallback((config: Record<string, unknown>, intent?: Record<string, unknown>) => {
    const str = (v: unknown): string => (v === undefined || v === null ? '' : String(v))
    setTransport(str(config.transport) || 'stdio')
    setCommand(str(config.command))
    setArgsText(Array.isArray(config.args) ? (config.args as unknown[]).map(str).join('\n') : '')
    setCwd(str(config.cwd))
    setUrl(str(config.url))
    const mapText = (v: unknown): string =>
      v && typeof v === 'object' && !Array.isArray(v)
        ? Object.entries(v as Record<string, unknown>)
            .map(([k, val]) => `${k}=${str(val)}`)
            .join('\n')
        : ''
    setEnvText(mapText(config.env))
    setHeadersText(mapText(config.headers))
    setTimeoutMs(config.toolCallTimeoutMs === undefined ? '' : str(config.toolCallTimeoutMs))
    setFailOnStartup(config.failOnStartupError === undefined ? '' : String(config.failOnStartupError))
    // 缺 cwd 且是 stdio → 这是 codegraph 类故障的典型特征，给出针对性提示
    const missing = (config.cwd === undefined || str(config.cwd) === '') && (str(config.transport) === 'stdio' || config.command !== undefined)
    setLiveMissingCwd(missing)
    void intent
  }, [])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const headers = await authHeaders()
        const res = await fetch(`/api/mcp-skill-panel/mcp/rowConfig?server=${encodeURIComponent(row.serverName)}`, { headers })
        const body = (await res.json()) as { ok: boolean; error?: string; config?: Record<string, unknown> }
        if (!body.ok) throw new Error(body.error ?? 'load failed')
        if (cancelled) return
        applyConfig(body.config ?? {})
      } catch (e: unknown) {
        if (!cancelled) setErr(e instanceof Error ? e.message : String(e))
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [row.serverName, authHeaders, applyConfig])

  const parseMap = (text: string, label: string): Record<string, string> | undefined => {
    const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
    if (lines.length === 0) return undefined
    const out: Record<string, string> = {}
    for (const line of lines) {
      const at = line.indexOf('=')
      if (at <= 0) throw new Error(`${label} 的每一行需为 key=value：${line}`)
      out[line.slice(0, at).trim()] = line.slice(at + 1).trim()
    }
    return out
  }

  const save = async (): Promise<void> => {
    setSaving(true)
    setErr(null)
    setNote(null)
    try {
      const set: Record<string, unknown> = { transport }
      const unset: string[] = []
      if (transport === 'stdio') {
        set.command = command.trim()
        set.args = argsText.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
        if (cwd.trim()) set.cwd = cwd.trim()
        else unset.push('cwd')
        unset.push('url', 'headers')
      } else {
        set.url = url.trim()
        const h = parseMap(headersText, 'headers')
        if (h) set.headers = h
        else unset.push('headers')
        unset.push('command', 'args', 'cwd')
      }
      const env = parseMap(envText, 'env')
      if (env) set.env = env
      else unset.push('env')
      if (timeoutMs.trim()) {
        const n = Number(timeoutMs.trim())
        if (!Number.isFinite(n) || n <= 0) throw new Error('toolCallTimeoutMs 必须是正数')
        set.toolCallTimeoutMs = n
      } else {
        unset.push('toolCallTimeoutMs')
      }
      if (failOnStartup === 'true' || failOnStartup === 'false') set.failOnStartupError = failOnStartup === 'true'
      else unset.push('failOnStartupError')

      const headers = await authHeaders()
      const res = await fetch('/api/mcp-skill-panel/mcp/rowConfig', {
        method: 'POST',
        headers,
        body: JSON.stringify({ server: row.serverName, set, unset }),
      })
      const body = (await res.json()) as { ok: boolean; error?: string; applied?: { ok: boolean; error?: string } }
      if (!body.ok) throw new Error(body.error ?? 'save failed')
      const applied = body.applied
      if (applied && !applied.ok) {
        setNote(t('ri.cfgSavedRestart', { err: applied.error ?? '—' }))
      } else {
        setNote(t('ri.cfgSavedLive'))
      }
      onSaved()
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  const field = (label: string, value: string, onChange: (v: string) => void, placeholder?: string): React.ReactElement => (
    <label style={C.cfgField}>
      <span style={C.cfgLabel}>{label}</span>
      <input style={C.cfgInput} value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />
    </label>
  )
  const area = (label: string, value: string, onChange: (v: string) => void, placeholder?: string): React.ReactElement => (
    <label style={C.cfgField}>
      <span style={C.cfgLabel}>{label}</span>
      <textarea style={C.cfgArea} value={value} placeholder={placeholder} rows={3} onChange={(e) => onChange(e.target.value)} />
    </label>
  )

  return (
    <div style={C.modalMask} role="dialog" aria-modal="true">
      <div style={C.modal}>
        <div style={C.cardTop}>
          <h3 style={C.cardTitle}>
            {t('ri.cfgTitle')} · {row.serverName}
          </h3>
          <button type="button" style={C.toolToggleBtn} onClick={onClose}>
            {t('ri.cfgClose')}
          </button>
        </div>
        {loading && <div style={C.empty}>{t('ri.loading')}</div>}
        {err && <div style={C.error}>{err}</div>}
        {note && <div style={C.hint}>{note}</div>}
        {!loading && (
          <>
            {liveMissingCwd && <div style={C.hint}>{t('ri.cfgMissingCwdHint')}</div>}
            {applyMode === 'next-session' && <div style={C.hint}>{t('ri.cfgNextSessionHint')}</div>}
            {field(t('ri.cfgTransport'), transport, (v) => setTransport(v.trim()), 'stdio')}
            {transport === 'stdio' ? (
              <>
                {field(t('ri.cfgCommand'), command, setCommand, 'codegraph')}
                {area(t('ri.cfgArgs'), argsText, setArgsText, 'serve\n--mcp')}
                {field(t('ri.cfgCwd'), cwd, setCwd, 'D:\\path\\to\\project')}
              </>
            ) : (
              <>
                {field(t('ri.cfgUrl'), url, setUrl, 'http://127.0.0.1:12306/mcp')}
                {area(t('ri.cfgHeaders'), headersText, setHeadersText, 'Authorization=Bearer …')}
              </>
            )}
            {area(t('ri.cfgEnv'), envText, setEnvText, 'API_KEY=…')}
            {field(t('ri.cfgTimeout'), timeoutMs, setTimeoutMs, '60000')}
            {field(t('ri.cfgFailOnStartup'), failOnStartup, setFailOnStartup, 'true | false')}
            <div style={C.cardTop}>
              <button type="button" style={{ ...C.toggle(false), ...(saving ? C.toggleDisabled : {}) }} disabled={saving} onClick={() => void save()}>
                {saving ? t('ri.pending') : t('ri.cfgSave')}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

function SkillPanel(props: {
  state: SkillsView
  t: Props['t']
  busy: Record<string, boolean>
  onToggle: (row: SkillRow) => void
}): React.ReactElement {
  const { state, t, busy, onToggle } = props
  return (
    <>
      <div style={C.stats}>
        <div style={C.stat}>
          <span style={C.statValue}>{state.skillsTotal}</span>
          <span style={C.statLabel}>{t('ri.statSkills', { n: state.skillsTotal })}</span>
        </div>
        <div style={C.stat}>
          <span style={C.statValue}>{state.skillsModelVisible}</span>
          <span style={C.statLabel}>{t('ri.statSkillsVisible', { n: state.skillsModelVisible })}</span>
        </div>
      </div>
      {state.skills.length === 0 && <div style={C.empty}>{t('ri.empty')}</div>}
      {state.skills.map((row) => {
        const isBusy = busy[`skill:${row.name}`]
        const visible = row.modelInvocable
        return (
          <div key={row.name} style={C.card}>
            <div style={C.cardTop}>
              <h3 style={C.cardTitle}>
                {row.name}
                <Badge
                  color={visible ? 'var(--dsw-alias-state-success-primary)' : 'var(--dsw-alias-label-tertiary)'}
                  bg={visible ? 'var(--dsw-alias-state-success-tertiary)' : 'var(--dsw-alias-fill-l2, var(--dsw-alias-bg-layer-2))'}
                >
                  {visible ? t('ri.modelVisible') : t('ri.modelHidden')}
                </Badge>
              </h3>
              <button
                type="button"
                style={{ ...C.toggle(visible), ...(isBusy ? C.toggleDisabled : {}) }}
                disabled={isBusy}
                onClick={() => onToggle(row)}
              >
                {isBusy ? t('ri.pending') : visible ? t('ri.disable') : t('ri.enable')}
              </button>
            </div>
            <p style={C.cardDesc}>{row.description}</p>
            <div style={C.cardMeta}>
              {t('ri.skillSource', { source: row.source })}
              {row.userInvocable ? ` · ${t('ri.userVisible')}` : ''}
            </div>
            <p style={C.hint}>{visible ? t('ri.skillToggleOffHint') : t('ri.skillToggleOnHint')}</p>
          </div>
        )
      })}
    </>
  )
}
