/**
 * 预设组合文件的文本操作与启停意图物化。
 *
 * 运行期禁止写 agent.cordis.yml（dsh-agent-presets 的 {mtimeMs,size} stamp 检测会
 * 触发 standing 重挂事故），因此 toggle 只写 state.json，由 syncPresetFiles 在
 * 插件 apply（启动早期、standing 未挂载）时物化到预设文件 —— 此时写文件安全。
 * 本模块为纯文本操作，可被 selftest 覆盖。
 */
import type { Context } from '@deepseek-ai/cordis'
import { readFile, writeFile, rename } from 'node:fs/promises'
import { readState, writeState, type McpRowState } from './state'

const DISABLE_KEY = 'disable-model-invocation'

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** 新行分隔符：跟随原文件。 */
function lineSep(text: string): string {
  return text.includes('\r\n') ? '\r\n' : '\n'
}

/**
 * 在组合文件中对 `- id: <rowId>` 行做 `  <key>: <value>` 标记的插入/移除。
 * 逐行文本编辑，保留注释与 !!js 表达式原样（loader 的 yaml.dump 会丢注释，故不用）。
 *
 * 语义（2026-08-27 修复）：value=true 保证标记存在且为 true（已有 false 时反转）；
 * value=false 移除标记。此前 value=true 遇到已存在的 `disabled: false` 会原样返回
 * （只支持插入/删除不支持反转），导致物化失败后 lastApplied 与文件脱节，
 * 下次启动被误判「外部修改」而删掉 state 条目（obsidian 设置丢失事故）。
 */
export function setRowFlag(text: string, rowId: string, key: string, value: boolean): string {
  const nl = lineSep(text)
  const lines = text.split(/\r?\n/)
  const rowRe = new RegExp(`^-\\s*id:\\s*${escapeRegExp(rowId)}\\s*$`)
  const idx = lines.findIndex((line) => rowRe.test(line))
  if (idx < 0) throw new Error(`row "- id: ${rowId}" not found in composition file`)
  let end = idx + 1
  while (end < lines.length && !/^-\s*id:/.test(lines[end])) end += 1
  const block = lines.slice(idx, end)
  const flagRe = new RegExp(`^\\s*${escapeRegExp(key)}:\\s*(true|false)\\s*$`)
  const flagAt = block.findIndex((line) => flagRe.test(line))
  if (flagAt >= 0) {
    if (value) {
      // 已有标记但为 false → 替换为 true（反转）；已有 true → 文本不变（幂等）
      if (/:\s*false\s*$/.test(block[flagAt])) {
        lines.splice(idx + flagAt, 1, `  ${key}: true`)
        return lines.join(nl)
      }
      return text
    }
    // 移除现有标记行（flagAt 是行块内偏移 → 全局偏移为 idx + flagAt）
    lines.splice(idx + flagAt, 1)
    return lines.join(nl)
  }
  if (value) {
    lines.splice(idx + 1, 0, `  ${key}: true`)
    return lines.join(nl)
  }
  return text
}

/** SKILL.md frontmatter 的 disable-model-invocation 键注入/移除（kebab-case 是唯一合法形式）。 */
export function setSkillFlag(text: string, value: boolean): string {
  const nl = lineSep(text)
  const has = new RegExp(`^${DISABLE_KEY}:\\s*true\\s*$`, 'm').test(text)
  if (value && !has) {
    const m = /^---\s*(\r?\n)/.exec(text)
    if (!m) return text
    return `---${m[1]}${DISABLE_KEY}: true${m[1]}${text.slice(m[0].length)}`
  }
  if (!value && has) {
    // 连同行尾换行一起移除，避免 frontmatter 留下空行
    return text.replace(new RegExp(`^\\s*${DISABLE_KEY}:\\s*true\\s*\\r?\\n?`, 'm'), '')
  }
  return text
}

/** dsh-skill-filesystem 的 skill 名约束：kebab-case（非合法名会被发现层丢弃）。 */
const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/** skill 名是否合法（kebab-case，前端预校验与后端落盘共用）。 */
export function isValidSkillName(name: string): boolean {
  return SKILL_NAME_PATTERN.test(name)
}

/**
 * 生成 SKILL.md 文本：frontmatter（name/description）+ 正文。
 * description 用 JSON 双引号标量（合法 YAML，冒号/换行安全）；正文原样保留。
 */
export function buildSkillMd(name: string, description: string, body: string): string {
  const nl = '\n'
  const desc = JSON.stringify(description)
  const trimmedBody = body.replace(/\s+$/, '')
  return `---${nl}name: ${name}${nl}description: ${desc}${nl}---${nl}${nl}${trimmedBody}${nl}`
}

/** 读取某行当前是否带 disabled: true（true/false/null=无标记）。 */
export function rowDisabledState(text: string, rowId: string): boolean | null {
  const lines = text.split(/\r?\n/)
  const rowRe = new RegExp(`^-\\s*id:\\s*${escapeRegExp(rowId)}\\s*$`)
  const idx = lines.findIndex((line) => rowRe.test(line))
  if (idx < 0) return null
  let end = idx + 1
  while (end < lines.length && !/^-\s*id:/.test(lines[end])) end += 1
  const block = lines.slice(idx, end)
  const flagLine = block.find((line) => /^\s*disabled:\s*(true|false)\s*$/.test(line))
  if (!flagLine) return null
  return /:\s*true\s*$/.test(flagLine)
}

/**
 * 启动早期物化：把状态文件里的 MCP 启停意图写入预设组合文件。
 * 只在「没有任何 agent 在跑」时执行 —— 有会话时写文件会触发
 * dsh-agent-presets 的 stamp 重挂（旧实例不 dispose → serverName 冲突事故）。
 */
export async function syncPresetFiles(ctx: Context): Promise<number> {
  if (ctx.agents.list().length > 0) return 0
  const state = await readState()
  const mcp = state.mcp
  if (!mcp || Object.keys(mcp).length === 0) return 0
  let materialized = 0
  for (const [file, rows] of Object.entries(mcp)) {
    let text: string
    try {
      text = await readFile(file, 'utf8')
    } catch {
      continue
    }
    let changed = false
    const next: Record<string, McpRowState> = {}
    for (const [rowId, entry] of Object.entries(rows)) {
      const cur = rowDisabledState(text, rowId)
      if (cur !== entry.lastApplied) {
        // 文件被外部（用户）修改过：尊重现状，不写文件。
        // 2026-08-27 修复：此前直接跳过（行不进入 next → 条目被永久删除）。
        // 物化链路 setRowFlag 无法反转 disabled:false 时 lastApplied 与文件脱节，
        // 会被误判外部修改而把用户设置从 state.json 抹掉（obsidian 事故）。
        // 改为保留条目：lastApplied 对齐现实（cur），desired 保留（面板仍显示
        // 意图徽标，可重新 toggle 接管）；desired 与现状一致时自动恢复管理闭环。
        next[rowId] = { desired: entry.desired, lastApplied: cur }
        continue
      }
      const curBool = cur === true
      if (curBool !== entry.desired) {
        try {
          text = setRowFlag(text, rowId, 'disabled', entry.desired)
          changed = true
          materialized += 1
        } catch {
          // 行已不存在（用户删除）：放弃管理
          continue
        }
      }
      // lastApplied 记录物化后的文件状态（= desired），而非物化前 curBool：
      // 否则下次启动 cur(文件=desired) !== lastApplied(旧值) 被误判为「外部修改」而放弃管理，
      // 导致 desired 残留 + 面板徽标悬挂（P1 重启链路闭环）。
      next[rowId] = { desired: entry.desired, lastApplied: entry.desired }
    }
    if (changed) {
      const tmp = `${file}.tmp`
      await writeFile(tmp, text, 'utf8')
      await rename(tmp, file)
    }
    mcp[file] = next
  }
  await writeState(state)
  return materialized
}
