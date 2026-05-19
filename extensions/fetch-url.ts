/**
 * fetch_url tool
 *
 * Fetches a URL or local file path and returns its content as clean Markdown
 * using markitdown. Works for HTML pages, PDFs, DOCX files, and more.
 *
 * This is the right tool to use after web_search when you need to read the
 * actual content of a page or document. Do not use browser_navigate for static
 * content reading, and do not use curl to fetch HTML for reading.
 *
 * For visual-only pages (charts, diagrams, image-based layouts) where this
 * tool returns no useful content, fall back to the screenshot tool instead.
 *
 * For local files (PDFs, DOCX, etc.), pass an absolute file path instead of
 * a URL. Use the read tool for plain text files — this tool is for binary or
 * richly formatted documents that need conversion to Markdown first.
 *
 * Requires: uvx (uv) and markitdown available on PATH.
 * SSL fix: sets REQUESTS_CA_BUNDLE automatically so markitdown works on
 * systems where the uv-managed Python doesn't inherit the system cert store.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { execSync } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";

const execFileAsync = promisify(execFile);

const MAX_OUTPUT_CHARS = 80_000;

export default function fetchUrlExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "fetch_url",
    label: "Fetch URL",
    description:
      "Fetch a URL or local file path and return its content as clean Markdown. " +
      "Use this after web_search to read the full content of a page. Works for HTML, PDFs, DOCX, and more. " +
      "For local files (PDF, DOCX, etc.), pass an absolute file path instead of a URL — use the read tool for plain text files. " +
      "Do NOT use browser_navigate or curl for reading static content — use this instead. " +
      "Google Drive file URLs (drive.google.com/file/d/...) are handled automatically via gdrive_read. " +
      "If this returns no useful content (visual-only page, image-heavy layout), fall back to the screenshot tool.",
    promptSnippet: "Fetch a URL or local file path and return its content as Markdown (HTML, PDF, DOCX, etc.)",
    parameters: Type.Object({
      url: Type.String({
        description: "The URL to fetch, or an absolute local file path for PDFs, DOCX files, and other formatted documents.",
      }),
    }),

    async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
      const env = {
        ...process.env,
        // markitdown uses requests under the hood; uv-managed Python often
        // doesn't pick up the system cert store automatically.
        REQUESTS_CA_BUNDLE: process.env.REQUESTS_CA_BUNDLE ?? "/etc/ssl/certs/ca-certificates.crt",
      };

      // Detect Google Drive file URLs and route to gdrive_read instead
      const driveMatch = params.url.match(
        /drive\.google\.com\/(?:file\/d\/|open\?id=|uc\?.*id=)([a-zA-Z0-9_-]{10,})/
      );
      if (driveMatch) {
        const fileId = driveMatch[1];
        try {
          const script = [
            "import sys, json",
            `sys.path.insert(0, '/home/lars/workspace/recall')`,
            "import gdrive",
            `result = gdrive.read_file('${fileId}')`,
            "print(json.dumps(result))",
          ].join("\n");
          const raw = execSync(`/usr/bin/python3 -c "${script.replace(/"/g, '\\"')}"`, { timeout: 30_000 }).toString();
          const data = JSON.parse(raw);
          const header = `=== ${data.name} (${data.mimeType}) ===${data.truncated ? " [truncated]" : ""}\n\n`;
          return {
            content: [{ type: "text", text: header + (data.content || "[empty]") }],
            details: { url: params.url, fileId, source: "gdrive" },
          };
        } catch (e) {
          // fall through to markitdown if gdrive read fails
        }
      }

      let stdout: string;
      let stderr: string;

      try {
        ({ stdout, stderr } = await execFileAsync("uvx", ["--from", "markitdown[pdf]", "markitdown", params.url], {
          env,
          timeout: 30_000,
          maxBuffer: MAX_OUTPUT_CHARS * 4,
          signal: signal ?? undefined,
        }));
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`fetch_url failed for ${params.url}: ${msg}`);
      }

      if (stderr && !stdout) {
        throw new Error(`markitdown returned no output for ${params.url}. stderr: ${stderr.slice(0, 500)}`);
      }

      const content = stdout.trim();
      const truncated = content.length > MAX_OUTPUT_CHARS;
      const output = truncated ? content.slice(0, MAX_OUTPUT_CHARS) + "\n\n[...output truncated]" : content;

      return {
        content: [{ type: "text", text: output }],
        details: { url: params.url, truncated, length: content.length },
      };
    },
  });
}
