import { test } from 'node:test';
import assert from 'node:assert/strict';
import { greet } from '../src/greet.mjs';

test('trims leading and trailing spaces from the name', () => {
  assert.equal(greet('  Ada  '), 'Hello, Ada!');
});

test('leaves an already-trimmed name unchanged', () => {
  assert.equal(greet('Ada'), 'Hello, Ada!');
});
