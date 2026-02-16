/**
 * Career site application via Gemini 3 browser agent.
 * Uses OpenCode CLI (Gemini 3 Flash) to drive agent-browser for full
 * career-site apply chain: navigate, register, fill form, upload resume, submit.
 */

import { readFileSync, existsSync, mkdirSync } from "fs";
import type Database from "better-sqlite3";
import type { ApplyResult, ApplicationStep } from "./apply-engine.js";
import { AccountManager, type CareerAccount } from "./account-manager.js";
import { executeOpenCodeCLI } from "../executors/opencode-cli.js";
import { logger } from "../utils/logger.js";

const SCREENSHOTS_DIR = "/Users/yj/job-hunt/screenshots";
const ANSWERS_BANK_PATH = "/Users/yj/job-hunt/config/answers-bank.md";
const CAREER_APPLY_TIMEOUT = 600000; // 10 minutes

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

  return `You are applying to a job on a company career site using agent-browser CLI.

JOB CONTEXT:
- Company: ${job.company}
- Title: ${job.title}
- URL: ${job.url}
- JD excerpt: ${jdExcerpt}

${accountSection}

RESUME PDF: ${resumePath}
${coverSection}

TOOLS AVAILABLE (via bash):
- agent-browser connect 9222          # connect to Chrome
- agent-browser snapshot -i           # get interactive elements with @refs
- agent-browser open <url>            # navigate
- agent-browser fill @ref "value"     # fill input
- agent-browser select @ref "value"   # select dropdown
- agent-browser click @ref            # click button/link
- agent-browser upload @ref <file>    # upload file
- agent-browser screenshot [path]     # take screenshot
- agent-browser check @ref            # check checkbox

WORKFLOW:
1. Connect to browser: agent-browser connect 9222
2. Navigate to the job URL
3. snapshot -i to see the page
4. If redirected to career site → handle login/registration
5. Find and click "Apply" or similar button
6. Fill application form using candidate info below
7. Upload resume PDF: ${resumePath}
8. Upload cover letter if field exists
9. SKIP all optional fields (salary expectations, diversity questions unless required)
10. NEVER fill salary/compensation fields — leave blank or skip
11. Screenshot before submit to: ${SCREENSHOTS_DIR}/${job.id}_pre_submit.png
12. Click submit
13. Screenshot after submit to: ${SCREENSHOTS_DIR}/${job.id}_post_submit.png

IF REGISTRATION REQUIRED:
- Register with email from candidate info below
- Generate a random secure password (16+ chars, mixed case, numbers, symbols)
- Output the password in format: CREDENTIAL:${job.company}:<email>:<password>
- Complete email verification if needed

IF LOGIN REQUIRED AND CREDENTIALS PROVIDED:
- Login with the existing account credentials above

CANDIDATE INFO:
${answersBank}

FORM FILLING RULES:
- Required fields: fill with candidate info above
- Optional fields: SKIP (leave blank, don't check optional checkboxes)
- "How did you hear": LinkedIn
- Work authorization: Yes (US Citizen)
- Sponsorship: No
- Veteran: Yes
- Salary: NEVER FILL — leave blank or type "Prefer not to say"
- Diversity/EEO: "Decline to self-identify" if forced, otherwise skip

OUTPUT: Return a JSON summary at the very end of your response wrapped in \`\`\`json ... \`\`\` fences:
{
  "success": true/false,
  "steps": ["navigated to career page", "registered account", "filled form", "uploaded resume", "submitted"],
  "credential": "CREDENTIAL:company:email:password" or null,
  "confirmationScreenshot": "/path/to/screenshot.png" or null,
  "error": "description" or null
}`;
}

interface GeminiApplyResult {
  success: boolean;
  steps: string[];
  credential: string | null;
  confirmationScreenshot: string | null;
  error: string | null;
}

function parseGeminiResult(output: string): GeminiApplyResult {
  // Try to find JSON in code fences first
  const fenced = output.match(/```json\s*([\s\S]*?)```/);
  if (fenced) {
    try {
      return JSON.parse(fenced[1]!.trim());
    } catch { /* fall through */ }
  }

  // Try to find any JSON object in the output
  const jsonMatch = output.match(/\{[\s\S]*?"success"[\s\S]*?\}/);
  if (jsonMatch) {
    try {
      return JSON.parse(jsonMatch[0]);
    } catch { /* fall through */ }
  }

  // Couldn't parse — derive from output text
  const hasSubmit = /submit|submitted|application.*(?:sent|complete|received)/i.test(output);
  const hasError = /error|failed|captcha|blocked|timeout/i.test(output);
  const credMatch = output.match(/CREDENTIAL:([^:\n]+):([^:\n]+):([^\n]+)/);

  return {
    success: hasSubmit && !hasError,
    steps: ["gemini agent ran (could not parse structured output)"],
    credential: credMatch ? credMatch[0] : null,
    confirmationScreenshot: null,
    error: hasError ? "Agent reported an error (see logs)" : null,
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
  onStep: (step: ApplicationStep) => void
): Promise<ApplyResult> {
  const steps: ApplicationStep[] = [];
  let stepNum = 0;
  const accountMgr = new AccountManager(db);

  if (!existsSync(SCREENSHOTS_DIR)) mkdirSync(SCREENSHOTS_DIR, { recursive: true });

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
    onStep(acctStep);

    // 3. Decrypt password if we have an account
    const accountPassword = account ? accountMgr.getDecryptedPassword(account.id) : null;

    // 4. Determine resume path
    const resumePath = application.resume_version && existsSync(application.resume_version)
      ? application.resume_version
      : "/Users/yj/job-hunt/resumes/base-resume.txt";

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

    const result = await executeOpenCodeCLI(prompt, "", {
      model: "google/gemini-3-flash-preview",
      researchOnly: false,
      timeout: CAREER_APPLY_TIMEOUT,
      cwd: "/Users/yj/job-hunt",
    });

    if (result.exitCode !== 0) {
      agentStep.stepStatus = "failed";
      agentStep.error = result.output?.slice(0, 500) || "Gemini agent failed";
      steps.push(agentStep);
      onStep(agentStep);
      return {
        success: false,
        steps,
        error: agentStep.error,
      };
    }

    steps.push(agentStep);
    onStep(agentStep);

    // 5. Parse Gemini output
    const geminiResult = parseGeminiResult(result.output);

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
          onStep(credStep);
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
      onStep(s);
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
