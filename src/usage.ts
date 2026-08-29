import * as vscode from 'vscode';
import {
  monitorQuotaUrl,
  regionLabel,
  resolveRegionCandidates,
  setDetectedRegion,
  type GlmRegion,
} from './region';

/**
 * Coding Plan usage monitor endpoints (same host as the chat API).
 * Discovered from the official `@z_ai/coding-helper` package, which queries
 * `{base}/api/monitor/usage/quota/limit` with the plan API key.
 */
const REQUEST_TIMEOUT_MS = 15000;

export interface PlanLimitInfo {
  /** Raw limit type, e.g. CREDIT_LIMIT, TOKENS_LIMIT or TIME_LIMIT. */
  type: string;
  /** Usage percentage of the quota window (0–100). */
  percentage?: number;
  /** Current usage value within the window, if reported. */
  currentValue?: number;
  /** Total quota for the window, if reported. */
  total?: number;
  /** Friendly label, resolved from the window (e.g. '5-Hour Credits'). */
  label?: string;
  /** Epoch ms when this quota window resets, if reported by the API. */
  resetAt?: number;
}

export interface PlanUsage {
  /** 5-hour usage limit (smallest CREDIT_LIMIT window or TOKENS_LIMIT). */
  fiveHour?: PlanLimitInfo;
  /** Extended limit (largest CREDIT_LIMIT window or TIME_LIMIT). */
  monthly?: PlanLimitInfo;
  /** Every quota window reported by the API, in priority order. */
  all: PlanLimitInfo[];
  /** Platform the key was found on, when known. */
  region?: GlmRegion;
  /** Subscription plan name reported by the API, when known. */
  planName?: string;
  /** Epoch ms of when this data was fetched. */
  fetchedAt: number;
}

export class GlmUsageError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
  ) {
    super(message);
    this.name = 'GlmUsageError';
  }
}

function toNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string') {
    const parsed = Number.parseFloat(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return undefined;
}

/** Fields that may carry the quota window's reset timestamp. */
const RESET_FIELD_KEYS = [
  'resetTime',
  'resetAt',
  'nextResetTime',
  'cycleEndTime',
  'windowEndTime',
  'endTime',
  'expireTime',
  'expirationTime',
];

/** Fields that may carry a display name for the subscription plan. */
const PLAN_NAME_KEYS = [
  'planName',
  'plan_name',
  'packageName',
  'planType',
  'plan',
];

function toEpochMs(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    // Epoch seconds (~1.7e9) vs epoch milliseconds (~1.7e12).
    if (value >= 1e12) {
      return value;
    }
    if (value >= 1e9) {
      return value * 1000;
    }
    return undefined;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (/^\d+(\.\d+)?$/.test(trimmed)) {
      return toEpochMs(Number.parseFloat(trimmed));
    }
    const parsed = Date.parse(trimmed);
    return Number.isNaN(parsed) ? undefined : parsed;
  }
  return undefined;
}

function pickString(record: unknown, keys: string[]): string | undefined {
  if (!record || typeof record !== 'object') {
    return undefined;
  }
  for (const key of keys) {
    const value = (record as Record<string, unknown>)[key];
    if (typeof value === 'string' && value.trim().length > 0) {
      return value.trim();
    }
  }
  return undefined;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function parseLimitItem(raw: unknown): PlanLimitInfo | undefined {
  if (!raw || typeof raw !== 'object') {
    return undefined;
  }
  const record = raw as Record<string, unknown>;
  const type = typeof record.type === 'string' ? record.type : '';
  if (!type) {
    return undefined;
  }
  const percentage = toNumber(record.percentage);
  const currentValue = toNumber(record.currentValue);
  const total =
    toNumber(record.usage) ?? toNumber(record.total) ?? toNumber(record.limit);
  return {
    type,
    // Derive the percentage when the API only reports raw values.
    percentage:
      percentage ??
      (currentValue !== undefined && total
        ? (currentValue / total) * 100
        : undefined),
    currentValue,
    total,
    label: pickString(record, ['name', 'title', 'label']),
    resetAt: RESET_FIELD_KEYS.map(key => toEpochMs(record[key])).find(
      value => value !== undefined,
    ),
  };
}

/** Fallback labels for the known quota window types. */
const LIMIT_LABELS: Record<string, string> = {
  CREDIT_LIMIT: 'Credits',
  TOKENS_LIMIT: '5-Hour Credits',
  TIME_LIMIT: 'Extended Quota',
};

export function limitLabel(type: string): string {
  return LIMIT_LABELS[type] ?? type;
}

function toPlanUsage(limits: PlanLimitInfo[]): PlanUsage {
  const usage: PlanUsage = {all: [], fetchedAt: Date.now()};
  const ordered: PlanLimitInfo[] = [];

  // Legacy/explicit window types.
  const tokens = limits.filter(info => info.type === 'TOKENS_LIMIT');
  const times = limits.filter(info => info.type === 'TIME_LIMIT');

  // CREDIT_LIMIT windows sorted by total ascending: the smaller window is
  // the 5-hour quota, the larger one the weekly quota (Lite: 2,000/10,000;
  // Pro: 12,000/60,000; Max: 28,000/140,000).
  const credits = limits
    .filter(info => info.type === 'CREDIT_LIMIT')
    .sort((a, b) => (a.total ?? Infinity) - (b.total ?? Infinity));

  if (tokens[0]) {
    tokens[0].label ??= LIMIT_LABELS.TOKENS_LIMIT;
    usage.fiveHour = tokens[0];
    ordered.push(tokens[0]);
  }
  if (times[0]) {
    times[0].label ??= LIMIT_LABELS.TIME_LIMIT;
    usage.monthly = times[0];
    ordered.push(times[0]);
  }
  credits.forEach((info, index) => {
    if (credits.length >= 2) {
      info.label =
        index === 0
          ? '5-Hour Credits'
          : index === credits.length - 1
            ? 'Weekly Credits'
            : `Credits #${index + 1}`;
    } else {
      info.label ??= LIMIT_LABELS.CREDIT_LIMIT;
    }
    if (!usage.fiveHour) {
      usage.fiveHour = info;
    }
    usage.monthly = info;
    ordered.push(info);
  });
  for (const info of limits) {
    if (!ordered.includes(info)) {
      info.label ??= limitLabel(info.type);
      ordered.push(info);
    }
  }

  usage.all = ordered;
  return usage;
}

export class GlmUsageClient {
  constructor(
    private readonly apiKey: string,
    /** `apiRegion` config value: 'auto' | 'global' | 'china'. */
    private readonly regionSetting: string | undefined = 'auto',
  ) {}

  /**
   * Fetch the current Coding Plan quota usage.
   * Returns the 5-hour token quota and (if present) the monthly/weekly quota.
   *
   * The official `@z_ai/coding-helper` queries the monitor endpoint with the
   * raw plan key in the Authorization header (no `Bearer` prefix). Some
   * server versions also accept `Bearer <key>`, so each platform is tried
   * with the official scheme first and the prefixed form as a fallback.
   */
  async fetchPlanUsage(): Promise<PlanUsage> {
    const regions = resolveRegionCandidates(this.regionSetting);
    let lastError: unknown;
    let sawEmpty = false;
    let emptyRegion: GlmRegion | undefined;

    for (const region of regions) {
      const schemes = [this.apiKey, `Bearer ${this.apiKey}`];
      for (const authorization of schemes) {
        try {
          const lookup = await this.requestQuotaLimits(region, authorization);
          if (lookup.limits.length > 0) {
            setDetectedRegion(region);
            return {
              ...toPlanUsage(lookup.limits),
              region,
              planName: lookup.planName,
            };
          }
          // The key authenticated but has no plan quota on this platform.
          sawEmpty = true;
          emptyRegion = region;
        } catch (error) {
          lastError = error;
        }
      }
    }

    if (lastError !== undefined && !sawEmpty) {
      if (lastError instanceof GlmUsageError) {
        throw lastError;
      }
      const message =
        lastError instanceof Error ? lastError.message : String(lastError);
      throw new GlmUsageError(`Usage API request failed: ${message}`, 0);
    }

    if (sawEmpty) {
      // The key is valid on a platform but has no Coding Plan quota there.
      setDetectedRegion(emptyRegion!);
      return {all: [], region: emptyRegion, fetchedAt: Date.now()};
    }

    // Every platform failed with an error.
    if (lastError instanceof GlmUsageError) {
      throw lastError;
    }
    const message =
      lastError instanceof Error ? lastError.message : String(lastError);
    throw new GlmUsageError(`Usage API request failed: ${message}`, 0);
  }

  /**
   * Raw diagnostic probe: every region x auth scheme with the HTTP status
   * and the raw response body, for troubleshooting key/platform problems.
   */
  async fetchDiagnostics(regionSetting = this.regionSetting): Promise<string> {
    const lines: string[] = [];
    const regions = resolveRegionCandidates(regionSetting);
    lines.push(`API key: ${this.maskedKey()}`);
    lines.push(`apiRegion setting: ${regionSetting ?? 'auto'}`);
    lines.push('');

    for (const region of regions) {
      lines.push(`== ${regionLabel(region)} ==`);
      for (const [i, scheme] of ['raw', 'Bearer'].entries()) {
        const authorization = i === 0 ? this.apiKey : `Bearer ${this.apiKey}`;
        try {
          const {status, body} = await this.rawRequest(region, authorization);
          lines.push(`[${scheme}] HTTP ${status}`);
          lines.push(
            body.length > 2000 ? `${body.slice(0, 2000)}…(truncated)` : body,
          );
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          lines.push(`[${scheme}] FAILED: ${message}`);
        }
        lines.push('');
      }
    }
    return lines.join('\n');
  }

  private maskedKey(): string {
    const key = this.apiKey;
    if (key.length <= 12) {
      return `***(${key.length} chars)`;
    }
    return `${key.slice(0, 6)}…${key.slice(-4)} (${key.length} chars)`;
  }

  private async rawRequest(
    region: GlmRegion,
    authorization: string,
  ): Promise<{status: number; body: string}> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(monitorQuotaUrl(region), {
        method: 'GET',
        headers: {
          Authorization: authorization,
          'Accept-Language': 'en-US,en',
          'Content-Type': 'application/json',
        },
        signal: controller.signal,
      });
      const body = await response.text();
      return {status: response.status, body};
    } finally {
      clearTimeout(timer);
    }
  }

  private async requestQuotaLimits(
    region: GlmRegion,
    authorization: string,
  ): Promise<{limits: PlanLimitInfo[]; planName?: string}> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const response = await fetch(monitorQuotaUrl(region), {
        method: 'GET',
        headers: {
          Authorization: authorization,
          'Accept-Language': 'en-US,en',
          'Content-Type': 'application/json',
        },
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new GlmUsageError(
          `Usage API error: HTTP ${response.status}`,
          response.status,
        );
      }

      const payload = (await response.json()) as {
        code?: number | string;
        msg?: string;
        success?: boolean;
        data?: {limits?: unknown[]} | unknown[];
        limits?: unknown[];
      };

      // Both platforms wrap errors in HTTP 200 responses, e.g.
      // {code: 401, msg: 'token expired or incorrect', success: false}.
      // Treat these as real errors instead of "no quota" so the probe
      // logic can fall through to the next platform/auth scheme.
      const bizCode = toNumber(payload.code);
      if (
        payload.success === false ||
        (bizCode !== undefined && bizCode !== 200)
      ) {
        throw new GlmUsageError(
          `Usage API error${bizCode !== undefined ? ` (code ${bizCode})` : ''}: ${payload.msg ?? 'unknown error'}`,
          bizCode ?? 0,
        );
      }

      const data = payload?.data;
      const limitsRaw = Array.isArray(data)
        ? data
        : ((data as {limits?: unknown[]})?.limits ??
          payload?.limits ??
          (Array.isArray(payload) ? payload : []));
      if (!Array.isArray(limitsRaw)) {
        throw new GlmUsageError('Usage API returned an unexpected payload', 0);
      }

      const limits: PlanLimitInfo[] = [];
      for (const raw of limitsRaw) {
        const info = parseLimitItem(raw);
        if (info) {
          limits.push(info);
        }
      }
      const planName =
        pickString(data, PLAN_NAME_KEYS) ?? pickString(payload, PLAN_NAME_KEYS);
      return {limits, planName};
    } catch (error) {
      if (error instanceof GlmUsageError) {
        throw error;
      }
      const message = error instanceof Error ? error.message : String(error);
      throw new GlmUsageError(`Usage API request failed: ${message}`, 0);
    } finally {
      clearTimeout(timer);
    }
  }
}

export function formatLimitValue(value: number): string {
  if (!Number.isInteger(value)) {
    return value.toFixed(1);
  }
  return value.toLocaleString('en-US');
}

/** Horizontal usage bar, colored like Copilot's usage indicators. */
function barColor(pct: number): string {
  return pct >= 90 ? '#e5534b' : pct >= 70 ? '#d4a72c' : '#4c8dff';
}

/** Theme-aware text colors for the SVG quota blocks. */
function quotaPalette(): {text: string; secondary: string} {
  const kind = vscode.window.activeColorTheme.kind;
  const dark =
    kind === vscode.ColorThemeKind.Dark ||
    kind === vscode.ColorThemeKind.HighContrast;
  return dark
    ? {text: '#e6edf3', secondary: '#9198a1'}
    : {text: '#1f2328', secondary: '#59636e'};
}

const BLOCK_WIDTH = 240;
const BAR_HEIGHT = 6;

/**
 * Copilot-style quota block: an oversized bold percentage with a
 * normal-weight "used" beside it, the credit counts below and the filled
 * bar — all composed as ONE inline SVG carried by a `data:` URI.
 *
 * Markdown rendering can't produce this layout: headings are always bold,
 * and the hover sanitizer strips font-size/font-weight inline styles (only
 * color, background-color and border-radius survive on spans). Inside an
 * SVG, per-`tspan` sizing/weight is exact, and the row spacing is
 * pixel-controlled, so there are no blank paragraph gaps around the bar.
 */
function quotaBlockHtml(limit: PlanLimitInfo): string {
  const palette = quotaPalette();
  const pct =
    limit.percentage !== undefined ? Math.round(limit.percentage) : undefined;
  const hasCounts =
    limit.currentValue !== undefined && limit.total !== undefined;

  // Vertical layout (baseline coords): percentage line at 15, counts line
  // at 33, bar at 41. Without one of the rows the elements shift up.
  const countsY = 33;
  const barY = hasCounts ? 41 : 21;
  const blockHeight = barY + BAR_HEIGHT;

  let body = '';
  if (pct !== undefined) {
    body +=
      '<text x="0" y="15" font-size="20" font-weight="600" ' +
      `fill="${palette.text}" letter-spacing="-0.3">${pct}%` +
      `<tspan font-size="12.5" font-weight="400" fill="${palette.secondary}"> used</tspan>` +
      '</text>';
  }
  if (hasCounts) {
    body +=
      `<text x="0" y="${countsY}" font-size="12" fill="${palette.secondary}">` +
      `${formatLimitValue(limit.currentValue!)} of ${formatLimitValue(limit.total!)} credits` +
      '</text>';
  }

  const clamped =
    limit.percentage !== undefined
      ? Math.max(0, Math.min(100, limit.percentage))
      : 0;
  const fill = barColor(Math.round(clamped));
  // Keep a minimum fill so tiny percentages stay visible.
  const fillWidth = Math.max(
    (BLOCK_WIDTH * clamped) / 100,
    clamped > 0 ? BAR_HEIGHT : 0,
  );
  body +=
    `<rect y="${barY}" width="${BLOCK_WIDTH}" height="${BAR_HEIGHT}" rx="3" ` +
    'fill="#888888" fill-opacity="0.35"/>' +
    (fillWidth > 0
      ? `<rect y="${barY}" width="${fillWidth}" height="${BAR_HEIGHT}" rx="3" fill="${fill}"/>`
      : '');

  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${BLOCK_WIDTH}" ` +
    `height="${blockHeight}" font-family="Segoe UI, sans-serif">${body}</svg>`;
  const src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  return `<img alt='${pct !== undefined ? `${pct}% used` : 'quota usage'}' src='${src}' width='${BLOCK_WIDTH}' height='${blockHeight}'>`;
}

/** "Resets Sep 1 at 8:00 AM" — Copilot-style reset hint. */
function formatResetTime(resetAt: number | undefined): string {
  if (!resetAt) {
    return '';
  }
  const target = new Date(resetAt);
  const sameYear = target.getFullYear() === new Date().getFullYear();
  const formatted = target.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    ...(sameYear ? {} : {year: 'numeric'}),
    hour: 'numeric',
    minute: '2-digit',
  });
  return `Resets ${formatted}`;
}

export function buildUsageTooltip(
  usage: PlanUsage | undefined,
  error: string | undefined,
  requestCount: number,
): vscode.MarkdownString {
  const markdown = new vscode.MarkdownString(undefined, true);
  markdown.supportHtml = true;

  if (usage) {
    const title = usage.planName
      ? escapeHtml(usage.planName)
      : 'GLM Coding Plan';
    markdown.appendMarkdown(`### ${title}\n\n`);
    if (usage.region) {
      markdown.appendMarkdown(
        `<span style="opacity:.65;">Platform: ${regionLabel(usage.region)}</span>\n\n`,
      );
    }
    for (const limit of usage.all) {
      const label = escapeHtml(limit.label ?? limitLabel(limit.type));
      const reset = formatResetTime(limit.resetAt);
      markdown.appendMarkdown(
        `**${label}**${reset ? ` &nbsp;·&nbsp; <span style="opacity:.65;">${reset}</span>` : ''}\n\n`,
      );
      // Percentage + counts + bar as one tightly-spaced SVG block.
      markdown.appendMarkdown(`${quotaBlockHtml(limit)}\n\n`);
    }
    if (usage.all.length === 0) {
      const regionNote = usage.region
        ? ` The key is valid on **${regionLabel(usage.region)}**, but that account has no active Coding Plan subscription.`
        : '';
      markdown.appendMarkdown(
        'No active Coding Plan quota found for this API key.\n\n' +
          regionNote +
          '\n\nMake sure this key is a **GLM Coding Plan** key (from a Coding Plan subscription on z.ai or open.bigmodel.cn). ' +
          'Pay-as-you-go API keys have no plan quota.\n\n',
      );
    }
    markdown.appendMarkdown('---\n\n');
    const time = new Date(usage.fetchedAt).toLocaleTimeString(undefined, {
      hour: 'numeric',
      minute: '2-digit',
    });
    markdown.appendMarkdown(
      `<span style="opacity:.65;">Updated ${time} · ${requestCount} requests · Click to refresh</span>`,
    );
  } else if (error) {
    markdown.appendMarkdown(`⚠️ ${error}\n\n`);
    markdown.appendMarkdown('Click to retry');
  } else {
    markdown.appendMarkdown('Loading usage…\n\n');
    markdown.appendMarkdown('Click to refresh');
  }
  return markdown;
}
