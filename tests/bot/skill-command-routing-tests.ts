/**
 * `/vc-login` and `/amc-login` as real bot commands.
 *
 * Before 2026-09-01 both were rejected by the parser as unknown slash commands
 * (src/commands/parser.ts) because they exist only as Claude Code skills — so the MFA
 * relay flow could only be started by typing a sentence. They are now registered as
 * category "skill", which the parser rewrites into an ordinary session query. That means
 * they take exactly the same route as any other message: same executor, same permissions,
 * same per-lane queue, and therefore the same receipt-time persistence and relay-code
 * acknowledgement for the reply that follows.
 *
 * The assertions below mirror the guards in `bot.on("message:text")` rather than starting
 * a bot; the no-telegram helper is imported first so nothing can open a poller.
 */
import "../helpers/no-telegram.js";
import assert from "node:assert/strict";
import test from "node:test";
import {
  getCommand,
  getCommandsByCategory,
  isExecutorSwitchWithQuery,
  isPureExecutorSwitch,
  parseCommand,
  skillInvocationQuery,
  type ParsedCommand,
} from "../../src/commands/index.js";

/**
 * The routing decision `bot.on("message:text")` makes, in order, for a slash message that
 * no `bot.command(...)` handler claimed. Returns what the handler would do with it.
 */
function routeOf(text: string): "unknown-command" | "fresh-session" | "executor-switch" | "prompt-for-input" | "session-turn" {
  const parsed = parseCommand(text);
  if (!parsed) return "prompt-for-input";
  if (parsed.unknownCommand) return "unknown-command";
  if (parsed.isNewSession) return "fresh-session";
  if (isPureExecutorSwitch(parsed) || isExecutorSwitchWithQuery(parsed)) return "executor-switch";
  if (!parsed.query && !parsed.command) return "prompt-for-input";
  return "session-turn";
}

test("both login commands are registered as skill commands", () => {
  const skills = getCommandsByCategory("skill").map((c) => c.name).sort();
  assert.deepEqual(skills, ["/amc-login", "/vc-login"]);
  assert.equal(getCommand("/vc-login")?.skill, "vc-login");
  assert.equal(getCommand("/amc-login")?.skill, "amc-login");
  // Underscore aliases, because Telegram's own command menu dislikes hyphens.
  assert.equal(getCommand("/vc_login")?.skill, "vc-login");
  assert.equal(getCommand("/amc_login")?.skill, "amc-login");
  for (const name of ["/vc-login", "/amc-login"]) {
    assert.ok((getCommand(name)?.description ?? "").length > 0, `${name} needs a /help description`);
  }
});

test("/vc-login is no longer an unknown command and becomes a session turn", () => {
  assert.equal(routeOf("/vc-login"), "session-turn");
  assert.equal(routeOf("/amc-login"), "session-turn");
  assert.equal(routeOf("/vc_login"), "session-turn");
});

test("the rewritten query names the skill so the session invokes it, not a paraphrase", () => {
  const parsed = parseCommand("/vc-login") as ParsedCommand;
  assert.equal(parsed.command, "/vc-login");
  assert.equal(parsed.skill, "vc-login");
  assert.equal(parsed.query, skillInvocationQuery("vc-login"));
  assert.match(parsed.query, /vc-login skill/);
  assert.match(parsed.query, /\/vc-login/, "echoes the slash trigger the skill declares");
  assert.equal(parsed.isNewSession, false, "a login must not wipe the session it reports into");
  assert.equal(parsed.isExecutorSwitch, false, "runs on the lane's existing executor");
});

test("arguments after the command are carried into the invocation", () => {
  const parsed = parseCommand("/vc-login the OX downloader is stuck") as ParsedCommand;
  assert.equal(parsed.query, skillInvocationQuery("vc-login", "the OX downloader is stuck"));
  assert.match(parsed.query, /the OX downloader is stuck$/);
});

test("skillInvocationQuery is stable and trims empty arguments", () => {
  assert.equal(skillInvocationQuery("amc-login"), "Run the amc-login skill now (Telegram /amc-login).");
  assert.equal(skillInvocationQuery("amc-login", "   "), "Run the amc-login skill now (Telegram /amc-login).");
});

test("genuinely unknown slash commands are still rejected", () => {
  assert.equal(routeOf("/definitely-not-a-command"), "unknown-command");
  assert.equal(routeOf("/vclogin"), "unknown-command", "no fuzzy matching on login commands");
});

test("existing command routing is unchanged", () => {
  assert.equal(routeOf("/new"), "fresh-session");
  assert.equal(routeOf("/claude"), "executor-switch");
  assert.equal(routeOf("/claude summarise this"), "executor-switch");
  assert.equal(routeOf("log back into vendor central"), "session-turn", "the old phrasing still works");
});
