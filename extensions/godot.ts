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
import { existsSync, readFileSync, unlinkSync } from "fs";
import { join } from "path";

const GODOT_BIN =
	"/home/lars/Downloads/Godot_v4.5.1-stable_linux.x86_64/Godot_v4.5.1-stable_linux.x86_64";
const PROJECT_DIR = "/home/lars/workspace/luvlies/godot";

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

			// Clean up previous screenshot
			if (existsSync(screenshotPath)) {
				unlinkSync(screenshotPath);
			}

			// Write a temporary autoload script that captures after N frames
			const autoloadScript = join(PROJECT_DIR, "scripts", "_auto_screenshot.gd");
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
			require("fs").writeFileSync(autoloadScript, gdScript);

			// We need to temporarily add the autoload to project.godot
			const projectFile = join(PROJECT_DIR, "project.godot");
			const originalProject = readFileSync(projectFile, "utf-8");

			let modifiedProject = originalProject;
			if (modifiedProject.includes("[autoload]")) {
				modifiedProject = modifiedProject.replace(
					"[autoload]",
					'[autoload]\n_AutoScreenshot="*res://scripts/_auto_screenshot.gd"'
				);
			} else {
				modifiedProject += '\n[autoload]\n_AutoScreenshot="*res://scripts/_auto_screenshot.gd"\n';
			}
			require("fs").writeFileSync(projectFile, modifiedProject);

			onUpdate?.({
				content: [{ type: "text", text: `Launching Godot (waiting ${waitMs}ms / ${waitFrames} frames)...` }],
			});

			try {
				// Run Godot with a timeout
				const timeout = Math.max(waitMs + 5000, 15000);
				execSync(
					`${GODOT_BIN} --path "${PROJECT_DIR}" --resolution ${width}x${height} 2>&1`,
					{
						timeout,
						encoding: "utf-8",
						env: { ...process.env, DISPLAY: process.env.DISPLAY || ":0" },
					}
				);
			} catch (err: any) {
				// Godot may exit with non-zero after quit(), that's fine
				if (!existsSync(screenshotPath)) {
					// Restore project.godot
					require("fs").writeFileSync(projectFile, originalProject);
					// Clean up autoload script
					if (existsSync(autoloadScript)) unlinkSync(autoloadScript);

					return {
						content: [
							{
								type: "text",
								text: `Failed to capture screenshot. Godot output:\n${err.stdout || err.message}`,
							},
						],
					};
				}
			} finally {
				// Restore original project.godot (remove autoload)
				require("fs").writeFileSync(projectFile, originalProject);
				// Clean up autoload script
				if (existsSync(autoloadScript)) unlinkSync(autoloadScript);
			}

			if (!existsSync(screenshotPath)) {
				return {
					content: [{ type: "text", text: "Screenshot file was not created. Godot may have failed to launch." }],
				};
			}

			// Read the screenshot and return as image
			const imageData = readFileSync(screenshotPath);
			const base64 = imageData.toString("base64");

			return {
				content: [
					{ type: "text", text: `Screenshot captured (${width}x${height}, after ${waitFrames} frames)` },
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
				unlinkSync(outputVideo);
			}

			onUpdate?.({
				content: [{ type: "text", text: `Recording ${duration}s at ${fps}fps...` }],
			});

			try {
				// Use ffmpeg to record the X11 window
				// First start Godot in background
				const godotProcess = spawn(
					GODOT_BIN,
					["--path", PROJECT_DIR, "--resolution", "1280x800"],
					{
						env: { ...process.env, DISPLAY: process.env.DISPLAY || ":0" },
						detached: false,
						stdio: "ignore",
					}
				);

				// Wait for window to appear and get its position
				await new Promise((resolve) => setTimeout(resolve, 2000));
				
				// Get window geometry using xdotool
				let windowInfo = "";
				try {
					windowInfo = execSync(`xdotool search --name "Luvlies" getwindowgeometry | grep Position`, {
						encoding: "utf-8",
					});
				} catch (e) {
					// Fallback if can't find window
					windowInfo = "Position: 0,0";
				}
				
				// Parse position like "Position: 123,456 (screen: 0)"
				const match = windowInfo.match(/Position: (\d+),(\d+)/);
				const xOffset = match ? match[1] : "0";
				const yOffset = match ? match[2] : "0";

				// Record with ffmpeg at the window position
				execSync(
					`ffmpeg -video_size 1280x800 -framerate ${fps} -f x11grab -i :0.0+${xOffset},${yOffset} -t ${duration} -pix_fmt yuv420p -y "${outputVideo}" 2>&1`,
					{
						timeout: (duration + 5) * 1000,
						encoding: "utf-8",
					}
				);

				// Kill Godot
				godotProcess.kill();

				if (!existsSync(outputVideo)) {
					return {
						content: [{ type: "text", text: "Video recording failed - file not created" }],
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
			}
		},
	});
}
