import * as vscode from 'vscode';
import {match} from 'ts-pattern';
import {GlmApiClient, GlmApiError} from './api';
import {AuthManager} from './auth';
import {GlmChatProvider, type UsageCallback} from './provider';
import {pickChatRegions, regionLabel, setDetectedRegion} from './region';
import {
  buildUsageTooltip,
  GlmUsageClient,
  GlmUsageError,
  type PlanUsage,
} from './usage';

function getApiRegionSetting(): string {
  return (
    vscode.workspace
      .getConfiguration('glm-chat-provider')
      .get<string>('apiRegion', 'auto') ?? 'auto'
  );
}

async function setApiKey(
  authManager: AuthManager,
  provider: GlmChatProvider,
): Promise<void> {
  await authManager.promptForApiKey();
  provider.fireLanguageModelChatInformationChange();
}

async function clearApiKey(
  authManager: AuthManager,
  provider: GlmChatProvider,
): Promise<void> {
  await authManager.deleteApiKey();
  provider.fireLanguageModelChatInformationChange();
  vscode.window.showInformationMessage('GLM API key cleared');
}

async function testConnection(
  authManager: AuthManager,
  provider: GlmChatProvider,
): Promise<void> {
  const key = await authManager.getApiKey();
  if (!key) {
    const shouldSetKey = await vscode.window.showInformationMessage(
      'No API key in extension storage. Use "GLM: Set API Key" first, then run this test again.',
      'Set API Key',
    );
    if (shouldSetKey === 'Set API Key') {
      await setApiKey(authManager, provider);
    }
    return;
  }

  const regions = pickChatRegions(getApiRegionSetting());
  for (const [index, region] of regions.entries()) {
    const client = new GlmApiClient(key, region);
    try {
      await client.chat('glm-4.7', [{role: 'user', content: 'Ping'}], {
        maxTokens: 1,
      });
      setDetectedRegion(region);
      vscode.window.showInformationMessage(
        `GLM provider test succeeded on ${regionLabel(region)}.`,
      );
      return;
    } catch (error) {
      const isAuthError =
        error instanceof GlmApiError &&
        (error.statusCode === 401 || error.statusCode === 403);
      if (isAuthError && index < regions.length - 1) {
        continue;
      }
      const message = match(error)
        .when(
          (value): value is GlmApiError =>
            value instanceof GlmApiError && value.statusCode === 401,
          () => 'Invalid API key. Please set a new key.',
        )
        .when(
          (value): value is Error => value instanceof Error,
          value => `GLM provider test failed: ${value.message}`,
        )
        .otherwise(value => `GLM provider test failed: ${String(value)}`);
      vscode.window.showErrorMessage(message);
      return;
    }
  }
}

async function setThinkingEffort(): Promise<void> {
  const config = vscode.workspace.getConfiguration('glm-chat-provider');
  const current = config.get<string>('defaultThinkingMode', 'auto');

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

  await config.update('defaultThinkingMode', choice.value, true);
  vscode.window.showInformationMessage(
    `GLM thinking effort set to ${choice.label}`,
  );
}

async function setTemperature(): Promise<void> {
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
  if (selection.value === undefined) {
    const input = await vscode.window.showInputBox({
      prompt: 'Enter temperature value (0.0 - 1.0)',
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

  await vscode.workspace
    .getConfiguration('glm-chat-provider')
    .update('temperature', value, true);
  vscode.window.showInformationMessage(`GLM temperature set to ${value}`);
}

export function activate(context: vscode.ExtensionContext): void {
  const authManager = new AuthManager(context.secrets);

  let requestCount = 0;
  let planUsage: PlanUsage | undefined;
  let usageError: string | undefined;
  let usageInFlight = false;
  let lastUsageAttempt = 0;

  const usageStatusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    100,
  );
  usageStatusBarItem.command = 'glm-chat-provider.refreshUsage';

  let diagnosticsChannel: vscode.OutputChannel | undefined;

  const getUsageSettings = () => {
    const config = vscode.workspace.getConfiguration('glm-chat-provider');
    return {
      showPlanUsage: config.get<boolean>('showPlanUsage', true),
      refreshSeconds: config.get<number>('usageRefreshIntervalSeconds', 300),
    };
  };

  const renderUsageStatusBar = (): void => {
    const {showPlanUsage} = getUsageSettings();
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
    const primary =
      planUsage?.fiveHour?.percentage ??
      planUsage?.monthly?.percentage ??
      planUsage?.all?.[0]?.percentage;

    // Copilot-style: one small static ZHIPU logo; details on hover.
    if (primary !== undefined) {
      const pct = Math.round(primary);
      usageStatusBarItem.text = '$(glm-zhipu)';
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
    usageStatusBarItem.tooltip = buildUsageTooltip(
      planUsage,
      usageError,
      requestCount,
    );
    usageStatusBarItem.show();
  };

  const refreshUsage = async (force = true): Promise<void> => {
    if (usageInFlight) {
      return;
    }
    // Simple throttle: skip if fetched within the last 30s unless forced.
    const now = Date.now();
    if (!force && now - lastUsageAttempt < 30_000) {
      return;
    }
    lastUsageAttempt = now;

    const apiKey = await authManager.getApiKey();
    if (!apiKey) {
      planUsage = undefined;
      usageError = undefined;
      renderUsageStatusBar();
      return;
    }

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
      usageInFlight = false;
      renderUsageStatusBar();
    }
  };

  const onUsage: UsageCallback = () => {
    requestCount += 1;
    // Refresh quota after a request completes (throttled, non-forced).
    void refreshUsage(false);
  };

  const provider = new GlmChatProvider(authManager, onUsage);

  const manageActions: Record<string, () => Promise<void>> = {
    'Set API Key': async () => {
      await setApiKey(authManager, provider);
      await refreshUsage();
    },
    'Clear API Key': async () => {
      await clearApiKey(authManager, provider);
      await refreshUsage();
    },
    'Test Connection': () => testConnection(authManager, provider),
    'Refresh Plan Usage': () => refreshUsage(),
  };

  renderUsageStatusBar();
  void refreshUsage(false);

  let usageRefreshTimer: ReturnType<typeof setInterval> | undefined;
  const scheduleUsageRefresh = (): void => {
    if (usageRefreshTimer) {
      clearInterval(usageRefreshTimer);
    }
    const {refreshSeconds, showPlanUsage} = getUsageSettings();
    if (!showPlanUsage || refreshSeconds <= 0) {
      return;
    }
    usageRefreshTimer = setInterval(
      () => void refreshUsage(false),
      Math.max(30, refreshSeconds) * 1000,
    );
  };
  scheduleUsageRefresh();

  context.subscriptions.push(
    {
      dispose: () => {
        if (usageRefreshTimer) {
          clearInterval(usageRefreshTimer);
        }
      },
    },
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
    vscode.commands.registerCommand('glm-chat-provider.setApiKey', async () => {
      await setApiKey(authManager, provider);
      await refreshUsage();
    }),
    vscode.commands.registerCommand(
      'glm-chat-provider.clearApiKey',
      async () => {
        await clearApiKey(authManager, provider);
        await refreshUsage();
      },
    ),
    vscode.commands.registerCommand(
      'glm-chat-provider.refreshUsage',
      async () => {
        await refreshUsage();
      },
    ),
    vscode.commands.registerCommand(
      'glm-chat-provider.usageDiagnostics',
      async () => {
        const key = await authManager.getApiKey();
        if (!key) {
          vscode.window.showInformationMessage(
            'No API key in extension storage. Use "GLM: Set API Key" first.',
          );
          return;
        }
        const channel =
          diagnosticsChannel ??
          (diagnosticsChannel = vscode.window.createOutputChannel(
            'GLM Usage Diagnostics',
          ));
        channel.clear();
        channel.appendLine(
          `GLM usage diagnostics — ${new Date().toISOString()}`,
        );
        await channel.appendLine('');
        try {
          const report = await new GlmUsageClient(
            key,
            getApiRegionSetting(),
          ).fetchDiagnostics();
          channel.appendLine(report);
        } catch (error) {
          channel.appendLine(
            `Diagnostics failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        channel.appendLine('');
        channel.appendLine(
          'Tip: a healthy Coding Plan key returns JSON with a "limits" array containing TOKENS_LIMIT / TIME_LIMIT entries.',
        );
        channel.show(true);
      },
    ),
    vscode.commands.registerCommand('glm-chat-provider.manage', async () => {
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

export function deactivate(): void {}
