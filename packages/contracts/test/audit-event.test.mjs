import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AuditEventWireSchema,
  ContractValidationError,
  getAuditEventJsonSchema,
  parseAuditEvent,
} from '../dist/index.js';

const uuids = {
  event: '01890f3e-9b70-7cc2-98c5-7f6a1b2c3d4e',
  parent: '01890f3e-9b71-7cc2-a8c5-7f6a1b2c3d4e',
  developer: '01890f3e-9b72-7cc2-b8c5-7f6a1b2c3d4e',
  agent: '01890f3e-9b73-7cc2-88c5-7f6a1b2c3d4e',
  merchant: '01890f3e-9b74-7cc2-98c5-7f6a1b2c3d4e',
  transaction: '01890f3e-9b75-7cc2-a8c5-7f6a1b2c3d4e',
};

const traceId = '0123456789abcdef0123456789abcdef';

function createValidAuditEvent() {
  return {
    schemaVersion: '1',
    eventId: `evt_${uuids.event}`,
    eventType: 'transaction.state_changed',
    actor: { type: 'agent', id: `agt_${uuids.agent}` },
    object: { type: 'transaction', id: `txn_${uuids.transaction}` },
    occurredAt: '2026-08-27T03:00:00.000Z',
    traceId,
    parentEventId: `evt_${uuids.parent}`,
    result: { outcome: 'succeeded', code: null },
  };
}

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

test('parses an immutable event with actor, object, time, trace and result', () => {
  const event = parseAuditEvent(createValidAuditEvent());

  assert.equal(event.eventType, 'transaction.state_changed');
  assert.deepEqual(event.actor, { type: 'agent', id: `agt_${uuids.agent}` });
  assert.deepEqual(event.object, {
    type: 'transaction',
    id: `txn_${uuids.transaction}`,
  });
  assert.equal(event.occurredAt, '2026-08-27T03:00:00.000Z');
  assert.equal(event.traceId, traceId);
  assert.deepEqual(event.result, { outcome: 'succeeded', code: null });
  assert.equal(Object.isFrozen(event), true);
  assert.equal(Object.isFrozen(event.actor), true);
  assert.equal(Object.isFrozen(event.object), true);
  assert.equal(Object.isFrozen(event.result), true);
});

test('supports each actor kind and requires actor-specific identifiers', () => {
  const actors = [
    { type: 'developer', id: `dev_${uuids.developer}` },
    { type: 'agent', id: `agt_${uuids.agent}` },
    { type: 'merchant', id: `mch_${uuids.merchant}` },
    { type: 'system', id: null },
    { type: 'payment_provider', id: null, providerName: 'alipay' },
  ];

  for (const actor of actors) {
    const wire = createValidAuditEvent();
    wire.actor = actor;
    assert.deepEqual(parseAuditEvent(wire).actor, actor);
  }

  const wrongPrefix = createValidAuditEvent();
  wrongPrefix.actor = { type: 'agent', id: `dev_${uuids.developer}` };
  assertContractError(() => parseAuditEvent(wrongPrefix), {
    code: 'invalid_format',
    path: '/actor/id',
  });
});

test('supports every auditable object kind with a matching resource prefix', () => {
  const objects = [
    ['developer', 'dev'],
    ['agent', 'agt'],
    ['merchant', 'mch'],
    ['service', 'svc'],
    ['mandate', 'mdt'],
    ['quote', 'qte'],
    ['transaction', 'txn'],
    ['payment_attempt', 'pat'],
    ['delivery', 'dlv'],
    ['refund', 'rfd'],
    ['audit_event', 'evt'],
    ['outbox_event', 'obx'],
  ];

  for (const [type, prefix] of objects) {
    const wire = createValidAuditEvent();
    wire.object = { type, id: `${prefix}_${uuids.transaction}` };
    assert.deepEqual(parseAuditEvent(wire).object, wire.object);
  }

  const wrongPrefix = createValidAuditEvent();
  wrongPrefix.object = { type: 'refund', id: `txn_${uuids.transaction}` };
  assertContractError(() => parseAuditEvent(wrongPrefix), {
    code: 'invalid_format',
    path: '/object/id',
  });
});

test('requires a stable code for failed and denied results only', () => {
  for (const outcome of ['failed', 'denied']) {
    const wire = createValidAuditEvent();
    wire.result = { outcome, code: 'AUTHORIZATION_DENIED' };
    assert.equal(parseAuditEvent(wire).result.code, 'AUTHORIZATION_DENIED');

    wire.result.code = null;
    assertContractError(() => parseAuditEvent(wire), {
      code: 'invalid_result_code',
      path: '/result/code',
    });
  }

  for (const outcome of ['succeeded', 'pending']) {
    const wire = createValidAuditEvent();
    wire.result = { outcome, code: null };
    assert.equal(parseAuditEvent(wire).result.code, null);

    wire.result.code = 'UNEXPECTED_CODE';
    assertContractError(() => parseAuditEvent(wire), {
      code: 'invalid_result_code',
      path: '/result/code',
    });
  }
});

test('rejects self-parenting, invalid event types, timestamps and trace IDs', () => {
  const selfParent = createValidAuditEvent();
  selfParent.parentEventId = selfParent.eventId;
  assertContractError(() => parseAuditEvent(selfParent), {
    code: 'duplicate_reference',
    path: '/parentEventId',
  });

  const invalidEventType = createValidAuditEvent();
  invalidEventType.eventType = 'TransactionChanged';
  assertContractError(() => parseAuditEvent(invalidEventType), {
    code: 'invalid_format',
    path: '/eventType',
  });

  const invalidTimestamp = createValidAuditEvent();
  invalidTimestamp.occurredAt = '2026-02-29T03:00:00.000Z';
  assertContractError(() => parseAuditEvent(invalidTimestamp), {
    code: 'invalid_format',
    path: '/occurredAt',
  });

  const invalidTrace = createValidAuditEvent();
  invalidTrace.traceId = '0'.repeat(32);
  assertContractError(() => parseAuditEvent(invalidTrace), {
    code: 'invalid_format',
    path: '/traceId',
  });
});

test('rejects unknown fields without echoing rejected input', () => {
  const secret = 'PRIVATE_AUDIT_PAYLOAD';
  const wire = { ...createValidAuditEvent(), payload: secret };

  assert.throws(
    () => parseAuditEvent(wire),
    (error) => {
      assert.equal(error instanceof ContractValidationError, true);
      assert.equal(error.message.includes(secret), false);
      assert.equal(JSON.stringify(error.issues).includes(secret), false);
      return true;
    },
  );
});

test('exports a strict Draft 2020-12 audit event schema', () => {
  const schema = getAuditEventJsonSchema();

  assert.equal(AuditEventWireSchema.safeParse(createValidAuditEvent()).success, true);
  assert.equal(schema.$schema, 'https://json-schema.org/draft/2020-12/schema');
  assert.equal(schema.additionalProperties, false);
  assert.equal(schema.properties.actor.oneOf.length, 5);
  assert.equal(schema.properties.object.oneOf.length, 12);
  assert.equal(schema.properties.result.additionalProperties, false);
  assert.deepEqual(schema.required, [
    'schemaVersion',
    'eventId',
    'eventType',
    'actor',
    'object',
    'occurredAt',
    'traceId',
    'parentEventId',
    'result',
  ]);
});
