import { NextRequest, NextResponse } from 'next/server';
import axios from 'axios';
import { chatCompletion } from '@/lib/openai';

export const maxDuration = 300;

const COLLEGUE_SYSTEM_WORDS = /\b(student|system|ERP|SIS|Banner|registration|HR|finance|payroll|portal|information)\b/i;

/** Step 1: Detect legacy references. Returns snippets that reference CougarWeb or Colleague in a system sense. */
function findLegacySnippets(html: string, text: string): Array<{ snippet: string; offset: number }> {
  const results: Array<{ snippet: string; offset: number }> = [];
  const normalized = text;

  // Hard matches (case-insensitive): cougarweb, cougar web
  const cougarRegex = /\b(cougar\s*web|cougarweb)\b/gi;
  let m;
  while ((m = cougarRegex.exec(normalized)) !== null) {
    const start = Math.max(0, m.index - 80);
    const end = Math.min(normalized.length, m.index + 120);
    const snippet = normalized.slice(start, end).replace(/\s+/g, ' ').trim();
    if (snippet.length > 20 && !results.some((r) => r.snippet === snippet)) {
      results.push({ snippet, offset: m.index });
    }
  }

  // Colleague when near system-related words (ignore plain "consult your colleague")
  const colleagueRegex = /\bcolleague\b/gi;
  while ((m = colleagueRegex.exec(normalized)) !== null) {
    const windowStart = Math.max(0, m.index - 100);
    const windowEnd = Math.min(normalized.length, m.index + 100);
    const window = normalized.slice(windowStart, windowEnd);
    if (COLLEGUE_SYSTEM_WORDS.test(window)) {
      const snippet = window.replace(/\s+/g, ' ').trim();
      if (snippet.length > 20 && !results.some((r) => r.snippet === snippet)) {
        results.push({ snippet, offset: m.index });
      }
    }
  }

  return results;
}

async function fetchPageContent(url: string): Promise<{ html: string; text: string; title: string } | null> {
  try {
    const response = await axios.get(url, {
      timeout: 20000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; Workday Website Scanner)',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
      maxRedirects: 10,
      validateStatus: (status) => status < 500,
    });

    if (!response?.data) return null;
    const html = typeof response.data === 'string' ? response.data : JSON.stringify(response.data);

    const text = html
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .substring(0, 30000);

    const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
    const title = titleMatch ? titleMatch[1].trim() : '';

    return { html, text, title };
  } catch {
    return null;
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { urls, keywords = [], workStreamAreas = [] } = body;

    if (!urls || !Array.isArray(urls) || urls.length === 0) {
      return NextResponse.json(
        { success: false, error: 'urls array is required' },
        { status: 400 }
      );
    }

    if (urls.length > 500) {
      return NextResponse.json(
        { success: false, error: 'Maximum 500 URLs per request' },
        { status: 400 }
      );
    }

    const results: Array<{
      url: string;
      pageTitle: string;
      hasLegacyReferences: boolean;
      findings: Array<{
        html_context: string;
        primary_audience: string;
        task_category: string;
        reference_type: string;
        workday_feature: string;
        proposed_replacement: string;
        suggested_keywords: string[];
        confidence: 'high' | 'medium' | 'low';
        notes?: string;
      }>;
    }> = [];

    for (const url of urls) {
      const pageContent = await fetchPageContent(url);
      if (!pageContent) {
        results.push({
          url,
          pageTitle: '',
          hasLegacyReferences: false,
          findings: [],
        });
        continue;
      }

      const snippets = findLegacySnippets(pageContent.html, pageContent.text);
      if (snippets.length === 0) {
        results.push({
          url,
          pageTitle: pageContent.title,
          hasLegacyReferences: false,
          findings: [],
        });
        continue;
      }

      const findings: Array<{
        html_context: string;
        primary_audience: string;
        task_category: string;
        reference_type: string;
        workday_feature: string;
        proposed_replacement: string;
        suggested_keywords: string[];
        confidence: 'high' | 'medium' | 'low';
        notes?: string;
      }> = [];

      const workStreamHint =
        workStreamAreas?.length > 0
          ? `The college provided these work stream areas to consider: ${workStreamAreas.join(', ')}.`
          : '';
      const keywordHint =
        keywords?.length > 0 ? `Additional keywords to consider: ${keywords.join(', ')}.` : '';

      for (const { snippet } of snippets) {
        const prompt = `You are analyzing college web content for a Workday migration. The college is moving from CougarWeb and Colleague to Workday.

${workStreamHint}
${keywordHint}

RULES:
1. Use ONLY the page content provided. Do not invent URLs or internal feature names.
2. Map legacy terms (CougarWeb, Colleague, "student portal," etc.) to Workday or Workday features only when clearly inferable.
3. If context is unclear, use generic "Workday" and set confidence to "low".

STEP 1 – Detect: The following snippet has already been flagged as containing a CougarWeb or Colleague reference. Confirm it is a SYSTEM reference (not plain English "colleague").

STEP 2 – Classify:
- primary_audience: one of "students" | "employees/faculty/staff" | "mixed/other" (use lexical cues: student, enrollment, financial aid, employee, payroll, HR, etc.)
- task_category: one of "registration_and_academic_planning" | "grades_transcripts_and_records" | "student_finance_and_aid" | "general_student_portal_access" | "hr_time_payroll" | "employee_self_service_other" | "administrative_reporting_and_advising" | "generic_system_reference"
- reference_type: one of "action_portal" | "informational_reference" | "historical_reference"

STEP 3 – Map to Workday using the mapping table (e.g. registration + students → "Workday Student – academic planning and registration"). Emit workday_feature and set confidence: "high" | "medium" | "low".

STEP 4 – Rewrite: Provide proposed_replacement (full suggested replacement text for the snippet, before/after style). Preserve intent and tone. No fabricated URLs.

STEP 5 – Suggest 3–6 Workday keywords for SEO (include "Workday", task and audience).

STEP 6 – If unsure, use generic "Workday is the college's new system for managing your information and services" and confidence "low" with brief notes.

Snippet to analyze:
"""
${snippet}
"""

Respond with ONLY a single JSON object (no markdown, no other text):
{
  "primary_audience": "students" | "employees/faculty/staff" | "mixed/other",
  "task_category": "one of the task_category values above",
  "reference_type": "action_portal" | "informational_reference" | "historical_reference",
  "workday_feature": "short label e.g. Workday Student – academic planning and registration",
  "proposed_replacement": "full replacement text for the snippet",
  "suggested_keywords": ["Workday", "keyword2", ...],
  "confidence": "high" | "medium" | "low",
  "notes": "optional brief note if low confidence"
}`;

        try {
          const response = await chatCompletion(
            [{ role: 'user', content: prompt }],
            undefined,
            { temperature: 0.2 }
          );

          const jsonMatch = response.match(/\{[\s\S]*\}/);
          if (jsonMatch) {
            const parsed = JSON.parse(jsonMatch[0]);
            findings.push({
              html_context: snippet,
              primary_audience: parsed.primary_audience || 'mixed/other',
              task_category: parsed.task_category || 'generic_system_reference',
              reference_type: parsed.reference_type || 'informational_reference',
              workday_feature: parsed.workday_feature || 'Workday – unified cloud-based system',
              proposed_replacement: parsed.proposed_replacement || snippet,
              suggested_keywords: Array.isArray(parsed.suggested_keywords) ? parsed.suggested_keywords : ['Workday'],
              confidence: ['high', 'medium', 'low'].includes(parsed.confidence) ? parsed.confidence : 'low',
              notes: parsed.notes,
            });
          } else {
            findings.push({
              html_context: snippet,
              primary_audience: 'mixed/other',
              task_category: 'generic_system_reference',
              reference_type: 'informational_reference',
              workday_feature: 'Workday – unified cloud-based system',
              proposed_replacement: snippet.replace(/\b(cougar\s*web|cougarweb|colleague)\b/gi, 'Workday'),
              suggested_keywords: ['Workday'],
              confidence: 'low',
              notes: 'AI response could not be parsed',
            });
          }
        } catch (err) {
          findings.push({
            html_context: snippet,
            primary_audience: 'mixed/other',
            task_category: 'generic_system_reference',
            reference_type: 'informational_reference',
            workday_feature: 'Workday – unified cloud-based system',
            proposed_replacement: snippet.replace(/\b(cougar\s*web|cougarweb|colleague)\b/gi, 'Workday'),
            suggested_keywords: ['Workday'],
            confidence: 'low',
            notes: err instanceof Error ? err.message : 'Analysis failed',
          });
        }
      }

      results.push({
        url,
        pageTitle: pageContent.title,
        hasLegacyReferences: true,
        findings,
      });
    }

    return NextResponse.json({ success: true, results });
  } catch (error) {
    console.error('[Analyze]', error);
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to analyze websites',
      },
      { status: 500 }
    );
  }
}
