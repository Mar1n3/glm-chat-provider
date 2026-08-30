import * as vscode from 'vscode';

/** API key 在 SecretStorage 中的存储键名。 */
const API_KEY_SECRET_KEY = 'glm-chat-provider.apiKey';

/**
 * API key 管理器。
 *
 * 负责把用户的 API key 存取到 VS Code 的 SecretStorage（加密存储），
 * 并提供交互式输入框让用户录入 key。
 */
export class AuthManager {
  /** 构造时注入 VS Code 的加密存储服务。 */
  constructor(private readonly secrets: vscode.SecretStorage) {}

  /** 读取已保存的 API key；未设置时返回 undefined。 */
  async getApiKey(): Promise<string | undefined> {
    return this.secrets.get(API_KEY_SECRET_KEY);
  }

  /** 删除已保存的 API key。 */
  async deleteApiKey(): Promise<void> {
    await this.secrets.delete(API_KEY_SECRET_KEY);
  }

  /**
   * 弹出输入框让用户录入 API key（密码模式，输入内容不回显），
   * 录入成功后保存并返回 key；用户取消则返回 undefined。
   */
  async promptForApiKey(): Promise<string | undefined> {
    const input = await vscode.window.showInputBox({
      prompt: 'Enter your GLM API Key',
      password: true,
      placeHolder: 'sk-...',
      ignoreFocusOut: true,
      validateInput: value => {
        if (!value || value.trim().length === 0) {
          return 'API key cannot be empty';
        }
        return undefined;
      },
    });

    if (!input) {
      return undefined;
    }

    const key = input.trim();
    await this.secrets.store(API_KEY_SECRET_KEY, key);
    vscode.window.showInformationMessage('GLM API key saved successfully');
    return key;
  }

  /** 取 key 的便捷方法：优先读已保存的，没有则弹窗让用户录入。 */
  async getOrPromptApiKey(): Promise<string | undefined> {
    return (await this.getApiKey()) ?? this.promptForApiKey();
  }
}
