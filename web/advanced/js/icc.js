(function (root, factory) {
  const ModelOrder = typeof module === "object" && module.exports
    ? require("./model-order.js")
    : root.DecisionModelOrder;
  const api = factory(ModelOrder);
  if (typeof module === "object" && module.exports) module.exports = api;
  root.DecisionICC = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function (ModelOrder) {
  "use strict";

  function finite(values) { return (values || []).filter(Number.isFinite); }
  function mean(values) { const xs = finite(values); return xs.length ? xs.reduce((sum, value) => sum + value, 0) / xs.length : null; }
  function unique(values) { return Array.from(new Set((values || []).filter((value) => value != null && value !== ""))); }
  function groupBy(rows, keyFn) {
    const groups = new Map();
    (rows || []).forEach((row) => {
      const key = keyFn(row);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(row);
    });
    return groups;
  }

  function oneWayIcc1k(matrix, k) {
    const rows = (matrix || []).filter((row) => Array.isArray(row) && row.length === k && row.every(Number.isFinite));
    const n = rows.length;
    if (n < 2 || k < 2) return { computable: false, status: "INSUFFICIENT_TARGETS", reason: "至少需要2个目标和2次完整重复", n, k };
    const targetMeans = rows.map(mean);
    const grand = mean(rows.flat());
    const ssBetween = k * targetMeans.reduce((sum, value) => sum + (value - grand) ** 2, 0);
    const ssWithin = rows.reduce((sum, row, index) => sum + row.reduce((subtotal, value) => subtotal + (value - targetMeans[index]) ** 2, 0), 0);
    const msBetween = ssBetween / (n - 1);
    const msWithin = ssWithin / (n * (k - 1));
    if ((!Number.isFinite(msBetween) || !Number.isFinite(msWithin)) || (Math.abs(msBetween) <= 1e-12 && Math.abs(msWithin) <= 1e-12)) {
      return { computable: false, status: "NO_VARIANCE", reason: "目标和重复均无可估计方差；不能把结果冒充0或1", n, k, msBetween, msWithin };
    }
    if (Math.abs(msBetween) <= 1e-12) return { computable: false, status: "BETWEEN_VARIANCE_ZERO", reason: "目标间方差为0，ICC不可稳定估计", n, k, msBetween, msWithin };
    const sigmaTarget = (msBetween - msWithin) / k;
    const sigmaError = msWithin;
    const icc11 = (msBetween - msWithin) / (msBetween + (k - 1) * msWithin);
    const icc1k = (msBetween - msWithin) / msBetween;
    return {
      computable: true, status: icc1k < 0 ? "NEGATIVE_ESTIMATE" : "OK",
      reason: icc1k < 0 ? "重复误差大于目标间差异，保留负ICC作诊断" : "一元随机效应ICC(1,k)",
      n, k, grandMean: grand, msBetween, msWithin, sigmaTarget, sigmaError, icc11, icc1k,
    };
  }

  function withinAiProfiles(analysis, options = {}) {
    const k = Number(options.repetitions || analysis.plannedRepeats || 5);
    const minTargets = Math.max(4, Number(options.minTargets || 5));
    const directional = (analysis.itemRepeatSummaries || []).filter((item) => item.scoreFamily === "DIRECTIONAL_RANK" && item.repeatStatus === "COMPLETE");
    const scopes = [];
    groupBy(directional, (item) => `${item.modelConfig}::${item.bankId}::${item.categoryId}`).forEach((rows) => {
      scopes.push({ scope: "CATEGORY", domain: "", domainKey: "", rows });
      groupBy(rows.filter((item) => item.domainEligible !== false && item.domain), (item) => item.domainKey || `${item.bankId}::${item.domain}`).forEach((domainRows) => {
        scopes.push({ scope: "DOMAIN_WITHIN_CATEGORY", domain: domainRows[0].domain, domainKey: domainRows[0].domainKey, rows: domainRows });
      });
    });
    return scopes.map((scope) => {
      const rows = scope.rows;
      const matrix = rows.map((item) => (item.pValues || []).filter(Number.isFinite)).filter((values) => values.length === k);
      let result;
      if (matrix.length < minTargets) result = { computable: false, status: "INSUFFICIENT_CONDITIONS", reason: `过滤后仅${matrix.length}个完整题目条件；至少需要${minTargets}个，单一Group×3条件不估计ICC`, n: matrix.length, k };
      else result = oneWayIcc1k(matrix, k);
      return {
        iccType: "WITHIN_AI_CONDITION_PROFILE_ICC_1_K", estimand: `ICC(1,${k})`, scope: scope.scope,
        modelConfig: rows[0].modelConfig, bankId: rows[0].bankId, bankDatasetId: rows[0].bankDatasetId || rows[0].bankId,
        bankLabel: rows[0].bankLabel, categoryId: rows[0].categoryId, category: rows[0].category,
        categoryKey: rows[0].categoryKey, domain: scope.domain, domainKey: scope.domainKey,
        scoreFamily: "DIRECTIONAL_RANK", targetCount: matrix.length, repetitions: k,
        ...result,
      };
    });
  }

  function repeatThetaDirectional(analysis) {
    const included = (analysis.records || []).filter((row) => row.scoreFamily === "DIRECTIONAL_RANK" && row.valid && (analysis.options.includeRepaired || !row.repaired));
    const condition = new Map();
    groupBy(included, (row) => `${row.modelConfig}::${row.bankId}::${row.groupId}::${row.conditionCode}::${row.repeatIndex}`).forEach((rows, key) => {
      condition.set(key, mean(rows.map((row) => row.preference)));
    });
    const output = [];
    (analysis.effects && analysis.effects.groupEffects || []).filter((effect) => effect.scoreFamily === "DIRECTIONAL_RANK").forEach((effect) => {
      const required = Object.entries(effect.weights || {}).filter(([, weight]) => Math.abs(Number(weight)) > 1e-12);
      const k = analysis.plannedRepeats || 5;
      for (let repeatIndex = 1; repeatIndex <= k; repeatIndex += 1) {
        const terms = required.map(([conditionCode, weight]) => ({
          conditionCode, weight: Number(weight),
          value: condition.get(`${effect.modelConfig}::${effect.bankId}::${effect.groupId}::${conditionCode}::${repeatIndex}`),
        }));
        const complete = terms.length >= 2 && terms.every((term) => Number.isFinite(term.value));
        output.push({
          modelConfig: effect.modelConfig, bankId: effect.bankId, bankDatasetId: effect.bankDatasetId || effect.bankId,
          bankContentHash: effect.bankContentHash || "", bankLabel: effect.bankLabel,
          categoryId: effect.categoryId, category: effect.category, categoryKey: effect.categoryKey,
          groupId: effect.groupId, contrastId: effect.contrastId, repeatIndex,
          thetaType: "REGISTERED_E", theta: complete ? terms.reduce((sum, term) => sum + term.weight * term.value, 0) / 2 : null,
          domain: effect.domain || "", domainKey: effect.domainKey || "", domainEligible: effect.domainEligible === true,
          computable: complete, reason: complete ? "同一RepeatIndex内条件P按登记权重形成E" : "至少一个非零权重条件在该RepeatIndex缺失",
        });
      }
    });
    return output;
  }

  function crossAiCoreEffects(analysis, options = {}) {
    const k = Number(options.repetitions || analysis.plannedRepeats || 5);
    const theta = repeatThetaDirectional(analysis);
    const results = [];
    groupBy(theta, (row) => `${row.bankId}::${row.categoryId}::${row.contrastId}::${row.groupId}`).forEach((rows) => {
      const models = unique(rows.map((row) => row.modelConfig))
        .sort((a, b) => ModelOrder.compare(a, b, analysis.records));
      const matrix = [];
      const eligibleModels = [];
      models.forEach((modelConfig) => {
        const values = Array.from({ length: k }, (_, index) => {
          const row = rows.find((item) => item.modelConfig === modelConfig && item.repeatIndex === index + 1);
          return row && row.theta;
        });
        if (values.every(Number.isFinite)) { matrix.push(values); eligibleModels.push(modelConfig); }
      });
      let result;
      if (models.length < 2) result = { computable: false, status: "INSUFFICIENT_MODELS", reason: "当前核心效应少于2个AI配置；不伪造跨AI ICC", n: models.length, k };
      else if (matrix.length < 2) result = { computable: false, status: "INCOMPLETE_REPEATS", reason: "少于2个AI具有完整的逐Repeat核心效应", n: matrix.length, k };
      else if (unique(rows.map((row) => row.bankContentHash).filter(Boolean)).length > 1) result = { computable: false, status: "BANK_CONTENT_MISMATCH", reason: "BankContentHash不一致，禁止跨版本ICC", n: matrix.length, k };
      else result = oneWayIcc1k(matrix, k);
      results.push({
        iccType: "CROSS_AI_CORE_EFFECT_ICC_1_K", estimand: `ICC(1,${k})`, scope: "GROUP_CONTRAST",
        bankId: rows[0].bankId, bankDatasetId: rows[0].bankDatasetId, bankLabel: rows[0].bankLabel,
        categoryId: rows[0].categoryId, category: rows[0].category, categoryKey: rows[0].categoryKey,
        contrastId: rows[0].contrastId, groupId: rows[0].groupId, thetaType: "REGISTERED_E",
        domain: rows[0].domain || "", domainKey: rows[0].domainKey || "", domainEligible: rows[0].domainEligible === true,
        modelCount: models.length, eligibleModelCount: matrix.length, models: eligibleModels, repetitions: k,
        interpretationCaution: matrix.length <= 3 ? "仅2至3个AI时ICC高度不稳定，只作描述" : "",
        ...result,
      });
    });
    return { thetaByRepeat: theta, results };
  }

  function analyze(analysis, options = {}) {
    const cross = crossAiCoreEffects(analysis || {}, options);
    return {
      methodology: "ICC_1_K_ONE_WAY_RANDOM_v1",
      varianceDiagnosticsPreservedAs: "DescriptiveBetweenWithinVarianceRatio",
      withinAiProfiles: withinAiProfiles(analysis || {}, options),
      crossAiCoreEffects: cross.results,
      thetaByRepeat: cross.thetaByRepeat,
      exclusions: [
        { scoreFamily: "NOMINAL_RANK", reason: "无预登记单一theta，不计算ICC" },
        { scoreFamily: "CUSTOM_CNI", reason: "当前CNI正式Contrast元数据阻断，不计算正式核心效应ICC" }
      ],
    };
  }

  return { oneWayIcc1k, withinAiProfiles, repeatThetaDirectional, crossAiCoreEffects, analyze };
});
