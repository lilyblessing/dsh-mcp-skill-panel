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
  /** 扣掉工具级禁用后，该 server 实际进入模型上下文的工具数。 */
  toolsEnabled: number
  /** 同上的 token 估算（批量禁用的唯一可见反馈）。 */
  tokensEnabled: number
  status: McpStatus
  /** 模型是否可见（autoManage 下：启用且非 AI 临时启用 → 可见；关闭模式下全部启用可见）。 */
  modelVisible: boolean
  /** 宿主侧期望状态（next-session 模式下可能与 disabled 不同）。 */
  desired?: boolean
  /** true = 已记录意图但尚未在运行时生效（待下次会话/重启）。 */
  pending?: boolean
  /** 项目级 MCP 行：所属工作空间根（<workspace>/.dsh/mcps 所在目录）；缺省 = 全局行。 */
  workspace?: string
  /**
   * 行来源（rc.1 standing 组合兜底新增）：
   * - 'live' = ctx.loader.entries() 真实行（可 toggle/entry.update）
   * - 'preset' = compositionInventory standing 快照行（rc.1 preset 行不在 loader.entries，
   *   开关走 state.json desired 意图 + 下次启动物化，面板置 pending）
   */
  source?: 'live' | 'preset'
  /** 该 server 的工具列表（面板工具级禁用用；null = 该 server 暂无工具目录）。 */
  toolList?: Array<{ name: string; description: string; disabled: boolean }> | null
}

export interface McpView {
  sessionId: string | null
  preset: string | null
  cwd: string | null
  /** 最近一次会话进入的工作空间（随会话切换更新；添加项目 MCP 的默认目标）。 */
  activeWorkspace: string | null
  mcp: McpRow[]
  mcpTotal: number
  mcpDisabled: number
  mcpToolsTotal: number
  mcpTokensTotal: number
  /** 扣掉工具级禁用后的 MCP 工具总数 / token 估算。 */
  mcpToolsEnabledTotal: number
  mcpTokensEnabledTotal: number
  /** 全部工具（含 read/edit/bash/skill 等非 MCP 工具）总数与有效数 —— 工具预算红线用。 */
  toolsAllTotal: number
  toolsAllEnabled: number
  /** 工具预算（如 grok 的 350）；null = 未设置，不提示。 */
  toolBudget: number | null
  /** AI 中间层总开关（面板开关）。 */
  autoManage: boolean
  /** 按模型覆盖表：键为 provider 或 provider/model，值 true=启用中间层。 */
  autoManageByRoute: Record<string, boolean>
  /** 中间层是否已实际挂载（总开关关但存在 true 覆盖项时也会挂载）。 */
  autoManageMounted: boolean
  /** 中间层生效时隐藏哪些 server：'disabled'=仅手动停用的；'all'=全部 MCP。 */
  middleLayerHides: 'disabled' | 'all'
  /** 当前会话（或缺省 agent）实际生效的判定与依据。 */
  autoManageActive: {
    on: boolean
    source: 'model' | 'provider' | 'master' | 'no-route'
    provider: string | null
    model: string | null
  }
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
