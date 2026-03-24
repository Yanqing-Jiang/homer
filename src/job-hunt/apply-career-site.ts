/**
 * Career site application via Gemini 3 browser agent.
 * Uses OpenCode CLI (Gemini 3 Flash) to drive agent-browser for full
 * career-site apply chain: navigate, register, fill form, upload resume, submit.
 */

import { readFileSync, existsSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
// @ts-ignore
import type Database from "better-sqlite3";
import type { ApplyResult, ApplicationStep } from "./apply-engine.js";
import { AccountManager, type CareerAccount } from "./account-manager.js";
import { executeOpenCodeCLI, isAuthError } from "../executors/opencode-cli.js";
import { GEMINI_CLI_FLASH_MODEL } from "../executors/gemini-cli.js";
import { waitForVerificationEmail } from "./gmail-client.js";
import { logger } from "../utils/logger.js";

const DEBUG_OUTPUT_DIR = "/Users/yj/homer/output/gemini";

const SCREENSHOTS_DIR = "/Users/yj/job-hunt/screenshots";
const ANSWERS_BANK_PATH = "/Users/yj/job-hunt/config/answers-bank.md";
const CAREER_APPLY_TIMEOUT = 600000; // 10 minutes

async function checkChromeReachable(): Promise<boolean> {
  try {
    const r = await fetch("http://localhost:9222/json/version", {
      signal: AbortSignal.timeout(3000),
    });
    return r.ok;
  } catch {
    return false;
  }
}

interface CareerSiteJob {
  id: string;
  url: string;
  company: string;
  title: string;
  description?: string;
}

function buildAgentPrompt(
  job: CareerSiteJob,
  resumePath: string,
  coverLetterPath: string | null,
  account: CareerAccount | null,
  accountPassword: string | null,
  answersBank: string,
): string {
  const accountSection = account
    ? `EXISTING ACCOUNT:\n- Email: ${account.username}\n- Password: ${accountPassword ?? "(could not decrypt — try password recovery)"}\n- Login URL: ${account.loginUrl}\n- Use these credentials to log in first.`
    : "NO EXISTING ACCOUNT — register if needed.";

  const coverSection = coverLetterPath && existsSync(coverLetterPath)
    ? `COVER LETTER: ${coverLetterPath} (upload if the form has a cover letter field)`
    : "No cover letter available.";

  const jdExcerpt = job.description ? job.description.slice(0, 1500) : "(no description available)";

  return `CRITICAL OUTPUT REQUIREMENT: You MUST end your response with a JSON block in \`\`\`json ... \`\`\` fences. No exceptions. If you cannot complete the task, still output JSON with success:false and an error message.

You are applying to a job on a company career site. You MUST use agent-browser CLI commands via bash to actually navigate and fill forms. Do NOT just describe what you would do — execute the commands.

JOB CONTEXT:
- Company: ${job.company}
- Title: ${job.title}
- URL: ${job.url}
- JD excerpt: ${jdExcerpt}

${accountSection}

RESUME PDF: ${resumePath}
${coverSection}

TOOLS — execute these bash commands directly:
  agent-browser connect 9222          # ALWAYS run this first
  agent-browser open "<url>"          # navigate (waits for page load)
  agent-browser snapshot -i           # get interactive elements with @refs
  agent-browser fill @ref "value"     # fill input
  agent-browser select @ref "value"   # select dropdown
  agent-browser click @ref            # click button/link
  agent-browser upload @ref <file>    # upload file
  agent-browser screenshot <path>     # take screenshot
  agent-browser check @ref            # check checkbox

AGENT-BROWSER RULES:
- NEVER use JSON.stringify in eval scripts — return raw JS objects
- Use agent-browser open "<url>" NOT eval "window.location.href='url'" for navigation
- eval scripts must be single-line (no newlines)

WORKFLOW — execute each step:
1. agent-browser connect 9222
2. agent-browser open "${job.url}"
3. agent-browser snapshot -i  →  inspect the page
4. Handle login/registration if redirected to career site
5. Find and click "Apply" or similar button
6. Fill application form fields using candidate info below
7. agent-browser upload @ref ${resumePath}  →  upload resume
8. Upload cover letter if the form has a cover letter field
9. SKIP all optional fields (salary, diversity questions unless required)
10. NEVER fill salary/compensation — leave blank or "Prefer not to say"
11. agent-browser screenshot ${SCREENSHOTS_DIR}/${job.id}_pre_submit.png
12. Click submit button
13. agent-browser screenshot ${SCREENSHOTS_DIR}/${job.id}_post_submit.png

IF REGISTRATION REQUIRED:
- Register with email from candidate info below
- Generate a random secure password (16+ chars, mixed case, numbers, symbols)
- Output the password as: CREDENTIAL:${job.company}:<email>:<password>
- If you hit a "verify your email" screen after registering, stop and set needs_email_verification:true in the JSON

IF LOGIN REQUIRED AND CREDENTIALS PROVIDED:
- Login with the existing account credentials above

CANDIDATE INFO:
${answersBank}

FORM FILLING RULES:
- Required fields: fill with candidate info
- Optional fields: SKIP entirely
- "How did you hear": LinkedIn
- Work authorization: Yes (US Citizen)
- Sponsorship: No
- Veteran: Yes
- Salary: NEVER FILL
- Diversity/EEO: "Decline to self-identify" if required, otherwise skip

MANDATORY FINAL OUTPUT — your response MUST end with this JSON block:
\`\`\`json
{
  "success": true or false,
  "steps": ["list", "of", "completed", "steps"],
  "credential": "CREDENTIAL:company:email:password" or null,
  "confirmationScreenshot": "/path/to/screenshot.png" or null,
  "needs_email_verification": false,
  "company_domain": null,
  "error": "error description" or null
}
\`\`\``;
}

interface GeminiApplyResult {
  success: boolean;
  steps: string[];
  credential: string | null;
  confirmationScreenshot: string | null;
  error: string | null;
  needs_email_verification?: boolean;
  company_domain?: string;
}

function parseGeminiResult(output: string, jobId?: string): GeminiApplyResult {
  // Match the LAST JSON code fence (agent may emit multiple — final one is the result)
  const allFenced = [...output.matchAll(/```json\s*([\s\S]*?)```/g)];
  const fenced = allFenced.length > 0 ? allFenced[allFenced.length - 1] : null;
  if (fenced) {
    try {
      const parsed = JSON.parse(fenced[1]!.trim());
      return {
        success: typeof parsed.success === "boolean" ? parsed.success : false,
        steps: Array.isArray(parsed.steps) ? parsed.steps : [],
        credential: parsed.credential ?? null,
        confirmationScreenshot: parsed.confirmationScreenshot ?? null,
        error: parsed.error ?? null,
        needs_email_verification: parsed.needs_email_verification,
        company_domain: parsed.company_domain,
      };
    } catch { /* fall through */ }
  }

  // Try to find any JSON object in the output
  const jsonMatch = output.match(/\{[\s\S]*?"success"[\s\S]*?\}/);
  if (jsonMatch) {
    try {
      return JSON.parse(jsonMatch[0]);
    } catch { /* fall through */ }
  }

  // Couldn't parse — save raw output to debug file and derive from text
  try {
    mkdirSync(DEBUG_OUTPUT_DIR, { recursive: true });
    const slug = jobId ? `apply-${jobId}` : "apply-unknown";
    const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const debugPath = join(DEBUG_OUTPUT_DIR, `${slug}-${ts}.md`);
    writeFileSync(debugPath, `# Gemini Apply Debug — ${jobId ?? "unknown"}\n\nRaw output (JSON parse failed):\n\n${output}`);
    logger.warn({ jobId, debugPath }, "Gemini apply: could not parse JSON — saved raw output");
  } catch (e) {
    logger.warn({ error: e }, "Could not write Gemini debug output");
  }

  // Require definitive confirmation phrases — avoid matching agent planning text ("I will submit")
  const hasSubmit = /application.*(?:submitted|received|sent|complete)|confirmation.*number|successfully submitted|thank you for applying/i.test(output);
  const hasError = /error|failed|captcha|blocked|timeout/i.test(output);
  const credMatch = output.match(/CREDENTIAL:([^:\n]+):([^:\n]+):([^\n]+)/);

  return {
    success: hasSubmit && !hasError,
    steps: ["gemini agent ran (could not parse structured output)"],
    credential: credMatch ? credMatch[0] : null,
    confirmationScreenshot: null,
    error: hasError ? "Agent reported an error (see logs)" : "No JSON output from agent",
  };
}

function extractCredential(output: string): { company: string; email: string; password: string } | null {
  const match = output.match(/CREDENTIAL:([^:\n]+):([^:\n]+):([^\n]+)/);
  if (!match) return null;
  return { company: match[1]!, email: match[2]!, password: match[3]!.trim() };
}

export async function careerSiteApply(
  job: CareerSiteJob,
  application: { id: string; resume_version?: string; cover_letter?: string },
  db: Database.Database,
  onStep: (step: ApplicationStep) => Promise<void>
): Promise<ApplyResult> {
  const steps: ApplicationStep[] = [];
  let stepNum = 0;
  const accountMgr = new AccountManager(db);

  if (!existsSync(SCREENSHOTS_DIR)) mkdirSync(SCREENSHOTS_DIR, { recursive: true });

  // Chrome preflight check
  const chromeOk = await checkChromeReachable();
  if (!chromeOk) {
    return { success: false, steps, error: "Chrome not running on port 9222" };
  }

  try {
    // 1. Load answers bank
    let answersBank = "";
    try {
      answersBank = readFileSync(ANSWERS_BANK_PATH, "utf8");
    } catch {
      logger.warn("Could not read answers bank");
    }

    // 2. Check for existing account
    stepNum++;
    const account = await accountMgr.getAccount(job.company);
    const acctStep: ApplicationStep = {
      stepNumber: stepNum,
      stepType: account ? "found_account" : "no_account",
      stepStatus: "completed",
    };
    steps.push(acctStep);
    await onStep(acctStep);

    // 3. Decrypt password if we have an account
    const accountPassword = account ? accountMgr.getDecryptedPassword(account.id) : null;

    // 4. Determine resume path — always use PDF (career sites cannot upload .txt)
    const resumePath = application.resume_version && existsSync(application.resume_version)
      ? application.resume_version
      : "/Users/yj/job-hunt/resumes/base-resume.pdf";

    // 5. Build prompt and run Gemini agent
    stepNum++;
    const prompt = buildAgentPrompt(
      job,
      resumePath,
      application.cover_letter ?? null,
      account,
      accountPassword,
      answersBank,
    );

    const agentStep: ApplicationStep = {
      stepNumber: stepNum,
      stepType: "gemini_agent",
      stepStatus: "completed",
    };

    logger.info({ jobId: job.id, company: job.company }, "Starting Gemini career-site agent");

    const agentOptions = {
      model: `google/${GEMINI_CLI_FLASH_MODEL}`,
      researchOnly: false,
      timeout: CAREER_APPLY_TIMEOUT,
      cwd: "/Users/yj/job-hunt",
    } as const;

    let result = await executeOpenCodeCLI(prompt, "", agentOptions);

    // Exponential backoff retry on auth errors (token expiry, network blip)
    const authBackoffs = [5_000, 15_000, 45_000];
    for (let attempt = 0; attempt < authBackoffs.length && (result.exitCode === 3 || isAuthError(result.output)); attempt++) {
      const wait = authBackoffs[attempt]!;
      logger.warn({ jobId: job.id, attempt }, `Auth error — retrying in ${wait}ms`);
      await new Promise(r => setTimeout(r, wait));
      result = await executeOpenCodeCLI(prompt, "", agentOptions);
    }

    if (result.exitCode !== 0) {
      agentStep.stepStatus = "failed";
      agentStep.error = result.output?.slice(0, 500) || "Gemini agent failed";
      steps.push(agentStep);
      await onStep(agentStep);
      return {
        success: false,
        steps,
        error: agentStep.error,
      };
    }

    steps.push(agentStep);
    await onStep(agentStep);

    // 5. Parse Gemini output
    let geminiResult = parseGeminiResult(result.output, job.id);

    // 5a. Handle email verification gate
    if (geminiResult.needs_email_verification && geminiResult.company_domain) {
      stepNum++;
      const verifyStep: ApplicationStep = {
        stepNumber: stepNum,
        stepType: "email_verification_wait",
        stepStatus: "completed",
      };
      steps.push(verifyStep);
      await onStep(verifyStep);

      logger.info({ domain: geminiResult.company_domain }, "Waiting for verification email");
      const verifyUrl = await waitForVerificationEmail(geminiResult.company_domain, 300_000);

      if (!verifyUrl) {
        return { success: false, steps, error: "Email verification timeout — no link received within 5 min" };
      }

      // Re-invoke agent to click verification link and complete application
      const verifyPrompt = `Navigate to this email verification link: ${verifyUrl}
After verifying, continue the job application for ${job.company} - ${job.title} at ${job.url}.
Use the same resume at ${application.resume_version ?? "/Users/yj/job-hunt/resumes/base-resume.txt"}.
Complete the form and submit. Return the same JSON format as before.`;

      const verifyResult = await executeOpenCodeCLI(verifyPrompt, "", {
        model: `google/${GEMINI_CLI_FLASH_MODEL}`,
        researchOnly: false,
        timeout: 480_000, // 8 min remaining
        cwd: "/Users/yj/job-hunt",
      });

      if (verifyResult.exitCode === 0) {
        geminiResult = parseGeminiResult(verifyResult.output, job.id);
      } else {
        return { success: false, steps, error: "Post-verification apply failed" };
      }
    }

    // 6. Store credential if returned
    if (geminiResult.credential) {
      const cred = extractCredential(geminiResult.credential);
      if (cred) {
        stepNum++;
        try {
          await accountMgr.createAccount(cred.company, job.url, cred.email, cred.password);
          const credStep: ApplicationStep = {
            stepNumber: stepNum,
            stepType: "store_credential",
            stepStatus: "completed",
          };
          steps.push(credStep);
          await onStep(credStep);
          logger.info({ company: cred.company }, "Stored new career site credentials");
        } catch (err) {
          logger.warn({ error: err, company: cred.company }, "Failed to store credential");
        }
      }
    }

    // 7. Record Gemini steps
    for (const gemStep of geminiResult.steps) {
      stepNum++;
      const s: ApplicationStep = {
        stepNumber: stepNum,
        stepType: gemStep,
        stepStatus: geminiResult.success ? "completed" : "failed",
      };
      steps.push(s);
      await onStep(s);
    }

    // 8. Check for CAPTCHA or MFA in error
    if (!geminiResult.success && geminiResult.error) {
      const errorLower = geminiResult.error.toLowerCase();
      if (errorLower.includes("captcha")) {
        return {
          success: false,
          steps,
          escalation: "captcha",
          error: geminiResult.error,
          confirmationScreenshot: geminiResult.confirmationScreenshot ?? undefined,
        };
      }
      if (errorLower.includes("mfa") || errorLower.includes("two-factor") || errorLower.includes("verification code")) {
        return {
          success: false,
          steps,
          escalation: "mfa_required",
          error: geminiResult.error,
        };
      }
    }

    return {
      success: geminiResult.success,
      steps,
      error: geminiResult.error ?? undefined,
      confirmationScreenshot: geminiResult.confirmationScreenshot ?? undefined,
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.error({ error, jobId: job.id }, "Career site apply failed");
    return { success: false, steps, error: msg };
  }
}
