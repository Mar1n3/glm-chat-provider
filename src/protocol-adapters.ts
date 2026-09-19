import type {ChatOptions, GlmContentPart, GlmMessage} from './api';
import type {ApiProtocol} from './region';
import {supportsEffort} from './protocol';

type Block = Record<string, unknown>;

function parts(content: GlmMessage['content']): GlmContentPart[] {
  return typeof content === 'string'
    ? [{type: 'text', text: content}]
    : content;
}

function textOnly(content: GlmMessage['content'], context: string): string {
  return parts(content)
    .map(part => {
      if (part.type !== 'text')
        throw new Error(`${context} does not support images.`);
      return part.text;
    })
    .join('');
}

function imageSource(url: string): Block {
  const data =
    /^data:(image\/(?:jpeg|png|gif|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(
      url,
    );
  if (data) return {type: 'base64', media_type: data[1], data: data[2]};
  if (/^https?:\/\//.test(url)) return {type: 'url', url};
  throw new Error(
    'Messages images require an HTTP(S) URL or a base64 JPEG, PNG, GIF or WebP data URL.',
  );
}

function anthropicContent(content: GlmMessage['content']): Block[] {
  return parts(content).map(part =>
    part.type === 'text'
      ? {type: 'text', text: part.text}
      : {type: 'image', source: imageSource(part.image_url.url)},
  );
}

function responseContent(content: GlmMessage['content']): Block[] {
  return parts(content).map(part =>
    part.type === 'image_url'
      ? {type: 'input_image', image_url: part.image_url.url, detail: 'auto'}
      : {type: 'input_text', text: part.text},
  );
}

function validateEffort(protocol: ApiProtocol, options?: ChatOptions): void {
  const effort = options?.reasoningEffort;
  if (effort !== undefined && !supportsEffort(protocol, effort)) {
    throw new Error(
      `${protocol} does not support reasoning effort "${effort}". Select a supported effort in the model settings.`,
    );
  }
  if (effort && options?.thinking?.type === 'disabled') {
    throw new Error(
      'Reasoning effort cannot be combined with disabled thinking.',
    );
  }
}

/** Messages wire format; content and tool results stay in their original order. */
export function toAnthropicBody(
  model: string,
  messages: GlmMessage[],
  options: ChatOptions | undefined,
  stream: boolean,
): Record<string, unknown> {
  validateEffort('messages', options);
  const system: string[] = [];
  const converted: Array<{role: string; content: Block[]}> = [];
  const append = (role: string, content: Block[]) => {
    const previous = converted[converted.length - 1];
    if (previous?.role === role) previous.content.push(...content);
    else converted.push({role, content});
  };
  for (const message of messages) {
    if (message.role === 'system') {
      system.push(textOnly(message.content, 'Messages system instructions'));
    } else if (message.role === 'tool') {
      append('user', [
        {
          type: 'tool_result',
          tool_use_id: message.tool_call_id ?? '',
          content: anthropicContent(message.content),
        },
      ]);
    } else {
      const content = anthropicContent(message.content).filter(
        block => block.type !== 'text' || block.text !== '',
      );
      for (const call of message.tool_calls ?? []) {
        // Invalid arguments must not silently become a different tool invocation.
        const input: unknown = JSON.parse(call.function.arguments || '{}');
        if (!input || typeof input !== 'object' || Array.isArray(input))
          throw new Error('Tool arguments must be a JSON object.');
        content.push({
          type: 'tool_use',
          id: call.id,
          name: call.function.name,
          input,
        });
      }
      append(message.role, content);
    }
  }
  const body: Record<string, unknown> = {
    model,
    max_tokens: options?.maxTokens ?? 8192,
    messages: converted,
    stream,
  };
  if (system.length) body.system = system.join('\n\n');
  if (options?.temperature !== undefined)
    body.temperature = options.temperature;
  if (options?.topP !== undefined) body.top_p = options.topP;
  if (options?.stop?.length) body.stop_sequences = options.stop;
  if (options?.reasoningEffort)
    body.output_config = {effort: options.reasoningEffort};
  if (options?.thinking?.type === 'enabled') {
    // Adaptive thinking uses output_config.effort instead of inventing a token budget.
    body.thinking = {type: 'adaptive'};
  } else if (options?.thinking?.type === 'disabled') {
    body.thinking = {type: 'disabled'};
  }
  if (options?.tools?.length)
    body.tools = options.tools.map(tool => ({
      name: tool.function.name,
      description: tool.function.description,
      input_schema: tool.function.parameters,
    }));
  return body;
}

/** Responses wire format; assistant tool calls precede function_call_output items. */
export function toResponsesBody(
  model: string,
  messages: GlmMessage[],
  options: ChatOptions | undefined,
  stream: boolean,
): Record<string, unknown> {
  validateEffort('responses', options);
  if (options?.stop?.length)
    throw new Error('Responses does not support stop sequences.');
  const instructions: string[] = [];
  const input: Block[] = [];
  for (const message of messages) {
    if (message.role === 'system') {
      instructions.push(
        textOnly(message.content, 'Responses system instructions'),
      );
    } else if (message.role === 'tool') {
      input.push({
        type: 'function_call_output',
        call_id: message.tool_call_id ?? '',
        output:
          typeof message.content === 'string'
            ? message.content
            : responseContent(message.content),
      });
    } else {
      const content =
        message.role === 'assistant'
          ? textOnly(message.content, 'Responses assistant messages')
          : responseContent(message.content);
      if (content.length > 0 || !message.tool_calls?.length) {
        input.push({type: 'message', role: message.role, content});
      }
      for (const call of message.tool_calls ?? []) {
        input.push({
          type: 'function_call',
          call_id: call.id,
          name: call.function.name,
          arguments: call.function.arguments,
        });
      }
    }
  }
  const body: Record<string, unknown> = {model, input, stream};
  if (instructions.length) body.instructions = instructions.join('\n\n');
  if (options?.maxTokens !== undefined)
    body.max_output_tokens = options.maxTokens;
  if (options?.temperature !== undefined)
    body.temperature = options.temperature;
  if (options?.topP !== undefined) body.top_p = options.topP;
  const effort =
    options?.reasoningEffort ??
    (options?.thinking?.type === 'enabled'
      ? 'high'
      : options?.thinking?.type === 'disabled'
        ? 'none'
        : undefined);
  if (effort !== undefined) body.reasoning = {effort};
  if (options?.tools?.length)
    body.tools = options.tools.map(tool => ({
      type: 'function',
      name: tool.function.name,
      description: tool.function.description,
      parameters: tool.function.parameters,
    }));
  return body;
}
