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
 * 关键词全文检索 top-K（P3 网关定稿：加权 B）。
 * 打分（bench `.scratch/mvt-5-search-bench.mjs` 实测定稿，加权 B）：
 * 工具裸名 substring 15 / server 名 substring 3 / 描述 substring 6 /
 * 参数名命中 3 / 公名 haystack（server/bare 拼接）substring 兜底 +1。
 * substring 而非 token 精确命中：中文连写（“读文件”）不切分也能命中。
 * 返回按分数降序（同分按 server、name 字典序稳定）的命中数组。
 */
export declare function searchCatalog(catalog: Catalog, query: string, limit?: number): SearchHit[];
/**
 * 列出某 server 的全部工具（精简：name + description；L2 无 schema）。
 * 分页：offset/limit（1..200，缺省 0/20；P3 网关定稿 limit=20）。
 * 返回 undefined 表示该 server 不在 catalog 中。
 */
export declare function listServer(catalog: Catalog, server: string, offset?: number, limit?: number): {
    tools: Array<{
        name: string;
        description: string;
    }>;
    totalCount: number;
} | undefined;
/** catalog 文件路径：<dir>/catalog.json。 */
export declare function catalogFileFor(dir: string): string;
/** 从目录加载 catalog；文件不存在 / 解析失败时返回空 catalog。 */
export declare function loadCatalog(dir: string): Promise<Catalog>;
/** 原子写回 catalog（tmp + rename，0600）。调用方负责 mkdir。 */
export declare function saveCatalog(dir: string, catalog: Catalog): Promise<void>;
