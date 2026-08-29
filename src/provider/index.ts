import * as vscode from 'vscode';
import {match} from 'ts-pattern';
import {GlmApiClient, GlmApiError, type NormalizedStreamChunk} from '../api';
import type {AuthManager} from '../auth';
import {
  pickChatRegions,
  resolveApiProvider,
  setDetectedRegion,
  type ApiProtocol,
} from '../region';
import {
  GLM_MODEL_DEFINITIONS,
  getModelConfigurationSchema,
  type GlmModelDefinition,
  type ModelConfigurationOptions,
  type ModelPickerChatInformation,
} from '../models';
import {createThinkingPart} from './thinking';
import {
  convertMessages,
  convertTools,
  parseToolArguments,
  type ToolCallBuilder,
} from './convert';
import {getConfiguredTemperature} from './temperature';

/**
 * 在 VS Code 模型信息上扩展的内部类型：额外挂一个 __glmApiKey 字段，
 * 用于把 API Key 绑定到具体模型上。后续发起聊天请求时可直接从模型
 * 信息里取到密钥，而不必再次访问全局凭据存储。
 */
type ModelWithApiKey = vscode.LanguageModelChatInformation & {
  __glmApiKey?: string;
};

/**
 * VS Code 的 PrepareLanguageModelChatModelOptions，并扩展可选的
 * configuration 字段：用于承载用户在聊天模型选择器上保存的配置
 * （例如本扩展写入的 apiKey）。
 */
type PrepareLanguageModelChatInfoOptions =
  vscode.PrepareLanguageModelChatModelOptions & {
    readonly configuration?: {
      readonly apiKey?: string;
      readonly [key: string]: unknown;
    };
  };

/**
 * 把一条 GLM 模型定义转换成 VS Code 模型选择器所需的
 * LanguageModelChatInformation（带类型字段的 ModelPickerChatInformation）。
 * 支持思维链的模型会附加 configurationSchema，供选择器展示 thinking 配置。
 */
function toChatInfo(m: GlmModelDefinition): ModelPickerChatInformation {
  return {
    id: m.id,
    name: m.name,
    family: m.family,
    version: m.version,
    detail: m.detail,
    tooltip: 'Z.AI',
    maxInputTokens: m.maxInputTokens,
    maxOutputTokens: m.maxOutputTokens,
    isUserSelectable: true,
    capabilities: {
      toolCalling: m.capabilities.toolCalling,
      imageInput: m.capabilities.imageInput,
    },
    ...(m.capabilities.thinking
      ? {configurationSchema: getModelConfigurationSchema(m.thinkingSupport)}
      : {}),
  };
}

/**
 * 预先把全部 GLM 模型定义转换好的模型信息列表（不含 apiKey 的公共部分），
 * 供每次 provideLanguageModelChatInformation 复用，避免重复转换。
 */
const TYPED_MODELS: ModelPickerChatInformation[] = GLM_MODEL_DEFINITIONS.map(
  m => toChatInfo(m),
);

/**
 * 用量回调类型：当一次请求拿到 token 用量时，以 OpenAI 形状的字段
 * 通知给外部（例如本扩展的用量统计面板）。
 */
export type UsageCallback = (usage: {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  cached_tokens?: number;
}) => void;

/**
 * GLM 聊天提供者：实现 VS Code 的 LanguageModelChatProvider 接口。
 * 职责包括：向 VS Code 上报可用模型列表（并绑定 apiKey）、处理一次
 * 聊天请求（区域候选回退、流式增量上报、工具调用拼装、思维内容透传）、
 * 在流结束时上报 token 用量，以及把 API 错误映射成友好提示。
 */
export class GlmChatProvider implements vscode.LanguageModelChatProvider {
  private readonly _onDidChangeLanguageModelChatInformation =
    new vscode.EventEmitter<void>();

  readonly onDidChangeLanguageModelChatInformation =
    this._onDidChangeLanguageModelChatInformation.event;

  constructor(
    private readonly authManager: AuthManager,
    private readonly onUsage?: UsageCallback,
  ) {}

  /** 通知 VS Code 模型信息已变化，促使其重新拉取模型列表。 */
  fireLanguageModelChatInformationChange(): void {
    this._onDidChangeLanguageModelChatInformation.fire();
  }

  /**
   * 返回当前可用的模型列表（VS Code 会在需要时调用本方法）。
   * @param options 携带用户配置，其中的 apiKey 用于判断是否已配置密钥
   * @param token 取消令牌（列出模型是纯本地操作，本实现不使用）
   * 配置缺失或 apiKey 为空时返回空列表；否则返回全部模型，并把 apiKey
   * 挂在每个模型信息（__glmApiKey）上，供后续聊天请求直接使用。
   */
  async provideLanguageModelChatInformation(
    options: PrepareLanguageModelChatInfoOptions,
    token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelChatInformation[]> {
    void token; // 显式标记该参数未使用，避免触发 lint 告警。
    if (options.configuration === undefined) {
      return [];
    }

    const raw = options.configuration.apiKey;
    const apiKey =
      typeof raw === 'string' && raw.trim().length > 0 ? raw.trim() : undefined;

    if (!apiKey) {
      return [];
    }

    return this.modelsWithApiKey(apiKey);
  }

  /** 为每个预转换模型克隆一份并挂上 __glmApiKey，形成最终上报的模型列表。 */
  private modelsWithApiKey(
    apiKey: string,
  ): vscode.LanguageModelChatInformation[] {
    return TYPED_MODELS.map(model => ({
      ...model,
      __glmApiKey: apiKey,
    })) as unknown as vscode.LanguageModelChatInformation[];
  }

  /**
   * 处理一次聊天请求（语言模型提供者的核心入口）。
   * 密钥来源：优先使用模型信息上挂的 __glmApiKey，没有则向 AuthManager
   * 获取（必要时弹窗提示用户输入）。随后按区域候选顺序逐个尝试
   * streamResponse：只有 401/403 这类鉴权错误（发生在产生任何流内容
   * 之前）才回退到下一个平台；成功后 setDetectedRegion 缓存该平台，
   * 后续请求直接复用、不再探测。最终捕获到的错误经 throwMappedError
   * 转换成友好错误后抛出。
   */
  async provideLanguageModelChatResponse(
    model: vscode.LanguageModelChatInformation,
    messages: readonly vscode.LanguageModelChatRequestMessage[],
    options: vscode.ProvideLanguageModelChatResponseOptions,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    token: vscode.CancellationToken,
  ): Promise<void> {
    // 密钥来源：优先用模型信息上挂的 __glmApiKey；缺失时向 AuthManager
    // 获取（必要时弹窗提示用户输入）。
    const modelApiKey = (model as ModelWithApiKey).__glmApiKey;
    const apiKey =
      modelApiKey && modelApiKey.trim().length > 0
        ? modelApiKey
        : await this.authManager.getOrPromptApiKey();

    if (!apiKey) {
      throw new Error(
        'API key not configured. Use "GLM: Set API Key" command.',
      );
    }

    try {
      const config = vscode.workspace.getConfiguration('glm-chat-provider');
      const providerSetting = config.get<string>('apiProvider');
      const customBaseUrl = config.get<string>('customBaseUrl');
      const customProtocol = config.get<string>(
        'customApiProtocol',
        'chat-completions',
      );
      const resolved = resolveApiProvider(providerSetting, customBaseUrl);

      if (resolved.provider === 'custom') {
        // 自定义服务商：单一端点，无区域探测、无用量功能。
        const client = new GlmApiClient(apiKey, 'china', {
          baseUrl: resolved.customBaseUrl!,
          protocol: customProtocol as ApiProtocol,
        });
        await this.streamResponse(
          client,
          model,
          messages,
          options,
          progress,
          token,
        );
        return;
      }

      // 官方平台：按区域候选顺序尝试，鉴权失败时回退另一个平台。
      const regionSetting = config.get<string>('apiRegion', 'auto');
      const regions = pickChatRegions(regionSetting);
      let lastError: unknown;

      for (const [index, region] of regions.entries()) {
        try {
          await this.streamResponse(
            new GlmApiClient(apiKey, region),
            model,
            messages,
            options,
            progress,
            token,
          );
          // 记住成功的平台并缓存，后续请求可跳过区域探测。
          setDetectedRegion(region);
          lastError = undefined;
          break;
        } catch (error) {
          lastError = error;
          // 只有鉴权错误（401/403）才回退到下一个平台：这类错误发生在
          // 产生任何流内容之前，回退不会造成内容重复输出。
          const canFallback =
            index < regions.length - 1 &&
            error instanceof GlmApiError &&
            (error.statusCode === 401 || error.statusCode === 403);
          if (!canFallback) {
            break;
          }
        }
      }

      if (lastError !== undefined) {
        await this.throwMappedError(lastError);
      }
    } catch (error) {
      await this.throwMappedError(error);
    }
  }

  /**
   * 根据模型的 thinkingSupport 类型与用户配置，解析出请求体需要的
   * thinking 开关和 reasoning_effort 参数。
   * @param modelId 模型 id，用于查找模型定义、判断其思维支持类型
   * @param options 聊天选择器传入的配置，取值优先级高于全局设置
   * 支持类型含义：on-off 可开关；on-off-effort 可开关且可选推理力度；
   * always-on-effort 强制开启、只能调力度；其余视为不支持思维链。
   * 返回空对象表示本次请求不带任何 thinking 相关字段。
   */
  private resolveThinking(
    modelId: string,
    options?: ModelConfigurationOptions,
  ): {thinking?: Record<string, unknown>; reasoningEffort?: string} {
    const def = GLM_MODEL_DEFINITIONS.find(m => m.id === modelId);
    const canDisable =
      def?.thinkingSupport === 'on-off' ||
      def?.thinkingSupport === 'on-off-effort';
    const hasEffort = def?.thinkingSupport === 'on-off-effort';
    const alwaysOnWithEffort = def?.thinkingSupport === 'always-on-effort';

    if (alwaysOnWithEffort) {
      // GLM-5.3 系列：思维链强制开启且不可关闭，只能控制
      // reasoning_effort（low/high/max）。
      const configuredMode =
        options?.modelConfiguration?.thinkingMode ??
        options?.configuration?.thinkingMode;

      const globalConfig = vscode.workspace
        .getConfiguration('glm-chat-provider')
        .get<string>('defaultThinkingMode', 'auto');

      const mode = configuredMode ?? globalConfig;
      if (mode === 'low') {
        return {thinking: {type: 'enabled'}, reasoningEffort: 'low'};
      }
      if (mode === 'high') {
        return {thinking: {type: 'enabled'}, reasoningEffort: 'high'};
      }
      if (mode === 'max') {
        return {thinking: {type: 'enabled'}, reasoningEffort: 'max'};
      }
      // API 默认 reasoning_effort 就是 'max'，因此只需传强制开启标志。
      return {thinking: {type: 'enabled'}};
    }

    if (options) {
      const configuredMode =
        options.modelConfiguration?.thinkingMode ??
        options.configuration?.thinkingMode;

      if (hasEffort) {
        if (configuredMode === 'high') {
          return {thinking: {type: 'enabled'}, reasoningEffort: 'high'};
        }
        if (configuredMode === 'max') {
          return {thinking: {type: 'enabled'}, reasoningEffort: 'max'};
        }
        if (configuredMode === 'disabled') {
          return {thinking: {type: 'disabled'}};
        }
      } else {
        if (configuredMode === 'enabled') {
          // GLM 5.1+/5/4.7 系列默认已开启思维链；若在 type: 'enabled' 之外
          // 附带 clear_thinking 等额外字段，新模型会校验报错，因此只传
          // {type: 'enabled'}，不带任何额外字段。
          return {thinking: {type: 'enabled'}};
        }
        if (configuredMode === 'disabled' && canDisable) {
          return {thinking: {type: 'disabled'}};
        }
      }
    }

    const config = vscode.workspace
      .getConfiguration('glm-chat-provider')
      .get<string>('defaultThinkingMode', 'auto');

    if (hasEffort) {
      if (config === 'high') {
        return {thinking: {type: 'enabled'}, reasoningEffort: 'high'};
      }
      if (config === 'max') {
        return {thinking: {type: 'enabled'}, reasoningEffort: 'max'};
      }
      if (config === 'disabled') {
        return {thinking: {type: 'disabled'}};
      }
    } else {
      if (config === 'enabled') {
        return {thinking: {type: 'enabled'}};
      }
      if (config === 'disabled' && canDisable) {
        return {thinking: {type: 'disabled'}};
      }
    }

    return {};
  }

  /**
   * 建立 GLM 流式请求并逐 chunk 消费，把增量内容通过 progress 上报。
   * 流程：准备温度与 thinking 参数 → 调用 client.streamChat 建流 →
   * 逐 chunk 处理每个 choice：reportDelta 上报思维/正文增量文本；
   * collectToolCalls 按 index 累积工具调用分片；finish_reason 为
   * 'tool_calls' 时立即上报已完成的工具调用。流结束后再统一上报一次
   * 工具调用（兜底），最后上报 token 用量。
   */
  private async streamResponse(
    client: GlmApiClient,
    model: vscode.LanguageModelChatInformation,
    messages: readonly vscode.LanguageModelChatRequestMessage[],
    options: vscode.ProvideLanguageModelChatResponseOptions,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    token: vscode.CancellationToken,
  ): Promise<void> {
    const toolCallBuilders = new Map<number, ToolCallBuilder>();

    const modelConfig = options as ModelConfigurationOptions;
    const temperature = getConfiguredTemperature(modelConfig);
    const {thinking, reasoningEffort} = this.resolveThinking(
      model.id,
      modelConfig,
    );

    let lastUsage:
      | {
          prompt_tokens: number;
          completion_tokens: number;
          total_tokens: number;
          cached_tokens?: number;
        }
      | undefined;

    const stream = client.streamChat(
      model.id,
      convertMessages(messages),
      {
        maxTokens: options.modelOptions?.maxTokens as number | undefined,
        tools: convertTools(options.tools),
        temperature,
        thinking,
        reasoningEffort,
        // API 回传用量时：暂存到 lastUsage（流结束后上报给 VS Code），
        // 并转发给外部监听者（如用量面板）。
        onUsage: usage => {
          lastUsage = usage;
          this.onUsage?.(usage);
        },
      },
      token,
    );

    for await (const chunk of stream) {
      // 用户已取消请求时直接返回，不再处理和上报后续内容。
      if (token.isCancellationRequested) {
        return;
      }

      // 统一 chunk 结构：文本增量 / 思维增量 / 工具调用增量 / 结束原因。
      if (chunk.thinking) {
        this.reportThinking(chunk.thinking, progress);
      }
      if (chunk.text) {
        progress.report(new vscode.LanguageModelTextPart(chunk.text));
      }
      if (chunk.toolCall) {
        this.collectToolCall(chunk.toolCall, toolCallBuilders);
      }
      if (chunk.finishReason === 'tool_calls') {
        this.reportToolCalls(progress, toolCallBuilders);
      }
    }

    this.reportToolCalls(progress, toolCallBuilders);
    this.reportUsage(lastUsage, progress);
  }

  /**
   * 在流结束时向聊天界面上报 token 用量：发出一个 MIME 类型为 'usage'
   * 的 LanguageModelDataPart，载荷是 OpenAI 形状的 usage JSON
   * （cached_tokens 放在 prompt_tokens_details 里）。VS Code 聊天界面
   * 的上下文窗口指示器依靠它来显示本次请求的 token 消耗。
   */
  private reportUsage(
    usage:
      | {
          prompt_tokens: number;
          completion_tokens: number;
          total_tokens: number;
          cached_tokens?: number;
        }
      | undefined,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
  ): void {
    if (!usage) {
      return;
    }
    const payload = {
      prompt_tokens: usage.prompt_tokens,
      completion_tokens: usage.completion_tokens,
      total_tokens: usage.total_tokens,
      prompt_tokens_details: {cached_tokens: usage.cached_tokens ?? 0},
    };
    progress.report(
      new vscode.LanguageModelDataPart(
        new TextEncoder().encode(JSON.stringify(payload)),
        'usage',
      ),
    );
  }

  /**
   * 上报思维链增量内容：包装成 LanguageModelThinkingPart 上报。
   * LanguageModelThinkingPart 是提案 API，旧版本运行时不存在，
   * createThinkingPart 内部会探测并优雅降级。
   */
  private reportThinking(
    thinking: string,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
  ): void {
    const thinkingPart = createThinkingPart(thinking);
    if (thinkingPart) {
      progress.report(thinkingPart);
    }
  }

  /**
   * 累积流式到达的工具调用分片。
   * 流式模式下，同一个工具调用的 id、函数名和参数 JSON 会拆成多个分片、
   * 按 index 分批到达：这里按 index 找到（或新建）对应的 builder，
   * 把各字段逐段拼接，等 finish_reason 或流结束时由 reportToolCalls
   * 统一上报。
   */
  private collectToolCall(
    call: NormalizedStreamChunk['toolCall'],
    builders: Map<number, ToolCallBuilder>,
  ): void {
    if (!call) {
      return;
    }

    const builder = builders.get(call.index) ?? {
      id: '',
      name: '',
      arguments: '',
    };

    if (call.id) {
      builder.id = call.id;
    }
    if (call.name) {
      builder.name = call.name;
    }
    if (call.argumentsDelta) {
      builder.arguments += call.argumentsDelta;
    }

    builders.set(call.index, builder);
  }

  /**
   * 把累积完成的工具调用统一上报为 LanguageModelToolCallPart。
   * 缺少 id 或 name 的条目视为不完整、直接跳过；上报完成后清空缓存，
   * 以便同一流中后续新的工具调用从头累积。
   */
  private reportToolCalls(
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    builders: Map<number, ToolCallBuilder>,
  ): void {
    if (builders.size === 0) {
      return;
    }

    for (const builder of builders.values()) {
      if (!builder.id || !builder.name) {
        continue;
      }

      progress.report(
        new vscode.LanguageModelToolCallPart(
          builder.id,
          builder.name,
          parseToolArguments(builder.arguments),
        ),
      );
    }

    builders.clear();
  }

  /**
   * 把 GLM API 错误映射成面向用户的友好错误后抛出。
   * 401：删除已失效的 API Key 并提示用户重新设置；429：提示触发限流；
   * 其余 GlmApiError：附带原始错误信息；非 GlmApiError 的异常原样抛出。
   */
  private async throwMappedError(error: unknown): Promise<never> {
    if (!(error instanceof GlmApiError)) {
      throw error;
    }

    await match(error.statusCode)
      .with(401, async () => {
        await this.authManager.deleteApiKey();
        throw new Error(
          'Invalid API key. Please set a new one using "GLM: Set API Key".',
        );
      })
      .with(429, async () => {
        throw new Error('Rate limit exceeded. Please wait and try again.');
      })
      .otherwise(async () => {
        throw new Error(`GLM API error: ${error.message}`);
      });

    throw error;
  }

  /**
   * 估算一段文本或一条消息的 token 数（粗略近似：每 4 个字符折算
   * 1 个 token，向上取整）。消息形式只累计其中文本部件的字符数；
   * model 与 token 参数在本实现中未使用。
   */
  provideTokenCount(
    model: vscode.LanguageModelChatInformation,
    text: string | vscode.LanguageModelChatRequestMessage,
    token: vscode.CancellationToken,
  ): Thenable<number> {
    void model;
    void token;
    if (typeof text === 'string') {
      return Promise.resolve(Math.ceil(text.length / 4));
    }

    let totalChars = 0;
    for (const part of text.content) {
      if (part instanceof vscode.LanguageModelTextPart) {
        totalChars += part.value.length;
      }
    }
    return Promise.resolve(Math.ceil(totalChars / 4));
  }
}
