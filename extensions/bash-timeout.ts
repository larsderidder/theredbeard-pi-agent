/**
 * Bash Timeout Extension
 *
 * The LLM sometimes starts background processes (dev servers, etc.) and then
 * runs a sleep+curl check in the same bash call. Without a timeout the bash
 * tool hangs until Escape is pressed.
 *
 * This extension intercepts bash tool calls to enforce a default timeout of
 * 30s when none is set by the model, and caps any supplied value at 600s.
 * It does not override the tool, so it composes with other bash extensions.
 */

import { isToolCallEventType, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

const DEFAULT_TIMEOUT_SECS = 30;
const MAX_TIMEOUT_SECS = 600;

export default function (pi: ExtensionAPI) {
	pi.on("tool_call", (event) => {
		if (!isToolCallEventType("bash", event)) {
			return;
		}

		if (event.input.timeout === undefined || event.input.timeout === null) {
			event.input.timeout = DEFAULT_TIMEOUT_SECS;
			return;
		}

		event.input.timeout = Math.min(event.input.timeout, MAX_TIMEOUT_SECS);
	});
}
