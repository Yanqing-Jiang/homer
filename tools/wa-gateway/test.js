/** Fixture tests for relay-logic.js — run: node --test test.js */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  backoffMs, buildSelfSet, classifyClose, extractAnswer, extractOtp,
  isSelfChat, selfJid,
} from './relay-logic.js';

const PN = '14255550123@s.whatsapp.net';
const LID = '123456789012345@lid';
const OTHER = '19998887777@s.whatsapp.net';
const user = { id: '14255550123:12@s.whatsapp.net', lid: '123456789012345:12@lid' };
const selfSet = buildSelfSet(user);
// LID-primary account shape from installed baileys Contact: id/lid/phoneNumber
const lidUser = { id: '123456789012345:7@lid', lid: '123456789012345:7@lid',
                  phoneNumber: '14255550123:7@s.whatsapp.net' };
const lidSelfSet = buildSelfSet(lidUser);

const chal = {
  id: 'c1', nonce: 'ab12', state: 'sent', wa_message_id: '3EB0PROMPT',
  expires_ms: Date.now() + 60000,
};
const msg = (text, { id = 'M1', remoteJid = PN, remoteJidAlt, quoted, fromMe = true } = {}) => ({
  key: { id, remoteJid, remoteJidAlt, fromMe },
  message: quoted
    ? { extendedTextMessage: { text, contextInfo: { stanzaId: quoted } } }
    : { conversation: text },
});

test('self identity: PN primary, LID primary, and alt-jid permutations', () => {
  assert.ok(isSelfChat({ remoteJid: PN }, selfSet));
  assert.ok(isSelfChat({ remoteJid: LID }, selfSet));
  assert.ok(isSelfChat({ remoteJid: OTHER, remoteJidAlt: LID }, selfSet));
  assert.ok(isSelfChat({ remoteJid: OTHER, remoteJidAlt: PN }, selfSet));
  assert.ok(!isSelfChat({ remoteJid: OTHER }, selfSet));
  assert.ok(!isSelfChat({}, selfSet));
});

test('LID-primary account: phoneNumber field covers the PN identity', () => {
  assert.ok(isSelfChat({ remoteJid: PN }, lidSelfSet));
  assert.ok(isSelfChat({ remoteJid: LID }, lidSelfSet));
  assert.ok(isSelfChat({ remoteJid: OTHER, remoteJidAlt: PN }, lidSelfSet));
  assert.ok(!isSelfChat({ remoteJid: OTHER }, lidSelfSet));
});

test('selfJid strips the device suffix from the send destination', () => {
  assert.equal(selfJid(user), PN);
  assert.equal(selfJid(lidUser), LID);
});

test("'unknown' challenge accepts a BOUND reply (uncertain send rescued)", () => {
  const unk = { ...chal, state: 'unknown' };
  assert.equal(extractAnswer(msg('123456', { quoted: '3EB0PROMPT' }), unk, selfSet, Date.now()), '123456');
  assert.equal(extractAnswer(msg('123456 #ab12'), unk, selfSet, Date.now()), '123456');
  assert.equal(extractAnswer(msg('123456'), unk, selfSet, Date.now()), null);
});

test('quoted reply to the current prompt is accepted, fromMe included', () => {
  assert.equal(extractAnswer(msg('123456', { quoted: '3EB0PROMPT' }), chal, selfSet, Date.now()), '123456');
  assert.equal(extractAnswer(msg('123 456', { quoted: '3EB0PROMPT' }), chal, selfSet, Date.now()), '123456');
});

test('nonce-token binding works without a quote', () => {
  assert.equal(extractAnswer(msg('123456 #ab12'), chal, selfSet, Date.now()), '123456');
  assert.equal(extractAnswer(msg('#ab12 987654'), chal, selfSet, Date.now()), '987654');
});

test('bare unbound digits are rejected (stale-answer replay defense)', () => {
  assert.equal(extractAnswer(msg('123456'), chal, selfSet, Date.now()), null);
});

test('wrong quote, wrong nonce, non-code, oversize, own prompt: rejected', () => {
  assert.equal(extractAnswer(msg('123456', { quoted: 'OTHERMSG' }), chal, selfSet, Date.now()), null);
  assert.equal(extractAnswer(msg('123456 #zz99'), chal, selfSet, Date.now()), null);
  assert.equal(extractAnswer(msg('the code is 123456 #ab12x'), chal, selfSet, Date.now()), null);
  assert.equal(extractAnswer(msg('x'.repeat(65), { quoted: '3EB0PROMPT' }), chal, selfSet, Date.now()), null);
  assert.equal(extractAnswer(msg('123456 #ab12', { id: '3EB0PROMPT' }), chal, selfSet, Date.now()), null);
  assert.equal(extractAnswer(msg('123456 #ab12', { remoteJid: OTHER }), chal, selfSet, Date.now()), null);
});

test('expired or non-sent challenges never match', () => {
  const expired = { ...chal, expires_ms: Date.now() - 1 };
  assert.equal(extractAnswer(msg('123456 #ab12'), expired, selfSet, Date.now()), null);
  const pending = { ...chal, state: 'pending' };
  assert.equal(extractAnswer(msg('123456 #ab12'), pending, selfSet, Date.now()), null);
  assert.equal(extractAnswer(msg('123456 #ab12'), null, selfSet, Date.now()), null);
});

test('OTP watch: Amazon inbound message yields the code; scope enforced', () => {
  const watch = { id: 'w1', nonce: 'ff01', state: 'sent', kind: 'watch',
                  wa_message_id: null, expires_ms: Date.now() + 60000 };
  const amazon = (text, extra = {}) => ({
    key: { id: 'A1', remoteJid: '441234567890@s.whatsapp.net', fromMe: false, ...extra },
    message: { conversation: text },
  });
  assert.equal(extractOtp(amazon('123456 is your Amazon one-time passcode. Do not share it.'), watch, selfSet, Date.now()), '123456');
  // template-shaped body
  const tpl = { key: { id: 'A2', remoteJid: '44123@s.whatsapp.net', fromMe: false },
                message: { templateMessage: { hydratedTemplate: { hydratedContentText: 'Your Amazon code is 987654' } } } };
  assert.equal(extractOtp(tpl, watch, selfSet, Date.now()), '987654');
  // rejected: fromMe, self-chat, no amazon mention, two candidate tokens,
  // wrong kind, expired
  assert.equal(extractOtp(amazon('Amazon code 123456', { fromMe: true }), watch, selfSet, Date.now()), null);
  assert.equal(extractOtp({ key: { id: 'A3', remoteJid: PN, fromMe: false }, message: { conversation: 'Amazon 123456' } }, watch, selfSet, Date.now()), null);
  assert.equal(extractOtp(amazon('your code is 123456'), watch, selfSet, Date.now()), null);
  assert.equal(extractOtp(amazon('Amazon codes 1234 and 5678'), watch, selfSet, Date.now()), null);
  assert.equal(extractOtp(amazon('Amazon code 123456'), { ...watch, kind: 'ask' }, selfSet, Date.now()), null);
  assert.equal(extractOtp(amazon('Amazon code 123456'), { ...watch, expires_ms: Date.now() - 1 }, selfSet, Date.now()), null);
});

test("kind separation: extractAnswer never fires on a 'watch' challenge", () => {
  const watch = { ...chal, kind: 'watch' };
  assert.equal(extractAnswer(msg('123456', { quoted: '3EB0PROMPT' }), watch, selfSet, Date.now()), null);
  assert.equal(extractAnswer(msg('123456', { quoted: '3EB0PROMPT' }), { ...chal, kind: 'ask' }, selfSet, Date.now()), '123456');
});

test('close classification: permanent reasons idle, others reconnect', () => {
  for (const code of [401, 403, 411, 440, 500]) {
    assert.equal(classifyClose(code).action, 'idle', String(code));
  }
  for (const code of [408, 428, 515, undefined]) {
    assert.equal(classifyClose(code).action, 'reconnect', String(code));
  }
});

test('backoff grows and is bounded', () => {
  assert.ok(backoffMs(0) >= 5000 && backoffMs(0) < 7000);
  assert.ok(backoffMs(20) <= 375000);
});
