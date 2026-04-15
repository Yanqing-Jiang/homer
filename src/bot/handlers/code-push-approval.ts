/**
 * Phase 1.4 — Telegram callbacks for nightly code-push approval.
 *
 * Callback namespace: cp:*
 *   cp:<proposalId>:approve  — approve + immediately push
 *   cp:<proposalId>:deny     — deny (commits stay local)
 */

import type { Bot } from "grammy";
import { execSync } from "child_process";
import { logger } from "../../utils/logger.js";
import type { StateManager } from "../../state/manager.js";
import {
  getCodePushProposal,
  markCodePushApproved,
  markCodePushDenied,
  executeApprovedCodePush,
  PROJECT_DIR,
} from "../../scheduler/code-push-proposal.js";

const PUSH_RETRIES = 3;
const PUSH_RETRY_DELAY_MS = 5_000;
const GH_BIN = "/opt/homebrew/bin/gh";

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function pushWithRetry(): Promise<{ ok: true } | { ok: false; error: string }> {
  let lastErr: string | undefined;
  for (let attempt = 1; attempt <= PUSH_RETRIES; attempt++) {
    try {
      let ghToken = process.env.GH_TOKEN ?? "";
      if (!ghToken) {
        ghToken = execSync(`${GH_BIN} auth token`, { encoding: "utf-8", timeout: 5_000 }).trim();
      }
      execSync("git push origin main", {
        cwd: PROJECT_DIR,
        timeout: 60_000,
        env: {
          ...process.env,
          GH_TOKEN: ghToken,
          GIT_CONFIG_COUNT: "1",
          GIT_CONFIG_KEY_0: "credential.helper",
          GIT_CONFIG_VALUE_0: `!${GH_BIN} auth git-credential`,
        },
      });
      return { ok: true };
    } catch (err: any) {
      lastErr = err.message ?? String(err);
      logger.warn({ attempt, err: lastErr }, "[CodePushApproval] push attempt failed");
      if (attempt < PUSH_RETRIES) await sleep(PUSH_RETRY_DELAY_MS);
    }
  }
  return { ok: false, error: lastErr ?? "unknown push error" };
}

export function registerCodePushApprovalHandlers(bot: Bot, stateManager: StateManager): void {
  bot.callbackQuery(/^cp:([^:]+):approve$/, async (ctx) => {
    const proposalId = ctx.match[1];
    if (!proposalId) {
      await ctx.answerCallbackQuery({ text: "Invalid proposal ID", show_alert: true });
      return;
    }

    const db = stateManager.getDb();
    const proposal = getCodePushProposal(db, proposalId);
    if (!proposal) {
      await ctx.answerCallbackQuery({ text: "Proposal not found", show_alert: true });
      return;
    }
    if (proposal.status !== "pending") {
      await ctx.answerCallbackQuery({ text: `Already ${proposal.status}`, show_alert: true });
      return;
    }

    const marked = markCodePushApproved(db, proposalId);
    if (!marked) {
      await ctx.answerCallbackQuery({ text: "Race — already decided", show_alert: true });
      return;
    }

    await ctx.answerCallbackQuery({ text: "Pushing…" });
    try {
      await ctx.editMessageReplyMarkup({ reply_markup: undefined });
    } catch { /* ignore — message may be gone */ }

    const result = await executeApprovedCodePush(db, proposalId, { pushOnce: pushWithRetry });

    const suffix = result.success
      ? `\n\n✅ <b>Pushed.</b> ${proposal.unpushedCount} commit(s) are now on origin/main.`
      : `\n\n❌ <b>Push failed:</b> ${result.error ?? "unknown"}`;
    try {
      const origText = (ctx.callbackQuery.message as { text?: string } | undefined)?.text
        ?? (ctx.callbackQuery.message as { caption?: string } | undefined)?.caption
        ?? "";
      await ctx.editMessageText(origText + suffix, { parse_mode: "HTML" });
    } catch (err) {
      logger.debug({ err }, "[CodePushApproval] could not edit original message — sending follow-up");
      await ctx.reply(suffix.trim(), { parse_mode: "HTML" });
    }
  });

  bot.callbackQuery(/^cp:([^:]+):deny$/, async (ctx) => {
    const proposalId = ctx.match[1];
    if (!proposalId) {
      await ctx.answerCallbackQuery({ text: "Invalid proposal ID", show_alert: true });
      return;
    }

    const db = stateManager.getDb();
    const denied = markCodePushDenied(db, proposalId, "denied via Telegram");
    if (!denied) {
      await ctx.answerCallbackQuery({ text: "Already decided", show_alert: true });
      return;
    }

    await ctx.answerCallbackQuery({ text: "Denied" });
    try {
      await ctx.editMessageReplyMarkup({ reply_markup: undefined });
    } catch { /* ignore */ }
    try {
      const origText = (ctx.callbackQuery.message as { text?: string } | undefined)?.text
        ?? (ctx.callbackQuery.message as { caption?: string } | undefined)?.caption
        ?? "";
      await ctx.editMessageText(origText + "\n\n🚫 <b>Denied.</b> Commits remain local.", { parse_mode: "HTML" });
    } catch { /* ignore */ }
  });
}
