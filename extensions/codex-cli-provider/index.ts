/**
 * Codex CLI Provider Extension for pi
 *
 * Wraps the `codex` CLI as a pi model provider via `codex exec --json`.
 */

import type {
	AssistantMessage,
	AssistantMessageEventStream,
	Context,
	Model,
	SimpleStreamOptions,
} from "@mariozechner/pi-ai";
import { createAssistantMessageEventStream, calculateCost } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { spawn } from "child_process";

function buildFullPrompt(context: Context): string {
	const parts: string[] = [];

	if (context.system) {
		parts.push(`<system>\n${context.system}\n</system>`);
	}

	for (const msg of context.messages) {
		if (msg.role === "user") {
			const text =
				typeof msg.content === "string"
					? msg.content
					: Array.isArray(msg.content)
						? msg.content
								.filter((b: any) => b.type === "text")
								.map((b: any) => b.text)
								.join("\n")
						: "";
			if (text) parts.push(`<user>\n${text}\n</user>`);
		} else if (msg.role === "assistant") {
			const content = (msg as any).content;
			if (Array.isArray(content)) {
				const textParts = content
					.filter((b: any) => b.type === "text")
					.map((b: any) => b.text);
				if (textParts.length > 0) {
					parts.push(`<assistant>\n${textParts.join("\n")}\n</assistant>`);
				}
				const toolCalls = content.filter((b: any) => b.type === "toolCall");
				for (const tc of toolCalls) {
					parts.push(
						`<tool_call name=\"${tc.name}\">\n${JSON.stringify(tc.arguments)}\n</tool_call>`,
					);
				}
			}
		} else if (msg.role === "tool") {
			const content = (msg as any).content;
			if (Array.isArray(content)) {
				for (const block of content) {
					if (block.type === "toolResult") {
						const resultText = Array.isArray(block.content)
							? block.content
									.filter((b: any) => b.type === "text")
									.map((b: any) => b.text)
									.join("\n")
							: String(block.content || "");
						parts.push(
							`<tool_result id=\"${block.id}\">\n${resultText}\n</tool_result>`,
						);
					}
				}
			}
		}
	}

	return parts.join("\n\n");
}

function streamCodexCli(
	model: Model<any>,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();

	(async () => {
		const output: AssistantMessage = {
			role: "assistant",
			content: [],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		};

		try {
			stream.push({ type: "start", partial: output });

			const prompt = buildFullPrompt(context);
			const modelId = model.id;

			const args = [
				"exec",
				"--json",
				"--color",
				"never",
				"-m",
				modelId,
				"-C",
				process.cwd(),
			];

			const proc = spawn("codex", args, {
				stdio: ["pipe", "pipe", "pipe"],
				env: { ...process.env, NO_COLOR: "1" },
			});

			if (options?.signal) {
				options.signal.addEventListener(
					"abort",
					() => {
						proc.kill("SIGTERM");
					},
					{ once: true },
				);
			}

			proc.stdin.write(prompt);
			proc.stdin.end();

			let contentIndex = -1;
			let buffer = "";

			const appendText = (text: string) => {
				if (!text) return;
				if (contentIndex === -1) {
					output.content.push({ type: "text", text: "" });
					contentIndex = output.content.length - 1;
					stream.push({ type: "text_start", contentIndex, partial: output });
				}
				const block = output.content[contentIndex];
				if (block.type === "text") {
					block.text += text;
					stream.push({ type: "text_delta", contentIndex, delta: text, partial: output });
				}
			};

			const endTextBlock = () => {
				if (contentIndex < 0) return;
				const block = output.content[contentIndex];
				if (block.type === "text") {
					stream.push({
						type: "text_end",
						contentIndex,
						content: block.text,
						partial: output,
					});
				}
				contentIndex = -1;
			};

			const pushToolCall = (name: string, args: Record<string, unknown>) => {
				endTextBlock();
				const toolId = `codex_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
				output.content.push({
					type: "toolCall",
					id: toolId,
					name,
					arguments: args,
				});
				const tcIndex = output.content.length - 1;
				stream.push({ type: "toolcall_start", contentIndex: tcIndex, partial: output });
				stream.push({
					type: "toolcall_end",
					contentIndex: tcIndex,
					toolCall: {
						type: "toolCall",
						id: toolId,
						name,
						arguments: args,
					},
					partial: output,
				});
			};

			proc.stdout.on("data", (chunk: Buffer) => {
				buffer += chunk.toString();
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";

				for (const line of lines) {
					if (!line.trim()) continue;
					let event: any;
					try {
						event = JSON.parse(line);
					} catch {
						continue;
					}

					if (event.type === "item.completed") {
						const item = event.item || {};
						if (item.type === "reasoning") {
							const text = item.text || "";
							if (!text) continue;

							if (contentIndex >= 0) {
								const prev = output.content[contentIndex];
								if (prev.type === "text") {
									stream.push({
										type: "text_end",
										contentIndex,
										content: prev.text,
										partial: output,
									});
								}
								contentIndex = -1;
							}

							output.content.push({ type: "thinking", thinking: "" } as any);
							const thinkIdx = output.content.length - 1;
							stream.push({ type: "thinking_start", contentIndex: thinkIdx, partial: output });
							const thinkBlock = output.content[thinkIdx] as any;
							thinkBlock.thinking = text;
							stream.push({
								type: "thinking_delta",
								contentIndex: thinkIdx,
								delta: text,
								partial: output,
							});
							stream.push({
								type: "thinking_end",
								contentIndex: thinkIdx,
								content: text,
								partial: output,
							});
						} else if (item.type === "agent_message") {
							const text = item.text || "";
							if (!text) continue;
							appendText(text);
						} else if (item.type === "tool_call") {
							endTextBlock();

							const toolName = item.tool || item.name || "unknown";
							const toolArgs = item.arguments || item.args || {};
							const toolId = item.id || `codex_${Date.now()}`;

							output.content.push({
								type: "toolCall",
								id: toolId,
								name: toolName,
								arguments: toolArgs,
							});
							const tcIndex = output.content.length - 1;
							stream.push({ type: "toolcall_start", contentIndex: tcIndex, partial: output });
							stream.push({
								type: "toolcall_end",
								contentIndex: tcIndex,
								toolCall: {
									type: "toolCall",
									id: toolId,
									name: toolName,
									arguments: toolArgs,
								},
								partial: output,
							});
						} else if (item.type === "command_execution") {
							const command = item.command || "(unknown command)";
							const outputText = (item.aggregated_output || "").trimEnd();
							const exitCode = item.exit_code;
							const maxOutput = 4000;
							const truncated = outputText.length > maxOutput;
							const outputPreview = truncated
								? `${outputText.slice(0, maxOutput)}\n... (truncated)`
								: outputText;
							pushToolCall("codex.exec", {
								command,
								exitCode,
								output: outputPreview || undefined,
								outputTruncated: truncated || undefined,
							});
						}
					}

					if (event.type === "turn.completed") {
						const usage = event.usage || {};
						output.usage.input = usage.input_tokens || 0;
						output.usage.output = usage.output_tokens || 0;
						output.usage.cacheRead = usage.cached_input_tokens || 0;
						output.usage.totalTokens =
							(output.usage.input || 0) + (output.usage.output || 0);
					}
				}
			});

			await new Promise<void>((resolve, reject) => {
				proc.on("close", (code) => {
					if (contentIndex >= 0) {
						const block = output.content[contentIndex];
						if (block.type === "text") {
							stream.push({
								type: "text_end",
								contentIndex,
								content: block.text,
								partial: output,
							});
						}
					}

					if (code !== 0 && !options?.signal?.aborted) {
						reject(new Error(`codex exited with code ${code}`));
					} else {
						resolve();
					}
				});

				proc.on("error", (err) => {
					reject(err);
				});
			});

			if (output.content.length === 0) {
				output.content.push({ type: "text", text: "(no response)" });
			}

			calculateCost(model, output.usage);

			stream.push({
				type: "done",
				reason: output.stopReason as "stop" | "length" | "toolUse",
				message: output,
			});
			stream.end();
		} catch (error) {
			output.stopReason = options?.signal?.aborted ? "aborted" : "error";
			output.errorMessage = error instanceof Error ? error.message : String(error);
			stream.push({ type: "error", reason: output.stopReason, error: output });
			stream.end();
		}
	})();

	return stream;
}

export default function (pi: ExtensionAPI) {
	pi.registerProvider("codex-cli", {
		baseUrl: "https://codex.cli.local",
		apiKey: "not-needed",
		api: "openai-responses" as any,
		streamSimple: streamCodexCli,
		models: [
			{
				id: "gpt-5.2-codex",
				name: "GPT-5.2 Codex (CLI)",
				reasoning: true,
				input: ["text"] as ("text" | "image")[],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 128000,
				maxTokens: 32768,
			},
			{
				id: "gpt-5.3-codex",
				name: "GPT-5.3 Codex (CLI)",
				reasoning: true,
				input: ["text"] as ("text" | "image")[],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 128000,
				maxTokens: 32768,
			},
		],
	});
}
