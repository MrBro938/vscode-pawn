# Pawn Tools for Visual Studio Code

Pawn Tools adds language support for **Pawn** projects to Visual Studio Code. It is designed for Pawn development, including SA-MP and open.mp projects.

The extension supports `.p`, `.pawn`, `.pwn`, and `.inc` files.

## Features

### Editing and IntelliSense

- **Syntax highlighting** for Pawn source files.
- **Semantic highlighting** based on symbols found by the Pawn analyzer.
- **Code completion** for keywords, functions, native declarations, macros, enums, variables, and symbols from included files.
- **Scope-aware suggestions**: local variables and parameters are suggested only after their declaration and while they are in scope.
- **Function and macro signatures** while typing a call, including parameter information.
- **Hover information** for recognized functions and symbols.
- **Go to Definition** for Pawn symbols and include directives.
- **Find All References** and **Rename Symbol**.
- **Document Outline** with functions, enums, constants, variables, and enum members.
- **Snippets** for Pawn syntax, standard functions and definitions, and community libraries.

### Include and project support

The language server builds an include graph and uses it to resolve symbols across the current file and its dependencies.

Include directories can be discovered from project and compiler configuration, including:

- The workspace and project include settings.
- `pawn.json` and `pawn.yaml` package configuration.
- Compiler `pawn.cfg` files and compiler include directories.
- `-i` include arguments and package dependencies.
- Additional paths configured with `pawn.includePaths`.

### Color previews

Color swatches are available for:

- Hex color literals such as `0xRRGGBB` and `0xRRGGBBAA`.
- SA-MP inline text color tags such as `{FF8800}` inside Pawn strings.
- Color constants declared with `#define`, including simple aliases and definitions resolved through included files.

For example:

```
#define COLOR_GREY 0xAFAFAFAA
#define COLOR_HINT COLOR_GREY

SendClientMessage(playerid, COLOR_GREY, "Hello");
SendClientMessage(playerid, COLOR_HINT, "Another message");
```

The preview is displayed next to recognized color values and references. It does not rewrite the source code.

### Build integration

The extension contributes two problem matchers:

- `$pawncc` — parses Pawn compiler output.
- `$sampctl` — parses sampctl output, including watcher builds.

Compiler messages can therefore appear in the VS Code **Problems** panel when your build task uses the matching problem matcher.

### Performance tools

The language server uses cached analysis, include and completion data, and semantic-token results to avoid repeating work unnecessarily.

Optional performance logging can help investigate slow workspace indexing or language-service requests. Use the commands described below to enable it and inspect the collected statistics.

Crash diagnostics are also collected automatically. If the language server stops unexpectedly, VS Code shows a notification with an option to open the log. If the Extension Host exits without normal deactivation, the extension offers to open the log the next time it starts.

## Installation

### Install a VSIX from GitHub Actions

1. Open the repository's [Actions](https://github.com/MrBro938/vscode-pawn/actions/workflows/build.yml) page.
2. Open a successful **Build Pawn Tools** run for the commit you want to install.
3. Download the `Pawn-Tools.vsix` artifact.
4. In VS Code, open the Command Palette with `Ctrl+Shift+P` / `Cmd+Shift+P`.
5. Run **Extensions: Install from VSIX...** and select the downloaded file.

### Build from source

Requirements: Node.js 22 and npm.

```bash
git clone https://github.com/MrBro938/vscode-pawn.git
cd vscode-pawn
npm ci
npm test
npx --yes @vscode/vsce package --out Pawn-Tools.vsix
```

Then install `Pawn-Tools.vsix` using **Extensions: Install from VSIX...**.

## Configuration

Open VS Code settings and search for `Pawn`, or add the following to your workspace `.vscode/settings.json`:

```json
{
  "pawn.includePaths": [
    "./include",
    "./pawno/include"
  ],
  "pawn.compilerPath": "C:/path/to/pawncc.exe",
  "pawn.functionSearchScope": "includes",
  "pawn.performanceLogging": false
}
```

| Setting | Default | Description |
| --- | --- | --- |
| `pawn.includePaths` | `[]` | Additional include directories. Relative paths are resolved from each workspace folder. |
| `pawn.compilerPath` | `""` | Path to the Pawn compiler executable or its directory. Used to locate the adjacent `pawn.cfg` and standard include directory. |
| `pawn.functionSearchScope` | `includes` | Controls how broadly cross-file symbols are searched for completion, hover, Go to Definition, and Signature Help. |
| `pawn.performanceLogging` | `false` | Collect local performance statistics for indexing, analysis, semantic tokens, and IntelliSense requests. |

### Function search scope

Choose the search range that best fits your project:

| Value | Search scope |
| --- | --- |
| `includes` | **Default and fastest.** Searches the active file and files it includes, recursively. For example, standard functions such as `SetPlayerPos` can be found through `a_samp.inc` when it is included. |
| `compilationUnit` | Searches the active file, its includes, and files that include the active file. |
| `workspace` | Searches all indexed Pawn files in the workspace and configured include directories. This can take longer in large projects. |

For most projects, keep the default `includes` setting. Use `workspace` when you need to find symbols that are not reachable through the current file's include tree.

## Building Pawn projects

Pawn Tools provides problem matchers; it does not bundle the Pawn compiler or sampctl. Configure your compiler or build tool separately.

### Using sampctl

Install and configure [sampctl](https://github.com/Southclaws/sampctl) for your project, then add a task such as this to `.vscode/tasks.json`:

```json
{
  "version": "2.0.0",
  "tasks": [
    {
      "label": "Build Pawn package",
      "type": "shell",
      "command": "sampctl",
      "args": ["build"],
      "group": {
        "kind": "build",
        "isDefault": true
      },
      "problemMatcher": "$sampctl"
    }
  ]
}
```

Run the task with `Ctrl+Shift+B` / `Cmd+Shift+B`, or choose **Tasks: Run Task** from the Command Palette.

### Using pawncc directly

Create a task that runs your `pawncc` executable and set:

```json
"problemMatcher": "$pawncc"
```

Update the compiler path and arguments to match your local project structure and build options.

## Commands

Open the Command Palette and search for:

| Command | Description |
| --- | --- |
| **Pawn: Show Performance Statistics** | Opens the performance output with Extension Host and Language Server statistics. |
| **Pawn: Toggle Performance Logging** | Enables or disables collection of performance statistics. |
| **Pawn: Reset Performance Statistics** | Clears the collected counters and timings. |
| **Pawn: Open Crash Log** | Opens the crash log stored in the extension global storage. |

When performance logging is disabled, the extension continues to work normally; only the additional profiling data is omitted.

## Compatibility

- Visual Studio Code **1.144.0 or newer**.
- Pawn source files with the extensions `.p`, `.pawn`, `.pwn`, and `.inc`.

The compiler and build system are separate tools and must be installed independently.

## Development

The main extension code is in `src/`; the language server is in `src/server/`. Tests are in `test/`.

Useful scripts:

```bash
npm run compile
npm test
npm run watch
```

See [CHANGELOG.md](CHANGELOG.md) for project changes.
