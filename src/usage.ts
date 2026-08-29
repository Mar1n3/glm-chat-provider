/**
 * GLM Coding Plan 套餐用量模块：
 * - GlmUsageClient 按平台与鉴权方式探测监控接口 /api/monitor/usage/quota/limit，
 *   解析各配额窗口（5 小时/每周/长周期）；
 * - buildUsageTooltip 把用量结果渲染成状态栏悬浮提示（含内联 SVG 进度条）。
 */
import * as vscode from 'vscode';
import {
  monitorQuotaUrl,
  regionLabel,
  resolveRegionCandidates,
  setDetectedRegion,
  type GlmRegion,
} from './region';

/**
 * 用量监控请求的超时时间（毫秒）。
 *
 * 监控端点与聊天 API 同域，路径为 `{base}/api/monitor/usage/quota/limit`
 * （调用方式探测自官方 `@z_ai/coding-helper` 包），用套餐 API Key 鉴权查询。
 */
const REQUEST_TIMEOUT_MS = 15000;

/** 单个配额窗口的用量信息（由监控接口返回的 limits 数组逐项解析而来）。 */
export interface PlanLimitInfo {
  /** 窗口原始类型，如 CREDIT_LIMIT、TOKENS_LIMIT 或 TIME_LIMIT。 */
  type: string;
  /** 窗口已用百分比（0–100），接口未返回时由 currentValue/total 推算。 */
  percentage?: number;
  /** 窗口内当前已用数值，接口未返回时缺省。 */
  currentValue?: number;
  /** 窗口配额总量，接口未返回时缺省。 */
  total?: number;
  /** 人类可读的窗口标签（如 '5-Hour Credits'），按窗口类型整理得出。 */
  label?: string;
  /** 窗口重置时间（epoch 毫秒），接口报告时才有。 */
  resetAt?: number;
}

/** 一次套餐用量查询的完整结果（整理后的结构化数据）。 */
export interface PlanUsage {
  /** 5 小时配额窗口（total 最小的 CREDIT_LIMIT 窗口，或 TOKENS_LIMIT）。 */
  fiveHour?: PlanLimitInfo;
  /** 长周期配额窗口（total 最大的 CREDIT_LIMIT 窗口，或 TIME_LIMIT）。 */
  monthly?: PlanLimitInfo;
  /** 接口报告的全部配额窗口，按展示优先级排序。 */
  all: PlanLimitInfo[];
  /** 命中的平台（国内/国际），探测成功时才有。 */
  region?: GlmRegion;
  /** 接口报告的订阅套餐名称，接口提供时才有。 */
  planName?: string;
  /** 本次数据抓取时间（epoch 毫秒）。 */
  fetchedAt: number;
}

/** 用量接口专用错误：携带 HTTP 状态码（业务包装错误为业务 code，网络/超时失败为 0），便于上层识别与展示。 */
export class GlmUsageError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
  ) {
    super(message);
    this.name = 'GlmUsageError';
  }
}

/**
 * 把任意值宽松地转成数字：接受有限数值或可解析的数字字符串，其余返回 undefined。
 * 用于解析接口返回中类型不固定的数值字段。
 */
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

/** 可能携带配额窗口重置时间戳的字段名列表（各平台字段名不一，逐个尝试）。 */
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

/** 可能携带订阅套餐名称的字段名列表（依次在 data 与顶层响应中尝试）。 */
const PLAN_NAME_KEYS = [
  'planName',
  'plan_name',
  'packageName',
  'planType',
  'plan',
];

/**
 * 把秒/毫秒时间戳或时间字符串统一转换成 epoch 毫秒，无法识别时返回 undefined。
 * 用于归一化各平台格式不一的重置时间字段。
 */
function toEpochMs(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    // 区分 epoch 秒（约 1.7e9）与 epoch 毫秒（约 1.7e12）。
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

/**
 * 按给定字段名顺序从对象中取第一个非空字符串（返回去除首尾空白后的值）。
 * 用于兼容各平台的字段命名差异。
 */
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

/** 转义文本中的 &、<、>，用于把套餐名等不可信文本安全地嵌入 HTML/Markdown 悬浮内容。 */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * 把接口返回的单个原始窗口对象解析为 PlanLimitInfo：必须有非空 type 字段。
 * 数值字段做类型兼容处理；percentage 缺失时由 currentValue/total 推算；
 * 标签与重置时间按候选字段名逐个探测。
 */
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
    // 接口只给原始数值时，用 currentValue/total 推算百分比。
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

/** 已知窗口类型的兜底标签（接口未提供名称时使用）。 */
const LIMIT_LABELS: Record<string, string> = {
  CREDIT_LIMIT: 'Credits',
  TOKENS_LIMIT: '5-Hour Credits',
  TIME_LIMIT: 'Extended Quota',
};

/** 取窗口类型的展示标签：已知类型用预置文案，未知类型原样返回。 */
export function limitLabel(type: string): string {
  return LIMIT_LABELS[type] ?? type;
}

/**
 * 把解析出的窗口列表整理成 PlanUsage：识别 5 小时/长周期窗口、补齐展示标签，
 * 并按展示优先级（TOKENS_LIMIT、TIME_LIMIT、CREDIT_LIMIT、其余）生成 all。
 */
function toPlanUsage(limits: PlanLimitInfo[]): PlanUsage {
  const usage: PlanUsage = {all: [], fetchedAt: Date.now()};
  const ordered: PlanLimitInfo[] = [];

  // 旧版/显式的窗口类型：TOKENS_LIMIT 对应 5 小时配额，TIME_LIMIT 对应长周期配额。
  const tokens = limits.filter(info => info.type === 'TOKENS_LIMIT');
  const times = limits.filter(info => info.type === 'TIME_LIMIT');

  // CREDIT_LIMIT 窗口按 total 升序排序：最小的窗口是 5 小时配额，
  // 最大的是每周配额（Lite 档 2,000/10,000；Pro 档 12,000/60,000；
  // Max 档 28,000/140,000）。
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

/** GLM Coding Plan 套餐用量查询客户端：按平台与鉴权方式依次探测监控接口，并把结果整理为 PlanUsage。 */
export class GlmUsageClient {
  constructor(
    private readonly apiKey: string,
    /** `apiRegion` 配置值：'auto'（自动探测）| 'global'（国际版）| 'china'（国内版）。 */
    private readonly regionSetting: string | undefined = 'auto',
  ) {}

  /**
   * 查询当前 Coding Plan 套餐用量，返回 5 小时配额及（若有）长周期/每周配额。
   *
   * 官方 `@z_ai/coding-helper` 以裸套餐 Key 调用监控接口（Authorization 头
   * 不带 `Bearer` 前缀）；部分服务端也接受 `Bearer <key>`。因此按区域候选
   * 列表（先国内后国际）× 两种鉴权方式依次探测：每个平台先用官方方式、
   * 再用带前缀的方式，拿到有效配额立即返回并缓存该平台。
   */
  async fetchPlanUsage(): Promise<PlanUsage> {
    const regions = resolveRegionCandidates(this.regionSetting);
    let lastError: unknown;
    let sawEmpty = false;
    let emptyRegion: GlmRegion | undefined;

    for (const region of regions) {
      // 两种鉴权方式：官方的裸 Key 在前，带 Bearer 前缀的作兜底。
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
          // Key 在该平台鉴权通过，但该平台没有任何套餐配额。
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
      // Key 在某平台有效，但该账号未订阅 Coding Plan 套餐。
      setDetectedRegion(emptyRegion!);
      return {all: [], region: emptyRegion, fetchedAt: Date.now()};
    }

    // 所有平台都以错误收场：抛出最后一次的错误。
    if (lastError instanceof GlmUsageError) {
      throw lastError;
    }
    const message =
      lastError instanceof Error ? lastError.message : String(lastError);
    throw new GlmUsageError(`Usage API request failed: ${message}`, 0);
  }

  /**
   * 诊断用原始探测：遍历每个平台 × 每种鉴权方式，返回 HTTP 状态码与
   * 原始响应体（超长截断），用于排查 Key 或平台连通性问题。
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

  /** 返回脱敏后的 API Key（保留首尾各几位与总长度），用于诊断输出。 */
  private maskedKey(): string {
    const key = this.apiKey;
    if (key.length <= 12) {
      return `***(${key.length} chars)`;
    }
    return `${key.slice(0, 6)}…${key.slice(-4)} (${key.length} chars)`;
  }

  /**
   * 发一次原始 GET 请求并返回 HTTP 状态码与响应体文本，不做解析与错误包装
   * （超时由 AbortController 按 REQUEST_TIMEOUT_MS 中止）。仅供诊断命令使用。
   */
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

  /**
   * 请求监控接口并解析配额窗口列表：兼容 data 为数组、data/顶层带 limits
   * 数组等多种响应形态；识别包在 HTTP 200 里的业务错误并抛为 GlmUsageError。
   */
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

      // 两个平台都把业务错误包在 HTTP 200 响应里，例如
      // {code: 401, msg: 'token expired or incorrect', success: false}。
      // 这里要把它识别为真实错误而非“无配额”，让外层探测逻辑
      // 得以继续尝试下一个平台/鉴权方式。
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

      // data 可能直接是数组，也可能是 {limits: [...]}；顶层 limits 作最后兜底。
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

/** 把配额数值格式化为展示文本：小数保留 1 位，整数按千分位分组。 */
export function formatLimitValue(value: number): string {
  if (!Number.isInteger(value)) {
    return value.toFixed(1);
  }
  return value.toLocaleString('en-US');
}

/** 用量进度条颜色：按百分比分档（≥90% 红、≥70% 黄、其余蓝），风格对齐 Copilot 的用量指示。 */
function barColor(pct: number): string {
  return pct >= 90 ? '#e5534b' : pct >= 70 ? '#d4a72c' : '#4c8dff';
}

/** 依据当前编辑器亮/暗色主题返回 SVG 配额块的文字颜色（主文字与次要文字）。 */
function quotaPalette(): {text: string; secondary: string} {
  const kind = vscode.window.activeColorTheme.kind;
  const dark =
    kind === vscode.ColorThemeKind.Dark ||
    kind === vscode.ColorThemeKind.HighContrast;
  return dark
    ? {text: '#e6edf3', secondary: '#9198a1'}
    : {text: '#1f2328', secondary: '#59636e'};
}

/** 配额块（内联 SVG）的固定宽度与进度条高度（像素）。 */
const BLOCK_WIDTH = 240;
const BAR_HEIGHT = 6;

/**
 * Copilot 风格的配额块：超大加粗的百分比 + 旁边正常字重的 "used"，下方是
 * 已用数值/总量，再下是进度条 —— 全部画成一张内联 SVG，用 `data:` URI
 * 嵌入 img 标签。
 *
 * Markdown 排版做不出这种布局：标题永远加粗，且悬浮净化器会剥离
 * font-size/font-weight 等内联样式（span 上只有 color、background-color
 * 和 border-radius 幸存）。而在 SVG 内部，每个 tspan 的字号/字重精确
 * 可控，行距按像素排布，进度条四周也不会出现空段落间隙。
 */
function quotaBlockHtml(limit: PlanLimitInfo): string {
  const palette = quotaPalette();
  const pct =
    limit.percentage !== undefined ? Math.round(limit.percentage) : undefined;
  const hasCounts =
    limit.currentValue !== undefined && limit.total !== undefined;

  // 垂直布局（基线坐标）：百分比行在 y=15，数值行在 y=33，进度条在 y=41；
  // 缺少某一行时，下方元素整体上移。
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
  // 保证最小填充宽度，避免极小百分比画出来不可见。
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

/** 生成 Copilot 风格的重置提示，如 "Resets Sep 1 at 8:00 AM"；无重置时间返回空串。 */
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

/**
 * 组装用量悬浮提示的完整 Markdown 内容。
 *
 * @param usage 已抓取的套餐用量；为 undefined 时走错误或加载分支。
 * @param error 最近一次抓取的错误文案（仅在没有任何 usage 数据时展示）。
 * @param requestCount 已发出的监控请求数，展示在底部状态行。
 */
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
      // 百分比 + 数值 + 进度条合成一个紧凑排布的 SVG 块。
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
      `<span style="opacity:.65;">Updated ${time} · ${requestCount} requests · Click to manage provider</span>`,
    );
  } else if (error) {
    markdown.appendMarkdown(`⚠️ ${error}\n\n`);
    markdown.appendMarkdown('Click to manage provider');
  } else {
    markdown.appendMarkdown('Loading usage…\n\n');
    markdown.appendMarkdown('Click to manage provider');
  }
  return markdown;
}
