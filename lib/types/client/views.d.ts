/**
 * MCP 与技能管理面板：MCP 服务器 / 技能 双标签页，统计头 + 卡片 + 启停开关。
 * 样式全部 JS 内联（宿主全局 CSS 可能覆盖注入的 class），颜色走 --dsw-alias-* 主题变量。
 * 视图形状类型来自 shared-types（与 host 单一来源，type-only import 不打包）。
 */
import React from 'react';
interface Props {
    /** 由 locale 插槽注入：NS 字典的翻译函数 */
    t: (key: string, params?: Record<string, string | number>) => string;
    close?: () => void;
}
export declare function RuntimeInventorySection(props: Props): React.ReactElement;
export declare function ensureToolToken(): Promise<string | null>;
export {};
