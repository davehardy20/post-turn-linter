import { promises as fs } from "node:fs";
import { extname, join } from "node:path";
import type {
	LinterConfig,
	LinterDefinition,
	Plugin,
	PluginContext,
} from "./types.js";

// Re-export types for consumers
export * from "./types.js";

const DEFAULT_CONFIG: LinterConfig = {
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

		".sh": {
			command: "/opt/homebrew/bin/shellcheck",
			args: [],
			name: "ShellCheck",
		},
		".bash": {
			command: "/opt/homebrew/bin/shellcheck",
			args: [],
			name: "ShellCheck",
		},
		".zsh": {
			command: "/opt/homebrew/bin/shellcheck",
			args: [],
			name: "ShellCheck",
		},
		".ksh": {
			command: "/opt/homebrew/bin/shellcheck",
			args: [],
			name: "ShellCheck",
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
			timeoutMs: userConfig.timeoutMs ?? DEFAULT_CONFIG.timeoutMs,
			maxParallel: userConfig.maxParallel ?? DEFAULT_CONFIG.maxParallel,
			linters: {
				...DEFAULT_CONFIG.linters,
				...(userConfig.linters || {}),
			},
		};
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") {
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
 * Handles both direct file edits and bash commands that modify files
 */
function detectModifiedFile(input: {
	tool: string;
	args?: { filePath?: string; path?: string; command?: string };
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

	// Handle bash commands that modify files
	if (input.tool === "bash" && input.args?.command) {
		const cmd = input.args.command;

		// cp [options] source dest - capture destination file(s)
		// Handles: cp file1 file2, cp -r dir1 dir2, cp file1 file2 file3 dest/
		const cpMatch = cmd.match(/cp\s+(?:-[a-zA-Z]+\s+)*(.*)$/);
		if (cpMatch) {
			const argsStr = cpMatch[1];
			// Split by whitespace but respect quotes
			const args = argsStr.match(/[^\s"']+|"([^"]*)"|'([^']*)'/g) || [];
			// Remove flags and clean up quotes
			const cleanArgs = args
				.map((arg) => arg.replace(/^["']|["']$/g, ""))
				.filter((arg) => !arg.startsWith("-") && arg.length > 0);
			// Last argument is the destination
			if (cleanArgs.length >= 2) {
				const dest = cleanArgs[cleanArgs.length - 1];
				return dest;
			}
		}

		// mv [options] source dest - capture destination
		const mvMatch = cmd.match(/mv\s+(?:-[a-zA-Z]+\s+)*(\S+)\s+(\S+)$/);
		if (mvMatch) {
			return mvMatch[2];
		}

		// echo "content" > file - capture file after >
		const echoRedirectMatch = cmd.match(/echo\s+.*>\s*(\S+)$/);
		if (echoRedirectMatch) {
			return echoRedirectMatch[1];
		}

		// cat > file or tee file
		const catRedirectMatch = cmd.match(/(?:cat|tee)\s+.*>\s*(\S+)$/);
		if (catRedirectMatch) {
			return catRedirectMatch[1];
		}

		// sed -i (in-place edit)
		const sedMatch = cmd.match(
			/sed\s+(?:-[a-zA-Z]*i[a-zA-Z]*\s+|-i\s+(?:'[^']*'|"[^"]*")\s+)*(\S+)$/,
		);
		if (sedMatch) {
			return sedMatch[1];
		}
	}

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
 * Run a linter on a batch of files using native Bun.spawn
 */
async function runLinter(
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

	try {
		const outputs: string[] = [];

		for (let i = 0; i < existingFiles.length; i += BATCH_SIZE) {
			const batch = existingFiles.slice(i, i + BATCH_SIZE);
			const cmdParts = [linter.command, ...linter.args, ...batch];

			const timeoutPromise = new Promise<string>((_, reject) => {
				setTimeout(() => {
					reject(new Error(`Linter command timed out after ${timeoutMs}ms`));
				}, timeoutMs);
			});

			try {
				const proc = Bun.spawn(cmdParts, {
					stdout: "pipe",
					stderr: "pipe",
				});

				const batchOutputPromise = new Response(proc.stdout).text();
				const batchErrorPromise = new Response(proc.stderr).text();

				const [batchOutput, batchError] = await Promise.race([
					Promise.all([batchOutputPromise, batchErrorPromise]),
					timeoutPromise,
				]);

				const combinedOutput = [batchOutput, batchError]
					.filter(Boolean)
					.join("\n");
				if (combinedOutput) {
					outputs.push(combinedOutput);
				}

				await proc.exited;
			} catch (error) {
				console.error(
					`[PostTurnLinter] Error running ${linter.name} on batch ${Math.floor(i / BATCH_SIZE) + 1}:`,
					error,
				);
			}
		}

		return {
			name: linter.name,
			output: outputs.join("\n").trim(),
			fileCount: existingFiles.length,
		};
	} catch (error) {
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
	_$,
	directory,
	worktree,
}: PluginContext) => {
	const projectDir = worktree || directory;
	const config = await loadConfig(projectDir);
	const timeoutMs = config.timeoutMs ?? DEFAULT_CONFIG.timeoutMs;
	const maxParallel = config.maxParallel ?? DEFAULT_CONFIG.maxParallel ?? 3;

	const modifiedFiles = new Set<string>();
	let hasRun = false;

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
				if (hasRun) return;
				if (modifiedFiles.size === 0) return;

				hasRun = true;

				// Copy files to process and clear the set atomically
				const filesToProcess = new Set(modifiedFiles);
				modifiedFiles.clear();

				const filesByLinter = groupFilesByLinter(filesToProcess, config);

				if (filesByLinter.size === 0) {
					hasRun = false;
					return;
				}

				const linterEntries = Array.from(filesByLinter.entries());
				const linterResults: ({
					name: string;
					output: string;
					fileCount: number;
				} | null)[] = new Array(linterEntries.length);

				// Controlled parallelism
				let nextIndex = 0;
				const workers = new Array(Math.min(maxParallel, linterEntries.length))
					.fill(null)
					.map(async () => {
						while (nextIndex < linterEntries.length) {
							const currentIndex = nextIndex++;
							const [_, filePaths] = linterEntries[currentIndex];
							const linter = getLinterForFile(filePaths[0], config);
							if (linter) {
								linterResults[currentIndex] = await runLinter(
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
				console.error("[PostTurnLinter] Error in event handler:", error);
			} finally {
				// Always reset the flag so we can run again on next idle
				hasRun = false;
			}
		},
	};
};

// Default export for compatibility
export default PostTurnLinter;
