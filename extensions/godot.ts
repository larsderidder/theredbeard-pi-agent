/**
 * Godot Extension - Run Godot project and capture screenshots
 *
 * Provides tools to:
 * - Run the Godot project and capture a screenshot after N frames
 * - Run headless Godot scripts (e.g., scene builders)
 * - Build scenes via the build_scenes.gd tool script
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { execSync, spawn } from "child_process";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "fs";
import { join } from "path";
import sharp from "sharp";

const MAX_DIMENSION = 2000;

const GODOT_BIN =
	"/home/lars/.local/bin/godot";
const PROJECT_DIR = process.env.GODOT_PROJECT_DIR || process.cwd() + "/godot";

/** Kill any lingering Godot processes from previous screenshot runs. */
function killStaleGodot(): void {
	try {
		execSync(`pkill -f "${GODOT_BIN}.*--path.*${PROJECT_DIR}" 2>/dev/null || true`, {
			timeout: 3000,
			encoding: "utf-8",
		});
	} catch {
		// best effort
	}
}

/** Restore project.godot and clean up the autoload script. Always safe to call. */
function cleanupScreenshotArtifacts(
	projectFile: string,
	originalProject: string,
	autoloadScript: string,
	screenshotPath: string,
): void {
	try { writeFileSync(projectFile, originalProject); } catch { /* best effort */ }
	try { if (existsSync(autoloadScript)) unlinkSync(autoloadScript); } catch { /* best effort */ }
	try { if (existsSync(screenshotPath)) unlinkSync(screenshotPath); } catch { /* best effort */ }
}

export default function (pi: ExtensionAPI) {
	// Tool: Capture a screenshot of the running game
	pi.registerTool({
		name: "godot_screenshot",
		label: "Godot Screenshot",
		description:
			"Run the Godot project for a few seconds and capture a screenshot. Returns the screenshot as an image. Use this to see how the game looks after making changes.",
		parameters: Type.Object({
			wait_ms: Type.Optional(
				Type.Number({
					description: "Milliseconds to wait before capturing (default: 2000)",
				})
			),
			width: Type.Optional(
				Type.Number({
					description: "Window width (default: 1280)",
				})
			),
			height: Type.Optional(
				Type.Number({
					description: "Window height (default: 800)",
				})
			),
		}),

		async execute(_toolCallId, params, signal, onUpdate, _ctx) {
			const waitMs = params.wait_ms ?? 2000;
			const width = params.width ?? 1280;
			const height = params.height ?? 800;
			const screenshotPath = join(PROJECT_DIR, "screenshot_auto.png");
			const projectFile = join(PROJECT_DIR, "project.godot");
			const scriptsDir = join(PROJECT_DIR, "scripts");
			const autoloadScript = join(scriptsDir, "_auto_screenshot.gd");

			// Validate project exists
			if (!existsSync(projectFile)) {
				return {
					content: [{ type: "text", text: `project.godot not found at ${projectFile}. Is GODOT_PROJECT_DIR set correctly?` }],
					isError: true,
				};
			}

			// Validate Godot binary exists
			if (!existsSync(GODOT_BIN)) {
				return {
					content: [{ type: "text", text: `Godot binary not found at ${GODOT_BIN}.` }],
					isError: true,
				};
			}

			// Kill any stale Godot from a previous failed run
			killStaleGodot();

			// Clean up previous screenshot
			if (existsSync(screenshotPath)) {
				unlinkSync(screenshotPath);
			}

			// Ensure scripts directory exists
			if (!existsSync(scriptsDir)) {
				mkdirSync(scriptsDir, { recursive: true });
			}

			// Read original project before any modifications
			const originalProject = readFileSync(projectFile, "utf-8");

			// Write a temporary autoload script that captures after N frames
			const waitFrames = Math.max(5, Math.ceil((waitMs / 1000) * 60)); // assume ~60fps
			const gdScript = `extends Node

var _frame := 0

func _process(_delta: float) -> void:
	_frame += 1
	if _frame == ${waitFrames}:
		var img = get_viewport().get_texture().get_image()
		img.save_png("res://screenshot_auto.png")
		print("SCREENSHOT_CAPTURED")
		get_tree().quit()
`;
			writeFileSync(autoloadScript, gdScript);

			// Add autoload to project.godot
			let modifiedProject = originalProject;
			if (modifiedProject.includes("[autoload]")) {
				modifiedProject = modifiedProject.replace(
					"[autoload]",
					'[autoload]\n_AutoScreenshot="*res://scripts/_auto_screenshot.gd"'
				);
			} else {
				modifiedProject += '\n[autoload]\n_AutoScreenshot="*res://scripts/_auto_screenshot.gd"\n';
			}
			writeFileSync(projectFile, modifiedProject);

			onUpdate?.({
				content: [{ type: "text", text: `Launching Godot (waiting ${waitMs}ms / ${waitFrames} frames)...` }],
			});

			let godotOutput = "";

			try {
				// Run Godot with a timeout (generous: waitMs + 10s, minimum 15s)
				const timeout = Math.max(waitMs + 10000, 15000);
				godotOutput = execSync(
					`${GODOT_BIN} --path "${PROJECT_DIR}" --resolution ${width}x${height} 2>&1`,
					{
						timeout,
						encoding: "utf-8",
						env: { ...process.env, DISPLAY: process.env.DISPLAY || ":0" },
					}
				);
			} catch (err: any) {
				// Godot exits with non-zero after quit(), that's expected.
				// Capture whatever output we got for diagnostics.
				godotOutput = err.stdout || err.stderr || err.message || "";

				if (!existsSync(screenshotPath)) {
					cleanupScreenshotArtifacts(projectFile, originalProject, autoloadScript, screenshotPath);

					// Try to extract useful error info
					const errorLines = godotOutput
						.split("\n")
						.filter((l: string) => /error|fatal|exception|cannot|failed/i.test(l))
						.slice(0, 10)
						.join("\n");

					return {
						content: [
							{
								type: "text",
								text: `Failed to capture screenshot.\n${errorLines ? "Errors:\n" + errorLines : "Godot output:\n" + godotOutput.slice(0, 2000)}`,
							},
						],
						isError: true,
					};
				}
			} finally {
				// Always restore original project.godot and clean up autoload script
				writeFileSync(projectFile, originalProject);
				try { if (existsSync(autoloadScript)) unlinkSync(autoloadScript); } catch { /* best effort */ }
			}

			if (!existsSync(screenshotPath)) {
				return {
					content: [{ type: "text", text: "Screenshot file was not created. Godot may have crashed or the main scene failed to load." }],
					isError: true,
				};
			}

			// Read the screenshot, resize if needed for API limits
			let imgBuffer: Buffer = readFileSync(screenshotPath);

			// Clean up the screenshot file now that we have it in memory
			try { unlinkSync(screenshotPath); } catch { /* best effort */ }

			let imgW: number;
			let imgH: number;
			let needsResize: boolean;

			try {
				const metadata = await sharp(imgBuffer).metadata();
				imgW = metadata.width ?? 0;
				imgH = metadata.height ?? 0;
				needsResize = imgW > MAX_DIMENSION || imgH > MAX_DIMENSION;
			} catch {
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
					{ type: "text", text: `Screenshot captured (${imgW}x${imgH}${imgW !== finalW ? ` resized to ${finalW}x${finalH} for API` : ""}, after ${waitFrames} frames)` },
					{ type: "image", data: base64, mimeType: "image/png" },
				],
			};
		},
	});

	// Tool: Run a headless Godot script
	pi.registerTool({
		name: "godot_run_script",
		label: "Godot Run Script",
		description:
			"Run a GDScript tool script in headless mode (no window). Use for scene generation, asset importing, etc.",
		parameters: Type.Object({
			script: Type.String({
				description: 'Script path relative to the Godot project (e.g., "res://scripts/build_scenes.gd")',
			}),
		}),

		async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
			try {
				// First do an import pass to ensure all assets are registered
				execSync(`${GODOT_BIN} --headless --import --path "${PROJECT_DIR}" 2>&1`, {
					timeout: 30000,
					encoding: "utf-8",
				});

				const output = execSync(
					`${GODOT_BIN} --headless --script ${params.script} --path "${PROJECT_DIR}" 2>&1`,
					{
						timeout: 30000,
						encoding: "utf-8",
					}
				);

				return {
					content: [{ type: "text", text: output }],
				};
			} catch (err: any) {
				return {
					content: [{ type: "text", text: `Script failed:\n${err.stdout || err.stderr || err.message}` }],
					isError: true,
				};
			}
		},
	});

	// Tool: Build scenes (shorthand)
	pi.registerTool({
		name: "godot_build_scenes",
		label: "Godot Build Scenes",
		description:
			"Run the build_scenes.gd script to regenerate .tscn scene files. Run this after modifying build_scenes.gd or adding new assets.",
		parameters: Type.Object({}),

		async execute(_toolCallId, _params, signal, onUpdate, _ctx) {
			onUpdate?.({
				content: [{ type: "text", text: "Importing assets..." }],
			});

			try {
				// Import pass
				execSync(`${GODOT_BIN} --headless --import --path "${PROJECT_DIR}" 2>&1`, {
					timeout: 30000,
					encoding: "utf-8",
				});

				onUpdate?.({
					content: [{ type: "text", text: "Building scenes..." }],
				});

				// Build scenes
				const output = execSync(
					`${GODOT_BIN} --headless --script res://scripts/build_scenes.gd --path "${PROJECT_DIR}" 2>&1`,
					{
						timeout: 30000,
						encoding: "utf-8",
					}
				);

				const success = output.includes("SUCCESS");
				return {
					content: [{ type: "text", text: success ? "Scenes built successfully.\n" + output : "Build output:\n" + output }],
				};
			} catch (err: any) {
				return {
					content: [{ type: "text", text: `Build failed:\n${err.stdout || err.stderr || err.message}` }],
					isError: true,
				};
			}
		},
	});

	// Tool: Record video
	pi.registerTool({
		name: "godot_record_video",
		label: "Godot Record Video",
		description:
			"Record a video of the Godot project running. Returns path to the video file (MP4). Use this to see animations and movement over time.",
		parameters: Type.Object({
			duration_sec: Type.Optional(
				Type.Number({
					description: "Duration to record in seconds (default: 10)",
				})
			),
			fps: Type.Optional(
				Type.Number({
					description: "Frames per second (default: 30)",
				})
			),
		}),

		async execute(_toolCallId, params, signal, onUpdate, _ctx) {
			const duration = params.duration_sec ?? 10;
			const fps = params.fps ?? 30;
			const outputVideo = join(PROJECT_DIR, "gameplay_video.mp4");

			// Clean up previous video
			if (existsSync(outputVideo)) {
				try { unlinkSync(outputVideo); } catch { /* best effort */ }
			}

			// Kill stale Godot from previous runs
			killStaleGodot();

			// Read project name for xdotool window search
			const projectFile = join(PROJECT_DIR, "project.godot");
			let windowName = "Godot";
			try {
				const projContent = readFileSync(projectFile, "utf-8");
				const nameMatch = projContent.match(/config\/name="([^"]+)"/);
				if (nameMatch) windowName = nameMatch[1];
			} catch { /* use default */ }

			onUpdate?.({
				content: [{ type: "text", text: `Recording ${duration}s at ${fps}fps...` }],
			});

			let godotProcess: ReturnType<typeof spawn> | null = null;

			try {
				// Start Godot in background
				godotProcess = spawn(
					GODOT_BIN,
					["--path", PROJECT_DIR, "--resolution", "1280x800"],
					{
						env: { ...process.env, DISPLAY: process.env.DISPLAY || ":0" },
						detached: false,
						stdio: "ignore",
					}
				);

				// Wait for window to appear, polling with xdotool
				let windowId = "";
				const maxRetries = 20;
				for (let i = 0; i < maxRetries; i++) {
					await new Promise((resolve) => setTimeout(resolve, 500));
					try {
						windowId = execSync(
							`xdotool search --name "${windowName}" 2>/dev/null | head -1`,
							{ encoding: "utf-8", timeout: 3000 }
						).trim();
						if (windowId) break;
					} catch { /* keep trying */ }
				}

				if (!windowId) {
					throw new Error(`Godot window "${windowName}" did not appear after ${maxRetries * 500}ms`);
				}

				// Get window geometry
				let xOffset = "0";
				let yOffset = "0";
				try {
					const geom = execSync(`xdotool getwindowgeometry ${windowId}`, {
						encoding: "utf-8",
						timeout: 3000,
					});
					const match = geom.match(/Position: (\d+),(\d+)/);
					if (match) {
						xOffset = match[1];
						yOffset = match[2];
					}
				} catch { /* fallback to 0,0 */ }

				// Record with ffmpeg at the window position
				execSync(
					`ffmpeg -video_size 1280x800 -framerate ${fps} -f x11grab -i :0.0+${xOffset},${yOffset} -t ${duration} -pix_fmt yuv420p -y "${outputVideo}" 2>&1`,
					{
						timeout: (duration + 10) * 1000,
						encoding: "utf-8",
					}
				);

				if (!existsSync(outputVideo)) {
					return {
						content: [{ type: "text", text: "Video recording failed: output file was not created." }],
						isError: true,
					};
				}

				const stats = require("fs").statSync(outputVideo);
				return {
					content: [
						{
							type: "text",
							text: `Video recorded: ${outputVideo} (${(stats.size / 1024 / 1024).toFixed(2)} MB, ${duration}s)`,
						},
					],
				};
			} catch (err: any) {
				return {
					content: [{ type: "text", text: `Recording failed:\n${err.stdout || err.stderr || err.message}` }],
					isError: true,
				};
			} finally {
				// Always kill Godot, even if ffmpeg fails
				if (godotProcess && !godotProcess.killed) {
					godotProcess.kill();
				}
			}
		},
	});
}
