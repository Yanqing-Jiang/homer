import { sendSmsNotification } from "../bot/handlers/sms.js";
import { YANQING_PHONE, SMS_MAX_LENGTH } from "./constants.js";

/**
 * Send an emergency SMS to Yanqing. Best-effort — never throws.
 * Strips emoji, truncates, and prefixes with [HOMER ALERT].
 */
export async function sendEmergencySms(message: string): Promise<void> {
  try {
    const clean = message.replace(/[\u{1F000}-\u{1FFFF}]|[\u{2600}-\u{27BF}]|[\u{FE00}-\u{FEFF}]/gu, "").trim();
    const prefix = "[HOMER ALERT] ";
    const maxBody = SMS_MAX_LENGTH - prefix.length;
    const body = prefix + (clean.length > maxBody ? clean.slice(0, maxBody - 3) + "..." : clean);
    await sendSmsNotification(YANQING_PHONE, body);
  } catch {
    // best-effort — swallow all errors
  }
}
