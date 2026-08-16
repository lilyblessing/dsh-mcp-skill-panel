/** 双语字典：zh/en 真双语（不互为别名），语言跟随 DSH 界面设置。 */
export const NS = 'runtime-inventory'

export const en: Record<string, string> = {
  'ri.nav': 'MCP & Skill Manager',
  'ri.mcpTab': 'MCP Servers',
  'ri.skillTab': 'Skills',
  'ri.refresh': 'Refresh',
  'ri.loading': 'Loading…',
  'ri.error': 'Failed: {error}',
  'ri.empty': 'No data yet.',
  'ri.session': 'Session',
  'ri.preset': 'Preset',
  'ri.cwd': 'Workspace',
  // stats
  'ri.statMcpServers': '{n} servers',
  'ri.statMcpDisabled': '{n} disabled',
  'ri.statMcpTools': '{n} tools',
  'ri.statMcpTokens': '~{n}k tokens',
  'ri.statSkills': '{n} skills',
  'ri.statSkillsVisible': '{n} model-visible',
  // mcp card
  'ri.statusActive': 'Active',
  'ri.statusDisabled': 'Disabled',
  'ri.statusIdle': 'No tools',
  'ri.statusFailed': 'Failed',
  'ri.toolsCount': '{n} tools',
  'ri.tokensCount': '~{n}k tokens',
  'ri.transport': 'transport',
  'ri.disable': 'Disable',
  'ri.enable': 'Enable',
  'ri.pending': 'Working…',
  // skill card
  'ri.skillSource': 'source: {source}',
  'ri.modelVisible': 'Model',
  'ri.modelHidden': 'Hidden',
  'ri.userVisible': 'User',
  // toggles
  'ri.toggleOffHint': 'Release context: tools disappear immediately.',
  'ri.toggleOnHint': 'Restore tools without restart.',
  'ri.toggleError': 'Toggle failed: {error}',
  'ri.skillToggleOffHint': 'Remove this skill from the model catalog.',
  'ri.skillToggleOnHint': 'Make this skill model-visible again.',
  // autoManage switch
  'ri.autoManageTitle': 'AI Middle Layer',
  'ri.autoManageOn': 'On',
  'ri.autoManageOff': 'Off',
  'ri.autoManageDescOn':
    'Disabled MCP servers stay hidden from the model and are used on demand via mcp_search / mcp_call (keep-alive enable + idle reaping). Servers you enabled stay directly visible (e.g. memory for recall, filesystem for IO); AI-temporarily-enabled servers never pollute context. Manually enabled servers are never auto-disabled.',
  'ri.autoManageDescOff':
    'Off: tools of enabled MCP servers are directly visible to the model (classic mode).',
}

export const zh: Record<string, string> = {
  'ri.nav': 'MCP 与技能管理面板',
  'ri.mcpTab': 'MCP 服务器',
  'ri.skillTab': '技能',
  'ri.refresh': '刷新',
  'ri.loading': '加载中…',
  'ri.error': '加载失败：{error}',
  'ri.empty': '暂无数据',
  'ri.session': '会话',
  'ri.preset': '预设',
  'ri.cwd': '工作目录',
  // stats
  'ri.statMcpServers': '{n} 个服务器',
  'ri.statMcpDisabled': '{n} 个已停用',
  'ri.statMcpTools': '{n} 个工具',
  'ri.statMcpTokens': '约 {n}k token',
  'ri.statSkills': '{n} 个技能',
  'ri.statSkillsVisible': '{n} 个模型可见',
  // mcp card
  'ri.statusActive': '运行中',
  'ri.statusDisabled': '已停用',
  'ri.statusIdle': '无工具',
  'ri.statusFailed': '异常',
  'ri.toolsCount': '{n} 个工具',
  'ri.tokensCount': '约 {n}k token',
  'ri.transport': '传输',
  'ri.disable': '停用',
  'ri.enable': '启用',
  'ri.pending': '处理中…',
  // skill card
  'ri.skillSource': '来源：{source}',
  'ri.modelVisible': '模型可见',
  'ri.modelHidden': '模型隐藏',
  'ri.userVisible': '用户可用',
  // toggles
  'ri.toggleOffHint': '释放上下文：工具立即从模型目录消失。',
  'ri.toggleOnHint': '无需重启即可恢复工具。',
  'ri.toggleError': '切换失败：{error}',
  'ri.skillToggleOffHint': '将该技能从模型目录移除。',
  'ri.skillToggleOnHint': '恢复该技能的模型可见性。',
  // autoManage 开关
  'ri.autoManageTitle': 'AI 中间层',
  'ri.autoManageOn': '已开启',
  'ri.autoManageOff': '已关闭',
  'ri.autoManageDescOn':
    '停用的 MCP 服务器对模型隐藏，需要时经 mcp_search / mcp_call 按需调用（保活启用 + 空闲回收）；你手动打开的服务器保持模型可见（如 memory 高灵敏召回、filesystem 直接读写）；AI 临时启用的服务器不会污染上下文。用户手动启用的服务器不会被自动停用。',
  'ri.autoManageDescOff':
    '关闭后：已启用 MCP 服务器的工具直接对模型可见（经典模式）。',
}
