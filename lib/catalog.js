//#region src/catalog.ts
/** 从完整 tool name 解析 server 段（与 src/index.ts serverOf 一致）。 */
function serverOfMcp(name) {
	if (!name.startsWith("mcp__")) return null;
	const rest = name.slice(5);
	const at = rest.indexOf("__");
	if (at < 0) return null;
	return rest.slice(0, at);
}
/**
* 从 tools.schemas(scope) 的结果里，按 `mcp__<serverName>__` 前缀抽取该 server
* 的全部工具条目。name 是完整工具 id；参数取原样 JSON Schema。
*/
function snapshotFromSchemas(schemas, serverName) {
	const prefix = `mcp__${serverName}__`;
	const out = [];
	for (const schema of schemas) {
		const name = String(schema?.name ?? "");
		if (!name.startsWith(prefix)) continue;
		out.push({
			name,
			description: String(schema?.description ?? ""),
			parameters: schema?.parameters ?? {}
		});
	}
	out.sort((a, b) => a.name.localeCompare(b.name));
	return out;
}
/** 从工具参数 JSON Schema 提取参数名集合（properties 键）。 */
function paramNamesOf(parameters) {
	const names = /* @__PURE__ */ new Set();
	if (parameters && typeof parameters === "object") {
		const props = parameters.properties;
		if (props && typeof props === "object") for (const key of Object.keys(props)) names.add(key.toLowerCase());
	}
	return names;
}
/**
* 关键词全文检索 top-K（P3 网关定稿：加权 B）。
* 打分（bench `.scratch/mvt-5-search-bench.mjs` 实测定稿，加权 B）：
* 工具裸名 substring 15 / server 名 substring 3 / 描述 substring 6 /
* 参数名命中 3 / 公名 haystack（server/bare 拼接）substring 兜底 +1。
* substring 而非 token 精确命中：中文连写（“读文件”）不切分也能命中。
* 返回按分数降序（同分按 server、name 字典序稳定）的命中数组。
*/
function searchCatalog(catalog, query, limit = 8) {
	const terms = String(query).toLowerCase().split(/[\s,，。、/\\|]+/).filter(Boolean);
	if (terms.length === 0) return [];
	const scored = [];
	for (const [server, serverInfo] of Object.entries(catalog)) for (const tool of serverInfo.tools) {
		const bare = tool.name.split("__").pop() ?? tool.name;
		const nameHay = `${server}/${bare}`.toLowerCase();
		const descHay = String(tool.description ?? "").toLowerCase();
		const paramHay = [...paramNamesOf(tool.parameters)].join(" ");
		const serverHay = String(server).toLowerCase();
		let score = 0;
		for (const term of terms) {
			if (bare.toLowerCase().includes(term)) score += 15;
			if (serverHay.includes(term)) score += 3;
			if (descHay.includes(term)) score += 6;
			if (paramHay.includes(term)) score += 3;
			if (nameHay.includes(term)) score += 1;
		}
		if (score > 0) scored.push({
			hit: {
				server,
				tool
			},
			score
		});
	}
	scored.sort((a, b) => b.score - a.score || a.hit.server.localeCompare(b.hit.server) || a.hit.tool.name.localeCompare(b.hit.tool.name));
	const k = Math.max(1, Math.floor(Number(limit) || 1));
	return scored.slice(0, k).map((s) => s.hit);
}
/**
* 列出某 server 的全部工具（精简：name + description；L2 无 schema）。
* 分页：offset/limit（1..200，缺省 0/20；P3 网关定稿 limit=20）。
* 返回 undefined 表示该 server 不在 catalog 中。
*/
function listServer(catalog, server, offset = 0, limit = 20) {
	const serverInfo = catalog[server];
	if (!serverInfo) return void 0;
	const totalCount = serverInfo.tools.length;
	const start = Math.max(0, Math.floor(Number(offset) || 0));
	const size = Math.min(200, Math.max(1, Math.floor(Number(limit) || 20)));
	return {
		tools: serverInfo.tools.slice(start, start + size).map((tool) => ({
			name: tool.name,
			description: tool.description
		})),
		totalCount
	};
}
/** catalog 文件路径：<dir>/catalog.json。 */
function catalogFileFor(dir) {
	return `${dir.replace(/[\\/]$/, "")}/catalog.json`;
}
/** 从目录加载 catalog；文件不存在 / 解析失败时返回空 catalog。 */
async function loadCatalog(dir) {
	try {
		const text = await import("node:fs/promises").then((fsp) => fsp.readFile(catalogFileFor(dir), "utf8"));
		const parsed = JSON.parse(text);
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
		return {};
	} catch {
		return {};
	}
}
/** 原子写回 catalog（tmp + rename，0600）。调用方负责 mkdir。 */
async function saveCatalog(dir, catalog) {
	const fsp = await import("node:fs/promises");
	await fsp.mkdir(dir, { recursive: true });
	const file = catalogFileFor(dir);
	const json = JSON.stringify(catalog, null, 2);
	await fsp.writeFile(`${file}.tmp`, json, {
		encoding: "utf8",
		mode: 384
	});
	await fsp.rename(`${file}.tmp`, file);
}
//#endregion
export { catalogFileFor, listServer, loadCatalog, saveCatalog, searchCatalog, serverOfMcp, snapshotFromSchemas };
