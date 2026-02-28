/**
 * Cover letter generation using Gemini Flash API.
 */

import { writeFileSync, mkdirSync, existsSync } from "fs";
import { geminiUrl } from "./config.js";
import { logger } from "../utils/logger.js";

const COVER_LETTERS_DIR = "/Users/yj/job-hunt/cover-letters";

export interface CoverLetterResult {
  content: string;
  filePath: string;
}

export async function generateCoverLetter(
  company: string,
  role: string,
  jobDescription: string,
  matchAnalysis: string
): Promise<CoverLetterResult | null> {
  const apiKey = process.env.GEMINI_API_KEY_Primary || process.env.GEMINI_API_KEY;
  if (!apiKey) {
    logger.warn("No GEMINI_API_KEY_Primary, skipping cover letter");
    return null;
  }

  const prompt = `Write a concise, professional cover letter for Yanqing Jiang applying to ${role} at ${company}.

Key profile:
- 10+ years experience, currently at P&G
- $450MM+ quantified business impact across ML pipelines, data platforms, analytics
- Full-stack data: Python/SQL/Spark + production ML + data engineering
- US citizen, Army veteran
- Building production LLM systems (personal AI assistant project)
- Based in Seattle area

Match analysis: ${matchAnalysis}

Job Description (excerpt):
${jobDescription.slice(0, 3000)}

Requirements:
- 3-4 paragraphs max
- Opening hook tied to company/role
- Body: 2-3 specific achievements from profile that align with JD
- Close: enthusiasm + next steps
- Professional but not generic — show personality
- No filler phrases like "I am writing to express my interest"

Output the cover letter text only, no metadata.`;

  try {
    const resp = await fetch(
      geminiUrl(),
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.7, maxOutputTokens: 65536 },
        }),
      }
    );

    if (!resp.ok) {
      logger.warn({ status: resp.status }, "Cover letter generation failed");
      return null;
    }

    const data = (await resp.json()) as any;
    const content = data?.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
    if (!content || content.length < 100) return null;

    if (!existsSync(COVER_LETTERS_DIR)) mkdirSync(COVER_LETTERS_DIR, { recursive: true });
    const date = new Date().toISOString().slice(0, 10);
    const safe = (s: string) => s.replace(/[^a-zA-Z0-9]/g, "_").slice(0, 30);
    const filePath = `${COVER_LETTERS_DIR}/${safe(company)}_${safe(role)}_${date}.md`;
    writeFileSync(filePath, content, "utf8");

    return { content, filePath };
  } catch (error) {
    logger.warn({ error }, "Cover letter generation error");
    return null;
  }
}
