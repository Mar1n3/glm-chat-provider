/**
 * GLM Coding Plan platform regions.
 *
 * The same plan product exists on two independent platforms with separate
 * accounts and API keys:
 * - `global`: Z.AI international — https://api.z.ai
 * - `china`:  ZHIPU China       — https://open.bigmodel.cn
 *
 * Both expose the same paths for the OpenAI-compatible coding API and the
 * usage monitor endpoints (discovered from the official
 * `@z_ai/coding-helper` package).
 */
export type GlmRegion = 'global' | 'china';

export const GLM_PLATFORM_BASE_URLS: Record<GlmRegion, string> = {
  global: 'https://api.z.ai',
  china: 'https://open.bigmodel.cn',
};

export const GLM_CHAT_BASE_PATH = '/api/coding/paas/v4';
export const GLM_MONITOR_QUOTA_PATH = '/api/monitor/usage/quota/limit';

export function chatBaseUrl(region: GlmRegion): string {
  return GLM_PLATFORM_BASE_URLS[region] + GLM_CHAT_BASE_PATH;
}

export function monitorQuotaUrl(region: GlmRegion): string {
  return GLM_PLATFORM_BASE_URLS[region] + GLM_MONITOR_QUOTA_PATH;
}

export function regionLabel(region: GlmRegion): string {
  return region === 'china' ? 'ZHIPU (China)' : 'Z.AI (Global)';
}

/** Regions to probe, in order, for a `apiRegion` config value. */
export function resolveRegionCandidates(
  setting: string | undefined,
): GlmRegion[] {
  if (setting === 'global') {
    return ['global'];
  }
  if (setting === 'china') {
    return ['china'];
  }
  // 'auto' (default) or anything else: probe both platforms, China first —
  // the primary audience of this fork is on the ZHIPU (open.bigmodel.cn) plan.
  return ['china', 'global'];
}

/**
 * Regions to try for a chat request, in order. An explicit config wins;
 * otherwise the region detected from a successful usage lookup goes first.
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

/** Region picked for a single-shot client (e.g. connection test). */
export function pickChatRegion(setting: string | undefined): GlmRegion {
  return pickChatRegions(setting)[0];
}

let detectedRegion: GlmRegion | undefined;

/**
 * Remember which platform the API key belongs to (learned from the usage
 * monitor or a successful chat request) so later requests can skip probing.
 */
export function setDetectedRegion(region: GlmRegion): void {
  detectedRegion = region;
}

export function getDetectedRegion(): GlmRegion | undefined {
  return detectedRegion;
}
