import * as vscode from 'vscode';
import {
  TEMPERATURE_PRESET_VALUES,
  type ModelConfigurationOptions,
  type TemperaturePreset,
} from '../models';

export function normalizeTemperatureValue(value: unknown): number | undefined {
  if (typeof value === 'number' && !Number.isNaN(value)) {
    return Math.max(0, Math.min(1, value));
  }
  if (typeof value !== 'string') return undefined;

  if (value === 'custom') {
    const custom = vscode.workspace
      .getConfiguration('glm-chat-provider')
      .get<number>('temperature');
    if (custom !== undefined && !Number.isNaN(custom))
      return Math.max(0, Math.min(1, custom));
    return undefined;
  }

  const preset = value as TemperaturePreset;
  if (preset in TEMPERATURE_PRESET_VALUES)
    return TEMPERATURE_PRESET_VALUES[preset];

  const parsed = Number.parseFloat(value);
  if (!Number.isNaN(parsed)) return Math.max(0, Math.min(1, parsed));
  return undefined;
}

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
