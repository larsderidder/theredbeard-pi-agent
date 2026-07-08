/**
 * Worktree Extension
 *
 * Creates an isolated git worktree and switches the agent's cwd to it.
 *
 * Usage:
 *   /worktree <name> [branch]
 *
 *   <name>    Slug for the worktree directory and branch (e.g. "health-scoring")
 *   [branch]  Optional branch name. Defaults to feat/<name>.
 *              If the branch already exists, checks it out without -b.
 *
 * The worktree is created as a sibling of the repo root:
 *   /path/to/repo/          <- main worktree
 *   /path/to/repo--<name>/  <- new worktree
 *
 * After creation, the agent's cwd is switched to the new worktree.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as path from "node:path";
import * as fs from "node:fs";

export default function worktreeExtension(pi: ExtensionAPI) {
  pi.registerCommand("worktree", {
    description: "Create a git worktree and switch cwd to it. Usage: /worktree <name> [branch]",

    getArgumentCompletions: (_prefix) => null,

    handler: async (args, ctx) => {
      const parts = args.trim().split(/\s+/).filter(Boolean);

      if (parts.length === 0) {
        ctx.ui.notify("Usage: /worktree <name> [branch]", "error");
        return;
      }

      const name = parts[0];
      const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

      if (!slug) {
        ctx.ui.notify("Invalid name. Use lowercase letters, numbers, and hyphens.", "error");
        return;
      }

      // Find repo root from current cwd
      const repoResult = await pi.exec("git", ["rev-parse", "--show-toplevel"], {
        cwd: ctx.cwd,
      });

      if (repoResult.code !== 0) {
        ctx.ui.notify(`Not inside a git repository: ${repoResult.stderr}`, "error");
        return;
      }

      const repoRoot = repoResult.stdout.trim();
      const repoParent = path.dirname(repoRoot);
      const repoName = path.basename(repoRoot);
      const worktreePath = path.join(repoParent, `${repoName}--${slug}`);

      // Determine branch name
      const branchArg = parts[1];
      const branch = branchArg
        ? branchArg.replace(/[^a-zA-Z0-9/_-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "")
        : `feat/${slug}`;

      // Check if worktree path already exists
      if (fs.existsSync(worktreePath)) {
        const ok = await ctx.ui.confirm(
          "Worktree exists",
          `${worktreePath} already exists. Switch cwd to it anyway?`
        );
        if (!ok) return;

        ctx.ui.notify(`Switched cwd to existing worktree: ${worktreePath}`, "info");
        pi.sendMessage(
          {
            customType: "worktree",
            content: `Worktree already existed. Switched cwd to: ${worktreePath}\nBranch: ${branch}\n\nDo your work in this directory.`,
            display: true,
          },
          { triggerTurn: false }
        );
        return;
      }

      // Check if branch already exists
      const branchCheck = await pi.exec(
        "git",
        ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`],
        { cwd: repoRoot }
      );
      const branchExists = branchCheck.code === 0;

      // Detect default branch (main or master)
      const defaultBranchResult = await pi.exec(
        "git",
        ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
        { cwd: repoRoot }
      );
      const defaultBranch = defaultBranchResult.code === 0
        ? defaultBranchResult.stdout.trim().replace(/^origin\//, "")
        : "main";

      // Create the worktree
      ctx.ui.setStatus("worktree", `Creating worktree ${repoName}--${slug}...`);

      let result: { stdout: string; stderr: string; code: number; killed: boolean };

      if (branchExists) {
        result = await pi.exec("git", ["worktree", "add", worktreePath, branch], {
          cwd: repoRoot,
        });
      } else {
        result = await pi.exec(
          "git",
          ["worktree", "add", "-b", branch, worktreePath, defaultBranch],
          { cwd: repoRoot }
        );
      }

      ctx.ui.setStatus("worktree", undefined);

      if (result.code !== 0) {
        ctx.ui.notify(`Failed to create worktree: ${result.stderr}`, "error");
        return;
      }

      ctx.ui.notify(`Worktree ready: ${worktreePath}`, "success");

      // Inject a message so the LLM knows the cwd has changed
      pi.sendMessage(
        {
          customType: "worktree",
          content: [
            `Worktree created. All work must happen in this directory:`,
            `  Path:   ${worktreePath}`,
            `  Branch: ${branch}`,
            ``,
            `Do not touch files in ${repoRoot}. Use ${worktreePath} for all reads, writes, builds, and commits.`,
            `When done: report the branch name, worktree path, and a summary of what was done.`,
          ].join("\n"),
          display: true,
        },
        { triggerTurn: false }
      );
    },
  });
}
