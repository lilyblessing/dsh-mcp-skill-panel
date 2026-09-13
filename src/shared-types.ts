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
  /**
   * 0.7.2：该行当前是「AI 经 mcp_call 临时启用」保活中的（autoManage 下为 true）。
   *
   * 为什么需要这个字段：卡片此前只有 `modelVisible`——用户手动启用的行同样 `modelVisible=true`，
   * 于是「用户打开」与「AI 临时打开」在外观上**分不清**。2026-09-14 实测事故里，模型误用面板
   * API 把 obsidian 行打开后，卡片与用户自己打开的行长得一模一样，没人能一眼看出这是 AI 干的。
   * AI 临时启用会写 state.json 的 ai 段（被回收器清除后才消失），故本字段也是审计痕迹。
   */
  aiOwned?: boolean
  /** 宿主侧期望状态（next-session 模式下可能与 disabled 不同）。 */
  desired?: boolean
  /** true = 已记录意图但尚未在运行时生效（待下次会话/重启）。 */
  pending?: boolean
  /**
   * 0.7.1 诚实上报：行**启用且在跑**，但 live 注册的工具数为 0
   * （子进程起不来/空转：如 codegraph 缺 `.codegraph` 索引、端点不可达）。
   *
   * 此前这种行会回落显示 catalog 目录快照的工具数，于是"零注册"被渲染成
   * "4 个工具在跑"（假绿；2026-09-13 实测 codegraph）。带上本标记后 UI 显示
   * `failed` 且工具数为 0，目录快照退回 `toolList`（工具级禁用 UI 仍可用）。
   */
  unregistered?: boolean
  /** 项目级 MCP 行：所属工作空间根（<workspace>/.dsh/mcps 所在目录）；缺省 = 全局行。 */
  workspace?: string
  /**
   * 行来源（rc.1 standing 组合兜底新增）：
   * - 'live' = ctx.loader.entries() 真实行（可 toggle/entry.update）
   * - 'preset' = compositionInventory standing 快照行（rc.1 preset 行不在 loader.entries，
   *   开关走 state.json desired 意图 + 下次启动物化，面板置 pending）
   * - 'gateway' = P5 网关自托管 gw- 行（loader 常驻，entryId=gw-mcp-<server>；
   *   toggle 走 preset 意图分支，见 routes.ts toggleMcp 网关分支）
   */
  source?: 'live' | 'preset' | 'gateway'
  /** 该 server 的工具列表（面板工具级禁用用；null = 该 server 暂无工具目录）。 */
  toolList?: Array<{ name: string; description: string; disabled: boolean }> | null
  // BLOCK-2（2026-09-09）：McpRow 不再携带全量挂载 config。曾有 `config?` 可选
  // 字段透出 preset 快照行的 command/args/env/headers（含求值后 secrets），而
  // /state 是无鉴权 GET 且 client 零消费；P4 网关走 host 侧 resolvePresetConfig，
  // 不经网络。host 侧全量配置见 preset-mcp.ts PresetMcpClientConfig。
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
