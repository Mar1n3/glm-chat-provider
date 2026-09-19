const assert = require('node:assert/strict');
const {test} = require('node:test');
const Module = require('node:module');

// Only the VS Code host is mocked; model, provider, converter and API code are real.
const settings = {};
const vscode = {
  workspace: {
    getConfiguration: () => ({
      get: (key, fallback) => settings[key] ?? fallback,
    }),
  },
  EventEmitter: class {
    event = () => ({dispose() {}});
    fire() {}
  },
  LanguageModelTextPart: class {
    constructor(value) {
      this.value = value;
    }
  },
  LanguageModelDataPart: class {
    constructor(data, mimeType) {
      Object.assign(this, {data, mimeType});
    }
  },
  LanguageModelToolCallPart: class {},
  LanguageModelToolResultPart: class {},
  LanguageModelChatMessageRole: {User: 1, Assistant: 2},
};
const originalLoad = Module._load;
let GlmChatProvider, GlmApiClient, definitions;
try {
  Module._load = function (id, ...args) {
    return id === 'vscode' ? vscode : originalLoad.call(this, id, ...args);
  };
  ({GlmChatProvider} = require('../out/provider/index.js'));
  ({GlmApiClient} = require('../out/api.js'));
  ({GLM_MODEL_DEFINITIONS: definitions} = require('../out/models.js'));
} finally {
  Module._load = originalLoad;
}

const id = 'glm-5.3-flashx';
const token = {
  isCancellationRequested: false,
  onCancellationRequested: () => ({dispose() {}}),
};
const provider = new GlmChatProvider({});

async function getModel() {
  const models = await provider.provideLanguageModelChatInformation(
    {configuration: {apiKey: 'test-key'}},
    token,
  );
  return models.find(model => model.id === id);
}

test('FlashX is registered once, with capabilities and picker configuration', async () => {
  assert.equal(definitions.filter(model => model.id === id).length, 1);
  assert.equal(
    new Set(definitions.map(model => model.id)).size,
    definitions.length,
  );
  const model = await getModel();
  assert.equal(model.name, 'GLM-5.3-FlashX');
  assert.equal(model.version, '5.3-flashx');
  assert.equal(model.maxInputTokens, 1000000);
  assert.equal(model.maxOutputTokens, 131072);
  assert.deepEqual(model.capabilities, {toolCalling: true, imageInput: true});
  const schema = model.configurationSchema.properties;
  assert.deepEqual(schema.thinkingMode.enum, ['low', 'high', 'max']);
  assert.equal(schema.thinkingMode.default, 'max');
  assert.equal(schema.temperature.default, 'max');
  assert.deepEqual(
    await provider.provideLanguageModelChatInformation(
      {configuration: {}},
      token,
    ),
    [],
  );
});

async function captureRequest(options, messages = []) {
  const client = new GlmApiClient('test-key');
  let body;
  client.client.chat.completions.create = async params => {
    body = params;
    return (async function* () {})();
  };
  // Exercise the real provider -> conversion -> API serializer path without a paid call.
  await provider.streamResponse(
    client,
    await getModel(),
    messages,
    options,
    {report() {}},
    token,
  );
  return body;
}

for (const field of ['modelConfiguration', 'configuration']) {
  for (const mode of ['low', 'high', 'max']) {
    test(`${field}: ${mode} reaches the Chat Completions wire body`, async () => {
      const body = await captureRequest({
        [field]: {thinkingMode: mode, temperature: 'max'},
      });
      assert.equal(body.model, id);
      assert.equal(body.reasoning_effort, mode);
      assert.deepEqual(body.thinking, {type: 'enabled'});
      assert.equal(body.temperature, 1);
    });
  }
}

test('new configuration takes precedence over legacy configuration', async () => {
  const body = await captureRequest({
    modelConfiguration: {thinkingMode: 'low', temperature: 'precise'},
    configuration: {thinkingMode: 'high', temperature: 'creative'},
  });
  assert.equal(body.reasoning_effort, 'low');
  assert.equal(body.temperature, 0.2);
});

test('unset, stale and invalid thinking modes cannot disable always-on reasoning', async () => {
  for (const mode of [undefined, 'disabled', 'auto', 'invalid']) {
    const body = await captureRequest({
      modelConfiguration: {thinkingMode: mode},
    });
    assert.deepEqual(body.thinking, {type: 'enabled'});
    assert.equal(body.reasoning_effort, undefined);
  }
});

test('FlashX text, image and tools survive provider and Chat Completions serialization', async () => {
  const messages = [
    {
      role: vscode.LanguageModelChatMessageRole.User,
      content: [
        new vscode.LanguageModelTextPart('Describe this image'),
        new vscode.LanguageModelDataPart(
          new Uint8Array([1, 2, 3]),
          'image/png',
        ),
      ],
    },
  ];
  const body = await captureRequest(
    {
      modelConfiguration: {thinkingMode: 'low'},
      modelOptions: {maxTokens: 1024},
      tools: [
        {name: 'lookup', description: 'Lookup', inputSchema: {type: 'object'}},
      ],
    },
    messages,
  );
  assert.deepEqual(body.messages[0].content, [
    {type: 'text', text: 'Describe this image'},
    {type: 'image_url', image_url: {url: 'data:image/png;base64,AQID'}},
  ]);
  assert.equal(body.tools[0].function.name, 'lookup');
  assert.equal(body.max_tokens, 1024);
});

test('manifest and lockfile versions agree', () => {
  const pkg = require('../package.json');
  const lock = require('../package-lock.json');
  assert.equal(pkg.version, lock.version);
  assert.equal(pkg.version, lock.packages[''].version);
});

test('Responses picker removes max and refreshes when the protocol changes', async () => {
  settings.apiProvider = 'custom';
  settings.customApiProtocol = 'responses';
  try {
    const schema = (await getModel()).configurationSchema.properties
      .thinkingMode;
    assert.deepEqual(schema.enum, ['low', 'high']);
    assert.equal(schema.default, 'high');
    assert.equal(schema.enum.length, schema.enumItemLabels.length);
    settings.customApiProtocol = 'messages';
    assert.deepEqual(
      (await getModel()).configurationSchema.properties.thinkingMode.enum,
      ['low', 'high', 'max'],
    );
    settings.apiProvider = 'zhipu';
    settings.customApiProtocol = 'responses';
    assert.deepEqual(
      (await getModel()).configurationSchema.properties.thinkingMode.enum,
      ['low', 'high', 'max'],
    );
  } finally {
    delete settings.apiProvider;
    delete settings.customApiProtocol;
  }
});

for (const protocol of ['messages', 'responses']) {
  test(`${protocol} default effort matches its picker and preserves image content`, async t => {
    let body;
    t.mock.method(globalThis, 'fetch', async (url, init) => {
      body = JSON.parse(init.body);
      return new Response('data: [DONE]\n\n', {status: 200});
    });
    const client = new GlmApiClient('test-key', 'global', {
      baseUrl: 'https://gateway.invalid',
      protocol,
    });
    const messages = [
      {
        role: vscode.LanguageModelChatMessageRole.User,
        content: [
          new vscode.LanguageModelTextPart('Describe'),
          new vscode.LanguageModelDataPart(
            new Uint8Array([1, 2, 3]),
            'image/png',
          ),
        ],
      },
    ];
    await provider.streamResponse(
      client,
      await getModel(),
      messages,
      {},
      {report() {}},
      token,
    );
    if (protocol === 'messages') {
      assert.equal(body.output_config.effort, 'max');
      assert.equal(body.thinking.type, 'adaptive');
      assert.equal(body.messages[0].content[0].text, 'Describe');
      assert.equal(body.messages[0].content[1].source.data, 'AQID');
    } else {
      assert.equal(body.reasoning.effort, 'high');
      assert.equal(body.input[0].content[0].text, 'Describe');
      assert.equal(
        body.input[0].content[1].image_url,
        'data:image/png;base64,AQID',
      );
    }
  });
}
