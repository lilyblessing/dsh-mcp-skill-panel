/**
 * 添加 MCP 弹窗（快速迁移）：粘贴其它 harness 的 mcpServers JSON，
 * 在弹窗内选择「全局 / 项目」目标，转换预览后确认添加。
 *
 * - 全局：写入 <profile>/cordis.patch.yml（- insert: 块，${VAR} → !!js 表达式）+ 立即挂载
 * - 项目：写入 <workspace>/.dsh/mcps/mcp.json（与子目录扫描去重规则一致）+ 重扫挂载
 * 全部逻辑（token / 预览 / 添加 / 结果展示）都在本组件内部，对 views.tsx 零侵入。
 * 样式走宿主 --dsw-alias-* 主题变量（与 views.tsx 一致），本地私有 C，不导出。
 */
import React from 'react';
interface Props {
    /** locale 翻译函数（由父级传入，保持与宿主 locale 插槽一致）。 */
    t: (key: string, params?: Record<string, string | number>) => string;
    /** 当前会话工作空间（cwd）；null = 无会话上下文，此时禁止「项目」目标。 */
    workspace: string | null;
    /** 关闭弹窗。 */
    onClose: () => void;
    /** 添加成功（含部分成功）后回调：父级负责刷新 MCP 列表。 */
    onAdded: () => void;
}
export declare function AddMcpModal(props: Props): React.ReactElement;
export {};
