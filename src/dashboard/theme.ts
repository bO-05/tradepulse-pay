import { studioTheme } from "ag-studio";

/** Tailwind colors used by the rest of TradePulse (see tailwind.config.js and RoleShell). */
export const TRADEPULSE_PALETTE = {
  appBackground: "#0a0f1d", // slate-950 (custom)
  panel: "#0f172a", // slate-900
  widget: "#151f30", // slate-850 (custom)
  raised: "#1e293b", // slate-800
  border: "#334155", // slate-700
  text: "#f1f5f9", // slate-100
  subtleText: "#94a3b8", // slate-400
  emerald: "#10b981", // emerald-500, the app's accent
  emeraldLight: "#6ee7b7", // emerald-300
  brand: "#22c55e", // brand-500
  sky: "#38bdf8", // sky-400
  amber: "#f59e0b", // amber-500
  rose: "#f43f5e", // rose-500
  violet: "#a78bfa", // violet-400
} as const;

const p = TRADEPULSE_PALETTE;

export const tradePulseStudioTheme = studioTheme.withParams({
  browserColorScheme: "dark",
  fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif",
  accentColor: p.emerald,
  backgroundColor: p.panel,
  foregroundColor: p.text,
  textColor: p.text,
  subtleTextColor: p.subtleText,
  borderColor: p.border,
  iconColor: p.subtleText,
  menuBackgroundColor: p.raised,
  menuTextColor: p.text,
  tooltipBackgroundColor: p.raised,
  tooltipTextColor: p.text,
  rowHoverColor: p.raised,
  studioWrapperBackgroundColor: p.appBackground,
  studioPanelContainerBackgroundColor: p.panel,
  studioPanelDividerActiveColor: p.emerald,
  studioCanvasBackgroundColor: p.appBackground,
  studioCanvasGridLineColor: p.raised,
  studioWidgetBackgroundColor: p.widget,
  studioWidgetBorder: { width: 1, color: p.border },
  studioWidgetBorderRadius: 12,
  studioWidgetTitleTextColor: p.emeraldLight,
  studioWidgetTitleFontSize: 15,
  studioWidgetSubtitleTextColor: p.subtleText,
  studioWidgetSubtitleFontSize: 12,
  studioWidgetToolbarBackgroundColor: p.raised,
  studioWidgetLoadingOverlayBackgroundColor: p.widget,
  studioWidgetNoDataOverlayBackgroundColor: p.widget,
  gridAccentColor: p.emerald,
  gridHeaderBackgroundColor: p.raised,
  gridHeaderTextColor: p.emeraldLight,
  gridDataBackgroundColor: p.widget,
  gridOddRowBackgroundColor: p.panel,
  gridCellTextColor: p.text,
  gridRowHoverColor: p.raised,
  chartAccentColor: p.emerald,
  chartTextColor: p.text,
  chartSubtleTextColor: p.subtleText,
  chartGridLineColor: p.raised,
  chartAxisLineColor: p.border,
  chartTooltipBackgroundColor: p.raised,
  chartTooltipTextColor: p.text,
  chartPaletteFills1Color: p.emerald,
  chartPaletteFills2Color: p.sky,
  chartPaletteFills3Color: p.amber,
  chartPaletteFills4Color: p.violet,
  chartPaletteFills5Color: p.rose,
  chartPaletteFills6Color: p.brand,
});
