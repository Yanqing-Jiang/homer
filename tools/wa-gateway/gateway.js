#!/usr/bin/env node
/**
 * wa-gateway — Baileys companion-device bridge for AMZ WhatsApp OTP capture.
 *
 * Scope is deliberately tiny and privacy-first:
 *   - Human relay mode reads/writes only the account's "Message Yourself"
 *     self-chat. Direct mode watches only inside an explicit, short-lived
 *     challenge for Amazon's own OTP and persists only its 4-8 digit code.
 *     No unrelated message text, and no JID, is written to disk or logs.
 *   - Challenges live in homer.db `wa_challenge` with an explicit state
 *     machine: pending -> sending -> sent -> answered -> consumed, with
 *     cancelled / expired / failed / unknown exits. Prompts get a stable
 *     preallocated WhatsApp message id and are never sent after expiry or
 *     cancellation.
 *   - SEND-OUTCOME POLICY (review Critical 1): once sendMessage is entered,
 *     EVERY failure — timeout, closed socket, anything — is 'unknown', never
 *     retried, never reported as provably-unsent. Baileys' local WebSocket
 *     callback cannot prove a frame did not leave the process. 'unknown'
 *     still accepts a BOUND reply: if the prompt did land, the quote/nonce
 *     proves it, and the answer is honored.
 *   - With no active challenge the gateway stores nothing at all, so the
 *     relay feature flag being off means no conversational data at rest.
 *
 * Modes:
 *   node gateway.js                 # daemon (launchd). REFUSES to pair: if
 *                                   # unpaired it idles with status 'unpaired'.
 *   node gateway.js --pair          # interactive QR pairing, then exits.
 *   node gateway.js --pair-code     # interactive pairing code (asks for the
 *                                   # phone number on stdin, never argv).
 *   Pairing requires the launchd job to be stopped first:
 *     launchctl bootout gui/$UID/com.homer.wa-gateway
 *   A unix-socket singleton refuses to start beside another instance, and is
 *   acquired BEFORE any database or auth-directory access.
 *
 * BAN RISK (accepted by Yanqing 2026-08-17): Baileys is an unofficial client;
 * Meta has warned/banned accounts for third-party tool use. This gateway
 * stays low-volume, self-chat-only, never bulk, markOnlineOnConnect off. If
 * WhatsApp shows an "unauthorized tools" warning, stop the gateway and fall
 * back to the Telegram relay.
 *
 * DEBT: standalone tool with its own node_modules rather than a homer daemon
 * executor (AGENTS.md prefers consolidating surfaces) — kept separate so an
 * unofficial-client dependency and its reconnect churn can never destabilize
 * the daemon. Fold into src/executors/ if a second WhatsApp consumer appears.
 */
import Database from 'better-sqlite3';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import pino from 'pino';
import qrcode from 'qrcode-terminal';
import {
  makeWASocket,
  useMultiFileAuthState,
  generateMessageIDV2,
} from 'baileys';
import {
  anyMessageText, backoffMs, buildSelfSet, classifyClose, extractAnswer,
  extractOtp, isSelfChat, messageText, selfJid,
} from './relay-logic.js';

// libsignal currently emits the complete session object through console.info
// when closing an old session. That object contains private/root key material;
// suppress that one library diagnostic before any socket work can occur.
const originalConsoleInfo = console.info.bind(console);
console.info = (...args) => {
  if (args[0] === 'Closing session:') return;
  originalConsoleInfo(...args);
};

const HOME = os.homedir();
const DB_PATH = path.join(HOME, 'homer/data/homer.db');
const AUTH_DIR = path.join(HOME, 'homer/data/wa-auth');
const SOCK_PATH = path.join(HOME, 'homer/data/wa-gateway.sock');
const LOG_PATH = path.join(HOME, 'homer/logs/wa-gateway.log');
const HEARTBEAT_MS = 15000;
const PUMP_MS = 2000;
const SEND_TIMEOUT_MS = 30000;  // give up waiting on a send; outcome = unknown
const SENT_GRACE_MS = 120000;   // sent/unknown stop matching this long after expiry
const PLACEHOLDER_RETRY_MS = 10000;
const PLACEHOLDER_MAX_RETRIES = 10;

const PAIR_QR = process.argv.includes('--pair');
const PAIR_CODE = process.argv.includes('--pair-code');
const PAIRING = PAIR_QR || PAIR_CODE;

// Never log message content, JIDs, or library internals (review M9).
const logger = pino({ level: 'silent' });
const log = (m) => console.log(`${new Date().toISOString()} [wa-gateway] ${m}`);

// Everything this process creates — auth keys, sqlite temp files, the unix
// socket — is born 0600/0700 (review M9): baileys' auth writer sets no mode.
process.umask(0o077);

// ------------------------------------------------------------- hardening (M9)
function hardenFiles() {
  try { if (fs.existsSync(LOG_PATH)) fs.chmodSync(LOG_PATH, 0o600); } catch { /* best effort */ }
  try {
    fs.mkdirSync(AUTH_DIR, { recursive: true, mode: 0o700 });
    fs.chmodSync(AUTH_DIR, 0o700);
    for (const f of fs.readdirSync(AUTH_DIR)) {
      try { fs.chmodSync(path.join(AUTH_DIR, f), 0o600); } catch { /* best effort */ }
    }
  } catch { /* best effort */ }
}

// ------------------------------------------------------------ singleton (M9)
function acquireSingleton() {
  return new Promise((resolve) => {
    const tryListen = (retried) => {
      const srv = net.createServer(() => { /* liveness probe only */ });
      srv.on('error', (e) => {
        if (e.code !== 'EADDRINUSE' || retried) {
          log('another wa-gateway instance is running — exiting');
          process.exit(0);
        }
        const probe = net.createConnection(SOCK_PATH);
        probe.on('connect', () => {
          probe.destroy();
          log('another wa-gateway instance is running — exiting');
          process.exit(0);
        });
        probe.on('error', () => { // stale socket file
          try { fs.unlinkSync(SOCK_PATH); } catch { /* gone already */ }
          tryListen(true);
        });
      });
      srv.listen(SOCK_PATH, () => resolve(srv));
    };
    tryListen(false);
  });
}

// ---------------------------------------------------- database (after lock)
let db;
let stmt;
function initDb() {
  db = new Database(DB_PATH);
  db.pragma('busy_timeout = 10000');
  db.exec(`
    CREATE TABLE IF NOT EXISTS wa_schema_meta (
      id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL);
  `);
  const row = db.prepare('SELECT version FROM wa_schema_meta WHERE id = 1').get();
  const version = row ? row.version : 0;
  if (version < 1) {
    // One transaction: either the whole v1 schema plus its version stamp
    // lands, or none of it — a crash mid-migration cannot strand half a DDL.
    db.exec(`
      BEGIN;
      DROP TABLE IF EXISTS wa_outbox;
      DROP TABLE IF EXISTS wa_inbox;
      DROP TABLE IF EXISTS wa_gateway_state;
      DROP TABLE IF EXISTS wa_challenge;
      DROP TABLE IF EXISTS wa_gateway_status;
      CREATE TABLE wa_challenge (
        id            TEXT PRIMARY KEY,
        nonce         TEXT NOT NULL,
        text          TEXT NOT NULL,
        state         TEXT NOT NULL DEFAULT 'pending',
        wa_message_id TEXT,
        answer        TEXT,
        attempts      INTEGER NOT NULL DEFAULT 0,
        error         TEXT,
        created_ms    INTEGER NOT NULL,
        expires_ms    INTEGER NOT NULL,
        sent_ms       INTEGER,
        answered_ms   INTEGER,
        closed_ms     INTEGER
      );
      CREATE INDEX idx_wa_challenge_state ON wa_challenge (state, expires_ms);
      CREATE INDEX idx_wa_challenge_active ON wa_challenge (state, sent_ms);
      CREATE TABLE wa_gateway_status (
        id           INTEGER PRIMARY KEY CHECK (id = 1),
        status       TEXT NOT NULL,
        heartbeat_ms INTEGER NOT NULL,
        pid          INTEGER,
        generation   INTEGER,
        last_error   TEXT
      );
      INSERT INTO wa_schema_meta (id, version) VALUES (1, 1)
        ON CONFLICT(id) DO UPDATE SET version = 1;
      COMMIT;
    `);
  }
  if (version < 2) {
    // v2: challenge kinds. 'ask' = two-way self-chat relay prompt;
    // 'watch' = passive watch for Amazon's own OTP message (the login flow
    // pressed "Send code to WhatsApp"); watch rows are never pumped/sent.
    db.exec(`
      BEGIN;
      ALTER TABLE wa_challenge ADD COLUMN kind TEXT NOT NULL DEFAULT 'ask';
      INSERT INTO wa_schema_meta (id, version) VALUES (1, 2)
        ON CONFLICT(id) DO UPDATE SET version = 2;
      COMMIT;
    `);
  }
  stmt = {
    status: db.prepare(
      'INSERT INTO wa_gateway_status (id, status, heartbeat_ms, pid, generation, last_error) ' +
      'VALUES (1, @status, @hb, @pid, @gen, @err) ON CONFLICT(id) DO UPDATE SET ' +
      'status=@status, heartbeat_ms=@hb, pid=@pid, generation=@gen, last_error=@err'),
    // Crash recovery (review): a row stranded in 'sending' means a previous
    // process died with the send outcome unknowable — label it exactly that,
    // and redact the prompt it was still carrying.
    reconcile: db.prepare(
      "UPDATE wa_challenge SET state='unknown', text='[reconciled]', " +
      "error='stranded_sending', closed_ms=? WHERE state='sending'"),
    expirePending: db.prepare(
      "UPDATE wa_challenge SET state='expired', text='[expired]', closed_ms=? " +
      "WHERE state='pending' AND expires_ms < ?"),
    expireSent: db.prepare(
      "UPDATE wa_challenge SET state='expired', closed_ms=? " +
      "WHERE state IN ('sent','unknown') AND expires_ms + " + SENT_GRACE_MS + ' < ?'),
    claim: db.prepare(
      "UPDATE wa_challenge SET state='sending', attempts=attempts+1, " +
      'wa_message_id=COALESCE(wa_message_id, @mid) WHERE id = (' +
      "  SELECT id FROM wa_challenge WHERE state='pending' AND kind='ask' " +
      '  AND expires_ms > @now ORDER BY created_ms LIMIT 1) ' +
      'RETURNING id, text, wa_message_id'),
    markSent: db.prepare(  // prompt text is spent once transmitted — redact now
      "UPDATE wa_challenge SET state='sent', sent_ms=?, text='[sent]' " +
      "WHERE id=? AND state='sending'"),
    markUnknown: db.prepare(
      "UPDATE wa_challenge SET state='unknown', text='[sent?]', error=?, " +
      "sent_ms=? WHERE id=? AND state='sending'"),
    active: db.prepare(
      "SELECT id, nonce, state, kind, wa_message_id, expires_ms FROM wa_challenge " +
      "WHERE state IN ('sent','unknown') AND expires_ms + " + SENT_GRACE_MS +
      ' > ? ORDER BY COALESCE(sent_ms, created_ms) DESC LIMIT 1'),
    answer: db.prepare(
      "UPDATE wa_challenge SET answer=?, state='answered', answered_ms=? " +
      "WHERE id=? AND state IN ('sent','unknown')"),
    prune: db.prepare('DELETE FROM wa_challenge WHERE created_ms < ?'),
  };
}

let status = 'starting';
let generation = 0;
let activeSock = null;
let lastError = null;

function heartbeat() {
  try {
    stmt.status.run({ status, hb: Date.now(), pid: process.pid,
                      gen: generation, err: lastError });
  } catch (e) { log(`status write failed (${e.code || 'db_error'})`); }
}

// --------------------------------------------------------------- pump (M1/M2)
let pumping = false;
async function pumpOnce() {
  if (pumping || status !== 'connected') return;
  const sock = activeSock;
  if (!sock?.user) return;
  pumping = true;
  try {
    const now = Date.now();
    stmt.expirePending.run(now, now);
    stmt.expireSent.run(now, now);
    const mid = generateMessageIDV2(sock.user.id);
    const row = stmt.claim.get({ mid, now });
    if (!row) return;
    // SEND-OUTCOME POLICY: from here on, any failure is 'unknown'. There is
    // no retry and no 'provably unsent' claim — Baileys' local errors cannot
    // prove non-transmission (review Critical 1). A bound reply can still
    // rescue an 'unknown' prompt that actually landed.
    try {
      await Promise.race([
        sock.sendMessage(selfJid(sock.user), { text: row.text },
                         { messageId: row.wa_message_id }),
        new Promise((_, rej) => setTimeout(
          () => rej(Object.assign(new Error('send timeout'), { code: 'send_timeout' })),
          SEND_TIMEOUT_MS)),
      ]);
      const r = stmt.markSent.run(Date.now(), row.id);
      if (r.changes === 1) log(`challenge ${row.id} prompt sent`);
      else log(`challenge ${row.id} closed while its send was in flight`);
    } catch (e) {
      stmt.markUnknown.run(e?.code === 'send_timeout' ? 'send_timeout' : 'send_error',
                           Date.now(), row.id);
      log(`challenge ${row.id} send outcome uncertain — awaiting bound reply or expiry`);
      if (e?.code === 'send_timeout') {
        // The race only stopped the WAITER — the underlying WebSocket write
        // is still pending and could transmit the prompt minutes later,
        // beside a newer ask. Kill the socket so the send's lifetime is
        // bounded; the close handler reconnects with backoff.
        log('terminating socket to bound the timed-out send');
        try { sock.end(new Error('send timeout')); } catch { /* already down */ }
      }
    }
  } catch (e) {
    log(`pump error (${e.code || 'db_error'})`);
  } finally {
    pumping = false;
  }
}

// ------------------------------------------------------------------- connect
let reconnectAttempt = 0;
const placeholderRetries = new Map();

function retryPlaceholder(sock, key, challengeId, attempt = 1) {
  const messageId = key?.id;
  if (!messageId || placeholderRetries.has(messageId)) return;
  const run = () => {
    try {
      const current = stmt.active.get(Date.now());
      if (!current || current.id !== challengeId || current.kind !== 'watch'
          || attempt > PLACEHOLDER_MAX_RETRIES || activeSock !== sock) {
        placeholderRetries.delete(messageId);
        return;
      }
      sock.requestPlaceholderResend(key)
        .then(() => log(`watch ${challengeId}: placeholder resend retry ${attempt} requested`))
        .catch(() => log(`watch ${challengeId}: placeholder resend retry ${attempt} failed`));
      attempt += 1;
      placeholderRetries.set(messageId, setTimeout(run, PLACEHOLDER_RETRY_MS));
    } catch (e) {
      placeholderRetries.delete(messageId);
      log(`watch ${challengeId}: placeholder retry stopped (${e.code || 'error'})`);
    }
  };
  placeholderRetries.set(messageId, setTimeout(run, PLACEHOLDER_RETRY_MS));
}

async function connect() {
  const myGen = ++generation;
  hardenFiles();
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const saveCredsGuarded = async () => {
    if (myGen !== generation) return; // stale socket must not write keys (M1)
    try { await saveCreds(); hardenFiles(); }
    catch { log('creds save failed'); }
  };

  // Paired = we have an account identity. `creds.registered` is only set by
  // the pairing-CODE flow; QR-linked companions leave it false while `me`
  // and `account` carry the linked identity.
  const paired = Boolean(state.creds.registered || state.creds.me);
  if (!paired && !PAIRING) {
    status = 'unpaired';
    heartbeat();
    log('not paired; daemon mode refuses to pair. Stop this service and run ' +
        'gateway.js --pair (QR) or --pair-code interactively.');
    return; // idle; heartbeat keeps reporting 'unpaired'
  }

  // Web protocol version: the installed library's pinned default (review S1);
  // fetchLatestBaileysVersion tracks master and can outrun this rc.
  const sock = makeWASocket({
    auth: state,
    logger,
    markOnlineOnConnect: false,
    syncFullHistory: false,
  });
  sock.ev.on('creds.update', saveCredsGuarded);

  if (PAIR_CODE && !paired) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question('Phone number (E.164, e.g. +14255550123): ', async (num) => {
      rl.close();
      try {
        const code = await sock.requestPairingCode(num.replace(/\D/g, ''));
        console.log(`\nPairing code: ${code}\nWhatsApp > Settings > Linked ` +
                    'Devices > Link a Device > Link with phone number instead\n');
      } catch { log('pairing code request failed'); }
    });
  }

  sock.ev.on('connection.update', (u) => {
    if (myGen !== generation) return; // stale socket callback (M1)
    if (u.qr) {
      if (!PAIR_QR) { log('pairing required — ignoring QR in daemon mode'); return; }
      console.log('\nScan with WhatsApp > Settings > Linked Devices > Link a Device:\n');
      qrcode.generate(u.qr, { small: true });
    }
    if (u.connection === 'open') {
      reconnectAttempt = 0;
      status = 'connected';
      lastError = null;
      activeSock = sock;
      heartbeat();
      log('connected'); // deliberately no JID (review M9)
      if (PAIRING) {
        log('pairing complete — exiting in 8s; then start com.homer.wa-gateway');
        setTimeout(() => process.exit(0), 8000);
      }
    }
    if (u.connection === 'close') {
      if (activeSock === sock) activeSock = null;
      const code = u.lastDisconnect?.error?.output?.statusCode;
      const policy = classifyClose(code);
      status = policy.status;
      lastError = `close_${code ?? 'unknown'}`;
      heartbeat();
      if (policy.action === 'idle') {
        log(`permanent disconnect (${policy.status}) — idling for operator ` +
            '(re-pair or investigate; relay falls back to Telegram)');
        return;
      }
      const delay = backoffMs(reconnectAttempt++);
      log(`connection closed (status ${code ?? '?'}); reconnecting in ${Math.round(delay / 1000)}s`);
      setTimeout(() => {
        if (myGen !== generation) return;
        connect().catch((e) => { log(`reconnect failed (${e.code || 'error'})`); process.exit(1); });
      }, delay);
    }
  });

  sock.ev.on('messages.upsert', ({ messages, type }) => {
    if (myGen !== generation) return;
    try {
      const challenge = stmt.active.get(Date.now());
      if (!challenge) return;   // no ask window: ignore and store nothing
      const selfSet = buildSelfSet(sock.user);
      // Diagnostic (challenge windows only, categorical only): enough to see
      // WHY a reply was dropped without ever logging content or JIDs.
      for (const m of messages) {
        log(`upsert during challenge: type=${type} fromMe=${!!m.key?.fromMe} ` +
            `self=${isSelfChat(m.key, selfSet)} ` +
            `quoted=${!!m.message?.extendedTextMessage?.contextInfo?.stanzaId} ` +
            `shapes=${Object.keys(m.message || {}).slice(0, 4).join(',')} ` +
            `len=${String(anyMessageText(m) || '').length}`);
      }
      if (type !== 'notify') return; // live messages only — never history/offline (M3)
      for (const m of messages) {
        // Business OTP messages (Amazon) can reach a companion device as an
        // undecryptable placeholder while the phone shows full content. Ask
        // the phone to resend the real content; it re-arrives in a later
        // upsert and extractOtp reads it then.
        if (challenge.kind === 'watch' && m.message?.placeholderMessage
            && !m.key.fromMe && !isSelfChat(m.key, selfSet)) {
          // Baileys makes one automatic request before emitting this upsert.
          // Its request cache lasts eight seconds, so an immediate duplicate
          // does nothing. Retry just after that cache expires, and keep the
          // bounded watch alive while the phone is briefly unavailable.
          log(`watch ${challenge.id}: placeholder received — scheduling bounded resend retries`);
          retryPlaceholder(sock, m.key, challenge.id);
          continue;
        }
        const code = challenge.kind === 'watch'
          ? extractOtp(m, challenge, selfSet, Date.now())
          : extractAnswer(m, challenge, selfSet, Date.now());
        if (code !== null) {
          const r = stmt.answer.run(code, Date.now(), challenge.id);
          if (r.changes === 1) log(`challenge ${challenge.id} answered (${challenge.kind || 'ask'})`);
        } else if (challenge && isSelfChat(m.key, selfSet)) {
          // Category + length only; the text itself is personal and unlogged.
          log(`ignoring unbound self-chat message during challenge ` +
              `(len=${String(messageText(m) || '').length})`);
        }
      }
    } catch (e) {
      log(`upsert handler error (${e.code || 'error'})`);
    }
  });
}

// -------------------------------------------------------------------- main
// Order matters: singleton FIRST — no DB mutation, auth read, or socket until
// this process is provably the only gateway (review M9/S5).
const singleton = await acquireSingleton();
hardenFiles();
try {
  initDb();
} catch (e) {
  log(`database unavailable (${e.code || 'db_error'}) — exiting for launchd throttle`);
  process.exit(1);
}
const reconciled = stmt.reconcile.run(Date.now());
if (reconciled.changes) log(`reconciled ${reconciled.changes} stranded 'sending' row(s) to 'unknown'`);
try { stmt.prune.run(Date.now() - 7 * 864e5); } catch { /* best effort */ }
heartbeat();
setInterval(heartbeat, HEARTBEAT_MS);
setInterval(pumpOnce, PUMP_MS);
setInterval(() => { try { stmt.prune.run(Date.now() - 7 * 864e5); } catch { /* */ } },
            6 * 3600 * 1000);

function shutdown(sig) {
  status = 'stopped';
  try { heartbeat(); } catch { /* */ }
  try { singleton.close(); fs.unlinkSync(SOCK_PATH); } catch { /* */ }
  try { db.close(); } catch { /* */ }
  log(`${sig} — stopped`);
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

connect().catch((e) => { log(`fatal (${e.code || 'error'})`); process.exit(1); });
