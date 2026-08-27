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
    (row: McpRow): { label: string; color: string; bg: string } => {
      switch (row.status) {
        case 'active':
          return { label: t('ri.statusActive'), color: 'var(--dsw-alias-state-success-primary)', bg: 'var(--dsw-alias-state-success-tertiary)' }
        case 'disabled':
          return { label: t('ri.statusDisabled'), color: 'var(--dsw-alias-label-tertiary)', bg: 'var(--dsw-alias-fill-l2)' }
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
          <AutoManageCard on={(view as McpView).autoManage} busy={Boolean(busy.autoManage)} t={t} onToggle={toggleAutoManage} />
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
function Badge(props: { color: string; bg: string; children: React.ReactNode }): React.ReactElement {
  return <span style={C.badge(props.color, props.bg)}>{props.children}</span>
}

function AutoManageCard(props: {
  on: boolean
  busy: boolean
  t: Props['t']
  onToggle: () => void
}): React.ReactElement {
  const { on, busy, t, onToggle } = props
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
            bg={on ? 'var(--dsw-alias-state-success-tertiary)' : 'var(--dsw-alias-fill-l2)'}
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
    // 点按钮即弹出账提示，让用户在费用知情下操作。
    showWarn(t('ri.cacheWarn'), true)
    setBusy((prev) => ({ ...prev, applyMode: true }))
    setError(null)
    const token = await ensureToken()
    const headers: Record<string, string> = { 'content-type': 'application/json' }
    if (token) headers['x-panel-token'] = token
    fetch('/api/mcp-skill-panel/mcp/applyPending', { method: 'POST', headers })
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

function McpPanel(props: {
  state: McpView
  t: Props['t']
  busy: Record<string, boolean>
  onToggle: (row: McpRow) => void
  statusOf: (row: McpRow) => { label: string; color: string; bg: string }
  applyMode: 'immediate' | 'next-session'
  loadMcp: () => void
}): React.ReactElement {
  const { state, t, busy, onToggle, statusOf, applyMode, loadMcp } = props
  // 工具级禁用精简：每个 server 展开的工具下拉（已折叠/展开）
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  // 工具行禁用开关临时态（立即生效后由 loadMcp 校准）
  const [toolBusy, setToolBusy] = useState<Record<string, boolean>>({})
  const [toolErr, setToolErr] = useState<string | null>(null)

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
        <div style={C.stat}>
          <span style={C.statValue}>{state.mcpToolsTotal}</span>
          <span style={C.statLabel}>{t('ri.statMcpTools', { n: state.mcpToolsTotal })}</span>
        </div>
        <div style={C.stat}>
          <span style={C.statValue}>~{formatK(state.mcpTokensTotal)}k</span>
          <span style={C.statLabel}>{t('ri.statMcpTokens', { n: formatK(state.mcpTokensTotal) })}</span>
        </div>
      </div>
      {toolErr && <div style={C.error}>{toolErr}</div>}
      {state.mcp.length === 0 && <div style={C.empty}>{t('ri.empty')}</div>}
      {state.mcp.map((row) => {
        const st = statusOf(row)
        const isBusy = busy[`mcp:${row.rowId}`]
        // 有效状态：next-session 且有待生效意图时按意图显示/动作（按钮=翻转意图，可撤销）；
        // immediate 或无 pending 时 = live disabled（原行为）。
        const effDisabled = applyMode === 'next-session' && row.pending ? (row.desired ?? row.disabled) : row.disabled
        const isOpen = Boolean(expanded[row.entryId])
        const toolList = row.toolList ?? []
        return (
          <div key={row.entryId} style={C.card}>
            <div style={C.cardTop}>
              <h3 style={C.cardTitle}>
                {row.serverName}
                <Badge color={st.color} bg={st.bg}>
                  {st.label}
                </Badge>
                {row.pending && (
                  <Badge color="var(--dsw-alias-state-warn-primary)" bg="var(--dsw-alias-state-warn-tertiary)">
                    {t('ri.pendingBadge')}
                  </Badge>
                )}
                {row.modelVisible ? (
                  <Badge color="var(--dsw-alias-state-info-primary, #4a90d9)" bg="var(--dsw-alias-state-info-tertiary, rgba(74,144,217,0.15))">
                    {t('ri.modelVisible')}
                  </Badge>
                ) : (
                  !row.disabled && (
                    <Badge color="var(--dsw-alias-label-tertiary)" bg="var(--dsw-alias-fill-l2)">
                      {t('ri.modelHidden')}
                    </Badge>
                  )
                )}
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
                <button type="button" style={C.toolToggleBtn} onClick={() => setExpanded((prev) => ({ ...prev, [row.entryId]: !prev[row.entryId] }))}>
                  {isOpen ? `▾ ${t('ri.toolListHide')} (${toolList.length})` : `▸ ${t('ri.toolListShow')} (${toolList.length})`}
                </button>
                {isOpen && (
                  <div style={C.toolList}>
                    {toolList.map((tool) => {
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
                )}
              </>
            )}
          </div>
        )
      })}
    </>
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
                  bg={visible ? 'var(--dsw-alias-state-success-tertiary)' : 'var(--dsw-alias-fill-l2)'}
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
