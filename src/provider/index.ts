import * as vscode from 'vscode';
import {match} from 'ts-pattern';
import {GlmApiClient, GlmApiError} from '../api';
import type {ChatCompletionChunk} from 'openai/resources/chat/completions/completions';
import type {AuthManager} from '../auth';
import {pickChatRegions, setDetectedRegion} from '../region';
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

type ModelWithApiKey = vscode.LanguageModelChatInformation & {
  __glmApiKey?: string;
};

type PrepareLanguageModelChatInfoOptions =
  vscode.PrepareLanguageModelChatModelOptions & {
    readonly configuration?: {
      readonly apiKey?: string;
      readonly [key: string]: unknown;
    };
  };

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

const TYPED_MODELS: ModelPickerChatInformation[] = GLM_MODEL_DEFINITIONS.map(
  m => toChatInfo(m),
);

export type UsageCallback = (usage: {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  cached_tokens?: number;
}) => void;

export class GlmChatProvider implements vscode.LanguageModelChatProvider {
  private readonly _onDidChangeLanguageModelChatInformation =
    new vscode.EventEmitter<void>();

  readonly onDidChangeLanguageModelChatInformation =
    this._onDidChangeLanguageModelChatInformation.event;

  constructor(
    private readonly authManager: AuthManager,
    private readonly onUsage?: UsageCallback,
  ) {}

  fireLanguageModelChatInformationChange(): void {
    this._onDidChangeLanguageModelChatInformation.fire();
  }

  async provideLanguageModelChatInformation(
    options: PrepareLanguageModelChatInfoOptions,
    token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelChatInformation[]> {
    void token;
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

  private modelsWithApiKey(
    apiKey: string,
  ): vscode.LanguageModelChatInformation[] {
    return TYPED_MODELS.map(model => ({
      ...model,
      __glmApiKey: apiKey,
    })) as unknown as vscode.LanguageModelChatInformation[];
  }

  async provideLanguageModelChatResponse(
    model: vscode.LanguageModelChatInformation,
    messages: readonly vscode.LanguageModelChatRequestMessage[],
    options: vscode.ProvideLanguageModelChatResponseOptions,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    token: vscode.CancellationToken,
  ): Promise<void> {
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
      const regionSetting = vscode.workspace
        .getConfiguration('glm-chat-provider')
        .get<string>('apiRegion', 'auto');
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
          // Remember the platform that worked so later requests skip probing.
          setDetectedRegion(region);
          lastError = undefined;
          break;
        } catch (error) {
          lastError = error;
          // Only fall back to the next platform on auth errors, which happen
          // before any stream content is produced.
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
      // GLM-5.3 series: thinking is always enabled and cannot be disabled.
      // Only reasoning_effort (low/high/max) can be controlled.
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
      // API default reasoning_effort is 'max'; only send the always-on flag.
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
          // For GLM 5.1+/5/4.7 series, thinking is enabled by default.
          // Sending clear_thinking alongside type: 'enabled' causes a validation
          // error on newer models. Only send {type: 'enabled'} without extra fields.
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
        onUsage: usage => {
          lastUsage = usage;
          this.onUsage?.(usage);
        },
      },
      token,
    );

    for await (const chunk of stream) {
      if (token.isCancellationRequested) {
        return;
      }

      for (const choice of chunk.choices) {
        this.reportDelta(choice.delta, progress);
        this.collectToolCalls(choice.delta.tool_calls, toolCallBuilders);
        if (choice.finish_reason === 'tool_calls') {
          this.reportToolCalls(progress, toolCallBuilders);
        }
      }
    }

    this.reportToolCalls(progress, toolCallBuilders);
    this.reportUsage(lastUsage, progress);
  }

  /**
   * Reports token usage to the chat UI so the context-window indicator has
   * data. This mirrors VS Code's first-party providers: emit a
   * `LanguageModelDataPart` with the `usage` MIME type containing
   * OpenAI-shaped usage JSON at the end of the response stream.
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

  private reportDelta(
    delta: ChatCompletionChunk.Choice.Delta,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
  ): void {
    const deltaAny = delta as Record<string, unknown>;

    const reasoningContent = deltaAny.reasoning_content;
    if (typeof reasoningContent === 'string' && reasoningContent) {
      const thinkingPart = createThinkingPart(reasoningContent);
      if (thinkingPart) {
        progress.report(thinkingPart);
      }
    }

    if (delta.content) {
      progress.report(new vscode.LanguageModelTextPart(delta.content));
    }
  }

  private collectToolCalls(
    toolCalls: ChatCompletionChunk.Choice.Delta.ToolCall[] | undefined,
    builders: Map<number, ToolCallBuilder>,
  ): void {
    if (!toolCalls?.length) {
      return;
    }

    for (const call of toolCalls) {
      const builder = builders.get(call.index) ?? {
        id: '',
        name: '',
        arguments: '',
      };

      if (call.id) {
        builder.id = call.id;
      }
      if (call.function?.name) {
        builder.name = call.function.name;
      }
      if (call.function?.arguments) {
        builder.arguments += call.function.arguments;
      }

      builders.set(call.index, builder);
    }
  }

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
