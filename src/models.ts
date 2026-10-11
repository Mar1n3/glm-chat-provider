/**
 * GLM 模型元数据、思考档位表与模型选择器配置 schema。
 *
 * 模型清单本身在 model-catalog.ts（新增模型只改那个文件）；本文件负责：
 * 1. 把清单条目补全成完整的模型定义（family、version、能力开关）；
 * 2. 用一张"思考档位表"（THINKING_PROFILES）同时驱动模型选择器的
 *    thinkingMode 选项，以及请求体里的 thinking / reasoning_effort 字段，
 *    保证界面上能选的档位和实际发出的请求始终一致；
 * 3. 生成温度预设选项。
 */
import type * as vscode from 'vscode';
import type {ApiProtocol} from './region';
import {MODEL_CATALOG} from './model-catalog';
import {PROTOCOL_CAPABILITIES, supportsEffort} from './protocol';

/** 温度预设名：balanced=均衡、precise=精确、creative=创意、max=最高。 */
export type TemperaturePreset = 'balanced' | 'precise' | 'creative' | 'max';
/**
 * 模型选择器中 thinkingMode 选项的取值：
 * auto=由模型自行决定是否思考；enabled/disabled=强制开启/关闭思维链；
 * low/high/max=开启思维链并指定推理力度档位（仅支持力度档位的模型使用）。
 */
export type ThinkingMode =
  | 'auto'
  | 'enabled'
  | 'disabled'
  | 'low'
  | 'high'
  | 'max';

/**
 * 模型对思维链（thinking）的支持方式，决定配置界面中 thinkingMode
 * 的候选值与默认值，也决定请求时是否附带推理力度（reasoningEffort）参数。
 * 各取值的含义见 model-catalog.ts 中 ModelCatalogEntry.thinking 的说明。
 */
export type ThinkingSupport =
  | 'on-off'
  | 'always-on'
  | 'on-off-effort'
  | 'always-on-effort'
  | 'none';

/** 各温度预设对应的实际温度值（范围 0.0–1.0）。 */
export const TEMPERATURE_PRESET_VALUES: Record<TemperaturePreset, number> = {
  balanced: 0.7,
  precise: 0.2,
  creative: 0.9,
  max: 1.0,
};

/** 温度预设在选择器里的展示顺序、标签与说明。 */
const TEMPERATURE_PRESETS: ReadonlyArray<{
  value: TemperaturePreset;
  label: string;
  hint: string;
}> = [
  {value: 'balanced', label: 'Balanced', hint: 'Standard'},
  {value: 'precise', label: 'Precise', hint: 'Low, good for code'},
  {value: 'creative', label: 'Creative', hint: 'Higher, good for writing'},
  {value: 'max', label: 'Max', hint: 'Highest'},
];

/** 请求体里与思考相关的字段；空对象表示沿用服务端默认行为。 */
export interface ThinkingRequest {
  thinking?: Record<string, unknown>;
  reasoningEffort?: string;
}

/** 思考档位表中的一个可选档位。 */
interface ThinkingModeOption {
  value: ThinkingMode;
  label: string;
  description: string;
  /** 选中该档位时发送的字段。 */
  request: ThinkingRequest;
}

/** 一种思考支持方式的完整定义。 */
interface ThinkingProfile {
  /** 选择器里可选的档位（按展示顺序）；空数组表示不显示思考选项。 */
  modes: readonly ThinkingModeOption[];
  /** 选择器默认选中的档位。 */
  defaultMode?: ThinkingMode;
  /** 未选择、或选中值不在 modes 里（如切换模型后残留的旧值）时发送的字段。 */
  fallback(protocol: ApiProtocol): ThinkingRequest;
  /** 温度选项的默认预设。 */
  defaultTemperature: TemperaturePreset;
  /** README 模型表格里 Thinking 列的说明文字。 */
  summary: string;
}

const ENABLED: ThinkingRequest = {thinking: {type: 'enabled'}};
const DISABLED: ThinkingRequest = {thinking: {type: 'disabled'}};
const SERVER_DEFAULT = (): ThinkingRequest => ({});
const withEffort = (effort: 'low' | 'high' | 'max'): ThinkingRequest => ({
  thinking: {type: 'enabled'},
  reasoningEffort: effort,
});

/** 推理力度类档位：选择器会按协议能力过滤掉不支持的档位。 */
const EFFORT_MODES: readonly ThinkingMode[] = ['low', 'high', 'max'];

/**
 * 思考档位表：每种支持方式的可选档位、默认值与对应请求字段。
 * 选择器 schema（getModelConfigurationSchema）与请求解析
 * （resolveThinkingRequest）都只读这张表。
 */
const THINKING_PROFILES: Record<ThinkingSupport, ThinkingProfile> = {
  // GLM-5.3 系列：思维链强制开启且不可关闭，只能控制推理力度。
  'always-on-effort': {
    modes: [
      {
        value: 'low',
        label: 'Low',
        description: 'Enabled, low effort — lightweight reasoning',
        request: withEffort('low'),
      },
      {
        value: 'high',
        label: 'High',
        description: 'Enabled, high effort — enhanced reasoning',
        request: withEffort('high'),
      },
      {
        value: 'max',
        label: 'Max',
        description: 'Enabled, max effort — deep reasoning (recommended)',
        request: withEffort('max'),
      },
    ],
    defaultMode: 'max',
    // 官方接口沿用服务端默认 max；自定义协议显式发送选择器的默认档位。
    fallback: protocol =>
      protocol === 'chat-completions'
        ? ENABLED
        : {
            ...ENABLED,
            reasoningEffort: PROTOCOL_CAPABILITIES[protocol].defaultEffort,
          },
    defaultTemperature: 'max',
    summary: 'Always on (low/high/max effort)',
  },
  // GLM-5.2：可开可关，开启时可选 high / max 推理力度。
  'on-off-effort': {
    modes: [
      {
        value: 'auto',
        label: 'Auto',
        description: 'Let the model decide (default)',
        request: {},
      },
      {
        value: 'high',
        label: 'High',
        description: 'Enabled, high effort — faster responses',
        request: withEffort('high'),
      },
      {
        value: 'max',
        label: 'Max',
        description:
          'Enabled, max effort — best for complex tasks (recommended)',
        request: withEffort('max'),
      },
      {
        value: 'disabled',
        label: 'Disabled',
        description: 'Disable chain-of-thought',
        request: DISABLED,
      },
    ],
    defaultMode: 'auto',
    fallback: SERVER_DEFAULT,
    defaultTemperature: 'balanced',
    summary: 'Auto / high / max / off',
  },
  // GLM-4.6 ~ 5.1：可开可关，无力度档位。显式开启时只传 {type: 'enabled'}：
  // 附带 clear_thinking 等额外字段会被新模型校验拒绝。
  'on-off': {
    modes: [
      {
        value: 'auto',
        label: 'Auto',
        description: 'Let the model decide (default)',
        request: {},
      },
      {
        value: 'enabled',
        label: 'Enabled',
        description: 'Always enable chain-of-thought',
        request: ENABLED,
      },
      {
        value: 'disabled',
        label: 'Disabled',
        description: 'Disable chain-of-thought',
        request: DISABLED,
      },
    ],
    defaultMode: 'auto',
    fallback: SERVER_DEFAULT,
    defaultTemperature: 'balanced',
    summary: 'Auto on/off',
  },
  // GLM-4.5 系列：思维链始终开启，无法关闭。
  'always-on': {
    modes: [
      {
        value: 'enabled',
        label: 'Always On',
        description: 'Thinking is always active for this model',
        request: ENABLED,
      },
    ],
    defaultMode: 'enabled',
    fallback: SERVER_DEFAULT,
    defaultTemperature: 'balanced',
    summary: 'Always on',
  },
  // 不支持思考的模型：不显示思考选项，也不发送任何思考字段。
  none: {
    modes: [],
    fallback: SERVER_DEFAULT,
    defaultTemperature: 'balanced',
    summary: 'No',
  },
};

/** 选择器里一个下拉选项的 schema。 */
interface EnumSettingSchema {
  readonly type: 'string';
  readonly title: string;
  readonly enum: string[];
  readonly enumItemLabels: string[];
  readonly enumDescriptions: string[];
  readonly default: string;
  readonly description?: string;
  readonly group: 'navigation';
}

/** 模型选择器的配置界面 schema（思考档位 + 温度预设）。 */
export interface ModelConfigurationSchema {
  readonly properties: {
    readonly thinkingMode?: EnumSettingSchema;
    readonly temperature: EnumSettingSchema;
  };
}

/** 温度选项 schema；默认值不是 Balanced 时在说明里标注推荐。 */
function temperatureSchema(
  defaultPreset: TemperaturePreset,
): EnumSettingSchema {
  return {
    type: 'string',
    title: 'Temperature',
    enum: TEMPERATURE_PRESETS.map(preset => preset.value),
    enumItemLabels: TEMPERATURE_PRESETS.map(preset => preset.label),
    enumDescriptions: TEMPERATURE_PRESETS.map(preset => {
      const value = TEMPERATURE_PRESET_VALUES[preset.value].toFixed(1);
      const recommended =
        preset.value === defaultPreset && defaultPreset !== 'balanced'
          ? ', recommended for this model'
          : '';
      return `${preset.hint} (${value}${recommended})`;
    }),
    default: defaultPreset,
    description: 'Presets (range: 0.0 – 1.0)',
    group: 'navigation',
  };
}

/**
 * 获取指定思维支持类型对应的模型选择器配置 schema。
 * 参数 thinkingSupport：模型的思维支持类型；不传时按通用 'on-off' 处理。
 * 推理力度档位按当前协议过滤（例如 Responses 协议没有 max），默认档位
 * 被过滤掉时改用该协议的默认力度——展示与请求序列化共用同一份能力定义。
 */
export function getModelConfigurationSchema(
  thinkingSupport: ThinkingSupport = 'on-off',
  protocol: ApiProtocol = 'chat-completions',
): ModelConfigurationSchema {
  const profile = THINKING_PROFILES[thinkingSupport];
  const modes = profile.modes.filter(
    mode =>
      !EFFORT_MODES.includes(mode.value) ||
      supportsEffort(protocol, mode.value),
  );
  const defaultMode =
    profile.defaultMode &&
    modes.some(mode => mode.value === profile.defaultMode)
      ? profile.defaultMode
      : PROTOCOL_CAPABILITIES[protocol].defaultEffort;
  return {
    properties: {
      ...(modes.length > 0
        ? {
            thinkingMode: {
              type: 'string',
              title: 'Thinking',
              enum: modes.map(mode => mode.value),
              enumItemLabels: modes.map(mode => mode.label),
              enumDescriptions: modes.map(mode => mode.description),
              default: defaultMode,
              group: 'navigation',
            },
          }
        : {}),
      temperature: temperatureSchema(profile.defaultTemperature),
    },
  };
}

/**
 * 根据模型的思考支持方式与用户在选择器上的选择，解析请求体需要的
 * thinking 开关和 reasoning_effort 参数。
 * 选择器的新字段 modelConfiguration 优先于兼容字段 configuration；
 * 选中值不在该模型的档位表里时（未选择、旧值残留），使用档位表的兜底值。
 * 未知模型不发送任何思考字段，沿用服务端默认行为。
 */
export function resolveThinkingRequest(
  model: GlmModelDefinition | undefined,
  options?: ModelConfigurationOptions,
  protocol: ApiProtocol = 'chat-completions',
): ThinkingRequest {
  const profile = THINKING_PROFILES[model?.thinkingSupport ?? 'none'];
  const selected =
    options?.modelConfiguration?.thinkingMode ??
    options?.configuration?.thinkingMode;
  const option = profile.modes.find(mode => mode.value === selected);
  const request = option ? option.request : profile.fallback(protocol);
  // 复制一份，避免调用方修改到档位表里共享的常量对象。
  return {
    ...(request.thinking ? {thinking: {...request.thinking}} : {}),
    ...(request.reasoningEffort
      ? {reasoningEffort: request.reasoningEffort}
      : {}),
  };
}

/** README 模型表格里 Thinking 列的说明文字。 */
export function describeThinkingSupport(support: ThinkingSupport): string {
  return THINKING_PROFILES[support].summary;
}

/**
 * 在 VS Code 传入的请求选项基础上，扩展模型选择器下发的配置字段：
 * modelConfiguration 为标准字段，configuration 为兼容字段，两者存放的
 * 都是模型选择器上的 thinkingMode、temperature 等取值。
 */
export type ModelConfigurationOptions =
  vscode.ProvideLanguageModelChatResponseOptions & {
    readonly modelConfiguration?: Record<string, unknown>;
    readonly configuration?: Record<string, unknown>;
  };

/**
 * 提供给模型选择器的单个模型条目：在标准 LanguageModelChatInformation
 * 之上补充展示信息（是否可被用户选中、状态图标、详情、悬浮提示），
 * 以及该模型对应的配置界面 schema。
 */
export type ModelPickerChatInformation = vscode.LanguageModelChatInformation & {
  readonly isUserSelectable: boolean;
  readonly statusIcon?: vscode.ThemeIcon;
  readonly detail?: string;
  readonly tooltip?: string;
  readonly configurationSchema?: ModelConfigurationSchema;
};

/** 单个 GLM 模型的完整元数据定义（由 model-catalog.ts 的条目补全而来）。 */
export interface GlmModelDefinition {
  /** 模型 API ID：请求后端时使用的模型名。 */
  id: string;
  /** 在模型选择器中展示的显示名。 */
  name: string;
  /** 模型族（上报给 VS Code 语言模型 API 的 family 字段）。 */
  family: string;
  /** 模型版本标识。 */
  version: string;
  /** 补充说明文字（如所属平台）。 */
  detail: string;
  /** 最大输入 token 数（上下文窗口大小）。 */
  maxInputTokens: number;
  /** 单次回复的最大输出 token 数。 */
  maxOutputTokens: number;
  /** 模型能力开关集合。 */
  capabilities: {
    /** 是否支持工具调用。 */
    toolCalling: boolean;
    /** 是否支持图片输入。 */
    imageInput: boolean;
    /** 是否具备思维链推理能力。 */
    thinking: boolean;
  };
  /** 思维链支持方式，见 ThinkingSupport。 */
  thinkingSupport: ThinkingSupport;
}

/**
 * 全部 GLM 模型的完整定义（顺序与 model-catalog.ts 一致），供注册语言
 * 模型、生成模型选择器条目时使用。
 */
export const GLM_MODEL_DEFINITIONS: readonly GlmModelDefinition[] =
  MODEL_CATALOG.map(entry => ({
    id: entry.id,
    name: entry.name,
    family: 'glm',
    version: entry.version ?? entry.id.replace(/^glm-/, ''),
    detail: 'Z.AI',
    maxInputTokens: entry.maxInputTokens,
    maxOutputTokens: entry.maxOutputTokens,
    capabilities: {
      toolCalling: entry.toolCalling ?? true,
      imageInput: entry.imageInput,
      thinking: entry.thinking !== 'none',
    },
    thinkingSupport: entry.thinking,
  }));

const MODELS_BY_ID = new Map(GLM_MODEL_DEFINITIONS.map(m => [m.id, m]));

/** 按模型 ID 查找完整定义；未知 ID 返回 undefined。 */
export function findModelDefinition(
  id: string,
): GlmModelDefinition | undefined {
  return MODELS_BY_ID.get(id);
}
