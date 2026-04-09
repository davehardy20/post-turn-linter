# Post Turn Linter

An [OpenCode](https://github.com/opencode-ai/opencode) plugin that
automatically runs linters on modified files after each tool execution turn.
This helps catch code quality issues immediately while you're working,
providing instant feedback without interrupting your flow.

## Features

- **Automatic Linting**: Watches file modifications and runs appropriate linters
  when the session becomes idle
- **Bash Command Detection**: Detects file modifications from bash commands
  (`cp`, `mv`, `echo`, `sed`, etc.)
- **Multi-Language Support**: Built-in support for TypeScript, JavaScript,
  Python, C/C++, Rust, Terraform, Shell scripts, Docker, and more
- **Configurable**: Customize which linters to use, timeouts, and parallel
  execution limits
- **Batch Processing**: Efficiently processes files in batches to handle large
  changesets
- **Parallel Execution**: Runs multiple linters concurrently for faster feedback
- **Smart Grouping**: Groups files by linter type to minimize redundant
  execution

## Prerequisites

### System Dependencies

This plugin requires the following tools to be installed on your system,
depending on which languages you're linting:

#### Required for All

- [Bun](https://bun.sh/) >= 1.0.0 (runtime for the plugin)

#### Language-Specific Linters

| Language | Linter | Installation |
|----------|--------|--------------|
| TypeScript/JavaScript | [Biome](https://biomejs.dev/) | `npm install -g @biomejs/biome` or `bun add -g @biomejs/biome` |
| Python | [Ruff](https://docs.astral.sh/ruff/) | `pip install ruff` or `brew install ruff` |
| C/C++ | [cppcheck](https://cppcheck.sourceforge.io/) | `apt install cppcheck` / `brew install cppcheck` |
| Rust | [Clippy](https://github.com/rust-lang/rust-clippy) | Included with Rust toolchain |
| Terraform | [tflint](https://github.com/terraform-linters/tflint) | `brew install tflint` |
| Go | [golangci-lint](https://golangci-lint.run/) | `brew install golangci-lint` |
| Shell (sh, bash, zsh, ksh) | [ShellCheck](https://www.shellcheck.net/) | `brew install shellcheck` |
| Docker | [Hadolint](https://github.com/hadolint/hadolint) | `brew install hadolint` |

You only need to install the linters for languages you actually use. The plugin
will skip languages without available linters.

## Installation

### 1. Clone the Repository

```bash
git clone https://github.com/davehardy20/post-turn-linter.git
cd post-turn-linter
```

### 2. Install Dependencies

```bash
bun install
```

### 3. Build the Plugin

```bash
bun run build
```

### 4. Configure OpenCode

Add the plugin to your OpenCode configuration. The exact method depends on your
OpenCode setup, but typically you'll need to:

1. Copy or symlink the plugin to your OpenCode plugins directory
2. Register the plugin in your OpenCode configuration

Example configuration entry:

```json
{
  "plugins": [
    {
      "name": "post-turn-linter",
      "path": "/path/to/post-turn-linter/dist/index.js"
    }
  ]
}
```

## Configuration

The plugin works out of the box with sensible defaults. To customize behavior,
create an optional configuration file at `.opencode/linter.config.json` in your
project root:

```json
{
  "timeoutMs": 60000,
  "maxParallel": 3,
  "linters": {
    ".ts": {
      "command": "biome",
      "args": ["check"],
      "name": "Biome"
    },
    ".tsx": {
      "command": "biome",
      "args": ["check"],
      "name": "Biome"
    },
    ".py": {
      "command": "ruff",
      "args": ["check", "--fix"],
      "name": "Ruff"
    },
    ".rs": {
      "command": "cargo",
      "args": ["clippy", "--all-targets", "--all-features"],
      "name": "Clippy"
    },
    "Dockerfile": {
      "command": "hadolint",
      "args": [],
      "name": "Hadolint"
    }
  }
}
```

### Configuration Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `timeoutMs` | number | 60000 | Maximum time to wait for a linter to complete (milliseconds) |
| `maxParallel` | number | 3 | Maximum number of linters to run in parallel |
| `linters` | object | See below | Map of file extensions to linter configurations |

### Linter Configuration

Each entry in the `linters` object maps a file extension (or filename for special files like `Dockerfile`) to a linter definition:

```typescript
{
  "command": "biome",        // The command to execute
  "args": ["check"],         // Arguments to pass to the command
  "name": "Biome"            // Display name for the linter
}
```

### Default Linters

The plugin includes sensible defaults for common file types:

| Extension | Linter | Command |
|-----------|--------|---------|
| .ts, .tsx, .js, .jsx, .mjs, .cjs | Biome | `biome check` |
| .py, .pyi | Ruff | `ruff check` |
| .c | cppcheck | `cppcheck --enable=all --std=c11` |
| .cpp, .cc, .hpp | cppcheck | `cppcheck --enable=all --std=c++17` |
| .h | cppcheck | `cppcheck --enable=all` |
| .tf, .tfvars | tflint | `tflint` |
| .rs | Clippy | `cargo clippy --all-targets --all-features` |
| .sh, .bash, .zsh, .ksh | ShellCheck | `shellcheck` |
| Dockerfile | Hadolint | `hadolint` |

## Extending the Tool

### Adding Custom Linters

You can add support for any language by extending the `linters` configuration:

```json
{
  "linters": {
    ".php": {
      "command": "phpstan",
      "args": ["analyse", "--level=8"],
      "name": "PHPStan"
    },
    ".java": {
      "command": "checkstyle",
      "args": ["-c", "google_checks.xml"],
      "name": "Checkstyle"
    },
    ".rb": {
      "command": "rubocop",
      "args": ["--format", "simple"],
      "name": "RuboCop"
    },
    "Dockerfile": {
      "command": "hadolint",
      "args": ["--no-color"],
      "name": "Hadolint"
    }
  }
}
```

### Creating Custom Plugins

You can extend this plugin or create your own based on the same patterns. The
plugin exports a `PostTurnLinter` function that follows the OpenCode plugin
interface.

```typescript
import { PostTurnLinter } from '@davehardy20/post-turn-linter';

// You can wrap or extend the plugin
const MyCustomLinter = async (context) => {
  const basePlugin = await PostTurnLinter(context);
  
  return {
    ...basePlugin,
    // Add custom hooks or override behavior
  };
};
```

### Plugin Hooks

The plugin implements two OpenCode plugin hooks:

#### `tool.execute.after`

Called after each tool execution. Detects file modifications and queues them for
linting.

#### `event`

Listens for `session.idle` events. When the session becomes idle, runs the
queued linters immediately.

## How It Works

1. **Detection**: After each tool execution, the plugin checks if a file was
   modified (created, edited, replaced) or if a bash command modified files
   (`cp`, `mv`, `echo`, `sed`, etc.)
2. **Queueing**: Modified files are added to an internal queue (up to 1000 files
   maximum)
3. **Idle Trigger**: When the OpenCode session becomes idle, the plugin runs the
   queued linters immediately
4. **Grouping**: Files are grouped by their associated linter to minimize
   redundant execution
5. **Execution**: Linters run in parallel (up to `maxParallel` concurrent) with
   timeout protection
6. **Batching**: Large file sets are processed in batches of 50 to avoid
   command-line length limits
7. **Reporting**: Results are sent back to the OpenCode session as a prompt with
   all linter output

## Development

### Building

```bash
bun run build
```

### Watch Mode

```bash
bun run watch
```

### Type Checking

```bash
bun run typecheck
```

## Troubleshooting

### Linters Not Running

1. Check that the linter is installed and available in your PATH: `which biome`
2. Check OpenCode logs for plugin loading errors
3. If you've created a custom configuration file, verify it's valid JSON at `.opencode/linter.config.json`

### Linter Timeouts

Increase the `timeoutMs` in your configuration:

```json
{
  "timeoutMs": 120000
}
```

### High Resource Usage

Reduce `maxParallel` to limit concurrent linter execution:

```json
{
  "maxParallel": 1    // Run linters sequentially
}
```

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request. For major
changes, please open an issue first to discuss what you would like to change.

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## License

MIT License - see [LICENSE](LICENSE) file for details

## Acknowledgments

- Built for the [OpenCode](https://github.com/opencode-ai/opencode) AI coding assistant
- Inspired by the need for immediate code quality feedback in AI-assisted development
