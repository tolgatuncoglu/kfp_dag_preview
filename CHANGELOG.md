# Changelog

## Unreleased

### Added
- Horizontal/vertical DAG layout selector for Python and compiled YAML previews. The selection persists through refreshes and group changes and is reflected in Copy Mermaid.
- Click-and-drag panning on the DAG canvas, with a movement threshold to preserve task clicks.

### Changed
- Fit now fits both dimensions and resets the scroll position. Toolbar controls wrap in narrow panels.

## 0.2.0

### Added
- The preview now refreshes when the pipeline file or any `.py` file in the workspace changes on disk, including edits made by external tools and imported modules, not only saves made in VS Code. Bursts of events compile once.
- Opening the same pipeline again reveals the existing preview instead of starting a second one.
- Compilation times out after two minutes, ignores stdin, and stops the whole child process group when cancelled.
- Pipeline discovery recognizes `@kfp.dsl.pipeline`, `import kfp as k` and `import kfp.dsl as d`.
- MIT license.

### Changed
- `kfpDagPreview.kfpExecutable` now takes precedence over the detected Python environment. If the selected interpreter has no `kfp`, the extension falls back to `kfp` on `PATH` before failing.
- Compiled YAML preview works in Restricted Mode. Python preview still requires a trusted workspace.
- Compile failures show a one-line summary in the status line; the full output remains under **Show compiler output**.
- The webview bundle is minified (about 5 MB, down from 12 MB); the VSIX is about 1.5 MB.

### Fixed
- Clicking a task could open a different task's details when one task id was a prefix of another (for example `work` and `work-2`).
- Dependencies on tasks that do not exist in a scope no longer render as ghost nodes.
- Failed Mermaid renders no longer leave error elements in the page.
- A decorator on a `class` no longer marks the following function as a pipeline.
- The preview button in the editor title bar no longer fails with `Pipeline function or component "[object Object]" not found`.

## 0.1.1

- Initial local release: compile a KFP v2 Python pipeline with the local `kfp` CLI, render its DAG with bundled Mermaid, refresh on save, copy Mermaid source, and preview compiled PipelineSpec YAML.
