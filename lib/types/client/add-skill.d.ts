/**
 * 创建技能弹窗：名字 / 描述 / 指令（正文）三栏 + 全局/项目目标。
 * 顶部上传区接受单个 SKILL.md / .md 文件 —— 原生解析 frontmatter 预填三栏
 * （零依赖，FileReader.text + 逐行 key: value，不解析 zip）。
 * 指令栏自适应高度：随内容增长，超过上限出滚动条。
 * 全部逻辑（token / 解析 / 提交）在本组件内部，views.tsx 只挂按钮与弹窗。
 */
import React from 'react';
interface Props {
    /** locale 翻译函数（由父级传入，与宿主 locale 插槽一致）。 */
    t: (key: string, params?: Record<string, string | number>) => string;
    /** 当前会话工作空间（cwd）；null = 无会话上下文，禁止「项目」目标。 */
    workspace: string | null;
    /** 关闭弹窗。 */
    onClose: () => void;
    /** 创建成功后回调：父级负责刷新技能列表。 */
    onAdded: () => void;
}
export declare function AddSkillModal(props: Props): React.ReactElement;
export {};
