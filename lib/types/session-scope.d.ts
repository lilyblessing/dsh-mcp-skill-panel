/**
 * 面板「会话作用域」纯逻辑（零 import —— 与 row-display / preset-text 同模式，独立产物
 * lib/session-scope.js 供 scripts/selftest-mcp.mjs 直接 import 自测）。
 *
 * 背景：面板注册在**进程级全局**的 `settings.section` 槽位，此前它发的所有请求都不带
 * session，于是 host 只能按 `roots[0]` 解析会话（src/routes.ts:950 的 queryParam 缺省）——
 * 多会话并存时，面板显示的是「启动期那个会话」的数据，而用户正在用的是另一个会话。
 *
 * host 侧**一直支持**会话透传：`?session=`（/state、/models）与 body 里的 `session`
 * （/skill/toggle、/mcp/toolBulk）。所以本模块只负责「把当前会话安全地拼进请求」，
 * 不引入任何新端点、不改变任何 host 语义。
 *
 * 硬契约（也是「可独立 revert」的根据）：**取不到会话时，三个函数都必须让调用方产出与
 * 「不透传」逐字节相同的请求** —— 不加查询串、不加 body 键。
 */
/** 归一化宿主给出的会话 id：非字符串 / 空串 / 全空白一律视为「无会话」。 */
export declare function readCurrentSession(value: unknown): string | undefined;
/**
 * 把会话 id 追加进查询串。
 * 无会话 → 原样返回 path（逐字节不变）；有会话 → 按 path 是否已含 `?` 选分隔符并 urlencode。
 */
export declare function withSessionParam(path: string, session: string | undefined): string;
/** POST body 的会话字段：无会话时返回空对象，展开后不新增任何键。 */
export declare function sessionField(session: string | undefined): {
    session?: string;
};
