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
- `cursorTscRunner.runOnSave`: rerun on relevant file saves.
- `cursorTscRunner.relevantRerunDebounceMs`: debounce delay for save-triggered reruns (milliseconds).
- `cursorTscRunner.maxParallelChecks`: max concurrent checks in full runs.
- `cursorTscRunner.relevantExtensions`: file extensions that trigger save-based reruns.

### UI / Styling

- `cursorTscRunner.resultsFontSize`
- `cursorTscRunner.resultPadding`
- `cursorTscRunner.resultsSpinnerSize`
- `cursorTscRunner.resultsRowStripeEvenBackground`
- `cursorTscRunner.resultsRowStripeOddBackground`
- `cursorTscRunner.resultsRowBackgroundSuccess`
- `cursorTscRunner.resultsRowBackgroundFailed`
- `cursorTscRunner.resultsRowBackgroundMissing`
- `cursorTscRunner.resultsRowBackgroundIdle`
- `cursorTscRunner.resultsRowBackgroundRunning`

Empty-string background settings keep the extension default visuals.

### GitHub Actions (live status)

For any target folder where **`.github/workflows`** exists on that folder or a parent up to the workspace root, the extension shows a **second bubble** with the **latest GitHub Actions workflow run** for the same ref as your local repo:

- Resolves **`git`** starting at the target path, reads **`remote.origin.url`**, parses **owner/repo** (github.com and common GitHub Enterprise SSH/HTTPS forms).
- Uses the **current branch**, or **`head_sha`** when HEAD is detached.
- Calls the **GitHub REST API** (`GET /repos/{owner}/{repo}/actions/runs?per_page=1` plus `branch=` or `head_sha=`). The newest matching run drives the emoji; click the bubble to open the run in the browser (when a URL is available).

Settings:

- `cursorTscRunner.githubToken`: optional; **required for private repos** and recommended for rate limits. Prefer **User** settings and do not commit the token.
- `cursorTscRunner.githubApiBaseUrl`: optional override, e.g. `https://api.github.com` or `https://HOSTNAME/api/v3` for Enterprise. If empty, **github.com** remotes use `https://api.github.com`; other hosts default to `https://<host>/api/v3`.
- `cursorTscRunner.githubActionsRefreshMs`: polling interval for refreshing CI bubbles (default 120000 ms).

If no run exists for that branch/commit, the bubble shows a neutral state and a tooltip explains it. Errors (auth, network) appear as **⚠️** with details in the tooltip.

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
