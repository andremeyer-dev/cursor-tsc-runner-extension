# Cursor TSC Runner

Run fast TypeScript checks across multiple folders and view live status in a sidebar panel.

## What It Does

- Runs `yarn tsc --noEmit --pretty false` per configured project folder.
- Shows per-project status in the **TSC Runner** activity bar view.
- Supports:
  - initial run on startup,
  - automatic rerun on relevant file saves,
  - manual rerun per row,
  - manual full run via command palette.

## Command

- `Cursor TSC Runner: Run yarn tsc` (`cursorTscRunner.runTypeChecks`)

## Configuration

All settings are under the `cursorTscRunner.*` namespace.

### Core

- `cursorTscRunner.targetFolders`: workspace-relative folders to check.
- `cursorTscRunner.autoRunOnStart`: run once when extension activates.
- `cursorTscRunner.autoRunOnRelevantSave`: rerun on relevant file saves.
- `cursorTscRunner.maxParallelChecks`: max concurrent checks in full runs.
- `cursorTscRunner.relevantExtensions`: file extensions that trigger save-based reruns.

### UI / Styling

- `cursorTscRunner.resultsFontSize`
- `cursorTscRunner.resultsPanelPaddingY`
- `cursorTscRunner.resultsPanelPaddingX`
- `cursorTscRunner.resultsRowPaddingY`
- `cursorTscRunner.resultsRowPaddingX`
- `cursorTscRunner.resultsRowGap`
- `cursorTscRunner.resultsRowSpacing`
- `cursorTscRunner.resultsRowRadius`
- `cursorTscRunner.resultsSpinnerSize`

## Build and Package

Use `npm` in this extension folder.

```bash
cd cursor-tsc-runner-extension
npm install
npm run build
npx @vscode/vsce package --no-yarn
```

Output:

- `cursor-tsc-runner-extension-<version>.vsix`

## Install In Cursor

1. Open **Extensions** view.
2. Click the `...` menu.
3. Select **Install from VSIX...**
4. Pick `cursor-tsc-runner-extension-<version>.vsix`
5. Reload Cursor when prompted.

After installation, the extension appears in your installed extensions list and the **TSC Runner** icon appears in the activity bar.
