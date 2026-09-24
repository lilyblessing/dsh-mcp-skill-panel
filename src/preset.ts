/**
 * 预设组合的文本操作与启停意图物化。
 *
 * 0.1.7（2026-09-24）：预设改为**声明式**（一条 preset = 一条 declaration 行），
 * 没有独立的 agent.cordis.yml 可写 —— 因此物化目标从「预设组合文件」改为
 * **profile patch 的声明行 config**，且一律走官方写入面 `ctx.configEditor.edit`
 *（自带文件锁 + 原子写 + reconcileProfilePatches 热重载，官方 settings 即此法）。
 * 历史理由（已失效）：旧包用 `{mtimeMs,size}` stamp 检测预设文件变化，运行期写该
 * 文件会触发 standing 重挂而旧实例不清理 → 当时的对策是「只在启动早期、无会话时写文件」。
 * 现对策：**不直接写盘**，交给 configEditor（写盘 + 重挂由它按代际语义处理）。
 * 本模块的其余部分仍是纯文本操作，可被 selftest 覆盖（setRowFlag / setRowConfigKeys /
 * rowDisabledState 保留为纯函数与自测目标，0.1.7 起不再被 syncPresetFiles 调用）。
 */
import type { Context } from '@deepseek-ai/cordis'
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
 * 0.6.0：在组合文件中对 `- id: <rowId>` 行做**任意标量键**的设置/删除（通用版 setRowFlag）。
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

  /**
   * 一个键的**值区间**占几行：标题行 + 其后所有更深缩进的续行
   * （块映射 / 块序列 / 块标量的子行都属于这个键）。
   *
   * 2026-09-15 实测事故：早先覆盖时只替换标题行，`env:` 的 4 行块映射被遗留成孤儿 ——
   *   env: { MIMO_API_KEY: ... }      ← 新写的单行 flow
   *     MIMO_API_KEY: !!js "..."      ← 旧子行没人管
   * 整个组合文件就此变成非法 YAML（`bad indentation of a mapping entry (389:7)`），
   * 预设挂载失败 → 所有旧会话 resume 报错、新会话也建不出来。
   * 覆盖/删除都必须连着值区间一起动。
   */
  const keyValueSpan = (at: number, limit: number, keyIndent: number): number => {
    let span = 1
    let i = at + 1
    while (i < limit) {
      if (lines[i].trim().length === 0) {
        // 块内空行：仅当后面还有更深缩进的兄弟行时才并入（否则它是块外分隔行）
        let j = i
        while (j < limit && lines[j].trim().length === 0) j += 1
        if (j >= limit) break
        const nextIndent = /^(\s*)/.exec(lines[j])?.[1].length ?? 0
        if (nextIndent <= keyIndent) break
        span += j - i
        i = j
        continue
      }
      const indent = /^(\s*)/.exec(lines[i])?.[1].length ?? 0
      if (indent <= keyIndent) break
      span += 1
      i += 1
    }
    return span
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
    for (const key of remove) {
      // 每删一个键后块形态都会变，故每轮重算块尾与键缩进
      const blockEnd = configBlockEnd(configAt, end)
      const keyIndent = configKeyIndent(configAt, blockEnd)
      const at = findKey(key, configAt, blockEnd, keyIndent)
      if (at < 0) continue
      const span = keyValueSpan(at, blockEnd, keyIndent)
      lines.splice(at, span)
      end -= span
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
        // 覆盖：连同旧值区间一起替换，否则块映射/块序列的子行会成为孤儿（见 keyValueSpan）
        const span = keyValueSpan(at, blockEnd, keyIndent)
        lines.splice(at, span, line)
        end += 1 - span
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

/**
 * 未转义的普通标量可直接裸写的字符集。
 * 首字符另有限制：不能是 `- ? : , [ ] { } # & * ! | > ' " % @ \`` 等 YAML 指示符开头
 * （如 `--mcp` 会被当成块序列指示符的歧义区），这类一律加引号 ——
 * 与预设里既有写法一致（`args: ['serve', '--mcp']`）。
 */
const PLAIN_SCALAR = /^[A-Za-z0-9_./\\:-]+$/
const SAFE_FIRST = /^[A-Za-z0-9_./\\]/

/**
 * 裸写后会被解析成**非字符串**的标量形态。
 *
 * 预设组合按 `yaml.JSON_SCHEMA.extend(!!js)` 解析（cordis-plugin-include 的
 * entryListSchema），于是 `300` 是 number、`true` 是 boolean、`~` 是 null、
 * `.inf` 是 Infinity。env 这类值必须是字符串，裸写会**静默改类型**
 * （实测：原始 `MIMO_TIMEOUT: '300'` 被物化成 `300`）。
 * JSON_SCHEMA 不认 YAML 1.1 的 `yes/no/on/off`（实测仍为字符串），故无需为其加引号。
 */
const NON_STRING_SCALAR =
  /^(?:~|true|false|null|[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?|[-+]?0[xX][0-9a-fA-F]+|[-+]?0[oO][0-7]+|[-+]?0[bB][01]+|[-+]?\.(?:inf|nan))$/i

/** 运行态的 `!!js` 表达式载体（cordis-plugin-include 的 construct 产物）。 */
function isJsExprObject(value: unknown): value is { __jsExpr: string } {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    typeof (value as { __jsExpr?: unknown }).__jsExpr === 'string'
  )
}

/**
 * 0.6.0：把配置值序列化成**单行 YAML**（写入预设文件用）。
 *
 * 保守策略：只在确认安全时才裸写，其余一律单引号包裹（YAML 单引号里 `'` 需写成 `''`）。
 * 数组/对象用 flow 风格（与预设里既有的 `args: ['serve', '--mcp']` 一致）。
 * `!!js` 表达式写回**标签形态**（与 dsh 自己的 `represent` 一致），不退化成
 * `{ __jsExpr: ... }`：两者求值等价（`interpolate` 认 `__jsExpr` 键），但标签形态
 * 保住文件原有写法，改配置不会把用户的表达式写成另一种方言。
 */
export function configValueToYaml(value: unknown): string {
  if (typeof value === 'boolean' || typeof value === 'number') return String(value)
  if (isJsExprObject(value)) return `!!js ${JSON.stringify(value.__jsExpr)}`
  if (Array.isArray(value)) {
    const items = value.map((v) => configValueToYaml(v))
    return `[${items.join(', ')}]`
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).map(([k, v]) => `${k}: ${configValueToYaml(v)}`)
    return `{ ${entries.join(', ')} }`
  }
  const s = String(value ?? '')
  if (s.length > 0 && PLAIN_SCALAR.test(s) && SAFE_FIRST.test(s) && !NON_STRING_SCALAR.test(s)) return s
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

/** profile patch 行的 config 编辑面（config-editor 服务的本插件所需子集）。 */
interface ConfigEditorLike {
  entries(): Array<{ options: { id?: unknown; name?: unknown; config?: unknown } }>
  edit(entry: unknown, change: (current: Record<string, unknown>, inherited: Record<string, unknown>) => Record<string, unknown>): Promise<void>
}

/**
 * 0.1.7 启动早期物化：把 state.json 的 MCP 启停/配置意图写进 **profile patch 的预设声明行**。
 *
 * 走官方写入面 `ctx.configEditor.edit`（config-editor：文件锁 + 原子写 +
 * reconcileProfilePatches 热重载；官方 settings 即此法）。声明式预设没有独立文件，
 * 故 state.mcp 的第一级键 = **预设声明行的 Loader 行 id**；找不到该声明行（含 0.1.5
 * 遗留的「预设文件路径」键）→ 跳过该键（死键不迁移、不猜）。
 *
 * 幂等（0.1.7 新增）：目标 `disabled` 与目标 config 键都已一致时**不调用 edit** ——
 * 每次 edit 都会触发该声明行的 reconcile/重挂，无谓的重挂正是要避免的事故形态
 *（W0 报告 §5-2 P10 护栏）。非 profile 场合（无 configEditor 服务）不写盘，返回 0。
 */
export async function syncPresetFiles(ctx: Context): Promise<number> {
  const editor = ctx.get('configEditor') as ConfigEditorLike | undefined
  if (editor === undefined) return 0
  const state = await readState()
  const mcp = state.mcp
  if (!mcp || Object.keys(mcp).length === 0) return 0
  let materialized = 0
  for (const [presetRowId, rows] of Object.entries(mcp)) {
    const entry = editor.entries().find((row) => String(row.options.id ?? '') === presetRowId)
    if (entry === undefined) continue
    const current = (entry.options.config ?? {}) as Record<string, unknown>
    const plugins = Array.isArray(current.plugins) ? (current.plugins as Array<Record<string, unknown>>) : []
    const nextPlugins = mergeRowIntents(plugins, rows)
    if (nextPlugins === undefined) {
      // 无变化（幂等闸）：只对齐 state 的物化记录，不发起 edit ——
      // 每次 edit 都会触发该声明行的 reconcile/重挂，无谓重挂正是要避免的事故形态。
      for (const [rowId, row] of Object.entries(rows)) {
        if (row.desired === row.lastApplied) continue
        mcp[presetRowId][rowId] = { ...row, lastApplied: row.desired }
      }
      continue
    }
    await editor.edit(entry, (cur) => {
      const curPlugins = Array.isArray(cur.plugins) ? (cur.plugins as Array<Record<string, unknown>>) : []
      return { ...cur, plugins: mergeRowIntents(curPlugins, rows) ?? curPlugins }
    })
    materialized += 1
    // 物化记录：lastApplied = 本次写进 profile patch 的启停值；configAppliedYaml = 本次
    // 写入的配置意图文本（供下次启动判断「是否已物化」）。
    for (const [rowId, row] of Object.entries(rows)) {
      mcp[presetRowId][rowId] = {
        desired: row.desired,
        lastApplied: row.desired,
        config: row.config,
        ...(row.config && Object.keys(row.config).length > 0 ? { configAppliedYaml: configKeysToYamlText(row.config) } : {}),
      }
    }
  }
  await writeState(state)
  return materialized
}

/**
 * 把 state 里的行意图合并进声明行的 plugins 数组；**无变化返回 undefined**（幂等闸）。
 *
 * - `desired === true` → 该行写 `disabled: true`；`desired === false` → 删除 `disabled` 键
 *   （与旧 setRowFlag 的「value=false 即移除标记」同语义）。
 * - `config` 键（「更多配置」意图）：先按 state 里的 `configAppliedYaml` 判定是否已物化，
 *   未物化则整键合并进该行 `config`；0.1.7 不再有文本写入，`!!js` 表达式由 config-editor
 *   自己的 `__jsExpr` → `!!js` 标签回写处理。
 */
function mergeRowIntents(
  plugins: Array<Record<string, unknown>>,
  rows: Record<string, McpRowState>,
): Array<Record<string, unknown>> | undefined {
  let changed = false
  const next = plugins.map((plugin) => {
    const rowId = String(plugin.id ?? '')
    const want = rows[rowId]
    if (want === undefined) return plugin
    let row = plugin
    if (want.desired === true) {
      if (plugin.disabled !== true) {
        row = { ...row, disabled: true }
        changed = true
      }
    } else if ('disabled' in row) {
      row = { ...row }
      delete row.disabled
      changed = true
    }
    if (want.config && Object.keys(want.config).length > 0 && configKeysToYamlText(want.config) !== want.configAppliedYaml) {
      const base = row.config !== null && typeof row.config === 'object' && !Array.isArray(row.config)
        ? (row.config as Record<string, unknown>)
        : {}
      row = { ...row, config: { ...base, ...want.config } }
      changed = true
    }
    return row
  })
  return changed ? next : undefined
}
