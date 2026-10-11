const assert = require('node:assert/strict');
const fs = require('node:fs');
const {test} = require('node:test');
const {MODEL_CATALOG} = require('../out/model-catalog.js');
const {
  GLM_MODEL_DEFINITIONS,
  getModelConfigurationSchema,
  resolveThinkingRequest,
} = require('../out/models.js');
const {supportsEffort} = require('../out/protocol.js');
const {
  toAnthropicBody,
  toResponsesBody,
} = require('../out/protocol-adapters.js');
const {
  README_PATH,
  readModelSection,
  renderModelTable,
} = require('../scripts/models-readme.cjs');

// These checks run for every catalog entry, so a newly added model is covered
// without writing a model-specific test.
const protocols = ['chat-completions', 'messages', 'responses'];

test('catalog entries are well-formed and unique', () => {
  assert.ok(MODEL_CATALOG.length > 0);
  assert.equal(GLM_MODEL_DEFINITIONS.length, MODEL_CATALOG.length);
  for (const key of ['id', 'name']) {
    const values = MODEL_CATALOG.map(model => model[key]);
    const duplicates = values.filter((v, i) => values.indexOf(v) !== i);
    assert.deepEqual(duplicates, [], `duplicate model ${key}`);
  }
  for (const model of MODEL_CATALOG) {
    assert.match(model.id, /^[a-z0-9][a-z0-9.-]*$/, `${model.id}: bad id`);
    assert.equal(model.name, model.name.trim(), `${model.id}: name spaces`);
    for (const key of ['maxInputTokens', 'maxOutputTokens']) {
      assert.ok(
        Number.isInteger(model[key]) && model[key] > 0,
        `${model.id}: ${key} must be a positive integer`,
      );
    }
    assert.ok(
      model.maxOutputTokens <= model.maxInputTokens,
      `${model.id}: output limit exceeds context window`,
    );
  }
  for (const model of GLM_MODEL_DEFINITIONS) {
    assert.ok(model.version.length > 0, `${model.id}: empty version`);
  }
});

test('every picker option is consistent and serializes on its protocol', () => {
  for (const model of GLM_MODEL_DEFINITIONS) {
    for (const protocol of protocols) {
      const where = `${model.id} on ${protocol}`;
      const {thinkingMode, temperature} = getModelConfigurationSchema(
        model.thinkingSupport,
        protocol,
      ).properties;
      assert.ok(temperature.enum.includes(temperature.default), where);
      assert.equal(thinkingMode === undefined, !model.capabilities.thinking);
      const modes = thinkingMode ? [...thinkingMode.enum, undefined] : [];
      if (thinkingMode) {
        assert.ok(thinkingMode.enum.includes(thinkingMode.default), where);
        assert.equal(thinkingMode.enumItemLabels.length, modes.length - 1);
        assert.equal(thinkingMode.enumDescriptions.length, modes.length - 1);
      }
      for (const mode of modes) {
        const request = resolveThinkingRequest(
          model,
          {modelConfiguration: {thinkingMode: mode}},
          protocol,
        );
        if (request.reasoningEffort) {
          assert.ok(supportsEffort(protocol, request.reasoningEffort), where);
        }
        // Anything the picker offers (or its unset default) must be accepted
        // by the wire adapter instead of failing at request time.
        const options = {...request};
        const messages = [{role: 'user', content: 'hi'}];
        if (protocol === 'messages')
          toAnthropicBody(model.id, messages, options, true);
        if (protocol === 'responses')
          toResponsesBody(model.id, messages, options, true);
      }
    }
  }
});

test('models without thinking show only temperature and send no thinking fields', () => {
  const schema = getModelConfigurationSchema('none');
  assert.equal(schema.properties.thinkingMode, undefined);
  assert.equal(schema.properties.temperature.default, 'balanced');
  const model = {id: 'x', thinkingSupport: 'none'};
  for (const mode of [undefined, 'enabled', 'max']) {
    assert.deepEqual(
      resolveThinkingRequest(model, {modelConfiguration: {thinkingMode: mode}}),
      {},
    );
  }
});

test('resolved thinking requests are fresh objects', () => {
  const model = GLM_MODEL_DEFINITIONS.find(m => m.thinkingSupport === 'on-off');
  const options = {modelConfiguration: {thinkingMode: 'enabled'}};
  resolveThinkingRequest(model, options).thinking.type = 'mutated';
  assert.deepEqual(resolveThinkingRequest(model, options).thinking, {
    type: 'enabled',
  });
});

test('README model table matches the catalog', () => {
  const readme = fs.readFileSync(README_PATH, 'utf8').replace(/\r\n/g, '\n');
  assert.equal(
    readModelSection(readme).content,
    renderModelTable(),
    'README model table is out of date: run `npm run models:readme`',
  );
});
