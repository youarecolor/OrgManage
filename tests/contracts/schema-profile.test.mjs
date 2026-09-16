import test from 'node:test';
import assert from 'node:assert/strict';
import { assertSchemaProfile, SchemaProfileError } from '../../scripts/schema-profile.mjs';

const baseline = () => ({
  $schema: 'https://json-schema.org/draft/2020-12/schema', $id: 'urn:orgmanage:i1-p01:Oracle:0.1', title: 'Oracle',
  type: 'object', properties: { text: { type: 'string', maxLength: 5 } }, required: ['text'], additionalProperties: false,
});
const invalid = (schema) => assert.throws(() => assertSchemaProfile(schema), SchemaProfileError);

test('RESP-V06: reviewed finite closed schema and local references are accepted', () => {
  assert.doesNotThrow(() => assertSchemaProfile(baseline()));
  const localRef = baseline();
  localRef.$defs = { Text: { type: 'string', maxLength: 5 } };
  localRef.properties.text = { $ref: '#/$defs/Text' };
  assert.doesNotThrow(() => assertSchemaProfile(localRef));
});

for (const keyword of ['$dynamicRef', '$anchor', '$data', 'format', 'patternProperties', 'unevaluatedProperties', 'if', 'then', 'allOf', 'default', 'unknownKeyword']) {
  test(`RESP-V06: unreviewed schema keyword ${keyword} fails before generation`, () => {
    const candidate = baseline(); candidate[keyword] = true; invalid(candidate);
  });
}
test('external, missing and recursive references are rejected rather than fetched or ignored', () => {
  for (const reference of ['https://example.invalid/schema.json', 'file:///schema.json', '#/$defs/Missing']) {
    const candidate = baseline(); candidate.properties.text = { $ref: reference }; invalid(candidate);
  }
  const recursive = baseline();
  recursive.$defs = { Text: { $ref: '#/$defs/Text' } };
  recursive.properties.text = { $ref: '#/$defs/Text' }; invalid(recursive);
});
test('known keywords with malformed syntax or open object defaults fail', () => {
  const mutations = [
    (s) => { s.additionalProperties = true; },
    (s) => { delete s.additionalProperties; },
    (s) => { s.required = []; },
    (s) => { s.required = ['text', 'text']; },
    (s) => { s.required = ['unknown']; },
    (s) => { s.properties.text = { type: 'string', maxLength: '5' }; },
    (s) => { s.properties.text = { type: 'string', minLength: 6, maxLength: 5 }; },
    (s) => { s.properties.text = { type: 'string' }; },
    (s) => { s.properties.text = { type: 'string', enum: [] }; },
    (s) => { s.properties.text = { type: 'string', enum: ['a', 'a'] }; },
    (s) => { s.properties.text = { type: 'string', const: 1 }; },
    (s) => { s.properties.text = { type: 'array', minItems: 0, maxItems: 33, items: { type: 'null' } }; },
    (s) => { s.properties.text = { type: 'integer' }; },
    (s) => { s.properties.text = { type: 'boolean' }; },
    (s) => { s.properties.text = true; },
    (s) => { s.properties.text = { anyOf: [] }; },
    (s) => { s.properties.text = { type: 'string', maxLength: 5, pattern: '.*' }; },
  ];
  for (const mutate of mutations) { const candidate = baseline(); mutate(candidate); invalid(candidate); }
});
test('schema identity and export names are exact and reject terminal newlines', () => {
  const badTitle = baseline(); badTitle.title += '\n'; invalid(badTitle);
  const badId = baseline(); badId.$id += '\n'; invalid(badId);
  const wrongDialect = baseline(); wrongDialect.$schema = 'https://json-schema.org/draft-07/schema'; invalid(wrongDialect);
});
test('dangerous property names and cyclic in-memory schema objects fail explicitly', () => {
  for (const name of ['constructor', 'prototype', '__proto__']) {
    const candidate = baseline();
    Object.defineProperty(candidate.properties, name, { enumerable: true, value: { type: 'null' } });
    candidate.required.push(name); invalid(candidate);
  }
  const cyclic = baseline(); cyclic.properties.text = cyclic; invalid(cyclic);
});
