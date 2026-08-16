/**
 * Host/Client 共享的类型定义（单一来源）。
 *
 * 面板视图形状（McpRow/McpView/SkillRow/SkillsView）同时被 host 的 collect.ts
 * 产出与 client 的 views.tsx 消费 —— 集中定义避免两端各自声明导致漂移
 * （v0.4.2 加 modelVisible/autoManage 时曾需要两边同步改）。
 * 纯类型文件：type-only import 不产生任何打包产物。
 */

export type McpStatus = 'active' | 'disabled' | 'idle' | 'failed'

export interface McpRow {
  entryId: string
  rowId: string
  serverName: string
  transport: string | null
  disabled: boolean
  running: boolean
  tools: number
  tokens: number
  status: McpStatus
  /** 模型是否可见（autoManage 下：启用且非 AI 临时启用 → 可见；关闭模式下全部启用可见）。 */
  modelVisible: boolean
}

export interface McpView {
  sessionId: string | null
  preset: string | null
  cwd: string | null
  mcp: McpRow[]
  mcpTotal: number
  mcpDisabled: number
  mcpToolsTotal: number
  mcpTokensTotal: number
  /** AI 中间层当前是否生效（面板开关）。 */
  autoManage: boolean
  errors: string[]
}

export interface SkillRow {
  name: string
  description: string
  source: string
  modelInvocable: boolean
  userInvocable: boolean
}

export interface SkillsView {
  sessionId: string | null
  preset: string | null
  cwd: string | null
  skills: SkillRow[]
  skillsTotal: number
  skillsModelVisible: number
  errors: string[]
}
