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
/**
 * 服务商标识：
 * - 'zhipu'：智谱国内版（open.bigmodel.cn，支持套餐用量查询）
 * - 'zai'：Z.AI 国际版（api.z.ai，支持套餐用量查询）
 * - 'custom'：自定义服务商（内网服务器 / 第三方 GLM 代理），没有套餐
 *   监控接口，状态栏用量功能自动隐藏。
 */
export type ApiProviderId = 'zhipu' | 'zai' | 'custom';

/**
 * 自定义服务商使用的接口协议：
 * - 'chat-completions'：OpenAI Chat Completions 兼容协议（大多数网关/中转）
 * - 'messages'：Anthropic Messages 兼容协议
 * - 'responses'：OpenAI Responses 协议
 */
export type ApiProtocol = 'chat-completions' | 'messages' | 'responses';
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
 * 解析服务商配置，返回归一化结果。
 *
 * @param providerSetting  `apiProvider` 配置值（'zhipu'/'zai'/'custom'，
 *                         兼容旧配置 'china'/'global'/'auto'）
 * @param customBaseUrl    `customBaseUrl` 配置值（provider 为 custom 时使用）
 * @returns provider 标识；custom 时附带归一化后的 base 地址（去掉尾部斜杠）
 * @throws 配置为 custom 但 customBaseUrl 为空时抛错
 */
export function resolveApiProvider(
  providerSetting: string | undefined,
  customBaseUrl: string | undefined,
): {provider: ApiProviderId; customBaseUrl?: string} {
  // 兼容旧配置值：global -> zai。
  if (providerSetting === 'global') {
    return {provider: 'zai'};
  }
  if (providerSetting === 'custom') {
    const base = (customBaseUrl ?? '').trim().replace(/\/+$/, '');
    if (!base) {
      throw new Error(
        'apiProvider is "custom" but customBaseUrl is empty. Set glm-chat-provider.customBaseUrl.',
      );
    }
    return {provider: 'custom', customBaseUrl: base};
  }
  // 'zhipu'、'china'、'auto'、未设置或未知值：默认智谱国内版。
  return {provider: 'zhipu'};
}

/**
 * 判断服务商是否为官方平台（智谱 / Z.AI）。
 * 只有官方平台提供套餐用量监控接口。
 */
export function isOfficialProvider(provider: ApiProviderId): boolean {
  return provider === 'zhipu' || provider === 'zai';
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
