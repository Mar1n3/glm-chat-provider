/**
 * GLM 模型元数据与模型选择器配置 schema。
 *
 * 本文件集中定义所有 GLM 模型的元数据（id、上下文窗口、输出上限、
 * 能力、思维链支持方式），并根据各模型的思维支持类型，为 VS Code
 * 模型选择器生成对应的配置界面 schema（thinkingMode 与 temperature
 * 两组选项）。
 */
import type * as vscode from 'vscode';

/** 温度预设名：balanced=均衡、precise=精确、creative=创意、max=最高。 */
export type TemperaturePreset = 'balanced' | 'precise' | 'creative' | 'max';
/**
 * 模型选择器中 thinkingMode 选项的取值：
 * auto=由模型自行决定是否思考；enabled/disabled=强制开启/关闭思维链；
 * high/max=开启思维链并指定推理力度档位（仅支持力度档位的模型使用）。
 */
export type ThinkingMode = 'auto' | 'enabled' | 'disabled' | 'high' | 'max';

/** 各温度预设对应的实际温度值（范围 0.0–1.0）。 */
export const TEMPERATURE_PRESET_VALUES: Record<TemperaturePreset, number> = {
  balanced: 0.7,
  precise: 0.2,
  creative: 0.9,
  max: 1.0,
};

/**
 * 按模型的思维支持类型，生成模型选择器的配置界面 schema
 * （包含 thinkingMode 与 temperature 两组属性）。
 * 不同支持类型对应不同的 thinkingMode 候选值与默认值；temperature
 * 选项在各类别间基本一致，仅个别默认值不同。
 * 参数 thinkingSupport：模型的思维支持类型；不传时按最通用的
 * 'on-off'（可开关）类型处理。
 */
function buildModelConfigurationSchema(thinkingSupport?: ThinkingSupport) {
  // 思维链始终开启、无法关闭的模型：thinkingMode 仅提供 enabled 一项。
  if (thinkingSupport === 'always-on') {
    return {
      properties: {
        thinkingMode: {
          type: 'string',
          title: 'Thinking',
          enum: ['enabled'],
          enumItemLabels: ['Always On'],
          enumDescriptions: ['Thinking is always active for this model'],
          default: 'enabled',
          group: 'navigation',
        },
        temperature: {
          type: 'string',
          title: 'Temperature',
          enum: ['balanced', 'precise', 'creative', 'max', 'custom'],
          enumItemLabels: ['Balanced', 'Precise', 'Creative', 'Max', 'Custom'],
          enumDescriptions: [
            'Standard (0.7)',
            'Low, good for code (0.2)',
            'Higher, good for writing (0.9)',
            'Highest (1.0)',
            'Custom value set in settings',
          ],
          default: 'balanced',
          description: 'Presets (range: 0.0 – 1.0)',
          group: 'navigation',
        },
      },
    } as const;
  }

  // 思维链始终开启且支持推理力度的模型：可选 low/high/max，默认 max。
  if (thinkingSupport === 'always-on-effort') {
    return {
      properties: {
        thinkingMode: {
          type: 'string',
          title: 'Thinking',
          enum: ['low', 'high', 'max'],
          enumItemLabels: ['Low', 'High', 'Max'],
          enumDescriptions: [
            'Enabled, low effort — lightweight reasoning',
            'Enabled, high effort — enhanced reasoning',
            'Enabled, max effort — deep reasoning (recommended)',
          ],
          default: 'max',
          group: 'navigation',
        },
        temperature: {
          type: 'string',
          title: 'Temperature',
          enum: ['balanced', 'precise', 'creative', 'max', 'custom'],
          enumItemLabels: ['Balanced', 'Precise', 'Creative', 'Max', 'Custom'],
          enumDescriptions: [
            'Standard (0.7)',
            'Low, good for code (0.2)',
            'Higher, good for writing (0.9)',
            'Highest (1.0, recommended for this model)',
            'Custom value set in settings',
          ],
          default: 'max',
          description: 'Presets (range: 0.0 – 1.0)',
          group: 'navigation',
        },
      },
    } as const;
  }

  // 可开关且支持推理力度的模型：可选 auto/high/max/disabled，默认 auto。
  if (thinkingSupport === 'on-off-effort') {
    return {
      properties: {
        thinkingMode: {
          type: 'string',
          title: 'Thinking',
          enum: ['auto', 'high', 'max', 'disabled'],
          enumItemLabels: ['Auto', 'High', 'Max', 'Disabled'],
          enumDescriptions: [
            'Let the model decide (default)',
            'Enabled, high effort — faster responses',
            'Enabled, max effort — best for complex tasks (recommended)',
            'Disable chain-of-thought',
          ],
          default: 'auto',
          group: 'navigation',
        },
        temperature: {
          type: 'string',
          title: 'Temperature',
          enum: ['balanced', 'precise', 'creative', 'max', 'custom'],
          enumItemLabels: ['Balanced', 'Precise', 'Creative', 'Max', 'Custom'],
          enumDescriptions: [
            'Standard (0.7)',
            'Low, good for code (0.2)',
            'Higher, good for writing (0.9)',
            'Highest (1.0)',
            'Custom value set in settings',
          ],
          default: 'balanced',
          description: 'Presets (range: 0.0 – 1.0)',
          group: 'navigation',
        },
      },
    } as const;
  }

  // 默认分支：可开关、无推理力度档位的模型（含未指定支持类型的情况），
  // thinkingMode 可选 auto/enabled/disabled。
  return {
    properties: {
      thinkingMode: {
        type: 'string',
        title: 'Thinking',
        enum: ['auto', 'enabled', 'disabled'],
        enumItemLabels: ['Auto', 'Enabled', 'Disabled'],
        enumDescriptions: [
          'Let the model decide (default)',
          'Always enable chain-of-thought',
          'Disable chain-of-thought',
        ],
        default: 'auto',
        group: 'navigation',
      },
      temperature: {
        type: 'string',
        title: 'Temperature',
        enum: ['balanced', 'precise', 'creative', 'max', 'custom'],
        enumItemLabels: ['Balanced', 'Precise', 'Creative', 'Max', 'Custom'],
        enumDescriptions: [
          'Standard (0.7)',
          'Low, good for code (0.2)',
          'Higher, good for writing (0.9)',
          'Highest (1.0)',
          'Custom value set in settings',
        ],
        default: 'balanced',
        description: 'Presets (range: 0.0 – 1.0)',
        group: 'navigation',
      },
    },
  } as const;
}

/** 预生成的"可开关思维链"（on-off）类型 schema，供通用场景复用。 */
export const MODEL_CONFIGURATION_SCHEMA_BASE =
  buildModelConfigurationSchema('on-off');
/** 预生成的"可开关 + 推理力度档位"（on-off-effort）类型 schema。 */
export const MODEL_CONFIGURATION_SCHEMA_EFFORT =
  buildModelConfigurationSchema('on-off-effort');

/**
 * 获取指定思维支持类型对应的模型选择器配置 schema。
 * 参数 thinkingSupport：模型的思维支持类型；不传时按通用 'on-off' 处理。
 * 返回值：包含 thinkingMode 与 temperature 属性的配置 schema，
 * 返回类型与预生成的 MODEL_CONFIGURATION_SCHEMA_BASE 保持一致。
 */
export function getModelConfigurationSchema(
  thinkingSupport?: ThinkingSupport,
): typeof MODEL_CONFIGURATION_SCHEMA_BASE {
  return buildModelConfigurationSchema(thinkingSupport);
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
  readonly configurationSchema?: ReturnType<typeof getModelConfigurationSchema>;
};

/**
 * 模型对思维链（thinking）的支持方式，决定配置界面中 thinkingMode
 * 的候选值与默认值，也决定请求时是否附带推理力度（reasoningEffort）参数。
 */
export type ThinkingSupport =
  | 'on-off'
  | 'always-on'
  | 'on-off-effort'
  | 'always-on-effort';

/** 单个 GLM 模型的元数据定义。 */
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
  /** 思维链支持方式：
   *  'on-off'：可通过 API 开启/关闭思维链。
   *  'always-on'：思维链始终开启，无法关闭。
   *  'on-off-effort'：可开启/关闭，且支持多档推理力度（high/max）。
   *  'always-on-effort'：始终开启无法关闭，且支持多档推理力度（low/high/max）。 */
  thinkingSupport: ThinkingSupport;
}

/**
 * 全部 16 个 GLM 模型的清单（按发布时间从新到旧排列），供注册语言模型、
 * 生成模型选择器条目，以及按模型 ID 查找元数据（解析推理参数）时使用。
 */
export const GLM_MODEL_DEFINITIONS: readonly GlmModelDefinition[] = [
  {
    id: 'glm-5.3',
    name: 'GLM-5.3',
    family: 'glm',
    version: '5.3',
    detail: 'Z.AI',
    maxInputTokens: 1000000,
    maxOutputTokens: 131072,
    capabilities: {imageInput: false, toolCalling: true, thinking: true},
    thinkingSupport: 'always-on-effort',
  },
  {
    id: 'glm-5.3-flash',
    name: 'GLM-5.3-Flash',
    family: 'glm',
    version: '5.3-flash',
    detail: 'Z.AI',
    maxInputTokens: 1000000,
    maxOutputTokens: 131072,
    capabilities: {imageInput: true, toolCalling: true, thinking: true},
    thinkingSupport: 'always-on-effort',
  },
  {
    id: 'glm-5.2',
    name: 'GLM-5.2',
    family: 'glm',
    version: '5.2',
    detail: 'Z.AI',
    maxInputTokens: 1000000,
    maxOutputTokens: 131072,
    capabilities: {imageInput: false, toolCalling: true, thinking: true},
    thinkingSupport: 'on-off-effort',
  },
  {
    id: 'glm-5.1',
    name: 'GLM-5.1',
    family: 'glm',
    version: '5.1',
    detail: 'Z.AI',
    maxInputTokens: 204800,
    maxOutputTokens: 131072,
    capabilities: {imageInput: false, toolCalling: true, thinking: true},
    thinkingSupport: 'on-off',
  },
  {
    id: 'glm-5',
    name: 'GLM-5',
    family: 'glm',
    version: '5',
    detail: 'Z.AI',
    maxInputTokens: 204800,
    maxOutputTokens: 131072,
    capabilities: {imageInput: false, toolCalling: true, thinking: true},
    thinkingSupport: 'on-off',
  },
  {
    id: 'glm-5-turbo',
    name: 'GLM-5-Turbo',
    family: 'glm',
    version: '5-turbo',
    detail: 'Z.AI',
    maxInputTokens: 204800,
    maxOutputTokens: 131072,
    capabilities: {imageInput: false, toolCalling: true, thinking: true},
    thinkingSupport: 'on-off',
  },
  {
    id: 'glm-5v-turbo',
    name: 'GLM-5V-Turbo',
    family: 'glm',
    version: '5v-turbo',
    detail: 'Z.AI',
    maxInputTokens: 204800,
    maxOutputTokens: 131072,
    capabilities: {imageInput: true, toolCalling: true, thinking: true},
    thinkingSupport: 'on-off',
  },
  {
    id: 'glm-4.7',
    name: 'GLM-4.7',
    family: 'glm',
    version: '4.7',
    detail: 'Z.AI',
    maxInputTokens: 204800,
    maxOutputTokens: 131072,
    capabilities: {imageInput: false, toolCalling: true, thinking: true},
    thinkingSupport: 'on-off',
  },
  {
    id: 'glm-4.7-flash',
    name: 'GLM-4.7 Flash',
    family: 'glm',
    version: '4.7-flash',
    detail: 'Z.AI',
    maxInputTokens: 204800,
    maxOutputTokens: 131072,
    capabilities: {imageInput: false, toolCalling: true, thinking: true},
    thinkingSupport: 'on-off',
  },
  {
    id: 'glm-4.7-flashx',
    name: 'GLM-4.7 FlashX',
    family: 'glm',
    version: '4.7-flashx',
    detail: 'Z.AI',
    maxInputTokens: 204800,
    maxOutputTokens: 131072,
    capabilities: {imageInput: false, toolCalling: true, thinking: true},
    thinkingSupport: 'on-off',
  },
  {
    id: 'glm-4.6',
    name: 'GLM-4.6',
    family: 'glm',
    version: '4.6',
    detail: 'Z.AI',
    maxInputTokens: 204800,
    maxOutputTokens: 131072,
    capabilities: {imageInput: false, toolCalling: true, thinking: true},
    thinkingSupport: 'on-off',
  },
  {
    id: 'glm-4.6v',
    name: 'GLM-4.6V',
    family: 'glm',
    version: '4.6v',
    detail: 'Z.AI',
    maxInputTokens: 131072,
    maxOutputTokens: 32768,
    capabilities: {imageInput: true, toolCalling: true, thinking: true},
    thinkingSupport: 'on-off',
  },
  {
    id: 'glm-4.5',
    name: 'GLM-4.5',
    family: 'glm',
    version: '4.5',
    detail: 'Z.AI',
    maxInputTokens: 131072,
    maxOutputTokens: 98304,
    capabilities: {imageInput: false, toolCalling: true, thinking: true},
    thinkingSupport: 'always-on',
  },
  {
    id: 'glm-4.5-flash',
    name: 'GLM-4.5 Flash',
    family: 'glm',
    version: '4.5-flash',
    detail: 'Z.AI',
    maxInputTokens: 131072,
    maxOutputTokens: 98304,
    capabilities: {imageInput: false, toolCalling: true, thinking: true},
    thinkingSupport: 'always-on',
  },
  {
    id: 'glm-4.5-air',
    name: 'GLM-4.5 Air',
    family: 'glm',
    version: '4.5-air',
    detail: 'Z.AI',
    maxInputTokens: 131072,
    maxOutputTokens: 98304,
    capabilities: {imageInput: false, toolCalling: true, thinking: true},
    thinkingSupport: 'always-on',
  },
  {
    id: 'glm-4.5v',
    name: 'GLM-4.5V',
    family: 'glm',
    version: '4.5v',
    detail: 'Z.AI',
    maxInputTokens: 64000,
    maxOutputTokens: 16384,
    capabilities: {imageInput: true, toolCalling: true, thinking: true},
    thinkingSupport: 'always-on',
  },
];
