/**
 * Inbound-message persistence and MFA-relay recognition.
 *
 * The `vc-login` / `amc-login` skills ask Yanqing for an MFA code through
 * `~/Desktop/AMZ_API/ops/tg_code_relay.py`. Telegram allows exactly ONE getUpdates
 * consumer per token and the Homer daemon is it, so the relay's `homer_db` source does
 * not poll Telegram at all: it sends the prompt with sendMessage and then reads the row
 * the daemon persists into `thread_messages(thread_id='tg:<chat>', role='user')` every
 * three seconds until its window closes.
 *
 * That contract only holds if the daemon writes the row PROMPTLY. Before this module the
 * row was created inside `handleNewExecution`, i.e. after the thinking indicator, the
 * bootstrap-file read, the thread lookup and the "queued — will reply after current turn"
 * reply — and, worse, only once the update had been dequeued at all (see the non-blocking
 * dispatch in ./index.ts). Persisting here, at receipt, makes the row the first thing that
 * happens to an inbound message.
 *
 * Everything except `receiveInboundTelegramText` is pure so the recognition rules can be
 * tested against fixtures, and they deliberately mirror the Python side
 * (`looks_like_code`, `split_reply`, `_names_another_prompt`) — a message that Homer
 * classifies as a code must be exactly the set the relay would accept.
 */

import { randomUUID } from "node:crypto";
import { closeSync, existsSync, openSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { flockSync } from "fs-ext";
import { logger } from "../utils/logger.js";
import type { StateManager } from "../state/manager.js";

/** The marker the relay puts in every prompt: `AMZ code relay [#a9c7]`. */
export const RELAY_PROMPT_RE = /AMZ code relay\s*\[#([0-9a-f]{4})\]/i;
/** Any nonce marker, used to tell "answers a different prompt" from "answers ours". */
const NONCE_RE = /\[#([0-9a-f]{4})\]/i;
/** How the daemon persists a Telegram reply-to; the relay's split_reply() unwraps it. */
const REPLY_WRAP_RE = /^\s*<replying-to\b[^>]*>([\s\S]*?)<\/replying-to>/;
/**
 * How far back a relay prompt still counts as pending. `ask_code`'s default window is
 * 600 s and its prompt advertises "Window: 10 min"; 15 minutes covers that plus the
 * setup the relay charges to its own budget, and nothing beyond it.
 */
export const RELAY_PROMPT_WINDOW_MS = 15 * 60 * 1000;

/**
 * `tg_code_relay.STATE_PATH`, and the lock `_AskLock` derives from it (`path + ".lock"`).
 * Hard-coded in the relay, which we must not modify, so it is hard-coded here too.
 */
export const RELAY_STATE_PATH = join(homedir(), "Library", "Logs", "AMZ_API", "tg_code_relay_state.json");
export const RELAY_LOCK_PATH = `${RELAY_STATE_PATH}.lock`;

/** `[body, quotedPrompt]` — mirrors tg_code_relay.split_reply. */
export function splitReplyWrapper(text: string): { body: string; quoted: string | null } {
  const match = REPLY_WRAP_RE.exec(text);
  if (!match) return { body: text, quoted: null };
  return { body: text.slice(match[0].length), quoted: match[1]! };
}

/**
 * The normalised code, or null. A code is a WHOLE message of 4-8 digits; internal
 * spaces and dashes are stripped (phones format codes), anything else is not an answer.
 * Mirrors tg_code_relay.looks_like_code, including its deliberate rejection of
 * "the code is 123456".
 */
export function looksLikeMfaCode(text: string | null | undefined): string | null {
  if (text == null) return null;
  const stripped = String(text).replace(/[\s\-‐-―]/g, "");
  return /^\d{4,8}$/.test(stripped) ? stripped : null;
}

export function relayNonceIn(text: string | null | undefined): string | null {
  if (!text) return null;
  const match = RELAY_PROMPT_RE.exec(text);
  return match ? match[1]!.toLowerCase() : null;
}

/** True when a quoted prompt names a DIFFERENT relay nonce — mirrors _names_another_prompt. */
export function quotesAnotherNonce(quoted: string | null, nonce: string): boolean {
  if (!quoted) return false;
  const match = NONCE_RE.exec(quoted);
  return match !== null && match[1]!.toLowerCase() !== nonce;
}

export interface RelayPromptCandidate {
  text: string;
  /** Epoch ms the outbound message was recorded. */
  createdAt: number;
}

/**
 * Is a relay in its ask window RIGHT NOW?
 *
 * `_AskLock` (tg_code_relay.py:218-251) holds an exclusive `flock` on
 * `<state>.lock` for the whole ask — it is taken before the prompt is sent and released
 * only after `_await_homer_db` returns or times out. So "somebody else holds that lock"
 * is exactly "a relay is waiting for a code", with no cooperation from the relay and no
 * change to AMZ_API.
 *
 * This is the ONLY source that works for the shape Yanqing actually uses. `ask_code`
 * sends its prompt with a direct `api.call("sendMessage", …)`, so the prompt never
 * reaches `telegram_messages` and the outbound-nonce source below is structurally empty;
 * the reply-to source only fires if he long-presses and replies rather than typing six
 * digits, which is what the prompt itself asks for.
 *
 * Probing is read-only in effect: we take the lock non-blockingly and release it in the
 * same breath, so the worst a concurrent relay sees is one failed `LOCK_EX|LOCK_NB` that
 * its own 0.5 s retry loop absorbs. We never create the file — an absent lock means no
 * relay has ever run here, which is not a pending ask.
 *
 * Fails OPEN, deliberately (round-2 review N8 — the comment used to claim the opposite):
 * any unexpected error reports "unknown", and only "asking" ever withholds. An unreadable
 * lock must not start swallowing every numeric message Yanqing sends.
 */
export type AskWindowState = "asking" | "idle" | "unknown";

export function probeRelayAskWindow(lockPath: string = RELAY_LOCK_PATH): AskWindowState {
  if (!existsSync(lockPath)) return "idle";
  let fd: number | undefined;
  try {
    fd = openSync(lockPath, "r");
  } catch {
    return "unknown";
  }
  try {
    // Shared, non-blocking: an exclusive holder blocks it, and two concurrent Homer
    // probes never block each other.
    flockSync(fd, "shnb");
    try { flockSync(fd, "un"); } catch { /* released on close anyway */ }
    return "idle";
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EAGAIN" || code === "EWOULDBLOCK" || code === "EACCES") return "asking";
    return "unknown";
  } finally {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* best effort */ } }
  }
}

export interface PendingRelay {
  /** null when the ask-lock told us a relay is waiting but not which one. */
  nonce: string | null;
  source: "outbound" | "reply" | "ask-lock";
  /** True when the relay's ask lock is held right now, whatever named the prompt. */
  asking: boolean;
}

/**
 * The relay prompt that is plausibly still waiting for an answer, in priority order:
 *
 *  1. the most recent outbound message in the same chat carrying the marker, inside the
 *     window — this is what is actually PENDING, so it wins when it exists;
 *  2. the message Yanqing replied to, if that message is itself inside the window (M1: an
 *     un-bounded reply-to let a scroll-back reply to yesterday's prompt be acknowledged as
 *     "handed to the login" and then silently dropped);
 *  3. the relay's own ask lock — no nonce, but proof that a relay is waiting right now.
 *
 * Order matters for 1 vs 2: a reply to a stale prompt must not outrank the live one, and
 * `quotesAnotherNonce` then rejects the mismatch so the code falls through to normal
 * handling, which is the safe direction.
 */
export function detectPendingRelayPrompt(input: {
  replyToText?: string | null;
  /** Telegram `date` of the replied-to message, in SECONDS (its own unit). */
  replyToDateSeconds?: number | null;
  recentOutbound?: readonly RelayPromptCandidate[];
  askWindow?: AskWindowState;
  now?: number;
  windowMs?: number;
}): PendingRelay | null {
  const now = input.now ?? Date.now();
  const windowMs = input.windowMs ?? RELAY_PROMPT_WINDOW_MS;

  // N9: a live ask lock is an unconditional FLOOR, not the lowest-priority source. It used
  // to lose to a nonce source, so if `recentOutbound` ever carried a prompt whose nonce
  // differed from the one the message quoted, `quotesAnotherNonce` would reject the match
  // and forward the OTP into the session even though a relay was demonstrably waiting. The
  // nonce sources now only NAME the prompt; whether to withhold is decided here.
  const asking = input.askWindow === "asking";

  const candidates = [...(input.recentOutbound ?? [])].sort((a, b) => b.createdAt - a.createdAt);
  for (const candidate of candidates) {
    if (now - candidate.createdAt > windowMs) continue;
    const nonce = relayNonceIn(candidate.text);
    if (nonce) return { nonce, source: "outbound", asking };
  }

  const replyNonce = relayNonceIn(input.replyToText);
  if (replyNonce) {
    const at = input.replyToDateSeconds != null ? input.replyToDateSeconds * 1000 : null;
    // An unknown date is treated as in-window: Telegram always supplies `date`, so the
    // only way to get here is a caller that did not thread it through, and refusing then
    // would silently disable the reply-to path.
    if (at === null || now - at <= windowMs) return { nonce: replyNonce, source: "reply", asking };
  }

  if (asking) return { nonce: null, source: "ask-lock", asking };
  return null;
}

export interface InboundDisposition {
  /** Row id written to thread_messages, or null when nothing was persisted. */
  threadMessageId: string | null;
  /** Exactly what was persisted (reply-wrapped when the message quoted a Homer message). */
  content: string;
  /**
   * Set when this message is an answer to a pending relay prompt. The caller must
   * acknowledge it and must NOT feed it to the Claude session — the relay consumes the
   * row directly and scrubs it afterwards, and routing an OTP through a session
   * transcript would put it somewhere the relay cannot redact.
   */
  relay: {
    nonce: string | null;
    digits: number;
    source: PendingRelay["source"];
    /** The message quotes a DIFFERENT prompt than the one we believe is pending (N10). */
    mismatched: boolean;
  } | null;
}

export interface ReceiveInboundArgs {
  lane: string;
  chatId: number;
  /** Raw message text. */
  text: string;
  /** Reply-wrapped content to persist, when the message quoted a Homer message. */
  wrappedContent?: string | null;
  /** Text of the message being replied to, if any. */
  replyToText?: string | null;
  /** Telegram `date` of the replied-to message, in seconds. */
  replyToDateSeconds?: number | null;
  now?: number;
  /** Test seam for the relay ask-lock probe. */
  probeAskWindow?: () => AskWindowState;
}

/**
 * Persist an inbound Telegram text message and classify it, BEFORE any queueing
 * decision. Returns the row id so the execution path reuses the same row instead of
 * writing a second one.
 *
 * Never logs message content: an inbound message in this lane may be an OTP.
 */
export function receiveInboundTelegramText(
  stateManager: StateManager,
  args: ReceiveInboundArgs,
): InboundDisposition {
  const content = args.wrappedContent ?? args.text;
  const now = args.now ?? Date.now();
  if (!content.trim()) return { threadMessageId: null, content, relay: null };

  let threadMessageId: string | null = null;
  if (stateManager.isOpen) {
    const thread = stateManager.ensureThreadForLane(args.lane, { title: `Telegram ${args.chatId}` });
    threadMessageId = randomUUID();
    stateManager.createThreadMessage({
      id: threadMessageId,
      threadId: thread.id,
      role: "user",
      content,
    });
  }

  const { body, quoted } = splitReplyWrapper(content);
  const code = looksLikeMfaCode(body);
  if (!code) return { threadMessageId, content, relay: null };

  const recentOutbound = stateManager.isOpen
    ? stateManager
        .findRecentTelegramMessages(args.chatId, now - RELAY_PROMPT_WINDOW_MS)
        .map((row) => ({ text: row.messageText, createdAt: row.createdAt }))
    : [];

  // Only probe the ask lock once we know the body IS a code — the probe is a syscall on a
  // path outside Homer, and there is no reason to make it for ordinary conversation.
  let askWindow: AskWindowState = "idle";
  try {
    askWindow = (args.probeAskWindow ?? probeRelayAskWindow)();
  } catch (err) {
    logger.warn({ err }, "Relay ask-window probe failed — treating as not asking");
    askWindow = "unknown";
  }

  const pending = detectPendingRelayPrompt({
    replyToText: args.replyToText,
    replyToDateSeconds: args.replyToDateSeconds,
    recentOutbound,
    askWindow,
    now,
  });
  if (!pending) return { threadMessageId, content, relay: null };

  // The nonce guard only applies when we KNOW which prompt is pending AND no relay is
  // actually holding its ask lock. A live ask lock means a relay is waiting for a code right
  // now, so withholding the OTP is correct whatever the message happens to quote (N9).
  if (!pending.asking && pending.nonce !== null && quotesAnotherNonce(quoted, pending.nonce)) {
    return { threadMessageId, content, relay: null };
  }

  // N10: when the nonce we know is not the one this message answers, the relay will ignore
  // it — so acknowledge honestly rather than claiming it was handed over.
  const mismatched = pending.nonce !== null && quotesAnotherNonce(quoted, pending.nonce);
  return {
    threadMessageId,
    content,
    relay: { nonce: mismatched ? null : pending.nonce, digits: code.length, source: pending.source, mismatched },
  };
}
