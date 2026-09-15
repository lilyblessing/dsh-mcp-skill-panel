import type { Context } from '@deepseek-ai/cordis';
import { type DomainCaches } from './collect';
import type { McpCallController } from './mcpcall';
import type { CatalogRuntime, Config } from './index';
import { type ProviderCatalogEntry, type RouteServices } from './model-route';
type Req = import('node:http').IncomingMessage;
type Res = import('node:http').ServerResponse;
export type Route = {
    kind: 'exact';
    path: string;
    handler: (req: Req, res: Res) => void;
};
/** 由 index.ts 在 apply 里注入（热改 live entry 的 config）。 */
export declare function setRowConfigApplyHook(hook: (server: string, config: Record<string, unknown>) => Promise<{
    ok: boolean;
    error?: string;
}>): void;
interface ModelsCatalog {
    providers: ProviderCatalogEntry[];
    cached: boolean;
    fetchedAt: number | null;
}
/** 清空目录缓存（**仅供自测**：TTL 命中 / 失效 / 超时三条路径在 Node 侧的唯一入口）。 */
export declare function __resetModelsCache(): void;
/**
 * 取 provider/模型目录，带 TTL 缓存与单飞。
 *
 * 取舍（为什么必须缓存）：`listModels` 是逐个 provider 打到 adapter 的调用，可能
 * 触达网络；而 `/models` 与其它读端点一样是**无鉴权 GET**（本仓「读端点开放、
 * 写操作鉴权」的设计，见 handleAny 注释）。TTL 缓存把这条开放端点的扇出上界锁死
 * 成**每 60s 至多一次**完整抓取 —— 这就是对「无鉴权读端点会放大到 adapter」的
 * 缓解手段；单飞再保证并发请求共享同一个在飞 promise，不会因并发而乘上扇出。
 *
 * `cached` 的语义：本次响应**直接取自**已完成的 TTL 缓存（没有参与任何抓取）。
 * 与别人共享在飞抓取的并发请求同样是 `false` —— 它们确实不是从缓存拿到的。
 *
 * 时间上界（为什么必须有）：单飞把「一个 adapter 卡住」从「一次慢响应」放大成「端点对外
 * 不可用」—— `inflight` 一旦被一个**永不 settle** 的 `listModels` 钉住，之后每个 `/models`
 * 请求都 await 同一个 pending promise（对外表现为「宿主 llm 服务未提供 provider 目录」，
 * 连报错都没有）。故单次抓取套 `Promise.race` 上界 `MODELS_FETCH_TIMEOUT_MS`：
 * 超时只改**本次请求**的返回（空目录 + `cached:false`），不写缓存、不动 `fetchedAt`，
 * 并清掉 `inflight` 让下一个请求能重新发起抓取；迟到的真实结果照常写缓存。
 *
 * @param llm - 经 ctx.inject 捕获的 llm 服务引用（缺失时降级为空目录，不抛）。
 * @param timeoutMs - 抓取时间上界（ms），**仅供自测注入**（默认 `MODELS_FETCH_TIMEOUT_MS`；
 * 生产调用点不传，避免把一个「测试用的口子」变成第二个配置面）。
 */
export declare function modelsCatalog(llm: RouteServices['llm'], timeoutMs?: number): Promise<ModelsCatalog>;
export declare function makeRoutes(ctx: Context, caches: DomainCaches, catalogRuntime: CatalogRuntime, config: Config | undefined, controller: McpCallController | undefined, triggerSnapshot: () => Promise<void>): Route[];
export {};
