import * as vscode from 'vscode';
import secureJsonParse from 'secure-json-parse';
import {P, match} from 'ts-pattern';
import type {GlmContentPart, GlmMessage, GlmTool, GlmToolCall} from '../api';
import {readThinkingText} from './thinking';

/**
 * 工具调用累积器：流式响应中，同一个工具调用的 id、函数名与参数 JSON
 * 字符串会拆成多个分片到达，用该结构把它们逐段拼接保存。
 */
export type ToolCallBuilder = {
  id: string;
  name: string;
  arguments: string;
};

/** 工具执行结果：callId 对应发起调用时的 id，content 为结果文本内容。 */
type ToolResult = {
  callId: string;
  content: string;
};

/**
 * 单条消息的内容累积器：reduce 遍历消息内容部件时，把各类信息分别
 * 归拢到文本、图片、工具调用、工具结果四个桶里，遍历结束后再统一
 * 决定 GLM 消息的输出形状。
 */
type MessageAccumulator = {
  text: string;
  imageParts: GlmContentPart[];
  toolCalls: GlmToolCall[];
  toolResult?: ToolResult;
};

/**
 * 把工具调用的 arguments JSON 字符串解析成对象。
 * 使用 secure-json-parse 防御原型污染等恶意 JSON；入参为空时按 '{}'
 * 处理；解析失败或结果不是普通对象（例如数组）时返回空对象。
 */
export function parseToolArguments(
  argumentsText: string,
): Record<string, unknown> {
  const parsed = secureJsonParse.safeParse(argumentsText || '{}');
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {};
  }
  return parsed as Record<string, unknown>;
}

/** 把 VS Code 聊天请求的消息数组逐条转换成 GLM 消息数组。 */
export function convertMessages(
  messages: readonly vscode.LanguageModelChatRequestMessage[],
): GlmMessage[] {
  return messages.map(message => toGlmMessage(message));
}

/**
 * 把一条 VS Code 消息转换成一条 GLM 消息。
 * 第一步：用 reduce + ts-pattern 按部件类型把内容归拢进累积器：
 * - 文本部件：追加到 text；
 * - 工具调用部件：转成 GLM tool_calls 条目（input 序列化为 arguments）；
 * - 工具结果部件：只保留文本内容，并记录 callId；
 * - 图片 DataPart（image/* MIME）：转成 data URI 形式的 image_url 内容块；
 * - 其余部件：尝试按思维内容提取文本并入 text。
 * 第二步：按优先级决定输出形状——有工具结果就是 tool 角色（带
 * tool_call_id）；有工具调用就是 assistant 且带 tool_calls；有图片时
 * content 是文本 + 图片的内容块数组；否则 content 就是纯文本。
 */
function toGlmMessage(
  message: vscode.LanguageModelChatRequestMessage,
): GlmMessage {
  const accumulated = message.content.reduce<MessageAccumulator>(
    (state, part) =>
      match(part)
        // 文本部件：把文本追加进累积器的 text 字段。
        .with(P.instanceOf(vscode.LanguageModelTextPart), value => ({
          ...state,
          text: state.text + value.value,
        }))
        // 工具调用部件：记录一条 GLM tool_calls（input 序列化为 arguments）。
        .with(P.instanceOf(vscode.LanguageModelToolCallPart), value => ({
          ...state,
          toolCalls: [
            ...state.toolCalls,
            {
              id: value.callId,
              type: 'function' as const,
              function: {
                name: value.name,
                arguments: JSON.stringify(value.input),
              },
            },
          ],
        }))
        // 工具结果部件：只保留其中的文本内容，并记录对应的 callId。
        .with(P.instanceOf(vscode.LanguageModelToolResultPart), value => ({
          ...state,
          toolResult: {
            callId: value.callId,
            content: value.content
              .map(item =>
                item instanceof vscode.LanguageModelTextPart ? item.value : '',
              )
              .join(''),
          },
        }))
        // 二进制数据部件：仅处理图片 MIME，转成 data URI 形式的图片内容块。
        .with(P.instanceOf(vscode.LanguageModelDataPart), value => {
          if (value.mimeType.startsWith('image/')) {
            const base64 = uint8ArrayToBase64(value.data);
            return {
              ...state,
              imageParts: [
                ...state.imageParts,
                {
                  type: 'image_url' as const,
                  image_url: {url: `data:${value.mimeType};base64,${base64}`},
                },
              ],
            };
          }
          return state;
        })
        // 其余部件：尝试按思维内容提取文本，成功则并入 text。
        .otherwise(value => {
          const thinking = readThinkingText(value);
          return thinking ? {...state, text: state.text + thinking} : state;
        }),
    {text: '', imageParts: [], toolCalls: []},
  );

  const role = mapRole(message.role);

  // 优先级 1：消息里携带工具结果 → 输出为 tool 角色，并用 tool_call_id 回指调用。
  if (accumulated.toolResult) {
    return {
      role: 'tool',
      content: accumulated.toolResult.content,
      tool_call_id: accumulated.toolResult.callId,
    };
  }

  // 优先级 2：消息里携带工具调用 → 输出为 assistant 并附 tool_calls。
  if (accumulated.toolCalls.length > 0) {
    return {
      role: 'assistant',
      content: accumulated.text,
      tool_calls: accumulated.toolCalls,
    };
  }

  // 优先级 3：带图片 → content 输出为可选文本 + 图片的内容块数组。
  if (accumulated.imageParts.length > 0) {
    const content: GlmContentPart[] = [];
    if (accumulated.text) {
      content.push({type: 'text', text: accumulated.text});
    }
    content.push(...accumulated.imageParts);
    return {role, content};
  }

  return {role, content: accumulated.text};
}

/**
 * 把 VS Code 的消息角色枚举映射成 GLM/OpenAI 的角色字符串；
 * 无法识别的角色一律降级为 system。
 */
function mapRole(
  role: vscode.LanguageModelChatMessageRole,
): 'user' | 'assistant' | 'system' {
  return match(role)
    .with(
      vscode.LanguageModelChatMessageRole.Assistant,
      () => 'assistant' as const,
    )
    .with(vscode.LanguageModelChatMessageRole.User, () => 'user' as const)
    .otherwise(() => 'system' as const);
}

/**
 * 把 Uint8Array 编码成 base64 字符串。
 * 必须分块调用 String.fromCharCode：一次性把整个大数组展开成参数会
 * 超出 JavaScript 的参数个数上限，因此每 0x8000（32768）字节处理一块，
 * 先拼成二进制字符串，再用 Buffer 一次性转成 base64。
 */
function uint8ArrayToBase64(data: Uint8Array): string {
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < data.length; i += chunkSize) {
    const chunk = data.subarray(i, i + chunkSize);
    binary += String.fromCharCode.apply(null, chunk as unknown as number[]);
  }
  return Buffer.from(binary, 'binary').toString('base64');
}

/**
 * 把 VS Code 的工具定义数组转换成 GLM 的 function 工具定义；
 * 未提供工具或数组为空时返回 undefined（请求中不带 tools 字段）。
 */
export function convertTools(
  tools?: readonly vscode.LanguageModelChatTool[],
): GlmTool[] | undefined {
  return tools?.length
    ? tools.map(tool => ({
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description,
          parameters: (tool.inputSchema ?? {}) as Record<string, unknown>,
        },
      }))
    : undefined;
}
