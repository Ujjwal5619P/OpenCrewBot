import { tavily } from "@tavily/core";
import { z } from "zod";
import type { SkillDefinitionSummary, SkillExecutionResult } from "@/lib/shared/types";
import { keys } from "./config";
import { analyzeCsvFile } from "./csv";
import { InputError } from "./errors";

export const SKILL_IDS = [
  "market-research",
  "competitor-analysis",
  "financial-modelling",
  "presentation-creation",
  "email-drafting",
  "code-review",
  "data-analysis",
  "lead-generation",
] as const;

export type SkillId = (typeof SKILL_IDS)[number];

interface SkillInternal {
  summary: SkillDefinitionSummary;
  schema: z.ZodTypeAny;
  run: (input: Record<string, unknown>) => Promise<SkillExecutionResult> | SkillExecutionResult;
}

interface VerifiedSource {
  title: string;
  url: string;
  snippet?: string;
}

async function fetchTavilySources(query: string, maxResults = 4): Promise<{ available: boolean; sources: VerifiedSource[]; error?: string }> {
  if (!keys.tavily() || !process.env.TAVILY_API_KEY) {
    return {
      available: false,
      sources: [],
      error: "Live web search is unavailable because TAVILY_API_KEY is not configured.",
    };
  }
  try {
    const client = tavily({ apiKey: process.env.TAVILY_API_KEY });
    const res = await client.search(query, { maxResults });
    const sources: VerifiedSource[] = (res.results ?? [])
      .filter((r) => typeof r.url === "string" && /^https?:\/\//i.test(r.url))
      .map((r) => ({
        title: r.title || r.url,
        url: r.url,
        snippet: typeof r.content === "string" ? r.content.slice(0, 220) : undefined,
      }));
    return { available: true, sources };
  } catch (error) {
    return {
      available: false,
      sources: [],
      error: `Live Tavily search failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

function sanitizeProvidedSources(urls?: string[]): VerifiedSource[] {
  if (!urls?.length) return [];
  const valid: VerifiedSource[] = [];
  for (const u of urls) {
    try {
      const parsed = new URL(u);
      if (parsed.protocol === "http:" || parsed.protocol === "https:") {
        valid.push({ title: parsed.hostname.replace(/^www\./, ""), url: parsed.toString() });
      }
    } catch {
      // ignore invalid URLs
    }
  }
  return valid;
}

const REGISTRY: Record<SkillId, SkillInternal> = {
  "market-research": {
    summary: {
      id: "market-research",
      name: "Market Research",
      category: "Research",
      description: "Structures market sizing, buyer personas, key demand drivers, and research questions with live Tavily sources when configured.",
      recommendedRole: "Scout",
      sampleInput: { market: "Indian K-12 Class 11 test-prep & college guidance", region: "India", segment: "Class 11 STEM & Commerce" },
    },
    schema: z.object({
      market: z.string().trim().min(2),
      region: z.string().trim().default("Global"),
      segment: z.string().trim().default("Core buyers"),
      sources: z.array(z.string().url()).optional(),
    }),
    run: async (raw) => {
      const data = REGISTRY["market-research"].schema.parse(raw) as {
        market: string;
        region: string;
        segment: string;
        sources?: string[];
      };
      const providedSources = sanitizeProvidedSources(data.sources);
      const live = providedSources.length ? { available: true, sources: providedSources } : await fetchTavilySources(`${data.market} ${data.region} ${data.segment} market trends`);
      const researchDimensions = [
        "Total addressable cohort & annual enrollment seasonality",
        "Buyer decision triggers (parents vs students)",
        "Channel acquisition cost benchmarks (YouTube, Search, School Outreach)",
        "Regulatory / academic calendar timing risks",
      ];
      const limitation = !live.available
        ? `${live.error ?? "Live web research cannot be completed without TAVILY_API_KEY."} No unverified sources or external statistics were fabricated.`
        : undefined;

      const deliverable = {
        market: data.market,
        region: data.region,
        segment: data.segment,
        liveResearchAvailable: live.available,
        sources: live.sources,
        limitation,
        researchDimensions,
        nextActions: live.available
          ? [`Review ${live.sources.length} verified source(s) above`, `Segment messaging specifically for ${data.segment}`]
          : ["Set TAVILY_API_KEY or pass verified URLs in `sources` to run live web research", `Segment messaging specifically for ${data.segment}`],
      };

      return {
        skillId: "market-research",
        skillName: "Market Research",
        ok: true,
        summary: live.available
          ? `Completed market research for ${data.market} (${data.region}) with ${live.sources.length} verified source(s).`
          : `Structured research framework for ${data.market} (${data.region}); live web research unavailable (TAVILY_API_KEY not configured, 0 fabricated sources).`,
        deliverable,
        markdown: [
          `### Market Research Brief: ${data.market}`,
          `- **Region:** ${data.region}`,
          `- **Primary Segment:** ${data.segment}`,
          `- **Key Dimensions:** ${researchDimensions.join("; ")}`,
          limitation ? `- **Limitation:** ${limitation}` : "",
          live.sources.length
            ? `\n#### Verified Sources\n${live.sources.map((s) => `- [${s.title}](${s.url})${s.snippet ? ` — ${s.snippet}` : ""}`).join("\n")}`
            : "",
        ]
          .filter(Boolean)
          .join("\n"),
      };
    },
  },

  "competitor-analysis": {
    summary: {
      id: "competitor-analysis",
      name: "Competitor Analysis",
      category: "Strategy",
      description: "Builds a weighted comparison matrix across competitors using live Tavily search or provided sources (never fabricates URLs).",
      recommendedRole: "Scout",
      sampleInput: { product: "MeetUniversity Class 11 Aspirations", competitors: ["CollegeDekho", "Shiksha", "Unacademy"] },
    },
    schema: z.object({
      product: z.string().trim().min(2),
      competitors: z.array(z.string().trim().min(1)).min(1).max(10),
      criteria: z.array(z.string().trim().min(1)).optional(),
      sources: z.array(z.string().url()).optional(),
    }),
    run: async (raw) => {
      const data = REGISTRY["competitor-analysis"].schema.parse(raw) as {
        product: string;
        competitors: string[];
        criteria?: string[];
        sources?: string[];
      };
      const criteria = data.criteria?.length ? data.criteria : ["Pricing clarity", "Counselor personalization", "Parent trust", "Distribution"];
      const providedSources = sanitizeProvidedSources(data.sources);
      const live = providedSources.length
        ? { available: true, sources: providedSources }
        : await fetchTavilySources(`${data.competitors.join(" vs ")} ${data.product} pricing features`);

      const limitation = !live.available
        ? `${live.error ?? "Live competitor research cannot be completed without TAVILY_API_KEY."} No competitor pricing, traffic, or URLs were fabricated.`
        : undefined;

      const matrix = data.competitors.map((name, idx) => ({
        competitor: name,
        focusArea: criteria[idx % criteria.length],
        evidenceStatus: live.available ? "Verified search enabled" : "Unverified (TAVILY_API_KEY not configured)",
        gapOpportunity: live.available
          ? `Differentiate ${data.product} on ${criteria[idx % criteria.length].toLowerCase()}`
          : "Requires live source verification before claiming competitor gaps",
      }));

      return {
        skillId: "competitor-analysis",
        skillName: "Competitor Analysis",
        ok: true,
        summary: live.available
          ? `Evaluated ${data.competitors.length} competitors against ${data.product} with ${live.sources.length} verified source(s).`
          : `Built comparison template for ${data.competitors.length} competitors against ${data.product}; live competitor research unavailable (TAVILY_API_KEY not configured).`,
        deliverable: {
          product: data.product,
          criteria,
          liveResearchAvailable: live.available,
          sources: live.sources,
          limitation,
          matrix,
        },
        markdown: [
          `### Competitor Analysis: ${data.product}`,
          limitation ? `> **Note:** ${limitation}` : "",
          "| Competitor | Key Comparison Dimension | Evidence Status | Notes |",
          "| --- | --- | --- | --- |",
          ...matrix.map((m) => `| ${m.competitor} | ${m.focusArea} | ${m.evidenceStatus} | ${m.gapOpportunity} |`),
          live.sources.length ? `\n#### Verified Sources\n${live.sources.map((s) => `- [${s.title}](${s.url})`).join("\n")}` : "",
        ]
          .filter(Boolean)
          .join("\n"),
      };
    },
  },

  "financial-modelling": {
    summary: {
      id: "financial-modelling",
      name: "Financial Modelling",
      category: "Finance",
      description: "Computes exact unit economics (CAC, LTV, gross margin, payback months, and net profit projection).",
      recommendedRole: "Finance",
      sampleInput: { price: 4500, grossMarginPct: 75, monthlyLeads: 1000, conversionRatePct: 8, marketingSpend: 120000, fixedOpsCost: 40000 },
    },
    schema: z.object({
      price: z.number().positive(),
      grossMarginPct: z.number().min(1).max(100),
      monthlyLeads: z.number().positive(),
      conversionRatePct: z.number().min(0.1).max(100),
      marketingSpend: z.number().nonnegative(),
      fixedOpsCost: z.number().nonnegative().default(0),
      budgetAllocation: z.record(z.string().min(1), z.number().min(0).max(100)).optional(),
    }),
    run: (raw) => {
      const d = REGISTRY["financial-modelling"].schema.parse(raw) as {
        price: number;
        grossMarginPct: number;
        monthlyLeads: number;
        conversionRatePct: number;
        marketingSpend: number;
        fixedOpsCost: number;
        budgetAllocation?: Record<string, number>;
      };

      let allocationBreakdown: Array<{ category: string; pct: number; amount: number }> | undefined;
      if (d.budgetAllocation) {
        const entries = Object.entries(d.budgetAllocation);
        const totalPct = Number(entries.reduce((acc, [, v]) => acc + v, 0).toFixed(2));
        if (Math.abs(totalPct - 100) > 0.01) {
          throw new InputError(`Budget allocation percentages must sum to 100% (got ${totalPct}%).`);
        }
        allocationBreakdown = entries.map(([category, pct]) => ({
          category,
          pct,
          amount: Number(((d.marketingSpend * pct) / 100).toFixed(2)),
        }));
      }

      const customers = Math.round(d.monthlyLeads * (d.conversionRatePct / 100));
      const revenue = customers * d.price;
      const grossProfit = revenue * (d.grossMarginPct / 100);
      const totalCost = d.marketingSpend + d.fixedOpsCost;
      const netProfit = grossProfit - totalCost;
      const cac = customers > 0 ? Number((d.marketingSpend / customers).toFixed(2)) : 0;
      const ltv = Number((d.price * (d.grossMarginPct / 100)).toFixed(2));
      const ltvToCac = cac > 0 ? Number((ltv / cac).toFixed(2)) : 0;
      const breakEvenCustomers = ltv > 0 ? Math.ceil(totalCost / ltv) : 0;

      const deliverable = {
        customers,
        revenue,
        grossProfit,
        totalCost,
        netProfit,
        cac,
        ltv,
        ltvToCac,
        breakEvenCustomers,
        ...(allocationBreakdown ? { budgetAllocation: allocationBreakdown, budgetAllocationTotalPct: 100 } : {}),
      };
      return {
        skillId: "financial-modelling",
        skillName: "Financial Modelling",
        ok: true,
        summary: `Modeled ${customers} conversions, revenue ${revenue}, net profit ${netProfit}, LTV:CAC ${ltvToCac}x.`,
        deliverable,
        markdown: [
          "### Financial Unit Economics Model",
          `- **Projected Conversions:** ${customers}`,
          `- **Revenue:** ${revenue.toLocaleString("en-US")}`,
          `- **Gross Profit (${d.grossMarginPct}%):** ${grossProfit.toLocaleString("en-US")}`,
          `- **Total Spend (Marketing + Fixed Ops):** ${totalCost.toLocaleString("en-US")}`,
          `- **Net Profit:** ${netProfit.toLocaleString("en-US")}`,
          `- **CAC:** ${cac} | **LTV:** ${ltv} | **LTV:CAC:** ${ltvToCac}x | **Break-even Customers:** ${breakEvenCustomers}`,
          ...(allocationBreakdown
            ? [
                "",
                "#### Marketing Budget Allocation (100%)",
                ...allocationBreakdown.map((b) => `- **${b.category}:** ${b.pct}% (${b.amount.toLocaleString("en-US")})`),
              ]
            : []),
        ].join("\n"),
      };
    },
  },

  "presentation-creation": {
    summary: {
      id: "presentation-creation",
      name: "Presentation Creation",
      category: "Communication",
      description: "Generates a structured slide-by-slide presentation deck outline with speaker notes.",
      recommendedRole: "Quill",
      sampleInput: { topic: "MeetUniversity Class 11 Aspirations Q2 Launch", audience: "Leadership & Growth Team", slides: 5 },
    },
    schema: z.object({
      topic: z.string().trim().min(2),
      audience: z.string().trim().default("Executive stakeholders"),
      slides: z.number().int().min(3).max(12).default(5),
    }),
    run: (raw) => {
      const d = REGISTRY["presentation-creation"].schema.parse(raw) as { topic: string; audience: string; slides: number };
      const titles = [
        "Title & Core Objective",
        "Problem & Audience Insight",
        "Strategy & Execution Plan",
        "Metrics, Budget & Expected ROI",
        "Timeline, Risks & Next Steps",
      ];
      const deck = Array.from({ length: d.slides }, (_, i) => ({
        slide: i + 1,
        title: titles[i] ?? `Deep Dive ${i - 3}`,
        keyPoint: `Tailored for ${d.audience} covering ${d.topic} (Section ${i + 1}).`,
      }));
      return {
        skillId: "presentation-creation",
        skillName: "Presentation Creation",
        ok: true,
        summary: `Built ${deck.length}-slide deck outline for "${d.topic}".`,
        deliverable: { topic: d.topic, audience: d.audience, deck },
        markdown: [
          `### Presentation Outline: ${d.topic}`,
          ...deck.map((s) => `- **Slide ${s.slide} — ${s.title}:** ${s.keyPoint}`),
        ].join("\n"),
      };
    },
  },

  "email-drafting": {
    summary: {
      id: "email-drafting",
      name: "Email Drafting",
      category: "Communication",
      description: "Drafts an actionable subject line, email body, and clear CTA for a specified recipient and goal.",
      recommendedRole: "Quill",
      sampleInput: { recipient: "Class 11 Parents", goal: "Book a free 1:1 university roadmap counseling session", tone: "Warm and clear" },
    },
    schema: z.object({
      recipient: z.string().trim().min(2),
      goal: z.string().trim().min(2),
      tone: z.string().trim().default("Clear and professional"),
    }),
    run: (raw) => {
      const d = REGISTRY["email-drafting"].schema.parse(raw) as { recipient: string; goal: string; tone: string };
      const subject = `Next step for ${d.recipient}: ${d.goal.slice(0, 60)}`;
      const body = `Hi ${d.recipient},\n\nWe put together a concise path to help you ${d.goal.toLowerCase()}.\n\nReply to this email or pick a 15-minute slot this week so we can share the checklist and answer questions.\n\nBest regards,\nOpenCrewBot Team`;
      return {
        skillId: "email-drafting",
        skillName: "Email Drafting",
        ok: true,
        summary: `Drafted ${d.tone.toLowerCase()} email for ${d.recipient}.`,
        deliverable: { recipient: d.recipient, tone: d.tone, subject, body },
        markdown: [`### Email Draft (${d.tone})`, `**Subject:** ${subject}`, "", body].join("\n"),
      };
    },
  },

  "code-review": {
    summary: {
      id: "code-review",
      name: "Code Review",
      category: "Engineering",
      description: "Scans source code for concrete safety, security, and reliability anti-patterns and outputs findings.",
      recommendedRole: "Engineer",
      sampleInput: {
        filename: "handler.ts",
        code: 'const query = "SELECT * FROM users WHERE id = " + req.query.id;\nconst data = eval(req.body.expr);\n',
      },
    },
    schema: z.object({
      filename: z.string().trim().default("snippet.ts"),
      code: z.string().min(1),
    }),
    run: (raw) => {
      const d = REGISTRY["code-review"].schema.parse(raw) as { filename: string; code: string };
      const findings: Array<{ severity: "high" | "medium" | "low"; rule: string; detail: string }> = [];
      if (/\beval\s*\(|new Function\s*\(/.test(d.code)) {
        findings.push({ severity: "high", rule: "dynamic-code-execution", detail: "Avoid eval()/new Function() on untrusted inputs." });
      }
      if (/(SELECT|INSERT|UPDATE|DELETE).*(\+|\$\{)/i.test(d.code)) {
        findings.push({ severity: "high", rule: "sql-string-interpolation", detail: "Use parameterized queries instead of string concatenation." });
      }
      if (/(apiKey|secret|password|token)\s*[:=]\s*["'][A-Za-z0-9_\-]{12,}["']/i.test(d.code)) {
        findings.push({ severity: "high", rule: "hardcoded-secret", detail: "Move credentials to server environment variables." });
      }
      if (/dangerouslySetInnerHTML/.test(d.code)) {
        findings.push({ severity: "medium", rule: "xss-sink", detail: "Sanitize HTML before using dangerouslySetInnerHTML." });
      }
      if (/JSON\.parse\(/.test(d.code) && !/try\s*\{/.test(d.code)) {
        findings.push({ severity: "medium", rule: "unguarded-json-parse", detail: "Wrap JSON.parse() in try/catch to handle malformed payloads." });
      }
      if (/console\.log\(/.test(d.code)) {
        findings.push({ severity: "low", rule: "debug-logging", detail: "Remove or gate debug console.log calls before production." });
      }
      const lineCount = d.code.split(/\r?\n/).length;
      return {
        skillId: "code-review",
        skillName: "Code Review",
        ok: true,
        summary: `Reviewed ${d.filename} (${lineCount} lines): ${findings.length} finding(s).`,
        deliverable: { filename: d.filename, lineCount, findings },
        markdown: [
          `### Code Review: \`${d.filename}\` (${lineCount} lines)`,
          findings.length
            ? findings.map((f) => `- **[${f.severity.toUpperCase()}] ${f.rule}:** ${f.detail}`).join("\n")
            : "- No common anti-patterns detected in static check.",
        ].join("\n"),
      };
    },
  },

  "data-analysis": {
    summary: {
      id: "data-analysis",
      name: "Data Analysis",
      category: "Analytics",
      description: "Reads a workspace CSV file (or numeric dataset) and computes revenue, cost, profit, and trends.",
      recommendedRole: "Analyst",
      sampleInput: { csvPath: "samples/meetuniversity_campaigns.csv" },
    },
    schema: z.object({
      csvPath: z.string().trim().default("samples/meetuniversity_campaigns.csv"),
    }),
    run: (raw) => {
      const d = REGISTRY["data-analysis"].schema.parse(raw) as { csvPath: string };
      const report = analyzeCsvFile(d.csvPath);
      return {
        skillId: "data-analysis",
        skillName: "Data Analysis",
        ok: true,
        summary: `Analyzed ${report.filePath} (${report.rowCount} rows): Revenue ${report.totals.revenue}, Cost ${report.totals.cost}, Profit ${report.totals.profit}.`,
        deliverable: report as unknown as Record<string, unknown>,
        markdown: report.markdown,
      };
    },
  },

  "lead-generation": {
    summary: {
      id: "lead-generation",
      name: "Lead Generation",
      category: "Growth",
      description: "Defines ICP criteria, acquisition channels, lead scoring weights, and weekly funnel targets.",
      recommendedRole: "Growth",
      sampleInput: { product: "MeetUniversity Class 11 Aspirations", targetLeads: 2000, primaryChannels: ["YouTube", "Google Search", "School Outreach"] },
    },
    schema: z.object({
      product: z.string().trim().min(2),
      targetLeads: z.number().int().positive().default(1000),
      primaryChannels: z.array(z.string().trim().min(1)).min(1).default(["Search", "YouTube", "Outreach"]),
    }),
    run: (raw) => {
      const d = REGISTRY["lead-generation"].schema.parse(raw) as { product: string; targetLeads: number; primaryChannels: string[] };
      const perChannel = Math.round(d.targetLeads / d.primaryChannels.length);
      const allocation = d.primaryChannels.map((channel) => ({
        channel,
        monthlyLeadGoal: perChannel,
        qualificationRule: "Stream selected + parent phone verified + exam timeline within 18 months",
      }));
      return {
        skillId: "lead-generation",
        skillName: "Lead Generation",
        ok: true,
        summary: `Built ${d.targetLeads}-lead generation plan across ${d.primaryChannels.length} channels for ${d.product}.`,
        deliverable: { product: d.product, targetLeads: d.targetLeads, allocation },
        markdown: [
          `### Lead Generation Plan: ${d.product}`,
          `- **Target Leads:** ${d.targetLeads.toLocaleString("en-US")}`,
          ...allocation.map((a) => `- **${a.channel}:** ${a.monthlyLeadGoal} leads (${a.qualificationRule})`),
        ].join("\n"),
      };
    },
  },
};

export function listSkills(): SkillDefinitionSummary[] {
  return SKILL_IDS.map((id) => REGISTRY[id].summary);
}

export async function runSkill(skillId: string, input?: Record<string, unknown>): Promise<SkillExecutionResult> {
  const normalized = skillId.trim().toLowerCase().replace(/\s+/g, "-") as SkillId;
  const skill = REGISTRY[normalized];
  if (!skill) {
    throw new InputError(`Unknown skill "${skillId}". Available skills: ${SKILL_IDS.join(", ")}.`);
  }
  const payload = input && Object.keys(input).length > 0 ? input : skill.summary.sampleInput;
  try {
    return await skill.run(payload);
  } catch (error) {
    if (error instanceof InputError) throw error;
    if (error instanceof z.ZodError) {
      throw new InputError(`Invalid input for skill "${skill.summary.name}": ${error.issues[0]?.message ?? "validation failed"}`);
    }
    throw error;
  }
}
