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

/**
 * 0.7.0：在组合文件中对 `- id: <rowId>` 行做**任意标量键**的设置/删除（通用版 setRowFlag）。
 *
 * 为什么必须是文本编辑而不是 yaml.dump：预设文件里允许 `!!js` 表达式与注释，
 * dump 会丢掉它们（setRowFlag 的注释已记录这条）。
 *
 * 关键语义：**只改 config: 块内的同名键**，不碰行级键（disabled/name 等）。
 * 早先实现曾把 config 块挂到行级，本函数按缩进判别：
 *   - config: 行缩进记为 base；
 *   - 子键缩进 > base 即认为属于 config 块；
 *   - 键是标量（单行 `key: value`）才替换，多行值（`|` / 嵌套 map）保守跳过并报错，
 *     避免把用户的复杂配置改坏。
 *
 * @param set 要写入/覆盖的键（值须已序列化为 YAML 标量文本）
 * @param remove 要删除的键
 */
export function setRowConfigKeys(
  text: string,
  rowId: string,
  set: Record<string, string>,
  remove: string[] = [],
): string {
  const nl = lineSep(text)
  const lines = text.split(/\r?\n/)
  const rowRe = new RegExp(`^-\\s*id:\\s*${escapeRegExp(rowId)}\\s*$`)
  const idx = lines.findIndex((line) => rowRe.test(line))
  if (idx < 0) throw new Error(`row "- id: ${rowId}" not found in composition file`)
  const rowIndent = /^(\s*)/.exec(lines[idx])?.[1].length ?? 0
  const childIndent = rowIndent + 2
  let end = idx + 1
  while (end < lines.length && !/^-\s*id:/.test(lines[end])) end += 1

  // 定位 config: 块（行级缩进恰好等于 childIndent 的那个）
  let configAt = -1
  {
    const re = new RegExp(`^\\s{${childIndent}}config:\\s*$`)
    for (let i = idx + 1; i < end; i += 1) {
      if (re.test(lines[i])) { configAt = i; break }
    }
  }

  /**
   * config 块的**直接子键缩进**（块内非空行取最小缩进）。
   * 教训：早先直接用 `childIndent + 2` 当键缩进并写成 `^\s{N}key:`，而 `\s{N}` 是
   * "恰好 N 个空白后紧跟 key" —— 该写法永远匹配不上真正的键行，导致每次都当新键
   * 插入（自测 ②「同键覆盖幂等」抓到的 bug）。取块内最小缩进才是稳健判定。
   */
  const configKeyIndent = (from: number, limit: number): number => {
    let min = -1
    for (let i = from + 1; i < limit; i += 1) {
      const line = lines[i]
      if (line.trim().length === 0) continue
      const indent = /^(\s*)/.exec(line)?.[1].length ?? 0
      if (indent <= childIndent) break
      if (min < 0 || indent < min) min = indent
    }
    return min < 0 ? childIndent + 2 : min
  }

  /** 在 config 块内按**直接子键**精确命中 `key:` 行（不做深度匹配，避免误伤嵌套同名键）。 */
  const findKey = (key: string, from: number, limit: number, keyIndent: number): number => {
    const re = new RegExp(`^\\s{${keyIndent}}${escapeRegExp(key)}:`)
    for (let i = from + 1; i < limit; i += 1) {
      const line = lines[i]
      if (line.trim().length === 0) continue
      const indent = /^(\s*)/.exec(line)?.[1].length ?? 0
      if (indent <= childIndent) break
      if (indent === keyIndent && re.test(line)) return i
    }
    return -1
  }

  /** config 块的最后一个内容行之后（空行不并入，避免把新键插到块外）。 */
  function configBlockEnd(from: number, limit: number): number {
    let last = from + 1
    for (let i = from + 1; i < limit; i += 1) {
      const line = lines[i]
      if (line.trim().length === 0) continue
      const indent = /^(\s*)/.exec(line)?.[1].length ?? 0
      if (indent <= childIndent) break
      last = i + 1
    }
    return last
  }

  // 删除：config 块存在才可能删得掉
  if (configAt >= 0) {
    const blockEnd = configBlockEnd(configAt, end)
    const keyIndent = configKeyIndent(configAt, blockEnd)
    for (const key of remove) {
      const at = findKey(key, configAt, blockEnd, keyIndent)
      if (at < 0) continue
      lines.splice(at, 1)
      end -= 1
    }
  }

  // 写入：先试覆盖，再考虑新增
  // 注意：每写入一个键都要重算块尾 —— 否则同一批里的后续键会重复插入
  // （自测 ②「同键覆盖幂等」抓到的第二个 bug）。
  for (const [key, value] of Object.entries(set)) {
    if (configAt >= 0) {
      const blockEnd = configBlockEnd(configAt, end)
      const keyIndent = configKeyIndent(configAt, blockEnd)
      const at = findKey(key, configAt, blockEnd, keyIndent)
      const line = `${' '.repeat(keyIndent)}${key}: ${value}`
      if (at >= 0) {
        lines[at] = line
      } else {
        lines.splice(blockEnd, 0, line)
        end += 1
      }
    } else {
      // 行内没有 config: → 新建块。插到该行**最后一个非空行之后**（而非 end 之前）：
      // end 是下一个 `- id:` 的位置，其前常有空行分隔符，插在 end 前会把空行顶到
      // config 块上面（自测 ⑤ 抓到）。
      let lastContent = idx
      for (let i = idx + 1; i < end; i += 1) if (lines[i].trim().length > 0) lastContent = i
      lines.splice(lastContent + 1, 0, `${' '.repeat(childIndent)}config:`, `${' '.repeat(childIndent + 2)}${key}: ${value}`)
      end += 2
      configAt = lastContent + 1
    }
  }
  return lines.join(nl)
}

/** 允许通过面板编辑的挂载配置键（与 mcp-convert.ts 的挂载形态一致）。 */
export const EDITABLE_CONFIG_KEYS = [
  'transport',
  'command',
  'args',
  'env',
  'cwd',
  'url',
  'headers',
  'toolCallTimeoutMs',
  'failOnStartupError',
] as const

export type EditableConfigKey = (typeof EDITABLE_CONFIG_KEYS)[number]

/**
 * 未转义的普通标量可直接裸写的字符集。
 * 首字符另有限制：不能是 `- ? : , [ ] { } # & * ! | > ' " % @ \`` 等 YAML 指示符开头
 * （如 `--mcp` 会被当成块序列指示符的歧义区），这类一律加引号 ——
 * 与预设里既有写法一致（`args: ['serve', '--mcp']`）。
 */
const PLAIN_SCALAR = /^[A-Za-z0-9_./\\:-]+$/
const SAFE_FIRST = /^[A-Za-z0-9_./\\]/

/**
 * 0.7.0：把配置值序列化成**单行 YAML**（写入预设文件用）。
 *
 * 保守策略：只在确认安全时才裸写，其余一律单引号包裹（YAML 单引号里 `'` 需写成 `''`）。
 * 数组/对象用 flow 风格（与预设里既有的 `args: ['serve', '--mcp']` 一致）。
 */
export function configValueToYaml(value: unknown): string {
  if (typeof value === 'boolean' || typeof value === 'number') return String(value)
  if (Array.isArray(value)) {
    const items = value.map((v) => configValueToYaml(v))
    return `[${items.join(', ')}]`
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).map(([k, v]) => `${k}: ${configValueToYaml(v)}`)
    return `{ ${entries.join(', ')} }`
  }
  const s = String(value ?? '')
  if (s.length > 0 && PLAIN_SCALAR.test(s) && SAFE_FIRST.test(s)) return s
  return `'${s.replace(/'/g, "''")}'`
}

/** 把一组配置键/值转成 setRowConfigKeys 需要的「已序列化标量」形态。 */
export function configSetToYaml(set: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(set)) out[k] = configValueToYaml(v)
  return out
}

/** 把配置对象转成用于"是否已物化"比对的稳定文本（键排序，避免顺序抖动导致重复写）。 */
export function configKeysToYamlText(config: Record<string, unknown>): string {
  const keys = Object.keys(config).sort()
  return keys.map((k) => `${k}: ${configValueToYaml(config[k])}`).join('\n')
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
      let lastApplied: boolean | null = entry.lastApplied
      if (cur !== entry.lastApplied) {
        // 文件被外部（用户）修改过：**启停意图**上尊重现状，不写 disabled。
        // 2026-08-27 修复：此前直接跳过（行不进入 next → 条目被永久删除）。
        // 物化链路 setRowFlag 无法反转 disabled:false 时 lastApplied 与文件脱节，
        // 会被误判外部修改而把用户设置从 state.json 抹掉（obsidian 事故）。
        // 改为保留条目：lastApplied 对齐现实（cur），desired 保留（面板仍显示
        // 意图徽标，可重新 toggle 接管）；desired 与现状一致时自动恢复管理闭环。
        //
        // 0.7.1 修复（2026-09-14 实测事故）：**配置意图必须继续物化**。
        // 原实现在此处 `continue` 把整行跳过 → 「更多配置」改的 cwd 永远进不了
        // 预设文件且毫无提示。触发场景：codegraph 行无 `disabled` 键 ⇒
        // rowDisabledState 返回 null，而 state 里记的 lastApplied 来自 live
        // entry.disabled = false ⇒ null !== false ⇒ 每次启动都判成「外部改动」。
        // 启停与配置是两个正交字段：对齐 lastApplied 后继续走配置物化是安全的
        //（本分支不写 `disabled`，用户对启停的改动仍被尊重）。
        lastApplied = cur
        ctx.logger.info?.(
          `mcp-skill-panel: preset row ${rowId} externally modified (disabled ${String(entry.lastApplied)} → ${String(cur)}); keeping desired=${String(entry.desired)}, still materializing config`,
        )
      } else {
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
        lastApplied = entry.desired
      }
      // 0.7.0：配置意图物化（仅当与上次物化结果不同才写，幂等且可自愈）
      let configAppliedYaml = entry.configAppliedYaml
      if (entry.config && Object.keys(entry.config).length > 0) {
        const yamlText = configKeysToYamlText(entry.config)
        if (yamlText !== entry.configAppliedYaml) {
          try {
            text = setRowConfigKeys(text, rowId, configSetToYaml(entry.config))
            changed = true
            materialized += 1
            configAppliedYaml = yamlText
          } catch {
            // 行已不存在 / 结构异常：保留意图，下次启动重试
          }
        }
      }
      // lastApplied 记录物化后的文件状态（= desired），而非物化前 curBool：
      // 否则下次启动 cur(文件=desired) !== lastApplied(旧值) 被误判为「外部修改」而放弃管理，
      // 导致 desired 残留 + 面板徽标悬挂（P1 重启链路闭环）。外部改动分支则对齐 cur。
      next[rowId] = { desired: entry.desired, lastApplied, config: entry.config, configAppliedYaml }
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
