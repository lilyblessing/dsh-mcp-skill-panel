/**
 * 创建技能弹窗：名字 / 描述 / 指令（正文）三栏 + 全局/项目目标。
 * 顶部上传区接受单个 SKILL.md / .md 文件 —— 原生解析 frontmatter 预填三栏
 * （零依赖，FileReader.text + 逐行 key: value，不解析 zip）。
 * 指令栏自适应高度：随内容增长，超过上限出滚动条。
 * 全部逻辑（token / 解析 / 提交）在本组件内部，views.tsx 只挂按钮与弹窗。
 */
import React, { useCallback, useRef, useState } from 'react'

interface Props {
  /** locale 翻译函数（由父级传入，与宿主 locale 插槽一致）。 */
  t: (key: string, params?: Record<string, string | number>) => string
  /** 当前会话工作空间（cwd）；null = 无会话上下文，禁止「项目」目标。 */
  workspace: string | null
  /** 关闭弹窗。 */
  onClose: () => void
  /** 创建成功后回调：父级负责刷新技能列表。 */
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
    width: 'min(620px, calc(100vw - 48px))',
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
  header: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  title: {
    margin: 0,
    fontSize: 16,
    fontWeight: 600,
    color: 'var(--dsw-alias-label-primary)',
  },
  close: {
    font: 'inherit',
    cursor: 'pointer',
    border: 0,
    background: 'transparent',
    color: 'var(--dsw-alias-label-tertiary)',
    fontSize: 16,
    lineHeight: 1,
    padding: 4,
  },
  dropzone: (drag: boolean): React.CSSProperties => ({
    border: `1px dashed ${drag ? 'var(--dsw-alias-state-info-primary, #4a90d9)' : 'var(--dsw-alias-border-l2)'}`,
    borderRadius: 8,
    padding: '18px 16px',
    textAlign: 'center' as const,
    cursor: 'pointer',
    background: drag ? 'color-mix(in srgb, var(--dsw-alias-state-info-primary, #4a90d9) 8%, transparent)' : 'transparent',
    display: 'flex',
    flexDirection: 'column' as const,
    alignItems: 'center',
    gap: 6,
  }),
  dropIcon: {
    fontSize: 22,
    color: 'var(--dsw-alias-label-secondary)',
  },
  dropTitle: {
    margin: 0,
    fontSize: 13,
    fontWeight: 600,
    color: 'var(--dsw-alias-label-primary)',
  },
  dropDesc: {
    margin: 0,
    fontSize: 11,
    lineHeight: '16px',
    color: 'var(--dsw-alias-label-tertiary)',
  },
  label: {
    display: 'flex',
    alignItems: 'center',
    gap: 4,
    margin: '0 0 4px',
    fontSize: 12,
    fontWeight: 600,
    color: 'var(--dsw-alias-label-primary)',
  },
  required: {
    color: 'var(--dsw-alias-state-error-primary)',
  },
  input: {
    font: 'inherit',
    width: '100%',
    boxSizing: 'border-box' as const,
    background: 'var(--dsw-alias-bg-layer-2)',
    color: 'var(--dsw-alias-label-primary)',
    border: '1px solid var(--dsw-alias-border-l2)',
    borderRadius: 6,
    padding: '7px 10px',
    fontSize: 12,
  },
  textarea: {
    font: 'inherit',
    width: '100%',
    boxSizing: 'border-box' as const,
    fontFamily: 'inherit',
    background: 'var(--dsw-alias-bg-layer-2)',
    color: 'var(--dsw-alias-label-primary)',
    border: '1px solid var(--dsw-alias-border-l2)',
    borderRadius: 6,
    padding: '7px 10px',
    fontSize: 12,
    lineHeight: '18px',
    resize: 'vertical' as const,
    minHeight: 64,
  },
  bodyTextarea: {
    // 自适应滚动条：随内容增长（autoResize），到 maxHeight 后内部滚动
    overflowY: 'auto' as const,
    resize: 'none' as const,
    minHeight: 160,
    maxHeight: 340,
    fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace',
    whiteSpace: 'pre-wrap' as const,
  },
  row: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
  },
  hint: {
    margin: 0,
    fontSize: 11,
    color: 'var(--dsw-alias-label-tertiary)',
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
  action: {
    font: 'inherit',
    cursor: 'pointer',
    border: '1px solid var(--dsw-alias-border-l2)',
    background: 'var(--dsw-alias-bg-layer-1)',
    color: 'var(--dsw-alias-label-secondary)',
    borderRadius: 6,
    padding: '5px 16px',
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
  disabledButton: {
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
    wordBreak: 'break-all' as const,
  },
  footer: {
    display: 'flex',
    justifyContent: 'flex-end',
    gap: 8,
  },
}

/** 解析单个 SKILL.md 文本：frontmatter 的 name/description + 正文（零依赖逐行解析）。 */
function parseSkillMd(text: string): { name?: string; description?: string; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text)
  if (!m) return { body: text }
  const fields: Record<string, string> = {}
  for (const line of m[1].split(/\r?\n/)) {
    const km = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line)
    if (!km) continue
    let value = km[2].trim()
    if ((value.startsWith('"') && value.endsWith('"') && value.length >= 2) || (value.startsWith("'") && value.endsWith("'") && value.length >= 2)) {
      value = value.slice(1, -1)
    }
    fields[km[1].toLowerCase()] = value
  }
  return { name: fields.name || undefined, description: fields.description || undefined, body: text.slice(m[0].length) }
}

export function AddSkillModal(props: Props): React.ReactElement {
  const { t, workspace, onClose, onAdded } = props
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [body, setBody] = useState('')
  const [target, setTarget] = useState<'global' | 'project'>('global')
  const [drag, setDrag] = useState(false)
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const bodyRef = useRef<HTMLTextAreaElement | null>(null)
  const fileRef = useRef<HTMLInputElement | null>(null)

  // 进程级 token：POST 前取一次并缓存（服务端随机令牌，阻断跨源盲写）
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

  /** 指令栏自适应高度：内容增长撑开，超过 maxHeight 后内部滚动（出现滚动条）。 */
  const autoResize = useCallback(() => {
    const el = bodyRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 340)}px`
  }, [])

  const onChangeBody = useCallback(
    (value: string) => {
      setBody(value)
      autoResize()
    },
    [autoResize],
  )

  /** 上传 .md：原生解析 frontmatter 预填名字/描述，其余进指令栏。 */
  const onFile = useCallback(
    (file: File | undefined | null) => {
      if (!file) return
      void file
        .text()
        .then((text) => {
          const parsed = parseSkillMd(text)
          if (parsed.name && isValidSkillNameClient(parsed.name)) setName(parsed.name)
          if (parsed.description) setDescription(parsed.description)
          setBody(parsed.body)
          setResult(null)
          // 等状态写入后重算高度
          requestAnimationFrame(autoResize)
        })
        .catch((error: unknown) => {
          setResult({ ok: false, text: t('ri.addSkillError', { error: error instanceof Error ? error.message : String(error) }) })
        })
    },
    [autoResize, t],
  )

  const nameValid = isValidSkillNameClient(name)

  const submit = useCallback(async () => {
    if (!nameValid || description.trim().length === 0 || body.trim().length === 0) return
    setBusy(true)
    setResult(null)
    try {
      const token = await ensureToken()
      const headers: Record<string, string> = { 'content-type': 'application/json' }
      if (token) headers['x-panel-token'] = token
      const res = await fetch('/api/mcp-skill-panel/skill/add', {
        method: 'POST',
        headers,
        body: JSON.stringify({ name, description, body, target, workspace: workspace ?? undefined }),
      })
      const data = (await res.json()) as { ok: boolean; path?: string; error?: string }
      if (!data.ok || !data.path) throw new Error(data.error ?? 'add skill failed')
      // 成功：关闭弹窗（父级 onAdded 负责刷新列表）
      onAdded()
      onClose()
    } catch (error) {
      // 失败：留在弹窗内展示原因（服务端错误、名字冲突、目标不可写等）
      setResult({ ok: false, text: t('ri.addSkillError', { error: error instanceof Error ? error.message : String(error) }) })
    } finally {
      setBusy(false)
    }
  }, [nameValid, name, description, body, target, workspace, ensureToken, t, onAdded, onClose])

  return (
    <div style={C.overlay} role="dialog" aria-modal="true" onClick={onClose}>
      <div style={C.modal} onClick={(event) => event.stopPropagation()}>
        <div style={C.header}>
          <h3 style={C.title}>{t('ri.addSkill')}</h3>
          <button type="button" style={C.close} aria-label={t('ri.addSkillCancel')} onClick={onClose}>
            ✕
          </button>
        </div>

        {/* 上传区（仅 .md 原生解析，不解析 zip）：点击选择或拖入 */}
        <div
          style={C.dropzone(drag)}
          onClick={() => fileRef.current?.click()}
          onDragOver={(event) => {
            event.preventDefault()
            setDrag(true)
          }}
          onDragLeave={() => setDrag(false)}
          onDrop={(event) => {
            event.preventDefault()
            setDrag(false)
            onFile(event.dataTransfer.files?.[0])
          }}
        >
          <span style={C.dropIcon}>⬆</span>
          <p style={C.dropTitle}>{t('ri.addSkillDropTitle')}</p>
          <p style={C.dropDesc}>{t('ri.addSkillDropDesc')}</p>
        </div>
        <input
          ref={fileRef}
          type="file"
          accept=".md,.markdown,text/markdown"
          style={{ display: 'none' }}
          onChange={(event) => {
            onFile(event.target.files?.[0])
            event.target.value = ''
          }}
        />

        <div>
          <p style={C.label}>
            <span style={C.required}>*</span>
            {t('ri.addSkillName')}
          </p>
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder={t('ri.addSkillNamePh')}
            style={C.input}
            spellCheck={false}
          />
          {name.length > 0 && !nameValid && <p style={{ ...C.hint, color: 'var(--dsw-alias-state-error-primary)', marginTop: 4 }}>{t('ri.addSkillNameInvalid')}</p>}
        </div>

        <div>
          <p style={C.label}>
            <span style={C.required}>*</span>
            {t('ri.addSkillDesc')}
          </p>
          <textarea
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            placeholder={t('ri.addSkillDescPh')}
            style={C.textarea}
            rows={2}
          />
        </div>

        <div>
          <p style={C.label}>
            <span style={C.required}>*</span>
            {t('ri.addSkillBody')}
          </p>
          <textarea
            ref={bodyRef}
            value={body}
            onChange={(event) => onChangeBody(event.target.value)}
            placeholder={t('ri.addSkillBodyPh')}
            style={{ ...C.textarea, ...C.bodyTextarea }}
            spellCheck={false}
          />
        </div>

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
            <span style={{ ...C.hint, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {workspace ?? t('ri.addMcpNoWorkspace')}
            </span>
          )}
        </div>

        {result && <div style={result.ok ? C.success : C.error}>{result.text}</div>}

        <div style={C.footer}>
          <button type="button" style={C.action} disabled={busy} onClick={onClose}>
            {t('ri.addSkillCancel')}
          </button>
          <button
            type="button"
            style={{ ...C.primary, ...(busy || !nameValid || !description.trim() || !body.trim() ? C.disabledButton : {}) }}
            disabled={busy || !nameValid || !description.trim().length || !body.trim().length}
            onClick={() => void submit()}
          >
            {busy ? t('ri.pending') : t('ri.addSkillConfirm')}
          </button>
        </div>
      </div>
    </div>
  )
}

/** 客户端本地 kebab-case 校验（与服务端 preset.isValidSkillName 同规则）。 */
function isValidSkillNameClient(name: string): boolean {
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)
}
