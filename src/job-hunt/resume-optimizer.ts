/**
 * Resume optimization via hr-breaker subprocess.
 * Fallback: use base resume if optimization fails.
 */

import { spawn, execSync } from "child_process";
import { writeFileSync, mkdirSync, existsSync } from "fs";
import { logger } from "../utils/logger.js";

const HR_BREAKER_DIR = "/Users/yj/tools/hr-breaker";
const BASE_RESUME = "/Users/yj/job-hunt/resumes/base-resume.txt";
const GENERATED_DIR = "/Users/yj/job-hunt/resumes/generated";

export interface OptimizationResult {
  success: boolean;
  pdfPath: string | null;
  iterations: number;
  error?: string;
}

export async function optimizeResume(
  jobId: string,
  jobDescription: string,
  company: string,
  role: string
): Promise<OptimizationResult> {
  if (!existsSync(GENERATED_DIR)) mkdirSync(GENERATED_DIR, { recursive: true });

  const date = new Date().toISOString().slice(0, 10);
  const safeCompany = company.replace(/[^a-zA-Z0-9]/g, "_").slice(0, 30);
  const safeRole = role.replace(/[^a-zA-Z0-9]/g, "_").slice(0, 30);
  const outputPath = `${GENERATED_DIR}/${safeCompany}_${safeRole}_${date}.pdf`;

  // Write JD to temp file
  const jdPath = `/tmp/jd-${jobId}.txt`;
  writeFileSync(jdPath, jobDescription, "utf8");

  return new Promise((resolve) => {
    const proc = spawn("uv", ["run", "hr-breaker", "optimize", BASE_RESUME, jdPath, "--output", outputPath, "--debug"], {
      cwd: HR_BREAKER_DIR,
      env: { ...process.env },
      timeout: 300_000,
    });

    const chunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    proc.stdout.on("data", (d) => chunks.push(d));
    proc.stderr.on("data", (d) => errChunks.push(d));

    proc.on("close", (code) => {
      const stdout = Buffer.concat(chunks).toString("utf8");
      const stderr = Buffer.concat(errChunks).toString("utf8");

      if (code === 0 && existsSync(outputPath)) {
        // Extract text sidecar for validation
        const txtPath = outputPath.replace(/\.pdf$/i, ".txt");
        if (!existsSync(txtPath)) {
          try {
            execSync(`pdftotext "${outputPath}" "${txtPath}"`, { timeout: 30_000 });
          } catch {
            logger.warn({ outputPath }, "pdftotext failed — resume will submit without text validation");
          }
        }

        const iterMatch = stdout.match(/iteration[s]?\s*[:=]\s*(\d+)/i);
        resolve({
          success: true,
          pdfPath: outputPath,
          iterations: iterMatch ? parseInt(iterMatch[1]!) : 1,
        });
      } else {
        logger.warn({ code, stderr: stderr.slice(0, 300) }, "hr-breaker failed");
        resolve({
          success: false,
          pdfPath: null,
          iterations: 0,
          error: stderr.slice(0, 200) || `Exit code ${code}`,
        });
      }
    });

    proc.on("error", (err) => {
      resolve({
        success: false,
        pdfPath: null,
        iterations: 0,
        error: err.message,
      });
    });
  });
}

/**
 * Get base resume path for fallback.
 */
export function getBaseResumePath(): string {
  return BASE_RESUME;
}
