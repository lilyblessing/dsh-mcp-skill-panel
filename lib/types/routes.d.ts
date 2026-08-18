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
export declare function makeRoutes(ctx: Context, caches: DomainCaches, catalogRuntime: CatalogRuntime, config: Config | undefined, controller: McpCallController | undefined, triggerSnapshot: () => Promise<void>): Route[];
export {};
