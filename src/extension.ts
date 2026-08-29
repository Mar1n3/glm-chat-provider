/**
 * GLM（Z.AI / 智谱）聊天模型提供方扩展的入口模块。
 * 负责注册语言模型提供方、管理 API Key、渲染套餐用量状态栏，
 * 并提供连通性测试、思维档位与温度设置、用量诊断等管理命令。
 */
import * as vscode from 'vscode';
import {match} from 'ts-pattern';
import {AuthManager} from './auth';
import {
  GlmChatProvider,
  getVSCodeApiKey,
  hasVSCodeApiKey,
  type UsageCallback,
} from './provider';
import {isOfficialProvider, resolveApiProvider} from './region';
import {
  buildUsageTooltip,
  GlmUsageClient,
  GlmUsageError,
  type PlanUsage,
} from './usage';

/**
 * 读取 apiRegion 配置（auto / global / china）。
 * 未配置时回退为 auto，由区域探测逻辑决定实际使用的平台。
 */
function getApiRegionSetting(): string {
  return (
    vscode.workspace
      .getConfiguration('glm-chat-provider')
      .get<string>('apiRegion', 'auto') ?? 'auto'
  );
}

/**
 * 命令处理：弹出 QuickPick 让用户选择思维（thinking）档位，
 * 并把结果写入全局配置 defaultThinkingMode，供请求构造时使用。
 */
async function setThinkingEffort(): Promise<void> {
  const config = vscode.workspace.getConfiguration('glm-chat-provider');
  const current = config.get<string>('defaultThinkingMode', 'auto');

  // 档位选项：auto 由模型自行决定；low 为低思考力度（GLM-5.3+），
  // high / max 为更高思考力度（GLM-5.2+）；disabled 表示始终关闭思考。
  const items = [
    {
      label: 'Auto',
      description: 'Let the model decide when to think',
      value: 'auto',
      picked: current === 'auto',
    },
    {
      label: 'Enabled',
      description: 'Always enable thinking mode',
      value: 'enabled',
      picked: current === 'enabled',
    },
    {
      label: 'Low',
      description: 'Thinking enabled, low effort (GLM-5.3+)',
      value: 'low',
      picked: current === 'low',
    },
    {
      label: 'High',
      description: 'Thinking enabled, high effort (GLM-5.2+)',
      value: 'high',
      picked: current === 'high',
    },
    {
      label: 'Max',
      description: 'Thinking enabled, max effort (GLM-5.2+)',
      value: 'max',
      picked: current === 'max',
    },
    {
      label: 'Disabled',
      description: 'Always disable thinking mode',
      value: 'disabled',
      picked: current === 'disabled',
    },
  ];

  const choice = await vscode.window.showQuickPick(items, {
    placeHolder: 'Select thinking effort for GLM models',
  });

  if (!choice) {
    return;
  }

  // 第三个参数 true：写入全局（用户级）配置，对所有窗口生效。
  await config.update('defaultThinkingMode', choice.value, true);
  vscode.window.showInformationMessage(
    `GLM thinking effort set to ${choice.label}`,
  );
}

/**
 * 命令处理：弹出 QuickPick 让用户选择温度预设（均衡/精确/创意/最大），
 * 或选择 Custom 手动输入 0.0–1.0 的值，结果写入全局配置 temperature。
 */
async function setTemperature(): Promise<void> {
  // 各预设的取值与适用场景。
  const presets = [
    {
      key: 'balanced',
      label: 'Balanced',
      value: 0.7,
      description: 'Default for most tasks',
    },
    {
      key: 'precise',
      label: 'Precise',
      value: 0.2,
      description: 'Coding / Math (deterministic)',
    },
    {
      key: 'creative',
      label: 'Creative',
      value: 0.9,
      description: 'Writing / Brainstorming',
    },
    {
      key: 'max',
      label: 'Max',
      value: 1.0,
      description: 'Maximum (most random)',
    },
  ];

  // 组合预设与 Custom 项；Custom 的 value 为 undefined，表示走输入框流程。
  const selection = await vscode.window.showQuickPick(
    [
      ...presets.map(p => ({
        label: p.label,
        description: `${p.value} — ${p.description}`,
        value: p.value,
      })),
      {
        label: 'Custom',
        description: 'Enter your own value (0.0 - 1.0)',
        value: undefined,
      },
    ],
    {placeHolder: 'Select temperature for GLM models'},
  );

  if (!selection) return;

  let value: number;
  // 选择 Custom 时改用输入框读取自定义数值。
  if (selection.value === undefined) {
    const input = await vscode.window.showInputBox({
      prompt: 'Enter temperature value (0.0 - 1.0)',
      // 输入校验：必须是 0.0–1.0 之间的数字，否则拒绝提交。
      validateInput: text => {
        const parsed = Number.parseFloat(text);
        if (Number.isNaN(parsed) || parsed < 0 || parsed > 1) {
          return 'Value must be a number between 0.0 and 1.0';
        }
        return undefined;
      },
    });
    if (!input) return;
    value = Number.parseFloat(input);
  } else {
    value = selection.value;
  }

  // 写入全局（用户级）配置。
  await vscode.workspace
    .getConfiguration('glm-chat-provider')
    .update('temperature', value, true);
  vscode.window.showInformationMessage(`GLM temperature set to ${value}`);
}

/**
 * 命令处理：弹出 QuickPick 让用户切换 API 服务商（智谱/Z.AI/自定义）。
 * 选择自定义时依次引导输入 base 地址与接口协议，结果写入全局配置。
 */
async function switchProvider(): Promise<void> {
  const config = vscode.workspace.getConfiguration('glm-chat-provider');
  const current = config.get<string>('apiProvider', 'zhipu');

  const items = [
    {
      label: 'ZHIPU (China)',
      description: 'open.bigmodel.cn — Coding Plan usage supported',
      value: 'zhipu',
      picked: current === 'zhipu',
    },
    {
      label: 'Z.AI (Global)',
      description: 'api.z.ai — Coding Plan usage supported',
      value: 'zai',
      picked: current === 'zai',
    },
    {
      label: 'Custom',
      description: 'Your intranet server or a third-party GLM gateway',
      value: 'custom',
      picked: current === 'custom',
    },
  ];

  const choice = await vscode.window.showQuickPick(items, {
    placeHolder: 'Select API provider',
  });
  if (!choice) {
    return;
  }

  await config.update('apiProvider', choice.value, true);

  if (choice.value !== 'custom') {
    vscode.window.showInformationMessage(
      `GLM API provider set to ${choice.label}`,
    );
    return;
  }

  // 选择自定义：引导输入 base 地址（原样使用，不拼路径）。
  const existingBase = config.get<string>('customBaseUrl', '');
  const baseUrl = await vscode.window.showInputBox({
    prompt: 'Enter the custom provider base URL (used as-is, no path appended)',
    placeHolder: 'https://gw.corp.local/glm/v4',
    value: existingBase,
    ignoreFocusOut: true,
    validateInput: text =>
      text && text.trim().length > 0 ? undefined : 'Base URL cannot be empty',
  });
  if (!baseUrl) {
    return;
  }
  await config.update('customBaseUrl', baseUrl.trim(), true);

  // 接着选择接口协议，默认 chat-completions。
  const protocolItems = [
    {
      label: 'Chat Completions',
      description: 'OpenAI compatible (most gateways)',
      value: 'chat-completions',
    },
    {
      label: 'Messages',
      description: 'Anthropic Messages compatible',
      value: 'messages',
    },
    {
      label: 'Responses',
      description: 'OpenAI Responses compatible',
      value: 'responses',
    },
  ];
  // 预选当前已配置的协议（若有）。
  const existingProtocol = config.get<string>(
    'customApiProtocol',
    'chat-completions',
  );
  const protocol = await vscode.window.showQuickPick(
    protocolItems.map(item => ({
      ...item,
      picked: item.value === existingProtocol,
    })),
    {
      placeHolder: 'Select wire protocol',
      canPickMany: false,
    },
  );
  if (!protocol) {
    return;
  }
  await config.update('customApiProtocol', protocol.value, true);

  vscode.window.showInformationMessage(
    `GLM API provider set to Custom (${baseUrl.trim()}, ${protocol.value})`,
  );
}

/**
 * 扩展激活入口：创建鉴权管理器与聊天提供方，维护用量状态并渲染状态栏，
 * 注册全部命令与配置变更监听，并按配置间隔定时刷新套餐用量。
 */
export function activate(context: vscode.ExtensionContext): void {
  // 基于 VS Code SecretStorage 的鉴权管理器，负责 API Key 的安全存取。
  const authManager = new AuthManager(context.secrets);

  // 用量状态：本会话请求数、最近一次套餐用量、错误信息、
  // 拉取进行中标记（防止并发重入）、上次发起拉取的时间（用于节流）。
  let requestCount = 0;
  let planUsage: PlanUsage | undefined;
  let usageError: string | undefined;
  let usageInFlight = false;
  let lastUsageAttempt = 0;

  // 右下角状态栏项（优先级 100）：展示用量摘要，点击触发刷新命令。
  const usageStatusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    100,
  );
  usageStatusBarItem.command = 'glm-chat-provider.refreshUsage';

  // 诊断输出通道：首次执行诊断命令时才创建，之后复用。
  let diagnosticsChannel: vscode.OutputChannel | undefined;

  // 读取用量相关配置：是否展示套餐用量、定时刷新间隔（秒）。
  // 自定义服务商（内网/第三方网关）没有套餐监控接口，强制视为不展示。
  const getUsageSettings = () => {
    const config = vscode.workspace.getConfiguration('glm-chat-provider');
    const {provider} = resolveApiProvider(
      config.get<string>('apiProvider'),
      config.get<string>('customBaseUrl'),
    );
    const official = isOfficialProvider(provider);
    return {
      showPlanUsage: official && config.get<boolean>('showPlanUsage', true),
      refreshSeconds: config.get<number>('usageRefreshIntervalSeconds', 300),
    };
  };

  // 按当前用量状态重绘状态栏：关闭套餐展示时只显示会话请求数；
  // 开启时显示 ZHIPU 图标，用量 ≥90% 黄色警告、≥100% 红色，
  // 无百分比/未拉到数据/出错时用图标加符号区分。
  const renderUsageStatusBar = (): void => {
    const {showPlanUsage} = getUsageSettings();
    // 未开启套餐展示：仅显示请求数，点击改为打开管理菜单。
    if (!showPlanUsage) {
      usageStatusBarItem.text = `GLM: $(database) ${requestCount} req`;
      usageStatusBarItem.tooltip = [
        `Requests this session: ${requestCount}`,
        'Click to manage provider',
      ].join('\n');
      usageStatusBarItem.command = 'glm-chat-provider.manage';
      usageStatusBarItem.show();
      return;
    }

    usageStatusBarItem.command = 'glm-chat-provider.refreshUsage';
    // 主百分比取值顺序：5 小时窗口 > 月度窗口 > 首个套餐条目。
    const primary =
      planUsage?.fiveHour?.percentage ??
      planUsage?.monthly?.percentage ??
      planUsage?.all?.[0]?.percentage;

    // 参考 Copilot 风格：状态栏只放一个静态 ZHIPU 图标，明细放在悬停提示里。
    if (primary !== undefined) {
      const pct = Math.round(primary);
      usageStatusBarItem.text = '$(glm-zhipu)';
      // 按百分比着色：≥100% 红色（错误色），≥90% 黄色（警告色）。
      usageStatusBarItem.color =
        pct >= 100
          ? new vscode.ThemeColor('statusBarItem.errorForeground')
          : pct >= 90
            ? new vscode.ThemeColor('statusBarItem.warningForeground')
            : undefined;
    } else if (usageError) {
      usageStatusBarItem.text = '$(glm-zhipu) !';
    } else if (planUsage) {
      usageStatusBarItem.text = '$(glm-zhipu)';
    } else {
      usageStatusBarItem.text = '$(glm-zhipu) …';
    }
    // 悬停提示：展示套餐明细、错误信息与会话请求数。
    usageStatusBarItem.tooltip = buildUsageTooltip(
      planUsage,
      usageError,
      requestCount,
    );
    usageStatusBarItem.show();
  };

  // 拉取套餐用量并重绘状态栏。force=false 为非强制模式（30 秒节流），
  // 供定时器与请求后回调使用；force=true 立即执行，供点击/命令触发。
  // 自定义服务商（getUsageSettings 已把 showPlanUsage 强制置 false）时
  // 直接跳过：内网/第三方网关没有套餐监控接口。
  const refreshUsage = async (force = true): Promise<void> => {
    if (!getUsageSettings().showPlanUsage) {
      return;
    }
    // 已有拉取在进行中则直接返回，避免并发重复请求监控接口。
    if (usageInFlight) {
      return;
    }
    // 简单节流：非强制模式下，距上次拉取不足 30 秒则跳过本次。
    const now = Date.now();
    if (!force && now - lastUsageAttempt < 30_000) {
      return;
    }
    lastUsageAttempt = now;

    // 未配置 Key：清空套餐数据与错误状态，状态栏退回请求数展示。
    // Key 解析顺序：扩展自存的（存储1）→ VS Code 模型配置里的（存储2）。
    // 后者是聊天实际用的 Key；只要其中之一存在就能查套餐用量，
    // 避免出现“聊天正常但用量永远 Loading”的割裂状态。
    const apiKey = (await authManager.getApiKey()) ?? getVSCodeApiKey();
    if (!apiKey) {
      planUsage = undefined;
      usageError = undefined;
      renderUsageStatusBar();
      return;
    }

    // 请求监控接口：成功则更新套餐数据并清除错误，失败则记录错误信息。
    usageInFlight = true;
    try {
      planUsage = await new GlmUsageClient(
        apiKey,
        getApiRegionSetting(),
      ).fetchPlanUsage();
      usageError = undefined;
    } catch (error) {
      planUsage = undefined;
      usageError = match(error)
        .when(
          (value): value is GlmUsageError => value instanceof GlmUsageError,
          value =>
            value.statusCode === 401
              ? 'API key invalid or expired'
              : value.message,
        )
        .otherwise(value => String(value));
    } finally {
      // 无论成败都解除进行中标记并重绘状态栏。
      usageInFlight = false;
      renderUsageStatusBar();
    }
  };

  // 聊天请求结束后的回调：累计本会话请求数，
  // 并以非强制（节流）方式刷新一次套餐用量。
  const onUsage: UsageCallback = () => {
    requestCount += 1;
    // 请求结束后刷新配额（节流、非强制）。
    void refreshUsage(false);
  };

  // 创建聊天提供方，并把 onUsage 注册为每次请求后的用量回调。
  const provider = new GlmChatProvider(authManager, onUsage);

  // 管理菜单动作表构建器：每次打开菜单时重建，保证文案反映最新的
  // 服务商与密钥状态（例如 VS Code 侧 Key 是否仍存在）。
  const buildManageActions = (): Record<string, () => Promise<void>> => {
    const activeProviderConfig = vscode.workspace
      .getConfiguration('glm-chat-provider')
      .get<string>('apiProvider', 'zhipu');
    const currentProviderLabel =
      activeProviderConfig === 'custom'
        ? 'Custom'
        : activeProviderConfig === 'zai'
          ? 'Z.AI'
          : 'ZHIPU';
    return {
      [`Switch API Provider (current: ${currentProviderLabel})`]: () =>
        switchProvider(),
      // VS Code 侧（模型配置界面）已存 Key：显示 Set Provider；
      // 未存 Key：显示 Set Provider and API Key。
      // 两者都跳转到 VS Code 的模型配置界面完成操作。
      [hasVSCodeApiKey() ? 'Set Provider' : 'Set Provider and API Key']:
        async () => {
          await vscode.commands.executeCommand(
            'workbench.action.chat.configureModels',
          );
        },
      // 仅清除本扩展自存的 Key（用量统计用的凭据）；聊天用的 Key 保存在
      // VS Code 模型配置中，如需一并移除请前往模型配置界面删除。
      'Clear Provider': async () => {
        await authManager.deleteApiKey();
        provider.fireLanguageModelChatInformationChange();
        await refreshUsage();
        vscode.window.showInformationMessage(
          'GLM provider credentials cleared. To remove the chat key too, delete it in Configure Models.',
        );
      },
    };
  };

  // 激活时立即渲染一次状态栏，并以节流方式做首次用量拉取。
  renderUsageStatusBar();
  void refreshUsage(false);

  // 按配置间隔定时刷新用量；重复调度会先清除旧定时器，避免叠加。
  let usageRefreshTimer: ReturnType<typeof setInterval> | undefined;
  const scheduleUsageRefresh = (): void => {
    if (usageRefreshTimer) {
      clearInterval(usageRefreshTimer);
    }
    const {refreshSeconds, showPlanUsage} = getUsageSettings();
    // 关闭套餐展示或间隔 ≤0 时不启动定时刷新。
    if (!showPlanUsage || refreshSeconds <= 0) {
      return;
    }
    // 间隔下限 30 秒，防止配置过小导致监控请求过密。
    usageRefreshTimer = setInterval(
      () => void refreshUsage(false),
      Math.max(30, refreshSeconds) * 1000,
    );
  };
  scheduleUsageRefresh();

  // 注册所有命令、状态栏与监听器到 subscriptions，随扩展停用自动释放。
  context.subscriptions.push(
    // 释放用量刷新定时器。
    {
      dispose: () => {
        if (usageRefreshTimer) {
          clearInterval(usageRefreshTimer);
        }
      },
    },
    // 配置变更监听：展示开关/刷新间隔变化时重建定时器并重绘状态栏；
    // apiRegion 变化时立即强制刷新一次用量。
    vscode.workspace.onDidChangeConfiguration(event => {
      if (
        event.affectsConfiguration('glm-chat-provider.showPlanUsage') ||
        event.affectsConfiguration(
          'glm-chat-provider.usageRefreshIntervalSeconds',
        )
      ) {
        scheduleUsageRefresh();
        renderUsageStatusBar();
      }
      if (event.affectsConfiguration('glm-chat-provider.apiRegion')) {
        void refreshUsage();
      }
    }),
    usageStatusBarItem,
    vscode.lm.registerLanguageModelChatProvider('zai', provider),
    {dispose: () => diagnosticsChannel?.dispose()},
    // 命令：管理菜单，每次打开都重建动作表，动态反映当前状态。
    vscode.commands.registerCommand('glm-chat-provider.manage', async () => {
      const manageActions = buildManageActions();
      const choice = await vscode.window.showQuickPick(
        Object.keys(manageActions),
        {
          placeHolder: 'Manage Z.AI GLM provider',
        },
      );
      const action = choice ? manageActions[choice] : undefined;
      if (!action) {
        return;
      }
      await action();
    }),
    // 命令：选择思维档位 / 温度预设（见顶部同名函数）。
    vscode.commands.registerCommand(
      'glm-chat-provider.setThinkingEffort',
      async () => {
        await setThinkingEffort();
      },
    ),
    vscode.commands.registerCommand(
      'glm-chat-provider.setTemperature',
      async () => {
        await setTemperature();
      },
    ),
  );
}

/**
 * 扩展停用钩子：所有资源已通过 context.subscriptions 注册释放，无需额外清理。
 */
export function deactivate(): void {}
