/**
 * Pure decision logic for wa-gateway, split out so it can be unit-tested
 * against fixture messages without a socket (see test.js).
 */
import { jidNormalizedUser, DisconnectReason } from 'baileys';

// Close-reason policy (review M10): permanent/conflict reasons idle for an
// operator instead of retry-looping; everything else backs off.
const PERMANENT = {
  [DisconnectReason.loggedOut]: 'logged_out',        // 401 — re-pair needed
  [DisconnectReason.forbidden]: 'forbidden',          // 403 — account action
  [DisconnectReason.multideviceMismatch]: 'mismatch', // 411 — re-pair needed
  [DisconnectReason.connectionReplaced]: 'conflict',  // 440 — second process
  [DisconnectReason.badSession]: 'bad_session',       // 500 — wipe + re-pair
};

export function classifyClose(statusCode) {
  const idle = PERMANENT[statusCode];
  return idle ? { action: 'idle', status: idle }
              : { action: 'reconnect', status: 'connecting' };
}

export function backoffMs(attempt) {
  const base = Math.min(5000 * 2 ** Math.min(attempt, 6), 300000);
  return base + Math.floor(Math.random() * 0.25 * base);
}

// Self identity (review M4): the account can be addressed by phone-number JID
// AND by LID; a message key can carry the alternate form in remoteJidAlt.
// PN and LID are kept as distinct set members — never equated by user part.
// Installed baileys 7.0.0-rc14 Contact fields: id, lid, phoneNumber.
export function buildSelfSet(user) {
  const set = new Set();
  for (const j of [user?.id, user?.lid, user?.phoneNumber]) {
    if (j) { try { set.add(jidNormalizedUser(j)); } catch { /* skip */ } }
  }
  return set;
}

// The Message Yourself destination: the account's own normalized user JID
// (device suffix stripped) — never the raw device-qualified sock.user.id.
export function selfJid(user) {
  return jidNormalizedUser(user.id);
}

export function isSelfChat(key, selfSet) {
  for (const j of [key?.remoteJid, key?.remoteJidAlt]) {
    if (j) { try { if (selfSet.has(jidNormalizedUser(j))) return true; } catch { /* skip */ } }
  }
  return false;
}

export function messageText(m) {
  return m?.message?.conversation
    || m?.message?.extendedTextMessage?.text || '';
}

// Business/template senders (Amazon OTP) wrap text in more shapes than chat.
export function anyMessageText(m) {
  const msg = m?.message || {};
  return messageText(m)
    || msg.templateMessage?.hydratedTemplate?.hydratedContentText
    || msg.templateMessage?.hydratedFourRowTemplate?.hydratedContentText
    || msg.buttonsMessage?.contentText
    || msg.interactiveMessage?.body?.text
    || '';
}

const CODE_RE = /^\d{4,8}$/;
function normalizeDigits(s) {
  const t = String(s).replace(/[\s‐-―-]/g, '');
  return CODE_RE.test(t) ? t : null;
}

/**
 * The ONLY way a message becomes an answer (review M3/M5/M6): it must arrive
 * in a live `notify` batch, in the self-chat, while a challenge is `sent` and
 * unexpired, must not be the prompt itself, and must be BOUND to the current
 * prompt — either a WhatsApp quoted reply to the prompt message
 * (contextInfo.stanzaId === the prompt's preallocated message id) or a body
 * carrying the nonce token (`123456 #ab12`). The residue after removing the
 * nonce token must normalize to a whole 4-8 digit code. Bare unbound digits
 * are rejected: a late answer to an OLD prompt can never satisfy a new one.
 */
export function extractAnswer(m, challenge, selfSet, nowMs) {
  // 'unknown' means the send outcome was uncertain: the prompt MAY have been
  // delivered. A reply that is cryptographically bound to it (quote or nonce)
  // proves it was — accepting it is safe and rescues the ask.
  if (!challenge || (challenge.kind && challenge.kind !== 'ask')) return null;
  if (!['sent', 'unknown'].includes(challenge.state)) return null;
  if (nowMs >= challenge.expires_ms) return null;
  if (!m?.key || m.key.id === challenge.wa_message_id) return null;
  if (!isSelfChat(m.key, selfSet)) return null;
  const text = messageText(m);
  if (!text || text.length > 64) return null;

  const quoted = m.message?.extendedTextMessage?.contextInfo?.stanzaId;
  const nonceToken = `#${challenge.nonce}`;
  let body = text;
  let bound = false;
  if (quoted && quoted === challenge.wa_message_id) {
    bound = true;
  } else if (text.includes(nonceToken)) {
    bound = true;
    body = text.split(nonceToken).join(' ');
  }
  if (!bound) return null;
  return normalizeDigits(body);
}

/**
 * OTP watch (kind='watch'): Amazon's own WhatsApp message carrying the login
 * code, requested by the login flow pressing "Send code to WhatsApp". Unlike
 * relay asks there is no nonce to bind, so the scope is: live notify only
 * (enforced by the caller), INBOUND (never fromMe), NOT the self-chat, short
 * text that names Amazon, and exactly one 4-8 digit token in it. The window
 * is only open while the login flow is actively waiting, and a wrong code
 * merely fails the login form.
 */
export function extractOtp(m, challenge, selfSet, nowMs) {
  if (!challenge || challenge.kind !== 'watch') return null;
  if (!['sent', 'unknown'].includes(challenge.state)) return null;
  if (nowMs >= challenge.expires_ms) return null;
  if (!m?.key || m.key.fromMe) return null;
  if (isSelfChat(m.key, selfSet)) return null;
  const text = anyMessageText(m);
  if (!text || text.length > 300) return null;
  if (!/amazon/i.test(text)) return null;
  const tokens = [...new Set(text.match(/\b\d{4,8}\b/g) || [])];
  return tokens.length === 1 ? tokens[0] : null;
}
