/**
 * MCP 与技能管理面板：MCP 服务器 / 技能 双标签页，统计头 + 卡片 + 启停开关。
 * 样式全部 JS 内联（宿主全局 CSS 可能覆盖注入的 class），颜色走 --dsw-alias-* 主题变量。
 * 视图形状类型来自 shared-types（与 host 单一来源，type-only import 不打包）。
 */
import React, { useCallback, useEffect, useState } from 'react'
import type { McpRow, McpView, SkillRow, SkillsView } from '../shared-types'

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
    color: 'var(--dsw-alias-state-error-primary)',
    background: 'var(--dsw-alias-state-error-secondary)',
    borderRadius: 6,
    padding: '8px 10px',
  },
  empty: {
    fontSize: 13,
    color: 'var(--dsw-alias-label-tertiary)',
    padding: '16px 0',
    textAlign: 'center' as const,
  },
}

function formatK(n: number): string {
  return n >= 1000 ? (n / 1000).toFixed(1).replace(/\.0$/, '') : String(n)
}

export function RuntimeInventorySection(props: Props): React.ReactElement {
  const { t } = props
  const [tab, setTab] = useState<'mcp' | 'skill'>('mcp')
  const [mcp, setMcp] = useState<McpView | null>(null)
  const [skills, setSkills] = useState<SkillsView | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<Record<string, boolean>>({})

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

  const post = useCallback(
    (path: string, payload: Record<string, unknown>, key: string, onOk: () => void) => {
      setBusy((prev) => ({ ...prev, [key]: true }))
      setError(null)
      fetch(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
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
    [t, loadMcp, loadSkills],
  )

  const toggleMcp = (row: McpRow) => {
    post(
      '/api/runtime-inventory/mcp/toggle',
      { entryId: row.entryId, disabled: !row.disabled },
      `mcp:${row.rowId}`,
      () => loadMcp(),
    )
  }

  const toggleAutoManage = () => {
    const next = !(mcp?.autoManage ?? false)
    setBusy((prev) => ({ ...prev, autoManage: true }))
    setError(null)
    fetch('/api/mcp-skill-panel/config', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
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
    post(
      '/api/runtime-inventory/skill/toggle',
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
        <button type="button" style={C.refresh} onClick={() => (tab === 'mcp' ? loadMcp() : loadSkills())}>
          {t('ri.refresh')}
        </button>
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

      {!view && !error && <div style={C.empty}>{t('ri.loading')}</div>}

      {view && tab === 'mcp' && (
        <>
          <AutoManageCard on={(view as McpView).autoManage} busy={Boolean(busy.autoManage)} t={t} onToggle={toggleAutoManage} />
          <McpPanel state={view as McpView} t={t} busy={busy} onToggle={toggleMcp} statusOf={mcpStatus} />
        </>
      )}

      {view && tab === 'skill' && <SkillPanel state={view as SkillsView} t={t} busy={busy} onToggle={toggleSkill} />}
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
          style={{ ...C.toggle(on), ...(busy ? C.toggleDisabled : {}) }}
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

function McpPanel(props: {
  state: McpView
  t: Props['t']
  busy: Record<string, boolean>
  onToggle: (row: McpRow) => void
  statusOf: (row: McpRow) => { label: string; color: string; bg: string }
}): React.ReactElement {
  const { state, t, busy, onToggle, statusOf } = props
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
      {state.mcp.length === 0 && <div style={C.empty}>{t('ri.empty')}</div>}
      {state.mcp.map((row) => {
        const st = statusOf(row)
        const isBusy = busy[`mcp:${row.rowId}`]
        return (
          <div key={row.entryId} style={C.card}>
            <div style={C.cardTop}>
              <h3 style={C.cardTitle}>
                {row.serverName}
                <Badge color={st.color} bg={st.bg}>
                  {st.label}
                </Badge>
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
                style={{ ...C.toggle(row.disabled), ...(isBusy ? C.toggleDisabled : {}) }}
                disabled={isBusy}
                onClick={() => onToggle(row)}
              >
                {isBusy ? t('ri.pending') : row.disabled ? t('ri.enable') : t('ri.disable')}
              </button>
            </div>
            <div style={C.cardMeta}>
              {t('ri.toolsCount', { n: row.tools })} · {t('ri.tokensCount', { n: formatK(row.tokens) })}
              {row.transport ? ` · ${t('ri.transport')}: ${row.transport}` : ''}
            </div>
            <p style={C.hint}>{row.disabled ? t('ri.toggleOnHint') : t('ri.toggleOffHint')}</p>
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
