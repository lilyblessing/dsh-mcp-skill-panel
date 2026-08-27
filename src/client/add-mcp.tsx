/**
 * 添加 MCP 弹窗（快速迁移）：粘贴其它 harness 的 mcpServers JSON，
 * 在弹窗内选择「全局 / 项目」目标，转换预览后确认添加。
 *
 * - 全局：写入 <profile>/cordis.patch.yml（- insert: 块，${VAR} → !!js 表达式）+ 立即挂载
 * - 项目：写入 <workspace>/.dsh/mcps/mcp.json（与子目录扫描去重规则一致）+ 重扫挂载
 * 全部逻辑（token / 预览 / 添加 / 结果展示）都在本组件内部，对 views.tsx 零侵入。
 * 样式走宿主 --dsw-alias-* 主题变量（与 views.tsx 一致），本地私有 C，不导出。
 */
import React, { useCallback, useRef, useState } from 'react'

interface Props {
  /** locale 翻译函数（由父级传入，保持与宿主 locale 插槽一致）。 */
  t: (key: string, params?: Record<string, string | number>) => string
  /** 当前会话工作空间（cwd）；null = 无会话上下文，此时禁止「项目」目标。 */
  workspace: string | null
  /** 关闭弹窗。 */
  onClose: () => void
  /** 添加成功（含部分成功）后回调：父级负责刷新 MCP 列表。 */
  onAdded: () => void
}

const C = {
  overlay: {
    position: 'fixed' as const,
    inset: 0,
    background: 'rgba(0, 0, 0, 0.45)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 1000,
  },
  modal: {
    width: 'min(680px, calc(100vw - 48px))',
    maxHeight: 'calc(100vh - 80px)',
    overflowY: 'auto' as const,
    background: 'var(--dsw-alias-bg-layer-1)',
    border: '1px solid var(--dsw-alias-border-l2)',
    borderRadius: 10,
    padding: '16px 18px',
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 12,
    boxShadow: '0 8px 30px rgba(0,0,0,0.25)',
  },
  title: {
    margin: 0,
    fontSize: 16,
    fontWeight: 600,
    color: 'var(--dsw-alias-label-primary)',
  },
  textarea: {
    font: 'inherit',
    fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace',
    fontSize: 12,
    lineHeight: '18px',
    background: 'var(--dsw-alias-bg-layer-2)',
    color: 'var(--dsw-alias-label-primary)',
    border: '1px solid var(--dsw-alias-border-l2)',
    borderRadius: 6,
    padding: '8px 10px',
    resize: 'vertical' as const,
    minHeight: 120,
  },
  row: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
  },
  label: {
    fontSize: 12,
    color: 'var(--dsw-alias-label-secondary)',
  },
  tab: (active: boolean): React.CSSProperties => ({
    font: 'inherit',
    cursor: 'pointer',
    border: '1px solid',
    borderRadius: 6,
    padding: '4px 14px',
    fontSize: 12,
    fontWeight: active ? 600 : 400,
    color: active ? 'var(--dsw-alias-label-primary)' : 'var(--dsw-alias-label-tertiary)',
    background: active
      ? 'color-mix(in srgb, var(--dsw-alias-state-info-primary, #4a90d9) 16%, transparent)'
      : 'transparent',
    borderColor: active ? 'var(--dsw-alias-state-info-primary, #4a90d9)' : 'var(--dsw-alias-border-l2)',
  }),
  hint: {
    margin: 0,
    fontSize: 11,
    color: 'var(--dsw-alias-label-tertiary)',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap' as const,
  },
  action: {
    font: 'inherit',
    cursor: 'pointer',
    border: '1px solid var(--dsw-alias-border-l2)',
    background: 'var(--dsw-alias-bg-layer-1)',
    color: 'var(--dsw-alias-label-secondary)',
    borderRadius: 6,
    padding: '5px 14px',
    fontSize: 12,
  },
  primary: {
    font: 'inherit',
    cursor: 'pointer',
    border: 0,
    borderRadius: 6,
    padding: '5px 16px',
    fontSize: 12,
    color: 'var(--dsw-alias-label-inverse, #fff)',
    background: 'var(--dsw-alias-state-success-primary)',
  },
  primaryDisabled: {
    opacity: 0.55,
    cursor: 'progress',
  } as React.CSSProperties,
  error: {
    fontSize: 12,
    color: 'var(--dsw-alias-label-primary)',
    background: 'color-mix(in srgb, var(--dsw-alias-state-error-primary) 14%, transparent)',
    borderLeft: '3px solid var(--dsw-alias-state-error-primary)',
    borderRadius: 6,
    padding: '8px 10px',
  },
  success: {
    fontSize: 12,
    color: 'var(--dsw-alias-label-primary)',
    background: 'color-mix(in srgb, var(--dsw-alias-state-success-primary) 14%, transparent)',
    borderLeft: '3px solid var(--dsw-alias-state-success-primary)',
    borderRadius: 6,
    padding: '8px 10px',
  },
  pre: {
    margin: 0,
    maxHeight: 220,
    overflow: 'auto',
    fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace',
    fontSize: 11,
    lineHeight: '16px',
    color: 'var(--dsw-alias-label-secondary)',
    background: 'var(--dsw-alias-bg-layer-2)',
    border: '1px solid var(--dsw-alias-border-l2)',
    borderRadius: 6,
    padding: '8px 10px',
    whiteSpace: 'pre-wrap' as const,
  },
  footer: {
    display: 'flex',
    justifyContent: 'flex-end',
    gap: 8,
  },
}

export function AddMcpModal(props: Props): React.ReactElement {
  const { t, workspace, onClose, onAdded } = props
  const [json, setJson] = useState('')
  const [target, setTarget] = useState<'global' | 'project'>('global')
  const [preview, setPreview] = useState<{ names: string[]; yaml: string } | null>(null)
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null)
  const [busy, setBusy] = useState<'preview' | 'add' | null>(null)

  // 进程级 token：所有 POST 前取一次并缓存（服务端随机令牌，阻断跨源盲写）
  const tokenPromise = useRef<Promise<string | null> | null>(null)
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
    async (path: string, payload: Record<string, unknown>): Promise<{ ok: boolean; [key: string]: unknown }> => {
      const token = await ensureToken()
      const headers: Record<string, string> = { 'content-type': 'application/json' }
      if (token) headers['x-panel-token'] = token
      const res = await fetch(path, { method: 'POST', headers, body: JSON.stringify(payload) })
      return (await res.json()) as { ok: boolean; [key: string]: unknown }
    },
    [ensureToken],
  )

  const doPreview = useCallback(async () => {
    setBusy('preview')
    setResult(null)
    setPreview(null)
    try {
      const body = await post('/api/mcp-skill-panel/mcp/preview', { json })
      if (!body.ok || typeof body.yaml !== 'string') {
        throw new Error(typeof body.error === 'string' ? body.error : 'preview failed')
      }
      setPreview({ names: Array.isArray(body.names) ? (body.names as string[]) : [], yaml: body.yaml })
    } catch (error) {
      setResult({ ok: false, text: t('ri.addMcpError', { error: error instanceof Error ? error.message : String(error) }) })
    } finally {
      setBusy(null)
    }
  }, [post, json, t])

  const doAdd = useCallback(async () => {
    if (!json.trim()) return
    setBusy('add')
    setResult(null)
    try {
      // 项目目标不提交 workspace：由后端取「最近进入会话的工作区」写入（随切换实时），
      // 避免面板缓存的工作区过期导致加到旧项目。workspace prop 仅作展示提示。
      const payload: Record<string, unknown> = { json, target }
      const body = await post('/api/mcp-skill-panel/mcp/add', payload)
      if (!body.ok || typeof body.added !== 'number') {
        throw new Error(typeof body.error === 'string' ? body.error : 'add failed')
      }
      // 成功（含部分成功：部分已存在/挂载失败被跳过）：关闭弹窗，父级刷新列表
      onAdded()
      onClose()
    } catch (error) {
      // 失败：留在弹窗内展示原因（JSON 转换失败、已全部存在、挂载失败等）
      setResult({ ok: false, text: t('ri.addMcpError', { error: error instanceof Error ? error.message : String(error) }) })
    } finally {
      setBusy(null)
    }
  }, [post, json, target, workspace, t, onAdded, onClose])

  return (
    <div style={C.overlay} role="dialog" aria-modal="true" onClick={onClose}>
      <div style={C.modal} onClick={(event) => event.stopPropagation()}>
        <h3 style={C.title}>{t('ri.addMcp')}</h3>
        <p style={C.hint}>{t('ri.addMcpPasteHint')}</p>

        <textarea
          value={json}
          onChange={(event) => setJson(event.target.value)}
          placeholder={'{ "mcpServers": { "my-server": { "command": "…" } } }'}
          style={C.textarea}
          rows={7}
          spellCheck={false}
        />

        <div style={C.row}>
          <span style={C.label}>{t('ri.addMcpTarget')}</span>
          <button type="button" style={C.tab(target === 'global')} onClick={() => setTarget('global')}>
            {t('ri.addMcpTargetGlobal')}
          </button>
          <button
            type="button"
            style={{ ...C.tab(target === 'project'), ...(workspace ? {} : { opacity: 0.5, cursor: 'not-allowed' }) }}
            disabled={!workspace}
            onClick={() => setTarget('project')}
          >
            {t('ri.addMcpTargetProject')}
          </button>
          {target === 'project' && (
            <span style={{ ...C.hint, flex: 1 }}>
              {workspace ? `${t('ri.cwd')}: ${workspace}` : t('ri.addMcpNoWorkspace')}
            </span>
          )}
        </div>

        <div style={C.row}>
          <button type="button" style={C.action} disabled={busy !== null} onClick={() => void doPreview()}>
            {busy === 'preview' ? t('ri.pending') : t('ri.addMcpPreview')}
          </button>
          <span style={C.hint}>{preview ? `${t('ri.addMcpPreviewNames')}: ${preview.names.join(', ')}` : ''}</span>
        </div>

        {result && <div style={result.ok ? C.success : C.error}>{result.text}</div>}
        {preview && <pre style={C.pre}>{preview.yaml}</pre>}

        <div style={C.footer}>
          <button type="button" style={C.action} disabled={busy !== null} onClick={onClose}>
            {t('ri.addMcpCancel')}
          </button>
          <button
            type="button"
            style={{ ...C.primary, ...(busy !== null ? C.primaryDisabled : {}) }}
            disabled={busy !== null}
            onClick={() => void doAdd()}
          >
            {busy === 'add' ? t('ri.pending') : t('ri.addMcpConfirm')}
          </button>
        </div>
      </div>
    </div>
  )
}
