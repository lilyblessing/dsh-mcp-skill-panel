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
  // prompt-cache warning (P0: mid-session toggle invalidation)
  'ri.cacheWarn':
    "Toggling mid-session invalidates this session's prompt cache: the next request is billed at miss rate (~5-12.5× hit). Prefer toggling at a session boundary.",
  'ri.cacheWarnDismiss': 'Dismiss',
  // apply timing
  'ri.applyTiming': 'Apply timing',
  'ri.applyImmediate': 'Immediate',
  'ri.applyNextSession': 'Next session',
  'ri.applyModeDesc':
    "How manual toggles differ from on-demand middle-layer calls:\n· Immediate (default): a manual toggle changes the model-visible tools on the very next turn, invalidating this session's prefix cache from that turn onward — billed at miss rate (~5-12.5× hit). Use when you need to release/restore context right away.\n· Next session: a manual toggle only records intent; the current session keeps its toolset unchanged for all remaining turns (zero cache invalidation, zero extra cost) and applies at the next new session (before its first request) or after a DSH restart. Note: the current session will NOT release context just because you turned an MCP off (use \"Apply pending\" to force it).\n· Both modes: on-demand calls to disabled MCPs via the AI middle layer (mcp_search / mcp_call) always work — they temporarily enable and call outside the model request and never change your per-turn prefix, so they never cause a cache miss. Only manual toggles change the prefix.",
  'ri.applyPendingBtn': 'Apply pending now',
  'ri.applyDeferredHint': 'Intent recorded; it takes effect at the next new session or after a DSH restart.',
  'ri.pendingBadge': 'Pending',
  'ri.appliedPending': 'Applied {n} pending change(s).',
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
  // prompt-cache 警示（P0：会话中途开关致缓存失效）
  'ri.cacheWarn':
    '会话中途开关会使本会话的 Prompt Cache 失效，下次请求按 miss 费率计费（约为 hit 的 5~12.5 倍），建议在会话边界操作。',
  'ri.cacheWarnDismiss': '知道了',
  // 生效时机（applyMode）
  'ri.applyTiming': '生效时机',
  'ri.applyImmediate': '立即生效',
  'ri.applyNextSession': '下次会话生效',
  'ri.applyModeDesc':
    '用户手动启停开关 与 AI 中间层调用的区别：\n· 立即生效（默认）：手动开关会在下一轮对话立即改变模型看到的工具集，导致该轮起前缀缓存 100% 失效、按 miss 费率计费（约为 hit 的 5~12.5 倍）；适合需要马上释放/恢复上下文时。\n· 下次会话生效：手动开关只记录意图，当前会话全程工具集不变（零缓存失效、零额外费用），直到新开一个会话（其首次请求前）或重启 DSH 才生效；注意此时当前会话不会因为你关掉某 MCP 而立刻释放上下文（可用"立即应用"强制生效）。\n· 两者共同点：AI 中间层对已停用 MCP 的按需调用（mcp_search / mcp_call）始终可用——它在模型请求之外临时启用并调用，不改变每轮请求前缀，因此不会造成缓存 miss；只有"手动开关"才会改变前缀、从而可能造成 miss。',
  'ri.applyPendingBtn': '立即应用待生效变更',
  'ri.applyDeferredHint': '已记录意图，将在下次（新）会话或 DSH 重启后生效。',
  'ri.pendingBadge': '待生效',
  'ri.appliedPending': '已应用 {n} 项待生效变更。',
  // autoManage 开关
  'ri.autoManageTitle': 'AI 中间层',
  'ri.autoManageOn': '已开启',
  'ri.autoManageOff': '已关闭',
  'ri.autoManageDescOn':
    '停用的 MCP 服务器对模型隐藏，需要时经 mcp_search / mcp_call 按需调用（保活启用 + 空闲回收）；你手动打开的服务器保持模型可见（如 memory 高灵敏召回、filesystem 直接读写）；AI 临时启用的服务器不会污染上下文。用户手动启用的服务器不会被自动停用。',
  'ri.autoManageDescOff':
    '关闭后：已启用 MCP 服务器的工具直接对模型可见（经典模式）。',
}
