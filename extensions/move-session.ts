import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

function parseTarget(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    return "";
  }

  if (trimmed.startsWith('"')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (typeof parsed === "string") {
        return parsed;
      }
    } catch {
      // Fall back to the raw argument below.
    }
  }

  return trimmed;
}

function syncProcessCwd(targetCwd: string, ctx: ExtensionCommandContext): boolean {
  try {
    process.chdir(targetCwd);
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.ui.notify(`Could not update the process cwd: ${message}`, "error");
    return false;
  }
}

async function switchSessionFile(
  sessionFile: string,
  targetCwd: string,
  successMessage: string,
  ctx: ExtensionCommandContext,
): Promise<boolean> {
  const previousProcessCwd = process.cwd();
  if (!syncProcessCwd(targetCwd, ctx)) {
    return false;
  }

  let replacementCompleted = false;
  try {
    const result = await ctx.switchSession(sessionFile, {
      withSession: async (newCtx) => {
        replacementCompleted = true;
        if (resolve(newCtx.cwd) !== targetCwd) {
          throw new Error(`Replacement session cwd is ${newCtx.cwd}, expected ${targetCwd}`);
        }
        newCtx.ui.notify(successMessage, "info");
      },
    });

    if (result.cancelled) {
      process.chdir(previousProcessCwd);
      return false;
    }
    return true;
  } catch (error) {
    if (!replacementCompleted) {
      process.chdir(previousProcessCwd);
    }
    throw error;
  }
}

let activeMoveTarget: string | undefined;

function getSessionManager(): any {
  const { SessionManager } = require("@earendil-works/pi-coding-agent");
  return SessionManager;
}

async function moveSession(targetArg: string, ctx: ExtensionCommandContext): Promise<void> {
  await ctx.waitForIdle();

  const targetCwd = resolve(ctx.cwd, targetArg);
  const currentCwd = resolve(ctx.cwd);

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

    if (targetCwd === currentCwd) {
      await switchSessionFile(sourceFile, targetCwd, `Session rebound to ${targetCwd}`, ctx);
      return;
    }

    mkdirSync(targetCwd, { recursive: true });

    const newManager = getSessionManager().forkFrom(sourceFile, targetCwd);
    const newFile = newManager.getSessionFile();

    if (!newFile) {
      ctx.ui.notify("Could not create the moved session file.", "error");
      return;
    }

    await switchSessionFile(newFile, targetCwd, `Session copied to ${targetCwd}`, ctx);
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
