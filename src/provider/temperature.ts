import {
  TEMPERATURE_PRESET_VALUES,
  type ModelConfigurationOptions,
  type TemperaturePreset,
} from '../models';

/**
 * 把任意来源的温度值归一化为 0~1 之间的数字。
 * 支持三种输入：
 * - 数字：直接钳位到 [0, 1]；
 * - 预设名（balanced/precise/creative/max 等）：查 TEMPERATURE_PRESET_VALUES 表；
 * - 数字字符串：parseFloat 解析后钳位到 [0, 1]。
 * 其余输入返回 undefined，表示本次请求不带温度参数。
 */
export function normalizeTemperatureValue(value: unknown): number | undefined {
  if (typeof value === 'number' && !Number.isNaN(value)) {
    return Math.max(0, Math.min(1, value));
  }
  // 非数字也非字符串的值无法归一化。
  if (typeof value !== 'string') return undefined;

  // 先按预设名查表（预设值本身已在合法范围内，无需再钳位）。
  const preset = value as TemperaturePreset;
  if (preset in TEMPERATURE_PRESET_VALUES)
    return TEMPERATURE_PRESET_VALUES[preset];

  // 不是已知预设名时，再尝试按数字字符串解析并钳位到 [0, 1]。
  const parsed = Number.parseFloat(value);
  if (!Number.isNaN(parsed)) return Math.max(0, Math.min(1, parsed));
  return undefined;
}

/**
 * 从聊天选择器传入的配置中取出温度值并归一化。
 * 优先读 modelConfiguration.temperature（新的选择器配置结构），
 * 其次读 configuration.temperature（兼容旧结构）；
 * 两者都缺失或无法归一化时返回 undefined，请求将不带温度参数。
 */
export function getConfiguredTemperature(
  options?: ModelConfigurationOptions,
): number | undefined {
  const pickerValue =
    options?.modelConfiguration?.temperature ??
    options?.configuration?.temperature;
  const normalized = normalizeTemperatureValue(pickerValue);
  if (normalized !== undefined) return normalized;
  return undefined;
}
