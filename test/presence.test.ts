// Presence signals. The distinction that matters most here is "not paid" versus
// "not checked" — collapsing those would turn a failed request into a verdict.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { applyOrders, isBare, presenceBadge, readPresence } from '../src/presence.ts';

test('artwork marks a token as having a real profile', () => {
  assert.equal(readPresence({ imageUrl: 'https://cdn/x.png' }, 0).hasProfile, true);
  assert.equal(readPresence({ header: 'https://cdn/h.png' }, 0).hasProfile, true);
  assert.equal(readPresence({}, 0).hasProfile, false);
  assert.equal(readPresence(undefined, undefined).hasProfile, false);
});

test('socials are deduplicated and websites counted', () => {
  const p = readPresence(
    {
      socials: [{ type: 'twitter' }, { type: 'telegram' }, { type: 'twitter' }],
      websites: [{ url: 'a' }, { url: 'b' }],
    },
    3,
  );
  assert.deepEqual(p.socials, ['twitter', 'telegram']);
  assert.equal(p.websites, 2);
  assert.equal(p.boostsActive, 3);
});

test('a fresh presence record is explicitly unchecked for orders', () => {
  const p = readPresence({ imageUrl: 'x' }, 0);
  assert.equal(p.ordersChecked, false);
  assert.deepEqual(p.paidOrders, []);
  assert.equal(p.paidAt, null);
});

test('only approved orders count as paid', () => {
  // A processing payment can still be rejected, so it is not a receipt.
  const p = applyOrders(readPresence({}, 0), [
    { type: 'tokenProfile', status: 'approved', paymentTimestamp: 200 },
    { type: 'tokenAd', status: 'processing', paymentTimestamp: 100 },
  ]);
  assert.deepEqual(p.paidOrders, ['tokenProfile']);
  assert.equal(p.paidAt, 200);
  assert.equal(p.ordersChecked, true);
});

test('the earliest approved payment is reported', () => {
  const p = applyOrders(readPresence({}, 0), [
    { type: 'tokenAd', status: 'approved', paymentTimestamp: 500 },
    { type: 'tokenProfile', status: 'approved', paymentTimestamp: 100 },
  ]);
  assert.equal(p.paidAt, 100);
  assert.deepEqual(p.paidOrders.sort(), ['tokenAd', 'tokenProfile']);
});

test('an empty order list is a checked negative, not an unknown', () => {
  const p = applyOrders(readPresence({}, 0), []);
  assert.equal(p.ordersChecked, true);
  assert.deepEqual(p.paidOrders, []);
  assert.equal(p.paidAt, null);
});

test('bare means nothing at all was invested in presentation', () => {
  assert.equal(isBare(readPresence({}, 0)), true);
  assert.equal(isBare(readPresence({ imageUrl: 'x' }, 0)), false);
  assert.equal(isBare(readPresence({ socials: [{ type: 'twitter' }] }, 0)), false);
  assert.equal(isBare(readPresence({}, 5)), false);
  assert.equal(isBare(applyOrders(readPresence({}, 0), [{ type: 'tokenProfile', status: 'approved' }])), false);
});

test('the badge summarises presence at a glance', () => {
  assert.equal(presenceBadge(readPresence({}, 0)), 'bare');
  assert.equal(presenceBadge(readPresence({ imageUrl: 'x' }, 0)), 'prof');
  assert.equal(
    presenceBadge(readPresence({ imageUrl: 'x', socials: [{ type: 'twitter' }, { type: 'telegram' }] }, 2)),
    'prof/b2/2s',
  );
  const paid = applyOrders(readPresence({ imageUrl: 'x' }, 0), [
    { type: 'tokenProfile', status: 'approved' },
  ]);
  assert.equal(presenceBadge(paid), 'paid');
});

test('the badge never overflows its column', () => {
  // A three-digit boost count used to push the badge into the next column.
  const loud = applyOrders(
    readPresence({ imageUrl: 'x', socials: [{ type: 'twitter' }, { type: 'telegram' }] }, 100),
    [{ type: 'tokenProfile', status: 'approved' }],
  );
  assert.equal(presenceBadge(loud), 'paid/b99+/2s');
  assert.ok(presenceBadge(loud).length <= 12);
});
