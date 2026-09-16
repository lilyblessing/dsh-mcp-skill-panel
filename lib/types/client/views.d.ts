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
    /**
     * 宿主 `settings.section` 槽位的标准 props 之一（`dsh-client-ui-session` 对
     * `GlobalStandardProps` 的 module augmentation；runner 的 slot-catalog 亦声明
     * `standardProps` 含 `useSessions`）。用途：把**当前会话**透传给 host，使面板不必
     * 再只按 `roots[0]` 解析会话（多会话并存时那是启动期的会话，不是用户正在看的那个）。
     *
     * 本仓不引宿主类型，这里声明最小契约；DSH 仍是 0.1.x-rc、`standardProps` 会随版本
     * 重生成，故调用侧一律**防御式取用**（`typeof === 'function'`）：宿主不提供该 prop 时
     * 面板回退旧行为（host 按 roots[0] 解析），不报错。
     */
    useSessions?: (selector: (state: {
        current?: unknown;
    }) => unknown) => unknown;
}
export declare function RuntimeInventorySection(props: Props): React.ReactElement;
export {};
