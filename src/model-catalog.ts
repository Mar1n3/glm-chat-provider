/**
 * ★ GLM 模型清单 —— 新增 / 修改 / 下架模型，只需要改这一个文件 ★
 *
 * 新增一个模型的步骤：
 * 1. 复制下面任意一个 `{ ... },` 条目，粘贴到合适的位置
 *    （清单顺序就是模型选择器里的显示顺序，建议新模型放最前面）。
 * 2. 按智谱 / Z.AI 官方文档修改字段（每个字段的含义见 ModelCatalogEntry）。
 * 3. 运行 `npm run models:readme` 同步 README 里的模型表格，
 *    再运行 `npm test` 检查（ID 重复、数值不合法、README 未同步都会报错）。
 *
 * 选择器里的思考档位、温度选项，以及请求体里的 thinking /
 * reasoning_effort 字段，都会根据 `thinking` 自动生成，不需要改别的文件。
 */
import type {ThinkingSupport} from './models';

/** 清单里的一个模型条目。 */
export interface ModelCatalogEntry {
  /** API 模型 ID：请求里的 model 字段，例如 'glm-5.3'。 */
  readonly id: string;
  /** 模型选择器里显示的名字，例如 'GLM-5.3'。 */
  readonly name: string;
  /** 上下文窗口：最大输入 token 数，例如 1M 写作 1000000。 */
  readonly maxInputTokens: number;
  /** 单次回复的最大输出 token 数，例如 128K 写作 131072。 */
  readonly maxOutputTokens: number;
  /**
   * 思考（思维链）支持方式：
   * - 'always-on-effort'：始终开启，可选推理力度 low / high / max（如 GLM-5.3）
   * - 'on-off-effort'：可开可关，可选推理力度 high / max（如 GLM-5.2）
   * - 'on-off'：可开可关，无力度档位（如 GLM-4.6 ~ GLM-5.1）
   * - 'always-on'：始终开启，不可关闭（如 GLM-4.5）
   * - 'none'：不支持思考，选择器只显示温度
   */
  readonly thinking: ThinkingSupport;
  /** 是否支持图片输入（视觉模型、Flash 多模态模型为 true）。 */
  readonly imageInput: boolean;
  /** 是否支持工具调用；不写时默认 true。 */
  readonly toolCalling?: boolean;
  /** 版本号；不写时由 id 去掉 'glm-' 前缀得到，如 'glm-5.3' → '5.3'。 */
  readonly version?: string;
}

/** 全部模型，按发布时间从新到旧排列。 */
export const MODEL_CATALOG: readonly ModelCatalogEntry[] = [
  {
    id: 'glm-5.3',
    name: 'GLM-5.3',
    maxInputTokens: 1000000,
    maxOutputTokens: 131072,
    thinking: 'always-on-effort',
    imageInput: false,
  },
  {
    id: 'glm-5.3-flash',
    name: 'GLM-5.3-Flash',
    maxInputTokens: 1000000,
    maxOutputTokens: 131072,
    thinking: 'always-on-effort',
    imageInput: true,
  },
  {
    id: 'glm-5.3-flashx',
    name: 'GLM-5.3-FlashX',
    maxInputTokens: 1000000,
    maxOutputTokens: 131072,
    thinking: 'always-on-effort',
    imageInput: true,
  },
  {
    id: 'glm-5.2',
    name: 'GLM-5.2',
    maxInputTokens: 1000000,
    maxOutputTokens: 131072,
    thinking: 'on-off-effort',
    imageInput: false,
  },
  {
    id: 'glm-5.1',
    name: 'GLM-5.1',
    maxInputTokens: 204800,
    maxOutputTokens: 131072,
    thinking: 'on-off',
    imageInput: false,
  },
  {
    id: 'glm-5',
    name: 'GLM-5',
    maxInputTokens: 204800,
    maxOutputTokens: 131072,
    thinking: 'on-off',
    imageInput: false,
  },
  {
    id: 'glm-5-turbo',
    name: 'GLM-5-Turbo',
    maxInputTokens: 204800,
    maxOutputTokens: 131072,
    thinking: 'on-off',
    imageInput: false,
  },
  {
    id: 'glm-5v-turbo',
    name: 'GLM-5V-Turbo',
    maxInputTokens: 204800,
    maxOutputTokens: 131072,
    thinking: 'on-off',
    imageInput: true,
  },
  {
    id: 'glm-4.7',
    name: 'GLM-4.7',
    maxInputTokens: 204800,
    maxOutputTokens: 131072,
    thinking: 'on-off',
    imageInput: false,
  },
  {
    id: 'glm-4.7-flash',
    name: 'GLM-4.7 Flash',
    maxInputTokens: 204800,
    maxOutputTokens: 131072,
    thinking: 'on-off',
    imageInput: false,
  },
  {
    id: 'glm-4.7-flashx',
    name: 'GLM-4.7 FlashX',
    maxInputTokens: 204800,
    maxOutputTokens: 131072,
    thinking: 'on-off',
    imageInput: false,
  },
  {
    id: 'glm-4.6',
    name: 'GLM-4.6',
    maxInputTokens: 204800,
    maxOutputTokens: 131072,
    thinking: 'on-off',
    imageInput: false,
  },
  {
    id: 'glm-4.6v',
    name: 'GLM-4.6V',
    maxInputTokens: 131072,
    maxOutputTokens: 32768,
    thinking: 'on-off',
    imageInput: true,
  },
  {
    id: 'glm-4.5',
    name: 'GLM-4.5',
    maxInputTokens: 131072,
    maxOutputTokens: 98304,
    thinking: 'always-on',
    imageInput: false,
  },
  {
    id: 'glm-4.5-flash',
    name: 'GLM-4.5 Flash',
    maxInputTokens: 131072,
    maxOutputTokens: 98304,
    thinking: 'always-on',
    imageInput: false,
  },
  {
    id: 'glm-4.5-air',
    name: 'GLM-4.5 Air',
    maxInputTokens: 131072,
    maxOutputTokens: 98304,
    thinking: 'always-on',
    imageInput: false,
  },
  {
    id: 'glm-4.5v',
    name: 'GLM-4.5V',
    maxInputTokens: 64000,
    maxOutputTokens: 16384,
    thinking: 'always-on',
    imageInput: true,
  },
];
