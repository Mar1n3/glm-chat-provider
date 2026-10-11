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
import {toAnthropicBody, toResponsesBody} from './protocol-adapters';
import {parseApiProtocol} from './protocol';
import {match} from 'ts-pattern';
import {chatBaseUrl, type ApiProtocol, type GlmRegion} from './region';
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
        `API key must be plain ASCII. Invalid character at index ${utf16Index} (Unicode U+${cp.toString(16).toUpperCase()}). Re-copy the key from your provider console without extra symbols.`,
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
 * 统一的流式事件：三种协议在内部都归一化成这个形状，
 * 上层（provider）只处理这一种结构。
 */
export interface NormalizedStreamChunk {
  /** 增量文本（无则省略）。 */
  text?: string;
  /** 增量思维/推理内容（无则省略）。 */
  thinking?: string;
  /** 工具调用增量：index 用于把分片参数拼回完整调用。 */
  toolCall?: {
    index: number;
    id?: string;
    name?: string;
    argumentsDelta?: string;
  };
  /** 结束原因：tool_calls 表示模型请求调用工具。 */
  finishReason?: 'stop' | 'tool_calls';
  /** 本次响应累计的 token 用量（通常在流的最后出现）。 */
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    cached_tokens?: number;
  };
}

/**
 * 极简 SSE 解析：把 fetch 返回的响应体按行读取，按空行切分事件帧，
 * 产出每帧 data 行拼接后的 JSON。按 SSE 规范同时兼容 LF / CRLF / CR
 * 三种换行（部分网关用 CRLF）；流结束时没有以空行收尾的最后一帧也会
 * 分发。event: / id: / retry: 行与 ':' 开头的注释行忽略——两种协议的
 * 事件类型都在 data JSON 的 type 字段里。
 */
/* eslint-disable @typescript-eslint/no-explicit-any -- SSE 事件负载是动态 JSON，字段随事件类型变化，强类型化收益低 */
async function* parseSse(
  response: Response,
  signal: AbortSignal,
): AsyncGenerator<{data: any}> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let dataLines: string[] = [];
  try {
    while (!signal.aborted) {
      const {done, value} = await reader.read();
      buffer += decoder.decode(value, {stream: !done});
      // 流结束时补一个空行，让最后一帧也能分发出去。
      if (done) {
        buffer += '\n\n';
      }
      // 末尾单独的 \r 可能是被拆到两个数据块的 \r\n，留到下一块再切。
      const lines = buffer.split(/\r\n|\n|\r(?!$)/);
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (line.startsWith('data:')) {
          dataLines.push(line.slice(line.startsWith('data: ') ? 6 : 5));
          continue;
        }
        if (line !== '' || dataLines.length === 0) {
          continue;
        }
        // 空行：一帧结束，分发累积的 data。
        const data = dataLines.join('\n').trim();
        dataLines = [];
        if (data === '[DONE]') {
          return;
        }
        try {
          yield {data: JSON.parse(data)};
        } catch {
          // 跳过无法解析的数据帧。
        }
      }
      if (done) {
        return;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/* ==================== Anthropic Messages 协议适配 ==================== */

/**
 * 把 Messages API 的流式事件归一化。工具调用按块 index 聚合；输入
 * token 数要从 message_start 记到 message_delta 才能汇总用量。
 */
/* eslint-disable @typescript-eslint/no-explicit-any -- 事件负载同上 */
class AnthropicStreamNormalizer {
  /** message_start 里给出的输入 token 数，用于在 message_delta 里汇总用量。 */
  private inputTokens = 0;

  next(event: any): NormalizedStreamChunk | undefined {
    switch (event?.type) {
      case 'message_start':
        this.inputTokens = event.message?.usage?.input_tokens ?? 0;
        return undefined;
      case 'content_block_start': {
        const block = event.content_block;
        if (block?.type === 'tool_use') {
          return {
            toolCall: {index: event.index, id: block.id, name: block.name},
          };
        }
        return undefined;
      }
      case 'content_block_delta': {
        const delta = event.delta;
        if (delta?.type === 'text_delta') {
          return {text: delta.text};
        }
        if (delta?.type === 'thinking_delta') {
          return {thinking: delta.thinking};
        }
        if (delta?.type === 'input_json_delta') {
          return {
            toolCall: {
              index: event.index,
              argumentsDelta: delta.partial_json,
            },
          };
        }
        return undefined;
      }
      case 'message_delta': {
        const reason = event.delta?.stop_reason;
        const outputTokens = event.usage?.output_tokens;
        return {
          finishReason: reason === 'tool_use' ? 'tool_calls' : 'stop',
          usage: outputTokens
            ? {
                prompt_tokens: this.inputTokens,
                completion_tokens: outputTokens,
                total_tokens: this.inputTokens + outputTokens,
              }
            : undefined,
        };
      }
      // 流中途的错误事件（如 overloaded_error）：抛出而不是静默结束，
      // 否则用户只会看到一个被截断的空回复。
      case 'error':
        throw new GlmApiError(
          `Custom provider error: ${event.error?.message ?? 'unknown'}`,
          0,
        );
      default:
        return undefined;
    }
  }
}

/* ==================== OpenAI Responses 协议适配 ==================== */

/** Responses API 流式事件的归一化（同样按 index 聚合工具调用）。 */
/* eslint-disable @typescript-eslint/no-explicit-any -- 事件负载同上 */
class ResponsesStreamNormalizer {
  next(event: any): NormalizedStreamChunk | undefined {
    switch (event?.type) {
      case 'response.output_text.delta':
        return {text: event.delta};
      case 'response.reasoning_text.delta':
      case 'response.reasoning_summary_text.delta':
        return {thinking: event.delta};
      case 'response.function_call_arguments.delta': {
        const index = event.output_index ?? 0;
        const item = event.item;
        if (item?.name) {
          return {
            toolCall: {
              index,
              id: item.call_id ?? item.id,
              name: item.name,
              argumentsDelta: event.delta,
            },
          };
        }
        return {toolCall: {index, argumentsDelta: event.delta}};
      }
      case 'response.output_item.added': {
        const item = event.item;
        if (item?.type === 'function_call') {
          return {
            toolCall: {
              index: event.output_index ?? 0,
              id: item.call_id ?? item.id,
              name: item.name,
            },
          };
        }
        return undefined;
      }
      case 'response.completed': {
        const usage = event.response?.usage;
        return {
          finishReason: 'stop',
          usage: usage
            ? {
                prompt_tokens: usage.input_tokens ?? 0,
                completion_tokens: usage.output_tokens ?? 0,
                total_tokens: usage.total_tokens ?? 0,
                cached_tokens:
                  usage.input_tokens_details?.cached_tokens ?? undefined,
              }
            : undefined,
        };
      }
      case 'response.failed':
      case 'error':
        throw new GlmApiError(
          `Custom provider error: ${event.error?.message ?? event.response?.error?.message ?? 'unknown'}`,
          0,
        );
      default:
        return undefined;
    }
  }
}

/**
 * GLM API 客户端。
 * 一个实例绑定一个 API key 和一个服务端点（官方平台区域或自定义服务商）；
 * 官方平台与 chat-completions 协议走 OpenAI SDK，自定义服务商的
 * messages / responses 协议走内置的轻量 SSE 客户端（见本文件上方）。
 */
export class GlmApiClient {
  private readonly client: OpenAI;
  /** 自定义服务商的接口协议；官方平台固定为 'chat-completions'。 */
  readonly protocol: ApiProtocol;
  /** 自定义服务商的 base 地址；官方平台为 undefined。 */
  private readonly customBaseUrl?: string;
  private readonly apiKey: string;

  /**
   * @param apiKey  用户的 API key
   * @param region  平台区域，决定请求发往 api.z.ai 还是 open.bigmodel.cn
   * @param custom  自定义服务商配置：base 地址原样使用，协议三选一
   */
  constructor(
    apiKey: string,
    region: GlmRegion = 'global',
    custom?: {baseUrl: string; protocol: ApiProtocol},
  ) {
    this.apiKey = prepareApiKeyForOpenAIClient(apiKey);
    this.protocol = parseApiProtocol(custom?.protocol);
    this.customBaseUrl = custom?.baseUrl;
    this.client = new OpenAI({
      apiKey: this.apiKey,
      baseURL: this.customBaseUrl ?? chatBaseUrl(region),
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
   *
   * 按构造时确定的协议分发：
   * - chat-completions：走 OpenAI SDK（官方平台）；
   * - messages / responses：走内置 SSE 客户端并归一化事件（自定义服务商）。
   */
  async *streamChat(
    model: string,
    messages: GlmMessage[],
    options?: ChatOptions,
    cancellationToken?: vscode.CancellationToken,
  ): AsyncGenerator<NormalizedStreamChunk> {
    const abortController = new AbortController();
    const cancellationDisposable = cancellationToken?.onCancellationRequested(
      () => abortController.abort(),
    );

    try {
      if (this.protocol === 'chat-completions') {
        // ---- OpenAI Chat Completions（OpenAI SDK）----
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
                chunk.usage as {
                  prompt_tokens_details?: {cached_tokens?: number};
                }
              ).prompt_tokens_details?.cached_tokens,
            });
          }

          // 归一化为统一结构（保持工具调用增量与结束原因语义）。
          for (const choice of chunk.choices) {
            const normalized: NormalizedStreamChunk = {};
            if (choice.delta?.content) {
              normalized.text = choice.delta.content;
            }
            const reasoning = (
              choice.delta as Record<string, unknown> | undefined
            )?.reasoning_content;
            if (typeof reasoning === 'string' && reasoning) {
              normalized.thinking = reasoning;
            }
            if (choice.delta?.tool_calls?.length) {
              for (const call of choice.delta.tool_calls) {
                yield {
                  ...normalized,
                  toolCall: {
                    index: call.index,
                    id: call.id || undefined,
                    name: call.function?.name || undefined,
                    argumentsDelta: call.function?.arguments || undefined,
                  },
                };
              }
            } else {
              yield normalized;
            }
            if (choice.finish_reason) {
              yield {
                finishReason:
                  choice.finish_reason === 'tool_calls' ? 'tool_calls' : 'stop',
              };
            }
          }
        }
        return;
      }

      // ---- 自定义服务商：内置 SSE 客户端 ----
      const {body, headers} = this.buildCustomRequest(
        model,
        messages,
        options,
        true,
      );
      const response = await fetch(this.customRequestUrl(), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...headers,
        },
        body: JSON.stringify(body),
        signal: abortController.signal,
      });
      if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new GlmApiError(
          `Custom provider error: HTTP ${response.status} ${text.slice(0, 300)}`,
          response.status,
        );
      }

      const anthropic =
        this.protocol === 'messages'
          ? new AnthropicStreamNormalizer()
          : undefined;
      const responses =
        this.protocol === 'responses'
          ? new ResponsesStreamNormalizer()
          : undefined;

      for await (const {data} of parseSse(response, abortController.signal)) {
        if (cancellationToken?.isCancellationRequested) {
          return;
        }
        const normalized = anthropic
          ? anthropic.next(data)
          : responses
            ? responses.next(data)
            : undefined;
        if (!normalized) {
          continue;
        }
        if (normalized.usage && options?.onUsage) {
          options.onUsage(normalized.usage);
        }
        yield normalized;
      }
    } catch (error) {
      if (error instanceof GlmApiError) {
        throw error;
      }
      throw this.toGlmApiError(error);
    } finally {
      cancellationDisposable?.dispose();
    }
  }

  /** 自定义服务商的请求端点：base + 各协议的标准路径。 */
  private customRequestUrl(): string {
    const base = this.customBaseUrl!;
    if (this.protocol === 'messages') {
      return `${base}/v1/messages`;
    }
    if (this.protocol === 'responses') {
      return `${base}/v1/responses`;
    }
    return `${base}/chat/completions`;
  }

  /** 自定义服务商的请求头与请求体（按协议分支）。 */
  private buildCustomRequest(
    model: string,
    messages: GlmMessage[],
    options: ChatOptions | undefined,
    stream: boolean,
  ): {body: Record<string, unknown>; headers: Record<string, string>} {
    if (this.protocol === 'messages') {
      return {
        body: toAnthropicBody(model, messages, options, stream),
        headers: {
          'x-api-key': this.apiKey,
          'anthropic-version': '2023-06-01',
          Authorization: `Bearer ${this.apiKey}`,
        },
      };
    }
    // responses 协议（自定义服务商暂无 SDK 依赖，直接 fetch）。
    return {
      body: toResponsesBody(model, messages, options, stream),
      headers: {Authorization: `Bearer ${this.apiKey}`},
    };
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
      if (this.protocol === 'chat-completions') {
        await this.client.chat.completions.create(
          this.buildNonStreamingParams(model, messages, options),
        );
        return;
      }
      const {body, headers} = this.buildCustomRequest(
        model,
        messages,
        options,
        false,
      );
      const response = await fetch(this.customRequestUrl(), {
        method: 'POST',
        headers: {'Content-Type': 'application/json', ...headers},
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        throw new GlmApiError(
          `Custom provider error: HTTP ${response.status}`,
          response.status,
        );
      }
      await response.arrayBuffer();
    } catch (error) {
      if (error instanceof GlmApiError) throw error;
      throw this.toGlmApiError(error);
    }
  }
}
