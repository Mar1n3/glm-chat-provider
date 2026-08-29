import * as vscode from 'vscode';

/**
 * 创建一个 LanguageModelThinkingPart（思维链内容部件）。
 * 该类属于 VS Code 的提案 API（proposed API），旧版本运行时可能不存在，
 * 因此这里在运行时探测 vscode 上是否挂有该构造函数；不可用时返回
 * undefined，调用方应跳过思维内容的上报，不影响正文输出。
 */
export function createThinkingPart(
  value: string,
): vscode.LanguageModelResponsePart | undefined {
  // 运行时探测：把 vscode 断言成“可能带有 LanguageModelThinkingPart”的
  // 类型后读取构造函数，避免在不支持的旧版本上直接访问导致报错。
  const ThinkingPartCtor = (
    vscode as typeof vscode & {
      LanguageModelThinkingPart?: new (
        value: string,
        id?: string,
        metadata?: {readonly [key: string]: unknown},
      ) => vscode.LanguageModelResponsePart;
    }
  ).LanguageModelThinkingPart;

  // 构造函数不存在说明当前 VS Code 版本不支持该提案 API，放弃思维上报。
  if (typeof ThinkingPartCtor !== 'function') {
    return undefined;
  }

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
