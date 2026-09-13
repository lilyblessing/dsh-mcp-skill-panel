import type { Context } from '@deepseek-ai/cordis';
import { type DomainCaches } from './collect';
import type { McpCallController } from './mcpcall';
import type { CatalogRuntime, Config } from './index';
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
export declare function makeRoutes(ctx: Context, caches: DomainCaches, catalogRuntime: CatalogRuntime, config: Config | undefined, controller: McpCallController | undefined, triggerSnapshot: () => Promise<void>): Route[];
export {};
