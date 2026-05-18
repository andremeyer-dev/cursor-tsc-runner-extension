import { exec, execFile } from "node:child_process";
import { constants as fsConstants, readFileSync } from "node:fs";
import { access, stat } from "node:fs/promises";
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

interface CiDisplay {
  readonly bubble: string;
  readonly title: string;
  readonly url?: string;
  readonly segment?: string;
}

interface ProjectStatusRow {
  readonly folder: string;
  readonly outcome: FolderOutcome;
  readonly durationMs: number;
  readonly message: string;
  readonly hasGithubWorkflows: boolean;
  readonly ci?: readonly CiDisplay[];
}

interface WorkflowGlobalJobRow {
  readonly repoLabel: string;
  readonly workflowRelPath: string;
  readonly jobTitle: string;
  readonly display: CiDisplay;
}

interface GithubWorkflowRun {
  readonly id: number;
  readonly head_sha?: string;
  readonly status: string;
  readonly conclusion: string | null;
  readonly html_url: string;
  readonly name: string | null;
  readonly created_at: string;
}

interface GithubActionsRunsApi {
  readonly workflow_runs?: GithubWorkflowRun[];
}

interface GithubWorkflowFile {
  readonly id: number;
  readonly path: string;
}

interface GithubWorkflowsListApi {
  readonly workflows?: readonly GithubWorkflowFile[];
}

interface GithubJob {
  readonly id: number;
  readonly name: string;
  readonly status: string;
  readonly conclusion: string | null;
  readonly html_url: string;
}

interface GithubJobsListApi {
  readonly jobs?: readonly GithubJob[];
}

interface GithubCheckRun {
  readonly name: string;
  readonly status: string;
  readonly conclusion: string | null;
  readonly html_url: string | null;
  readonly details_url: string | null;
}

interface GithubCheckRunsApi {
  readonly check_runs?: readonly GithubCheckRun[];
}

interface OpenUrlMessage {
  readonly type: "openUrl";
  readonly url: string;
}

interface ResultsAppearanceConfig {
  readonly paddingPx: number;
  readonly spinnerSize: number;
  readonly stripeEvenCss: string | undefined;
  readonly stripeOddCss: string | undefined;
  readonly rowBgSuccessCss: string | undefined;
  readonly rowBgFailedCss: string | undefined;
  readonly rowBgMissingCss: string | undefined;
  readonly rowBgIdleCss: string | undefined;
  readonly rowBgRunningCss: string | undefined;
}

const executeCommand = promisify(exec);
const executeFile = promisify(execFile);
const commandId = "cursorTscRunner.runTypeChecks";
const maxCommandBufferBytes = 8 * 1024 * 1024;
const folderNotFoundPrefix = "Folder not found:";
const configSection = "cursorTscRunner";
const resultsFontSizeKey = "resultsFontSize";
const targetFoldersKey = "targetFolders";
const autoRunOnStartKey = "autoRunOnStart";
const runOnSaveKey = "runOnSave";
const relevantRerunDebounceMsKey = "relevantRerunDebounceMs";
const maxParallelChecksKey = "maxParallelChecks";
const relevantExtensionsKey = "relevantExtensions";
const resultPaddingKey = "resultPadding";
const spinnerSizeKey = "resultsSpinnerSize";
const rowStripeEvenKey = "resultsRowStripeEvenBackground";
const rowStripeOddKey = "resultsRowStripeOddBackground";
const rowBgSuccessKey = "resultsRowBackgroundSuccess";
const rowBgFailedKey = "resultsRowBackgroundFailed";
const rowBgMissingKey = "resultsRowBackgroundMissing";
const rowBgIdleKey = "resultsRowBackgroundIdle";
const rowBgRunningKey = "resultsRowBackgroundRunning";
const githubTokenKey = "githubToken";
const githubTokenFileKey = "githubTokenFile";
const githubApiBaseUrlKey = "githubApiBaseUrl";
let resolvedGithubTokenCache = "";
const githubActionsRefreshMsKey = "githubActionsRefreshMs";
const githubCiWorkflowPathKey = "githubCiWorkflowPath";
const githubCiAdditionalWorkflowPathsKey = "githubCiAdditionalWorkflowPaths";
const githubCiDebugKey = "githubCiDebug";
const workflowNumericIdCache = new Map<string, number>();
const defaultGithubCiAdditionalWorkflowPaths: readonly string[] = [".github/workflows/helm-chart.yml"];
const defaultTargetFolders: readonly string[] = [
  "global-backend",
  "realm-core-backend",
  "realm-simulation-backend",
  "admin-frontend",
  "game-ui-frontend",
  "sso-backend",
  "image-server-backend",
  "wiki-frontend",
  "realm-gateway-backend",
  "armory-backend",
  "tech-admin-backend",
  "tech-admin-frontend",
  "sso-frontend",
  "landing-frontend",
  "world-authoring-frontend",
  "world-authoring-backend",
  "ai-lab-backend",
  "ai-lab-frontend",
  "landing-backend",
  "game-ui-backend",
  "tools/coverage-ui",
  "external-repos/api-client",
  "external-repos/auth-client",
  "external-repos/combat-engine",
  "external-repos/docs",
  "external-repos/environments",
  "external-repos/eslint-config",
  "external-repos/grpc-service",
  "external-repos/health-contract",
  "external-repos/movement-engine",
  "external-repos/pino-ecs-elastic",
  "external-repos/ui-theme",
  "external-repos/vitest-config"
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

async function pathIsWorkflowsDirectory(dirPath: string): Promise<boolean> {
  try {
    const stats = await stat(dirPath);
    return stats.isDirectory();
  } catch {
    return false;
  }
}

async function hasGithubWorkflowsInTree(workspaceRoot: string, folder: string): Promise<boolean> {
  const rootResolved = path.resolve(workspaceRoot);
  let current = path.resolve(workspaceRoot, folder);
  for (;;) {
    const candidate = path.join(current, ".github", "workflows");
    if (await pathIsWorkflowsDirectory(candidate)) {
      return true;
    }
    if (current === rootResolved) {
      return false;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return false;
    }
    const rel = path.relative(rootResolved, parent);
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
      return false;
    }
    current = parent;
  }
}

async function computeGithubWorkflowsFlags(
  workspaceRoot: string,
  targetFolders: readonly string[]
): Promise<Map<string, boolean>> {
  const flags = new Map<string, boolean>();
  await Promise.all(
    targetFolders.map(async (folder) => {
      flags.set(folder, await hasGithubWorkflowsInTree(workspaceRoot, folder));
    })
  );
  return flags;
}

async function gitExec(gitRoot: string, args: string[]): Promise<string | undefined> {
  try {
    const { stdout } = await executeFile("git", ["-C", gitRoot, ...args], { maxBuffer: maxCommandBufferBytes });
    const t = String(stdout).trim();
    return t.length > 0 ? t : undefined;
  } catch {
    return undefined;
  }
}

async function findGitRoot(startPath: string, workspaceRoot: string): Promise<string | undefined> {
  const rootResolved = path.resolve(workspaceRoot);
  let current = path.resolve(startPath);
  for (;;) {
    try {
      await access(path.join(current, ".git"), fsConstants.F_OK);
      return current;
    } catch {
      /* empty */
    }
    if (current === rootResolved) {
      return undefined;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return undefined;
    }
    const rel = path.relative(rootResolved, parent);
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
      return undefined;
    }
    current = parent;
  }
}

async function gitGetRemoteOriginUrl(gitRoot: string): Promise<string | undefined> {
  return gitExec(gitRoot, ["config", "--get", "remote.origin.url"]);
}

async function gitGetBranchOrSha(gitRoot: string): Promise<{ branch: string } | { sha: string } | undefined> {
  const branch = await gitExec(gitRoot, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (branch === undefined) {
    return undefined;
  }
  if (branch === "HEAD") {
    const sha = await gitExec(gitRoot, ["rev-parse", "HEAD"]);
    return sha === undefined ? undefined : { sha };
  }
  return { branch };
}

function parseGithubRemote(remoteUrl: string): { owner: string; repo: string; host: string } | undefined {
  const s = remoteUrl.trim();
  if (s === "") {
    return undefined;
  }
  const fromParsedUrl = (u: URL): { owner: string; repo: string; host: string } | undefined => {
    const proto = u.protocol.toLowerCase();
    if (proto !== "http:" && proto !== "https:" && proto !== "ssh:" && proto !== "git:") {
      return undefined;
    }
    const host = u.hostname.toLowerCase();
    if (host === "") {
      return undefined;
    }
    const segments = u.pathname.replace(/^\//, "").split("/").filter((p) => p.length > 0);
    if (segments.length < 2) {
      return undefined;
    }
    const repo = segments[segments.length - 1]!.replace(/\.git$/i, "");
    const owner = segments.slice(0, -1).join("/");
    if (owner === "" || repo === "") {
      return undefined;
    }
    return { host, owner, repo };
  };
  try {
    const parsed = fromParsedUrl(new URL(s));
    if (parsed !== undefined) {
      return parsed;
    }
  } catch {
    /* empty */
  }
  if (/^git@[^:]+:/i.exec(s)) {
    try {
      const rest = s.slice(4);
      const colonIdx = rest.indexOf(":");
      if (colonIdx > 0) {
        const hostPart = rest.slice(0, colonIdx);
        const pathPart = rest.slice(colonIdx + 1);
        const converted = `ssh://git@${hostPart}/${pathPart}`;
        const parsed = fromParsedUrl(new URL(converted));
        if (parsed !== undefined) {
          return parsed;
        }
      }
    } catch {
      /* empty */
    }
  }
  const scp = /^git@([^:]+):([^/]+)\/(.+?)(?:\.git)?$/i.exec(s);
  if (scp !== null) {
    const host = scp[1].toLowerCase();
    const owner = scp[2];
    const repo = scp[3].replace(/\.git$/i, "");
    return { host, owner, repo };
  }
  const https = /^https?:\/\/(?:[^@\s/]+@)?([^/]+)\/([^/]+)\/([^/?.#]+)(?:\/|$)/i.exec(s);
  if (https !== null) {
    const host = https[1].toLowerCase();
    const owner = https[2];
    const repo = https[3].replace(/\.git$/i, "");
    return { host, owner, repo };
  }
  return undefined;
}

function resolveGithubApiBaseUrl(host: string, configuredOverride: string): string {
  const override = configuredOverride.trim().replace(/\/$/, "");
  if (override.length > 0) {
    return override;
  }
  if (host === "github.com" || host.endsWith(".github.com")) {
    return "https://api.github.com";
  }
  return `https://${host}/api/v3`;
}

function readGithubTokenFromFile(absPath: string): string {
  try {
    const raw = readFileSync(absPath, "utf8");
    const first = raw
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .find((line) => line.length > 0 && !line.startsWith("#"));
    return first ?? "";
  } catch {
    return "";
  }
}

function getGithubTokenFileSetting(): string {
  const raw = vscode.workspace.getConfiguration(configSection).get<string>(githubTokenFileKey);
  if (typeof raw !== "string") {
    return ".docker/devcontainer/github-token";
  }
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : ".docker/devcontainer/github-token";
}

function resolveGithubTokenFromWorkspaceFiles(): string {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  if (!workspaceFolder) {
    return "";
  }
  const root = workspaceFolder.uri.fsPath;
  const configuredRel = getGithubTokenFileSetting();
  const candidates = [
    path.isAbsolute(configuredRel) ? configuredRel : path.join(root, configuredRel),
    path.join(root, ".docker/devcontainer/npm-auth-token"),
    path.join(root, ".docker/devcontainer/github-token"),
  ];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    const normalized = path.normalize(candidate);
    if (seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    const token = readGithubTokenFromFile(normalized);
    if (token.length > 0) {
      return token;
    }
  }
  return "";
}

function getGithubToken(): string {
  const raw = vscode.workspace.getConfiguration(configSection).get<string>(githubTokenKey);
  const inline = typeof raw === "string" ? raw.trim() : "";
  if (inline.length > 0) {
    return inline;
  }
  if (resolvedGithubTokenCache.length > 0) {
    return resolvedGithubTokenCache;
  }
  resolvedGithubTokenCache = resolveGithubTokenFromWorkspaceFiles();
  return resolvedGithubTokenCache;
}

function clearGithubTokenCache(): void {
  resolvedGithubTokenCache = "";
}

function getGithubApiBaseUrl(): string {
  const raw = vscode.workspace.getConfiguration(configSection).get<string>(githubApiBaseUrlKey);
  return typeof raw === "string" ? raw.trim() : "";
}

function getGithubActionsRefreshMs(): number {
  const raw = vscode.workspace.getConfiguration(configSection).get<number>(githubActionsRefreshMsKey);
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    return 120000;
  }
  return Math.min(3600000, Math.max(15000, Math.round(raw)));
}

function getGithubCiWorkflowPath(): string {
  const raw = vscode.workspace.getConfiguration(configSection).get<string>(githubCiWorkflowPathKey);
  if (typeof raw !== "string") {
    return ".github/workflows/ci.yml";
  }
  const t = raw.trim();
  return t.length > 0 ? t : ".github/workflows/ci.yml";
}

function normalizeWorkflowRepoPath(raw: string): string {
  return raw.trim().replace(/^\.\//, "");
}

function getGithubCiAdditionalWorkflowPaths(): readonly string[] {
  const raw = vscode.workspace.getConfiguration(configSection).get<unknown>(githubCiAdditionalWorkflowPathsKey);
  const primaryKey = normalizeWorkflowRepoPath(getGithubCiWorkflowPath());
  const primaryCmp = primaryKey.length > 0 ? primaryKey : ".github/workflows/ci.yml";
  let candidates: string[];
  if (!Array.isArray(raw)) {
    candidates = [...defaultGithubCiAdditionalWorkflowPaths];
  } else {
    candidates = raw
      .filter((item): item is string => typeof item === "string")
      .map((item) => normalizeWorkflowRepoPath(item))
      .filter((item) => item.length > 0);
  }
  const out: string[] = [];
  const seen = new Set<string>();
  for (const n of candidates) {
    if (n === primaryCmp) {
      continue;
    }
    if (seen.has(n)) {
      continue;
    }
    seen.add(n);
    out.push(n);
  }
  return out;
}

function getGithubCiDebug(): boolean {
  return vscode.workspace.getConfiguration(configSection).get<boolean>(githubCiDebugKey) === true;
}

async function githubApiGet(
  apiBase: string,
  resourcePath: string,
  token: string
): Promise<{ ok: true; data: unknown } | { ok: false; status: number; detail: string }> {
  const url = `${apiBase.replace(/\/$/, "")}${resourcePath}`;
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "cursor-tsc-runner-extension"
  };
  if (token.length > 0) {
    headers.Authorization = `Bearer ${token}`;
  }
  try {
    const res = await fetch(url, { headers });
    const text = await res.text();
    if (!res.ok) {
      return {
        ok: false,
        status: res.status,
        detail:
          res.status === 401 || res.status === 403
            ? `HTTP ${String(res.status)}: set cursorTscRunner.githubTokenFile (e.g. .docker/devcontainer/github-token) for private repos.`
            : `HTTP ${String(res.status)}: ${text.slice(0, 200)}`
      };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      return { ok: false, status: res.status, detail: "Invalid JSON from GitHub API" };
    }
    return { ok: true, data: parsed };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, status: 0, detail: msg };
  }
}

async function fetchWorkflowNumericId(
  apiBase: string,
  owner: string,
  repo: string,
  workflowPath: string,
  token: string
): Promise<number | undefined> {
  const norm = normalizeWorkflowRepoPath(workflowPath);
  const cacheKey = `${apiBase}|${owner}|${repo}|${norm}`;
  const hit = workflowNumericIdCache.get(cacheKey);
  if (hit !== undefined) {
    return hit;
  }
  let page = 1;
  for (;;) {
    const r = await githubApiGet(
      apiBase,
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/workflows?page=${String(page)}&per_page=100`,
      token
    );
    if (!r.ok) {
      return undefined;
    }
    const body = r.data as GithubWorkflowsListApi;
    const list = body.workflows ?? [];
    for (const w of list) {
      if (w.path === norm) {
        workflowNumericIdCache.set(cacheKey, w.id);
        return w.id;
      }
    }
    if (list.length < 100) {
      return undefined;
    }
    page += 1;
  }
}

type JobsFetchResult = { kind: "ok"; jobs: readonly GithubJob[] } | { kind: "error"; detail: string };

async function fetchJobsForRun(
  apiBase: string,
  owner: string,
  repo: string,
  runId: number,
  token: string
): Promise<JobsFetchResult> {
  const all: GithubJob[] = [];
  let page = 1;
  for (;;) {
    const r = await githubApiGet(
      apiBase,
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/runs/${String(runId)}/jobs?per_page=100&page=${String(page)}&filter=all`,
      token
    );
    if (!r.ok) {
      return { kind: "error", detail: r.detail };
    }
    const body = r.data as GithubJobsListApi;
    const batch = body.jobs ?? [];
    for (const j of batch) {
      all.push(j);
    }
    if (batch.length < 100) {
      break;
    }
    page += 1;
  }
  return { kind: "ok", jobs: all };
}

async function fetchCheckRunsAsJobs(
  apiBase: string,
  owner: string,
  repo: string,
  headSha: string,
  token: string
): Promise<JobsFetchResult> {
  const all: GithubJob[] = [];
  let page = 1;
  for (;;) {
    const r = await githubApiGet(
      apiBase,
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits/${encodeURIComponent(headSha)}/check-runs?per_page=100&page=${String(page)}`,
      token
    );
    if (!r.ok) {
      return { kind: "error", detail: r.detail };
    }
    const body = r.data as GithubCheckRunsApi;
    const batch = body.check_runs ?? [];
    for (const cr of batch) {
      const url =
        typeof cr.html_url === "string" && cr.html_url.length > 0
          ? cr.html_url
          : typeof cr.details_url === "string" && cr.details_url.length > 0
            ? cr.details_url
            : "";
      all.push({
        id: 0,
        name: cr.name,
        status: cr.status,
        conclusion: cr.conclusion,
        html_url: url.length > 0 ? url : `https://github.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions`
      });
    }
    if (batch.length < 100) {
      break;
    }
    page += 1;
  }
  return { kind: "ok", jobs: all };
}

type FetchWorkflowBundle =
  | { kind: "ok"; run: GithubWorkflowRun; jobs: readonly GithubJob[]; workflowRunJobsOnly: readonly GithubJob[] }
  | { kind: "empty" }
  | { kind: "error"; detail: string };

async function fetchLatestWorkflowRunForWorkflow(
  apiBase: string,
  owner: string,
  repo: string,
  workflowId: number,
  ref: { branch: string } | { sha: string },
  token: string
): Promise<FetchWorkflowBundle> {
  let query = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/workflows/${String(workflowId)}/runs?per_page=1`;
  if ("branch" in ref) {
    query += `&branch=${encodeURIComponent(ref.branch)}`;
  } else {
    query += `&head_sha=${encodeURIComponent(ref.sha)}`;
  }
  const r = await githubApiGet(apiBase, query, token);
  if (!r.ok) {
    return { kind: "error", detail: r.detail };
  }
  const body = r.data as GithubActionsRunsApi;
  const first = body.workflow_runs?.[0];
  if (first === undefined) {
    return { kind: "empty" };
  }
  let fromJobs: GithubJob[] = [];
  const jobsResult = await fetchJobsForRun(apiBase, owner, repo, first.id, token);
  if (jobsResult.kind === "ok") {
    fromJobs = [...jobsResult.jobs];
  }
  let merged: GithubJob[] = fromJobs;
  const sha = first.head_sha;
  if (typeof sha === "string" && /^[0-9a-f]{7,40}$/i.test(sha)) {
    const cr = await fetchCheckRunsAsJobs(apiBase, owner, repo, sha, token);
    if (cr.kind === "ok" && cr.jobs.length > 0) {
      merged = mergeJobsByEoCiKey(cr.jobs, fromJobs);
    }
  }
  return { kind: "ok", run: first, jobs: merged, workflowRunJobsOnly: fromJobs };
}

function parseEoCiJobLabel(jobName: string): { readonly row: string; readonly segment: string; readonly slug: string } | undefined {
  const m = /\beo-ci\|([^|]+)\|([^|]+)\|([^\s|()]+)/.exec(jobName.trim());
  if (m === null) {
    return undefined;
  }
  return { row: m[1], segment: m[2], slug: m[3] };
}

const CI_MATRIX_PATH_TO_TARGET_FOLDERS: Readonly<Record<string, readonly string[]>> = {
  "global-backend": ["global-backend"],
  "sso-backend": ["sso-backend"],
  "auth-client": ["external-repos/auth-client"],
  "game-ui": ["game-ui-frontend"],
  "admin": ["admin-frontend"],
  "ionos-openai-proxy": ["ionos-openai-proxy"],
  "image_server": ["image-server-backend"],
  "image-server": ["image-server-backend"],
  "backend": ["backend"]
};

function mapCiMatrixPathToTargetFolders(matrixPathRaw: string): readonly string[] {
  const raw = matrixPathRaw.trim();
  const variants = [raw, raw.replace(/_/g, "-"), raw.replace(/-/g, "_")];
  for (const v of variants) {
    const mapped = CI_MATRIX_PATH_TO_TARGET_FOLDERS[v];
    if (mapped !== undefined) {
      return mapped;
    }
  }
  return [raw];
}

interface ParsedCiJobLabel {
  readonly rows: readonly string[];
  readonly segment: string;
  readonly slug: string;
}

function stripWorkflowNamePrefixesFromJobTitle(name: string): string {
  let current = name.trim();
  for (let i = 0; i < 6; i += 1) {
    const next = current.replace(/^[^/\n]{1,160}\/\s*/, "").trim();
    if (next === current) {
      break;
    }
    current = next;
  }
  return current;
}

function candidateJobTitlesForParsing(raw: string): readonly string[] {
  const t = raw.trim();
  const out: string[] = [t];
  const stripped = stripWorkflowNamePrefixesFromJobTitle(t);
  if (stripped !== t && stripped.length > 0) {
    out.push(stripped);
  }
  return out;
}

function parseLegacyGithubActionsMatrixJobName(jobName: string): ParsedCiJobLabel | undefined {
  const t = jobName.trim();
  const knip = /^knip \(([^)]+)\)\s*$/i.exec(t);
  if (knip !== null) {
    const rows = mapCiMatrixPathToTargetFolders(knip[1]);
    const slugPart = knip[1].trim().replace(/\//g, "-");
    return { rows, segment: "knip", slug: `knip-${slugPart}` };
  }
  const mig = /^migration check \(([^)]+)\)\s*$/i.exec(t);
  if (mig !== null) {
    const rows = mapCiMatrixPathToTargetFolders(mig[1]);
    return { rows, segment: "migration", slug: `migration-${mig[1].trim().replace(/\//g, "-")}` };
  }
  const smoke = /^(.+?) \(smoke\)\s*$/i.exec(t);
  if (smoke !== null) {
    const rows = mapCiMatrixPathToTargetFolders(smoke[1].trim());
    return { rows, segment: "smoke", slug: `smoke-${smoke[1].trim().replace(/\//g, "-")}` };
  }
  const tests = /^(.+?) \((vitest|full quality gate)\)\s*$/i.exec(t);
  if (tests !== null) {
    const rows = mapCiMatrixPathToTargetFolders(tests[1].trim());
    return { rows, segment: "tests", slug: `tests-${tests[1].trim().replace(/\//g, "-")}` };
  }
  return undefined;
}

function parseCiJobLabel(jobName: string): ParsedCiJobLabel | undefined {
  for (const cand of candidateJobTitlesForParsing(jobName)) {
    const eo = parseEoCiJobLabel(cand);
    if (eo !== undefined) {
      return { rows: [eo.row], segment: eo.segment, slug: eo.slug };
    }
    const legacy = parseLegacyGithubActionsMatrixJobName(cand);
    if (legacy !== undefined) {
      return legacy;
    }
  }
  return undefined;
}

function mergeJobsByEoCiKey(secondary: readonly GithubJob[], primary: readonly GithubJob[]): GithubJob[] {
  const map = new Map<string, GithubJob>();
  const keyOf = (j: GithubJob): string => {
    const p = parseCiJobLabel(j.name);
    if (p !== undefined) {
      return `p:${[...p.rows].sort().join("|")}:${p.segment}:${p.slug}`;
    }
    return `n:${j.name}`;
  };
  for (const j of secondary) {
    map.set(keyOf(j), j);
  }
  for (const j of primary) {
    map.set(keyOf(j), j);
  }
  return [...map.values()];
}

function segmentRank(segment: string): number {
  const order = ["tests", "knip", "smoke", "migration"];
  const idx = order.indexOf(segment);
  return idx >= 0 ? idx : 100;
}

function jobToCiDisplay(job: GithubJob, segment: string): CiDisplay {
  const st = job.status;
  const cn = job.conclusion;
  let bubble = "⚪";
  if (st === "queued" || st === "waiting" || st === "requested" || st === "pending") {
    bubble = "🟡";
  } else if (st === "in_progress") {
    bubble = "⏳";
  } else if (st === "completed") {
    if (cn === "success") {
      bubble = "🟢";
    } else if (cn === "failure") {
      bubble = "🔴";
    } else if (cn === "cancelled") {
      bubble = "⚫";
    } else if (cn === "skipped") {
      bubble = "⏭️";
    } else if (cn === "neutral") {
      bubble = "⚪";
    } else {
      bubble = "🔴";
    }
  }
  const titleParts: string[] = [segment, job.name, st];
  if (cn !== null && cn.length > 0) {
    titleParts.push(cn);
  }
  return { bubble, title: titleParts.join(" · "), url: job.html_url, segment };
}

function compareJobsBySegment(a: { readonly segment: string; readonly slug: string }, b: { readonly segment: string; readonly slug: string }): number {
  const d = segmentRank(a.segment) - segmentRank(b.segment);
  if (d !== 0) {
    return d;
  }
  return a.slug.localeCompare(b.slug);
}

function normalizeCiFolderKey(folder: string): string {
  return folder.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
}

function ciRowMatchesTargetFolder(folderNorm: string, rowNorm: string): boolean {
  if (rowNorm === folderNorm) {
    return true;
  }
  if (folderNorm.endsWith(`/${rowNorm}`)) {
    return true;
  }
  if (rowNorm.endsWith(`/${folderNorm}`)) {
    return true;
  }
  return false;
}

function buildFolderCiDisplays(folder: string, jobs: readonly GithubJob[]): readonly CiDisplay[] {
  const folderNorm = normalizeCiFolderKey(folder);
  const hits: { readonly job: GithubJob; readonly segment: string; readonly slug: string }[] = [];
  for (const job of jobs) {
    const parsed = parseCiJobLabel(job.name);
    if (parsed === undefined) {
      continue;
    }
    for (const row of parsed.rows) {
      const rowNorm = normalizeCiFolderKey(row);
      if (ciRowMatchesTargetFolder(folderNorm, rowNorm)) {
        hits.push({ job, segment: parsed.segment, slug: parsed.slug });
        break;
      }
    }
  }
  if (hits.length === 0) {
    return [];
  }
  const sorted = [...hits].sort((x, y) => compareJobsBySegment(x, y));
  return sorted.map((h) => jobToCiDisplay(h.job, h.segment));
}

function collectGlobalWorkflowJobRowsForMergedJobs(
  jobs: readonly GithubJob[],
  repoLabel: string,
  workflowRelPath: string
): WorkflowGlobalJobRow[] {
  const out: WorkflowGlobalJobRow[] = [];
  for (const job of jobs) {
    if (parseCiJobLabel(job.name) !== undefined) {
      continue;
    }
    out.push({
      repoLabel,
      workflowRelPath,
      jobTitle: stripWorkflowNamePrefixesFromJobTitle(job.name),
      display: jobToCiDisplay(job, "repo")
    });
  }
  return out;
}

type FetchWorkflowResult = { kind: "ok"; run: GithubWorkflowRun } | { kind: "empty" } | { kind: "error"; detail: string };

type GithubFetchBucket =
  | { readonly mode: "legacy"; readonly result: FetchWorkflowResult }
  | { readonly mode: "workflow"; readonly result: FetchWorkflowBundle };

async function fetchLatestWorkflowRun(
  apiBase: string,
  owner: string,
  repo: string,
  ref: { branch: string } | { sha: string },
  token: string
): Promise<FetchWorkflowResult> {
  let query = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/runs?per_page=1`;
  if ("branch" in ref) {
    query += `&branch=${encodeURIComponent(ref.branch)}`;
  } else {
    query += `&head_sha=${encodeURIComponent(ref.sha)}`;
  }
  const r = await githubApiGet(apiBase, query, token);
  if (!r.ok) {
    return { kind: "error", detail: r.detail };
  }
  const body = r.data as GithubActionsRunsApi;
  const first = body.workflow_runs?.[0];
  if (first === undefined) {
    return { kind: "empty" };
  }
  return { kind: "ok", run: first };
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

function statusRowFromResult(result: TypeCheckResult, previous: ProjectStatusRow | undefined): ProjectStatusRow {
  const keep =
    previous !== undefined && previous.folder === result.folder
      ? { wf: previous.hasGithubWorkflows, ci: previous.ci }
      : { wf: false, ci: undefined };
  return {
    folder: result.folder,
    outcome: outcomeFor(result),
    durationMs: result.durationMs,
    message: result.message,
    hasGithubWorkflows: keep.wf,
    ci: keep.ci
  };
}

function createInitialRows(targetFolders: readonly string[]): ProjectStatusRow[] {
  return targetFolders.map((folder) => ({
    folder,
    outcome: "idle",
    durationMs: 0,
    message: "",
    hasGithubWorkflows: false,
    ci: undefined
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
  return targetFolders.map(
    (folder) =>
      map.get(folder) ?? {
        folder,
        outcome: "idle",
        durationMs: 0,
        message: "",
        hasGithubWorkflows: false,
        ci: undefined
      }
  );
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

function cssBackgroundValue(raw: string): string {
  return raw.replace(/<\/style/gi, "\\3C /style");
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

function getRunOnSave(): boolean {
  const raw = vscode.workspace.getConfiguration(configSection).get<boolean>(runOnSaveKey);
  return raw !== false;
}

function getRelevantRerunDebounceMs(): number {
  const raw = vscode.workspace.getConfiguration(configSection).get<number>(relevantRerunDebounceMsKey);
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    return 800;
  }
  return Math.min(60000, Math.max(0, Math.round(raw)));
}

function getMaxParallelChecks(): number {
  const raw = vscode.workspace.getConfiguration(configSection).get<number>(maxParallelChecksKey);
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    return 2;
  }
  return Math.min(16, Math.max(1, Math.round(raw)));
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

function getOptionalCssBackground(key: string): string | undefined {
  const raw = vscode.workspace.getConfiguration(configSection).get<unknown>(key);
  if (typeof raw !== "string") {
    return undefined;
  }
  const trimmed = raw.trim();
  return trimmed === "" ? undefined : cssBackgroundValue(trimmed);
}

function getResultsAppearanceConfig(): ResultsAppearanceConfig {
  const paddingPx = getNumberSetting(resultPaddingKey, 0, 0, 32);
  return {
    paddingPx,
    spinnerSize: getNumberSetting(spinnerSizeKey, 6, 6, 24),
    stripeEvenCss: getOptionalCssBackground(rowStripeEvenKey),
    stripeOddCss: getOptionalCssBackground(rowStripeOddKey),
    rowBgSuccessCss: getOptionalCssBackground(rowBgSuccessKey),
    rowBgFailedCss: getOptionalCssBackground(rowBgFailedKey),
    rowBgMissingCss: getOptionalCssBackground(rowBgMissingKey),
    rowBgIdleCss: getOptionalCssBackground(rowBgIdleKey),
    rowBgRunningCss: getOptionalCssBackground(rowBgRunningKey)
  };
}

function buildOptionalRowBackgroundRules(appearance: ResultsAppearanceConfig): string {
  const parts: string[] = [];
  const stripeOdd = appearance.stripeOddCss;
  const stripeEven = appearance.stripeEvenCss;
  if (stripeOdd !== undefined || stripeEven !== undefined) {
    const oddVal = stripeOdd ?? "var(--vscode-editor-background)";
    const evenVal = stripeEven ?? "var(--vscode-editor-background)";
    parts.push(`tbody tr.row:nth-child(odd):not(.row-idle) td { background: ${oddVal}; }`);
    parts.push(`tbody tr.row:nth-child(even):not(.row-idle) td { background: ${evenVal}; }`);
  }
  if (appearance.rowBgSuccessCss !== undefined) {
    parts.push(`tbody tr.row-ok td { background: ${appearance.rowBgSuccessCss}; }`);
  }
  if (appearance.rowBgFailedCss !== undefined) {
    parts.push(`tbody tr.row-fail:not(.row-missing) td { background: ${appearance.rowBgFailedCss}; }`);
  }
  if (appearance.rowBgMissingCss !== undefined) {
    parts.push(`tbody tr.row-missing td { background: ${appearance.rowBgMissingCss}; }`);
  }
  if (appearance.rowBgIdleCss !== undefined) {
    parts.push(`tbody tr.row-idle td { background: ${appearance.rowBgIdleCss}; }`);
  }
  if (appearance.rowBgRunningCss !== undefined) {
    parts.push(`tbody tr.row-running td { background: ${appearance.rowBgRunningCss}; }`);
  }
  return parts.join("\n    ");
}

function isRerunMessage(value: unknown): value is RerunMessage {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const maybeType = (value as { readonly type?: unknown }).type;
  const maybeFolder = (value as { readonly folder?: unknown }).folder;
  return maybeType === "rerun" && typeof maybeFolder === "string" && maybeFolder.trim().length > 0;
}

function isOpenUrlMessage(value: unknown): value is OpenUrlMessage {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const maybeType = (value as { readonly type?: unknown }).type;
  const maybeUrl = (value as { readonly url?: unknown }).url;
  return maybeType === "openUrl" && typeof maybeUrl === "string" && /^https:\/\//i.test(maybeUrl);
}

function buildEmptyHtml(webview: vscode.Webview, fontSizePx: number, appearance: ResultsAppearanceConfig): string {
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
      padding: ${appearance.paddingPx}px;
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

function partitionCiDisplaysForColumns(ciList: readonly CiDisplay[]): {
  readonly testsColumn: readonly CiDisplay[];
  readonly knipColumn: readonly CiDisplay[];
} {
  const testsColumn: CiDisplay[] = [];
  const knipColumn: CiDisplay[] = [];
  for (const c of ciList) {
    if (c.segment === "knip") {
      knipColumn.push(c);
    } else {
      testsColumn.push(c);
    }
  }
  return { testsColumn, knipColumn };
}

function buildCiBubblesCellHtml(displays: readonly CiDisplay[]): string {
  if (displays.length === 0) {
    return "&nbsp;";
  }
  const parts: string[] = [];
  for (const c of displays) {
    const ciBubbleChar = escapeHtml(c.bubble);
    const ciTitle = escapeHtml(c.title);
    const ciUrl = c.url;
    if (typeof ciUrl === "string" && /^https:\/\//i.test(ciUrl)) {
      parts.push(
        `<button type="button" class="bubble bubble-ci ci-link" title="${ciTitle}" data-url="${escapeHtml(ciUrl)}" aria-label="${ciTitle}">${ciBubbleChar}</button>`
      );
    } else {
      parts.push(`<span class="bubble bubble-ci" title="${ciTitle}" aria-hidden="true">${ciBubbleChar}</span>`);
    }
  }
  return `<span class="ci-bubbles">${parts.join("")}</span>`;
}

function buildGlobalWorkflowTableHtml(rows: readonly WorkflowGlobalJobRow[]): string {
  if (rows.length === 0) {
    return "";
  }
  const distinctRepos = new Set(rows.map((r) => r.repoLabel));
  const distinctWf = new Set(rows.map((r) => r.workflowRelPath));
  const showRepo = distinctRepos.size > 1;
  const showWorkflow = distinctWf.size > 1;
  let head: string;
  if (showRepo && showWorkflow) {
    head =
      '<tr><th scope="col" class="col-wg-repo">Repo</th><th scope="col" class="col-wg-wf">Workflow</th><th scope="col" class="col-wg-job">Job</th><th scope="col" class="col-wg-status">Status</th></tr>';
  } else if (showRepo) {
    head = '<tr><th scope="col" class="col-wg-repo">Repo</th><th scope="col" class="col-wg-job">Job</th><th scope="col" class="col-wg-status">Status</th></tr>';
  } else if (showWorkflow) {
    head =
      '<tr><th scope="col" class="col-wg-wf">Workflow</th><th scope="col" class="col-wg-job">Job</th><th scope="col" class="col-wg-status">Status</th></tr>';
  } else {
    head = '<tr><th scope="col" class="col-wg-job">Job</th><th scope="col" class="col-wg-status">Status</th></tr>';
  }
  const body = rows
    .map((r) => {
      const jobEsc = escapeHtml(r.jobTitle);
      const statusCell = buildCiBubblesCellHtml([r.display]);
      if (showRepo && showWorkflow) {
        return `<tr class="row row-wg"><td class="col-wg-repo">${escapeHtml(r.repoLabel)}</td><td class="col-wg-wf">${escapeHtml(r.workflowRelPath)}</td><td class="col-wg-job">${jobEsc}</td><td class="col-wg-status">${statusCell}</td></tr>`;
      }
      if (showRepo) {
        return `<tr class="row row-wg"><td class="col-wg-repo">${escapeHtml(r.repoLabel)}</td><td class="col-wg-job">${jobEsc}</td><td class="col-wg-status">${statusCell}</td></tr>`;
      }
      if (showWorkflow) {
        return `<tr class="row row-wg"><td class="col-wg-wf">${escapeHtml(r.workflowRelPath)}</td><td class="col-wg-job">${jobEsc}</td><td class="col-wg-status">${statusCell}</td></tr>`;
      }
      return `<tr class="row row-wg"><td class="col-wg-job">${jobEsc}</td><td class="col-wg-status">${statusCell}</td></tr>`;
    })
    .join("");
  return `<div class="workflow-global-wrap"><div class="workflow-global-heading">Main CI (non-folder jobs)</div><table class="results-table workflow-global-table" aria-label="Main CI non-folder jobs"><thead>${head}</thead><tbody>${body}</tbody></table></div>`;
}

function buildResultsHtml(
  webview: vscode.Webview,
  rows: readonly ProjectStatusRow[],
  globalWorkflowJobRows: readonly WorkflowGlobalJobRow[],
  fontSizePx: number,
  appearance: ResultsAppearanceConfig
): string {
  const nonce = String(Date.now());
  const csp = ["default-src 'none'", `style-src ${webview.cspSource} 'unsafe-inline'`, `script-src 'nonce-${nonce}'`].join("; ");
  const cspAttr = escapeHtml(csp);
  const fontEsc = escapeHtml(String(fontSizePx));

  const tableBodyRows = rows
    .map((row) => {
      const outcome = row.outcome;
      const bubble = bubbleFor(outcome);
      const rowClass =
        outcome === "missing"
          ? "row-fail row-missing"
          : rowClassFor(outcome);
      const folder = escapeHtml(row.folder);
      const durationText = row.durationMs > 0 ? `(${formatDuration(row.durationMs)})` : "";
      const dur = escapeHtml(durationText);
      const spinner = outcome === "running" ? '<span class="spinner" aria-hidden="true"></span>' : "";
      const disabled = outcome === "running" ? "disabled" : "";
      const missingMessage = row.message.length > 0 ? row.message : `${folderNotFoundPrefix} ${row.folder}`;
      const infoIcon = outcome === "missing"
        ? `<span class="info" title="${escapeHtml(missingMessage)}" aria-label="${escapeHtml(missingMessage)}">ℹ</span>`
        : "";
      const ciList = row.hasGithubWorkflows ? row.ci ?? [] : [];
      let testsCell = "&nbsp;";
      let knipCell = "&nbsp;";
      if (row.hasGithubWorkflows && ciList.length > 0) {
        const { testsColumn, knipColumn } = partitionCiDisplaysForColumns(ciList);
        testsCell = buildCiBubblesCellHtml(testsColumn);
        knipCell = buildCiBubblesCellHtml(knipColumn);
      }
      const tscCell =
        outcome === "running"
          ? `<span class="col-tsc-inner">${spinner}</span>`
          : `<span class="col-tsc-inner">${spinner}<span class="bubble" aria-hidden="true">${bubble}</span></span>`;
      return `<tr class="row ${rowClass}"><td class="col-tsc">${tscCell}</td><td class="col-tests">${testsCell}</td><td class="col-knip">${knipCell}</td><td class="col-folder"><span class="folder">${folder}</span> ${infoIcon}</td><td class="col-dur"><span class="dur">${dur}</span></td><td class="col-action"><button class="rerun" data-folder="${folder}" type="button" ${disabled}>Rerun</button></td></tr>`;
    })
    .join("");

  const optionalRowBackgrounds = buildOptionalRowBackgroundRules(appearance);
  const globalWorkflowTableHtml = buildGlobalWorkflowTableHtml(globalWorkflowJobRows);

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
      padding: ${appearance.paddingPx}px;
      margin: 0;
      line-height: 1.25;
    }
    .results-table {
      width: 100%;
      border-collapse: collapse;
      table-layout: fixed;
      margin: 0;
    }
    .results-table thead th {
      text-align: left;
      font-weight: 600;
      font-size: 0.92em;
      opacity: 0.92;
      padding: 4px 3px 8px 3px;
      border-bottom: 1px solid var(--vscode-widget-border);
      vertical-align: bottom;
    }
    .results-table thead th.col-tsc,
    .results-table thead th.col-tests,
    .results-table thead th.col-knip {
      text-align: center;
    }
    .results-table tbody td {
      padding: ${appearance.paddingPx}px 4px;
      vertical-align: middle;
      border-bottom: 1px solid var(--vscode-widget-border);
    }
    .results-table tbody td.col-tsc,
    .results-table tbody td.col-tests,
    .results-table tbody td.col-knip {
      padding-left: 1px;
      padding-right: 1px;
    }
    .results-table tbody tr.row td {
      background: var(--vscode-editor-background);
    }
    col.cw-tsc { width: 1.85rem; }
    col.cw-tests { width: 1.85rem; }
    col.cw-knip { width: 1.85rem; }
    col.cw-dur { width: 3.5rem; }
    col.cw-action { width: 3.6rem; }
    .col-tsc {
      text-align: center;
      white-space: nowrap;
    }
    .col-tests,
    .col-knip {
      text-align: center;
      white-space: nowrap;
      overflow-x: auto;
      overflow-y: hidden;
    }
    .col-folder {
      min-width: 0;
      word-break: break-word;
    }
    .col-dur {
      white-space: nowrap;
      text-align: right;
      opacity: 0.9;
    }
    .col-action {
      text-align: right;
      white-space: nowrap;
    }
    .col-tsc-inner {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 2px;
    }
    .sr-only {
      position: absolute;
      width: 1px;
      height: 1px;
      padding: 0;
      margin: -1px;
      overflow: hidden;
      clip: rect(0, 0, 0, 0);
      border: 0;
    }
    tbody tr.row > td:first-child {
      box-shadow: inset 0 0 0 transparent;
    }
    tbody tr.row-ok > td:first-child {
      box-shadow: inset 2px 0 0 0 var(--vscode-testing-iconPassed, #3fb950);
    }
    tbody tr.row-fail > td:first-child {
      box-shadow: inset 2px 0 0 0 var(--vscode-testing-iconFailed, #f85149);
    }
    tbody tr.row-idle > td:first-child {
      box-shadow: inset 2px 0 0 0 var(--vscode-disabledForeground);
    }
    tbody tr.row-running > td:first-child {
      box-shadow: inset 2px 0 0 0 var(--vscode-progressBar-background);
    }
    tbody tr.row-idle td {
      background: color-mix(in srgb, var(--vscode-editor-background) 80%, var(--vscode-disabledForeground) 20%);
    }
    ${optionalRowBackgrounds}
    .bubble:not(.bubble-ci) { flex-shrink: 0; }
    .bubble-ci {
      opacity: 0.9;
      vertical-align: middle;
      flex-shrink: 0;
    }
    .ci-bubbles {
      display: inline-flex;
      align-items: center;
      gap: 2px;
      flex-shrink: 0;
      white-space: nowrap;
    }
    .ci-link {
      font: inherit;
      color: inherit;
      padding: 0;
      margin: 0;
      border: none;
      background: none;
      cursor: pointer;
    }
    .ci-link:hover { opacity: 1; }
    .folder { font-weight: 500; }
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
      vertical-align: middle;
    }
    .spinner {
      width: ${appearance.spinnerSize}px;
      height: ${appearance.spinnerSize}px;
      border-radius: 999px;
      border: 2px solid var(--vscode-progressBar-background);
      border-right-color: transparent;
      display: inline-block;
      animation: spin 0.9s linear infinite;
      margin-right: 2px;
      flex: 0 0 auto;
    }
    .rerun {
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
    .workflow-global-wrap {
      margin-bottom: 10px;
    }
    .workflow-global-heading {
      font-size: 0.88em;
      font-weight: 600;
      opacity: 0.9;
      margin-bottom: 4px;
    }
    .workflow-global-table {
      table-layout: auto;
      width: 100%;
    }
    .workflow-global-table thead th {
      text-align: left;
      font-weight: 600;
      font-size: 0.88em;
      opacity: 0.92;
      padding: 3px 3px 6px 3px;
      border-bottom: 1px solid var(--vscode-widget-border);
      vertical-align: bottom;
    }
    .workflow-global-table thead th.col-wg-status {
      text-align: center;
      width: 2.5rem;
    }
    .workflow-global-table tbody td {
      padding: ${appearance.paddingPx}px 4px;
      vertical-align: middle;
      border-bottom: 1px solid var(--vscode-widget-border);
      background: var(--vscode-editor-background);
    }
    .workflow-global-table tbody td.col-wg-status {
      text-align: center;
      white-space: nowrap;
      padding-left: 1px;
      padding-right: 1px;
    }
    .col-wg-repo {
      width: 32%;
      max-width: 12rem;
      min-width: 0;
      word-break: break-word;
    }
    .col-wg-wf {
      width: 22%;
      max-width: 14rem;
      min-width: 0;
      word-break: break-all;
      font-size: 0.92em;
      opacity: 0.95;
    }
    .col-wg-job {
      min-width: 0;
      word-break: break-word;
    }
  </style>
</head>
<body>
  ${globalWorkflowTableHtml}
  <table class="results-table">
    <colgroup>
      <col class="cw-tsc" />
      <col class="cw-tests" />
      <col class="cw-knip" />
      <col />
      <col class="cw-dur" />
      <col class="cw-action" />
    </colgroup>
    <thead>
      <tr>
        <th class="col-tsc" scope="col">TSC</th>
        <th class="col-tests" scope="col">Tests</th>
        <th class="col-knip" scope="col">Knip</th>
        <th class="col-folder" scope="col">Folder/name</th>
        <th class="col-dur" scope="col">Time</th>
        <th class="col-action" scope="col"><span class="sr-only">Buttons</span></th>
      </tr>
    </thead>
    <tbody>${tableBodyRows}</tbody>
  </table>
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
    for (const button of document.querySelectorAll(".ci-link")) {
      button.addEventListener("click", () => {
        const url = button.getAttribute("data-url");
        if (typeof url === "string" && url.length > 0) {
          vscodeApi.postMessage({ type: "openUrl", url });
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
  private latestGlobalWorkflowJobRows: readonly WorkflowGlobalJobRow[] = [];
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
        return;
      }
      if (isOpenUrlMessage(message)) {
        void vscode.env.openExternal(vscode.Uri.parse(message.url));
      }
    });

    webviewView.onDidDispose(() => {
      this.view = undefined;
    });

    this.renderPanelHtml();
  }

  setRows(rows: readonly ProjectStatusRow[], globalWorkflowJobRows?: readonly WorkflowGlobalJobRow[]): void {
    this.latestRows = rows;
    if (globalWorkflowJobRows !== undefined) {
      this.latestGlobalWorkflowJobRows = globalWorkflowJobRows;
    }
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
    const appearance = getResultsAppearanceConfig();

    if (this.latestRows === undefined) {
      this.view.webview.html = buildEmptyHtml(this.view.webview, fontSizePx, appearance);
      return;
    }

    this.view.webview.html = buildResultsHtml(
      this.view.webview,
      this.latestRows,
      this.latestGlobalWorkflowJobRows,
      fontSizePx,
      appearance
    );
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
    await refreshGithubCi();
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
            rows = rows.map((entry) =>
              entry.folder === folder ? statusRowFromResult(result, entry) : entry
            );
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
      void refreshGithubCi();
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
    void refreshGithubCi();
    let rows = provider.getLatestRows() ?? createInitialRows(targetFolders);
    try {
      rows = rows.map((entry) => (entry.folder === folder ? { ...entry, outcome: "running" as const, durationMs: 0 } : entry));
      provider.setRows(rows);
      const result = await runTypeCheck(workspaceFolder.uri.fsPath, folder);
      rows = rows.map((entry) => (entry.folder === folder ? statusRowFromResult(result, entry) : entry));
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
      void refreshGithubCi();
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
    const debounceMs = getRelevantRerunDebounceMs();
    saveRerunDebounceHandle = setTimeout(() => {
      saveRerunDebounceHandle = undefined;
      const folderToRun = pendingSaveTargetFolder;
      pendingSaveTargetFolder = undefined;
      if (typeof folderToRun === "string" && folderToRun.length > 0) {
        void runSingleTypeCheck(folderToRun);
      }
    }, debounceMs);
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

  let githubCiPoll: NodeJS.Timeout | undefined;

  const refreshGithubCi = async (): Promise<void> => {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (workspaceFolder === undefined) {
      return;
    }
    const root = workspaceFolder.uri.fsPath;
    const targets = getConfiguredTargetFolders(root);
    const workflowFlags = await computeGithubWorkflowsFlags(root, targets);
    const token = getGithubToken();
    const apiBaseUser = getGithubApiBaseUrl();

    interface GroupInfo {
      apiBase: string;
      owner: string;
      repo: string;
      ref: { branch: string } | { sha: string };
      gitRootAbs: string;
    }

    type Prep =
      | { kind: "skip" }
      | { kind: "error"; display: CiDisplay }
      | { kind: "fetch"; key: string };

    const prepByFolder = new Map<string, Prep>();
    const groups = new Map<string, GroupInfo>();

    for (const folder of targets) {
      if (!(workflowFlags.get(folder) ?? false)) {
        prepByFolder.set(folder, { kind: "skip" });
        continue;
      }
      const abs = path.resolve(root, folder);
      try {
        await access(abs, fsConstants.F_OK);
      } catch {
        prepByFolder.set(folder, {
          kind: "error",
          display: { bubble: "🔴", title: "Folder not found" }
        });
        continue;
      }
      const gitRoot = await findGitRoot(abs, root);
      if (gitRoot === undefined) {
        prepByFolder.set(folder, {
          kind: "error",
          display: { bubble: "📁", title: "No git repository (from target folder up to workspace root)" }
        });
        continue;
      }
      const remote = await gitGetRemoteOriginUrl(gitRoot);
      if (remote === undefined) {
        prepByFolder.set(folder, {
          kind: "error",
          display: { bubble: "➖", title: "No git remote origin" }
        });
        continue;
      }
      const parsed = parseGithubRemote(remote);
      if (parsed === undefined) {
        const hint = remote.length > 72 ? `${remote.slice(0, 69)}…` : remote;
        prepByFolder.set(folder, {
          kind: "error",
          display: {
            bubble: "➖",
            title: `Cannot parse remote origin as host/owner/repo (Actions API expects GitHub or GHE). Remote: ${hint}`
          }
        });
        continue;
      }
      const ref = await gitGetBranchOrSha(gitRoot);
      if (ref === undefined) {
        prepByFolder.set(folder, {
          kind: "error",
          display: { bubble: "⚪", title: "Could not resolve current branch or HEAD commit" }
        });
        continue;
      }
      const apiBase = resolveGithubApiBaseUrl(parsed.host, apiBaseUser);
      const refPart = "branch" in ref ? `b:${ref.branch}` : `s:${ref.sha}`;
      const gkey = `${apiBase}|${parsed.owner}|${parsed.repo}|${refPart}`;
      prepByFolder.set(folder, { kind: "fetch", key: gkey });
      if (!groups.has(gkey)) {
        groups.set(gkey, {
          apiBase,
          owner: parsed.owner,
          repo: parsed.repo,
          ref,
          gitRootAbs: path.resolve(gitRoot)
        });
      }
    }

    const wfPath = getGithubCiWorkflowPath();
    const primaryWorkflowPathNorm =
      normalizeWorkflowRepoPath(wfPath).length > 0 ? normalizeWorkflowRepoPath(wfPath) : ".github/workflows/ci.yml";
    const fetched = new Map<string, GithubFetchBucket>();
    for (const [gkey, g] of groups) {
      const wfNum = await fetchWorkflowNumericId(g.apiBase, g.owner, g.repo, wfPath, token);
      if (wfNum === undefined) {
        fetched.set(gkey, { mode: "legacy", result: await fetchLatestWorkflowRun(g.apiBase, g.owner, g.repo, g.ref, token) });
      } else {
        fetched.set(gkey, {
          mode: "workflow",
          result: await fetchLatestWorkflowRunForWorkflow(g.apiBase, g.owner, g.repo, wfNum, g.ref, token)
        });
      }
    }

    if (getGithubCiDebug()) {
      outputChannel.appendLine("[Cursor TSC Runner][GitHub CI] debug: merged job names per repo ref");
      for (const [gkey, bucket] of fetched) {
        if (bucket.mode === "workflow" && bucket.result.kind === "ok") {
          outputChannel.appendLine(`  ${gkey} count=${String(bucket.result.jobs.length)}`);
          for (const j of bucket.result.jobs) {
            outputChannel.appendLine(`    ${j.name}`);
          }
        }
      }
    }

    const legacyMergedJobsByGkey = new Map<string, readonly GithubJob[]>();
    const legacyWorkflowRunJobsOnlyByGkey = new Map<string, readonly GithubJob[]>();
    for (const [gkey, bucket] of fetched) {
      if (bucket.mode !== "legacy") {
        continue;
      }
      const fr = bucket.result;
      if (fr.kind !== "ok") {
        continue;
      }
      const gInfo = groups.get(gkey);
      if (gInfo === undefined) {
        continue;
      }
      const jr = await fetchJobsForRun(gInfo.apiBase, gInfo.owner, gInfo.repo, fr.run.id, token);
      const fromJobsOnly: GithubJob[] = jr.kind === "ok" ? [...jr.jobs] : [];
      let merged: GithubJob[] = [...fromJobsOnly];
      const sha = fr.run.head_sha;
      if (typeof sha === "string" && /^[0-9a-f]{7,40}$/i.test(sha)) {
        const cr = await fetchCheckRunsAsJobs(gInfo.apiBase, gInfo.owner, gInfo.repo, sha, token);
        if (cr.kind === "ok" && cr.jobs.length > 0) {
          merged = mergeJobsByEoCiKey(cr.jobs, merged);
        }
      }
      legacyWorkflowRunJobsOnlyByGkey.set(gkey, fromJobsOnly);
      legacyMergedJobsByGkey.set(gkey, merged);
    }

    const ciByFolder = new Map<string, readonly CiDisplay[] | undefined>();
    for (const folder of targets) {
      const prep = prepByFolder.get(folder);
      if (prep === undefined || prep.kind === "skip") {
        ciByFolder.set(folder, undefined);
        continue;
      }
      if (prep.kind === "error") {
        ciByFolder.set(folder, [prep.display]);
        continue;
      }
      const bucket = fetched.get(prep.key);
      if (bucket === undefined) {
        ciByFolder.set(folder, undefined);
        continue;
      }
      if (bucket.mode === "legacy") {
        const fr = bucket.result;
        if (fr.kind === "error") {
          ciByFolder.set(folder, [{ bubble: "⚠️", title: fr.detail }]);
        } else if (fr.kind === "empty") {
          ciByFolder.set(folder, [
            {
              bubble: "◻️",
              title: "No workflow runs on GitHub for this branch or commit"
            }
          ]);
        } else {
          const merged = legacyMergedJobsByGkey.get(prep.key) ?? [];
          const displays = buildFolderCiDisplays(folder, merged);
          ciByFolder.set(folder, displays.length > 0 ? displays : undefined);
        }
        continue;
      }
      const bundle = bucket.result;
      if (bundle.kind === "error") {
        ciByFolder.set(folder, [{ bubble: "⚠️", title: bundle.detail }]);
      } else if (bundle.kind === "empty") {
        ciByFolder.set(folder, [
          {
            bubble: "◻️",
            title: "No workflow runs on GitHub for this branch or commit"
          }
        ]);
      } else if (bundle.kind === "ok") {
        const displays = buildFolderCiDisplays(folder, bundle.jobs);
        ciByFolder.set(folder, displays.length > 0 ? displays : undefined);
      }
    }

    const workspaceMonorepoGitRoot = await findGitRoot(path.resolve(root), root);
    const workspaceMonorepoGitRootNorm =
      workspaceMonorepoGitRoot === undefined ? undefined : path.resolve(workspaceMonorepoGitRoot);

    const globalWorkflowJobRows: WorkflowGlobalJobRow[] = [];
    if (workspaceMonorepoGitRootNorm !== undefined) {
      for (const [gkey, g] of groups) {
        if (path.resolve(g.gitRootAbs) !== workspaceMonorepoGitRootNorm) {
          continue;
        }
        const bucket = fetched.get(gkey);
        if (bucket === undefined) {
          continue;
        }
        const repoLabel = `${g.owner}/${g.repo}`;
        if (bucket.mode === "workflow") {
          const br = bucket.result;
          if (br.kind === "ok") {
            globalWorkflowJobRows.push(
              ...collectGlobalWorkflowJobRowsForMergedJobs(
                br.workflowRunJobsOnly,
                repoLabel,
                primaryWorkflowPathNorm
              )
            );
          }
        } else if (bucket.mode === "legacy") {
          const fr = bucket.result;
          if (fr.kind === "ok") {
            const runOnly = legacyWorkflowRunJobsOnlyByGkey.get(gkey) ?? [];
            globalWorkflowJobRows.push(
              ...collectGlobalWorkflowJobRowsForMergedJobs(runOnly, repoLabel, primaryWorkflowPathNorm)
            );
          }
        }
        const additionalPathsList = getGithubCiAdditionalWorkflowPaths();
        for (const extraNorm of additionalPathsList) {
          const wfNumExtra = await fetchWorkflowNumericId(g.apiBase, g.owner, g.repo, extraNorm, token);
          if (wfNumExtra === undefined) {
            continue;
          }
          const bundleExtra = await fetchLatestWorkflowRunForWorkflow(
            g.apiBase,
            g.owner,
            g.repo,
            wfNumExtra,
            g.ref,
            token
          );
          if (bundleExtra.kind !== "ok") {
            continue;
          }
          globalWorkflowJobRows.push(
            ...collectGlobalWorkflowJobRowsForMergedJobs(
              bundleExtra.workflowRunJobsOnly,
              repoLabel,
              extraNorm
            )
          );
        }
      }
    }
    globalWorkflowJobRows.sort((a, b) => {
      const w = a.workflowRelPath.localeCompare(b.workflowRelPath);
      if (w !== 0) {
        return w;
      }
      const d = a.repoLabel.localeCompare(b.repoLabel);
      if (d !== 0) {
        return d;
      }
      return a.jobTitle.localeCompare(b.jobTitle);
    });

    const latest = provider.getLatestRows();
    const base = latest === undefined ? createInitialRows(targets) : syncRowsWithTargets(targets, latest);
    provider.setRows(
      base.map((row) => {
        const hasWf = workflowFlags.get(row.folder) ?? false;
        if (!hasWf) {
          return { ...row, hasGithubWorkflows: false, ci: undefined };
        }
        const ci = ciByFolder.get(row.folder);
        const hasCiPresentation = ci !== undefined && ci.length > 0;
        return {
          ...row,
          hasGithubWorkflows: hasCiPresentation,
          ci: hasCiPresentation ? ci : undefined
        };
      }),
      globalWorkflowJobRows
    );
  };

  const restartGithubCiPolling = (): void => {
    if (githubCiPoll !== undefined) {
      clearInterval(githubCiPoll);
      githubCiPoll = undefined;
    }
    const ms = getGithubActionsRefreshMs();
    githubCiPoll = setInterval(() => {
      void refreshGithubCi();
    }, ms);
  };

  context.subscriptions.push(
    new vscode.Disposable(() => {
      if (githubCiPoll !== undefined) {
        clearInterval(githubCiPoll);
        githubCiPoll = undefined;
      }
    })
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event: vscode.ConfigurationChangeEvent) => {
      if (event.affectsConfiguration(configSection)) {
        if (
          event.affectsConfiguration(`${configSection}.${githubTokenKey}`) ||
          event.affectsConfiguration(`${configSection}.${githubTokenFileKey}`)
        ) {
          clearGithubTokenCache();
        }
        if (
          event.affectsConfiguration(`${configSection}.${githubCiWorkflowPathKey}`) ||
          event.affectsConfiguration(`${configSection}.${githubCiAdditionalWorkflowPathsKey}`)
        ) {
          workflowNumericIdCache.clear();
        }
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (workspaceFolder) {
          provider.setRows(syncRowsWithTargets(getConfiguredTargetFolders(workspaceFolder.uri.fsPath), provider.getLatestRows()));
        }
        provider.refreshPanelFromConfiguration();
        restartGithubCiPolling();
        void refreshGithubCi();
      }
    })
  );
  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument((document: vscode.TextDocument) => {
      if (!getRunOnSave()) {
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
  restartGithubCiPolling();
  if (getAutoRunOnStart()) {
    void runAllTypeChecks("startup");
  } else {
    void refreshGithubCi();
  }
}

export function deactivate(): void {}
