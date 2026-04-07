/**
 * Bash Timeout Extension
 *
 * The LLM sometimes starts background processes (dev servers, etc.) and then
 * runs a sleep+curl check in the same bash call. Without a timeout the bash
 * tool hangs until Escape is pressed.
 *
 * This extension overrides the bash tool to enforce a default timeout of 30s
 * when none is set by the model, and caps any supplied value at 120s.
 *
 * The model's own system-prompt description already says "Optionally provide a
 * timeout in seconds" so the LLM can still request a longer one explicitly;
 * it just can't accidentally leave it unset on a potentially blocking command.
 */

import { createBashTool, type ExtensionAPI } from "@mariozechner/pi-coding-agent";

const DEFAULT_TIMEOUT_SECS = 30;
const MAX_TIMEOUT_SECS = 120;

export default function (pi: ExtensionAPI) {
	const cwd = process.cwd();
	const bashTool = createBashTool(cwd);

	pi.registerTool({
		...bashTool,
		description:
			bashTool.description +
			` Default timeout: ${DEFAULT_TIMEOUT_SECS}s (applied when none is given). Max timeout: ${MAX_TIMEOUT_SECS}s.`,

		execute: async (toolCallId, params, signal, onUpdate, _ctx) => {
			const rawTimeout = params.timeout;
			const timeout =
				rawTimeout === undefined || rawTimeout === null
					? DEFAULT_TIMEOUT_SECS
					: Math.min(rawTimeout, MAX_TIMEOUT_SECS);

			return bashTool.execute(toolCallId, { ...params, timeout }, signal, onUpdate);
		},
	});
}
