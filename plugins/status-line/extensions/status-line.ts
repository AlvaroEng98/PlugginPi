import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

const REFRESH_INTERVAL_MS = 5_000;
const GIT_TIMEOUT_MS = 2_000;

type GitStatus = { staged: number; unstaged: number; added: number };

function parseGitStatus(output: string): GitStatus {
  const status: GitStatus = { staged: 0, unstaged: 0, added: 0 };

  for (const line of output.split("\n")) {
    if (line.length < 2) continue;
    const indexStatus = line[0];
    const worktreeStatus = line[1];

    if (indexStatus === "?" && worktreeStatus === "?") {
      status.added++;
      continue;
    }
    if (indexStatus !== " ") status.staged++;
    if (worktreeStatus !== " ") status.unstaged++;
  }

  return status;
}

function readGitStatus(cwd: string): Promise<GitStatus | undefined> {
  return new Promise((resolveStatus) => {
    execFile(
      "git",
      ["--no-optional-locks", "status", "--porcelain=v1", "--untracked-files=all"],
      { cwd, encoding: "utf8", timeout: GIT_TIMEOUT_MS, maxBuffer: 2 * 1024 * 1024, windowsHide: true },
      (error, stdout) => resolveStatus(error ? undefined : parseGitStatus(stdout.toString())),
    );
  });
}

function displayPath(cwd: string): string {
  const configuredRoot = process.env.PI_STATUS_LINE_ROOT?.trim();
  const root = resolve(configuredRoot || homedir());
  const current = resolve(cwd);
  const pathFromRoot = relative(root, current);
  const isWithinRoot = pathFromRoot === "" ||
    (pathFromRoot !== ".." && !pathFromRoot.startsWith(`..${sep}`) && !isAbsolute(pathFromRoot));

  if (!isWithinRoot) return current;
  if (!pathFromRoot) return configuredRoot ? "." : "~";
  return configuredRoot ? pathFromRoot : `~${sep}${pathFromRoot}`;
}

function formatContextUsage(ctx: ExtensionContext, theme: Theme): string {
  const percent = ctx.getContextUsage()?.percent;
  if (percent == null || !Number.isFinite(percent)) return theme.fg("dim", "?%");

  const bounded = Math.max(0, Math.min(100, percent));
  const color = bounded > 90 ? "error" : bounded > 70 ? "warning" : "success";
  return theme.fg(color, `${bounded.toFixed(1)}%`);
}

function sanitizeStatus(text: string): string {
  return text.replace(/[\r\n\t]/g, " ").replace(/ +/g, " ").trim();
}

function renderAlignedLine(left: string, right: string | undefined, width: number, theme: Theme): string {
  if (!right) return truncateToWidth(left, width, theme.fg("dim", "…"));

  const rightLimit = Math.max(1, Math.floor(width * 0.35));
  const safeRight = theme.fg("dim", truncateToWidth(right, rightLimit, "…"));
  const rightWidth = visibleWidth(safeRight);
  const safeLeft = truncateToWidth(left, Math.max(0, width - rightWidth - 1), theme.fg("dim", "…"));
  const padding = " ".repeat(Math.max(1, width - visibleWidth(safeLeft) - rightWidth));
  return truncateToWidth(`${safeLeft}${padding}${safeRight}`, width, theme.fg("dim", "…"));
}

export default function (pi: ExtensionAPI) {
  let refreshTimer: ReturnType<typeof setInterval> | undefined;
  let requestRender: (() => void) | undefined;

  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    if (refreshTimer) clearInterval(refreshTimer);

    let gitStatus: GitStatus | undefined;
    let statusCwd: string | undefined;
    let refreshing = false;

    const refreshGitStatus = async () => {
      if (refreshing) return;
      refreshing = true;
      const cwd = ctx.sessionManager.getCwd();

      if (cwd !== statusCwd) {
        statusCwd = cwd;
        gitStatus = undefined;
      }

      try {
        const nextStatus = await readGitStatus(cwd);
        if (ctx.sessionManager.getCwd() === cwd) gitStatus = nextStatus;
      } catch {
        if (ctx.sessionManager.getCwd() === cwd) gitStatus = undefined;
      } finally {
        refreshing = false;
        requestRender?.();
      }
    };

    ctx.ui.setFooter((tui, theme, footerData) => {
      requestRender = () => tui.requestRender();
      const unsubscribeBranch = footerData.onBranchChange(requestRender);

      return {
        render(width: number): string[] {
          const cwd = ctx.sessionManager.getCwd();
          const parts = [theme.fg("accent", displayPath(cwd))];
          const branch = footerData.getGitBranch();
          if (branch) parts.push(theme.fg("success", branch));

          if (gitStatus) {
            parts.push(theme.fg("warning", `S: ${gitStatus.staged}`));
            parts.push(theme.fg("warning", `U: ${gitStatus.unstaged}`));
            parts.push(theme.fg("warning", `A: ${gitStatus.added}`));
          }
          parts.push(formatContextUsage(ctx, theme));

          const extensionStatuses = footerData.getExtensionStatuses();
          const line = renderAlignedLine(
            parts.join(theme.fg("dim", " | ")),
            extensionStatuses.get("opencode-go-meter"),
            width,
            theme,
          );
          const modelName = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "sin modelo";
          const effort = ctx.thinkingLevel ?? "off";
          const modelLine = truncateToWidth(
            `${theme.fg("accent", `modelo: ${modelName}`)} ${theme.fg("dim", "|")} ${theme.fg("muted", `esfuerzo: ${effort}`)}`,
            width,
            theme.fg("dim", "…"),
          );
          const statuses = Array.from(extensionStatuses.entries())
            .filter(([key]) => key !== "opencode-go-meter")
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([, text]) => sanitizeStatus(text))
            .filter(Boolean);
          return statuses.length > 0
            ? [line, modelLine, truncateToWidth(statuses.join(" "), width, theme.fg("dim", "…"))]
            : [line, modelLine];
        },
        invalidate() {},
        dispose() {
          unsubscribeBranch();
          requestRender = undefined;
        },
      };
    });

    void refreshGitStatus();
    refreshTimer = setInterval(() => void refreshGitStatus(), REFRESH_INTERVAL_MS);
  });

  pi.on("session_shutdown", (_event, ctx) => {
    if (refreshTimer) clearInterval(refreshTimer);
    refreshTimer = undefined;
    requestRender = undefined;
    if (ctx.mode === "tui") ctx.ui.setFooter(undefined);
  });
}
