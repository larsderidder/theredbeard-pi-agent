/**
 * convert_local_document tool
 *
 * Converts a local rich document to clean Markdown using markitdown.
 * Remote URLs are intentionally not supported. Use argus_extract for web pages
 * and remote documents so URL fetching goes through Argus SSRF protections.
 *
 * For plain text files, use the read tool instead.
 *
 * Requires: uvx (uv) and markitdown available on PATH.
 * SSL fix: sets REQUESTS_CA_BUNDLE automatically so markitdown works on
 * systems where the uv-managed Python doesn't inherit the system cert store.
 */

import { execFile } from "node:child_process";
import { existsSync, realpathSync, statSync } from "node:fs";
import { basename, isAbsolute, sep } from "node:path";
import { promisify } from "node:util";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";

const execFileAsync = promisify(execFile);

const MAX_OUTPUT_CHARS = 80_000;
const MAX_INPUT_BYTES = 50 * 1024 * 1024;

const DENIED_PATH_PREFIXES = [
  "/etc",
  "/proc",
  "/sys",
  "/dev",
  "/run",
  `${process.env.HOME ?? ""}/.ssh`,
  `${process.env.HOME ?? ""}/.gnupg`,
  `${process.env.HOME ?? ""}/.kube`,
  `${process.env.HOME ?? ""}/.aws`,
  `${process.env.HOME ?? ""}/.config/gcloud`,
  `${process.env.HOME ?? ""}/.mozilla`,
  `${process.env.HOME ?? ""}/.config/chromium`,
  `${process.env.HOME ?? ""}/.config/google-chrome`,
  `${process.env.HOME ?? ""}/.pi/agent/sessions`,
].filter(Boolean);

const DENIED_BASENAME_PATTERNS = [
  /^\.env(?:\.|$)/i,
  /(?:^|[._-])secret(?:[._-]|$)/i,
  /(?:^|[._-])token(?:[._-]|$)/i,
  /(?:^|[._-])credential(?:s)?(?:[._-]|$)/i,
  /(?:^|[._-])private(?:[._-]|$)/i,
  /\.pem$/i,
  /\.key$/i,
  /id_rsa$/i,
  /id_ed25519$/i,
];

function isUrlLike(input: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(input);
}

function isDeniedPrefix(filePath: string): boolean {
  return DENIED_PATH_PREFIXES.some((prefix) => filePath === prefix || filePath.startsWith(`${prefix}${sep}`));
}

function assertSafeLocalDocumentPath(filePath: string): string {
  if (isUrlLike(filePath)) {
    throw new Error("convert_local_document only accepts absolute local file paths. Use argus_extract for URLs.");
  }

  if (!isAbsolute(filePath)) {
    throw new Error("convert_local_document requires an absolute local file path.");
  }

  if (!existsSync(filePath)) {
    throw new Error(`File does not exist: ${filePath}`);
  }

  const realPath = realpathSync(filePath);
  const stats = statSync(realPath);
  if (!stats.isFile()) {
    throw new Error(`Path is not a file: ${filePath}`);
  }

  if (stats.size > MAX_INPUT_BYTES) {
    throw new Error(`File is too large for conversion: ${stats.size} bytes. Limit is ${MAX_INPUT_BYTES} bytes.`);
  }

  if (isDeniedPrefix(realPath)) {
    throw new Error(`Refusing to convert a file from a sensitive path: ${realPath}`);
  }

  const name = basename(realPath);
  if (DENIED_BASENAME_PATTERNS.some((pattern) => pattern.test(name))) {
    throw new Error(`Refusing to convert a likely sensitive file: ${name}`);
  }

  return realPath;
}

export default function convertLocalDocumentExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "convert_local_document",
    label: "Convert Local Document",
    description:
      "Convert a local rich document to clean Markdown. Only accepts absolute local file paths. " +
      "Remote URLs are intentionally rejected. Use argus_extract for web pages and remote documents, and use read for plain text files.",
    promptSnippet:
      "Convert a local PDF, DOCX, XLSX, PPTX, HTML, or other rich document to Markdown. Only for absolute local file paths. Use argus_extract for URLs.",
    parameters: Type.Object({
      path: Type.String({
        description: "Absolute local file path for a PDF, DOCX, XLSX, PPTX, HTML, or other rich document. URLs are rejected.",
      }),
    }),

    async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
      const filePath = assertSafeLocalDocumentPath(params.path);
      const env = {
        ...process.env,
        // markitdown uses requests under the hood. uv-managed Python often
        // does not pick up the system cert store automatically.
        REQUESTS_CA_BUNDLE: process.env.REQUESTS_CA_BUNDLE ?? "/etc/ssl/certs/ca-certificates.crt",
      };

      let stdout: string;
      let stderr: string;

      try {
        ({ stdout, stderr } = await execFileAsync("uvx", ["--from", "markitdown[pdf]", "markitdown", filePath], {
          env,
          timeout: 30_000,
          maxBuffer: MAX_OUTPUT_CHARS * 4,
          signal: signal ?? undefined,
        }));
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`convert_local_document failed for ${filePath}: ${msg}`);
      }

      if (stderr && !stdout) {
        throw new Error(`markitdown returned no output for ${filePath}. stderr: ${stderr.slice(0, 500)}`);
      }

      const content = stdout.trim();
      const truncated = content.length > MAX_OUTPUT_CHARS;
      const output = truncated ? `${content.slice(0, MAX_OUTPUT_CHARS)}\n\n[...output truncated]` : content;

      return {
        content: [{ type: "text", text: output }],
        details: { path: filePath, truncated, length: content.length },
      };
    },
  });
}
