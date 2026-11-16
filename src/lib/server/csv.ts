import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { DATA_DIR } from "./config";
import { InputError } from "./errors";

export interface CsvRowAnalysis {
  rowIndex: number;
  raw: Record<string, string>;
  revenue: number;
  cost: number;
  profit: number;
}

export interface CsvTrendPoint {
  period: string;
  rows: number;
  leads: number;
  conversions: number;
  revenue: number;
  cost: number;
  profit: number;
  profitDeltaFromPrev: number | null;
}

export interface CsvGroupBreakdown {
  group: string;
  revenue: number;
  cost: number;
  profit: number;
  marginPct: number;
  roas: number | null;
  leads: number;
  conversions: number;
  conversionRatePct: number;
}

export interface CsvAnalysisReport {
  filePath: string;
  rowCount: number;
  headers: string[];
  dataQuality: {
    missingValueCount: number;
    malformedRowCount: number;
  };
  totals: {
    leads: number;
    conversions: number;
    conversionRatePct: number;
    revenue: number;
    cost: number;
    profit: number;
    marginPct: number;
  };
  trends: CsvTrendPoint[];
  byGroup: CsvGroupBreakdown[];
  recommendations: string[];
  markdown: string;
}

function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === "," && !inQuotes) {
      out.push(cur.trim());
      cur = "";
    } else {
      cur += ch;
    }
  }
  out.push(cur.trim());
  return out;
}

/** Resolve a CSV path strictly inside the project's samples/ or data/ directories. */
export function resolveSafeCsvPath(requestedPath = "samples/meetuniversity_campaigns.csv"): string {
  const cleaned = requestedPath.trim() || "samples/meetuniversity_campaigns.csv";
  if (isAbsolute(cleaned)) throw new InputError("Use a relative path under samples/ or data/.");
  const samplesRoot = resolve(process.cwd(), "samples");
  const dataRoot = resolve(DATA_DIR);
  const candidate = resolve(/*turbopackIgnore: true*/ process.cwd(), cleaned);

  const inSamples = !relative(samplesRoot, candidate).startsWith("..") && !isAbsolute(relative(samplesRoot, candidate));
  const inData = !relative(dataRoot, candidate).startsWith("..") && !isAbsolute(relative(dataRoot, candidate));
  if (!inSamples && !inData) {
    throw new InputError("CSV access is restricted to files inside samples/ or data/.");
  }
  if (!existsSync(candidate)) {
    throw new InputError(`CSV file not found: ${cleaned}`);
  }
  return candidate;
}

export function listCsvFiles(): string[] {
  const results: string[] = [];
  const collect = (dir: string) => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (entry.name === "workspaces") continue;
        collect(join(dir, entry.name));
      } else if (entry.name.toLowerCase().endsWith(".csv")) {
        results.push(relative(process.cwd(), join(dir, entry.name)));
      }
    }
  };
  collect(resolve(process.cwd(), "samples"));
  collect(resolve(DATA_DIR));
  return results.sort();
}

export function saveUploadedCsv(filename: string, rawContent: string): { path: string; report: CsvAnalysisReport } {
  const safeBase = basename(filename || "upload.csv")
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .replace(/^_+|_+$/g, "");
  const finalName = safeBase.toLowerCase().endsWith(".csv") ? safeBase : `${safeBase || "upload"}.csv`;
  if (!rawContent || rawContent.includes("\0")) {
    throw new InputError("Invalid CSV file: file is empty or appears to be binary.");
  }
  const uploadDir = resolve(DATA_DIR, "uploads");
  mkdirSync(uploadDir, { recursive: true });
  const target = join(uploadDir, `${Date.now()}_${finalName}`);
  writeFileSync(target, rawContent, "utf8");
  const rel = relative(process.cwd(), target);
  try {
    const report = analyzeCsvFile(rel);
    return { path: rel, report };
  } catch (error) {
    throw error;
  }
}

function parseNumericCell(v: string | undefined): { value: number; missing: boolean } {
  if (v === undefined || v.trim() === "" || /^(n\/a|na|null|none|-)$/i.test(v.trim())) {
    return { value: 0, missing: true };
  }
  const n = Number(v.replace(/[₹$,%\s]/g, ""));
  if (!Number.isFinite(n)) return { value: 0, missing: true };
  return { value: n, missing: false };
}

export function analyzeCsvFile(requestedPath = "samples/meetuniversity_campaigns.csv"): CsvAnalysisReport {
  const fullPath = resolveSafeCsvPath(requestedPath);
  const rawBufferText = readFileSync(fullPath, "utf8");
  if (rawBufferText.includes("\0")) {
    throw new InputError("Invalid CSV file: binary content detected.");
  }
  const rawText = rawBufferText.trim();
  const lines = rawText.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) throw new InputError("CSV file must include a header row and at least one data row.");

  const headers = splitCsvLine(lines[0]).filter((h) => h.length > 0);
  if (headers.length < 2) {
    throw new InputError("Invalid CSV structure: expected at least 2 comma-separated columns in the header row.");
  }

  const revenueKeys = headers.filter((h) => /revenue|sales|income/i.test(h));
  const costKeys = headers.filter((h) => /cost|spend|expense/i.test(h));
  const periodKey = headers.find((h) => /month|date|period|week|quarter/i.test(h));
  const groupKey = headers.find((h) => /campaign|channel|segment|program|category|product/i.test(h));
  const leadsKey = headers.find((h) => /lead/i.test(h));
  const convKey = headers.find((h) => /conv|order|signup|sale/i.test(h));

  let totalRevenue = 0;
  let totalCost = 0;
  let totalLeads = 0;
  let totalConv = 0;
  let missingValueCount = 0;
  let malformedRowCount = 0;
  let numericCellsSeen = 0;

  const periodMap = new Map<string, { rows: number; leads: number; conversions: number; revenue: number; cost: number; profit: number }>();
  const groupMap = new Map<string, { revenue: number; cost: number; profit: number; leads: number; conversions: number }>();

  for (let i = 1; i < lines.length; i++) {
    const vals = splitCsvLine(lines[i]);
    if (vals.length !== headers.length) malformedRowCount += 1;

    const row: Record<string, string> = {};
    headers.forEach((h, idx) => {
      const cell = vals[idx] ?? "";
      if (cell.trim() === "") missingValueCount += 1;
      row[h] = cell;
    });

    // Check if any column contains parseable numbers so purely non-numeric text files are flagged
    for (const h of headers) {
      if (h === periodKey || h === groupKey) continue;
      const parsed = parseNumericCell(row[h]);
      if (!parsed.missing) numericCellsSeen += 1;
    }

    let revenue = 0;
    for (const k of revenueKeys) {
      const p = parseNumericCell(row[k]);
      revenue += p.value;
    }
    let cost = 0;
    for (const k of costKeys) {
      const p = parseNumericCell(row[k]);
      cost += p.value;
    }
    const profit = revenue - cost;
    const leads = leadsKey ? parseNumericCell(row[leadsKey]).value : 0;
    const conversions = convKey ? parseNumericCell(row[convKey]).value : 0;

    totalRevenue += revenue;
    totalCost += cost;
    totalLeads += leads;
    totalConv += conversions;

    const period = periodKey ? row[periodKey] || "Unknown" : "All";
    const p = periodMap.get(period) ?? { rows: 0, leads: 0, conversions: 0, revenue: 0, cost: 0, profit: 0 };
    p.rows += 1;
    p.leads += leads;
    p.conversions += conversions;
    p.revenue += revenue;
    p.cost += cost;
    p.profit += profit;
    periodMap.set(period, p);

    const group = groupKey ? row[groupKey] || "Other" : "All";
    const g = groupMap.get(group) ?? { revenue: 0, cost: 0, profit: 0, leads: 0, conversions: 0 };
    g.revenue += revenue;
    g.cost += cost;
    g.profit += profit;
    g.leads += leads;
    g.conversions += conversions;
    groupMap.set(group, g);
  }

  if (numericCellsSeen === 0) {
    throw new InputError("CSV file contains no parseable numeric metric columns to analyze.");
  }

  const sortedPeriods = [...periodMap.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  const trends: CsvTrendPoint[] = sortedPeriods.map(([period, val], idx) => ({
    period,
    ...val,
    profitDeltaFromPrev: idx === 0 ? null : val.profit - sortedPeriods[idx - 1][1].profit,
  }));

  const byGroup: CsvGroupBreakdown[] = [...groupMap.entries()]
    .map(([group, v]) => ({
      group,
      ...v,
      marginPct: v.revenue > 0 ? Number(((v.profit / v.revenue) * 100).toFixed(2)) : 0,
      roas: v.cost > 0 ? Number((v.revenue / v.cost).toFixed(2)) : null,
      conversionRatePct: v.leads > 0 ? Number(((v.conversions / v.leads) * 100).toFixed(2)) : 0,
    }))
    .sort((a, b) => b.profit - a.profit);

  const totalProfit = totalRevenue - totalCost;
  const marginPct = totalRevenue > 0 ? Number(((totalProfit / totalRevenue) * 100).toFixed(2)) : 0;
  const conversionRatePct = totalLeads > 0 ? Number(((totalConv / totalLeads) * 100).toFixed(2)) : 0;
  const relPath = relative(process.cwd(), fullPath);

  const recommendations: string[] = [];
  if (byGroup.length > 0) {
    const top = byGroup[0];
    recommendations.push(
      `Scale top-performing ${groupKey ?? "segment"} "${top.group}" (${top.profit.toLocaleString("en-US")} profit, ${top.marginPct}% margin${top.roas !== null ? `, ${top.roas}x ROAS` : ""}).`,
    );
    const weakest = byGroup[byGroup.length - 1];
    if (byGroup.length > 1 && weakest.group !== top.group) {
      recommendations.push(
        `Review or reallocate spend from "${weakest.group}" (${weakest.profit.toLocaleString("en-US")} profit, ${weakest.marginPct}% margin).`,
      );
    }
  }
  if (trends.length >= 2) {
    const first = trends[0];
    const last = trends[trends.length - 1];
    const diff = last.profit - first.profit;
    recommendations.push(
      `Net profit ${diff >= 0 ? "grew" : "declined"} by ${Math.abs(diff).toLocaleString("en-US")} from ${first.period} to ${last.period}.`,
    );
  }
  if (missingValueCount > 0) {
    recommendations.push(`Clean up ${missingValueCount} missing/blank cell(s) detected during ingestion (treated as 0 for sums).`);
  }

  const markdown = [
    `### CSV Analysis Report: \`${relPath}\` (${lines.length - 1} rows)`,
    `- **Total Revenue:** ${totalRevenue.toLocaleString("en-US")}`,
    `- **Total Cost:** ${totalCost.toLocaleString("en-US")}`,
    `- **Total Profit:** ${totalProfit.toLocaleString("en-US")} (${marginPct}% margin)`,
    totalLeads > 0 ? `- **Funnel:** ${totalConv.toLocaleString("en-US")} conversions / ${totalLeads.toLocaleString("en-US")} leads (${conversionRatePct}%)` : "",
    missingValueCount > 0 || malformedRowCount > 0
      ? `- **Data Quality:** ${missingValueCount} missing cell(s), ${malformedRowCount} irregular row(s)`
      : "",
    "",
    "#### Monthly Trends",
    "| Period | Revenue | Cost | Profit | Profit Delta vs Prev |",
    "| --- | ---: | ---: | ---: | ---: |",
    ...trends.map(
      (t) =>
        `| ${t.period} | ${t.revenue.toLocaleString("en-US")} | ${t.cost.toLocaleString("en-US")} | ${t.profit.toLocaleString("en-US")} | ${
          t.profitDeltaFromPrev === null ? "—" : `${t.profitDeltaFromPrev >= 0 ? "+" : ""}${t.profitDeltaFromPrev.toLocaleString("en-US")}`
        } |`,
    ),
    "",
    `#### Breakdown by ${groupKey ?? "Segment"}`,
    "| Segment | Revenue | Cost | Profit | Margin % | ROAS |",
    "| --- | ---: | ---: | ---: | ---: | ---: |",
    ...byGroup.map(
      (g) =>
        `| ${g.group} | ${g.revenue.toLocaleString("en-US")} | ${g.cost.toLocaleString("en-US")} | ${g.profit.toLocaleString("en-US")} | ${g.marginPct}% | ${
          g.roas !== null ? `${g.roas}x` : "—"
        } |`,
    ),
    recommendations.length ? `\n#### Recommendations\n${recommendations.map((r) => `- ${r}`).join("\n")}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  return {
    filePath: relPath,
    rowCount: lines.length - 1,
    headers,
    dataQuality: { missingValueCount, malformedRowCount },
    totals: {
      leads: totalLeads,
      conversions: totalConv,
      conversionRatePct,
      revenue: totalRevenue,
      cost: totalCost,
      profit: totalProfit,
      marginPct,
    },
    trends,
    byGroup,
    recommendations,
    markdown,
  };
}

