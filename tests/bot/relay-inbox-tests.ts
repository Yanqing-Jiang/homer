/**
 * The MFA-relay path: an inbound Telegram message must land in `thread_messages` at
 * RECEIPT — before any queueing decision — and a code answering a pending relay prompt
 * must be acknowledged rather than fed to the running Claude session.
 *
 * Nothing here starts a bot, a poller or a Claude session; the handler's branch is
 * mirrored by `handleInbound` below, which is the same two lines as
 * `bot.on("message:text")` after the receipt block.
 */
import "../helpers/no-telegram.js";
import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StateManager } from "../../src/state/manager.js";
import { runMigrations } from "../../src/state/migrations/index.js";
import { closeSync, openSync, writeFileSync } from "node:fs";
import { flockSync } from "fs-ext";
import {
  RELAY_PROMPT_WINDOW_MS,
  detectPendingRelayPrompt,
  looksLikeMfaCode,
  probeRelayAskWindow,
  quotesAnotherNonce,
  receiveInboundTelegramText,
  relayNonceIn,
  splitReplyWrapper,
} from "../../src/bot/relay-inbox.js";

const CHAT_ID = 7758999972;
const LANE = `tg:${CHAT_ID}`;
/** tg_code_relay.DB_POLL_S — the relay re-reads the table this often. */
const RELAY_POLL_MS = 3_000;
const PROMPT = "AMZ code relay [#a9c7]\nVendor Central login needs the SMS code.\nReply with ONLY the code (4-8 digits). Window: 10 min.";

function freshState(): { state: StateManager; dbPath: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "homer-relay-test-"));
  const dbPath = join(dir, "homer.db");
  const state = new StateManager(dbPath);
  runMigrations(state.getDb()); // threads / thread_messages live in the migration set
  return { state, dbPath, cleanup: () => { state.close(); rmSync(dir, { recursive: true, force: true }); } };
}

/** Exactly what the relay does: an independent read-only connection over the same file. */
/** A whole millisecond, so an ISO `created_at > since` comparison cannot tie. */
function tick(): void {
  const until = Date.now() + 2;
  while (Date.now() < until) { /* spin — 2ms, keeps the tests synchronous */ }
}

function relayReads(dbPath: string, sinceIso: string): Array<{ id: string; content: string }> {
  const con = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    return con.prepare(
      `SELECT id, content FROM thread_messages
        WHERE thread_id = ? AND role = 'user' AND created_at > ?
        ORDER BY created_at`,
    ).all(LANE, sinceIso) as Array<{ id: string; content: string }>;
  } finally {
    con.close();
  }
}

/** The handler's decision, verbatim: ack a relay code, otherwise hand the text to the session. */
function handleInbound(
  state: StateManager,
  args: {
    text: string;
    replyToText?: string | null;
    replyToDateSeconds?: number | null;
    wrappedContent?: string | null;
    askWindow?: "asking" | "idle" | "unknown";
  },
  sink: { sessionQueue: string[]; replies: string[] },
): ReturnType<typeof receiveInboundTelegramText> {
  const inbound = receiveInboundTelegramText(state, {
    lane: LANE,
    chatId: CHAT_ID,
    text: args.text,
    wrappedContent: args.wrappedContent ?? null,
    replyToText: args.replyToText ?? null,
    replyToDateSeconds: args.replyToDateSeconds ?? null,
    // Pinned so a relay genuinely running on this machine cannot flip the suite.
    probeAskWindow: () => args.askWindow ?? "idle",
  });
  if (inbound.relay) {
    const suffix = inbound.relay.nonce ? ` (relay [#${inbound.relay.nonce}])` : "";
    sink.replies.push(`code received — handing it to the login${suffix}`);
    return inbound;
  }
  sink.sessionQueue.push(args.text);
  return inbound;
}

// --------------------------------------------------------------- recognition rules

test("looksLikeMfaCode mirrors the relay's whole-message rule", () => {
  assert.equal(looksLikeMfaCode("123456"), "123456");
  assert.equal(looksLikeMfaCode("123 456"), "123456");
  assert.equal(looksLikeMfaCode("123-456"), "123456");
  assert.equal(looksLikeMfaCode("1234"), "1234");
  assert.equal(looksLikeMfaCode("12345678"), "12345678");
  assert.equal(looksLikeMfaCode("123"), null, "too short");
  assert.equal(looksLikeMfaCode("123456789"), null, "too long");
  assert.equal(looksLikeMfaCode("the code is 123456"), null, "ambiguous, deliberately rejected");
  assert.equal(looksLikeMfaCode(""), null);
  assert.equal(looksLikeMfaCode(null), null);
});

test("splitReplyWrapper unwraps the daemon's reply-to block", () => {
  const wrapped = `<replying-to source="telegram" message_id="5880">\n${PROMPT}\n</replying-to>\n\n123456`;
  const { body, quoted } = splitReplyWrapper(wrapped);
  assert.equal(looksLikeMfaCode(body), "123456");
  assert.equal(relayNonceIn(quoted), "a9c7");
});

test("a reply naming a different nonce is not our answer", () => {
  assert.equal(quotesAnotherNonce(PROMPT, "a9c7"), false);
  assert.equal(quotesAnotherNonce(PROMPT, "beef"), true);
  assert.equal(quotesAnotherNonce(null, "a9c7"), false, "a plain message answers whatever is pending");
});

test("a pending prompt is found from a recent outbound message, or from the reply-to", () => {
  const now = Date.parse("2026-09-01T20:00:00.000Z");
  assert.deepEqual(detectPendingRelayPrompt({ replyToText: PROMPT, now }), { nonce: "a9c7", source: "reply", asking: false });
  assert.deepEqual(
    detectPendingRelayPrompt({
      replyToText: "AMZ code relay [#dead]\nold question",
      recentOutbound: [{ text: PROMPT, createdAt: now - 1_000 }],
      now,
    }),
    { nonce: "a9c7", source: "outbound", asking: false },
    "what is pending outranks what was replied to",
  );
  assert.deepEqual(
    detectPendingRelayPrompt({ recentOutbound: [{ text: PROMPT, createdAt: now - 60_000 }], now }),
    { nonce: "a9c7", source: "outbound", asking: false },
  );
  assert.equal(
    detectPendingRelayPrompt({ recentOutbound: [{ text: PROMPT, createdAt: now - 60 * 60_000 }], now }),
    null,
    "a prompt older than the window is not pending",
  );
  assert.equal(detectPendingRelayPrompt({ recentOutbound: [{ text: "hello", createdAt: now }], now }), null);
});

// M1: an un-bounded reply-to let a scroll-back reply to yesterday's prompt be acknowledged
// as "handed to the login" and then dropped, with no relay listening.
test("a reply to a prompt older than the window is NOT treated as pending", () => {
  const now = Date.parse("2026-09-01T20:00:00.000Z");
  const fresh = Math.floor((now - 5 * 60_000) / 1000);
  const stale = Math.floor((now - RELAY_PROMPT_WINDOW_MS - 60_000) / 1000);
  assert.deepEqual(
    detectPendingRelayPrompt({ replyToText: PROMPT, replyToDateSeconds: fresh, now }),
    { nonce: "a9c7", source: "reply", asking: false },
  );
  assert.equal(detectPendingRelayPrompt({ replyToText: PROMPT, replyToDateSeconds: stale, now }), null);
  // …unless the ask lock says a relay is waiting right now, which outranks staleness.
  assert.deepEqual(
    detectPendingRelayPrompt({ replyToText: PROMPT, replyToDateSeconds: stale, askWindow: "asking", now }),
    { nonce: null, source: "ask-lock", asking: true },
  );
});

// H1: the source that actually fires in production. `ask_code` sends its prompt with a
// direct Bot API call, so nothing reaches telegram_messages; the ask lock is the only
// evidence Homer can see when Yanqing simply types six digits.
test("the ask lock is the fallback source when no nonce is knowable", () => {
  const now = Date.parse("2026-09-01T20:00:00.000Z");
  assert.equal(detectPendingRelayPrompt({ askWindow: "idle", now }), null);
  assert.equal(detectPendingRelayPrompt({ askWindow: "unknown", now }), null, "unknown never withholds on its own");
  assert.deepEqual(detectPendingRelayPrompt({ askWindow: "asking", now }), { nonce: null, source: "ask-lock", asking: true });
});

// The real file the relay uses: `_AskLock` opens `<state>.lock` and holds LOCK_EX on it
// for the whole ask window.
test("probeRelayAskWindow reads the relay's real flock contract", () => {
  const dir = mkdtempSync(join(tmpdir(), "homer-relay-lock-"));
  const statePath = join(dir, "tg_code_relay_state.json");
  const lockPath = `${statePath}.lock`;

  assert.equal(probeRelayAskWindow(lockPath), "idle", "no lock file yet = no relay has ever run");

  // The relay's own state file format, for the record: offset + updated_at, no secrets.
  writeFileSync(statePath, JSON.stringify({ offset: 115489715, updated_at: "2026-09-01T19:55:17+00:00" }));
  writeFileSync(lockPath, "");
  assert.equal(probeRelayAskWindow(lockPath), "idle", "an unlocked lock file is not an ask window");

  const held = openSync(lockPath, "a+");
  flockSync(held, "ex"); // exactly what _AskLock.__enter__ does
  try {
    assert.equal(probeRelayAskWindow(lockPath), "asking");
    // Probing must not steal or hold the lock — the relay keeps it across the whole ask.
    assert.equal(probeRelayAskWindow(lockPath), "asking");
  } finally {
    flockSync(held, "un");
    closeSync(held);
  }
  assert.equal(probeRelayAskWindow(lockPath), "idle", "released after the ask window closes");
  rmSync(dir, { recursive: true, force: true });
});

// ------------------------------------------------------------- receipt behaviour

test("a code arriving mid-turn is in thread_messages inside one relay poll, and is acked instead of queued", () => {
  const { state, dbPath, cleanup } = freshState();
  try {
    // A turn is running: the /vc-login session has been dispatched and holds the lane.
    // The receipt path does not consult the run manager at all, which is the point —
    // persistence no longer sits behind the queueing decision.
    const sink = { sessionQueue: [] as string[], replies: [] as string[] };
    handleInbound(state, { text: "/vc-login is what started this" }, sink);

    // The relay sends its prompt (recorded here as an outbound Homer message) and
    // starts polling from this instant.
    tick();
    const since = new Date().toISOString();
    tick();
    state.recordTelegramMessage({
      chatId: CHAT_ID,
      telegramMessageId: 5880,
      lane: LANE,
      role: "assistant",
      messageKind: "conversation",
      messageText: PROMPT,
    });

    const startedAt = Date.now();
    const inbound = handleInbound(state, { text: "123456", replyToText: PROMPT }, sink);
    const elapsedMs = Date.now() - startedAt;

    assert.ok(elapsedMs < RELAY_POLL_MS, `receipt took ${elapsedMs}ms, must beat one ${RELAY_POLL_MS}ms relay poll`);
    assert.deepEqual(inbound.relay, { nonce: "a9c7", digits: 6, source: "outbound", mismatched: false });

    // The relay, reading independently, sees the row with the fields it expects.
    const rows = relayReads(dbPath, since);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.id, inbound.threadMessageId);
    assert.equal(looksLikeMfaCode(splitReplyWrapper(rows[0]!.content).body), "123456");

    // The session was told nothing; Yanqing was told the code landed.
    assert.deepEqual(sink.sessionQueue, ["/vc-login is what started this"]);
    assert.deepEqual(sink.replies, ["code received — handing it to the login (relay [#a9c7])"]);
  } finally {
    cleanup();
  }
});

test("the relay's redaction still finds and overwrites exactly the row we wrote", () => {
  const { state, dbPath, cleanup } = freshState();
  try {
    const since = new Date().toISOString();
    tick();
    const inbound = receiveInboundTelegramText(state, {
      lane: LANE, chatId: CHAT_ID, text: "998877", replyToText: PROMPT, probeAskWindow: () => "idle",
    });
    assert.ok(inbound.relay);
    // _scrub_code_row: UPDATE thread_messages SET content = ? WHERE id = ?
    const con = new Database(dbPath);
    try {
      const res = con.prepare("UPDATE thread_messages SET content = ? WHERE id = ?")
        .run("[mfa code redacted after use]", inbound.threadMessageId);
      assert.equal(res.changes, 1);
    } finally {
      con.close();
    }
    assert.equal(relayReads(dbPath, since)[0]!.content, "[mfa code redacted after use]");
  } finally {
    cleanup();
  }
});

test("a reply-wrapped code is persisted wrapped, so the nonce guard still applies", () => {
  const { state, dbPath, cleanup } = freshState();
  try {
    const since = new Date().toISOString();
    tick();
    const wrapped = `<replying-to source="telegram" message_id="5880">\n${PROMPT}\n</replying-to>\n\n424242`;
    const inbound = receiveInboundTelegramText(state, {
      lane: LANE, chatId: CHAT_ID, text: "424242", wrappedContent: wrapped, replyToText: PROMPT,
      probeAskWindow: () => "idle",
    });
    assert.deepEqual(inbound.relay, { nonce: "a9c7", digits: 6, source: "reply", mismatched: false });
    assert.equal(relayReads(dbPath, since)[0]!.content, wrapped);
  } finally {
    cleanup();
  }
});

test("a code answering an OLD prompt's nonce is not claimed by the current relay", () => {
  const { state, cleanup } = freshState();
  try {
    const stale = "AMZ code relay [#dead]\nold question";
    const wrapped = `<replying-to source="telegram" message_id="1">\n${stale}\n</replying-to>\n\n111111`;
    state.recordTelegramMessage({
      chatId: CHAT_ID, telegramMessageId: 5881, lane: LANE, role: "assistant",
      messageKind: "conversation", messageText: PROMPT,
    });
    const inbound = receiveInboundTelegramText(state, {
      lane: LANE, chatId: CHAT_ID, text: "111111", wrappedContent: wrapped, replyToText: stale,
      probeAskWindow: () => "idle",
    });
    // The reply names #dead; the prompt Homer can see is #a9c7 — nonce wins, no ack.
    assert.equal(inbound.relay, null);
    assert.ok(inbound.threadMessageId, "still persisted — the relay decides for itself");
  } finally {
    cleanup();
  }
});

test("an ordinary message is persisted and goes to the session", () => {
  const { state, dbPath, cleanup } = freshState();
  try {
    const since = new Date().toISOString();
    tick();
    const sink = { sessionQueue: [] as string[], replies: [] as string[] };
    const inbound = handleInbound(state, { text: "what is the ABVP status" }, sink);
    assert.equal(inbound.relay, null);
    assert.deepEqual(sink.replies, []);
    assert.deepEqual(sink.sessionQueue, ["what is the ABVP status"]);
    assert.equal(relayReads(dbPath, since)[0]!.content, "what is the ABVP status");
  } finally {
    cleanup();
  }
});

test("a bare code with no pending prompt is left to the session, not swallowed", () => {
  const { state, cleanup } = freshState();
  try {
    const sink = { sessionQueue: [] as string[], replies: [] as string[] };
    const inbound = handleInbound(state, { text: "123456", askWindow: "idle" }, sink);
    assert.equal(inbound.relay, null);
    assert.deepEqual(sink.sessionQueue, ["123456"]);
  } finally {
    cleanup();
  }
});

// H1, the shape Yanqing actually uses: the relay prompt arrives, he types six digits with
// no reply-to, and nothing about that message names a nonce. Before this the OTP was
// forwarded into the Claude session transcript, where the relay's scrub cannot reach it.
test("a PLAIN code typed while the relay holds its ask lock is withheld and acknowledged", () => {
  const { state, dbPath, cleanup } = freshState();
  try {
    tick();
    const since = new Date().toISOString();
    tick();
    const sink = { sessionQueue: [] as string[], replies: [] as string[] };
    const inbound = handleInbound(state, { text: "483920", askWindow: "asking" }, sink);

    assert.deepEqual(inbound.relay, { nonce: null, digits: 6, source: "ask-lock", mismatched: false });
    assert.deepEqual(sink.sessionQueue, [], "the OTP never reaches the Claude session");
    assert.deepEqual(sink.replies, ["code received — handing it to the login"]);
    // The relay still gets it out of the table, which is the whole transport.
    const rows = relayReads(dbPath, since);
    assert.equal(rows.length, 1);
    assert.equal(looksLikeMfaCode(rows[0]!.content), "483920");
  } finally {
    cleanup();
  }
});

test("a non-code message during an ask window is untouched and still reaches the session", () => {
  const { state, cleanup } = freshState();
  try {
    const sink = { sessionQueue: [] as string[], replies: [] as string[] };
    const inbound = handleInbound(state, { text: "what is taking so long", askWindow: "asking" }, sink);
    assert.equal(inbound.relay, null);
    assert.deepEqual(sink.sessionQueue, ["what is taking so long"]);
  } finally {
    cleanup();
  }
});

test("an unreadable ask lock never withholds on its own", () => {
  const { state, cleanup } = freshState();
  try {
    const sink = { sessionQueue: [] as string[], replies: [] as string[] };
    assert.equal(handleInbound(state, { text: "483920", askWindow: "unknown" }, sink).relay, null);
    assert.deepEqual(sink.sessionQueue, ["483920"]);
  } finally {
    cleanup();
  }
});

// M1 through the real entry point.
test("a reply to a stale prompt is forwarded, not falsely acknowledged", () => {
  const { state, cleanup } = freshState();
  try {
    const staleSeconds = Math.floor((Date.now() - RELAY_PROMPT_WINDOW_MS - 60_000) / 1000);
    const wrapped = `<replying-to source="telegram" message_id="1">\n${PROMPT}\n</replying-to>\n\n123456`;
    const sink = { sessionQueue: [] as string[], replies: [] as string[] };
    const inbound = handleInbound(
      state,
      { text: "123456", wrappedContent: wrapped, replyToText: PROMPT, replyToDateSeconds: staleSeconds, askWindow: "idle" },
      sink,
    );
    assert.equal(inbound.relay, null, "no relay is listening — do not claim it was handed over");
    assert.deepEqual(sink.replies, []);
    assert.deepEqual(sink.sessionQueue, ["123456"]);
  } finally {
    cleanup();
  }
});

// N9: a live ask lock is a floor. If a nonce source ever names a different prompt than the
// one the message quotes, the code must still be withheld — the old order forwarded the OTP
// into the session while a relay was demonstrably waiting.
test("a live ask lock outranks a mismatched nonce instead of losing to it", () => {
  const { state, cleanup } = freshState();
  try {
    const stale = "AMZ code relay [#dead]\nold question";
    const wrapped = `<replying-to source="telegram" message_id="1">\n${stale}\n</replying-to>\n\n111111`;
    state.recordTelegramMessage({
      chatId: CHAT_ID, telegramMessageId: 5881, lane: LANE, role: "assistant",
      messageKind: "conversation", messageText: PROMPT,
    });
    const sink = { sessionQueue: [] as string[], replies: [] as string[] };
    const inbound = handleInbound(
      state,
      { text: "111111", wrappedContent: wrapped, replyToText: stale, askWindow: "asking" },
      sink,
    );
    assert.ok(inbound.relay, "withheld even though the quoted nonce does not match the pending one");
    assert.equal(inbound.relay!.mismatched, true);
    assert.deepEqual(sink.sessionQueue, [], "the OTP never reaches the session");
  } finally {
    cleanup();
  }
});

// N10: do not claim delivery for a code the relay will reject.
test("a mismatched code is acknowledged honestly, not as delivered", () => {
  const { state, cleanup } = freshState();
  try {
    const stale = "AMZ code relay [#dead]\nold question";
    const wrapped = `<replying-to source="telegram" message_id="1">\n${stale}\n</replying-to>\n\n111111`;
    state.recordTelegramMessage({
      chatId: CHAT_ID, telegramMessageId: 5882, lane: LANE, role: "assistant",
      messageKind: "conversation", messageText: PROMPT,
    });
    const inbound = receiveInboundTelegramText(state, {
      lane: LANE, chatId: CHAT_ID, text: "111111", wrappedContent: wrapped, replyToText: stale,
      probeAskWindow: () => "asking",
    });
    assert.equal(inbound.relay?.mismatched, true);
    assert.equal(inbound.relay?.nonce, null, "no nonce is claimed for a prompt this does not answer");
  } finally {
    cleanup();
  }
});

// Without a live ask lock the mismatch still falls through to the session, unchanged.
test("a mismatched nonce with no live ask is still forwarded", () => {
  const { state, cleanup } = freshState();
  try {
    const stale = "AMZ code relay [#dead]\nold question";
    const wrapped = `<replying-to source="telegram" message_id="1">\n${stale}\n</replying-to>\n\n111111`;
    state.recordTelegramMessage({
      chatId: CHAT_ID, telegramMessageId: 5883, lane: LANE, role: "assistant",
      messageKind: "conversation", messageText: PROMPT,
    });
    const sink = { sessionQueue: [] as string[], replies: [] as string[] };
    const inbound = handleInbound(
      state,
      { text: "111111", wrappedContent: wrapped, replyToText: stale, askWindow: "idle" },
      sink,
    );
    assert.equal(inbound.relay, null);
    assert.deepEqual(sink.sessionQueue, ["111111"]);
  } finally {
    cleanup();
  }
});
