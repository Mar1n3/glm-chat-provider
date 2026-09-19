const assert = require('node:assert/strict');
const {test} = require('node:test');
const {
  toAnthropicBody,
  toResponsesBody,
} = require('../out/protocol-adapters.js');
const {GlmApiClient} = require('../out/api.js');

const id = 'glm-5.3-flashx';
const image = {
  type: 'image_url',
  image_url: {url: 'data:image/png;base64,AQID'},
};
const content = [
  {type: 'text', text: 'Before'},
  image,
  {type: 'text', text: 'After'},
];
const messages = [{role: 'user', content}];
const tools = [
  {
    type: 'function',
    function: {
      name: 'lookup',
      description: 'Lookup',
      parameters: {type: 'object'},
    },
  },
];

test('Messages preserves interleaved text, inline images and remote images', () => {
  const body = toAnthropicBody(
    id,
    [
      ...messages,
      {
        role: 'user',
        content: [
          {
            type: 'image_url',
            image_url: {url: 'https://example.com/image.png'},
          },
        ],
      },
    ],
    undefined,
    true,
  );
  assert.deepEqual(body.messages[0].content, [
    {type: 'text', text: 'Before'},
    {
      type: 'image',
      source: {type: 'base64', media_type: 'image/png', data: 'AQID'},
    },
    {type: 'text', text: 'After'},
    {
      type: 'image',
      source: {type: 'url', url: 'https://example.com/image.png'},
    },
  ]);
});

test('Responses preserves interleaved text and images', () => {
  const body = toResponsesBody(id, messages, undefined, true);
  assert.deepEqual(body.input[0].content, [
    {type: 'input_text', text: 'Before'},
    {
      type: 'input_image',
      image_url: 'data:image/png;base64,AQID',
      detail: 'auto',
    },
    {type: 'input_text', text: 'After'},
  ]);
});

const history = [
  {role: 'system', content: [{type: 'text', text: 'Be helpful.'}]},
  {role: 'user', content: 'Find both.'},
  {
    role: 'assistant',
    content: 'Checking.',
    tool_calls: ['a', 'b'].map(call => ({
      id: call,
      type: 'function',
      function: {name: 'lookup', arguments: JSON.stringify({query: call})},
    })),
  },
  {role: 'tool', tool_call_id: 'a', content: 'First result'},
  {role: 'tool', tool_call_id: 'b', content: [image]},
  {role: 'assistant', content: 'Done.'},
];

test('Messages orders tool use before results and preserves assistant text and image results', () => {
  const body = toAnthropicBody(id, history, {tools}, true);
  assert.equal(body.system, 'Be helpful.');
  assert.deepEqual(
    body.messages.map(message => message.role),
    ['user', 'assistant', 'user', 'assistant'],
  );
  assert.deepEqual(
    body.messages[1].content.map(block => block.type),
    ['text', 'tool_use', 'tool_use'],
  );
  assert.equal(body.messages[1].content[0].text, 'Checking.');
  assert.deepEqual(body.messages[1].content[1].input, {query: 'a'});
  assert.deepEqual(
    body.messages[2].content.map(block => block.tool_use_id),
    ['a', 'b'],
  );
  assert.equal(body.messages[2].content[1].content[0].source.data, 'AQID');
  assert.deepEqual(body.tools[0].input_schema, {type: 'object'});
});

test('Responses preserves tool call IDs, result ordering and assistant history', () => {
  const body = toResponsesBody(id, history, {tools}, true);
  assert.equal(body.instructions, 'Be helpful.');
  assert.deepEqual(
    body.input.map(item => item.type),
    [
      'message',
      'message',
      'function_call',
      'function_call',
      'function_call_output',
      'function_call_output',
      'message',
    ],
  );
  assert.equal(body.input[1].content, 'Checking.');
  assert.deepEqual(
    body.input.slice(2, 6).map(item => item.call_id),
    ['a', 'b', 'a', 'b'],
  );
  assert.equal(body.input[5].output[0].type, 'input_image');
  assert.equal(body.input[6].content, 'Done.');
  assert.deepEqual(body.tools[0].parameters, {type: 'object'});
});

for (const mode of ['low', 'high', 'max']) {
  test(`Messages serializes ${mode} as output_config.effort`, () => {
    const body = toAnthropicBody(
      id,
      messages,
      {thinking: {type: 'enabled'}, reasoningEffort: mode},
      true,
    );
    assert.deepEqual(body.thinking, {type: 'adaptive'});
    assert.deepEqual(body.output_config, {effort: mode});
    assert.equal(body.reasoning_effort, undefined);
  });
}
for (const mode of ['low', 'high']) {
  test(`Responses serializes ${mode} as reasoning.effort`, () => {
    const body = toResponsesBody(
      id,
      messages,
      {thinking: {type: 'enabled'}, reasoningEffort: mode},
      true,
    );
    assert.deepEqual(body.reasoning, {effort: mode});
    assert.equal(body.thinking, undefined);
    assert.equal(body.reasoning_effort, undefined);
  });
}

test('Responses rejects stale max instead of silently reducing effort', () => {
  assert.throws(
    () => toResponsesBody(id, messages, {reasoningEffort: 'max'}, true),
    /does not support reasoning effort/,
  );
});

test('explicit on/off and unspecified thinking have distinct wire representations', () => {
  assert.deepEqual(
    toResponsesBody(id, messages, {thinking: {type: 'disabled'}}, true)
      .reasoning,
    {effort: 'none'},
  );
  assert.deepEqual(
    toResponsesBody(id, messages, {thinking: {type: 'enabled'}}, true)
      .reasoning,
    {effort: 'high'},
  );
  assert.equal(
    toResponsesBody(id, messages, undefined, true).reasoning,
    undefined,
  );
  assert.deepEqual(
    toAnthropicBody(id, messages, {thinking: {type: 'disabled'}}, true)
      .thinking,
    {type: 'disabled'},
  );
  assert.equal(
    toAnthropicBody(id, messages, undefined, true).thinking,
    undefined,
  );
});

for (const build of [toAnthropicBody, toResponsesBody]) {
  test(`${build.name} preserves numeric zero and explicit token limits`, () => {
    const body = build(
      id,
      messages,
      {temperature: 0, topP: 0.5, maxTokens: 2048},
      false,
    );
    assert.equal(body.temperature, 0);
    assert.equal(body.top_p, 0.5);
    assert.equal(body.max_tokens ?? body.max_output_tokens, 2048);
    assert.equal(body.stream, false);
  });
  test(`${build.name} rejects contradictory thinking configuration and system images`, () => {
    assert.throws(
      () =>
        build(
          id,
          messages,
          {thinking: {type: 'disabled'}, reasoningEffort: 'low'},
          true,
        ),
      /disabled thinking/,
    );
    assert.throws(
      () => build(id, [{role: 'system', content: [image]}], undefined, true),
      /does not support images/,
    );
  });
}

test('Messages rejects invalid image data and malformed tool arguments', () => {
  assert.throws(
    () =>
      toAnthropicBody(
        id,
        [
          {
            role: 'user',
            content: [
              {
                type: 'image_url',
                image_url: {url: 'data:image/svg+xml;base64,AQID'},
              },
            ],
          },
        ],
        undefined,
        true,
      ),
    /Messages images require/,
  );
  assert.throws(() =>
    toAnthropicBody(
      id,
      [
        {
          role: 'assistant',
          content: '',
          tool_calls: [{id: 'a', function: {name: 'lookup', arguments: '{'}}],
        },
      ],
      undefined,
      true,
    ),
  );
});

for (const protocol of ['messages', 'responses']) {
  test(`${protocol} uses the same adapter for streaming and non-streaming requests`, async t => {
    const calls = [];
    t.mock.method(globalThis, 'fetch', async (url, init) => {
      const body = JSON.parse(init.body);
      calls.push({url, body});
      return new Response(body.stream ? 'data: [DONE]\n\n' : '{}', {
        status: 200,
      });
    });
    const client = new GlmApiClient('test-key', 'global', {
      baseUrl: 'https://gateway.invalid',
      protocol,
    });
    await client.chat(id, messages, {reasoningEffort: 'low'});
    for await (const chunk of client.streamChat(id, messages, {
      reasoningEffort: 'low',
    }))
      void chunk;
    assert.equal(calls.length, 2);
    assert.equal(calls[0].url, `https://gateway.invalid/v1/${protocol}`);
    assert.deepEqual({...calls[0].body, stream: true}, calls[1].body);
  });
  test(`${protocol} preserves non-streaming HTTP errors`, async t => {
    t.mock.method(
      globalThis,
      'fetch',
      async () => new Response('{}', {status: 403}),
    );
    const client = new GlmApiClient('test-key', 'global', {
      baseUrl: 'https://gateway.invalid',
      protocol,
    });
    await assert.rejects(
      client.chat(id, messages),
      error => error.statusCode === 403,
    );
  });
}
