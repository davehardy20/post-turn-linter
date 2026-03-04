/**
 * Type definitions for the Post Turn Linter plugin
 * Compatible with the OpenCode plugin system
 */

/**
 * OpenCode client interface for session interactions
 */
export interface OpenCodeClient {
	session: {
		prompt: (options: {
			path: { id: string };
			body: {
				parts: Array<{ type: "text"; text: string }>;
			};
		}) => Promise<void>;
	};
}

/**
 * Plugin context provided by OpenCode
 */
export interface PluginContext {
	/** Bun shell for executing commands (unused - we use Bun.spawn directly) */
	_$: unknown;
	/** OpenCode client for session interactions */
	client: OpenCodeClient;
	/** Current working directory */
	directory: string;
	/** Git worktree directory (if in a git repo) */
	worktree?: string;
}

/**
 * Tool execution hook input
 */
export interface ToolExecuteInput {
	/** Name of the tool being executed */
	tool: string;
	/** Arguments passed to the tool */
	args?: {
		filePath?: string;
		path?: string;
		command?: string;
		[key: string]: unknown;
	};
}

/**
 * Event hook input
 */
export interface EventInput {
	/** Event data */
	event: {
		/** Event type */
		type: string;
		/** Additional event properties */
		properties?: {
			sessionID?: string;
			[key: string]: unknown;
		};
	};
}

/**
 * Plugin hook handlers
 */
export interface PluginHooks {
	/** Called after each tool execution */
	"tool.execute.after"?: (input: ToolExecuteInput) => Promise<void> | void;
	/** Called when events are triggered */
	event?: (input: EventInput) => Promise<void> | void;
}

/**
 * Plugin function signature
 */
export type Plugin = (
	context: PluginContext,
) => Promise<PluginHooks> | PluginHooks;

/**
 * Linter command definition
 */
export interface LinterDefinition {
	/** The command to execute (e.g., 'biome', 'ruff') */
	command: string;
	/** Arguments to pass to the command */
	args: string[];
	/** Display name for the linter */
	name: string;
}

/**
 * Linter configuration structure
 */
export interface LinterConfig {
	/** Map of file extensions to linter definitions */
	linters: Record<string, LinterDefinition>;
	/** Timeout for linter execution in milliseconds (default: 60000) */
	timeoutMs?: number;
	/** Maximum number of parallel linter processes (default: 3) */
	maxParallel?: number;
}
