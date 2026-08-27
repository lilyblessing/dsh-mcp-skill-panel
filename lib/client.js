window.__ModuleLoader__.load({
	id: "dsh-mcp-skill-panel",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		//#region \0rolldown/runtime.js
		var __create = Object.create;
		var __defProp = Object.defineProperty;
		var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
		var __getOwnPropNames = Object.getOwnPropertyNames;
		var __getProtoOf = Object.getPrototypeOf;
		var __hasOwnProp = Object.prototype.hasOwnProperty;
		var __copyProps = (to, from, except, desc) => {
			if (from && typeof from === "object" || typeof from === "function") for (var keys = __getOwnPropNames(from), i = 0, n = keys.length, key; i < n; i++) {
				key = keys[i];
				if (!__hasOwnProp.call(to, key) && key !== except) __defProp(to, key, {
					get: ((k) => from[k]).bind(null, key),
					enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable
				});
			}
			return to;
		};
		var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(isNodeMode || !mod || !mod.__esModule || !__hasOwnProp.call(mod, "default") ? __defProp(target, "default", {
			value: mod,
			enumerable: true
		}) : target, mod));
		//#endregion
		let react = require("react");
		react = __toESM(react, 1);
		let react_jsx_runtime = require("react/jsx-runtime");
		//#region src/client/add-mcp.tsx
		/**
		* 添加 MCP 弹窗（快速迁移）：粘贴其它 harness 的 mcpServers JSON，
		* 在弹窗内选择「全局 / 项目」目标，转换预览后确认添加。
		*
		* - 全局：写入 <profile>/cordis.patch.yml（- insert: 块，${VAR} → !!js 表达式）+ 立即挂载
		* - 项目：写入 <workspace>/.dsh/mcps/mcp.json（与子目录扫描去重规则一致）+ 重扫挂载
		* 全部逻辑（token / 预览 / 添加 / 结果展示）都在本组件内部，对 views.tsx 零侵入。
		* 样式走宿主 --dsw-alias-* 主题变量（与 views.tsx 一致），本地私有 C，不导出。
		*/
		const C$2 = {
			overlay: {
				position: "fixed",
				inset: 0,
				background: "rgba(0, 0, 0, 0.45)",
				display: "flex",
				alignItems: "center",
				justifyContent: "center",
				zIndex: 1e3
			},
			modal: {
				width: "min(680px, calc(100vw - 48px))",
				maxHeight: "calc(100vh - 80px)",
				overflowY: "auto",
				background: "var(--dsw-alias-bg-layer-1)",
				border: "1px solid var(--dsw-alias-border-l2)",
				borderRadius: 10,
				padding: "16px 18px",
				display: "flex",
				flexDirection: "column",
				gap: 12,
				boxShadow: "0 8px 30px rgba(0,0,0,0.25)"
			},
			title: {
				margin: 0,
				fontSize: 16,
				fontWeight: 600,
				color: "var(--dsw-alias-label-primary)"
			},
			textarea: {
				font: "inherit",
				fontFamily: "ui-monospace, SFMono-Regular, Consolas, monospace",
				fontSize: 12,
				lineHeight: "18px",
				background: "var(--dsw-alias-bg-layer-2)",
				color: "var(--dsw-alias-label-primary)",
				border: "1px solid var(--dsw-alias-border-l2)",
				borderRadius: 6,
				padding: "8px 10px",
				resize: "vertical",
				minHeight: 120
			},
			row: {
				display: "flex",
				alignItems: "center",
				gap: 8
			},
			label: {
				fontSize: 12,
				color: "var(--dsw-alias-label-secondary)"
			},
			tab: (active) => ({
				font: "inherit",
				cursor: "pointer",
				border: "1px solid",
				borderRadius: 6,
				padding: "4px 14px",
				fontSize: 12,
				fontWeight: active ? 600 : 400,
				color: active ? "var(--dsw-alias-label-primary)" : "var(--dsw-alias-label-tertiary)",
				background: active ? "color-mix(in srgb, var(--dsw-alias-state-info-primary, #4a90d9) 16%, transparent)" : "transparent",
				borderColor: active ? "var(--dsw-alias-state-info-primary, #4a90d9)" : "var(--dsw-alias-border-l2)"
			}),
			hint: {
				margin: 0,
				fontSize: 11,
				color: "var(--dsw-alias-label-tertiary)",
				overflow: "hidden",
				textOverflow: "ellipsis",
				whiteSpace: "nowrap"
			},
			action: {
				font: "inherit",
				cursor: "pointer",
				border: "1px solid var(--dsw-alias-border-l2)",
				background: "var(--dsw-alias-bg-layer-1)",
				color: "var(--dsw-alias-label-secondary)",
				borderRadius: 6,
				padding: "5px 14px",
				fontSize: 12
			},
			primary: {
				font: "inherit",
				cursor: "pointer",
				border: 0,
				borderRadius: 6,
				padding: "5px 16px",
				fontSize: 12,
				color: "var(--dsw-alias-label-inverse, #fff)",
				background: "var(--dsw-alias-state-success-primary)"
			},
			primaryDisabled: {
				opacity: .55,
				cursor: "progress"
			},
			error: {
				fontSize: 12,
				color: "var(--dsw-alias-label-primary)",
				background: "color-mix(in srgb, var(--dsw-alias-state-error-primary) 14%, transparent)",
				borderLeft: "3px solid var(--dsw-alias-state-error-primary)",
				borderRadius: 6,
				padding: "8px 10px"
			},
			success: {
				fontSize: 12,
				color: "var(--dsw-alias-label-primary)",
				background: "color-mix(in srgb, var(--dsw-alias-state-success-primary) 14%, transparent)",
				borderLeft: "3px solid var(--dsw-alias-state-success-primary)",
				borderRadius: 6,
				padding: "8px 10px"
			},
			pre: {
				margin: 0,
				maxHeight: 220,
				overflow: "auto",
				fontFamily: "ui-monospace, SFMono-Regular, Consolas, monospace",
				fontSize: 11,
				lineHeight: "16px",
				color: "var(--dsw-alias-label-secondary)",
				background: "var(--dsw-alias-bg-layer-2)",
				border: "1px solid var(--dsw-alias-border-l2)",
				borderRadius: 6,
				padding: "8px 10px",
				whiteSpace: "pre-wrap"
			},
			footer: {
				display: "flex",
				justifyContent: "flex-end",
				gap: 8
			}
		};
		function AddMcpModal(props) {
			const { t, workspace, onClose, onAdded } = props;
			const [json, setJson] = (0, react.useState)("");
			const [target, setTarget] = (0, react.useState)("global");
			const [preview, setPreview] = (0, react.useState)(null);
			const [result, setResult] = (0, react.useState)(null);
			const [busy, setBusy] = (0, react.useState)(null);
			const tokenPromise = (0, react.useRef)(null);
			const ensureToken = (0, react.useCallback)(() => {
				if (!tokenPromise.current) tokenPromise.current = fetch("/api/mcp-skill-panel/token").then((r) => r.json()).then((b) => b?.token ?? null).catch(() => null);
				return tokenPromise.current;
			}, []);
			const post = (0, react.useCallback)(async (path, payload) => {
				const token = await ensureToken();
				const headers = { "content-type": "application/json" };
				if (token) headers["x-panel-token"] = token;
				return await (await fetch(path, {
					method: "POST",
					headers,
					body: JSON.stringify(payload)
				})).json();
			}, [ensureToken]);
			const doPreview = (0, react.useCallback)(async () => {
				setBusy("preview");
				setResult(null);
				setPreview(null);
				try {
					const body = await post("/api/mcp-skill-panel/mcp/preview", { json });
					if (!body.ok || typeof body.yaml !== "string") throw new Error(typeof body.error === "string" ? body.error : "preview failed");
					setPreview({
						names: Array.isArray(body.names) ? body.names : [],
						yaml: body.yaml
					});
				} catch (error) {
					setResult({
						ok: false,
						text: t("ri.addMcpError", { error: error instanceof Error ? error.message : String(error) })
					});
				} finally {
					setBusy(null);
				}
			}, [
				post,
				json,
				t
			]);
			const doAdd = (0, react.useCallback)(async () => {
				if (!json.trim()) return;
				setBusy("add");
				setResult(null);
				try {
					const body = await post("/api/mcp-skill-panel/mcp/add", {
						json,
						target
					});
					if (!body.ok || typeof body.added !== "number") throw new Error(typeof body.error === "string" ? body.error : "add failed");
					onAdded();
					onClose();
				} catch (error) {
					setResult({
						ok: false,
						text: t("ri.addMcpError", { error: error instanceof Error ? error.message : String(error) })
					});
				} finally {
					setBusy(null);
				}
			}, [
				post,
				json,
				target,
				workspace,
				t,
				onAdded,
				onClose
			]);
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				style: C$2.overlay,
				role: "dialog",
				"aria-modal": "true",
				onClick: onClose,
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					style: C$2.modal,
					onClick: (event) => event.stopPropagation(),
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h3", {
							style: C$2.title,
							children: t("ri.addMcp")
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							style: C$2.hint,
							children: t("ri.addMcpPasteHint")
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("textarea", {
							value: json,
							onChange: (event) => setJson(event.target.value),
							placeholder: "{ \"mcpServers\": { \"my-server\": { \"command\": \"…\" } } }",
							style: C$2.textarea,
							rows: 7,
							spellCheck: false
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							style: C$2.row,
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									style: C$2.label,
									children: t("ri.addMcpTarget")
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									style: C$2.tab(target === "global"),
									onClick: () => setTarget("global"),
									children: t("ri.addMcpTargetGlobal")
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									style: {
										...C$2.tab(target === "project"),
										...workspace ? {} : {
											opacity: .5,
											cursor: "not-allowed"
										}
									},
									disabled: !workspace,
									onClick: () => setTarget("project"),
									children: t("ri.addMcpTargetProject")
								}),
								target === "project" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									style: {
										...C$2.hint,
										flex: 1
									},
									children: workspace ? `${t("ri.cwd")}: ${workspace}` : t("ri.addMcpNoWorkspace")
								})
							]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							style: C$2.row,
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								style: C$2.action,
								disabled: busy !== null,
								onClick: () => void doPreview(),
								children: busy === "preview" ? t("ri.pending") : t("ri.addMcpPreview")
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								style: C$2.hint,
								children: preview ? `${t("ri.addMcpPreviewNames")}: ${preview.names.join(", ")}` : ""
							})]
						}),
						result && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							style: result.ok ? C$2.success : C$2.error,
							children: result.text
						}),
						preview && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("pre", {
							style: C$2.pre,
							children: preview.yaml
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							style: C$2.footer,
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								style: C$2.action,
								disabled: busy !== null,
								onClick: onClose,
								children: t("ri.addMcpCancel")
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								style: {
									...C$2.primary,
									...busy !== null ? C$2.primaryDisabled : {}
								},
								disabled: busy !== null,
								onClick: () => void doAdd(),
								children: busy === "add" ? t("ri.pending") : t("ri.addMcpConfirm")
							})]
						})
					]
				})
			});
		}
		//#endregion
		//#region src/client/add-skill.tsx
		/**
		* 创建技能弹窗：名字 / 描述 / 指令（正文）三栏 + 全局/项目目标。
		* 顶部上传区接受单个 SKILL.md / .md 文件 —— 原生解析 frontmatter 预填三栏
		* （零依赖，FileReader.text + 逐行 key: value，不解析 zip）。
		* 指令栏自适应高度：随内容增长，超过上限出滚动条。
		* 全部逻辑（token / 解析 / 提交）在本组件内部，views.tsx 只挂按钮与弹窗。
		*/
		const C$1 = {
			overlay: {
				position: "fixed",
				inset: 0,
				background: "rgba(0, 0, 0, 0.45)",
				display: "flex",
				alignItems: "center",
				justifyContent: "center",
				zIndex: 1e3
			},
			modal: {
				width: "min(620px, calc(100vw - 48px))",
				maxHeight: "calc(100vh - 80px)",
				overflowY: "auto",
				background: "var(--dsw-alias-bg-layer-1)",
				border: "1px solid var(--dsw-alias-border-l2)",
				borderRadius: 10,
				padding: "16px 18px",
				display: "flex",
				flexDirection: "column",
				gap: 12,
				boxShadow: "0 8px 30px rgba(0,0,0,0.25)"
			},
			header: {
				display: "flex",
				alignItems: "center",
				justifyContent: "space-between"
			},
			title: {
				margin: 0,
				fontSize: 16,
				fontWeight: 600,
				color: "var(--dsw-alias-label-primary)"
			},
			close: {
				font: "inherit",
				cursor: "pointer",
				border: 0,
				background: "transparent",
				color: "var(--dsw-alias-label-tertiary)",
				fontSize: 16,
				lineHeight: 1,
				padding: 4
			},
			dropzone: (drag) => ({
				border: `1px dashed ${drag ? "var(--dsw-alias-state-info-primary, #4a90d9)" : "var(--dsw-alias-border-l2)"}`,
				borderRadius: 8,
				padding: "18px 16px",
				textAlign: "center",
				cursor: "pointer",
				background: drag ? "color-mix(in srgb, var(--dsw-alias-state-info-primary, #4a90d9) 8%, transparent)" : "transparent",
				display: "flex",
				flexDirection: "column",
				alignItems: "center",
				gap: 6
			}),
			dropIcon: {
				fontSize: 22,
				color: "var(--dsw-alias-label-secondary)"
			},
			dropTitle: {
				margin: 0,
				fontSize: 13,
				fontWeight: 600,
				color: "var(--dsw-alias-label-primary)"
			},
			dropDesc: {
				margin: 0,
				fontSize: 11,
				lineHeight: "16px",
				color: "var(--dsw-alias-label-tertiary)"
			},
			label: {
				display: "flex",
				alignItems: "center",
				gap: 4,
				margin: "0 0 4px",
				fontSize: 12,
				fontWeight: 600,
				color: "var(--dsw-alias-label-primary)"
			},
			required: { color: "var(--dsw-alias-state-error-primary)" },
			input: {
				font: "inherit",
				width: "100%",
				boxSizing: "border-box",
				background: "var(--dsw-alias-bg-layer-2)",
				color: "var(--dsw-alias-label-primary)",
				border: "1px solid var(--dsw-alias-border-l2)",
				borderRadius: 6,
				padding: "7px 10px",
				fontSize: 12
			},
			textarea: {
				font: "inherit",
				width: "100%",
				boxSizing: "border-box",
				fontFamily: "inherit",
				background: "var(--dsw-alias-bg-layer-2)",
				color: "var(--dsw-alias-label-primary)",
				border: "1px solid var(--dsw-alias-border-l2)",
				borderRadius: 6,
				padding: "7px 10px",
				fontSize: 12,
				lineHeight: "18px",
				resize: "vertical",
				minHeight: 64
			},
			bodyTextarea: {
				overflowY: "auto",
				resize: "none",
				minHeight: 160,
				maxHeight: 340,
				fontFamily: "ui-monospace, SFMono-Regular, Consolas, monospace",
				whiteSpace: "pre-wrap"
			},
			row: {
				display: "flex",
				alignItems: "center",
				gap: 8
			},
			hint: {
				margin: 0,
				fontSize: 11,
				color: "var(--dsw-alias-label-tertiary)"
			},
			tab: (active) => ({
				font: "inherit",
				cursor: "pointer",
				border: "1px solid",
				borderRadius: 6,
				padding: "4px 14px",
				fontSize: 12,
				fontWeight: active ? 600 : 400,
				color: active ? "var(--dsw-alias-label-primary)" : "var(--dsw-alias-label-tertiary)",
				background: active ? "color-mix(in srgb, var(--dsw-alias-state-info-primary, #4a90d9) 16%, transparent)" : "transparent",
				borderColor: active ? "var(--dsw-alias-state-info-primary, #4a90d9)" : "var(--dsw-alias-border-l2)"
			}),
			action: {
				font: "inherit",
				cursor: "pointer",
				border: "1px solid var(--dsw-alias-border-l2)",
				background: "var(--dsw-alias-bg-layer-1)",
				color: "var(--dsw-alias-label-secondary)",
				borderRadius: 6,
				padding: "5px 16px",
				fontSize: 12
			},
			primary: {
				font: "inherit",
				cursor: "pointer",
				border: 0,
				borderRadius: 6,
				padding: "5px 16px",
				fontSize: 12,
				color: "var(--dsw-alias-label-inverse, #fff)",
				background: "var(--dsw-alias-state-success-primary)"
			},
			disabledButton: {
				opacity: .55,
				cursor: "progress"
			},
			error: {
				fontSize: 12,
				color: "var(--dsw-alias-label-primary)",
				background: "color-mix(in srgb, var(--dsw-alias-state-error-primary) 14%, transparent)",
				borderLeft: "3px solid var(--dsw-alias-state-error-primary)",
				borderRadius: 6,
				padding: "8px 10px"
			},
			success: {
				fontSize: 12,
				color: "var(--dsw-alias-label-primary)",
				background: "color-mix(in srgb, var(--dsw-alias-state-success-primary) 14%, transparent)",
				borderLeft: "3px solid var(--dsw-alias-state-success-primary)",
				borderRadius: 6,
				padding: "8px 10px",
				wordBreak: "break-all"
			},
			footer: {
				display: "flex",
				justifyContent: "flex-end",
				gap: 8
			}
		};
		/** 解析单个 SKILL.md 文本：frontmatter 的 name/description + 正文（零依赖逐行解析）。 */
		function parseSkillMd(text) {
			const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
			if (!m) return { body: text };
			const fields = {};
			for (const line of m[1].split(/\r?\n/)) {
				const km = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
				if (!km) continue;
				let value = km[2].trim();
				if (value.startsWith("\"") && value.endsWith("\"") && value.length >= 2 || value.startsWith("'") && value.endsWith("'") && value.length >= 2) value = value.slice(1, -1);
				fields[km[1].toLowerCase()] = value;
			}
			return {
				name: fields.name || void 0,
				description: fields.description || void 0,
				body: text.slice(m[0].length)
			};
		}
		function AddSkillModal(props) {
			const { t, workspace, onClose, onAdded } = props;
			const [name, setName] = (0, react.useState)("");
			const [description, setDescription] = (0, react.useState)("");
			const [body, setBody] = (0, react.useState)("");
			const [target, setTarget] = (0, react.useState)("global");
			const [drag, setDrag] = (0, react.useState)(false);
			const [result, setResult] = (0, react.useState)(null);
			const [busy, setBusy] = (0, react.useState)(false);
			const bodyRef = (0, react.useRef)(null);
			const fileRef = (0, react.useRef)(null);
			const tokenPromise = (0, react.useRef)(null);
			const ensureToken = (0, react.useCallback)(() => {
				if (!tokenPromise.current) tokenPromise.current = fetch("/api/mcp-skill-panel/token").then((r) => r.json()).then((b) => b?.token ?? null).catch(() => null);
				return tokenPromise.current;
			}, []);
			/** 指令栏自适应高度：内容增长撑开，超过 maxHeight 后内部滚动（出现滚动条）。 */
			const autoResize = (0, react.useCallback)(() => {
				const el = bodyRef.current;
				if (!el) return;
				el.style.height = "auto";
				el.style.height = `${Math.min(el.scrollHeight, 340)}px`;
			}, []);
			const onChangeBody = (0, react.useCallback)((value) => {
				setBody(value);
				autoResize();
			}, [autoResize]);
			/** 上传 .md：原生解析 frontmatter 预填名字/描述，其余进指令栏。 */
			const onFile = (0, react.useCallback)((file) => {
				if (!file) return;
				file.text().then((text) => {
					const parsed = parseSkillMd(text);
					if (parsed.name && isValidSkillNameClient(parsed.name)) setName(parsed.name);
					if (parsed.description) setDescription(parsed.description);
					setBody(parsed.body);
					setResult(null);
					requestAnimationFrame(autoResize);
				}).catch((error) => {
					setResult({
						ok: false,
						text: t("ri.addSkillError", { error: error instanceof Error ? error.message : String(error) })
					});
				});
			}, [autoResize, t]);
			const nameValid = isValidSkillNameClient(name);
			const submit = (0, react.useCallback)(async () => {
				if (!nameValid || description.trim().length === 0 || body.trim().length === 0) return;
				setBusy(true);
				setResult(null);
				try {
					const token = await ensureToken();
					const headers = { "content-type": "application/json" };
					if (token) headers["x-panel-token"] = token;
					const data = await (await fetch("/api/mcp-skill-panel/skill/add", {
						method: "POST",
						headers,
						body: JSON.stringify({
							name,
							description,
							body,
							target,
							workspace: workspace ?? void 0
						})
					})).json();
					if (!data.ok || !data.path) throw new Error(data.error ?? "add skill failed");
					onAdded();
					onClose();
				} catch (error) {
					setResult({
						ok: false,
						text: t("ri.addSkillError", { error: error instanceof Error ? error.message : String(error) })
					});
				} finally {
					setBusy(false);
				}
			}, [
				nameValid,
				name,
				description,
				body,
				target,
				workspace,
				ensureToken,
				t,
				onAdded,
				onClose
			]);
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				style: C$1.overlay,
				role: "dialog",
				"aria-modal": "true",
				onClick: onClose,
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					style: C$1.modal,
					onClick: (event) => event.stopPropagation(),
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							style: C$1.header,
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h3", {
								style: C$1.title,
								children: t("ri.addSkill")
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								style: C$1.close,
								"aria-label": t("ri.addSkillCancel"),
								onClick: onClose,
								children: "✕"
							})]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							style: C$1.dropzone(drag),
							onClick: () => fileRef.current?.click(),
							onDragOver: (event) => {
								event.preventDefault();
								setDrag(true);
							},
							onDragLeave: () => setDrag(false),
							onDrop: (event) => {
								event.preventDefault();
								setDrag(false);
								onFile(event.dataTransfer.files?.[0]);
							},
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									style: C$1.dropIcon,
									children: "⬆"
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
									style: C$1.dropTitle,
									children: t("ri.addSkillDropTitle")
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
									style: C$1.dropDesc,
									children: t("ri.addSkillDropDesc")
								})
							]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
							ref: fileRef,
							type: "file",
							accept: ".md,.markdown,text/markdown",
							style: { display: "none" },
							onChange: (event) => {
								onFile(event.target.files?.[0]);
								event.target.value = "";
							}
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", {
								style: C$1.label,
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									style: C$1.required,
									children: "*"
								}), t("ri.addSkillName")]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
								value: name,
								onChange: (event) => setName(event.target.value),
								placeholder: t("ri.addSkillNamePh"),
								style: C$1.input,
								spellCheck: false
							}),
							name.length > 0 && !nameValid && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
								style: {
									...C$1.hint,
									color: "var(--dsw-alias-state-error-primary)",
									marginTop: 4
								},
								children: t("ri.addSkillNameInvalid")
							})
						] }),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", {
							style: C$1.label,
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								style: C$1.required,
								children: "*"
							}), t("ri.addSkillDesc")]
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("textarea", {
							value: description,
							onChange: (event) => setDescription(event.target.value),
							placeholder: t("ri.addSkillDescPh"),
							style: C$1.textarea,
							rows: 2
						})] }),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", {
							style: C$1.label,
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								style: C$1.required,
								children: "*"
							}), t("ri.addSkillBody")]
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("textarea", {
							ref: bodyRef,
							value: body,
							onChange: (event) => onChangeBody(event.target.value),
							placeholder: t("ri.addSkillBodyPh"),
							style: {
								...C$1.textarea,
								...C$1.bodyTextarea
							},
							spellCheck: false
						})] }),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							style: C$1.row,
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									style: C$1.label,
									children: t("ri.addMcpTarget")
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									style: C$1.tab(target === "global"),
									onClick: () => setTarget("global"),
									children: t("ri.addMcpTargetGlobal")
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									style: {
										...C$1.tab(target === "project"),
										...workspace ? {} : {
											opacity: .5,
											cursor: "not-allowed"
										}
									},
									disabled: !workspace,
									onClick: () => setTarget("project"),
									children: t("ri.addMcpTargetProject")
								}),
								target === "project" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									style: {
										...C$1.hint,
										flex: 1,
										overflow: "hidden",
										textOverflow: "ellipsis",
										whiteSpace: "nowrap"
									},
									children: workspace ?? t("ri.addMcpNoWorkspace")
								})
							]
						}),
						result && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							style: result.ok ? C$1.success : C$1.error,
							children: result.text
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							style: C$1.footer,
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								style: C$1.action,
								disabled: busy,
								onClick: onClose,
								children: t("ri.addSkillCancel")
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								style: {
									...C$1.primary,
									...busy || !nameValid || !description.trim() || !body.trim() ? C$1.disabledButton : {}
								},
								disabled: busy || !nameValid || !description.trim().length || !body.trim().length,
								onClick: () => void submit(),
								children: busy ? t("ri.pending") : t("ri.addSkillConfirm")
							})]
						})
					]
				})
			});
		}
		/** 客户端本地 kebab-case 校验（与服务端 preset.isValidSkillName 同规则）。 */
		function isValidSkillNameClient(name) {
			return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name);
		}
		//#endregion
		//#region src/client/views.tsx
		/**
		* MCP 与技能管理面板：MCP 服务器 / 技能 双标签页，统计头 + 卡片 + 启停开关。
		* 样式全部 JS 内联（宿主全局 CSS 可能覆盖注入的 class），颜色走 --dsw-alias-* 主题变量。
		* 视图形状类型来自 shared-types（与 host 单一来源，type-only import 不打包）。
		*/
		const C = {
			page: {
				display: "flex",
				flexDirection: "column",
				gap: "12px",
				maxWidth: "760px",
				padding: "4px 2px"
			},
			header: {
				display: "flex",
				alignItems: "center",
				justifyContent: "space-between",
				gap: "8px"
			},
			title: {
				margin: 0,
				fontSize: 18,
				fontWeight: 600,
				color: "var(--dsw-alias-label-primary)"
			},
			meta: {
				margin: "2px 0 0",
				fontSize: 12,
				color: "var(--dsw-alias-label-tertiary)"
			},
			refresh: {
				font: "inherit",
				cursor: "pointer",
				border: "1px solid var(--dsw-alias-border-l2)",
				background: "var(--dsw-alias-bg-layer-1)",
				color: "var(--dsw-alias-label-secondary)",
				borderRadius: 6,
				padding: "5px 12px",
				fontSize: 12
			},
			tabs: {
				display: "flex",
				gap: "18px",
				borderBottom: "1px solid var(--dsw-alias-border-l2)",
				alignItems: "flex-end"
			},
			tab: (active) => ({
				font: "inherit",
				cursor: "pointer",
				background: "transparent",
				border: 0,
				padding: "7px 1px 9px",
				fontSize: 13,
				lineHeight: "20px",
				color: active ? "var(--dsw-alias-label-primary)" : "var(--dsw-alias-label-tertiary)",
				borderBottom: active ? "2px solid var(--dsw-alias-label-primary)" : "2px solid transparent",
				marginBottom: -1
			}),
			stats: {
				display: "flex",
				gap: "8px",
				flexWrap: "wrap"
			},
			stat: {
				flex: "1 1 0",
				minWidth: 120,
				background: "var(--dsw-alias-bg-layer-1)",
				border: "1px solid var(--dsw-alias-border-l2)",
				borderRadius: 8,
				padding: "10px 12px",
				display: "flex",
				flexDirection: "column",
				gap: 2
			},
			statValue: {
				fontSize: 18,
				fontWeight: 600,
				color: "var(--dsw-alias-label-primary)"
			},
			statLabel: {
				fontSize: 11,
				color: "var(--dsw-alias-label-tertiary)"
			},
			card: {
				background: "var(--dsw-alias-bg-layer-1)",
				border: "1px solid var(--dsw-alias-border-l2)",
				borderRadius: 8,
				padding: "10px 12px",
				display: "flex",
				flexDirection: "column",
				gap: 4
			},
			cardTop: {
				display: "flex",
				alignItems: "center",
				justifyContent: "space-between",
				gap: "8px"
			},
			cardTitle: {
				margin: 0,
				fontSize: 14,
				fontWeight: 600,
				color: "var(--dsw-alias-label-primary)",
				display: "flex",
				alignItems: "center",
				gap: 8
			},
			cardDesc: {
				margin: 0,
				fontSize: 12,
				color: "var(--dsw-alias-label-secondary)",
				lineHeight: "18px"
			},
			cardMeta: {
				fontSize: 11,
				color: "var(--dsw-alias-label-tertiary)"
			},
			badge: (color, bg) => ({
				fontSize: 11,
				lineHeight: "16px",
				padding: "0 7px",
				borderRadius: 999,
				color,
				background: bg,
				whiteSpace: "nowrap"
			}),
			toggle: (disabled) => ({
				font: "inherit",
				cursor: "pointer",
				border: 0,
				borderRadius: 6,
				padding: "4px 12px",
				fontSize: 12,
				color: "var(--dsw-alias-label-inverse, #fff)",
				background: disabled ? "var(--dsw-alias-state-success-primary)" : "var(--dsw-alias-state-error-primary)",
				whiteSpace: "nowrap"
			}),
			toggleDisabled: {
				opacity: .55,
				cursor: "progress"
			},
			hint: {
				margin: 0,
				fontSize: 11,
				color: "var(--dsw-alias-label-tertiary)"
			},
			error: {
				fontSize: 12,
				color: "var(--dsw-alias-label-primary)",
				background: "color-mix(in srgb, var(--dsw-alias-state-error-primary) 14%, transparent)",
				borderLeft: "3px solid var(--dsw-alias-state-error-primary)",
				borderRadius: 6,
				padding: "8px 10px"
			},
			empty: {
				fontSize: 13,
				color: "var(--dsw-alias-label-tertiary)",
				padding: "16px 0",
				textAlign: "center"
			},
			warn: {
				display: "flex",
				alignItems: "center",
				justifyContent: "space-between",
				gap: "8px",
				fontSize: 12,
				lineHeight: "18px",
				color: "var(--dsw-alias-label-primary)",
				background: "color-mix(in srgb, var(--dsw-alias-state-warn-primary) 16%, transparent)",
				borderLeft: "3px solid var(--dsw-alias-state-warn-primary)",
				borderRadius: 6,
				padding: "8px 10px"
			},
			warnSevere: {
				color: "var(--dsw-alias-label-primary)",
				background: "color-mix(in srgb, var(--dsw-alias-state-error-primary) 24%, transparent)",
				borderLeft: "3px solid var(--dsw-alias-state-error-primary)",
				fontWeight: 600
			},
			warnDismiss: {
				font: "inherit",
				cursor: "pointer",
				border: 0,
				background: "transparent",
				color: "inherit",
				opacity: .85,
				padding: "2px 6px",
				borderRadius: 4,
				fontSize: 12,
				whiteSpace: "nowrap"
			},
			toolToggleBtn: {
				font: "inherit",
				cursor: "pointer",
				border: 0,
				background: "transparent",
				color: "var(--dsw-alias-label-tertiary)",
				padding: "2px 2px",
				fontSize: 12,
				alignSelf: "flex-start"
			},
			toolList: {
				marginTop: 4,
				borderTop: "1px solid var(--dsw-alias-border-l2)",
				paddingTop: 6,
				display: "flex",
				flexDirection: "column",
				gap: 4,
				maxHeight: 220,
				overflowY: "auto"
			},
			toolRow: {
				display: "flex",
				alignItems: "center",
				gap: 8,
				fontSize: 12
			},
			toolName: {
				flex: "0 0 auto",
				color: "var(--dsw-alias-label-primary)",
				fontWeight: 500
			},
			toolDesc: {
				flex: 1,
				color: "var(--dsw-alias-label-tertiary)",
				overflow: "hidden",
				textOverflow: "ellipsis",
				whiteSpace: "nowrap"
			},
			toolSwitch: (disabled) => ({
				font: "inherit",
				cursor: "pointer",
				border: 0,
				borderRadius: 5,
				padding: "2px 10px",
				fontSize: 11,
				flex: "0 0 auto",
				color: "var(--dsw-alias-label-inverse, #fff)",
				background: disabled ? "var(--dsw-alias-state-success-primary)" : "var(--dsw-alias-state-error-primary)",
				whiteSpace: "nowrap"
			})
		};
		function formatK(n) {
			return n >= 1e3 ? (n / 1e3).toFixed(1).replace(/\.0$/, "") : String(n);
		}
		const MCP_BATCH_DEBOUNCE_MS = 400;
		const CACHE_WARN_MAX_TOOLS = 50;
		const CACHE_WARN_MAX_TOKENS = 1e4;
		const CACHE_WARN_AUTO_DISMISS_MS = 12e3;
		function RuntimeInventorySection(props) {
			const { t } = props;
			const [tab, setTab] = (0, react.useState)("mcp");
			const [mcp, setMcp] = (0, react.useState)(null);
			const [skills, setSkills] = (0, react.useState)(null);
			const [error, setError] = (0, react.useState)(null);
			const [busy, setBusy] = (0, react.useState)({});
			const [warn, setWarn] = (0, react.useState)(null);
			const warnTimer = react.default.useRef(null);
			const showWarn = (0, react.useCallback)((text, severe) => {
				setWarn({
					text,
					severe
				});
				if (warnTimer.current) clearTimeout(warnTimer.current);
				warnTimer.current = setTimeout(() => setWarn(null), CACHE_WARN_AUTO_DISMISS_MS);
			}, []);
			const [applyMode, setApplyMode] = (0, react.useState)("immediate");
			const [showAdd, setShowAdd] = (0, react.useState)(false);
			const [showAddSkill, setShowAddSkill] = (0, react.useState)(false);
			const mcpSeq = react.default.useRef(0);
			const skillsSeq = react.default.useRef(0);
			const load = (0, react.useCallback)((part) => {
				const ref = part === "mcp" ? mcpSeq : skillsSeq;
				const seq = ++ref.current;
				setError(null);
				fetch(`/api/mcp-skill-panel/state?part=${part}`).then((res) => res.json()).then((body) => {
					if (!body.ok || !body.state) throw new Error(body.error ?? "bad response");
					if (seq !== ref.current) return;
					if (part === "mcp") setMcp(body.state);
					else setSkills(body.state);
				}).catch((err) => {
					if (seq === ref.current) setError(err instanceof Error ? err.message : String(err));
				});
			}, []);
			const loadMcp = (0, react.useCallback)(() => load("mcp"), [load]);
			const loadSkills = (0, react.useCallback)(() => load("skills"), [load]);
			(0, react.useEffect)(() => {
				if (tab === "mcp") loadMcp();
				else loadSkills();
			}, [
				tab,
				loadMcp,
				loadSkills
			]);
			(0, react.useEffect)(() => {
				fetch("/api/mcp-skill-panel/config").then((r) => r.json()).then((b) => {
					if (b.ok && b.applyMode) setApplyMode(b.applyMode);
				}).catch(() => {});
			}, []);
			const hasPending = Boolean(mcp?.mcp?.some((r) => r.pending));
			const tokenPromise = react.default.useRef(null);
			const ensureToken = (0, react.useCallback)(() => {
				if (!tokenPromise.current) tokenPromise.current = fetch("/api/mcp-skill-panel/token").then((r) => r.json()).then((b) => b?.token ?? null).catch(() => null);
				return tokenPromise.current;
			}, []);
			const post = (0, react.useCallback)(async (path, payload, key, onOk) => {
				setBusy((prev) => ({
					...prev,
					[key]: true
				}));
				setError(null);
				const token = await ensureToken();
				const headers = { "content-type": "application/json" };
				if (token) headers["x-panel-token"] = token;
				fetch(path, {
					method: "POST",
					headers,
					body: JSON.stringify(payload)
				}).then((res) => res.json()).then((body) => {
					if (!body.ok) throw new Error(body.error ?? "toggle failed");
					onOk();
				}).catch((err) => {
					setError(t("ri.toggleError", { error: err instanceof Error ? err.message : String(err) }));
					loadMcp();
					loadSkills();
				}).finally(() => setBusy((prev) => ({
					...prev,
					[key]: false
				})));
			}, [
				t,
				loadMcp,
				loadSkills,
				ensureToken
			]);
			const mcpBatch = react.default.useRef(/* @__PURE__ */ new Map());
			const mcpBatchTimer = react.default.useRef(null);
			const flushMcpBatch = (0, react.useCallback)(async () => {
				if (mcpBatchTimer.current) {
					clearTimeout(mcpBatchTimer.current);
					mcpBatchTimer.current = null;
				}
				const items = Array.from(mcpBatch.current.values());
				mcpBatch.current.clear();
				if (items.length === 0) return;
				const keys = items.map((it) => `mcp:${it.rowId}`);
				setBusy((prev) => {
					const next = { ...prev };
					for (const k of keys) next[k] = true;
					return next;
				});
				setError(null);
				const token = await ensureToken();
				const headers = { "content-type": "application/json" };
				if (token) headers["x-panel-token"] = token;
				try {
					const body = await (await fetch("/api/mcp-skill-panel/mcp/toggleBatch", {
						method: "POST",
						headers,
						body: JSON.stringify({ toggles: items.map(({ entryId, disabled }) => ({
							entryId,
							disabled
						})) })
					})).json();
					if (!body.ok) throw new Error(body.error ?? "batch toggle failed");
					if (body.failed && body.failed > 0) {
						const firstErr = body.results?.find((r) => r.ok === false)?.error;
						setError(t("ri.toggleError", { error: `batch: ${body.failed} failed${firstErr ? ` — ${firstErr}` : ""}` }));
					}
					loadMcp();
				} catch (err) {
					setError(t("ri.toggleError", { error: err instanceof Error ? err.message : String(err) }));
					loadMcp();
					loadSkills();
				} finally {
					setBusy((prev) => {
						const next = { ...prev };
						for (const k of keys) next[k] = false;
						return next;
					});
				}
			}, [
				t,
				loadMcp,
				loadSkills,
				ensureToken
			]);
			const toggleMcp = (0, react.useCallback)((row) => {
				if (applyMode === "immediate") showWarn(t("ri.cacheWarn"), row.tools > CACHE_WARN_MAX_TOOLS || row.tokens > CACHE_WARN_MAX_TOKENS);
				else showWarn(t("ri.applyDeferredHint"), false);
				const effDisabled = applyMode === "next-session" && row.pending ? row.desired ?? row.disabled : row.disabled;
				mcpBatch.current.set(row.entryId, {
					entryId: row.entryId,
					rowId: row.rowId,
					disabled: !effDisabled
				});
				if (mcpBatchTimer.current) clearTimeout(mcpBatchTimer.current);
				mcpBatchTimer.current = setTimeout(() => void flushMcpBatch(), MCP_BATCH_DEBOUNCE_MS);
			}, [
				showWarn,
				flushMcpBatch,
				applyMode,
				t
			]);
			(0, react.useEffect)(() => () => {
				if (warnTimer.current) clearTimeout(warnTimer.current);
				flushMcpBatch();
			}, [flushMcpBatch]);
			const toggleAutoManage = async () => {
				const next = !(mcp?.autoManage ?? false);
				showWarn(t("ri.cacheWarn"), false);
				setBusy((prev) => ({
					...prev,
					autoManage: true
				}));
				setError(null);
				const token = await ensureToken();
				const headers = { "content-type": "application/json" };
				if (token) headers["x-panel-token"] = token;
				fetch("/api/mcp-skill-panel/config", {
					method: "POST",
					headers,
					body: JSON.stringify({ autoManage: next })
				}).then((res) => res.json()).then((body) => {
					if (!body.ok) throw new Error(body.error ?? "config update failed");
					setMcp((prev) => prev ? {
						...prev,
						autoManage: Boolean(body.autoManage)
					} : prev);
					loadMcp();
				}).catch((err) => {
					setError(t("ri.toggleError", { error: err instanceof Error ? err.message : String(err) }));
				}).finally(() => setBusy((prev) => ({
					...prev,
					autoManage: false
				})));
			};
			const toggleSkill = (row) => {
				showWarn(t("ri.cacheWarn"), false);
				post("/api/mcp-skill-panel/skill/toggle", {
					name: row.name,
					disabled: row.modelInvocable
				}, `skill:${row.name}`, () => {
					setSkills((prev) => prev ? {
						...prev,
						skills: prev.skills.map((s) => s.name === row.name ? {
							...s,
							modelInvocable: !row.modelInvocable,
							userInvocable: s.userInvocable
						} : s),
						skillsModelVisible: prev.skillsModelVisible + (row.modelInvocable ? -1 : 1)
					} : prev);
					loadSkills();
				});
			};
			const mcpStatus = (0, react.useCallback)((row) => {
				switch (row.status) {
					case "active": return {
						label: t("ri.statusActive"),
						color: "var(--dsw-alias-state-success-primary)",
						bg: "var(--dsw-alias-state-success-tertiary)"
					};
					case "disabled": return {
						label: t("ri.statusDisabled"),
						color: "var(--dsw-alias-label-tertiary)",
						bg: "var(--dsw-alias-fill-l2)"
					};
					case "idle": return {
						label: t("ri.statusIdle"),
						color: "var(--dsw-alias-state-warn-primary)",
						bg: "var(--dsw-alias-state-warn-tertiary)"
					};
					default: return {
						label: t("ri.statusFailed"),
						color: "var(--dsw-alias-state-error-primary)",
						bg: "var(--dsw-alias-state-error-secondary)"
					};
				}
			}, [t]);
			const view = tab === "mcp" ? mcp : skills;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				style: C.page,
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: C.header,
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h2", {
							style: C.title,
							children: t("ri.nav")
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							style: C.meta,
							children: view ? `${t("ri.preset")}: ${view.preset ?? "—"} · ${t("ri.session")}: ${view.sessionId ?? "—"}` : ""
						})] }), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							style: {
								display: "flex",
								gap: 8
							},
							children: [
								tab === "mcp" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									style: C.refresh,
									onClick: () => setShowAdd(true),
									children: t("ri.addMcp")
								}),
								tab === "skill" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									style: C.refresh,
									onClick: () => setShowAddSkill(true),
									children: t("ri.addSkill")
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									style: C.refresh,
									onClick: () => {
										flushMcpBatch();
										if (tab === "mcp") loadMcp();
										else loadSkills();
									},
									children: t("ri.refresh")
								})
							]
						})]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: C.tabs,
						role: "tablist",
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							role: "tab",
							"aria-selected": tab === "mcp",
							style: C.tab(tab === "mcp"),
							onClick: () => setTab("mcp"),
							children: t("ri.mcpTab")
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							role: "tab",
							"aria-selected": tab === "skill",
							style: C.tab(tab === "skill"),
							onClick: () => setTab("skill"),
							children: t("ri.skillTab")
						})]
					}),
					error && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						style: C.error,
						children: error
					}),
					warn && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: {
							...C.warn,
							...warn.severe ? C.warnSevere : {}
						},
						role: "status",
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: warn.text }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							style: C.warnDismiss,
							onClick: () => {
								if (warnTimer.current) clearTimeout(warnTimer.current);
								setWarn(null);
							},
							children: t("ri.cacheWarnDismiss")
						})]
					}),
					!view && !error && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						style: C.empty,
						children: t("ri.loading")
					}),
					view && tab === "mcp" && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)(AutoManageCard, {
							on: view.autoManage,
							busy: Boolean(busy.autoManage),
							t,
							onToggle: toggleAutoManage
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)(ApplyTimingCard, {
							applyMode,
							hasPending,
							busy: Boolean(busy.applyMode),
							t,
							onModeChange: setApplyMode,
							loadMcp,
							ensureToken,
							setError,
							showWarn,
							setBusy
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)(McpPanel, {
							state: view,
							t,
							busy,
							onToggle: toggleMcp,
							statusOf: mcpStatus,
							applyMode,
							loadMcp
						})
					] }),
					view && tab === "skill" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(SkillPanel, {
						state: view,
						t,
						busy,
						onToggle: toggleSkill
					}),
					showAdd && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(AddMcpModal, {
						t,
						workspace: mcp?.activeWorkspace ?? mcp?.cwd ?? null,
						onClose: () => setShowAdd(false),
						onAdded: loadMcp
					}),
					showAddSkill && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(AddSkillModal, {
						t,
						workspace: skills?.cwd ?? null,
						onClose: () => setShowAddSkill(false),
						onAdded: loadSkills
					})
				]
			});
		}
		/** P2-7：状态徽标小组件（替代散落的 C.badge span 样板）。 */
		function Badge(props) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
				style: C.badge(props.color, props.bg),
				children: props.children
			});
		}
		function AutoManageCard(props) {
			const { on, busy, t, onToggle } = props;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				style: C.card,
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					style: C.cardTop,
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("h3", {
						style: C.cardTitle,
						children: [t("ri.autoManageTitle"), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Badge, {
							color: on ? "var(--dsw-alias-state-success-primary)" : "var(--dsw-alias-label-tertiary)",
							bg: on ? "var(--dsw-alias-state-success-tertiary)" : "var(--dsw-alias-fill-l2)",
							children: on ? t("ri.autoManageOn") : t("ri.autoManageOff")
						})]
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
						type: "button",
						style: {
							...C.toggle(!on),
							...busy ? C.toggleDisabled : {}
						},
						disabled: busy,
						onClick: onToggle,
						children: busy ? t("ri.pending") : on ? t("ri.disable") : t("ri.enable")
					})]
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
					style: C.cardDesc,
					children: on ? t("ri.autoManageDescOn") : t("ri.autoManageDescOff")
				})]
			});
		}
		function ApplyTimingCard(props) {
			const { applyMode, hasPending, busy, t, onModeChange, loadMcp, ensureToken, setError, showWarn, setBusy } = props;
			const switchMode = (0, react.useCallback)(async (mode) => {
				if (mode === applyMode) return;
				const token = await ensureToken();
				const headers = { "content-type": "application/json" };
				if (token) headers["x-panel-token"] = token;
				fetch("/api/mcp-skill-panel/config", {
					method: "POST",
					headers,
					body: JSON.stringify({ applyMode: mode })
				}).then((r) => r.json()).then((b) => {
					if (!b.ok) throw new Error(b.error ?? "config update failed");
					onModeChange(mode);
					loadMcp();
				}).catch((err) => {
					setError(t("ri.toggleError", { error: err instanceof Error ? err.message : String(err) }));
				});
			}, [
				applyMode,
				ensureToken,
				onModeChange,
				loadMcp,
				setError,
				t
			]);
			const applyPending = (0, react.useCallback)(async () => {
				showWarn(t("ri.cacheWarn"), true);
				setBusy((prev) => ({
					...prev,
					applyMode: true
				}));
				setError(null);
				const token = await ensureToken();
				const headers = { "content-type": "application/json" };
				if (token) headers["x-panel-token"] = token;
				fetch("/api/mcp-skill-panel/mcp/applyPending", {
					method: "POST",
					headers
				}).then((r) => r.json()).then((b) => {
					if (!b.ok) throw new Error(b.error ?? "applyPending failed");
					loadMcp();
					showWarn(t("ri.appliedPending", { n: b.applied ?? 0 }), false);
				}).catch((err) => {
					setError(t("ri.toggleError", { error: err instanceof Error ? err.message : String(err) }));
				}).finally(() => setBusy((prev) => ({
					...prev,
					applyMode: false
				})));
			}, [
				ensureToken,
				loadMcp,
				showWarn,
				setError,
				setBusy,
				t
			]);
			const modeBtn = (mode) => ({
				font: "inherit",
				cursor: "pointer",
				border: "1px solid",
				borderRadius: 6,
				padding: "4px 12px",
				fontSize: 12,
				fontWeight: applyMode === mode ? 600 : 400,
				color: applyMode === mode ? "var(--dsw-alias-label-primary)" : "var(--dsw-alias-label-tertiary)",
				background: applyMode === mode ? "color-mix(in srgb, var(--dsw-alias-state-info-primary, #4a90d9) 16%, transparent)" : "transparent",
				borderColor: applyMode === mode ? "var(--dsw-alias-state-info-primary, #4a90d9)" : "var(--dsw-alias-border-l2)"
			});
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				style: C.card,
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: C.cardTop,
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h3", {
							style: C.cardTitle,
							children: t("ri.applyTiming")
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							style: {
								display: "flex",
								gap: 6
							},
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								style: modeBtn("immediate"),
								onClick: () => void switchMode("immediate"),
								children: t("ri.applyImmediate")
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								style: modeBtn("next-session"),
								onClick: () => void switchMode("next-session"),
								children: t("ri.applyNextSession")
							})]
						})]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						style: {
							...C.cardDesc,
							whiteSpace: "pre-line"
						},
						children: t("ri.applyModeDesc")
					}),
					applyMode === "next-session" && hasPending && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
						type: "button",
						style: {
							...C.toggle(true),
							...busy ? C.toggleDisabled : {},
							alignSelf: "flex-start",
							marginTop: 4
						},
						disabled: busy,
						onClick: () => void applyPending(),
						children: busy ? t("ri.pending") : t("ri.applyPendingBtn")
					})
				]
			});
		}
		function McpPanel(props) {
			const { state, t, busy, onToggle, statusOf, applyMode, loadMcp } = props;
			const [expanded, setExpanded] = (0, react.useState)({});
			const [toolBusy, setToolBusy] = (0, react.useState)({});
			const [toolErr, setToolErr] = (0, react.useState)(null);
			const toolToggle = (0, react.useCallback)(async (row, tool) => {
				const key = `${row.entryId}:${tool.name}`;
				setToolBusy((prev) => ({
					...prev,
					[key]: true
				}));
				setToolErr(null);
				const token = await (await fetch("/api/mcp-skill-panel/token")).json().then((b) => b.token).catch(() => null);
				const headers = { "content-type": "application/json" };
				if (token) headers["x-panel-token"] = token;
				fetch("/api/mcp-skill-panel/mcp/toolToggle", {
					method: "POST",
					headers,
					body: JSON.stringify({
						serverName: row.serverName,
						toolName: tool.name,
						disabled: !tool.disabled
					})
				}).then((res) => res.json()).then((body) => {
					if (!body.ok) throw new Error(body.error ?? "tool toggle failed");
					loadMcp();
				}).catch((err) => {
					setToolErr(err instanceof Error ? err.message : String(err));
					loadMcp();
				}).finally(() => setToolBusy((prev) => ({
					...prev,
					[key]: false
				})));
			}, []);
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
				/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					style: C.stats,
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							style: C.stat,
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								style: C.statValue,
								children: state.mcpTotal
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								style: C.statLabel,
								children: t("ri.statMcpServers", { n: state.mcpTotal })
							})]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							style: C.stat,
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								style: C.statValue,
								children: state.mcpDisabled
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								style: C.statLabel,
								children: t("ri.statMcpDisabled", { n: state.mcpDisabled })
							})]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							style: C.stat,
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								style: C.statValue,
								children: state.mcpToolsTotal
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								style: C.statLabel,
								children: t("ri.statMcpTools", { n: state.mcpToolsTotal })
							})]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							style: C.stat,
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
								style: C.statValue,
								children: [
									"~",
									formatK(state.mcpTokensTotal),
									"k"
								]
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								style: C.statLabel,
								children: t("ri.statMcpTokens", { n: formatK(state.mcpTokensTotal) })
							})]
						})
					]
				}),
				toolErr && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
					style: C.error,
					children: toolErr
				}),
				state.mcp.length === 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
					style: C.empty,
					children: t("ri.empty")
				}),
				state.mcp.map((row) => {
					const st = statusOf(row);
					const isBusy = busy[`mcp:${row.rowId}`];
					const effDisabled = applyMode === "next-session" && row.pending ? row.desired ?? row.disabled : row.disabled;
					const isOpen = Boolean(expanded[row.entryId]);
					const toolList = row.toolList ?? [];
					return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: C.card,
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								style: C.cardTop,
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("h3", {
									style: C.cardTitle,
									children: [
										row.serverName,
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Badge, {
											color: st.color,
											bg: st.bg,
											children: st.label
										}),
										row.pending && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Badge, {
											color: "var(--dsw-alias-state-warn-primary)",
											bg: "var(--dsw-alias-state-warn-tertiary)",
											children: t("ri.pendingBadge")
										}),
										row.modelVisible ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Badge, {
											color: "var(--dsw-alias-state-info-primary, #4a90d9)",
											bg: "var(--dsw-alias-state-info-tertiary, rgba(74,144,217,0.15))",
											children: t("ri.modelVisible")
										}) : !row.disabled && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Badge, {
											color: "var(--dsw-alias-label-tertiary)",
											bg: "var(--dsw-alias-fill-l2)",
											children: t("ri.modelHidden")
										})
									]
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									style: {
										...C.toggle(effDisabled),
										...isBusy ? C.toggleDisabled : {}
									},
									disabled: isBusy,
									onClick: () => onToggle(row),
									children: isBusy ? t("ri.pending") : effDisabled ? t("ri.enable") : t("ri.disable")
								})]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								style: C.cardMeta,
								children: [
									t("ri.toolsCount", { n: row.tools }),
									" · ",
									t("ri.tokensCount", { n: formatK(row.tokens) }),
									row.transport ? ` · ${t("ri.transport")}: ${row.transport}` : "",
									row.workspace ? ` · ${t("ri.projectBadge")}: ${row.workspace}` : ""
								]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
								style: C.hint,
								children: row.pending ? t("ri.applyDeferredHint") : row.disabled ? t("ri.toggleOnHint") : t("ri.toggleOffHint")
							}),
							toolList.length > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								style: C.toolToggleBtn,
								onClick: () => setExpanded((prev) => ({
									...prev,
									[row.entryId]: !prev[row.entryId]
								})),
								children: isOpen ? `▾ ${t("ri.toolListHide")} (${toolList.length})` : `▸ ${t("ri.toolListShow")} (${toolList.length})`
							}), isOpen && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								style: C.toolList,
								children: toolList.map((tool) => {
									const tBusy = toolBusy[`${row.entryId}:${tool.name}`];
									return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
										style: C.toolRow,
										children: [
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
												type: "button",
												style: {
													...C.toolSwitch(tool.disabled),
													...tBusy ? C.toggleDisabled : {}
												},
												disabled: tBusy,
												onClick: () => void toolToggle(row, tool),
												children: tBusy ? t("ri.pending") : tool.disabled ? t("ri.enable") : t("ri.disable")
											}),
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
												style: C.toolName,
												children: tool.name.replace(/^mcp__[^_]+__/, "")
											}),
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
												style: C.toolDesc,
												children: tool.description || "—"
											})
										]
									}, tool.name);
								})
							})] })
						]
					}, row.entryId);
				})
			] });
		}
		function SkillPanel(props) {
			const { state, t, busy, onToggle } = props;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
				/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					style: C.stats,
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: C.stat,
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							style: C.statValue,
							children: state.skillsTotal
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							style: C.statLabel,
							children: t("ri.statSkills", { n: state.skillsTotal })
						})]
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: C.stat,
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							style: C.statValue,
							children: state.skillsModelVisible
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							style: C.statLabel,
							children: t("ri.statSkillsVisible", { n: state.skillsModelVisible })
						})]
					})]
				}),
				state.skills.length === 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
					style: C.empty,
					children: t("ri.empty")
				}),
				state.skills.map((row) => {
					const isBusy = busy[`skill:${row.name}`];
					const visible = row.modelInvocable;
					return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: C.card,
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								style: C.cardTop,
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("h3", {
									style: C.cardTitle,
									children: [row.name, /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Badge, {
										color: visible ? "var(--dsw-alias-state-success-primary)" : "var(--dsw-alias-label-tertiary)",
										bg: visible ? "var(--dsw-alias-state-success-tertiary)" : "var(--dsw-alias-fill-l2)",
										children: visible ? t("ri.modelVisible") : t("ri.modelHidden")
									})]
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									style: {
										...C.toggle(visible),
										...isBusy ? C.toggleDisabled : {}
									},
									disabled: isBusy,
									onClick: () => onToggle(row),
									children: isBusy ? t("ri.pending") : visible ? t("ri.disable") : t("ri.enable")
								})]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
								style: C.cardDesc,
								children: row.description
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								style: C.cardMeta,
								children: [t("ri.skillSource", { source: row.source }), row.userInvocable ? ` · ${t("ri.userVisible")}` : ""]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
								style: C.hint,
								children: visible ? t("ri.skillToggleOffHint") : t("ri.skillToggleOnHint")
							})
						]
					}, row.name);
				})
			] });
		}
		//#endregion
		//#region src/client/locales.ts
		/** 双语字典：zh/en 真双语（不互为别名），语言跟随 DSH 界面设置。 */
		const NS = "runtime-inventory";
		const en = {
			"ri.nav": "MCP & Skill Manager",
			"ri.mcpTab": "MCP Servers",
			"ri.skillTab": "Skills",
			"ri.refresh": "Refresh",
			"ri.loading": "Loading…",
			"ri.error": "Failed: {error}",
			"ri.empty": "No data yet.",
			"ri.session": "Session",
			"ri.preset": "Preset",
			"ri.cwd": "Workspace",
			"ri.statMcpServers": "{n} servers",
			"ri.statMcpDisabled": "{n} disabled",
			"ri.statMcpTools": "{n} tools",
			"ri.statMcpTokens": "~{n}k tokens",
			"ri.statSkills": "{n} skills",
			"ri.statSkillsVisible": "{n} model-visible",
			"ri.statusActive": "Active",
			"ri.statusDisabled": "Disabled",
			"ri.statusIdle": "No tools",
			"ri.statusFailed": "Failed",
			"ri.toolsCount": "{n} tools",
			"ri.tokensCount": "~{n}k tokens",
			"ri.transport": "transport",
			"ri.disable": "Disable",
			"ri.enable": "Enable",
			"ri.pending": "Working…",
			"ri.addMcp": "Add MCP",
			"ri.addMcpPasteHint": "Paste mcpServers JSON from another harness (e.g. Claude Code .mcp.json), then preview and confirm.",
			"ri.addMcpTarget": "Target",
			"ri.addMcpTargetGlobal": "Global",
			"ri.addMcpTargetProject": "Project",
			"ri.addMcpNoWorkspace": "No session workspace — cannot add project MCP.",
			"ri.addMcpPreview": "Preview",
			"ri.addMcpPreviewNames": "Parsed",
			"ri.addMcpConfirm": "Add",
			"ri.addMcpCancel": "Close",
			"ri.addMcpSuccess": "Added {n} {target} MCP(s).",
			"ri.addMcpSkipped": "Skipped {n} (existing/failed): {names}",
			"ri.addMcpError": "Failed: {error}",
			"ri.projectBadge": "Project",
			"ri.addSkill": "Create Skill",
			"ri.addSkillDropTitle": "Upload a SKILL.md to autofill",
			"ri.addSkillDropDesc": "Select or drag a single .md file here; its YAML frontmatter fills the name and description, the rest becomes the body.",
			"ri.addSkillName": "Skill name",
			"ri.addSkillNamePh": "A short, recognizable name (e.g. codemap)",
			"ri.addSkillNameInvalid": "Name must be kebab-case (lowercase letters, digits, hyphens).",
			"ri.addSkillDesc": "Description",
			"ri.addSkillDescPh": "When should this skill be used? e.g. When the user asks about project structure or file relationships",
			"ri.addSkillBody": "Instructions",
			"ri.addSkillBodyPh": "Define how the model behaves when this skill activates. e.g.\n# codemap\n## Commands\n## When to Use\n## Output Interpretation\n## Examples",
			"ri.addSkillConfirm": "Create",
			"ri.addSkillCancel": "Cancel",
			"ri.addSkillSuccess": "Skill created: {path}",
			"ri.addSkillError": "Failed: {error}",
			"ri.toolListShow": "Tools",
			"ri.toolListHide": "Tools",
			"ri.skillSource": "source: {source}",
			"ri.modelVisible": "Model",
			"ri.modelHidden": "Hidden",
			"ri.userVisible": "User",
			"ri.toggleOffHint": "Release context: tools disappear immediately.",
			"ri.toggleOnHint": "Restore tools without restart.",
			"ri.toggleError": "Toggle failed: {error}",
			"ri.skillToggleOffHint": "Remove this skill from the model catalog.",
			"ri.skillToggleOnHint": "Make this skill model-visible again.",
			"ri.cacheWarn": "Toggling mid-session invalidates this session's prompt cache: the next request is billed at miss rate (~5-12.5× hit). Prefer toggling at a session boundary.",
			"ri.cacheWarnDismiss": "Dismiss",
			"ri.applyTiming": "Apply timing",
			"ri.applyImmediate": "Immediate",
			"ri.applyNextSession": "Next session",
			"ri.applyModeDesc": "How manual toggles differ from on-demand middle-layer calls:\n· Immediate (default): a manual toggle changes the model-visible tools on the very next turn, invalidating this session's prefix cache from that turn onward — billed at miss rate (~5-12.5× hit). Use when you need to release/restore context right away.\n· Next session: a manual toggle only records intent; the current session keeps its toolset unchanged for all remaining turns (zero cache invalidation, zero extra cost) and applies at the next new session (before its first request) or after a DSH restart. Note: the current session will NOT release context just because you turned an MCP off (use \"Apply pending\" to force it).\n· Both modes: on-demand calls to disabled MCPs via the AI middle layer (mcp_search / mcp_call) always work — they temporarily enable and call outside the model request and never change your per-turn prefix, so they never cause a cache miss. Only manual toggles change the prefix.",
			"ri.applyPendingBtn": "Apply pending now",
			"ri.applyDeferredHint": "Intent recorded; it takes effect at the next new session or after a DSH restart.",
			"ri.pendingBadge": "Pending",
			"ri.appliedPending": "Applied {n} pending change(s).",
			"ri.autoManageTitle": "AI Middle Layer",
			"ri.autoManageOn": "On",
			"ri.autoManageOff": "Off",
			"ri.autoManageDescOn": "Disabled MCP servers stay hidden from the model and are used on demand via mcp_search / mcp_call (keep-alive enable + idle reaping). Servers you enabled stay directly visible (e.g. memory for recall, filesystem for IO); AI-temporarily-enabled servers never pollute context. Manually enabled servers are never auto-disabled.",
			"ri.autoManageDescOff": "Off: tools of enabled MCP servers are directly visible to the model (classic mode)."
		};
		const zh = {
			"ri.nav": "MCP 与技能管理面板",
			"ri.mcpTab": "MCP 服务器",
			"ri.skillTab": "技能",
			"ri.refresh": "刷新",
			"ri.loading": "加载中…",
			"ri.error": "加载失败：{error}",
			"ri.empty": "暂无数据",
			"ri.session": "会话",
			"ri.preset": "预设",
			"ri.cwd": "工作目录",
			"ri.statMcpServers": "{n} 个服务器",
			"ri.statMcpDisabled": "{n} 个已停用",
			"ri.statMcpTools": "{n} 个工具",
			"ri.statMcpTokens": "约 {n}k token",
			"ri.statSkills": "{n} 个技能",
			"ri.statSkillsVisible": "{n} 个模型可见",
			"ri.statusActive": "运行中",
			"ri.statusDisabled": "已停用",
			"ri.statusIdle": "无工具",
			"ri.statusFailed": "异常",
			"ri.toolsCount": "{n} 个工具",
			"ri.tokensCount": "约 {n}k token",
			"ri.transport": "传输",
			"ri.disable": "停用",
			"ri.enable": "启用",
			"ri.pending": "处理中…",
			"ri.addMcp": "添加 MCP",
			"ri.addMcpPasteHint": "粘贴其它 harness 的 mcpServers JSON（如 Claude Code 的 .mcp.json），转换预览后确认添加。",
			"ri.addMcpTarget": "目标",
			"ri.addMcpTargetGlobal": "全局",
			"ri.addMcpTargetProject": "项目",
			"ri.addMcpNoWorkspace": "无会话工作空间，无法添加项目 MCP。",
			"ri.addMcpPreview": "转换预览",
			"ri.addMcpPreviewNames": "解析到",
			"ri.addMcpConfirm": "确认添加",
			"ri.addMcpCancel": "关闭",
			"ri.addMcpSuccess": "已添加 {n} 个{target} MCP。",
			"ri.addMcpSkipped": "跳过 {n} 个（已存在/失败）：{names}",
			"ri.addMcpError": "操作失败：{error}",
			"ri.projectBadge": "项目",
			"ri.toolListShow": "工具",
			"ri.toolListHide": "工具",
			"ri.addSkill": "创建技能",
			"ri.addSkillDropTitle": "上传进行智能解析",
			"ri.addSkillDropDesc": "选择或拖入单个 .md 文件，YAML frontmatter 填充技能名称与描述，其余进入指令栏。",
			"ri.addSkillName": "技能名称",
			"ri.addSkillNamePh": "为该技能起一个简短、易识别的名称（例如 codemap）",
			"ri.addSkillNameInvalid": "名称需为 kebab-case（小写字母/数字/连字符）。",
			"ri.addSkillDesc": "描述",
			"ri.addSkillDescPh": "该技能应该在何时使用？例如：当用户询问项目结构或文件关系时",
			"ri.addSkillBody": "指令",
			"ri.addSkillBodyPh": "定义该技能激活时模型应如何行为。例如：\n# codemap\n## Commands\n## When to Use\n## Output Interpretation\n## Examples",
			"ri.addSkillConfirm": "确认",
			"ri.addSkillCancel": "取消",
			"ri.addSkillSuccess": "技能已创建：{path}",
			"ri.addSkillError": "操作失败：{error}",
			"ri.skillSource": "来源：{source}",
			"ri.modelVisible": "模型可见",
			"ri.modelHidden": "模型隐藏",
			"ri.userVisible": "用户可用",
			"ri.toggleOffHint": "释放上下文：工具立即从模型目录消失。",
			"ri.toggleOnHint": "无需重启即可恢复工具。",
			"ri.toggleError": "切换失败：{error}",
			"ri.skillToggleOffHint": "将该技能从模型目录移除。",
			"ri.skillToggleOnHint": "恢复该技能的模型可见性。",
			"ri.cacheWarn": "会话中途开关会使本会话的 Prompt Cache 失效，下次请求按 miss 费率计费（约为 hit 的 5~12.5 倍），建议在会话边界操作。",
			"ri.cacheWarnDismiss": "知道了",
			"ri.applyTiming": "生效时机",
			"ri.applyImmediate": "立即生效",
			"ri.applyNextSession": "下次会话生效",
			"ri.applyModeDesc": "用户手动启停开关 与 AI 中间层调用的区别：\n· 立即生效（默认）：手动开关会在下一轮对话立即改变模型看到的工具集，导致该轮起前缀缓存 100% 失效、按 miss 费率计费（约为 hit 的 5~12.5 倍）；适合需要马上释放/恢复上下文时。\n· 下次会话生效：手动开关只记录意图，当前会话全程工具集不变（零缓存失效、零额外费用），直到新开一个会话（其首次请求前）或重启 DSH 才生效；注意此时当前会话不会因为你关掉某 MCP 而立刻释放上下文（可用\"立即应用\"强制生效）。\n· 两者共同点：AI 中间层对已停用 MCP 的按需调用（mcp_search / mcp_call）始终可用——它在模型请求之外临时启用并调用，不改变每轮请求前缀，因此不会造成缓存 miss；只有\"手动开关\"才会改变前缀、从而可能造成 miss。",
			"ri.applyPendingBtn": "立即应用待生效变更",
			"ri.applyDeferredHint": "已记录意图，将在下次（新）会话或 DSH 重启后生效。",
			"ri.pendingBadge": "待生效",
			"ri.appliedPending": "已应用 {n} 项待生效变更。",
			"ri.autoManageTitle": "AI 中间层",
			"ri.autoManageOn": "已开启",
			"ri.autoManageOff": "已关闭",
			"ri.autoManageDescOn": "停用的 MCP 服务器对模型隐藏，需要时经 mcp_search / mcp_call 按需调用（保活启用 + 空闲回收）；你手动打开的服务器保持模型可见（如 memory 高灵敏召回、filesystem 直接读写）；AI 临时启用的服务器不会污染上下文。用户手动启用的服务器不会被自动停用。",
			"ri.autoManageDescOff": "关闭后：已启用 MCP 服务器的工具直接对模型可见（经典模式）。"
		};
		//#endregion
		//#region src/client/index.ts
		/**
		* Client 半区入口：注册 settings.section「MCP 与技能管理面板」页（MCP / 技能 双标签）。
		* 参考 ui-settings-plugins 的 settings.section 注册形态（id/order/label/locale 必带）。
		*
		* 平台类型（slots/locale）在本仓库无闭包类型可用，这里声明最小契约（P2-3 可维护性
		* 批次，替换此前的 any），与宿主实际签名对齐即可 —— 注册参数不匹配会在启动时报错。
		*/
		const inject = ["slots", "locale"];
		function apply(ctx) {
			const t = ctx.locale.bind(NS);
			ctx.effect(() => ctx.locale.register(NS, {
				zh,
				en
			}), "runtime-inventory: dictionaries");
			ctx.slots.inject("settings.section", () => ctx.slots.register({
				name: "settings.section",
				id: "runtime-inventory",
				order: 30,
				label: () => t("ri.nav"),
				locale: NS
			}, RuntimeInventorySection));
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
