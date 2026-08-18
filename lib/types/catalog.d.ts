/**
 * 私有 MCP catalog —— 采集 / 检索 / 持久化（P1）。
 *
 * 纯逻辑模块：不依赖 Cordis 运行时（仅类型），持久化函数显式接收目录，
 * 这样既能在插件 apply 里对 ~/.dsh/dsh-mcp-skill-panel 使用，也能被
 * scripts/selftest-mcp.mjs 用临时目录做往返自测。
 *
 * 数据形状：
 *   Catalog = { [serverName]: { tools: CatalogEntry[], fetchedAt, source } }
 *   CatalogEntry.name 是完整工具 id（mcp__<server>__<tool>），description 一句话，
 *   parameters 是 JSON Schema 参数对象。
 */
/** 单个工具的目录条目（完整 id + 描述 + 参数 schema）。 */
export interface CatalogEntry {
    name: string;
    description: string;
    parameters: unknown;
}
/** 一个 MCP server 的快照。 */
export interface CatalogServer {
    tools: CatalogEntry[];
    fetchedAt: number;
    source: 'live' | 'cached';
}
/** 私有 catalog：按 serverName 索引。 */
export type Catalog = Record<string, CatalogServer>;
/** 检索命中：server + 工具。 */
export interface SearchHit {
    server: string;
    tool: CatalogEntry;
}
/** 从完整 tool name 解析 server 段（与 src/index.ts serverOf 一致）。 */
export declare function serverOfMcp(name: string): string | null;
/**
 * 从 tools.schemas(scope) 的结果里，按 `mcp__<serverName>__` 前缀抽取该 server
 * 的全部工具条目。name 是完整工具 id；参数取原样 JSON Schema。
 */
export declare function snapshotFromSchemas(schemas: ReadonlyArray<{
    name?: unknown;
    description?: unknown;
    parameters?: unknown;
}>, serverName: string): CatalogEntry[];
/**
 * 关键词全文检索 top-K。
 * 打分：工具名命中 3 / 工具名前缀 2 / 描述命中 2 / 描述前缀 1 / 参数名 1。
 * 返回按分数降序（同分按 server、name 字典序稳定）的命中数组。
 */
export declare function searchCatalog(catalog: Catalog, query: string, limit?: number): SearchHit[];
/**
 * 列出某 server 的全部工具（精简：name + description）。
 * 返回 undefined 表示该 server 不在 catalog 中。
 */
export declare function listServer(catalog: Catalog, server: string): Array<{
    name: string;
    description: string;
}> | undefined;
/** catalog 文件路径：<dir>/catalog.json。 */
export declare function catalogFileFor(dir: string): string;
/** 从目录加载 catalog；文件不存在 / 解析失败时返回空 catalog。 */
export declare function loadCatalog(dir: string): Promise<Catalog>;
/** 原子写回 catalog（tmp + rename，0600）。调用方负责 mkdir。 */
export declare function saveCatalog(dir: string, catalog: Catalog): Promise<void>;
