import assert from 'node:assert/strict';
import test from 'node:test';

import * as z from 'zod';

import {
  API_JSON_MEDIA_TYPE,
  API_PROBLEM_MEDIA_TYPE,
  ContractValidationError,
  apiErrorCatalog,
  apiErrorCodes,
  createApiProblem,
  createApiSuccess,
  createApiSuccessSchema,
  getApiProblemJsonSchema,
  parseApiProblem,
} from '../dist/index.js';

const traceId = '0123456789abcdef0123456789abcdef';

function assertContractError(callback, expectedIssue) {
  assert.throws(callback, (error) => {
    assert.equal(error instanceof ContractValidationError, true);
    assert.equal(
      error.issues.some(
        (issue) => issue.code === expectedIssue.code && issue.path === expectedIssue.path,
      ),
      true,
    );
    return true;
  });
}

test('defines every error code with immutable machine handling metadata', () => {
  assert.deepEqual(Object.keys(apiErrorCatalog), apiErrorCodes);

  for (const code of apiErrorCodes) {
    const definition = apiErrorCatalog[code];
    const problem = createApiProblem(code, traceId);

    assert.equal(problem.type, `urn:aipay:problem:${definition.slug}`);
    assert.equal(problem.title, definition.title);
    assert.equal(problem.status, definition.status);
    assert.equal(problem.kind, definition.kind);
    assert.equal(problem.retryable, definition.retryable);
    assert.equal(problem.instance, `urn:aipay:trace:${traceId}`);
    assert.equal(problem.traceId, traceId);
    assert.equal(Object.isFrozen(definition), true);
    assert.equal(Object.isFrozen(problem), true);
  }
});

test('lets clients distinguish retryable, rejected, expired and system errors', () => {
  const retryable = createApiProblem('RATE_LIMITED', traceId, { retryAfterMs: 1_000 });
  const rejected = createApiProblem('AUTHORIZATION_DENIED', traceId);
  const expired = createApiProblem('QUOTE_EXPIRED', traceId);
  const system = createApiProblem('INTERNAL_ERROR', traceId);
  const retryableSystem = createApiProblem('SERVICE_UNAVAILABLE', traceId, {
    retryAfterMs: 5_000,
  });

  assert.deepEqual([retryable.kind, retryable.retryable], ['retryable', true]);
  assert.deepEqual([rejected.kind, rejected.retryable], ['rejected', false]);
  assert.deepEqual([expired.kind, expired.retryable], ['expired', false]);
  assert.deepEqual([system.kind, system.retryable], ['system', false]);
  assert.deepEqual([retryableSystem.kind, retryableSystem.retryable], ['system', true]);
});

test('supports structured validation issues only for invalid requests', () => {
  const problem = createApiProblem('INVALID_REQUEST', traceId, {
    detail: 'One or more request fields are invalid.',
    errors: [
      { code: 'invalid_format', pointer: '/quoteId' },
      { code: 'out_of_range', pointer: '/quantity' },
    ],
  });

  assert.equal(problem.detail, 'One or more request fields are invalid.');
  assert.equal(problem.errors.length, 2);
  assert.equal(Object.isFrozen(problem.errors), true);
  assert.equal(Object.isFrozen(problem.errors[0]), true);

  assertContractError(
    () =>
      createApiProblem('AUTHORIZATION_DENIED', traceId, {
        errors: [{ code: 'invalid_format', pointer: '/quoteId' }],
      }),
    { code: 'catalog_mismatch', path: '/errors' },
  );
});

test('rejects catalog drift and retry metadata on non-retryable errors', () => {
  const problem = { ...createApiProblem('QUOTE_EXPIRED', traceId) };

  problem.status = 400;
  assertContractError(() => parseApiProblem(problem), {
    code: 'catalog_mismatch',
    path: '/status',
  });

  problem.status = 410;
  problem.retryAfterMs = 1_000;
  assertContractError(() => parseApiProblem(problem), {
    code: 'retry_metadata_not_allowed',
    path: '/retryAfterMs',
  });
});

test('rejects invalid trace IDs, JSON pointers and unknown fields without echoing input', () => {
  assertContractError(() => createApiProblem('INTERNAL_ERROR', '0'.repeat(32)), {
    code: 'invalid_format',
    path: '/instance',
  });

  assertContractError(
    () =>
      createApiProblem('INVALID_REQUEST', traceId, {
        errors: [{ code: 'invalid_format', pointer: 'not-a-pointer' }],
      }),
    { code: 'invalid_format', path: '/errors/0/pointer' },
  );

  const secret = 'SECRET_INTERNAL_STACK_VALUE';
  const invalid = { ...createApiProblem('INTERNAL_ERROR', traceId), secret };
  assert.throws(
    () => parseApiProblem(invalid),
    (error) => {
      assert.equal(error instanceof ContractValidationError, true);
      assert.equal(error.message.includes(secret), false);
      assert.equal(JSON.stringify(error.issues).includes(secret), false);
      return true;
    },
  );
});

test('creates and validates the success response envelope', () => {
  const DataSchema = z.strictObject({ transactionId: z.string() });
  const SuccessSchema = createApiSuccessSchema(DataSchema);
  const response = createApiSuccess({ transactionId: 'txn_example' }, traceId);

  assert.equal(API_JSON_MEDIA_TYPE, 'application/json');
  assert.equal(API_PROBLEM_MEDIA_TYPE, 'application/problem+json');
  assert.equal(SuccessSchema.safeParse(response).success, true);
  assert.equal(Object.isFrozen(response), true);
  assert.equal(Object.isFrozen(response.meta), true);
  assert.equal(response.meta.traceId, traceId);

  assertContractError(() => createApiSuccess({}, 'not-a-trace-id'), {
    code: 'invalid_format',
    path: '/meta/traceId',
  });
});

test('exports a strict Draft 2020-12 Problem Details schema', () => {
  const schema = getApiProblemJsonSchema();

  assert.equal(schema.$schema, 'https://json-schema.org/draft/2020-12/schema');
  assert.equal(schema.additionalProperties, false);
  assert.equal(schema.properties.errors.items.additionalProperties, false);
  assert.deepEqual(schema.properties.code.enum, apiErrorCodes);
  assert.deepEqual(schema.properties.kind.enum, ['retryable', 'rejected', 'expired', 'system']);
  assert.deepEqual(schema.required, [
    'type',
    'title',
    'status',
    'instance',
    'code',
    'kind',
    'retryable',
    'traceId',
  ]);
});
