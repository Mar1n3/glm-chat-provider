/**
 * GLM Coding Plan 套餐的平台区域。
 *
 * 同一份套餐存在于两个相互独立的平台上，账号与 API Key 互不通用：
 * - `global`：Z.AI 国际版 — https://api.z.ai
 * - `china`：智谱国内版   — https://open.bigmodel.cn
 *
 * 两个平台暴露的 OpenAI 兼容编码 API 路径和用量监控端点完全相同
 * （路径信息来自官方 `@z_ai/coding-helper` 包）。
 */
/** 区域标识：'global' 国际版、'china' 国内版。 */
export type GlmRegion = 'global' | 'china';

/** 两个平台的 API 根地址，按区域索引取对应域名。 */
export const GLM_PLATFORM_BASE_URLS: Record<GlmRegion, string> = {
  global: 'https://api.z.ai',
  china: 'https://open.bigmodel.cn',
};

/** OpenAI 兼容编码 API 的路径（两个平台一致）。 */
export const GLM_CHAT_BASE_PATH = '/api/coding/paas/v4';
/** 用量配额监控接口的路径（两个平台一致）。 */
export const GLM_MONITOR_QUOTA_PATH = '/api/monitor/usage/quota/limit';

/**
 * 拼接指定区域的聊天 API 完整地址。
 * 参数 region：目标平台区域；返回"平台根地址 + 编码 API 路径"。
 */
export function chatBaseUrl(region: GlmRegion): string {
  return GLM_PLATFORM_BASE_URLS[region] + GLM_CHAT_BASE_PATH;
}

/**
 * 拼接指定区域的用量配额监控接口完整地址。
 * 参数 region：目标平台区域。
 */
export function monitorQuotaUrl(region: GlmRegion): string {
  return GLM_PLATFORM_BASE_URLS[region] + GLM_MONITOR_QUOTA_PATH;
}

/**
 * 返回区域在界面上的显示名：国内版为 "ZHIPU (China)"，
 * 国际版为 "Z.AI (Global)"。参数 region：目标平台区域。
 */
export function regionLabel(region: GlmRegion): string {
  return region === 'china' ? 'ZHIPU (China)' : 'Z.AI (Global)';
}

/**
 * 根据用户的 `apiRegion` 配置值，返回需要依次探测的区域列表。
 * 参数 setting：`apiRegion` 配置（'global' / 'china' / 'auto' 或未设置）。
 */
export function resolveRegionCandidates(
  setting: string | undefined,
): GlmRegion[] {
  if (setting === 'global') {
    return ['global'];
  }
  if (setting === 'china') {
    return ['china'];
  }
  // 'auto'（默认值）或其他未知取值：两个平台都探测，国内版优先——
  // 本分支的主要受众使用智谱（open.bigmodel.cn）套餐。
  return ['china', 'global'];
}

/**
 * 返回一次聊天请求应依次尝试的区域列表。
 * 配置中显式指定区域时只返回该区域；否则把用量查询成功探测到的区域
 * 排在首位（优先使用已验证可用的平台），另一区域作为兜底。
 * 参数 setting：`apiRegion` 配置值。
 */
export function pickChatRegions(setting: string | undefined): GlmRegion[] {
  if (setting === 'global' || setting === 'china') {
    return [setting];
  }
  const detected = getDetectedRegion();
  if (detected) {
    return [detected, detected === 'global' ? 'china' : 'global'];
  }
  return ['china', 'global'];
}

/** 模块级缓存：记录已探测成功的区域；尚未探测到时为 undefined。 */
let detectedRegion: GlmRegion | undefined;

/**
 * 记住 API Key 所属的平台（结论来自用量监控查询或一次成功的聊天请求），
 * 之后的请求即可跳过区域探测。
 * 参数 region：探测成功的区域。
 */
export function setDetectedRegion(region: GlmRegion): void {
  detectedRegion = region;
}

/** 读取已探测成功的区域；尚未探测到时返回 undefined。 */
export function getDetectedRegion(): GlmRegion | undefined {
  return detectedRegion;
}
