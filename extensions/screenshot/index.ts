/**
 * Screenshot tool for pi: captures a webpage using Puppeteer.
 *
 * Returns the screenshot as a base64 image (visible to the LLM)
 * and saves it to disk.
 *
 * Install globally: ~/.pi/agent/extensions/screenshot/
 */

import { Type } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import puppeteer from "puppeteer";
import sharp from "sharp";
import * as path from "node:path";
import * as fs from "node:fs";

const MAX_DIMENSION = 2000;

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "screenshot",
		label: "Screenshot",
		description:
			"Take a screenshot of a webpage at the given URL. Returns the image so you can see it. Also saves to disk at the specified output path.",
		parameters: Type.Object({
			url: Type.String({ description: "URL to screenshot" }),
			output: Type.String({
				description: "File path to save the PNG screenshot",
			}),
			width: Type.Optional(
				Type.Number({
					description: "Viewport width in pixels (default: 1280)",
				})
			),
			height: Type.Optional(
				Type.Number({
					description: "Viewport height in pixels (default: 900)",
				})
			),
			waitMs: Type.Optional(
				Type.Number({
					description:
						"Milliseconds to wait after load before capturing (default: 3000)",
				})
			),
			fullPage: Type.Optional(
				Type.Boolean({
					description:
						"Capture the full scrollable page, not just the viewport (default: false)",
				})
			),
		}),

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const {
				url,
				output: outputPath,
				width = 1280,
				height = 900,
				waitMs = 3000,
				fullPage = false,
			} = params as {
				url: string;
				output: string;
				width?: number;
				height?: number;
				waitMs?: number;
				fullPage?: boolean;
			};

			const resolvedPath = path.isAbsolute(outputPath)
				? outputPath
				: path.resolve(ctx.cwd, outputPath);

			const dir = path.dirname(resolvedPath);
			if (!fs.existsSync(dir)) {
				fs.mkdirSync(dir, { recursive: true });
			}

			let browser;
			try {
				browser = await puppeteer.launch({
					headless: true,
					args: [
						"--no-sandbox",
						"--disable-setuid-sandbox",
						"--disable-gpu",
					],
				});

				const page = await browser.newPage();
				await page.setViewport({ width, height });
				await page.goto(url, {
					waitUntil: "networkidle2",
					timeout: 30000,
				});

				if (waitMs > 0) {
					await new Promise((resolve) => setTimeout(resolve, waitMs));
				}

				const screenshotBuffer = await page.screenshot({
					path: resolvedPath,
					fullPage,
					type: "png",
				});

				// Always resize to fit within MAX_DIMENSION on both axes.
				// Use sharp to read actual dimensions; if that fails,
				// resize unconditionally so oversized full-page captures
				// never reach the API.
				let imgBuffer = Buffer.from(screenshotBuffer);
				let imgW: number;
				let imgH: number;
				let needsResize: boolean;

				try {
					const metadata = await sharp(imgBuffer).metadata();
					imgW = metadata.width ?? 0;
					imgH = metadata.height ?? 0;
					needsResize = imgW > MAX_DIMENSION || imgH > MAX_DIMENSION;
				} catch {
					// Cannot read dimensions; force a resize to be safe.
					imgW = 0;
					imgH = 0;
					needsResize = true;
				}

				let finalW = imgW;
				let finalH = imgH;

				if (needsResize) {
					imgBuffer = await sharp(imgBuffer)
						.resize(MAX_DIMENSION, MAX_DIMENSION, { fit: "inside", withoutEnlargement: true })
						.png()
						.toBuffer();
					const resizedMeta = await sharp(imgBuffer).metadata();
					finalW = resizedMeta.width ?? MAX_DIMENSION;
					finalH = resizedMeta.height ?? MAX_DIMENSION;
				}

				const base64 = imgBuffer.toString("base64");

				return {
					content: [
						{
							type: "image",
							mimeType: "image/png",
							data: base64,
						},
						{
							type: "text",
							text: `Screenshot saved to ${resolvedPath} (${imgW}x${imgH}${imgW !== finalW ? ` → resized to ${finalW}x${finalH} for API` : ""}${fullPage ? ", full page" : ""})`,
						},
					],
					details: { path: resolvedPath, width: imgW, height: imgH, fullPage },
				};
			} catch (error: any) {
				return {
					content: [
						{
							type: "text",
							text: `Screenshot failed: ${error.message}`,
						},
					],
					details: { error: error.message },
					isError: true,
				};
			} finally {
				if (browser) {
					await browser.close();
				}
			}
		},
	});
}
