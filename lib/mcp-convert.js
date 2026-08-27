//#region src/mcp-convert.ts
/** dsh-mcp-client 的 serverName 约束（存活实例全局唯一 + 命名长度）。 */
const SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;
/** `${VAR}` 环境变量占位（VAR 为 JS 标识符）。 */
const ENV_REF = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;
/** dsh-mcp-client 的插件包名。 */
const MCP_CLIENT_NAME = "@deepseek-ai/dsh-mcp-client";
function isPlainObject(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
function str(value) {
	return typeof value === "string" ? value : void 0;
}
function strArray(value) {
	return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : void 0;
}
function strDict(value) {
	if (!isPlainObject(value)) return void 0;
	const out = {};
	for (const [key, item] of Object.entries(value)) if (typeof item === "string") out[key] = item;
	return out;
}
/** 解析单个 server 配置；失败返回错误文案。 */
function parseServer(name, value) {
	if (!SERVER_NAME_PATTERN.test(name)) return { error: `server "${name}": serverName 需匹配 [A-Za-z0-9_-]{1,32}` };
	if (!isPlainObject(value)) return { error: `server "${name}": 配置需为对象` };
	const cfg = value;
	const explicit = String(cfg.type ?? cfg.transport ?? "").toLowerCase();
	const command = str(cfg.command);
	const url = str(cfg.url);
	let transport;
	if (explicit === "stdio" || explicit === "command") transport = "stdio";
	else if (explicit === "streamable-http" || explicit === "http" || explicit === "sse") transport = "streamable-http";
	else if (command !== void 0) transport = "stdio";
	else if (url !== void 0) transport = "streamable-http";
	if (transport === void 0) return { error: `server "${name}": 无法推断传输方式（需要 command=stdio 或 url=http）` };
	const toolCallTimeoutMs = typeof cfg.toolCallTimeoutMs === "number" && Number.isFinite(cfg.toolCallTimeoutMs) ? cfg.toolCallTimeoutMs : void 0;
	if (transport === "stdio") {
		if (command === void 0) return { error: `server "${name}": stdio 需要 command` };
		return {
			serverName: name,
			transport,
			command,
			args: strArray(cfg.args) ?? [],
			env: strDict(cfg.env) ?? {},
			cwd: str(cfg.cwd),
			toolCallTimeoutMs
		};
	}
	if (url === void 0) return { error: `server "${name}": http 需要 url` };
	return {
		serverName: name,
		transport,
		url,
		headers: strDict(cfg.headers) ?? {},
		toolCallTimeoutMs
	};
}
/**
* 解析 mcpServers JSON 文本。
* 同时接受 `{ "mcpServers": {...} }` 与直接 `{ <name>: {...} }` 两种形态。
*/
function parseMcpServersJson(text) {
	let raw;
	try {
		raw = JSON.parse(text);
	} catch (error) {
		return {
			servers: {},
			errors: [`JSON 解析失败: ${error instanceof Error ? error.message : String(error)}`]
		};
	}
	if (!isPlainObject(raw)) return {
		servers: {},
		errors: ["期望 JSON 对象（mcpServers 映射）"]
	};
	const map = isPlainObject(raw.mcpServers) ? raw.mcpServers : raw;
	const servers = {};
	const errors = [];
	for (const [name, value] of Object.entries(map)) {
		const parsed = parseServer(name, value);
		if ("error" in parsed) {
			errors.push(parsed.error);
			continue;
		}
		servers[name] = parsed;
	}
	return {
		servers,
		errors
	};
}
/** 字符串是否含 `${VAR}` 环境变量占位。 */
function hasEnvRef(value) {
	ENV_REF.lastIndex = 0;
	return ENV_REF.test(value);
}
/** 把含 `${VAR}` 的字符串转成 JS 模板字面量文本（`!!js` 表达式体）。 */
function toJsTemplate(value) {
	return `\`${value.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, "${process.env.$1}")}\``;
}
/** 运行时解析 `${VAR}` → process.env 值；缺失的保留占位符原样（远端报可见错误）。 */
function resolveEnvRefs(value) {
	return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name) => {
		const env = process.env[name];
		return env !== void 0 ? env : `\${${name}}`;
	});
}
/** 递归解析对象内所有字符串值的 ${VAR}（挂载时调用）。 */
function resolveServersEnv(servers) {
	const out = {};
	for (const [name, server] of Object.entries(servers)) {
		const copy = { ...server };
		if (copy.command !== void 0) copy.command = resolveEnvRefs(copy.command);
		if (copy.cwd !== void 0) copy.cwd = resolveEnvRefs(copy.cwd);
		if (copy.url !== void 0) copy.url = resolveEnvRefs(copy.url);
		if (copy.env) {
			const env = {};
			for (const [key, item] of Object.entries(copy.env)) env[key] = resolveEnvRefs(item);
			copy.env = env;
		}
		if (copy.headers) {
			const headers = {};
			for (const [key, item] of Object.entries(copy.headers)) headers[key] = resolveEnvRefs(item);
			copy.headers = headers;
		}
		if (copy.args) copy.args = copy.args.map((item) => resolveEnvRefs(item));
		out[name] = copy;
	}
	return out;
}
/** 把 McpServers 转成 dsh-mcp-client 插件行（loader entry 形状）。 */
function serversToRows(servers, idPrefix = "mcp") {
	const rows = [];
	for (const server of Object.values(servers)) {
		const config = {
			transport: server.transport,
			serverName: server.serverName
		};
		if (server.transport === "stdio") {
			config.command = server.command;
			if (server.args && server.args.length > 0) config.args = server.args;
			if (server.env && Object.keys(server.env).length > 0) config.env = server.env;
			if (server.cwd) config.cwd = server.cwd;
		} else {
			config.url = server.url;
			if (server.headers && Object.keys(server.headers).length > 0) config.headers = server.headers;
		}
		if (server.toolCallTimeoutMs !== void 0) config.toolCallTimeoutMs = server.toolCallTimeoutMs;
		rows.push({
			id: `${idPrefix}-${server.serverName}`,
			name: MCP_CLIENT_NAME,
			config
		});
	}
	return rows;
}
/** JSON 双引号字符串是合法 YAML 标量（内嵌转义由 JSON.stringify 处理）。 */
function yamlString(value) {
	return JSON.stringify(value);
}
/** 单个字符串值 → YAML 标量：含 ${VAR} → `!!js` 模板表达式；否则 JSON 字符串。 */
function yamlScalar(value) {
	if (!hasEnvRef(value)) return yamlString(value);
	return `!!js '${toJsTemplate(value).replace(/'/g, "''")}'`;
}
/** 迷你 YAML 序列化：对象/数组/字符串/数字/布尔（配置结构简单，无需完整 YAML 库）。 */
function emitYaml(obj, indent) {
	const out = [];
	for (const [key, value] of Object.entries(obj)) {
		if (value === void 0) continue;
		if (isPlainObject(value)) {
			out.push(`${indent}${key}:`);
			out.push(...emitYaml(value, `${indent}  `));
		} else if (Array.isArray(value)) {
			out.push(`${indent}${key}:`);
			for (const item of value) out.push(`${indent}  - ${yamlScalar(String(item))}`);
		} else if (typeof value === "string") out.push(`${indent}${key}: ${yamlScalar(value)}`);
		else out.push(`${indent}${key}: ${String(value)}`);
	}
	return out;
}
/** 生成全局 profile 可追加的 `- insert:` patch 块（dsh-mcp-client 行，!!js 环境插值）。 */
function serversToPatchYaml(servers) {
	const lines = [];
	for (const row of serversToRows(servers)) {
		lines.push("- insert:");
		lines.push(`    - id: ${row.id}`);
		lines.push(`      name: '${row.name.replace(/'/g, "''")}'`);
		lines.push("      config:");
		lines.push(...emitYaml(row.config, "        "));
	}
	return lines.join("\n") + "\n";
}
//#endregion
export { MCP_CLIENT_NAME, hasEnvRef, parseMcpServersJson, resolveEnvRefs, resolveServersEnv, serversToPatchYaml, serversToRows, toJsTemplate };
