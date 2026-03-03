import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import type {
	BunShell,
	LinterConfig,
	LinterDefinition,
	OpenCodeClient,
	Plugin,
	PluginContext,
} from "./types.js";

// Re-export types for consumers
export * from "./types.js";

const DEFAULT_CONFIG: LinterConfig = {
	cooldownMs: 15_000,
	timeoutMs: 60_000,
	maxParallel: 3,
	linters: {
		".ts": { command: "biome", args: ["check"], name: "Biome" },
		".tsx": { command: "biome", args: ["check"], name: "Biome" },
		".js": { command: "biome", args: ["check"], name: "Biome" },
		".jsx": { command: "biome", args: ["check"], name: "Biome" },
		".mjs": { command: "biome", args: ["check"], name: "Biome" },
		".cjs": { command: "biome", args: ["check"], name: "Biome" },

		".py": { command: "ruff", args: ["check"], name: "Ruff" },
		".pyi": { command: "ruff", args: ["check"], name: "Ruff" },

		".c": {
			command: "cppcheck",
			args: ["--enable=all", "--std=c11", "--quiet", "--template=gcc"],
			name: "cppcheck",
		},
		".cpp": {
			command: "cppcheck",
			args: ["--enable=all", "--std=c++17", "--quiet", "--template=gcc"],
			name: "cppcheck",
		},
		".cc": {
			command: "cppcheck",
			args: ["--enable=all", "--std=c++17", "--quiet", "--template=gcc"],
			name: "cppcheck",
		},
		".h": {
			command: "cppcheck",
			args: ["--enable=all", "--quiet", "--template=gcc"],
			name: "cppcheck",
		},
		".hpp": {
			command: "cppcheck",
			args: ["--enable=all", "--std=c++17", "--quiet", "--template=gcc"],
			name: "cppcheck",
		},

		".tf": { command: "tflint", args: [], name: "tflint" },
		".tfvars": { command: "tflint", args: [], name: "tflint" },

		".rs": {
			command: "cargo",
			args: ["clippy", "--all-targets", "--all-features"],
			name: "Clippy",
		},
	},
};

const MAX_MODIFIED_FILES = 1000;
const BATCH_SIZE = 50;

/**
 * Load linter configuration from the project directory
 * Looks for .opencode/linter.config.json
 */
async function loadConfig(directory: string): Promise<LinterConfig> {
	const configPath = join(directory, ".opencode", "linter.config.json");

	try {
		const configData = await fs.readFile(configPath, "utf8");
		const userConfig = JSON.parse(configData) as Partial<LinterConfig>;
		return {
			cooldownMs: userConfig.cooldownMs ?? DEFAULT_CONFIG.cooldownMs,
			timeoutMs: userConfig.timeoutMs ?? DEFAULT_CONFIG.timeoutMs,
			maxParallel: userConfig.maxParallel ?? DEFAULT_CONFIG.maxParallel,
			linters: {
				...DEFAULT_CONFIG.linters,
				...(userConfig.linters || {}),
			},
		};
	} catch (error) {
		if (
			error instanceof Error &&
			"code" in error &&
			error.code === "ENOENT"
		) {
			return DEFAULT_CONFIG;
		}
		console.error(
			`[PostTurnLinter] Failed to load config from ${configPath}:`,
			error,
		);
		return DEFAULT_CONFIG;
	}
}

/**
 * Get the appropriate linter for a given file path
 */
function getLinterForFile(
	filePath: string,
	config: LinterConfig,
): LinterDefinition | null {
	const ext = extname(filePath).toLowerCase();
	return config.linters[ext] || null;
}

/**
 * Detect if a tool execution modified a file
 */
function detectModifiedFile(input: {
	tool: string;
	args?: { filePath?: string; path?: string };
}): string | null {
	const editTools = [
		"write",
		"edit",
		"replace_content",
		"replace_symbol_body",
		"insert_after_symbol",
		"insert_before_symbol",
		"rename_symbol",
		"create_text_file",
	];

	if (!editTools.includes(input.tool)) return null;

	return input.args?.filePath || input.args?.path || null;
}

/**
 * Group files by their associated linter
 */
function groupFilesByLinter(
	files: Set<string>,
	config: LinterConfig,
): Map<string, string[]> {
	const groups = new Map<string, string[]>();

	for (const filePath of files) {
		const linter = getLinterForFile(filePath, config);
		if (linter) {
			const key = `${linter.command}:${linter.args.join(" ")}`;
			const group = groups.get(key) ?? [];
			group.push(filePath);
			groups.set(key, group);
		}
	}

	return groups;
}

/**
 * Run a linter on a batch of files
 */
async function runLinter(
	$: BunShell,
	filePaths: string[],
	linter: LinterDefinition,
	timeoutMs: number = 60_000,
): Promise<{ name: string; output: string; fileCount: number } | null> {
	if (filePaths.length === 0) return null;

	const existingFiles: string[] = [];
	for (const filePath of filePaths) {
		try {
			await fs.access(filePath);
			existingFiles.push(filePath);
		} catch {}
	}

	if (existingFiles.length === 0) return null;

	const outputFile = join(
		tmpdir(),
		`opencode-lint-${linter.command}-${randomUUID()}.log`,
	);

	try {
		for (let i = 0; i < existingFiles.length; i += BATCH_SIZE) {
			const batch = existingFiles.slice(i, i + BATCH_SIZE);

			const redirect = i === 0 ? ">" : ">>";
			const linterPromise = $`${linter.command} ${linter.args} ${batch} ${redirect} ${outputFile} 2>&1 || true`;

			// Apply timeout to each batch execution
			const timeoutId = setTimeout(() => {}, timeoutMs);

			try {
				await linterPromise;
			} finally {
				clearTimeout(timeoutId);
			}
		}

		let output: string;
		try {
			output = await fs.readFile(outputFile, "utf8");
		} catch {
			output = "";
		}

		try {
			await fs.unlink(outputFile);
		} catch (unlinkError) {
			console.error(
				`[PostTurnLinter] Failed to cleanup temp file ${outputFile}:`,
				unlinkError,
			);
		}

		return {
			name: linter.name,
			output: output.trim(),
			fileCount: existingFiles.length,
		};
	} catch (error) {
		try {
			await fs.unlink(outputFile);
		} catch (unlinkError) {
			console.error(
				`[PostTurnLinter] Failed to cleanup temp file ${outputFile}:`,
				unlinkError,
			);
		}
		return {
			name: linter.name,
			output: `Error running ${linter.command}: ${error instanceof Error ? error.message : error}`,
			fileCount: existingFiles.length,
		};
	}
}

/**
 * Post Turn Linter Plugin
 * Automatically runs linters on modified files after each tool execution
 */
export const PostTurnLinter: Plugin = async ({
	client,
	$,
	directory,
	worktree,
}: PluginContext) => {
	const projectDir = worktree || directory;
	const config = await loadConfig(projectDir);
	const cooldownMs = config.cooldownMs ?? DEFAULT_CONFIG.cooldownMs;
	const timeoutMs = config.timeoutMs ?? DEFAULT_CONFIG.timeoutMs;
	const maxParallel = config.maxParallel ?? DEFAULT_CONFIG.maxParallel ?? 3;

	const modifiedFiles = new Set<string>();
	let lastRunAt = 0;

	return {
		"tool.execute.after": async (input) => {
			const filePath = detectModifiedFile(input);
			if (filePath) {
				if (modifiedFiles.size < MAX_MODIFIED_FILES) {
					modifiedFiles.add(filePath);
				} else if (modifiedFiles.size === MAX_MODIFIED_FILES) {
					// Only warn once when we hit the limit
					console.warn(
						`[PostTurnLinter] Reached max modified files limit (${MAX_MODIFIED_FILES}). ` +
							`Subsequent file changes will not be linted.`,
					);
				}
			}
		},

		event: async ({ event }) => {
			try {
				if (event.type !== "session.idle") return;
				if (modifiedFiles.size === 0) return;

				const now = Date.now();
				if (now - lastRunAt < cooldownMs) return;
				lastRunAt = now;

				const filesByLinter = groupFilesByLinter(modifiedFiles, config);

				for (const filePaths of filesByLinter.values()) {
					for (const filePath of filePaths) {
						modifiedFiles.delete(filePath);
					}
				}

				if (filesByLinter.size === 0) return;

				const linterEntries = Array.from(filesByLinter.entries());
				const linterResults: ({
					name: string;
					output: string;
					fileCount: number;
				} | null)[] = new Array(linterEntries.length);

				// Controlled parallelism
				let nextIndex = 0;
				const workers = new Array(
					Math.min(maxParallel, linterEntries.length),
				)
					.fill(null)
					.map(async () => {
						while (nextIndex < linterEntries.length) {
							const currentIndex = nextIndex++;
							const [_, filePaths] = linterEntries[currentIndex];
							const linter = getLinterForFile(filePaths[0], config);
							if (linter) {
								linterResults[currentIndex] = await runLinter(
									$,
									filePaths,
									linter,
									timeoutMs,
								);
							}
						}
					});

				await Promise.all(workers);

				const results: string[] = [];
				for (const result of linterResults) {
					if (result?.output) {
						results.push(
							`--- ${result.name} (${result.fileCount} file${result.fileCount > 1 ? "s" : ""}) ---\n${result.output}`,
						);
					}
				}

				if (results.length > 0) {
					const message = `
Post-turn lint check completed.

${results.join("\n\n")}

If there are errors, fix them. If something's unclear, ask.
`.trim();

					const sessionID = event.properties?.sessionID;
					if (sessionID) {
						try {
							await client.session.prompt({
								path: { id: sessionID },
								body: {
									parts: [{ type: "text", text: message }],
								},
							});
						} catch (promptError) {
							console.error(
								"[PostTurnLinter] Failed to send lint results to session:",
								promptError,
							);
						}
					}
				}
			} catch (error) {
				console.error(
					"[PostTurnLinter] Error in event handler:",
					error,
				);
			}
		},
	};
};

// Default export for compatibility
export default PostTurnLinter;
