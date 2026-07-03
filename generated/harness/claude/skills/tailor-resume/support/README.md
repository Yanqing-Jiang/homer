# tailor-resume — Quickstart

A shared Homer skill that produces ATS-safe, LLM-aware, anti-fabrication resumes and cover letters for Yanqing Jiang from a pasted job description.

> **Note:** This used to be a Claude-only slash command + skill pair. The shared `SKILL.md` now contains the workflow, do's, and don'ts, with supporting prompts, templates, and ground-truth YAML in this directory.

## Status: v0.1 — prompts + ground-truth scaffolded

**What works now:**
- Skill/command entry: `tailor-resume`.
- Full workflow encoded in the generated `SKILL.md`: JD decomposition → company research → fit analysis (with gap interview) → tailoring → cover letter → self-critique.
- All 5 prompts populated under `prompts/`.
- Ground-truth YAML populated with Yanqing's current resume + `derived_claims` allowlist.
- Markdown templates for resume + cover letter ready for Pandoc rendering.
- Research-derived do's and don'ts encoded directly in the shared skill file and as a reference card in `templates/research-do-donts.md`.

**What's deferred to v1.0:**
- Python validation scripts (`validate_truth.py`, `validate_docx.py`).
- Pandoc rendering script (`render_docx.py`).
- ATS-parse round-trip test (`validate_ats_parse.py`).
- python-docx fallback renderer.

**What's deferred to v1.1:**
- AI-detection API gate (Originality.ai / Copyleaks).
- Auto-bootstrap from master `.docx` (`bootstrap_from_docx.py`).
- LinkedIn alignment output.
- Application tracking SQLite.
- Cover-letter A/B variant generation.

---

## How to test v0.1 today

1. **Make sure your master resume is up to date.** The fit-analysis step will surface gaps; if you have experience not on your current resume, this is the moment to add it.
2. **Add your LinkedIn URL** to `ground-truth/master-resume.yaml` (currently `null` — TODO marker is in the file).
3. **Open a fresh agent session** and run:
   ```
   /tailor-resume company="Spotify" role="Senior Data Scientist, Recommendations"
   ```
   then paste the JD on the next line.
4. **Expect the fit-analysis step to ask 1-3 targeted questions** about gaps in your resume coverage of the JD. Answer specifically.
5. **Review the JSON outputs** the skill produces — those are the audit trail.
6. **Convert the Markdown outputs to DOCX manually** for v0.1 (until the renderer ships):
   ```bash
   pandoc tailored-resume.md -o tailored-resume.docx \
     --reference-doc=support/templates/reference.docx
   ```

---

## Files

```
support/
├── README.md                              # this file
├── ground-truth/
│   └── master-resume.yaml                 # SOURCE OF TRUTH for all claims
├── prompts/
│   ├── jd-decomposition.md
│   ├── company-research.md
│   ├── fit-analysis.md                    # gap interview — KEY for Yanqing
│   ├── tailoring.md
│   ├── cover-letter.md
│   └── self-critique.md
├── templates/
│   ├── resume.md.j2
│   ├── cover-letter.md.j2
│   ├── research-do-donts.md               # research-backed reference card
│   └── reference.docx
├── scripts/
└── outputs/                               # or use per-app folder under ~/Desktop
```

---

## TODOs to complete v0.1 (5 minutes of manual work)

1. ❑ Create `templates/reference.docx` — a blank Word doc with Calibri 10.5pt body, 12pt bold headings, 0.65" margins, single column, no header/footer. Save to that path.
2. ❑ Add LinkedIn URL to `ground-truth/master-resume.yaml`.
3. ❑ Confirm Murray State University degree status in `ground-truth/master-resume.yaml`.
4. ❑ Optionally: add GitHub / personal-site URL.

---

## Maintenance

When your experience changes, edit `ground-truth/master-resume.yaml` directly. The fit-analysis step (Step 4 of the workflow) is the canonical place to surface and add new facts when a JD reveals coverage gaps you can fill with real experience.

---

## Source research

All research underlying the do's, don'ts, and architectural decisions:
- `~/homer/output/gemini/ats-landscape-2026-2026-05-01-1500.md`
- `~/homer/output/gemini/resume-tactics-2026-2026-05-01-1518.md`
- `~/homer/output/gemini/github-counter-ats-tools-2026-05-01-1200.md`
- `~/homer/output/kimi/llm-screening-tools-2026-05-01-1510.md`
- `~/homer/output/kimi/jd-tailoring-workflows-2026-05-01-1510.md`
- `~/homer/output/codex/skills-md-architecture-2026-05-01-1525.md`
- `~/homer/output/kimi/skills-md-redteam-2026-05-01-1540.md`
