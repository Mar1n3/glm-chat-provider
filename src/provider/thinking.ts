import * as vscode from 'vscode';

/**
 * 上报模式：运行时探测一次 LanguageModelThinkingPart 是否存在。
 * - 存在（新版 VS Code 启用了该提案 API）：思考内容以 ThinkingPart
 *   上报，聊天界面显示为可折叠的“思考过程”区块；
 * - 不存在（如 1.116 稳定 API）：返回 undefined，调用方降级为
 *   普通文本上报，保证思考内容始终可见。
 */
let thinkingPartSupported: boolean | undefined;

/**
 * 创建一个 LanguageModelThinkingPart（思维链内容部件）。
 * 该类属于 VS Code 的提案 API（proposed API），稳定版本运行时可能
 * 不存在，因此这里在运行时探测 vscode 上是否挂有该构造函数。
 *
 * @returns ThinkingPart 实例；运行时不支持该 API 时返回 undefined，
 * 调用方应降级为普通文本上报（而不是丢弃思考内容）。
 */
export function createThinkingPart(
  value: string,
): vscode.LanguageModelResponsePart | undefined {
  // 运行时探测结果只算一次，后续调用直接复用。
  thinkingPartSupported ??=
    typeof (
      vscode as typeof vscode & {
        LanguageModelThinkingPart?: new (
          value: string,
          id?: string,
          metadata?: {readonly [key: string]: unknown},
        ) => vscode.LanguageModelResponsePart;
      }
    ).LanguageModelThinkingPart === 'function';

  // 运行时不支持该提案 API：返回 undefined，由调用方降级为文本。
  if (!thinkingPartSupported) {
    return undefined;
  }

  const ThinkingPartCtor = (
    vscode as typeof vscode & {
      LanguageModelThinkingPart: new (
        value: string,
        id?: string,
        metadata?: {readonly [key: string]: unknown},
      ) => vscode.LanguageModelResponsePart;
    }
  ).LanguageModelThinkingPart;

  return new ThinkingPartCtor(value);
}

/**
 * 从一个可能是 LanguageModelThinkingPart 的消息部件中提取思维文本。
 * 入参类型未知，这里按结构探测：提案 API 形状的部件带 `thinking`
 * 字段；部分实现把内容放在 `value` 字段；两者都不是字符串则返回
 * undefined，表示该部件不含思维内容。
 */
export function readThinkingText(part: unknown): string | undefined {
  if (!part || typeof part !== 'object') {
    return undefined;
  }
  const candidate = part as {thinking?: unknown; value?: unknown};
  if (typeof candidate.thinking === 'string') {
    return candidate.thinking;
  }
  if (typeof candidate.value === 'string') {
    return candidate.value;
  }
  return undefined;
}
