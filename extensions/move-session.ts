import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

function parseTarget(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";

  if (trimmed.startsWith('"')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (typeof parsed === "string") return parsed;
    } catch {
      // Fall back to the raw argument below.
    }
  }

  return trimmed;
}

function syncProcessCwd(targetCwd: string, ctx: any): boolean {
  try {
    process.chdir(targetCwd);
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.ui.notify(`Session moved, but process cwd could not be updated: ${message}`, "error");
    return false;
  }
}

let activeMoveTarget: string | undefined;

function getSessionManager(): any {
  const { SessionManager } = require("@earendil-works/pi-coding-agent");
  return SessionManager;
}

async function moveSession(targetArg: string, ctx: any): Promise<void> {
  await ctx.waitForIdle();

  const targetCwd = resolve(ctx.cwd, targetArg);
  const currentCwd = resolve(ctx.cwd);

  if (targetCwd === currentCwd) {
    ctx.ui.notify(`Session is already in ${targetCwd}.`, "info");
    return;
  }

  if (activeMoveTarget) {
    ctx.ui.notify(`Session move already in progress to ${activeMoveTarget}.`, "error");
    return;
  }

  activeMoveTarget = targetCwd;
  try {
    const sourceFile = ctx.sessionManager.getSessionFile();
    if (!sourceFile) {
      ctx.ui.notify("Current session is ephemeral, nothing to move.", "error");
      return;
    }

    mkdirSync(targetCwd, { recursive: true });

    const newManager = getSessionManager().forkFrom(sourceFile, targetCwd);
    const newFile = newManager.getSessionFile();

    if (!newFile) {
      ctx.ui.notify("Could not create the moved session file.", "error");
      return;
    }

    await ctx.switchSession(newFile, {
      withSession: async (ctx: any) => {
        const processCwdUpdated = syncProcessCwd(targetCwd, ctx);
        const suffix = processCwdUpdated ? "" : ", but process cwd stayed unchanged";
        ctx.ui.notify(`Session copied to ${targetCwd}${suffix}`, "success");
      },
    });
  } finally {
    activeMoveTarget = undefined;
  }
}

export default function moveSessionExtension(pi: ExtensionAPI) {
  pi.registerCommand("move-session", {
    description: "Copy current session history to another directory and switch to it. Usage: /move-session <directory>",
    handler: async (args, ctx) => {
      const target = parseTarget(args);

      if (!target) {
        ctx.ui.notify("Usage: /move-session <directory>", "error");
        return;
      }

      await moveSession(target, ctx);
    },
  });

  pi.on("input", (event, ctx) => {
    if (event.source !== "extension") return { action: "continue" };
    if (!event.text.trim().startsWith("/move-session")) return { action: "continue" };

    ctx.ui.notify(
      "Ignored extension-injected /move-session message to prevent a retry loop. Use the slash command directly instead.",
      "error",
    );
    return { action: "handled" };
  });
}
