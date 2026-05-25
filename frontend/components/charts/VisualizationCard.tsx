/**
 * AssistMe — VisualizationCard
 *
 * Location: /components/charts/VisualizationCard.tsx
 * Created: 2026-05-21
 * Purpose: Renders AI visualization payloads inside AI message bubbles.
 *          Receives chart_data from messages.metadata.chart_data.
 *          Routes to the correct sub-component based on data.type.
 *
 * Supported types:
 *   metric       — single KPI
 *   metric_grid  — 2-4 KPI cards
 *   ranked_list  — top-N items with progress bars
 *   risk_list    — items with risk severity + days late
 *   insight      — single highlighted observation
 *   bar          — vertical bar chart for time-series (weekly trend)
 *
 * To add a new type:
 *   1. Add type string to SUPPORTED_TYPES in visualizationParser.js
 *   2. Add a new sub-component below
 *   3. Add a case in VisualizationCard switch
 *   4. Update AssistMe_UI_Rules.md and assistme_message_architecture_documentation_v7.md
 *
 * Design rules:
 *   - Renders INSIDE the AI message bubble, below text, above timestamp
 *   - Never renders on action cards or customer-facing messages
 *   - Never crashes — all failures render null silently with console.warn
 *   - No external libraries — pure React Native View components
 *   - No gap property — use marginBottom/marginRight for RN compatibility
 *   - Colors match AssistMe design system
 */

import React from 'react';
import { View, Text, StyleSheet } from 'react-native';

// ── Color tokens (matches [customer_id].tsx design system) ────
const COLORS = {
  primary: '#075E54',
  success: '#4CAF50',
  warning: '#FFC107',
  danger: '#D32F2F',
  aiBg: '#F0FAF8',
  cardBg: '#FFFFFF',
  border: '#E0E0E0',
  textPrimary: '#1A1A1A',
  textSecondary: '#666666',
  textMuted: '#999999',
  barBg: '#E8F5E9',
};

// ── Level → color mapping ─────────────────────────────────────
const levelColor = (level?: string) => {
  if (level === 'critical') return COLORS.danger;
  if (level === 'warning') return COLORS.warning;
  return COLORS.primary;
};

const levelBg = (level?: string) => {
  if (level === 'critical') return '#FFEBEE';
  if (level === 'warning') return '#FFFDE7';
  return COLORS.aiBg;
};

// ── Format currency ───────────────────────────────────────────
const formatINR = (value: number) =>
  '\u20B9' + value.toLocaleString('en-IN');

// ── MetricCard ────────────────────────────────────────────────
const MetricCard = ({ data }: { data: any }) => (
  <View style={[styles.card, { borderLeftColor: levelColor(data.level), backgroundColor: levelBg(data.level) }]}>
    {data.title && <Text style={styles.cardTitle}>{data.title}</Text>}
    <Text style={[styles.metricValue, { color: levelColor(data.level) }]}>{data.value}</Text>
    {data.subtitle && <Text style={styles.metricSubtitle}>{data.subtitle}</Text>}
  </View>
);

// ── MetricGridCard ────────────────────────────────────────────
const MetricGridCard = ({ data }: { data: any }) => {
  const cards = data.cards || [];
  return (
    <View style={styles.card}>
      {data.title && <Text style={styles.cardTitle}>{data.title}</Text>}
      <View style={styles.gridRow}>
        {cards.map((card: any, idx: number) => (
          <View key={idx} style={styles.gridCell}>
            <Text style={styles.gridLabel}>{card.label}</Text>
            <Text style={styles.gridValue}>{card.value}</Text>
            {card.trend && (
              <Text style={[
                styles.gridTrend,
                { color: card.trend_direction === 'up' ? COLORS.success : card.trend_direction === 'down' ? COLORS.danger : COLORS.textMuted }
              ]}>
                {card.trend_direction === 'up' ? '\u2191' : card.trend_direction === 'down' ? '\u2193' : '\u2192'} {card.trend}
              </Text>
            )}
          </View>
        ))}
      </View>
    </View>
  );
};

// ── RankedListCard ────────────────────────────────────────────
// Bar width = (value / maxValue) * 100% — pure View, no SVG
const RankedListCard = ({ data }: { data: any }) => {
  const series = data.series || [];
  if (series.length === 0) return null;
  const maxValue = Math.max(...series.map((s: any) => s.value || 0));
  const barColors = ['#075E54', '#1A936F', '#52B788', '#74C69D', '#95D5B2'];

  return (
    <View style={styles.card}>
      {data.title && <Text style={styles.cardTitle}>{data.title}</Text>}
      {series.map((item: any, idx: number) => {
        const pct = maxValue > 0 ? Math.round((item.value / maxValue) * 100) : 0;
        const barColor = barColors[idx % barColors.length];
        return (
          <View key={idx} style={styles.rankRow}>
            <Text style={styles.rankLabel} numberOfLines={1}>{item.label}</Text>
            <View style={styles.barTrack}>
              <View style={[styles.barFill, { width: `${pct}%`, backgroundColor: barColor }]} />
            </View>
            <Text style={styles.rankValue}>{formatINR(item.value)}</Text>
          </View>
        );
      })}
      {data.highlight && (
        <View style={[styles.highlightBox, { borderLeftColor: levelColor(data.level) }]}>
          <Text style={[styles.highlightText, { color: levelColor(data.level) }]}>{data.highlight}</Text>
        </View>
      )}
    </View>
  );
};

// ── BarChartCard ─────────────────────────────────────────────
// Vertical bar chart for time-series data (weekly trend etc.)
// Pure React Native Views — no SVG, no external libraries
// Centralized in VisualizationCard — accessible from all surfaces
const BarChartCard = ({ data }: { data: any }) => {
  const series = data.series || [];
  if (series.length === 0) return null;
  const maxValue = Math.max(...series.map((s: any) => s.value || 0), 1);
  const BAR_MAX_HEIGHT = 80;
  const trendColor = data.highlight?.startsWith('Up') ? COLORS.success
    : data.highlight?.startsWith('Down') ? COLORS.danger
    : COLORS.muted;

  return (
    <View style={styles.card}>
      {data.title && <Text style={styles.cardTitle}>{data.title}</Text>}
      <View style={{ flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-around', height: BAR_MAX_HEIGHT + 28, marginTop: 8 }}>
        {series.map((item: any, idx: number) => {
          const barH = maxValue > 0 ? Math.max(Math.round((item.value / maxValue) * BAR_MAX_HEIGHT), item.value > 0 ? 4 : 0) : 0;
          const isLast = idx === series.length - 1;
          return (
            <View key={idx} style={{ alignItems: 'center', flex: 1 }}>
              <Text style={{ fontSize: 8, color: COLORS.muted, marginBottom: 2 }}>
                {item.value > 0 ? formatINR(item.value) : ''}
              </Text>
              <View style={{
                height: barH, width: 18,
                backgroundColor: isLast ? COLORS.primary : '#B2DFDB',
                borderRadius: 3,
                minHeight: item.value > 0 ? 4 : 0,
              }} />
              <Text style={{ fontSize: 9, color: isLast ? COLORS.primary : COLORS.muted, marginTop: 4, fontWeight: isLast ? '700' : '400' }}>
                {item.label}
              </Text>
            </View>
          );
        })}
      </View>
      {data.highlight && (
        <View style={[styles.highlightBox, { borderLeftColor: trendColor }]}>
          <Text style={[styles.highlightText, { color: trendColor }]}>{data.highlight}</Text>
        </View>
      )}
    </View>
  );
};

// ── RiskListCard ───────────────────────────────────────────────
const RiskListCard = ({ data }: { data: any }) => {
  const series = data.series || [];
  if (series.length === 0) return null;

  return (
    <View style={styles.card}>
      {data.title && <Text style={styles.cardTitle}>{data.title}</Text>}
      {series.map((item: any, idx: number) => {
        const color = levelColor(item.level);
        const dotColor = item.level === 'critical' ? COLORS.danger : item.level === 'warning' ? COLORS.warning : COLORS.success;
        return (
          <View key={idx} style={[styles.riskRow, idx === series.length - 1 && { borderBottomWidth: 0 }]}>
            <View style={[styles.riskDot, { backgroundColor: dotColor }]} />
            <View style={styles.riskInfo}>
              <Text style={styles.riskLabel}>{item.label}</Text>
              {item.value > 0 && <Text style={styles.riskValue}>{formatINR(item.value)} overdue</Text>}
            </View>
            {item.days_late != null && (
              <Text style={[styles.riskDays, { color }]}>{item.days_late}d late</Text>
            )}
          </View>
        );
      })}
      {data.highlight && (
        <View style={[styles.highlightBox, { borderLeftColor: COLORS.warning }]}>
          <Text style={[styles.highlightText, { color: COLORS.textSecondary }]}>{data.highlight}</Text>
        </View>
      )}
    </View>
  );
};

// ── InsightCard ───────────────────────────────────────────────
const InsightCard = ({ data }: { data: any }) => (
  <View style={[styles.card, styles.insightCard, { borderLeftColor: levelColor(data.level), backgroundColor: levelBg(data.level) }]}>
    <Text style={[styles.insightTitle, { color: levelColor(data.level) }]}>{data.title}</Text>
    <Text style={styles.insightText}>{data.text}</Text>
  </View>
);

// ── VisualizationCard (router) ────────────────────────────────
interface VisualizationCardProps {
  data: any;
}

export default function VisualizationCard({ data }: VisualizationCardProps) {
  if (!data || !data.type) return null;

  try {
    switch (data.type) {
      case 'metric':
        return <MetricCard data={data} />;
      case 'metric_grid':
        return <MetricGridCard data={data} />;
      case 'ranked_list':
        return <RankedListCard data={data} />;
      case 'risk_list':
        return <RiskListCard data={data} />;
      case 'insight':
        return <InsightCard data={data} />;
      case 'bar':
        return <BarChartCard data={data} />;
      default:
        console.warn('[VisualizationCard] Unknown type received:', data.type);
        return null;
    }
  } catch (e) {
    console.warn('[VisualizationCard] Render error:', e);
    return null;
  }
}

// ── Styles ────────────────────────────────────────────────────
const styles = StyleSheet.create({
  card: {
    marginTop: 8,
    borderRadius: 10,
    borderLeftWidth: 3,
    borderLeftColor: COLORS.primary,
    backgroundColor: COLORS.cardBg,
    padding: 10,
  },
  cardTitle: {
    fontSize: 12,
    fontWeight: '700',
    color: COLORS.textSecondary,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 6,
  },
  // Metric
  metricValue: {
    fontSize: 24,
    fontWeight: '800',
    color: COLORS.primary,
    marginBottom: 2,
  },
  metricSubtitle: {
    fontSize: 12,
    color: COLORS.textMuted,
  },
  // MetricGrid
  gridRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
  },
  gridCell: {
    width: '48%',
    backgroundColor: COLORS.aiBg,
    borderRadius: 8,
    padding: 8,
    marginRight: '2%',
    marginBottom: 6,
  },
  gridLabel: {
    fontSize: 11,
    color: COLORS.textMuted,
    marginBottom: 2,
  },
  gridValue: {
    fontSize: 16,
    fontWeight: '700',
    color: COLORS.textPrimary,
  },
  gridTrend: {
    fontSize: 11,
    marginTop: 2,
    fontWeight: '600',
  },
  // RankedList
  rankRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 6,
  },
  rankLabel: {
    fontSize: 12,
    color: COLORS.textPrimary,
    width: 90,
    marginRight: 6,
  },
  barTrack: {
    flex: 1,
    height: 8,
    backgroundColor: COLORS.barBg,
    borderRadius: 4,
    overflow: 'hidden',
    marginRight: 6,
  },
  barFill: {
    height: 8,
    borderRadius: 4,
  },
  rankValue: {
    fontSize: 11,
    color: COLORS.textSecondary,
    fontWeight: '600',
    width: 60,
    textAlign: 'right',
  },
  // RiskList
  riskRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 5,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.border,
  },
  riskDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    marginRight: 8,
  },
  riskInfo: {
    flex: 1,
  },
  riskLabel: {
    fontSize: 13,
    fontWeight: '600',
    color: COLORS.textPrimary,
  },
  riskValue: {
    fontSize: 11,
    color: COLORS.textMuted,
    marginTop: 1,
  },
  riskDays: {
    fontSize: 12,
    fontWeight: '700',
    marginLeft: 6,
  },
  // Insight
  insightCard: {
    borderLeftWidth: 4,
  },
  insightTitle: {
    fontSize: 13,
    fontWeight: '700',
    marginBottom: 4,
  },
  insightText: {
    fontSize: 13,
    color: COLORS.textPrimary,
    lineHeight: 18,
  },
  // Highlight box
  highlightBox: {
    marginTop: 8,
    borderLeftWidth: 3,
    paddingLeft: 8,
    paddingVertical: 4,
  },
  highlightText: {
    fontSize: 12,
    lineHeight: 16,
    fontWeight: '500',
  },
});
