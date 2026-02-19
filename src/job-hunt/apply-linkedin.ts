/**
 * LinkedIn Easy Apply automation via agent-browser.
 * Form filling from answers config, resume upload, screenshot before submit.
 */

import { readFileSync, mkdirSync, existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import type { ApplyResult, ApplicationStep } from "./apply-engine.js";
import { runBrowser, safeNavigate, safeEval } from "./browser-utils.js";
import { logger } from "../utils/logger.js";

const SCREENSHOTS_DIR = "/Users/yj/job-hunt/screenshots";
const ANSWERS_PATH = join(homedir(), "job-hunt/config/answers.json");

// Load PII answers from config file (not source code)
function loadAnswers(): Record<string, string> {
  try {
    return JSON.parse(readFileSync(ANSWERS_PATH, "utf8"));
  } catch {
    logger.warn("Could not load answers.json — form fill will be limited");
    return {};
  }
}

// Field matchers — map common form field labels to answers
function buildFieldMatchers(): Record<string, string | ((options: string[]) => string)> {
  const answers = loadAnswers();
  return {
    phone: answers.phone ?? "",
    email: answers.email ?? "",
    linkedin: answers.linkedin ?? "",
    website: answers.website ?? "",
    "years of experience": (options) => findClosest(options, "10"),
    education: (options) => findClosest(options, "Master"),
    "work authorization": "Yes",
    "authorized to work": "Yes",
    sponsorship: "No",
    "require sponsorship": "No",
    veteran: answers.veteran ?? "Yes",
    disability: "Decline to self-identify",
    gender: "Decline to self-identify",
    race: "Decline to self-identify",
    ethnicity: "Decline to self-identify",
    "how did you hear": "LinkedIn",
  };
}

// NEVER auto-fill salary
const NEVER_FILL = ["salary", "compensation", "expected pay", "desired salary"];

function findClosest(options: string[], target: string): string {
  const lower = target.toLowerCase();
  return options.find((o) => o.toLowerCase().includes(lower)) ?? options[0] ?? target;
}

async function takeScreenshot(label: string, jobId: string): Promise<string | null> {
  if (!existsSync(SCREENSHOTS_DIR)) mkdirSync(SCREENSHOTS_DIR, { recursive: true });
  const path = `${SCREENSHOTS_DIR}/${jobId}_${label}_${Date.now()}.png`;
  try {
    await runBrowser(`screenshot "${path}"`);
    return existsSync(path) ? path : null;
  } catch {
    return null;
  }
}

export async function linkedInEasyApply(
  job: { id: string; url: string; company: string; title: string },
  application: { id: string; resume_version?: string },
  onStep: (step: ApplicationStep) => void
): Promise<ApplyResult> {
  const steps: ApplicationStep[] = [];
  let stepNum = 0;
  const fieldMatchers = buildFieldMatchers();

  try {
    // 1. Navigate to job page (safe — no shell interpolation)
    stepNum++;
    await runBrowser("connect 9222");
    await safeNavigate(job.url);
    await sleep(5000);
    const navStep: ApplicationStep = { stepNumber: stepNum, stepType: "navigate", stepStatus: "completed", pageUrl: job.url };
    steps.push(navStep);
    onStep(navStep);

    // 2. Click Easy Apply button
    stepNum++;
    const clickResult = await safeEval(
      "document.querySelector('button.jobs-apply-button, button[aria-label*=\"Easy Apply\"], .jobs-s-apply button')?.click(); true"
    );
    await sleep(3000);

    if (!clickResult.includes("true")) {
      const errStep: ApplicationStep = { stepNumber: stepNum, stepType: "click", stepStatus: "failed", error: "Easy Apply button not found" };
      steps.push(errStep);
      onStep(errStep);
      return { success: false, steps, error: "Easy Apply button not found" };
    }

    const clickStep: ApplicationStep = { stepNumber: stepNum, stepType: "click", stepStatus: "completed" };
    steps.push(clickStep);
    onStep(clickStep);

    // 3. Fill form pages (Easy Apply can have multiple pages)
    for (let page = 0; page < 10; page++) {
      stepNum++;
      await sleep(2000);

      // Check if we're on a confirmation page
      const isConfirmation = await safeEval(
        "document.querySelector('.artdeco-modal__content')?.innerText?.includes('submitted') || false"
      );
      if (isConfirmation.includes("true")) {
        const screenshot = await takeScreenshot("confirmation", job.id);
        const confStep: ApplicationStep = {
          stepNumber: stepNum, stepType: "verify_confirmation", stepStatus: "completed",
          screenshotPath: screenshot ?? undefined,
        };
        steps.push(confStep);
        onStep(confStep);
        return { success: true, steps, confirmationScreenshot: screenshot ?? undefined };
      }

      // Extract form fields (static script, no user data)
      const fieldsJson = await safeEval(EXTRACT_FIELDS_SCRIPT);
      let fields: Array<{ label: string; type: string; options: string[]; name: string }> = [];
      try {
        const jsonStart = fieldsJson.indexOf("[");
        if (jsonStart >= 0) fields = JSON.parse(fieldsJson.substring(jsonStart));
      } catch { /* empty */ }

      // Fill each field (write fill script to temp file to avoid shell injection)
      for (const field of fields) {
        const label = field.label.toLowerCase();

        // Check NEVER_FILL
        if (NEVER_FILL.some((nf) => label.includes(nf))) {
          logger.info({ label }, "Skipping salary field — escalation needed");
          const salaryStep: ApplicationStep = {
            stepNumber: stepNum, stepType: "fill_form", stepStatus: "skipped",
            error: "Salary field — requires manual input",
          };
          steps.push(salaryStep);
          onStep(salaryStep);
          return { success: false, steps, escalation: "unknown_field", error: `Salary field: ${field.label}` };
        }

        // Try to match field
        let answer: string | null = null;
        for (const [key, value] of Object.entries(fieldMatchers)) {
          if (label.includes(key)) {
            answer = typeof value === "function" ? value(field.options) : value;
            break;
          }
        }

        if (answer && field.name) {
          // Use safeEval to avoid shell injection from field.name
          const fillScript = `
            (function() {
              const el = document.querySelector('[name=' + ${JSON.stringify(JSON.stringify(field.name))} + ']');
              if (el) {
                el.value = ${JSON.stringify(answer)};
                el.dispatchEvent(new Event('input', {bubbles: true}));
                el.dispatchEvent(new Event('change', {bubbles: true}));
              }
            })()
          `;
          await safeEval(fillScript);
        }
      }

      // Upload resume via agent-browser file upload
      if (application.resume_version && existsSync(application.resume_version)) {
        await runBrowser(`upload "input[type=file]" "${application.resume_version}"`);
        await sleep(1000);
        // Dispatch events for React-based forms
        await safeEval(`
          (function() {
            const el = document.querySelector('input[type=file]');
            if (el) {
              el.dispatchEvent(new Event('input', {bubbles: true}));
              el.dispatchEvent(new Event('change', {bubbles: true}));
            }
          })()
        `);
      }

      // Take pre-submit screenshot
      await takeScreenshot(`page_${page}`, job.id);

      // Click Next or Submit
      const submitted = await safeEval(
        "const btn = document.querySelector('button[aria-label*=\"Submit\"], button[aria-label*=\"Review\"], footer button.artdeco-button--primary'); btn?.click(); btn?.innerText || ''"
      );

      const fillStep: ApplicationStep = {
        stepNumber: stepNum, stepType: "fill_form", stepStatus: "completed",
        formData: { fieldsCount: fields.length, submitted: submitted.slice(0, 50) },
      };
      steps.push(fillStep);
      onStep(fillStep);

      await sleep(3000);
    }

    return { success: false, steps, error: "Exceeded max form pages" };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.error({ error, jobId: job.id }, "LinkedIn Easy Apply failed");
    return { success: false, steps, error: msg };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

const EXTRACT_FIELDS_SCRIPT = `
(function() {
  const fields = [];
  document.querySelectorAll('.jobs-easy-apply-form-section__grouping, .fb-dash-form-element').forEach(g => {
    const label = g.querySelector('label, .fb-dash-form-element__label')?.innerText?.trim() || '';
    const input = g.querySelector('input, select, textarea');
    const options = Array.from(g.querySelectorAll('option, [role=option]')).map(o => o.innerText.trim());
    fields.push({
      label,
      type: input?.type || input?.tagName?.toLowerCase() || 'unknown',
      options,
      name: input?.name || ''
    });
  });
  return JSON.stringify(fields);
})()
`;
