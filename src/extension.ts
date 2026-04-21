import { exec } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access } from "node:fs/promises";
import * as path from "node:path";
import { promisify } from "node:util";
import * as vscode from "vscode";

interface TypeCheckResult {
  readonly folder: string;
  readonly succeeded: boolean;
  readonly durationMs: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly message: string;
}

interface ErrorShape {
  readonly code?: number;
  readonly stdout?: string;
  readonly stderr?: string;
  readonly message?: string;
}

interface RerunMessage {
  readonly type: "rerun";
  readonly folder: string;
}

type FolderOutcome = "success" | "missing" | "failed" | "idle" | "running";

interface ProjectStatusRow {
  readonly folder: string;
  readonly outcome: FolderOutcome;
  readonly durationMs: number;
  readonly message: string;
}

interface ResultsStyleConfig {
  readonly panelPaddingY: number;
  readonly panelPaddingX: number;
  readonly rowPaddingY: number;
  readonly rowPaddingX: number;
  readonly rowGap: number;
  readonly rowSpacing: number;
  readonly rowRadius: number;
  readonly spinnerSize: number;
}

const executeCommand = promisify(exec);
const commandId = "cursorTscRunner.runTypeChecks";
const maxCommandBufferBytes = 8 * 1024 * 1024;
const folderNotFoundPrefix = "Folder not found:";
const configSection = "cursorTscRunner";
const resultsFontSizeKey = "resultsFontSize";
const targetFoldersKey = "targetFolders";
const autoRunOnStartKey = "autoRunOnStart";
const autoRunOnRelevantSaveKey = "autoRunOnRelevantSave";
const maxParallelChecksKey = "maxParallelChecks";
const relevantExtensionsKey = "relevantExtensions";
const panelPaddingYKey = "resultsPanelPaddingY";
const panelPaddingXKey = "resultsPanelPaddingX";
const rowPaddingYKey = "resultsRowPaddingY";
const rowPaddingXKey = "resultsRowPaddingX";
const rowGapKey = "resultsRowGap";
const rowSpacingKey = "resultsRowSpacing";
const rowRadiusKey = "resultsRowRadius";
const spinnerSizeKey = "resultsSpinnerSize";
const defaultTargetFolders: readonly string[] = [
  "global-backend",
  "realm-core-backend",
  "realm-simulation-backend",
  "sso-backend",
  "image-server-backend",
  "realm-gateway-backend",
  "armory-backend",
  "tech-admin-backend",
  "world-authoring-backend",
  "ai-lab-backend",
  "landing-backend",
  "game-ui-backend"
];
const defaultRelevantExtensions: readonly string[] = [
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".d.ts",
  ".json"
];
const alwaysRelevantFileNames = new Set(["package.json", "yarn.lock"]);

function isErrorShape(value: unknown): value is ErrorShape {
  return typeof value === "object" && value !== null;
}

function extractError(value: unknown): ErrorShape {
  if (!isErrorShape(value)) {
    return {};
  }

  const maybeCode = value.code;
  const maybeStdout = value.stdout;
  const maybeStderr = value.stderr;
  const maybeMessage = value.message;

  return {
    code: typeof maybeCode === "number" ? maybeCode : undefined,
    stdout: typeof maybeStdout === "string" ? maybeStdout : undefined,
    stderr: typeof maybeStderr === "string" ? maybeStderr : undefined,
    message: typeof maybeMessage === "string" ? maybeMessage : undefined
  };
}

async function ensureFolderExists(folderPath: string): Promise<void> {
  await access(folderPath, fsConstants.F_OK);
}

async function runTypeCheck(workspaceRoot: string, folder: string): Promise<TypeCheckResult> {
  const absoluteFolder = path.resolve(workspaceRoot, folder);
  const startedAt = Date.now();

  try {
    await ensureFolderExists(absoluteFolder);
  } catch {
    return {
      folder,
      succeeded: false,
      durationMs: Date.now() - startedAt,
      stdout: "",
      stderr: "",
      message: `${folderNotFoundPrefix} ${folder}`
    };
  }

  try {
    const executionResult = await executeCommand("yarn tsc --noEmit --pretty false", {
      cwd: absoluteFolder,
      maxBuffer: maxCommandBufferBytes
    });

    return {
      folder,
      succeeded: true,
      durationMs: Date.now() - startedAt,
      stdout: executionResult.stdout,
      stderr: executionResult.stderr,
      message: "ok"
    };
  } catch (error: unknown) {
    const extractedError = extractError(error);

    return {
      folder,
      succeeded: false,
      durationMs: Date.now() - startedAt,
      stdout: extractedError.stdout ?? "",
      stderr: extractedError.stderr ?? "",
      message:
        extractedError.message ??
        `Failed to run yarn tsc (code ${String(extractedError.code ?? "unknown")})`
    };
  }
}

function formatDuration(durationMs: number): string {
  const seconds = durationMs / 1000;
  return `${seconds.toFixed(2)}s`;
}

function outcomeFor(result: TypeCheckResult): FolderOutcome {
  if (result.succeeded) {
    return "success";
  }

  if (result.message.startsWith(folderNotFoundPrefix)) {
    return "missing";
  }

  return "failed";
}

function statusRowFromResult(result: TypeCheckResult): ProjectStatusRow {
  return {
    folder: result.folder,
    outcome: outcomeFor(result),
    durationMs: result.durationMs,
    message: result.message
  };
}

function createInitialRows(targetFolders: readonly string[]): ProjectStatusRow[] {
  return targetFolders.map((folder) => ({
    folder,
    outcome: "idle",
    durationMs: 0,
    message: ""
  }));
}

function syncRowsWithTargets(
  targetFolders: readonly string[],
  existingRows: readonly ProjectStatusRow[] | undefined
): ProjectStatusRow[] {
  const map = new Map<string, ProjectStatusRow>();
  for (const row of existingRows ?? []) {
    map.set(row.folder, row);
  }
  return targetFolders.map((folder) => map.get(folder) ?? { folder, outcome: "idle", durationMs: 0, message: "" });
}

function bubbleFor(outcome: FolderOutcome): string {
  if (outcome === "idle") {
    return "⚪";
  }
  if (outcome === "running") {
    return "⏳";
  }
  if (outcome === "success") {
    return "🟢";
  }

  if (outcome === "missing") {
    return "🔴";
  }

  return "🔴";
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function rowClassFor(outcome: FolderOutcome): string {
  if (outcome === "idle") {
    return "row-idle";
  }
  if (outcome === "running") {
    return "row-running";
  }
  if (outcome === "success") {
    return "row-ok";
  }

  if (outcome === "missing") {
    return "row-fail";
  }

  return "row-fail";
}

function getResultsFontSizePx(): number {
  const raw = vscode.workspace.getConfiguration(configSection).get<number>(resultsFontSizeKey);
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return Math.min(24, Math.max(8, Math.round(raw)));
  }
  return 12;
}

function getConfiguredTargetFolders(workspaceRoot: string): string[] {
  const raw = vscode.workspace.getConfiguration(configSection).get<unknown>(targetFoldersKey);
  if (!Array.isArray(raw)) {
    return [...defaultTargetFolders];
  }
  const rootResolved = path.resolve(workspaceRoot);
  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (typeof item !== "string") {
      continue;
    }
    const trimmed = item.trim();
    if (trimmed === "") {
      continue;
    }
    if (path.isAbsolute(trimmed)) {
      continue;
    }
    const resolved = path.resolve(workspaceRoot, trimmed);
    const rel = path.relative(rootResolved, resolved);
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
      continue;
    }
    if (seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    normalized.push(trimmed);
  }
  return normalized;
}

function getAutoRunOnStart(): boolean {
  const raw = vscode.workspace.getConfiguration(configSection).get<boolean>(autoRunOnStartKey);
  return raw !== false;
}

function getAutoRunOnRelevantSave(): boolean {
  const raw = vscode.workspace.getConfiguration(configSection).get<boolean>(autoRunOnRelevantSaveKey);
  return raw !== false;
}

function getMaxParallelChecks(): number {
  const raw = vscode.workspace.getConfiguration(configSection).get<number>(maxParallelChecksKey);
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    return 1;
  }
  return Math.max(1, Math.round(raw));
}

function getRelevantExtensions(): Set<string> {
  const raw = vscode.workspace.getConfiguration(configSection).get<unknown>(relevantExtensionsKey);
  if (!Array.isArray(raw)) {
    return new Set(defaultRelevantExtensions);
  }
  const normalized = raw
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0)
    .map((entry) => (entry.startsWith(".") ? entry : `.${entry}`));
  if (normalized.length === 0) {
    return new Set(defaultRelevantExtensions);
  }
  return new Set(normalized);
}

function resolveTargetFolderForFile(
  workspaceRoot: string,
  targetFolders: readonly string[],
  filePath: string
): string | undefined {
  for (const folder of targetFolders) {
    const projectPath = path.resolve(workspaceRoot, folder);
    const relative = path.relative(projectPath, filePath);
    if (!(relative.startsWith("..") || path.isAbsolute(relative))) {
      return folder;
    }
  }
  return undefined;
}

function getNumberSetting(key: string, fallback: number, min: number, max: number): number {
  const raw = vscode.workspace.getConfiguration(configSection).get<number>(key);
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.round(raw)));
}

function getResultsStyleConfig(): ResultsStyleConfig {
  return {
    panelPaddingY: getNumberSetting(panelPaddingYKey, 2, 0, 32),
    panelPaddingX: getNumberSetting(panelPaddingXKey, 4, 0, 32),
    rowPaddingY: getNumberSetting(rowPaddingYKey, 2, 0, 24),
    rowPaddingX: getNumberSetting(rowPaddingXKey, 4, 0, 24),
    rowGap: getNumberSetting(rowGapKey, 6, 0, 32),
    rowSpacing: getNumberSetting(rowSpacingKey, 2, 0, 24),
    rowRadius: getNumberSetting(rowRadiusKey, 2, 0, 16),
    spinnerSize: getNumberSetting(spinnerSizeKey, 10, 6, 24)
  };
}

function isRerunMessage(value: unknown): value is RerunMessage {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const maybeType = (value as { readonly type?: unknown }).type;
  const maybeFolder = (value as { readonly folder?: unknown }).folder;
  return maybeType === "rerun" && typeof maybeFolder === "string" && maybeFolder.trim().length > 0;
}

function buildEmptyHtml(webview: vscode.Webview, fontSizePx: number, styleConfig: ResultsStyleConfig): string {
  const csp = ["default-src 'none'", `style-src ${webview.cspSource} 'unsafe-inline'`].join("; ");
  const cspAttr = escapeHtml(csp);
  const hint = escapeHtml('Run "Cursor TSC Runner: Run yarn tsc" from the command palette.');
  const fontEsc = escapeHtml(String(fontSizePx));

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${cspAttr}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Cursor TSC Runner</title>
  <style>
    body {
      font-family: var(--vscode-font-family);
      font-size: ${fontEsc}px;
      color: var(--vscode-descriptionForeground);
      background: var(--vscode-sideBar-background);
      padding: ${styleConfig.panelPaddingY}px ${styleConfig.panelPaddingX}px;
      margin: 0;
      line-height: 1.25;
    }
    p { margin: 0; }
  </style>
</head>
<body>
  <p>${hint}</p>
</body>
</html>`;
}

function buildResultsHtml(
  webview: vscode.Webview,
  rows: readonly ProjectStatusRow[],
  fontSizePx: number,
  styleConfig: ResultsStyleConfig
): string {
  const nonce = String(Date.now());
  const csp = ["default-src 'none'", `style-src ${webview.cspSource} 'unsafe-inline'`, `script-src 'nonce-${nonce}'`].join("; ");
  const cspAttr = escapeHtml(csp);
  const fontEsc = escapeHtml(String(fontSizePx));

  const listItems = rows
    .map((row) => {
      const outcome = row.outcome;
      const bubble = bubbleFor(outcome);
      const rowClass = rowClassFor(outcome);
      const folder = escapeHtml(row.folder);
      const durationText = row.durationMs > 0 ? `(${formatDuration(row.durationMs)})` : "";
      const dur = escapeHtml(durationText);
      const spinner = outcome === "running" ? '<span class="spinner" aria-hidden="true"></span>' : "";
      const disabled = outcome === "running" ? "disabled" : "";
      const missingMessage = row.message.length > 0 ? row.message : `${folderNotFoundPrefix} ${row.folder}`;
      const infoIcon = outcome === "missing"
        ? `<span class="info" title="${escapeHtml(missingMessage)}" aria-label="${escapeHtml(missingMessage)}">ℹ</span>`
        : "";
      return `<li class="row ${rowClass}"><span class="meta">${spinner}<span class="bubble" aria-hidden="true">${bubble}</span> <span class="folder">${folder}</span> ${infoIcon}<span class="dur">${dur}</span></span><button class="rerun" data-folder="${folder}" type="button" ${disabled}>Rerun</button></li>`;
    })
    .join("");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${cspAttr}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Cursor TSC Runner</title>
  <style>
    body {
      font-family: var(--vscode-font-family);
      font-size: ${fontEsc}px;
      color: var(--vscode-foreground);
      background: var(--vscode-sideBar-background);
      padding: ${styleConfig.panelPaddingY}px ${styleConfig.panelPaddingX}px;
      margin: 0;
      line-height: 1.25;
    }
    ul {
      list-style: none;
      padding: 0;
      margin: 0;
    }
    .row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: ${styleConfig.rowGap}px;
      padding: ${styleConfig.rowPaddingY}px ${styleConfig.rowPaddingX}px;
      margin-bottom: ${styleConfig.rowSpacing}px;
      border-radius: ${styleConfig.rowRadius}px;
      border: 1px solid var(--vscode-widget-border);
      background: var(--vscode-editor-background);
    }
    .meta {
      min-width: 0;
      display: inline-flex;
      align-items: center;
      gap: 4px;
    }
    .row-ok { border-left: 2px solid var(--vscode-testing-iconPassed, #3fb950); }
    .row-fail { border-left: 2px solid var(--vscode-testing-iconFailed, #f85149); }
    .row-idle {
      border-left: 2px solid var(--vscode-disabledForeground);
      color: var(--vscode-disabledForeground);
      background: color-mix(in srgb, var(--vscode-editor-background) 80%, var(--vscode-disabledForeground) 20%);
    }
    .row-running { border-left: 2px solid var(--vscode-progressBar-background); }
    .folder { font-weight: 500; word-break: break-all; }
    .dur { opacity: 0.85; }
    .info {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 12px;
      height: 12px;
      border-radius: 999px;
      font-size: 10px;
      line-height: 1;
      border: 1px solid var(--vscode-descriptionForeground);
      color: var(--vscode-descriptionForeground);
      cursor: help;
      flex: 0 0 auto;
    }
    .spinner {
      width: ${styleConfig.spinnerSize}px;
      height: ${styleConfig.spinnerSize}px;
      border-radius: 999px;
      border: 2px solid var(--vscode-progressBar-background);
      border-right-color: transparent;
      display: inline-block;
      animation: spin 0.9s linear infinite;
      margin-right: 2px;
      flex: 0 0 auto;
    }
    .rerun {
      flex: 0 0 auto;
      padding: 1px 6px;
      border-radius: 2px;
      border: 1px solid var(--vscode-button-border, transparent);
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
      font: inherit;
      cursor: pointer;
    }
    .rerun:hover { background: var(--vscode-button-secondaryHoverBackground); }
    .rerun:disabled {
      opacity: 0.65;
      cursor: default;
    }
    @keyframes spin {
      0% { transform: rotate(0deg); }
      100% { transform: rotate(360deg); }
    }
  </style>
</head>
<body>
  <ul>${listItems}</ul>
  <script nonce="${nonce}">
    const vscodeApi = acquireVsCodeApi();
    for (const button of document.querySelectorAll(".rerun")) {
      button.addEventListener("click", () => {
        const folder = button.getAttribute("data-folder");
        if (typeof folder === "string" && folder.length > 0) {
          vscodeApi.postMessage({ type: "rerun", folder });
        }
      });
    }
  </script>
</body>
</html>`;
}

class ResultsWebviewViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewId = "cursorTscRunner.results";

  private readonly extensionUri: vscode.Uri;
  private view: vscode.WebviewView | undefined;
  private latestRows: readonly ProjectStatusRow[] | undefined;
  private readonly onRerunFolder: (folder: string) => void;

  constructor(extensionUri: vscode.Uri, onRerunFolder: (folder: string) => void) {
    this.extensionUri = extensionUri;
    this.onRerunFolder = onRerunFolder;
  }

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void {
    this.view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri]
    };

    webviewView.webview.onDidReceiveMessage((message: unknown) => {
      if (isRerunMessage(message)) {
        this.onRerunFolder(message.folder);
      }
    });

    webviewView.onDidDispose(() => {
      this.view = undefined;
    });

    this.renderPanelHtml();
  }

  setRows(rows: readonly ProjectStatusRow[]): void {
    this.latestRows = rows;
    if (this.view) {
      this.renderPanelHtml();
    }
  }

  getLatestRows(): readonly ProjectStatusRow[] | undefined {
    return this.latestRows;
  }

  refreshPanelFromConfiguration(): void {
    this.renderPanelHtml();
  }

  private renderPanelHtml(): void {
    if (this.view === undefined) {
      return;
    }

    const fontSizePx = getResultsFontSizePx();
    const styleConfig = getResultsStyleConfig();

    if (this.latestRows === undefined) {
      this.view.webview.html = buildEmptyHtml(this.view.webview, fontSizePx, styleConfig);
      return;
    }

    this.view.webview.html = buildResultsHtml(this.view.webview, this.latestRows, fontSizePx, styleConfig);
  }
}

export function activate(context: vscode.ExtensionContext): void {
  const outputChannel = vscode.window.createOutputChannel("Cursor TSC Runner");
  context.subscriptions.push(outputChannel);

  let isRunning = false;
  let isDrainingQueuedReruns = false;
  const pendingFolderReruns = new Set<string>();

  const runAllTypeChecks = async (source: "manual" | "startup"): Promise<void> => {
    if (isRunning) {
      return;
    }
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
      if (source === "manual") {
        void vscode.window.showErrorMessage("No workspace folder is open.");
      }
      return;
    }

    const targetFolders = getConfiguredTargetFolders(workspaceFolder.uri.fsPath);
    if (targetFolders.length === 0) {
      if (source === "manual") {
        void vscode.window.showErrorMessage(
          "cursorTscRunner.targetFolders is empty or has no valid workspace-relative paths. Check Settings."
        );
      }
      return;
    }

    isRunning = true;
    let rows = syncRowsWithTargets(targetFolders, provider.getLatestRows());
    provider.setRows(rows);
    outputChannel.clear();
    outputChannel.appendLine(`Starting yarn tsc for ${targetFolders.length} folders (${source})...`);

    try {
      await vscode.window.withProgress(
        {
          location: source === "manual" ? vscode.ProgressLocation.Notification : vscode.ProgressLocation.Window,
          title: "Cursor TSC Runner",
          cancellable: false
        },
        async (progress: vscode.Progress<{ message?: string; increment?: number }>): Promise<void> => {
          const total = targetFolders.length;
          const maxParallel = Math.min(getMaxParallelChecks(), total);
          let done = 0;
          let started = 0;
          let active = 0;

          const runNext = async (): Promise<void> => {
            const currentIndex = started;
            if (currentIndex >= total) {
              return;
            }
            started += 1;
            active += 1;
            const folder = targetFolders[currentIndex];
            rows = rows.map((entry) => (entry.folder === folder ? { ...entry, outcome: "running" as const, durationMs: 0 } : entry));
            provider.setRows(rows);
            progress.report({
              message: `${done}/${total} finished (${active} running)`
            });

            const result = await runTypeCheck(workspaceFolder.uri.fsPath, folder);
            rows = rows.map((entry) => (entry.folder === folder ? statusRowFromResult(result) : entry));
            provider.setRows(rows);
            done += 1;
            active -= 1;

            const icon = result.succeeded ? "OK" : "FAIL";
            outputChannel.appendLine(`[${icon}] ${result.folder} - ${formatDuration(result.durationMs)} - ${result.message}`);

            if (result.stdout.length > 0) {
              outputChannel.appendLine("stdout:");
              outputChannel.appendLine(result.stdout.trim());
            }

            if (result.stderr.length > 0) {
              outputChannel.appendLine("stderr:");
              outputChannel.appendLine(result.stderr.trim());
            }

            outputChannel.appendLine("");
            progress.report({
              message: `${done}/${total} finished (${active} running)`
            });

            if (started < total) {
              await runNext();
            }
          };

          const workers: Promise<void>[] = [];
          for (let worker = 0; worker < maxParallel; worker += 1) {
            workers.push(runNext());
          }
          await Promise.all(workers);
        }
      );
      if (source === "manual") {
        void vscode.commands.executeCommand("workbench.view.extension.cursorTscRunnerSidebar");
      }
    } finally {
      isRunning = false;
      void drainQueuedFolderReruns();
    }
  };

  const runSingleTypeCheck = async (folder: string): Promise<void> => {
    if (isRunning) {
      pendingFolderReruns.add(folder);
      return;
    }
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
      return;
    }
    const targetFolders = getConfiguredTargetFolders(workspaceFolder.uri.fsPath);
    if (!targetFolders.includes(folder)) {
      return;
    }
    isRunning = true;
    try {
      let rows = provider.getLatestRows() ?? createInitialRows(targetFolders);
      rows = rows.map((entry) => (entry.folder === folder ? { ...entry, outcome: "running" as const, durationMs: 0 } : entry));
      provider.setRows(rows);
      const result = await runTypeCheck(workspaceFolder.uri.fsPath, folder);
      rows = rows.map((entry) => (entry.folder === folder ? statusRowFromResult(result) : entry));
      provider.setRows(rows);
      const icon = result.succeeded ? "OK" : "FAIL";
      outputChannel.appendLine(`[${icon}] ${result.folder} - ${formatDuration(result.durationMs)} - ${result.message}`);
      if (result.stdout.length > 0) {
        outputChannel.appendLine("stdout:");
        outputChannel.appendLine(result.stdout.trim());
      }
      if (result.stderr.length > 0) {
        outputChannel.appendLine("stderr:");
        outputChannel.appendLine(result.stderr.trim());
      }
      outputChannel.appendLine("");
    } finally {
      isRunning = false;
      void drainQueuedFolderReruns();
    }
  };

  const drainQueuedFolderReruns = async (): Promise<void> => {
    if (isRunning || isDrainingQueuedReruns) {
      return;
    }
    isDrainingQueuedReruns = true;
    try {
      while (!isRunning && pendingFolderReruns.size > 0) {
        const nextFolder = pendingFolderReruns.values().next().value as string | undefined;
        if (!nextFolder) {
          break;
        }
        pendingFolderReruns.delete(nextFolder);
        await runSingleTypeCheck(nextFolder);
      }
    } finally {
      isDrainingQueuedReruns = false;
    }
  };

  let saveRerunDebounceHandle: NodeJS.Timeout | undefined;
  let pendingSaveTargetFolder: string | undefined;
  const triggerRerunFromSave = (folder: string): void => {
    pendingSaveTargetFolder = folder;
    if (saveRerunDebounceHandle !== undefined) {
      clearTimeout(saveRerunDebounceHandle);
    }
    saveRerunDebounceHandle = setTimeout(() => {
      saveRerunDebounceHandle = undefined;
      const folderToRun = pendingSaveTargetFolder;
      pendingSaveTargetFolder = undefined;
      if (typeof folderToRun === "string" && folderToRun.length > 0) {
        void runSingleTypeCheck(folderToRun);
      }
    }, 600);
  };
  context.subscriptions.push(new vscode.Disposable(() => {
    if (saveRerunDebounceHandle !== undefined) {
      clearTimeout(saveRerunDebounceHandle);
      saveRerunDebounceHandle = undefined;
    }
  }));

  const provider = new ResultsWebviewViewProvider(context.extensionUri, (folder: string) => {
    void runSingleTypeCheck(folder);
  });
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(ResultsWebviewViewProvider.viewId, provider)
  );
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event: vscode.ConfigurationChangeEvent) => {
      if (event.affectsConfiguration(configSection)) {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (workspaceFolder) {
          provider.setRows(syncRowsWithTargets(getConfiguredTargetFolders(workspaceFolder.uri.fsPath), provider.getLatestRows()));
        }
        provider.refreshPanelFromConfiguration();
      }
    })
  );
  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument((document: vscode.TextDocument) => {
      if (!getAutoRunOnRelevantSave()) {
        return;
      }
      const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
      if (!workspaceFolder) {
        return;
      }
      const targetFolders = getConfiguredTargetFolders(workspaceFolder.uri.fsPath);
      if (targetFolders.length === 0) {
        return;
      }
      const relevantExtensions = getRelevantExtensions();
      const filePath = document.uri.fsPath;
      const fileName = path.basename(filePath);
      const ext = path.extname(filePath).toLowerCase();
      const relevantByName = alwaysRelevantFileNames.has(fileName);
      const relevantByExt = relevantExtensions.has(ext);
      if (!relevantByName && !relevantByExt) {
        return;
      }
      const targetFolder = resolveTargetFolderForFile(workspaceFolder.uri.fsPath, targetFolders, filePath);
      if (!targetFolder) {
        return;
      }
      triggerRerunFromSave(targetFolder);
    })
  );

  const disposable = vscode.commands.registerCommand(commandId, async (): Promise<void> => {
    await runAllTypeChecks("manual");
  });

  context.subscriptions.push(disposable);
  {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (workspaceFolder) {
      provider.setRows(syncRowsWithTargets(getConfiguredTargetFolders(workspaceFolder.uri.fsPath), provider.getLatestRows()));
    }
  }
  if (getAutoRunOnStart()) {
    void runAllTypeChecks("startup");
  }
}

export function deactivate(): void {}
