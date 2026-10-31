import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

const STATUS_KEY = "opencode-go-meter";
const USAGE_URL = "https://opencode.ai/zen/go/v1/usage";
const DEFAULT_REFRESH_SECONDS = 60;
const MIN_REFRESH_SECONDS = 15;
const MAX_REFRESH_SECONDS = 3600;

type UsageWindow = {
  status: "ok" | "rate-limited";
  percent: number;
  resetsAt: string;
};

type GoUsage = {
  rolling: UsageWindow;
  weekly: UsageWindow;
  monthly: UsageWindow;
};

type UsageResponse = { usage?: Partial<GoUsage> };

function getRefreshIntervalMs(): number {
  const configured = Number(process.env.OPENCODE_GO_REFRESH_SECONDS);
  const seconds = Number.isFinite(configured) && configured > 0
    ? configured
    : DEFAULT_REFRESH_SECONDS;
  return Math.min(MAX_REFRESH_SECONDS, Math.max(MIN_REFRESH_SECONDS, seconds)) * 1000;
}

function isUsageWindow(value: unknown): value is UsageWindow {
  if (typeof value !== "object" || value === null) return false;
  const window = value as Partial<UsageWindow>;
  return (
    typeof window.percent === "number" &&
    Number.isFinite(window.percent) &&
    typeof window.resetsAt === "string" &&
    (window.status === "ok" || window.status === "rate-limited")
  );
}

function parseUsage(value: unknown): GoUsage {
  if (typeof value !== "object" || value === null) {
    throw new Error("Respuesta de uso inválida");
  }
  const usage = (value as UsageResponse).usage;
  if (
    !usage ||
    !isUsageWindow(usage.rolling) ||
    !isUsageWindow(usage.weekly) ||
    !isUsageWindow(usage.monthly)
  ) {
    throw new Error("La respuesta no incluye las tres ventanas de uso");
  }
  return usage as GoUsage;
}

function makeBar(percent: number, cells: number, theme: Theme): string {
  const bounded = Math.max(0, Math.min(100, percent));
  const filled = Math.round((bounded / 100) * cells);
  return theme.fg("accent", "█".repeat(filled)) + theme.fg("dim", "░".repeat(cells - filled));
}

function renderLine(usage: GoUsage | undefined, error: boolean, width: number, theme: Theme): string {
  if (!usage) {
    const label = error ? "Go usage · sin conexión" : "Go usage · consultando…";
    return `${" ".repeat(Math.max(0, width - visibleWidth(label)))}${truncateToWidth(label, width)}`;
  }

  const cells = width >= 62 ? 8 : width >= 47 ? 5 : width >= 34 ? 3 : 1;
  const compact = width < 28;
  const divider = theme.fg("dim", " · ");
  const rows = [
    { label: compact ? "5h" : "5h", value: usage.rolling },
    { label: compact ? "S" : "sem", value: usage.weekly },
    { label: compact ? "M" : "mes", value: usage.monthly },
  ];
  const text = rows
    .map(({ label, value }) => {
      const percent = `${Math.round(value.percent)}%`;
      if (compact) return `${theme.fg("muted", label)} ${percent}`;
      return `${theme.fg("muted", label)} ${makeBar(value.percent, cells, theme)} ${percent}`;
    })
    .join(divider);
  const safeText = truncateToWidth(text, width, theme.fg("dim", "…"));
  return `${" ".repeat(Math.max(0, width - visibleWidth(safeText)))}${safeText}`;
}

function resetIn(iso: string): string {
  const milliseconds = Date.parse(iso) - Date.now();
  if (!Number.isFinite(milliseconds) || milliseconds <= 0) return "ahora";
  const minutes = Math.ceil(milliseconds / 60_000);
  if (minutes < 60) return `${minutes} min`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)} h`;
  return `${Math.floor(minutes / 1440)} d`;
}

async function fetchUsage(ctx: ExtensionContext): Promise<GoUsage> {
  const apiKey = await ctx.modelRegistry.getApiKeyForProvider("opencode-go");
  if (!apiKey) throw new Error("No hay API key configurada para opencode-go");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8_000);
  try {
    const response = await fetch(USAGE_URL, {
      method: "GET",
      headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
      signal: controller.signal,
    });
    if (response.status === 401) throw new Error("API key rechazada (401)");
    if (response.status === 403) throw new Error("La cuenta no tiene acceso a OpenCode Go (403)");
    if (!response.ok) throw new Error(`OpenCode respondió ${response.status}`);
    return parseUsage(await response.json());
  } finally {
    clearTimeout(timeout);
  }
}

export default function (pi: ExtensionAPI) {
  let usage: GoUsage | undefined;
  let lastError = false;
  let inFlight = false;
  let refreshTimer: ReturnType<typeof setInterval> | undefined;
  let requestRender: (() => void) | undefined;

  function clearWidget(ctx: ExtensionContext): void {
    try {
      ctx.ui.setWidget(STATUS_KEY, undefined);
    } catch {
      // The UI may already be disposed during reload or shutdown.
    }
  }

  function installWidget(ctx: ExtensionContext): void {
    if (ctx.mode !== "tui") return;
    ctx.ui.setWidget(
      STATUS_KEY,
      (tui, theme) => {
        requestRender = () => tui.requestRender();
        return {
          render(width: number): string[] {
            return [renderLine(usage, lastError, width, theme)];
          },
          invalidate() {},
          dispose() {
            requestRender = undefined;
          },
        };
      },
      { placement: "belowEditor" },
    );
  }

  async function refresh(ctx: ExtensionContext): Promise<void> {
    if (inFlight) return;
    inFlight = true;
    try {
      usage = await fetchUsage(ctx);
      lastError = false;
    } catch {
      // Keep the last successful values visible during temporary failures.
      lastError = true;
    } finally {
      inFlight = false;
      requestRender?.();
    }
  }

  pi.on("session_start", async (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    installWidget(ctx);
    await refresh(ctx);
    refreshTimer = setInterval(() => {
      void refresh(ctx);
    }, getRefreshIntervalMs());
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    if (refreshTimer) clearInterval(refreshTimer);
    refreshTimer = undefined;
    inFlight = false;
    requestRender = undefined;
    clearWidget(ctx);
  });

  pi.registerCommand("go-meter", {
    description: "Actualizar y mostrar las cuotas de OpenCode Go",
    handler: async (_args, ctx) => {
      await refresh(ctx);
      if (!usage) {
        ctx.ui.notify("No pude consultar el uso de OpenCode Go. Revisa la API key y la conexión.", "error");
        return;
      }
      ctx.ui.notify(
        [
          `OpenCode Go — uso (refresco automático cada ${Math.round(getRefreshIntervalMs() / 1000)} s)`,
          `5 horas: ${Math.round(usage.rolling.percent)}% usado · reinicia en ${resetIn(usage.rolling.resetsAt)}`,
          `Semanal: ${Math.round(usage.weekly.percent)}% usado · reinicia en ${resetIn(usage.weekly.resetsAt)}`,
          `Mensual: ${Math.round(usage.monthly.percent)}% usado · reinicia en ${resetIn(usage.monthly.resetsAt)}`,
        ].join("\n"),
        "info",
      );
    },
  });
}
