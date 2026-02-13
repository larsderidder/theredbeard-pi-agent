import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  function updateLastPrompt(ctx: { sessionManager: any; ui: any }) {
    const entries = ctx.sessionManager.getBranch();

    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i];
      if (entry.type === "message" && entry.message.role === "user") {
        const msg = entry.message;
        let text = "";

        if (typeof msg.content === "string") {
          text = msg.content;
        } else if (Array.isArray(msg.content)) {
          text = msg.content
            .filter((b: any) => b.type === "text")
            .map((b: any) => b.text)
            .join(" ");
        }

        if (text) {
          const theme = ctx.ui.theme;
          const oneLine = text.replace(/\n/g, " ").trim();
          const display = oneLine.length > 120 ? oneLine.slice(0, 117) + "..." : oneLine;
          ctx.ui.setStatus("last-prompt", theme.fg("dim", `💬 ${display}`));
        }
        return;
      }
    }
  }

  pi.on("session_start", async (_event, ctx) => {
    updateLastPrompt(ctx);
  });

  pi.on("agent_end", async (_event, ctx) => {
    updateLastPrompt(ctx);
  });
}
