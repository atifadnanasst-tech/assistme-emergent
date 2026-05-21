/**
 * AssistMe — Visualization Parser
 *
 * Location: /services/ai/visualizationParser.js
 * Created: 2026-05-21
 * Purpose: Extracts and validates [VIZ:{...}] blocks from AI responses.
 *          Keeps index.js clean. Reusable across all AI routes (customer, home, org-wide).
 *
 * Supported semantic types (frontend decides render style):
 *   metric       — { title, value, subtitle?, level? }
 *   metric_grid  — { title, cards:[{label, value, trend?, trend_direction?}] }
 *   ranked_list  — { title, currency?, series:[{label, value}], highlight?, level? }
 *   risk_list    — { title, series:[{label, value, days_late?, level?}], highlight? }
 *   insight      — { title, text, level? }
 *
 * level values: "info" | "warning" | "critical"
 * trend_direction values: "up" | "down" | "flat"
 *
 * To add a new type in future:
 *   1. Add the string to SUPPORTED_TYPES below
 *   2. Add the component in frontend/components/charts/VisualizationCard.tsx
 *   3. Update AssistMe_UI_Rules.md and assistme_message_architecture_documentation_v7.md
 *   Nothing else changes.
 */

export const SUPPORTED_TYPES = [
  'metric',        // single KPI — e.g. total outstanding, payment total
  'metric_grid',   // 2-4 KPIs together — e.g. business health summary
  'ranked_list',   // top-N items with amounts — e.g. outstanding, purchases, reorder
  'risk_list',     // items with risk severity + days late — e.g. risk check
  'insight',       // single highlighted observation — e.g. dominant fact from any query
];

/**
 * extractVisualization(responseText)
 *
 * Takes raw AI response text (may contain [VIZ:{...}] block).
 * Returns { cleanText, chartData }
 *
 * cleanText  — response with [VIZ:...] stripped, ready to save and display
 * chartData  — parsed JSON object or null if absent / malformed / unsupported type
 *
 * Never throws. All failures return null chartData silently.
 */
export function extractVisualization(responseText) {
  if (!responseText || typeof responseText !== 'string') {
    return { cleanText: responseText || '', chartData: null };
  }

  // Match [VIZ:{...}] — handles multiline JSON inside the block
  const vizRegex = /\[VIZ:(\{[\s\S]*?\})\]/;
  const match = responseText.match(vizRegex);

  if (!match) {
    return { cleanText: responseText.trim(), chartData: null };
  }

  let chartData = null;

  try {
    const parsed = JSON.parse(match[1]);

    if (!parsed.type) {
      console.warn('[visualizationParser] VIZ block missing type field — ignored');
      return { cleanText: responseText.replace(vizRegex, '').trim(), chartData: null };
    }

    if (!SUPPORTED_TYPES.includes(parsed.type)) {
      console.warn(`[visualizationParser] Unknown VIZ type "${parsed.type}" — ignored`);
      return { cleanText: responseText.replace(vizRegex, '').trim(), chartData: null };
    }

    chartData = parsed;
  } catch (e) {
    console.warn('[visualizationParser] VIZ block JSON parse failed — ignored:', e.message);
    return { cleanText: responseText.replace(vizRegex, '').trim(), chartData: null };
  }

  const cleanText = responseText.replace(vizRegex, '').trim();
  return { cleanText, chartData };
}
