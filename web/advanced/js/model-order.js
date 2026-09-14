(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.DecisionModelOrder = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const DISPLAY_ORDER = [
    "Deepseek-v4-flash",
    "Doubao-2.0-pro",
    "Qwen-3.7-flash",
    "Gemini-3.7-flash",
    "GPT-5.6-sol",
    "Grok-4.6",
  ];
  const TOKENS = DISPLAY_ORDER.map(normalize);

  function normalize(value) {
    return String(value == null ? "" : value).toLowerCase().replace(/[^a-z0-9]+/g, "");
  }

  function recordFor(value, records) {
    const key = String(value == null ? "" : value);
    return (records || []).find((record) => [
      record.modelConfig,
      record.analysisModelKey,
      record.rawModelConfigId,
      record.model,
    ].some((candidate) => String(candidate == null ? "" : candidate) === key));
  }

  function identity(value, records) {
    if (value && typeof value === "object") {
      return [
        value.label,
        value.model,
        value.provider,
        value.modelConfig,
        value.analysisModelKey,
        value.Model,
        value.ModelConfigID,
        value.AnalysisModelKey,
      ].filter(Boolean).join(" ");
    }
    const source = String(value == null ? "" : value);
    const record = recordFor(source, records);
    return record ? `${record.model || ""} ${record.provider || ""} ${source}` : source;
  }

  function rank(value, records) {
    const text = normalize(identity(value, records));
    const found = TOKENS.findIndex((token) => text.includes(token));
    return found < 0 ? DISPLAY_ORDER.length : found;
  }

  function compare(a, b, records) {
    const difference = rank(a, records) - rank(b, records);
    if (difference) return difference;
    return identity(a, records).localeCompare(identity(b, records), "zh-CN", { numeric: true, sensitivity: "base" });
  }

  function rowModel(row) {
    return row && (
      row.modelConfig || row.analysisModelKey || row.model || row.ModelConfigID ||
      row.AnalysisModelKey || row.Model || row.modelA || row.ModelA || ""
    );
  }

  function compareRows(a, b, records) {
    const primary = compare(rowModel(a), rowModel(b), records);
    if (primary) return primary;
    const secondaryA = a && (a.modelB || a.ModelB || "");
    const secondaryB = b && (b.modelB || b.ModelB || "");
    return compare(secondaryA, secondaryB, records);
  }

  function sortRows(rows, records) {
    return (rows || []).slice().sort((a, b) => compareRows(a, b, records));
  }

  return { DISPLAY_ORDER, normalize, identity, rank, compare, compareRows, sortRows };
});
