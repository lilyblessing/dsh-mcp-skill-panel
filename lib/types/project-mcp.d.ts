/**
 * 项目级（工作空间）MCP 运行时：读取 <workspace>/.dsh/mcps 下所有子目录的 mcp.json，
 * 惰性挂载 dsh-mcp-client 行到 loader 根树，并按「当前会话工作空间」过滤可见性，
 * 实现「仅该项目会话可见」。
 *
 * 工作空间 = 会话 cwd（用户约定：只认这个文件夹，不做 .git 向上查找）；
 * 根目录下没有 .dsh/mcps 目录 → 该工作空间没有项目 MCP。
 * 读取规则：<root>/.dsh/mcps/mcp.json 与所有子目录下（`**`）的 mcp.json
 * 都读，按 serverName 去重：先读根目录 json，子目录 json 覆盖根目录。
 *
 * 2026-08-27 实测确认的框架约束：
 * - dsh-mcp-client 的 serverName 按 ctx.root 全局唯一（activeServerNames WeakMap），
 *   跨工作空间同 serverName 只能挂第一个实例，后续冲突跳过并告警。
 * - agent 的 scope key 已被 preset standing key 绑定（bindScopeParent 对已绑定 key
 *   抛错），无法再绑项目作用域 → 严格「按会话作用域挂载」被框架锁死；
 *   因此挂载到 loader 根树（对面板枚举/启停/catalog 完全复用），「仅项目会话可见」
 *   由本模块的常开过滤（system-prompt/assemble 按会话 cwd）实现。
 * - 根树 backing 文件 cordis.yml 每次启动被重置为 []，create 触发的 tree.write 无害。
 * - 已知限制：插件 HMR 重载后 projectOwners 内存表清空（挂载的 projmcp-* 行仍在
 *   根树），在下次会话进入该工作空间前项目行会短暂按全局展示；生产中无 HMR 无此现象。
 */
import type { Context } from '@deepseek-ai/cordis';
import type { McpServers } from './mcp-convert';
/** 查询某 serverName 是否为本项目 MCP 行及其所属工作空间（collect/面板集成用）。 */
export declare function projectServerOwner(serverName: string): string | undefined;
/** 最近一次会话进入的工作空间（add project 目标 + 面板展示当前工作区）。 */
export declare function getActiveWorkspace(): string | null;
/**
 * 扫描工作空间的项目 MCP 配置：根目录 mcp.json 优先，子目录覆盖（后写覆盖先写）。
 * 目录不存在 → 空。解析错误经 warn 回调上报、跳过该文件。
 * 纯文件系统逻辑（不依赖 ctx），可被 selftest 用临时目录覆盖。
 */
export declare function scanWorkspaceMcp(root: string, warn?: (message: string) => void): Promise<McpServers>;
/**
 * 项目 MCP 的 serverName 重命名：追加<路径哈希 8 位 hex>后缀。
 *
 * 背景（2026-08-27 用户需求）：不同工作区可能配置「同 serverName 但路径参数不同」
 * 的项目 MCP（如各自 codegraph 指向不同仓库）。dsh-mcp-client 的 serverName 全进程
 * 唯一，同名会互相挤占 → 后挂载的工作区会拿到前者的路径配置、调用必然失败。
 * 给 serverName 追加确定性路径后缀后，不同工作区 = 不同 serverName = 各自独立实例。
 *
 * 形态：`<原名>-<8位hex>`（如 codegraph-e5f6a7b8，原名领先更可读）。
 * 约束：serverName 限 `[A-Za-z0-9_-]{1,32}`,后缀 8 位 hex + 分隔符 `-`;
 * 原名超过 23 字符时截断尾部（保留头部可读性），总长收敛到 ≤32。
 */
export declare function projectServerName(root: string, name: string): string;
/** 安装项目 MCP 运行时：会话挂载 + 常开过滤。返回整体释放函数。 */
export declare function installProjectMcp(ctx: Context): () => void;
/** 面板添加/外部修改项目 MCP 文件后，强制重扫该工作空间并同步挂载（幂等）。 */
export declare function remountWorkspace(ctx: Context, root: string): Promise<void>;
