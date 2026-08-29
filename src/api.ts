/**
 * GLM 聊天 API 客户端。
 *
 * GLM 的编码接口兼容 OpenAI 的 Chat Completions 协议，因此这里直接使用
 * openai 官方 SDK，按平台区域切换 baseURL（见 region.ts）。本模块负责：
 * 1. 把 VS Code 侧的消息/工具定义转换成 OpenAI 协议格式；
 * 2. 发起流式（streamChat）/非流式（chat）请求；
 * 3. 把 SDK 抛出的错误统一包装成 GlmApiError。
 */
import type * as vscode from 'vscode';
import OpenAI from 'openai';
import {match} from 'ts-pattern';
import {chatBaseUrl, type GlmRegion} from './region';
import type {
  ChatCompletionChunk,
  ChatCompletionCreateParamsNonStreaming,
  ChatCompletionCreateParamsStreaming,
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from 'openai/resources/chat/completions/completions';

/** 消息内容单元：纯文本或图片（图片用 data URL 承载）。 */
export type GlmContentPart =
  | {type: 'text'; text: string}
  | {type: 'image_url'; image_url: {url: string}};

/** 发给 GLM 的一条对话消息。 */
export interface GlmMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | GlmContentPart[];
  name?: string;
  tool_calls?: GlmToolCall[];
  tool_call_id?: string;
}

/** 一次工具调用（assistant 请求调用某个函数）。 */
export interface GlmToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

/** 注册给模型的工具（函数）定义。 */
export interface GlmTool {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

/** 单次聊天请求的可选参数。 */
export interface ChatOptions {
  temperature?: number;
  topP?: number;
  maxTokens?: number;
  tools?: GlmTool[];
  stop?: string[];
  /** 思维模式开关，如 {type: 'enabled'} / {type: 'disabled'}。 */
  thinking?: Record<string, unknown>;
  /** 思维力度：low / high / max。 */
  reasoningEffort?: string;
  /** 服务端每次回报 token 用量时的回调。 */
  onUsage?: (usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    cached_tokens?: number;
  }) => void;
}

/** 统一的 GLM API 错误：携带 HTTP 状态码和可选的原始响应。 */
export class GlmApiError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly response?: unknown,
  ) {
    super(message);
    this.name = 'GlmApiError';
  }
}

/**
 * 清理并校验 API key：去除零宽字符等不可见符号和首尾空白，
 * 并确保 key 全部为 ASCII 字符（否则部分服务端会拒绝请求）。
 * 校验失败时抛出 GlmApiError。
 */
function prepareApiKeyForOpenAIClient(apiKey: string): string {
  const cleaned = apiKey.replace(/[\u200B-\u200D\ufeff\u00A0]/g, '').trim();
  let utf16Index = 0;
  for (const ch of cleaned) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp > 255) {
      throw new GlmApiError(
        `API key must be plain ASCII. Invalid character at index ${utf16Index} (Unicode U+${cp.toString(16).toUpperCase()}). Re-copy the key from the Z.AI console without extra symbols.`,
        400,
      );
    }
    utf16Index += ch.length;
  }
  if (!cleaned) {
    throw new GlmApiError('API key is empty after trimming.', 400);
  }
  return cleaned;
}

/**
 * GLM API 客户端。
 * 一个实例绑定一个 API key 和一个平台区域；内部持有一个 OpenAI SDK 客户端。
 */
export class GlmApiClient {
  private readonly client: OpenAI;

  /**
   * @param apiKey  用户的 API key
   * @param region  平台区域，决定请求发往 api.z.ai 还是 open.bigmodel.cn
   */
  constructor(apiKey: string, region: GlmRegion = 'global') {
    this.client = new OpenAI({
      apiKey: prepareApiKeyForOpenAIClient(apiKey),
      baseURL: chatBaseUrl(region),
    });
  }

  /** 把本扩展的消息格式转换为 OpenAI 协议的消息格式。 */
  private toOpenAiMessages(
    messages: GlmMessage[],
  ): ChatCompletionMessageParam[] {
    return messages.map(message =>
      match(message.role)
        .with('tool', () => ({
          role: 'tool' as const,
          content: message.content,
          tool_call_id: message.tool_call_id ?? '',
        }))
        .with('assistant', () =>
          message.tool_calls?.length
            ? {
                role: 'assistant' as const,
                content: message.content,
                tool_calls: message.tool_calls.map(call => ({
                  id: call.id,
                  type: 'function' as const,
                  function: {
                    name: call.function.name,
                    arguments: call.function.arguments,
                  },
                })),
              }
            : {
                role: 'assistant' as const,
                content: message.content,
              },
        )
        .with('system', () => ({
          role: 'system' as const,
          content: message.content,
        }))
        .otherwise(() => ({
          role: 'user' as const,
          content: message.content,
        })),
    ) as ChatCompletionMessageParam[];
  }

  /** 把本扩展的工具定义转换为 OpenAI 协议的格式；空列表返回 undefined。 */
  private toOpenAiTools(tools?: GlmTool[]): ChatCompletionTool[] | undefined {
    if (!tools?.length) {
      return undefined;
    }

    return tools.map(tool => ({
      type: 'function',
      function: {
        name: tool.function.name,
        description: tool.function.description,
        parameters: tool.function.parameters,
      },
    }));
  }

  /** 把可选参数（topP / maxTokens / stop / thinking / tools 等）填进请求体。 */
  private applyOptionalParams(
    params:
      | ChatCompletionCreateParamsStreaming
      | ChatCompletionCreateParamsNonStreaming,
    options?: ChatOptions,
  ): void {
    if (options?.topP !== undefined) {
      params.top_p = options.topP;
    }
    if (options?.maxTokens !== undefined) {
      params.max_tokens = options.maxTokens;
    }
    if (options?.stop?.length) {
      params.stop = options.stop;
    }
    if (options?.thinking) {
      (params as unknown as Record<string, unknown>).thinking =
        options.thinking;
    }
    if (options?.reasoningEffort) {
      (params as unknown as Record<string, unknown>).reasoning_effort =
        options.reasoningEffort;
    }

    const tools = this.toOpenAiTools(options?.tools);
    if (tools) {
      params.tools = tools;
    }
  }

  /** 组装流式请求参数：stream: true 并要求服务端附带 token 用量。 */
  private buildStreamingParams(
    model: string,
    messages: GlmMessage[],
    options?: ChatOptions,
  ): ChatCompletionCreateParamsStreaming {
    const params: ChatCompletionCreateParamsStreaming = {
      model,
      messages: this.toOpenAiMessages(messages),
      stream: true,
      stream_options: {include_usage: true},
    };
    if (options?.temperature !== undefined) {
      params.temperature = options.temperature;
    }
    this.applyOptionalParams(params, options);
    return params;
  }

  /** 组装非流式请求参数（一次性返回完整结果）。 */
  private buildNonStreamingParams(
    model: string,
    messages: GlmMessage[],
    options?: ChatOptions,
  ): ChatCompletionCreateParamsNonStreaming {
    const params: ChatCompletionCreateParamsNonStreaming = {
      model,
      messages: this.toOpenAiMessages(messages),
      stream: false,
    };
    if (options?.temperature !== undefined) {
      params.temperature = options.temperature;
    }
    this.applyOptionalParams(params, options);
    return params;
  }

  /** 把任意抛出的异常统一转换成 GlmApiError，方便上层按状态码处理。 */
  private toGlmApiError(error: unknown): GlmApiError {
    return match(error)
      .when(
        (value): value is InstanceType<typeof OpenAI.APIError> =>
          value instanceof OpenAI.APIError,
        value =>
          new GlmApiError(
            `GLM API error: ${value.status} ${value.message}`,
            value.status ?? 0,
            value.error,
          ),
      )
      .when(
        (value): value is Error => value instanceof Error,
        value => new GlmApiError(`GLM API error: ${value.message}`, 0),
      )
      .otherwise(
        value => new GlmApiError(`GLM API error: ${String(value)}`, 0),
      );
  }

  /**
   * 流式聊天：逐块（chunk）产出服务端返回的内容。
   * 调用方用 for-await 循环消费；每个 chunk 携带一小段增量文本或工具调用。
   * 若服务端返回了 token 用量，会触发 options.onUsage 回调。
   * 支持通过 cancellationToken 中途取消请求。
   */
  async *streamChat(
    model: string,
    messages: GlmMessage[],
    options?: ChatOptions,
    cancellationToken?: vscode.CancellationToken,
  ): AsyncGenerator<ChatCompletionChunk> {
    const abortController = new AbortController();
    const cancellationDisposable = cancellationToken?.onCancellationRequested(
      () => abortController.abort(),
    );

    try {
      const stream = (await this.client.chat.completions.create(
        this.buildStreamingParams(model, messages, options),
        {
          signal: abortController.signal,
        },
      )) as AsyncIterable<ChatCompletionChunk>;

      for await (const chunk of stream) {
        if (cancellationToken?.isCancellationRequested) {
          return;
        }

        if (chunk.usage && options?.onUsage) {
          options.onUsage({
            prompt_tokens: chunk.usage.prompt_tokens,
            completion_tokens: chunk.usage.completion_tokens,
            total_tokens: chunk.usage.total_tokens,
            cached_tokens: (
              chunk.usage as {prompt_tokens_details?: {cached_tokens?: number}}
            ).prompt_tokens_details?.cached_tokens,
          });
        }

        yield chunk;
      }
    } catch (error) {
      throw this.toGlmApiError(error);
    } finally {
      cancellationDisposable?.dispose();
    }
  }

  /**
   * 非流式聊天：一次性等完整响应。仅用于连通性测试等简单场景。
   */
  async chat(
    model: string,
    messages: GlmMessage[],
    options?: ChatOptions,
  ): Promise<void> {
    try {
      await this.client.chat.completions.create(
        this.buildNonStreamingParams(model, messages, options),
      );
    } catch (error) {
      throw this.toGlmApiError(error);
    }
  }
}
