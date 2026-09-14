(function (root, factory) {
  const ModelOrder = typeof module === "object" && module.exports
    ? require("./model-order.js")
    : root.DecisionModelOrder;
  const api = factory(ModelOrder);
  if (typeof module === "object" && module.exports) module.exports = api;
  root.DecisionEffectSizes = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function (ModelOrder) {
  "use strict";

  function finite(values) { return (values || []).filter(Number.isFinite); }
  function mean(values) { const xs = finite(values); return xs.length ? xs.reduce((sum, value) => sum + value, 0) / xs.length : null; }
  function sampleSd(values) {
    const xs = finite(values);
    if (xs.length < 2) return null;
    const m = mean(xs);
    return Math.sqrt(xs.reduce((sum, value) => sum + (value - m) ** 2, 0) / (xs.length - 1));
  }
  function label(value) {
    if (!Number.isFinite(value)) return "无法计算";
    const magnitude = Math.abs(value);
    if (magnitude < 0.2) return "微小效应";
    if (magnitude < 0.5) return "小效应";
    if (magnitude < 0.8) return "中等效应";
    return "大效应";
  }
  function correction(df) { return Number.isFinite(df) && df > 0 ? 1 - 3 / (4 * df - 1) : null; }

  function categoryEffectSizes(analysis) {
    return (analysis.effects && analysis.effects.summaries || []).map((summary) => {
      const values = (summary.groupEffects || []).map((row) => row.effect).filter(Number.isFinite);
      const validGroups = values.length;
      const df = validGroups - 1;
      const standardDeviation = sampleSd(values);
      let computable = true;
      let reason = "满足现有80%覆盖门槛，按Group E样本标准差计算";
      if (!summary.eligible || !Number.isFinite(summary.coverage) || summary.coverage < 0.8) {
        computable = false; reason = "正式D覆盖门槛未满足，d/g不生成";
      } else if (validGroups < 2) {
        computable = false; reason = "有效Group少于2，无法估计题组间样本标准差";
      } else if (!Number.isFinite(standardDeviation) || Math.abs(standardDeviation) <= 1e-12) {
        computable = false; reason = "Group E样本标准差为0，标准化效应量无定义";
      }
      const cohenD = computable ? mean(values) / standardDeviation : null;
      const hedgesG = computable ? cohenD * correction(df) : null;
      return {
        modelConfig: summary.modelConfig, analysisModelKey: summary.analysisModelKey || summary.modelConfig,
        bankId: summary.bankId, bankDatasetId: summary.bankDatasetId || summary.bankId,
        bankContentHash: summary.bankContentHash || "", bankLabel: summary.bankLabel,
        categoryId: summary.categoryId, category: summary.category, categoryKey: summary.categoryKey,
        contrastId: summary.contrastId, dScore: summary.dScore,
        meanE: mean(values), sdE: standardDeviation, validGroups, plannedGroups: summary.plannedGroups,
        coverage: summary.coverage, df, hedgesCorrection: correction(df), cohenD, hedgesG,
        effectLabel: label(hedgesG), ceilingFloor: validGroups >= 2 && Math.abs(standardDeviation || 0) <= 1e-12,
        computable, reason,
      };
    });
  }

  function modelEffectSizes(analysis) {
    const effects = (analysis.effects && analysis.effects.groupEffects || []).filter((row) => row.valid && Number.isFinite(row.effect));
    const grouped = new Map();
    effects.forEach((row) => {
      const key = `${row.bankId}::${row.categoryId}::${row.contrastId}`;
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key).push(row);
    });
    const output = [];
    grouped.forEach((rows) => {
      const models = Array.from(new Set(rows.map((row) => row.modelConfig)))
        .sort((a, b) => ModelOrder.compare(a, b, analysis.records));
      for (let i = 0; i < models.length; i += 1) {
        for (let j = i + 1; j < models.length; j += 1) {
          const modelA = models[i]; const modelB = models[j];
          const byA = new Map(rows.filter((row) => row.modelConfig === modelA).map((row) => [row.groupId, row]));
          const byB = new Map(rows.filter((row) => row.modelConfig === modelB).map((row) => [row.groupId, row]));
          const shared = Array.from(byA.keys()).filter((groupId) => byB.has(groupId)).sort();
          const compatibleHash = shared.every((groupId) => !byA.get(groupId).bankContentHash || !byB.get(groupId).bankContentHash || byA.get(groupId).bankContentHash === byB.get(groupId).bankContentHash);
          const differences = shared.map((groupId) => byA.get(groupId).effect - byB.get(groupId).effect);
          const standardDeviation = sampleSd(differences);
          const df = shared.length - 1;
          let computable = true;
          let reason = "相同Bank×Category×Contrast×GroupID上的E配对差，使用差值样本标准差";
          if (!compatibleHash) { computable = false; reason = "BankContentHash不一致，禁止跨题库版本配对"; }
          else if (shared.length < 2) { computable = false; reason = "有效配对Group少于2"; }
          else if (!Number.isFinite(standardDeviation) || Math.abs(standardDeviation) <= 1e-12) { computable = false; reason = "配对E差值样本标准差为0，标准化效应量无定义"; }
          const meanDiff = mean(differences);
          const cohenDz = computable ? meanDiff / standardDeviation : null;
          const hedgesGz = computable ? cohenDz * correction(df) : null;
          output.push({
            bankId: rows[0].bankId, bankDatasetId: rows[0].bankDatasetId || rows[0].bankId,
            bankLabel: rows[0].bankLabel, categoryId: rows[0].categoryId, category: rows[0].category,
            categoryKey: rows[0].categoryKey, contrastId: rows[0].contrastId,
            modelA, modelB, matchedGroupIds: shared, validPairs: shared.length,
            meanDiff, sdDiff: standardDeviation, df, hedgesCorrection: correction(df),
            cohenDz, hedgesGz, effectLabel: label(hedgesGz), computable, reason,
          });
        }
      }
    });
    return output;
  }

  function analyze(analysis) {
    return {
      methodology: "Cohen_d_Hedges_g_v1.1",
      categoryEffectSizes: categoryEffectSizes(analysis || {}),
      effectModelComparisons: modelEffectSizes(analysis || {}),
      note: "d/g标准化Group E的题组间波动；dScore仍为平台正式D，二者绝不互换。",
    };
  }

  return { mean, sampleSd, label, correction, categoryEffectSizes, modelEffectSizes, analyze };
});
