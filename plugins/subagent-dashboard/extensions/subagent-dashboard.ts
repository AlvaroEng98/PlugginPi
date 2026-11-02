/**
 * Subagent Tool - Delegate tasks to specialized agents
 *
 * Spawns a separate `pi` process for each subagent invocation,
 * giving it an isolated context window.
 *
 * Supports three modes:
 *   - Single: { agent: "name", task: "..." }
 *   - Parallel: { tasks: [{ agent: "name", task: "..." }, ...] }
 *   - Chain: { chain: [{ agent: "name", task: "... {previous} ..." }, ...] }
 *
 * Uses RPC mode to stream output and control running subagents.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentMessage, AgentToolResult, ThinkingLevel } from "@earendil-works/pi-agent-core";
import { StringEnum, type Message, type ToolCall } from "@earendil-works/pi-ai";
import {
	CONFIG_DIR_NAME,
	type ExtensionAPI,
	type ExtensionContext,
	formatReadLineRange,
	getAgentDir,
	getMarkdownTheme,
	withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text, matchesKey, truncateToWidth, wrapTextWithAnsi, type Component, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { type AgentConfig, type AgentScope, discoverAgents } from "./agents.ts";
import { RpcSubagentProcess } from "./rpc-subagent.ts";

const MAX_PARALLEL_TASKS = 8;
const MAX_CONCURRENCY = 4;
const MAX_BACKGROUND_TASKS = 4;
const COLLAPSED_ITEM_COUNT = 10;
const PER_TASK_OUTPUT_CAP = 50 * 1024;
const DASHBOARD_OUTPUT_CAP = 12 * 1024;
const DASHBOARD_OUTPUT_LINES = 5;
const BACKGROUND_RESULT_TYPE = "subagent-dashboard-result";

function normalizeAgentScope(value: unknown): AgentScope {
	return value === "project" || value === "both" ? value : "user";
}

function normalizeExecutionMode(value: unknown): ExecutionMode {
	return value === "background" ? "background" : "task";
}

function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1000000).toFixed(1)}M`;
}

function compactText(value: string, maxLength = 120): string {
	const compact = value
		.replace(/\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001b\\))/g, "")
		.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	return compact.length > maxLength ? `${compact.slice(0, maxLength - 1)}…` : compact;
}

function compactTailText(value: string, maxLength: number): string {
	const compact = compactText(value, Number.MAX_SAFE_INTEGER);
	return compact.length > maxLength ? `…${compact.slice(-maxLength + 1)}` : compact;
}

function describeToolAction(toolName: string, args: Record<string, unknown>): string {
	const preview = (value: unknown, maxLength = 90) =>
		typeof value === "string" ? compactText(value, maxLength) : "";
	switch (toolName) {
		case "bash":
			return `$ ${preview(args.command) || "comando"}`;
		case "read":
			return `read ${preview(args.file_path ?? args.path) || "archivo"}`;
		case "write":
			return `write ${preview(args.file_path ?? args.path) || "archivo"}`;
		case "edit":
			return `edit ${preview(args.file_path ?? args.path) || "archivo"}`;
		case "grep":
			return `grep /${preview(args.pattern, 50)}/ ${preview(args.path, 40)}`.trim();
		case "find":
			return `find ${preview(args.pattern, 50)} ${preview(args.path, 40)}`.trim();
		default:
			return `${toolName} ${compactText(JSON.stringify(args), 80)}`.trim();
	}
}

function formatUsageStats(
	usage: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		cost: number;
		contextTokens?: number;
		turns?: number;
	},
	model?: string,
): string {
	const parts: string[] = [];
	if (usage.turns) parts.push(`${usage.turns} turn${usage.turns > 1 ? "s" : ""}`);
	if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
	if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
	if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
	if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
	if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
	if (usage.contextTokens && usage.contextTokens > 0) {
		parts.push(`ctx:${formatTokens(usage.contextTokens)}`);
	}
	if (model) parts.push(model);
	return parts.join(" ");
}

function formatToolCall(
	toolName: string,
	args: Record<string, unknown>,
	themeFg: (color: any, text: string) => string,
): string {
	const shortenPath = (p: string) => {
		const home = os.homedir();
		return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
	};

	switch (toolName) {
		case "bash": {
			const command = (args.command as string) || "...";
			const preview = command.length > 60 ? `${command.slice(0, 60)}...` : command;
			return themeFg("muted", "$ ") + themeFg("toolOutput", preview);
		}
		case "read": {
			const rawPath = (args.file_path || args.path || "...") as string;
			const filePath = shortenPath(rawPath);
			const lineRange = formatReadLineRange(args.offset, args.limit);
			let text = themeFg("accent", filePath);
			if (lineRange) {
				text += themeFg("warning", lineRange);
			}
			return themeFg("muted", "read ") + text;
		}
		case "write": {
			const rawPath = (args.file_path || args.path || "...") as string;
			const filePath = shortenPath(rawPath);
			const content = (args.content || "") as string;
			const lines = content.split("\n").length;
			let text = themeFg("muted", "write ") + themeFg("accent", filePath);
			if (lines > 1) text += themeFg("dim", ` (${lines} lines)`);
			return text;
		}
		case "edit": {
			const rawPath = (args.file_path || args.path || "...") as string;
			return themeFg("muted", "edit ") + themeFg("accent", shortenPath(rawPath));
		}
		case "ls": {
			const rawPath = (args.path || ".") as string;
			return themeFg("muted", "ls ") + themeFg("accent", shortenPath(rawPath));
		}
		case "find": {
			const pattern = (args.pattern || "*") as string;
			const rawPath = (args.path || ".") as string;
			return themeFg("muted", "find ") + themeFg("accent", pattern) + themeFg("dim", ` in ${shortenPath(rawPath)}`);
		}
		case "grep": {
			const pattern = (args.pattern || "") as string;
			const rawPath = (args.path || ".") as string;
			return (
				themeFg("muted", "grep ") +
				themeFg("accent", `/${pattern}/`) +
				themeFg("dim", ` in ${shortenPath(rawPath)}`)
			);
		}
		default: {
			const argsStr = JSON.stringify(args);
			const preview = argsStr.length > 50 ? `${argsStr.slice(0, 50)}...` : argsStr;
			return themeFg("accent", toolName) + themeFg("dim", ` ${preview}`);
		}
	}
}

interface UsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
}

interface SingleResult {
	agent: string;
	agentSource: "bundled" | "user" | "project" | "unknown";
	task: string;
	exitCode: number;
	messages: AgentMessage[];
	stderr: string;
	usage: UsageStats;
	model?: string;
	stopReason?: string;
	errorMessage?: string;
	step?: number;
}

type ExecutionMode = "task" | "background";

interface BackgroundTaskOwner {
	sessionId: string | undefined;
	agent: string;
	controller: AbortController;
}

interface SubagentDetails {
	mode: "single" | "parallel" | "chain";
	executionMode?: ExecutionMode;
	taskId?: string;
	agentScope: AgentScope;
	projectAgentsDir: string | null;
	results: SingleResult[];
}

function getFinalOutput(messages: AgentMessage[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") return part.text;
			}
		}
	}
	return "";
}

function isFailedResult(result: SingleResult): boolean {
	return result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted";
}

function getResultOutput(result: SingleResult): string {
	if (isFailedResult(result)) {
		return result.errorMessage || result.stderr || getFinalOutput(result.messages) || "(no output)";
	}
	return getFinalOutput(result.messages) || "(no output)";
}

function truncateParallelOutput(output: string): string {
	const byteLength = Buffer.byteLength(output, "utf8");
	if (byteLength <= PER_TASK_OUTPUT_CAP) return output;

	let truncated = output.slice(0, PER_TASK_OUTPUT_CAP);
	while (Buffer.byteLength(truncated, "utf8") > PER_TASK_OUTPUT_CAP) {
		truncated = truncated.slice(0, -1);
	}
	return `${truncated}\n\n[Output truncated: ${byteLength - Buffer.byteLength(truncated, "utf8")} bytes omitted. Full output preserved in tool details.]`;
}

function truncateBackgroundOutput(output: string): string {
	const byteLength = Buffer.byteLength(output, "utf8");
	if (byteLength <= PER_TASK_OUTPUT_CAP) return output;

	let truncated = output.slice(0, PER_TASK_OUTPUT_CAP);
	while (Buffer.byteLength(truncated, "utf8") > PER_TASK_OUTPUT_CAP) truncated = truncated.slice(0, -1);
	return `${truncated}\n\n[Resultado truncado: ${byteLength - Buffer.byteLength(truncated, "utf8")} bytes omitidos.]`;
}

type DisplayItem = { type: "text"; text: string } | { type: "toolCall"; name: string; args: Record<string, any> };

function getDisplayItems(messages: AgentMessage[]): DisplayItem[] {
	const items: DisplayItem[] = [];
	for (const msg of messages) {
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") items.push({ type: "text", text: part.text });
				else if (part.type === "toolCall") items.push({ type: "toolCall", name: part.name, args: part.arguments });
			}
		}
	}
	return items;
}

async function mapWithConcurrencyLimit<TIn, TOut>(
	items: TIn[],
	concurrency: number,
	fn: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> {
	if (items.length === 0) return [];
	const limit = Math.max(1, Math.min(concurrency, items.length));
	const results: TOut[] = new Array(items.length);
	let nextIndex = 0;
	const workers = new Array(limit).fill(null).map(async () => {
		while (true) {
			const current = nextIndex++;
			if (current >= items.length) return;
			results[current] = await fn(items[current], current);
		}
	});
	await Promise.all(workers);
	return results;
}

async function writePromptToTempFile(agentName: string, prompt: string): Promise<{ dir: string; filePath: string }> {
	const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-"));
	const safeName = agentName.replace(/[^\w.-]+/g, "_");
	const filePath = path.join(tmpDir, `prompt-${safeName}.md`);
	await withFileMutationQueue(filePath, async () => {
		await fs.promises.writeFile(filePath, prompt, { encoding: "utf-8", mode: 0o600 });
	});
	return { dir: tmpDir, filePath };
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}

	const execName = path.basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) {
		return { command: process.execPath, args };
	}

	return { command: "pi", args };
}

type OnUpdateCallback = (partial: AgentToolResult<SubagentDetails>) => void;

interface DispatchDefaults {
	model?: string;
	thinkingLevel?: ThinkingLevel;
}

interface DashboardThreadItem {
	id: string;
	kind: "assistant" | "operator" | "tool";
	text: string;
	toolCallId?: string;
	status?: "queued" | "running" | "completed" | "failed";
	output?: string;
}

interface DashboardAgent {
	id: string;
	name: string;
	source: AgentConfig["source"] | "unknown";
	task: string;
	model: string;
	effort: string;
	contextTokens: number;
	contextWindow?: number;
	status: "starting" | "working" | "idle" | "completed" | "failed" | "aborted" | "stopped";
	activity: string;
	output: string;
	thread: DashboardThreadItem[];
	startedAt: number;
}

interface DashboardAgentControls {
	cancel(): void;
	terminate(): Promise<void>;
	send(message: string): Promise<void>;
}

interface DashboardHooks {
	report(agent: DashboardAgent): void;
	setControls(id: string, controls: DashboardAgentControls | undefined): void;
	resolveModel(model?: string): { label: string; contextWindow?: number };
}

let nextDashboardAgentId = 0;

async function runSingleAgent(
	defaultCwd: string,
	dispatchDefaults: DispatchDefaults,
	agents: AgentConfig[],
	agentName: string,
	task: string,
	cwd: string | undefined,
	step: number | undefined,
	signal: AbortSignal | undefined,
	onUpdate: OnUpdateCallback | undefined,
	makeDetails: (results: SingleResult[]) => SubagentDetails,
	dashboard?: DashboardHooks,
	onStarted?: (id: string) => void,
): Promise<SingleResult> {
	const agent = agents.find((a) => a.name === agentName);
	const agentThinkingSuffix = agent?.model?.match(/:(off|minimal|low|medium|high|xhigh|max)$/)?.[1] as ThinkingLevel | undefined;
	const inheritsDispatchConfig = !agent?.model;
	const model = agent?.model
		? agentThinkingSuffix
			? agent.model.slice(0, -(agentThinkingSuffix.length + 1))
			: agent.model
		: dispatchDefaults.model;
	const thinkingLevel = agentThinkingSuffix ?? (inheritsDispatchConfig ? dispatchDefaults.thinkingLevel : undefined);
	const modelInfo = dashboard?.resolveModel(model);
	const dashboardAgent: DashboardAgent | undefined = dashboard
		? {
				id: `subagent-${Date.now().toString(36)}-${(++nextDashboardAgentId).toString(36)}`,
				name: agentName,
				source: agent?.source ?? "unknown",
				task,
				model: modelInfo?.label ?? model ?? "modelo predeterminado",
				effort: thinkingLevel ?? (inheritsDispatchConfig ? "off" : "predeterminado"),
				contextTokens: 0,
				contextWindow: modelInfo?.contextWindow,
				status: "starting",
				activity: "Iniciando proceso",
				output: "",
				thread: [],
				startedAt: Date.now(),
			}
		: undefined;
	const reportDashboard = () => {
		if (dashboardAgent) dashboard?.report({ ...dashboardAgent });
	};

	if (!agent) {
		const available = agents.map((a) => `"${a.name}"`).join(", ") || "none";
		if (dashboardAgent) {
			dashboardAgent.status = "failed";
			dashboardAgent.activity = "Agente no encontrado";
			reportDashboard();
			onStarted?.(dashboardAgent.id);
		}
		return {
			agent: agentName,
			agentSource: "unknown",
			task,
			exitCode: 1,
			messages: [],
			stderr: `Unknown agent: "${agentName}". Available agents: ${available}.`,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
			step,
		};
	}

	const args: string[] = ["--mode", "rpc", "--no-session"];
	if (model) args.push("--model", model);
	if (thinkingLevel) args.push("--thinking", thinkingLevel);
	if (agent.tools && agent.tools.length > 0) args.push("--tools", agent.tools.join(","));

	let tmpPromptDir: string | null = null;
	let tmpPromptPath: string | null = null;
	let rpc: RpcSubagentProcess | undefined;
	let wasAborted = false;
	let promptAccepted = false;
	let childExitCode: number | null = null;
	let abortTimer: ReturnType<typeof setTimeout> | undefined;
	let resolveSettled!: () => void;
	let hasSettled = false;
	const settled = new Promise<void>((resolve) => {
		resolveSettled = resolve;
	});

	const currentResult: SingleResult = {
		agent: agentName,
		agentSource: agent.source,
		task,
		exitCode: 0,
		messages: [],
		stderr: "",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
		model,
		step,
	};

	const finishRun = () => {
		if (hasSettled) return;
		hasSettled = true;
		resolveSettled();
	};
	let nextThreadItemId = 0;
	let streamingThreadItemId: string | undefined;
	const appendThreadItem = (item: Omit<DashboardThreadItem, "id">) => {
		if (!dashboardAgent) return undefined;
		const entry: DashboardThreadItem = { ...item, id: `thread-${++nextThreadItemId}` };
		dashboardAgent.thread.push(entry);
		if (dashboardAgent.thread.length > 200) dashboardAgent.thread.splice(0, dashboardAgent.thread.length - 200);
		reportDashboard();
		return entry;
	};
	const findToolThreadItem = (toolCallId: string | undefined) =>
		toolCallId ? dashboardAgent?.thread.find((item) => item.toolCallId === toolCallId) : undefined;
	const appendOutput = (text: string) => {
		if (!dashboardAgent || !text) return;
		let output = dashboardAgent.output + text;
		if (Buffer.byteLength(output, "utf8") > DASHBOARD_OUTPUT_CAP) {
			output = output.slice(-DASHBOARD_OUTPUT_CAP);
			while (Buffer.byteLength(output, "utf8") > DASHBOARD_OUTPUT_CAP) output = output.slice(1);
		}
		dashboardAgent.output = output;
		reportDashboard();
	};
	const appendAssistantDelta = (delta: string) => {
		if (!dashboardAgent || !delta) return;
		let item = streamingThreadItemId
			? dashboardAgent.thread.find((candidate) => candidate.id === streamingThreadItemId)
			: undefined;
		if (!item) {
			item = appendThreadItem({ kind: "assistant", text: "" });
			streamingThreadItemId = item?.id;
		}
		if (!item) return;
		item.text += delta;
		if (item.text.length > 8000) item.text = `…${item.text.slice(-7999)}`;
		reportDashboard();
	};
	const captureAssistantMessage = (message: Extract<AgentMessage, { role: "assistant" }>) => {
		if (!dashboardAgent) return;
		const text = message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
		if (text) {
			const streamed = streamingThreadItemId
				? dashboardAgent.thread.find((item) => item.id === streamingThreadItemId)
				: undefined;
			if (streamed) {
				streamed.text = text.slice(-8000);
				streamed.status = "completed";
			} else {
				appendThreadItem({ kind: "assistant", text: text.slice(-8000), status: "completed" });
			}
		}
		for (const part of message.content) {
			if (part.type !== "toolCall") continue;
			const existing = findToolThreadItem(part.id);
			if (existing) continue;
			appendThreadItem({
				kind: "tool",
				text: describeToolAction(part.name, part.arguments),
				toolCallId: part.id,
				status: "queued",
			});
		}
		streamingThreadItemId = undefined;
		reportDashboard();
	};
	const emitUpdate = () => {
		if (dashboardAgent) {
			dashboardAgent.status = "working";
			dashboardAgent.contextTokens = currentResult.usage.contextTokens;
			const lastMessage = currentResult.messages[currentResult.messages.length - 1];
			if (lastMessage?.role === "toolResult") {
				dashboardAgent.activity = "Revisando resultado de herramienta";
			} else {
				const lastAssistant = [...currentResult.messages].reverse().find((message) => message.role === "assistant");
				let lastToolCall: Extract<Message["content"][number], { type: "toolCall" }> | undefined;
				for (let i = (lastAssistant?.content.length ?? 0) - 1; i >= 0; i--) {
					const part = lastAssistant?.content[i];
					if (part?.type === "toolCall") {
						lastToolCall = part;
						break;
					}
				}
				dashboardAgent.activity = lastToolCall
					? describeToolAction(lastToolCall.name, lastToolCall.arguments)
					: "Generando respuesta";
			}
			reportDashboard();
		}
		if (onUpdate) {
			onUpdate({
				content: [{ type: "text", text: getFinalOutput(currentResult.messages) || "(running...)" }],
				details: makeDetails([currentResult]),
			});
		}
	};
	let abortRequestSent = false;
	const sendAbortRequest = () => {
		if (!rpc || !promptAccepted || abortRequestSent || hasSettled) return;
		abortRequestSent = true;
		void rpc.request({ type: "abort" }).catch(() => undefined);
		if (abortTimer) clearTimeout(abortTimer);
		abortTimer = setTimeout(() => rpc?.kill("SIGKILL"), 5000);
	};
	const requestCancel = () => {
		if (wasAborted || hasSettled || !rpc) return;
		wasAborted = true;
		if (dashboardAgent) {
			dashboardAgent.activity = "Cancelando…";
			reportDashboard();
		}
		if (promptAccepted) sendAbortRequest();
		else abortTimer = setTimeout(() => rpc?.kill("SIGKILL"), 5000);
	};
	const terminate = async () => {
		if (!rpc) return;
		requestCancel();
		await rpc.stop();
	};
	const sendMessage = async (message: string) => {
		if (!rpc || !promptAccepted || wasAborted || hasSettled) throw new Error("El subagente ya no está disponible");
		const response = await rpc.request({ type: "steer", message });
		if (!response.success) throw new Error(response.error || "No se pudo enviar el mensaje al subagente");
		if (response.data?.disposition === "handled") {
			throw new Error("Una extensión interceptó el mensaje; no llegó al subagente");
		}
		appendOutput(`\n> ${message}\n`);
		appendThreadItem({ kind: "operator", text: message });
		if (dashboardAgent) {
			dashboardAgent.activity = `Mensaje enviado: ${compactText(message, 70)}`;
			reportDashboard();
		}
	};

	reportDashboard();
	if (dashboardAgent) onStarted?.(dashboardAgent.id);
	try {
		if (signal?.aborted) throw new Error("Subagent was aborted");
		if (agent.systemPrompt.trim()) {
			const tmp = await writePromptToTempFile(agent.name, agent.systemPrompt);
			tmpPromptDir = tmp.dir;
			tmpPromptPath = tmp.filePath;
			args.push("--append-system-prompt", tmpPromptPath);
		}
		if (signal?.aborted) throw new Error("Subagent was aborted");

		const invocation = getPiInvocation(args);
		rpc = new RpcSubagentProcess(
			invocation.command,
			invocation.args,
			cwd ?? defaultCwd,
			(record) => {
				if (record.type === "extension_ui_request" && typeof record.id === "string") {
					// A headless child cannot display extension dialogs; fail closed instead of hanging.
					try {
						rpc?.send({ type: "extension_ui_response", id: record.id, cancelled: true });
					} catch {
						// The child may close between emitting the request and this response.
					}
					return;
				}

				if (record.type === "message_update") {
					const update = record.assistantMessageEvent;
					if (update?.type === "text_delta" && typeof update.delta === "string") {
						appendOutput(update.delta);
						appendAssistantDelta(update.delta);
					}
				}

				if (record.type === "tool_execution_start" && dashboardAgent) {
					dashboardAgent.status = "working";
					dashboardAgent.activity = describeToolAction(record.toolName, record.args ?? {});
					const toolItem = findToolThreadItem(record.toolCallId);
					if (toolItem) {
						toolItem.text = dashboardAgent.activity;
						toolItem.status = "running";
					} else {
						appendThreadItem({
							kind: "tool",
							text: dashboardAgent.activity,
							toolCallId: record.toolCallId,
							status: "running",
						});
					}
					appendOutput(`\n› ${dashboardAgent.activity}\n`);
					reportDashboard();
				}

				if (record.type === "tool_execution_end" && dashboardAgent) {
					const output = (record.result?.content ?? [])
						.filter((part: any) => part.type === "text")
						.map((part: any) => part.text)
						.join("\n");
					const toolItem = findToolThreadItem(record.toolCallId);
					if (toolItem) {
						toolItem.status = record.isError || record.result?.isError ? "failed" : "completed";
						if (output) toolItem.output = compactText(output, 1200);
						reportDashboard();
					}
					if (output) appendOutput(`${compactText(output, 1200)}\n`);
				}

				if (record.type === "message_end" && record.message) {
					const msg = record.message as AgentMessage;
					currentResult.messages.push(msg);
					if (msg.role === "assistant") {
						captureAssistantMessage(msg);
						currentResult.usage.turns++;
						const usage = msg.usage;
						if (usage) {
							currentResult.usage.input += usage.input || 0;
							currentResult.usage.output += usage.output || 0;
							currentResult.usage.cacheRead += usage.cacheRead || 0;
							currentResult.usage.cacheWrite += usage.cacheWrite || 0;
							currentResult.usage.cost += usage.cost?.total || 0;
							currentResult.usage.contextTokens = usage.totalTokens || 0;
						}
						if (!currentResult.model && msg.model) currentResult.model = msg.model;
						if (msg.stopReason) currentResult.stopReason = msg.stopReason;
						if (msg.errorMessage) currentResult.errorMessage = msg.errorMessage;
					}
					if (msg.role === "toolResult") {
						const toolItem = findToolThreadItem(msg.toolCallId);
						const output = msg.content
							.filter((part) => part.type === "text")
							.map((part) => part.text)
							.join("\n");
						if (toolItem) {
							toolItem.status = msg.isError ? "failed" : "completed";
							if (output) toolItem.output = compactText(output, 1200);
							reportDashboard();
						}
					}
					emitUpdate();
				}

				if (record.type === "tool_execution_end" || record.type === "tool_execution_update") emitUpdate();
				if (record.type === "agent_settled") {
					wasAborted = Boolean(record.aborted);
					if (wasAborted) currentResult.stopReason = "aborted";
					finishRun();
				}
			},
			(code) => {
				childExitCode = code ?? 1;
				if (!hasSettled) {
					currentResult.exitCode = childExitCode;
					currentResult.stopReason = "error";
					currentResult.stderr = `Subagent process exited before settling (${code ?? "unknown"})`;
				}
				finishRun();
			}
		);

		if (dashboardAgent) dashboard?.setControls(dashboardAgent.id, { cancel: requestCancel, terminate, send: sendMessage });
		if (signal) signal.addEventListener("abort", requestCancel, { once: true });
		if (signal?.aborted) requestCancel();
		if (wasAborted) throw new Error("Subagent was aborted");

		const promptResponse = await rpc.request({ type: "prompt", message: task });
		if (!promptResponse.success) throw new Error(promptResponse.error || "No se pudo iniciar el subagente");
		promptAccepted = true;
		if (promptResponse.data?.disposition === "handled") {
			currentResult.stopReason = "end";
			finishRun();
		}
		if (wasAborted) sendAbortRequest();
		if (dashboardAgent && !hasSettled) {
			dashboardAgent.status = "working";
			dashboardAgent.activity = "Generando respuesta";
			dashboard?.setControls(dashboardAgent.id, { cancel: requestCancel, terminate, send: sendMessage });
			reportDashboard();
		}
		await settled;

		currentResult.exitCode = childExitCode ?? 0;
		if (wasAborted) currentResult.stopReason = "aborted";
		if (dashboardAgent) {
			dashboardAgent.contextTokens = currentResult.usage.contextTokens;
			dashboardAgent.status = wasAborted
				? "aborted"
				: currentResult.exitCode === 0 && currentResult.stopReason !== "error"
					? "completed"
					: "failed";
			dashboardAgent.activity =
				dashboardAgent.status === "completed"
					? "Completado"
					: dashboardAgent.status === "aborted"
						? "Cancelado"
						: currentResult.errorMessage || currentResult.stderr || "Error al ejecutar";
			dashboard?.setControls(dashboardAgent.id, undefined);
			reportDashboard();
		}
		if (wasAborted) throw new Error("Subagent was aborted");
		return currentResult;
	} catch (error) {
		if (dashboardAgent && (dashboardAgent.status === "starting" || dashboardAgent.status === "working")) {
			dashboardAgent.status = wasAborted || signal?.aborted ? "aborted" : "failed";
			dashboardAgent.activity = dashboardAgent.status === "aborted" ? "Cancelado" : compactText(String(error), 100);
			dashboard?.setControls(dashboardAgent.id, undefined);
			reportDashboard();
		}
		throw error;
	} finally {
		if (signal) signal.removeEventListener("abort", requestCancel);
		if (abortTimer) clearTimeout(abortTimer);
		if (dashboardAgent) dashboard?.setControls(dashboardAgent.id, undefined);
		await rpc?.stop();
		if (tmpPromptPath)
			try {
				fs.unlinkSync(tmpPromptPath);
			} catch {
				/* ignore */
			}
		if (tmpPromptDir)
			try {
				fs.rmdirSync(tmpPromptDir);
			} catch {
				/* ignore */
			}
	}
}

const TaskItem = Type.Object({
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: Type.String({ description: "Task to delegate to the agent" }),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
});

const ChainItem = Type.Object({
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: Type.String({ description: "Task with optional {previous} placeholder for prior output" }),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
});

const AgentScopeSchema = StringEnum(["user", "project", "both"] as const, {
	description: 'Which agent directories to use. Default: "user". Use "both" to include project-local agents.',
	default: "user",
});

const ExecutionModeSchema = StringEnum(["task", "background"] as const, {
	description: 'Single-agent mode: "task" waits for the result; "background" returns a task ID and delivers the result when finished.',
	default: "task",
});

const SubagentParams = Type.Object({
	agent: Type.Optional(Type.String({ description: "Name of the agent to invoke (for single mode)" })),
	task: Type.Optional(Type.String({ description: "Task to delegate (for single mode)" })),
	mode: Type.Optional(ExecutionModeSchema),
	tasks: Type.Optional(Type.Array(TaskItem, { description: "Array of {agent, task} for parallel execution" })),
	chain: Type.Optional(Type.Array(ChainItem, { description: "Array of {agent, task} for sequential execution" })),
	agentScope: Type.Optional(AgentScopeSchema),
	confirmProjectAgents: Type.Optional(
		Type.Boolean({ description: "Prompt before running project-local agents. Default: true.", default: true }),
	),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process (single mode)" })),
});

export default function (pi: ExtensionAPI) {
	pi.registerMessageRenderer(BACKGROUND_RESULT_TYPE, (message, _options, theme) => {
		const status = (message.details as { status?: unknown } | undefined)?.status;
		const color = status === "failed" ? "error" : status === "cancelled" ? "warning" : "success";
		const content = typeof message.content === "string"
			? message.content
			: message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
		return new Text(theme.fg(color, content), 0, 0);
	});

	const dashboardAgents: DashboardAgent[] = [];
	const dashboardControls = new Map<string, DashboardAgentControls>();
	const backgroundTasks = new Map<string, BackgroundTaskOwner>();
	const abandonBackgroundTasks = () => {
		for (const task of backgroundTasks.values()) task.controller.abort();
		backgroundTasks.clear();
	};
	const dashboardActions = new Map<number, { type: "select" | "message" | "cancel"; id: string }>();
	let dashboardRequestRender: (() => void) | undefined;
	let dashboardViewRequestRender: (() => void) | undefined;
	let dashboardContext: ExtensionContext | undefined;
	let dashboardWidgetMounted = false;
	let selectedAgentId: string | undefined;
	let selectedViewAgentId: string | undefined;

	const activeDashboardAgents = () =>
		dashboardAgents.filter((agent) => agent.status === "starting" || agent.status === "working");
	const refreshDashboard = () => dashboardRequestRender?.();
	const deliverBackgroundResult = (id: string, result?: SingleResult, error?: unknown) => {
		const owner = backgroundTasks.get(id);
		if (!owner) return;
		backgroundTasks.delete(id);

		const ctx = dashboardContext;
		if (!ctx || ctx.sessionManager.getSessionId() !== owner.sessionId) return;
		const dashboardAgent = dashboardAgents.find((agent) => agent.id === id);
		const status = result
			? result.stopReason === "aborted"
				? "cancelled"
				: isFailedResult(result)
					? "failed"
					: "completed"
			: dashboardAgent?.status === "aborted"
				? "cancelled"
				: "failed";
		const output = truncateBackgroundOutput(result ? getResultOutput(result) : String(error ?? "Unknown subagent error"));
		const outcome = status === "completed" ? "terminó" : status === "cancelled" ? "fue cancelado" : "falló";
		const content = `Subagente ${owner.agent} (tarea ${id}) ${outcome}.\n\n${output}`;

		try {
			pi.sendMessage(
				{
					customType: BACKGROUND_RESULT_TYPE,
					content,
					display: true,
					details: { taskId: id, agent: owner.agent, status },
				},
				{ deliverAs: "steer", triggerTurn: true },
			);
		} catch (sendError) {
			if (ctx.hasUI) ctx.ui.notify(`No se pudo entregar el resultado del subagente ${id}: ${String(sendError)}`, "warning");
		}
	};
	const showAgentMessageInput = (id: string) => {
		const agent = activeDashboardAgents().find((item) => item.id === id);
		const controls = dashboardControls.get(id);
		const ctx = dashboardContext;
		if (!agent || !controls || !ctx?.hasUI) return;
		if (agent.status === "starting") {
			ctx.ui.notify(`Espera a que ${agent.name} termine de iniciar`, "info");
			return;
		}
		void (async () => {
			const message = await ctx.ui.input(`Mensaje para ${agent.name}`, "Escribe una instrucción para el subagente");
			if (!message?.trim()) return;
			try {
				await controls.send(message.trim());
			} catch (error) {
				ctx.ui.notify(String(error), "error");
			}
		})();
	};
	const cancelDashboardAgent = (id: string) => {
		const agent = activeDashboardAgents().find((item) => item.id === id);
		const controls = dashboardControls.get(id);
		if (!agent) return;
		if (controls) controls.cancel();
		else backgroundTasks.get(id)?.controller.abort();
		dashboardContext?.ui.notify(`Cancelando ${agent.name}…`, "info");
	};
	const installDashboardWidget = () => {
		const ctx = dashboardContext;
		if (!ctx || ctx.mode !== "tui") return;
		if (activeDashboardAgents().length === 0) {
			if (dashboardWidgetMounted) ctx.ui.setWidget("subagent-dashboard", undefined);
			dashboardWidgetMounted = false;
			dashboardRequestRender = undefined;
			selectedAgentId = undefined;
			return;
		}
		if (dashboardWidgetMounted) {
			refreshDashboard();
			return;
		}
		ctx.ui.setWidget("subagent-dashboard", (tui) => {
			const requestRender = () => tui.requestRender();
			dashboardRequestRender = requestRender;
			dashboardWidgetMounted = true;
			const component: Component & { dispose(): void } = {
				render: (width) => renderDashboard(ctx.ui.theme, width),
				invalidate() {},
				handleMouse(event: TuiMouseEvent) {
					if (event.type !== "click" || event.button !== "left") return undefined;
					const action = dashboardActions.get(event.y);
					if (!action) return undefined;
					if (action.type === "select") {
						selectedAgentId = action.id;
						refreshDashboard();
					} else if (action.type === "message") {
						showAgentMessageInput(action.id);
					} else {
						cancelDashboardAgent(action.id);
					}
					return { handled: true };
				},
				dispose() {
					if (dashboardRequestRender === requestRender) dashboardRequestRender = undefined;
					dashboardWidgetMounted = false;
				},
			};
			return component;
		});
	};
	const reportDashboardAgent = (agent: DashboardAgent) => {
		const existing = dashboardAgents.findIndex((item) => item.id === agent.id);
		if (existing >= 0) dashboardAgents[existing] = agent;
		else dashboardAgents.push(agent);

		const completed = dashboardAgents
			.filter((item) => item.status === "completed" || item.status === "failed" || item.status === "aborted")
			.sort((left, right) => right.startedAt - left.startedAt);
		const keepCompleted = new Set(completed.slice(0, 3).map((item) => item.id));
		for (let i = dashboardAgents.length - 1; i >= 0; i--) {
			const item = dashboardAgents[i];
			if (item.status !== "starting" && item.status !== "working" && !keepCompleted.has(item.id)) {
				dashboardAgents.splice(i, 1);
			}
		}
		installDashboardWidget();
		dashboardViewRequestRender?.();
	};

	const renderDashboard = (theme: ExtensionContext["ui"]["theme"], width: number) => {
		const active = activeDashboardAgents();
		const firstActive = active[0];
		if (!firstActive) return [];
		if (!selectedAgentId || !active.some((agent) => agent.id === selectedAgentId)) selectedAgentId = firstActive.id;
		const selected = active.find((agent) => agent.id === selectedAgentId);
		if (!selected) return [];
		dashboardActions.clear();
		const lines: string[] = [
			`${theme.fg("accent", theme.bold("SUBAGENTES"))} ${theme.fg("warning", `${active.length} activos`)} ${theme.fg("dim", "· clic para seleccionar")}`,
		];
		active.forEach((agent, index) => {
			const line = lines.length;
			const chosen = agent.id === selected.id;
			const status = agent.status === "starting" ? "◌" : "⏳";
			const prefix = chosen ? "▶" : " ";
			lines.push(
				`${theme.fg(chosen ? "accent" : "warning", prefix)} ${theme.fg("toolTitle", theme.bold(agent.name))} ${theme.fg("muted", "·")} ${theme.fg("muted", compactText(agent.activity, 75))} ${theme.fg("warning", status)}`,
			);
			dashboardActions.set(line, { type: "select", id: agent.id });
		});

		lines.push(`${theme.fg("dim", `Tarea: ${compactText(selected.task, 160)}`)}`);
		lines.push(`${theme.fg("muted", `Actividad: ${compactText(selected.activity, 120)} · ${selected.model} · esfuerzo ${selected.effort}`)}`);
		lines.push(theme.fg("muted", "Salida en vivo:"));
		const outputLines = selected.output.split(/\r?\n/).map((line) => line.trimEnd()).filter(Boolean).slice(-DASHBOARD_OUTPUT_LINES);
		if (outputLines.length === 0) lines.push(theme.fg("dim", "  Esperando salida del subagente…"));
		else for (const line of outputLines) lines.push(theme.fg("toolOutput", `  ${compactTailText(line, Math.max(24, width - 4))}`));

		if (dashboardControls.has(selected.id)) {
			if (selected.status !== "starting") {
				const messageLine = lines.length;
				lines.push(theme.fg("accent", "  ✉ Enviar mensaje (clic o /subagent-message)"));
				dashboardActions.set(messageLine, { type: "message", id: selected.id });
			}
			const cancelLine = lines.length;
			lines.push(theme.fg("error", "  ✕ Cancelar subagente (clic o /subagent-cancel)"));
			dashboardActions.set(cancelLine, { type: "cancel", id: selected.id });
		}
		return lines.map((line) => truncateToWidth(line, width, theme.fg("dim", "…")));
	};

	const getDashboardViewAgents = () =>
		[...dashboardAgents].sort((left, right) => {
			const leftActive = left.status === "starting" || left.status === "working";
			const rightActive = right.status === "starting" || right.status === "working";
			return Number(rightActive) - Number(leftActive) || right.startedAt - left.startedAt;
		});

	const showDashboardView = async (ctx: ExtensionContext) => {
		if (ctx.mode !== "tui") {
			ctx.ui.notify("La vista de subagentes requiere la interfaz TUI", "warning");
			return;
		}
		if (dashboardAgents.length === 0) {
			ctx.ui.notify("No hay subagentes recientes", "info");
			return;
		}

		const action = await ctx.ui.custom<{ type: "message"; id: string } | undefined>((tui, theme, keybindings, done) => {
			let focusedPane: "agents" | "thread" = "agents";
			let threadScrollOffset = 0;
			const currentAgents = () => getDashboardViewAgents();
			const selected = () => {
				const agents = currentAgents();
				if (!selectedViewAgentId || !agents.some((agent) => agent.id === selectedViewAgentId)) {
					selectedViewAgentId = agents[0]?.id;
				}
				return agents.find((agent) => agent.id === selectedViewAgentId);
			};
			const statusLabel = (status: DashboardAgent["status"]) => {
				switch (status) {
					case "starting": return "iniciando";
					case "working": return "activo";
					case "completed": return "completado";
					case "failed": return "fallido";
					case "aborted": return "cancelado";
					case "idle": return "inactivo";
					case "stopped": return "detenido";
				}
			};
			const statusColor = (status: DashboardAgent["status"]) =>
				status === "working" || status === "starting"
					? "warning"
					: status === "completed"
						? "success"
						: status === "failed" || status === "aborted"
							? "error"
							: "muted";
			const threadLines = (agent: DashboardAgent, width: number) => {
				const lines: string[] = [];
				for (const item of agent.thread) {
					const label = item.kind === "assistant"
						? theme.fg("accent", "● ")
						: item.kind === "operator"
							? theme.fg("success", "✉ ")
							: theme.fg(item.status === "failed" ? "error" : "muted", item.status === "running" ? "⏳ " : "› ");
					const toolStatusColor = item.status === "failed" ? "error" : item.status === "running" ? "warning" : "muted";
					const status = item.kind === "tool" && item.status ? theme.fg(toolStatusColor, ` [${item.status}]`) : "";
					const textLines = (item.text || "").replace(/\r/g, "").split("\n");
					for (let index = 0; index < textLines.length; index++) {
						const text = compactText(textLines[index], 800);
						const prefix = index === 0 ? label : "  ";
						const suffix = index === 0 ? status : "";
						lines.push(...wrapTextWithAnsi(`${prefix}${text}${suffix}`, Math.max(12, width)));
					}
					if (item.output) {
						const output = compactText(item.output, 1200);
						lines.push(...wrapTextWithAnsi(theme.fg("dim", `  ↳ ${output}`), Math.max(12, width)));
					}
				}
				return lines;
			};
			const component: Component = {
				render(width) {
					const agents = currentAgents();
					const activeCount = agents.filter((agent) => agent.status === "starting" || agent.status === "working").length;
					const agent = selected();
					if (!agent) return [theme.fg("dim", "No hay subagentes para mostrar")];
					const height = Math.max(1, tui.terminal.rows - 2);
					const contentHeight = Math.max(4, height - 4);
					const title = `${theme.fg("accent", theme.bold("SUBAGENTES"))} ${theme.fg("warning", `${activeCount} activos`)} ${theme.fg("dim", `· ${agents.length} recientes`)}`;
					const hint = theme.fg("dim", "↑↓ seleccionar/navegar · Tab cambiar panel · c cancelar · m enviar mensaje · Esc cerrar");
					const header = [truncateToWidth(title, width), truncateToWidth(hint, width)];
					const selectedIndex = agents.findIndex((item) => item.id === agent.id);
					const leftWidth = Math.min(38, Math.max(24, Math.floor(width * 0.3)));
					const separator = theme.fg("dim", " │ ");
					let body: string[];

					if (width >= 88) {
						const rightWidth = Math.max(16, width - leftWidth - 3);
						const leftLines = [theme.fg(focusedPane === "agents" ? "accent" : "muted", theme.bold(" TAREAS "))];
						for (const [index, item] of agents.entries()) {
							const chosen = item.id === agent.id;
							const pointer = chosen ? "▶ " : "  ";
							const state = statusLabel(item.status);
							leftLines.push(truncateToWidth(
								`${theme.fg(chosen ? "accent" : "muted", pointer)}${theme.fg("toolTitle", theme.bold(item.name))} ${theme.fg(statusColor(item.status), state)}`,
								leftWidth,
							));
							leftLines.push(truncateToWidth(theme.fg("dim", `  ${compactText(item.task, leftWidth - 4)}`), leftWidth));
							if (index >= Math.ceil(contentHeight / 2)) break;
						}
						const rightLines = [
							`${theme.fg("toolTitle", theme.bold(agent.name))} ${theme.fg(statusColor(agent.status), statusLabel(agent.status))}`,
							`${theme.fg("muted", agent.model)} · esfuerzo ${agent.effort} · ctx ${formatTokens(agent.contextTokens)}`,
							`${theme.fg("dim", `Tarea: ${compactText(agent.task, Math.max(20, rightWidth - 8))}`)}`,
							theme.fg("muted", "── Hilo de actividad ──"),
							...threadLines(agent, rightWidth - 2),
						];
						const threadCapacity = Math.max(1, contentHeight - 4);
						const threadStart = Math.max(4, rightLines.length - threadCapacity - threadScrollOffset);
						const visibleRight = rightLines.slice(0, 4).concat(rightLines.slice(threadStart, threadStart + threadCapacity));
						const rows = Math.max(leftLines.length, visibleRight.length, contentHeight);
						body = Array.from({ length: rows }, (_, index) => {
							const left = truncateToWidth(leftLines[index] ?? "", leftWidth, "", true);
							const right = truncateToWidth(visibleRight[index] ?? "", rightWidth, "", true);
							return `${left}${separator}${right}`;
						}).slice(0, contentHeight);
					} else {
						const listLines = agents.slice(0, 4).map((item, index) => {
							const chosen = item.id === agent.id;
							return `${theme.fg(chosen ? "accent" : "muted", chosen ? "▶" : "·")} ${index + 1}. ${theme.fg("toolTitle", item.name)} ${theme.fg(statusColor(item.status), statusLabel(item.status))}`;
						});
						const details = [
							`${theme.fg("toolTitle", theme.bold(agent.name))} ${theme.fg(statusColor(agent.status), statusLabel(agent.status))}`,
							`${theme.fg("muted", agent.model)} · esfuerzo ${agent.effort} · ctx ${formatTokens(agent.contextTokens)}`,
							`${theme.fg("dim", `Tarea: ${compactText(agent.task, width - 8)}`)}`,
							theme.fg("muted", "── Hilo de actividad ──"),
							...threadLines(agent, width - 4),
						];
						const fixed = [theme.fg("muted", "Tareas:"), ...listLines, theme.fg("dim", "────────────────────────")];
						const threadCapacity = Math.max(1, contentHeight - fixed.length - 4);
						const threadStart = Math.max(4, details.length - threadCapacity - threadScrollOffset);
						body = fixed.concat(details.slice(0, 4), details.slice(threadStart, threadStart + threadCapacity)).slice(0, contentHeight);
					}

					const footer = theme.fg("dim", focusedPane === "agents" ? `Agente ${selectedIndex + 1}/${agents.length}` : `Hilo · desplaza ${threadScrollOffset} líneas desde el final`);
					return [...header, ...body, truncateToWidth(footer, width)].slice(0, height).map((line) => truncateToWidth(line, width));
				},
				handleInput(data) {
					const agents = currentAgents();
					const agent = selected();
					if (keybindings.matches(data, "tui.select.cancel")) {
						done(undefined);
						return;
					}
					if (matchesKey(data, "tab") || matchesKey(data, "left") || matchesKey(data, "right")) {
						focusedPane = focusedPane === "agents" ? "thread" : "agents";
						tui.requestRender();
						return;
					}
					if (keybindings.matches(data, "tui.select.up")) {
						if (focusedPane === "agents" && agents.length > 0) {
							const index = agents.findIndex((item) => item.id === agent?.id);
						selectedViewAgentId = agents[(index - 1 + agents.length) % agents.length].id;
							threadScrollOffset = 0;
						} else threadScrollOffset++;
					} else if (keybindings.matches(data, "tui.select.down")) {
						if (focusedPane === "agents" && agents.length > 0) {
							const index = agents.findIndex((item) => item.id === agent?.id);
							selectedViewAgentId = agents[(index + 1) % agents.length].id;
							threadScrollOffset = 0;
						} else threadScrollOffset = Math.max(0, threadScrollOffset - 1);
					} else if (keybindings.matches(data, "tui.select.pageUp")) {
						threadScrollOffset += Math.max(1, tui.terminal.rows - 8);
					} else if (keybindings.matches(data, "tui.select.pageDown")) {
						threadScrollOffset = Math.max(0, threadScrollOffset - Math.max(1, tui.terminal.rows - 8));
					} else if (keybindings.matches(data, "tui.select.confirm")) {
						focusedPane = "thread";
					} else if (matchesKey(data, "c") && agent) {
						if (dashboardControls.has(agent.id)) cancelDashboardAgent(agent.id);
						else ctx.ui.notify(`${agent.name} ya no está activo`, "info");
					} else if (matchesKey(data, "m") && agent) {
						if (!dashboardControls.has(agent.id)) {
							ctx.ui.notify(`${agent.name} ya no está activo`, "info");
							return;
						}
						done({ type: "message", id: agent.id });
						return;
					} else return;
					tui.requestRender();
				},
				invalidate() {},
			};
			const requestRender = () => tui.requestRender();
			dashboardViewRequestRender = requestRender;
			return component;
		});
		dashboardViewRequestRender = undefined;
		if (action?.type === "message") showAgentMessageInput(action.id);
	};

	pi.on("session_start", (_event, ctx) => {
		dashboardAgents.length = 0;
		dashboardControls.clear();
		abandonBackgroundTasks();
		dashboardActions.clear();
		selectedAgentId = undefined;
		selectedViewAgentId = undefined;
		dashboardContext = ctx;
		dashboardWidgetMounted = false;
		dashboardRequestRender = undefined;
		dashboardViewRequestRender = undefined;
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		abandonBackgroundTasks();
		if (ctx.mode === "tui" && dashboardWidgetMounted) ctx.ui.setWidget("subagent-dashboard", undefined);
		dashboardWidgetMounted = false;
		dashboardRequestRender = undefined;
		dashboardViewRequestRender = undefined;
		await Promise.all(
			Array.from(dashboardControls.values(), async (controls) => {
				try {
					await controls.terminate();
				} catch {
					// Session shutdown must continue even if a child already exited.
				}
			}),
		);
		dashboardContext = undefined;
		dashboardControls.clear();
		dashboardActions.clear();
	});

	pi.registerCommand("subagents", {
		description: "Abrir la vista de actividad de los subagentes",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("La vista de subagentes requiere una interfaz interactiva", "warning");
				return;
			}
			await showDashboardView(ctx);
		},
	});

	pi.registerShortcut("alt+a", {
		description: "Abrir la vista de actividad de los subagentes",
		handler: async (ctx) => showDashboardView(ctx),
	});

	pi.registerCommand("subagent-message", {
		description: "Enviar una instrucción al subagente seleccionado",
		handler: async (args, ctx) => {
			const active = activeDashboardAgents();
			const selected = active.find((agent) => agent.id === selectedAgentId) ?? active[0];
			const controls = selected && dashboardControls.get(selected.id);
			if (!selected || !controls) {
				ctx.ui.notify("Selecciona un subagente activo con /subagents", "warning");
				return;
			}
			const message = args.trim() || (ctx.hasUI ? await ctx.ui.input(`Mensaje para ${selected.name}`, "Escribe una instrucción para el subagente") : undefined);
			if (!message?.trim()) return;
			try {
				await controls.send(message.trim());
				ctx.ui.notify(`Mensaje enviado a ${selected.name}`, "info");
			} catch (error) {
				ctx.ui.notify(String(error), "error");
			}
		},
	});

	pi.registerCommand("subagent-cancel", {
		description: "Cancelar el subagente seleccionado",
		handler: async (_args, ctx) => {
			const active = activeDashboardAgents();
			const selected = active.find((agent) => agent.id === selectedAgentId) ?? active[0];
			if (!selected || !dashboardControls.has(selected.id)) {
				ctx.ui.notify("Selecciona un subagente activo con /subagents", "warning");
				return;
			}
			cancelDashboardAgent(selected.id);
		},
	});

	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description: [
			"Delegate tasks to specialized subagents with isolated context.",
			'Modes: single (agent + task), parallel (tasks array), chain (sequential with {previous} placeholder). Single mode supports mode "task" (wait, default) or "background" (return a task ID; deliver the result automatically when finished).',
			`Includes bundled defaults (scout, planner, reviewer, worker) and user agents from ${path.join(getAgentDir(), "agents")}.`,
			`To enable project-local agents in ${CONFIG_DIR_NAME}/agents, set agentScope: "both" (or "project").`,
		].join(" "),
		parameters: SubagentParams,

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const agentScope = normalizeAgentScope(params.agentScope);
			const executionMode = normalizeExecutionMode(params.mode);
			const dispatchDefaults: DispatchDefaults = {
				model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
				thinkingLevel: ctx.thinkingLevel,
			};
			const knownModels = ctx.modelRegistry.getAll();
			const dashboardHooks: DashboardHooks = {
				report: reportDashboardAgent,
				setControls(id, controls) {
					if (controls) dashboardControls.set(id, controls);
					else dashboardControls.delete(id);
					installDashboardWidget();
				},
				resolveModel(model) {
					const match = model
						? knownModels.find((candidate) => `${candidate.provider}/${candidate.id}` === model) ??
							knownModels.find((candidate) => candidate.id === model && candidate.provider === ctx.model?.provider) ??
							knownModels.find((candidate) => candidate.id === model)
						: ctx.model;
					return {
						label: match ? `${match.provider}/${match.id}` : model ?? "modelo predeterminado",
						contextWindow: match?.contextWindow,
					};
				},
			};
			const discovery = discoverAgents(ctx.cwd, agentScope);
			const agents = discovery.agents;
			const confirmProjectAgents = params.confirmProjectAgents ?? true;

			const hasChain = (params.chain?.length ?? 0) > 0;
			const hasTasks = (params.tasks?.length ?? 0) > 0;
			const hasSingle = Boolean(params.agent && params.task);
			const modeCount = Number(hasChain) + Number(hasTasks) + Number(hasSingle);

			const makeDetails =
				(mode: "single" | "parallel" | "chain") =>
				(results: SingleResult[]): SubagentDetails => ({
					mode,
					agentScope,
					projectAgentsDir: discovery.projectAgentsDir,
					results,
				});

			if (modeCount !== 1) {
				const available = agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
				return {
					content: [
						{
							type: "text",
							text: `Invalid parameters. Provide exactly one mode.\nAvailable agents: ${available}`,
						},
					],
					details: makeDetails("single")([]),
				};
			}

			if (executionMode === "background" && !hasSingle) {
				return {
					content: [{ type: "text", text: 'Background mode is available only for a single agent call (agent + task), not parallel or chain tasks.' }],
					details: makeDetails(hasChain ? "chain" : hasTasks ? "parallel" : "single")([]),
					isError: true,
				};
			}

			if (
				(agentScope === "project" || agentScope === "both") &&
				confirmProjectAgents &&
				ctx.hasUI &&
				!ctx.isProjectTrusted()
			) {
				const requestedAgentNames = new Set<string>();
				if (params.chain) for (const step of params.chain) requestedAgentNames.add(step.agent);
				if (params.tasks) for (const t of params.tasks) requestedAgentNames.add(t.agent);
				if (params.agent) requestedAgentNames.add(params.agent);

				const projectAgentsRequested = Array.from(requestedAgentNames)
					.map((name) => agents.find((a) => a.name === name))
					.filter((a): a is AgentConfig => a?.source === "project");

				if (projectAgentsRequested.length > 0) {
					const names = projectAgentsRequested.map((a) => a.name).join(", ");
					const dir = discovery.projectAgentsDir ?? "(unknown)";
					const ok = await ctx.ui.confirm(
						"Run project-local agents?",
						`Agents: ${names}\nSource: ${dir}\n\nProject agents are repo-controlled. Only continue for trusted repositories.`,
					);
					if (!ok)
						return {
							content: [{ type: "text", text: "Canceled: project-local agents not approved." }],
							details: makeDetails(hasChain ? "chain" : hasTasks ? "parallel" : "single")([]),
						};
				}
			}

			if (params.chain && params.chain.length > 0) {
				const results: SingleResult[] = [];
				let previousOutput = "";

				for (let i = 0; i < params.chain.length; i++) {
					const step = params.chain[i];
					const taskWithContext = step.task.replace(/\{previous\}/g, previousOutput);

					// Create update callback that includes all previous results
					const chainUpdate: OnUpdateCallback | undefined = onUpdate
						? (partial) => {
								// Combine completed results with current streaming result
								const currentResult = partial.details?.results[0];
								if (currentResult) {
									const allResults = [...results, currentResult];
									onUpdate({
										content: partial.content,
										details: makeDetails("chain")(allResults),
									});
								}
							}
						: undefined;

					const result = await runSingleAgent(
						ctx.cwd,
						dispatchDefaults,
						agents,
						step.agent,
						taskWithContext,
						step.cwd,
						i + 1,
						signal,
						chainUpdate,
						makeDetails("chain"),
						dashboardHooks,
					);
					results.push(result);

					const isError = isFailedResult(result);
					if (isError) {
						const errorMsg = getResultOutput(result);
						return {
							content: [{ type: "text", text: `Chain stopped at step ${i + 1} (${step.agent}): ${errorMsg}` }],
							details: makeDetails("chain")(results),
							isError: true,
						};
					}
					previousOutput = getFinalOutput(result.messages);
				}
				return {
					content: [{ type: "text", text: getFinalOutput(results[results.length - 1].messages) || "(no output)" }],
					details: makeDetails("chain")(results),
				};
			}

			if (params.tasks && params.tasks.length > 0) {
				if (params.tasks.length > MAX_PARALLEL_TASKS)
					return {
						content: [
							{
								type: "text",
								text: `Too many parallel tasks (${params.tasks.length}). Max is ${MAX_PARALLEL_TASKS}.`,
							},
						],
						details: makeDetails("parallel")([]),
					};

				// Track all results for streaming updates
				const allResults: SingleResult[] = new Array(params.tasks.length);

				// Initialize placeholder results
				for (let i = 0; i < params.tasks.length; i++) {
					allResults[i] = {
						agent: params.tasks[i].agent,
						agentSource: "unknown",
						task: params.tasks[i].task,
						exitCode: -1, // -1 = still running
						messages: [],
						stderr: "",
						usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
					};
				}

				const emitParallelUpdate = () => {
					if (onUpdate) {
						const running = allResults.filter((r) => r.exitCode === -1).length;
						const done = allResults.filter((r) => r.exitCode !== -1).length;
						onUpdate({
							content: [
								{ type: "text", text: `Parallel: ${done}/${allResults.length} done, ${running} running...` },
							],
							details: makeDetails("parallel")([...allResults]),
						});
					}
				};

				const results = await mapWithConcurrencyLimit(params.tasks, MAX_CONCURRENCY, async (t, index) => {
					const result = await runSingleAgent(
						ctx.cwd,
						dispatchDefaults,
						agents,
						t.agent,
						t.task,
						t.cwd,
						undefined,
						signal,
						// Per-task update callback
						(partial) => {
							if (partial.details?.results[0]) {
								allResults[index] = partial.details.results[0];
								emitParallelUpdate();
							}
						},
						makeDetails("parallel"),
						dashboardHooks,
					);
					allResults[index] = result;
					emitParallelUpdate();
					return result;
				});

				const successCount = results.filter((r) => !isFailedResult(r)).length;
				const summaries = results.map((r) => {
					const output = truncateParallelOutput(getResultOutput(r));
					const status = isFailedResult(r)
						? `failed${r.stopReason && r.stopReason !== "end" ? ` (${r.stopReason})` : ""}`
						: "completed";
					return `### [${r.agent}] ${status}\n\n${output}`;
				});
				return {
					content: [
						{
							type: "text",
							text: `Parallel: ${successCount}/${results.length} succeeded\n\n${summaries.join("\n\n---\n\n")}`,
						},
					],
					details: makeDetails("parallel")(results),
				};
			}

			if (params.agent && params.task) {
				const agentName = params.agent;
				const taskText = params.task;
				if (executionMode === "background") {
					if (ctx.mode === "print" || ctx.mode === "json") {
						return {
							content: [{ type: "text", text: "Background mode requires a persistent interactive or RPC session; use task mode in print/JSON mode." }],
							details: { ...makeDetails("single")([]), executionMode },
							isError: true,
						};
					}
					if (signal?.aborted) {
						return {
							content: [{ type: "text", text: "Background subagent launch was aborted before it started." }],
							details: { ...makeDetails("single")([]), executionMode },
							isError: true,
						};
					}

							if (backgroundTasks.size >= MAX_BACKGROUND_TASKS) {
						return {
							content: [{ type: "text", text: `Ya hay ${MAX_BACKGROUND_TASKS} subagentes en segundo plano; espera a que termine uno antes de lanzar otro.` }],
							details: { ...makeDetails("single")([]), executionMode },
							isError: true,
						};
					}
					const sessionId = ctx.sessionManager.getSessionId();
					const backgroundController = new AbortController();
					let backgroundTaskId: string | undefined;
					const run = runSingleAgent(
						ctx.cwd,
						dispatchDefaults,
						agents,
						agentName,
						taskText,
						params.cwd,
						undefined,
						backgroundController.signal,
						undefined,
						makeDetails("single"),
						dashboardHooks,
						(id) => {
							backgroundTaskId = id;
							backgroundTasks.set(id, { sessionId, agent: agentName, controller: backgroundController });
						},
					);
					if (!backgroundTaskId) {
						const result = await run;
						return {
							content: [{ type: "text", text: getResultOutput(result) }],
							details: makeDetails("single")([result]),
							isError: isFailedResult(result),
						};
					}

					void run.then(
						(result) => deliverBackgroundResult(backgroundTaskId!, result),
						(error) => deliverBackgroundResult(backgroundTaskId!, undefined, error),
					);
					return {
						content: [{ type: "text", text: `Started ${agentName} in the background as task ${backgroundTaskId}. Its result will be delivered automatically when it finishes; use /subagents to monitor or cancel it.` }],
						details: { ...makeDetails("single")([]), executionMode, taskId: backgroundTaskId },
					};
				}

				const result = await runSingleAgent(
					ctx.cwd,
					dispatchDefaults,
					agents,
					params.agent,
					params.task,
					params.cwd,
					undefined,
					signal,
					onUpdate,
					makeDetails("single"),
					dashboardHooks,
				);
				const isError = isFailedResult(result);
				if (isError) {
					const errorMsg = getResultOutput(result);
					return {
						content: [{ type: "text", text: `Agent ${result.stopReason || "failed"}: ${errorMsg}` }],
						details: makeDetails("single")([result]),
						isError: true,
					};
				}
				return {
					content: [{ type: "text", text: getFinalOutput(result.messages) || "(no output)" }],
					details: makeDetails("single")([result]),
				};
			}

			const available = agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
			return {
				content: [{ type: "text", text: `Invalid parameters. Available agents: ${available}` }],
				details: makeDetails("single")([]),
			};
		},

		renderCall(args, theme, _context) {
			const scope = normalizeAgentScope(args.agentScope);
			const executionMode = args.mode === "background" ? " · background" : "";
			if (args.chain && args.chain.length > 0) {
				let text =
					theme.fg("toolTitle", theme.bold("subagent ")) +
					theme.fg("accent", `chain (${args.chain.length} steps)`) +
					theme.fg("muted", ` [${scope}]`);
				for (let i = 0; i < Math.min(args.chain.length, 3); i++) {
					const step = args.chain[i];
					// Clean up {previous} placeholder for display
					const cleanTask = step.task.replace(/\{previous\}/g, "").trim();
					const preview = cleanTask.length > 40 ? `${cleanTask.slice(0, 40)}...` : cleanTask;
					text +=
						"\n  " +
						theme.fg("muted", `${i + 1}.`) +
						" " +
						theme.fg("accent", step.agent) +
						theme.fg("dim", ` ${preview}`);
				}
				if (args.chain.length > 3) text += `\n  ${theme.fg("muted", `... +${args.chain.length - 3} more`)}`;
				return new Text(text, 0, 0);
			}
			if (args.tasks && args.tasks.length > 0) {
				let text =
					theme.fg("toolTitle", theme.bold("subagent ")) +
					theme.fg("accent", `parallel (${args.tasks.length} tasks)`) +
					theme.fg("muted", ` [${scope}]`);
				for (const t of args.tasks.slice(0, 3)) {
					const preview = t.task.length > 40 ? `${t.task.slice(0, 40)}...` : t.task;
					text += `\n  ${theme.fg("accent", t.agent)}${theme.fg("dim", ` ${preview}`)}`;
				}
				if (args.tasks.length > 3) text += `\n  ${theme.fg("muted", `... +${args.tasks.length - 3} more`)}`;
				return new Text(text, 0, 0);
			}
			const agentName = args.agent || "...";
			const preview = args.task ? (args.task.length > 60 ? `${args.task.slice(0, 60)}...` : args.task) : "...";
			let text =
				theme.fg("toolTitle", theme.bold("subagent ")) +
				theme.fg("accent", agentName) +
				theme.fg("muted", ` [${scope}${executionMode}]`);
			text += `\n  ${theme.fg("dim", preview)}`;
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded }, theme, _context) {
			const details = result.details as SubagentDetails | undefined;
			if (!details || details.results.length === 0) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
			}

			const mdTheme = getMarkdownTheme();

			const renderDisplayItems = (items: DisplayItem[], limit?: number) => {
				const toShow = limit ? items.slice(-limit) : items;
				const skipped = limit && items.length > limit ? items.length - limit : 0;
				let text = "";
				if (skipped > 0) text += theme.fg("muted", `... ${skipped} earlier items\n`);
				for (const item of toShow) {
					if (item.type === "text") {
						const preview = expanded ? item.text : item.text.split("\n").slice(0, 3).join("\n");
						text += `${theme.fg("toolOutput", preview)}\n`;
					} else {
						text += `${theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme))}\n`;
					}
				}
				return text.trimEnd();
			};

			if (details.mode === "single" && details.results.length === 1) {
				const r = details.results[0];
				const isError = isFailedResult(r);
				const icon = isError ? theme.fg("error", "✗") : theme.fg("success", "✓");
				const displayItems = getDisplayItems(r.messages);
				const finalOutput = getFinalOutput(r.messages);

				if (expanded) {
					const container = new Container();
					let header = `${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}${theme.fg("muted", ` (${r.agentSource})`)}`;
					if (isError && r.stopReason) header += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
					container.addChild(new Text(header, 0, 0));
					if (isError && r.errorMessage)
						container.addChild(new Text(theme.fg("error", `Error: ${r.errorMessage}`), 0, 0));
					container.addChild(new Spacer(1));
					container.addChild(new Text(theme.fg("muted", "─── Task ───"), 0, 0));
					container.addChild(new Text(theme.fg("dim", r.task), 0, 0));
					container.addChild(new Spacer(1));
					container.addChild(new Text(theme.fg("muted", "─── Output ───"), 0, 0));
					if (displayItems.length === 0 && !finalOutput) {
						container.addChild(new Text(theme.fg("muted", "(no output)"), 0, 0));
					} else {
						for (const item of displayItems) {
							if (item.type === "toolCall")
								container.addChild(
									new Text(
										theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)),
										0,
										0,
									),
								);
						}
						if (finalOutput) {
							container.addChild(new Spacer(1));
							container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
						}
					}
					const usageStr = formatUsageStats(r.usage, r.model);
					if (usageStr) {
						container.addChild(new Spacer(1));
						container.addChild(new Text(theme.fg("dim", usageStr), 0, 0));
					}
					return container;
				}

				let text = `${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}${theme.fg("muted", ` (${r.agentSource})`)}`;
				if (isError && r.stopReason) text += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
				if (isError && r.errorMessage) text += `\n${theme.fg("error", `Error: ${r.errorMessage}`)}`;
				else if (displayItems.length === 0) text += `\n${theme.fg("muted", "(no output)")}`;
				else {
					text += `\n${renderDisplayItems(displayItems, COLLAPSED_ITEM_COUNT)}`;
					if (displayItems.length > COLLAPSED_ITEM_COUNT) text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
				}
				const usageStr = formatUsageStats(r.usage, r.model);
				if (usageStr) text += `\n${theme.fg("dim", usageStr)}`;
				return new Text(text, 0, 0);
			}

			const aggregateUsage = (results: SingleResult[]) => {
				const total = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
				for (const r of results) {
					total.input += r.usage.input;
					total.output += r.usage.output;
					total.cacheRead += r.usage.cacheRead;
					total.cacheWrite += r.usage.cacheWrite;
					total.cost += r.usage.cost;
					total.turns += r.usage.turns;
				}
				return total;
			};

			if (details.mode === "chain") {
				const successCount = details.results.filter((r) => r.exitCode === 0).length;
				const icon = successCount === details.results.length ? theme.fg("success", "✓") : theme.fg("error", "✗");

				if (expanded) {
					const container = new Container();
					container.addChild(
						new Text(
							icon +
								" " +
								theme.fg("toolTitle", theme.bold("chain ")) +
								theme.fg("accent", `${successCount}/${details.results.length} steps`),
							0,
							0,
						),
					);

					for (const r of details.results) {
						const rIcon = r.exitCode === 0 ? theme.fg("success", "✓") : theme.fg("error", "✗");
						const displayItems = getDisplayItems(r.messages);
						const finalOutput = getFinalOutput(r.messages);

						container.addChild(new Spacer(1));
						container.addChild(
							new Text(
								`${theme.fg("muted", `─── Step ${r.step}: `) + theme.fg("accent", r.agent)} ${rIcon}`,
								0,
								0,
							),
						);
						container.addChild(new Text(theme.fg("muted", "Task: ") + theme.fg("dim", r.task), 0, 0));

						// Show tool calls
						for (const item of displayItems) {
							if (item.type === "toolCall") {
								container.addChild(
									new Text(
										theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)),
										0,
										0,
									),
								);
							}
						}

						// Show final output as markdown
						if (finalOutput) {
							container.addChild(new Spacer(1));
							container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
						}

						const stepUsage = formatUsageStats(r.usage, r.model);
						if (stepUsage) container.addChild(new Text(theme.fg("dim", stepUsage), 0, 0));
					}

					const usageStr = formatUsageStats(aggregateUsage(details.results));
					if (usageStr) {
						container.addChild(new Spacer(1));
						container.addChild(new Text(theme.fg("dim", `Total: ${usageStr}`), 0, 0));
					}
					return container;
				}

				// Collapsed view
				let text =
					icon +
					" " +
					theme.fg("toolTitle", theme.bold("chain ")) +
					theme.fg("accent", `${successCount}/${details.results.length} steps`);
				for (const r of details.results) {
					const rIcon = r.exitCode === 0 ? theme.fg("success", "✓") : theme.fg("error", "✗");
					const displayItems = getDisplayItems(r.messages);
					text += `\n\n${theme.fg("muted", `─── Step ${r.step}: `)}${theme.fg("accent", r.agent)} ${rIcon}`;
					if (displayItems.length === 0) text += `\n${theme.fg("muted", "(no output)")}`;
					else text += `\n${renderDisplayItems(displayItems, 5)}`;
				}
				const usageStr = formatUsageStats(aggregateUsage(details.results));
				if (usageStr) text += `\n\n${theme.fg("dim", `Total: ${usageStr}`)}`;
				text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
				return new Text(text, 0, 0);
			}

			if (details.mode === "parallel") {
				const running = details.results.filter((r) => r.exitCode === -1).length;
				const successCount = details.results.filter((r) => r.exitCode !== -1 && !isFailedResult(r)).length;
				const failCount = details.results.filter((r) => r.exitCode !== -1 && isFailedResult(r)).length;
				const isRunning = running > 0;
				const icon = isRunning
					? theme.fg("warning", "⏳")
					: failCount > 0
						? theme.fg("warning", "◐")
						: theme.fg("success", "✓");
				const status = isRunning
					? `${successCount + failCount}/${details.results.length} done, ${running} running`
					: `${successCount}/${details.results.length} tasks`;

				if (expanded && !isRunning) {
					const container = new Container();
					container.addChild(
						new Text(
							`${icon} ${theme.fg("toolTitle", theme.bold("parallel "))}${theme.fg("accent", status)}`,
							0,
							0,
						),
					);

					for (const r of details.results) {
						const rIcon = isFailedResult(r) ? theme.fg("error", "✗") : theme.fg("success", "✓");
						const displayItems = getDisplayItems(r.messages);
						const finalOutput = getFinalOutput(r.messages);

						container.addChild(new Spacer(1));
						container.addChild(
							new Text(`${theme.fg("muted", "─── ") + theme.fg("accent", r.agent)} ${rIcon}`, 0, 0),
						);
						container.addChild(new Text(theme.fg("muted", "Task: ") + theme.fg("dim", r.task), 0, 0));

						// Show tool calls
						for (const item of displayItems) {
							if (item.type === "toolCall") {
								container.addChild(
									new Text(
										theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)),
										0,
										0,
									),
								);
							}
						}

						// Show final output as markdown
						if (finalOutput) {
							container.addChild(new Spacer(1));
							container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
						}

						const taskUsage = formatUsageStats(r.usage, r.model);
						if (taskUsage) container.addChild(new Text(theme.fg("dim", taskUsage), 0, 0));
					}

					const usageStr = formatUsageStats(aggregateUsage(details.results));
					if (usageStr) {
						container.addChild(new Spacer(1));
						container.addChild(new Text(theme.fg("dim", `Total: ${usageStr}`), 0, 0));
					}
					return container;
				}

				// Collapsed view (or still running)
				let text = `${icon} ${theme.fg("toolTitle", theme.bold("parallel "))}${theme.fg("accent", status)}`;
				for (const r of details.results) {
					const rIcon =
						r.exitCode === -1
							? theme.fg("warning", "⏳")
							: isFailedResult(r)
								? theme.fg("error", "✗")
								: theme.fg("success", "✓");
					const displayItems = getDisplayItems(r.messages);
					text += `\n\n${theme.fg("muted", "─── ")}${theme.fg("accent", r.agent)} ${rIcon}`;
					if (displayItems.length === 0)
						text += `\n${theme.fg("muted", r.exitCode === -1 ? "(running...)" : "(no output)")}`;
					else text += `\n${renderDisplayItems(displayItems, 5)}`;
				}
				if (!isRunning) {
					const usageStr = formatUsageStats(aggregateUsage(details.results));
					if (usageStr) text += `\n\n${theme.fg("dim", `Total: ${usageStr}`)}`;
				}
				if (!expanded) text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
				return new Text(text, 0, 0);
			}

			const text = result.content[0];
			return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
		},
	});
}
