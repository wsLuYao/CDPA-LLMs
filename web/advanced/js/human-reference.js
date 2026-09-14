(function (root, factory) {
  const ModelOrder = typeof module === "object" && module.exports
    ? require("./model-order.js")
    : root.DecisionModelOrder;
  const api = factory(ModelOrder);
  if (typeof module === "object" && module.exports) module.exports = api;
  root.DecisionHumanReference = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function (ModelOrder) {
  "use strict";

  const REFERENCE_TYPE = "SAME_TASK_HUMAN_SAMPLE";
  const DEFAULT_ITERATIONS = 5000;
  const DEFAULT_SEED = 20260827;

  function clean(value) { return value == null ? "" : String(value).trim(); }
  function number(value, fallback = null) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }
  function truthy(value) { return ["1", "true", "yes", "y", "是"].includes(clean(value).toLowerCase()); }
  function unique(values) { return Array.from(new Set((values || []).filter((value) => clean(value) !== ""))); }
  function mean(values) {
    const finite = (values || []).filter(Number.isFinite);
    return finite.length ? finite.reduce((sum, value) => sum + value, 0) / finite.length : null;
  }
  function sd(values) {
    const finite = (values || []).filter(Number.isFinite);
    if (finite.length < 2) return null;
    const average = mean(finite);
    return Math.sqrt(finite.reduce((sum, value) => sum + (value - average) ** 2, 0) / (finite.length - 1));
  }
  function groupBy(rows, keyFn) {
    const map = new Map();
    (rows || []).forEach((row) => {
      const key = keyFn(row);
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(row);
    });
    return map;
  }
  function stableHash(value) {
    const text = String(value == null ? "" : value);
    let hash = 2166136261 >>> 0;
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 16777619) >>> 0;
    }
    return hash >>> 0;
  }
  function mulberry32(seed) {
    let state = seed >>> 0;
    return function random() {
      state += 0x6D2B79F5;
      let value = state;
      value = Math.imul(value ^ (value >>> 15), value | 1);
      value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
      return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
    };
  }
  function percentile(values, probability) {
    const sorted = (values || []).filter(Number.isFinite).sort((a, b) => a - b);
    if (!sorted.length) return null;
    if (sorted.length === 1) return sorted[0];
    const position = (sorted.length - 1) * probability;
    const low = Math.floor(position);
    const high = Math.ceil(position);
    if (low === high) return sorted[low];
    return sorted[low] + (sorted[high] - sorted[low]) * (position - low);
  }

  function normalizeHumanRows(rows) {
    return (rows || []).map((row, index) => ({
      __index: index,
      participantId: clean(row.ParticipantID),
      referenceType: clean(row.ReferenceType) || REFERENCE_TYPE,
      humanDataVersion: clean(row.HumanDataVersion),
      bankId: clean(row.BankDatasetID),
      bankDatasetId: clean(row.BankDatasetID),
      bankContentHash: clean(row.BankContentHash),
      questionId: clean(row.QuestionID),
      itemId: clean(row.ItemID),
      groupId: clean(row.GroupID),
      secondLevel: clean(row.SecondLevel),
      categoryId: clean(row.CategoryID),
      category: clean(row.Category),
      categoryKey: `${clean(row.BankDatasetID)}::${clean(row.CategoryID)}`,
      conditionCode: clean(row.ConditionCode),
      condition: clean(row.Condition),
      conditionLevel: clean(row.ConditionLevel),
      domain: clean(row.Domain),
      domainRaw: clean(row.Domain),
      domainKey: clean(row.DomainKey) || (clean(row.Domain) ? `${clean(row.BankDatasetID)}::${clean(row.Domain)}` : ""),
      domainSource: clean(row.DomainSource),
      logicalRanking: clean(row.LogicalRanking),
      topChoice: clean(row.TopChoice),
      rankL1: number(row.Rank_L1),
      rankL2: number(row.Rank_L2),
      rankL3: number(row.Rank_L3),
      preference: number(row.PreferenceScore_P),
      pairL1AboveL2: number(row.Pair_L1_Above_L2),
      l1Top: number(row.L1_Top),
      l2Top: number(row.L2_Top),
      l3Top: number(row.L3_Top),
      scoreFamily: clean(row.ScoreFamily),
      conditionStructure: clean(row.ConditionStructure),
      optionRole: clean(row.OptionRole),
      contrastId: clean(row.ContrastID),
      contrastWeights: clean(row.ContrastWeights),
      aggregationRule: clean(row.AggregationRule),
      itemVersion: clean(row.ItemVersion),
      sourceContentDigest: clean(row.Source_ContentDigest),
      sourceStimulusMatchStatus: clean(row.StimulusMatchStatus),
      sourceIncluded: truthy(row.Included),
      sourceExclusionReason: clean(row.ExclusionReason),
      included: false,
      exclusionReason: "NOT_MATCHED",
      stimulusMatchStatus: "NOT_MATCHED",
    }));
  }

  function aiItemMetadata(records) {
    const lookup = new Map();
    const conflicts = new Map();
    groupBy(records || [], (row) => `${row.bankId}::${row.itemId}`).forEach((rows, key) => {
      const first = rows[0];
      const metadata = {
        bankId: first.bankId,
        bankDatasetId: first.bankDatasetId,
        bankContentHash: first.bankContentHash,
        bankLabel: first.bankLabel,
        itemId: first.itemId,
        groupId: first.groupId,
        conditionCode: first.conditionCode,
        categoryId: first.categoryId,
        categoryKey: first.categoryKey,
        itemVersion: first.itemVersion,
        sourceContentDigest: first.sourceContentDigest,
        domain: first.domainRaw,
        domainKey: first.domainRaw ? `${first.bankId}::${first.domainRaw}` : "",
      };
      const fields = ["groupId", "conditionCode", "categoryId", "itemVersion", "sourceContentDigest", "domain"];
      const differing = fields.filter((field) => unique(rows.map((row) => {
        if (field === "domain") return row.domainRaw;
        return row[field];
      })).length > 1);
      if (differing.length) conflicts.set(key, differing);
      lookup.set(key, metadata);
    });
    return { lookup, conflicts };
  }

  function matchHumanRows(humanRows, aiRecords) {
    const ai = aiItemMetadata(aiRecords);
    const itemAudit = [];
    const itemStatus = new Map();
    groupBy(humanRows, (row) => `${row.bankId}::${row.itemId}`).forEach((rows, key) => {
      const first = rows[0];
      const metadata = ai.lookup.get(key);
      let status = "EXACT_MATCH";
      let reason = "BankDatasetID、ItemID、ConditionCode、ItemVersion与Source_ContentDigest一致";
      const mismatches = [];
      if (!metadata) {
        status = "AI_ITEM_NOT_FOUND";
        reason = "当前AI运行数据中不存在对应BankDatasetID＋ItemID";
      } else if (ai.conflicts.has(key)) {
        status = "AI_ITEM_METADATA_CONFLICT";
        reason = `AI侧同一ItemID元数据冲突：${ai.conflicts.get(key).join("、")}`;
      } else {
        if (first.groupId !== metadata.groupId) mismatches.push("GroupID");
        if (first.conditionCode !== metadata.conditionCode) mismatches.push("ConditionCode");
        if (first.categoryId !== metadata.categoryId) mismatches.push("CategoryID");
        if (first.itemVersion !== metadata.itemVersion) mismatches.push("ItemVersion");
        if (first.sourceContentDigest !== metadata.sourceContentDigest) mismatches.push("Source_ContentDigest");
        if (first.domain && metadata.domain && first.domain !== metadata.domain) mismatches.push("Domain");
        if (mismatches.length) {
          status = mismatches.includes("Source_ContentDigest") ? "CONTENT_DIGEST_MISMATCH" : "STIMULUS_METADATA_MISMATCH";
          reason = `严格刺激匹配失败：${mismatches.join("、")}`;
        }
      }
      const eligible = status === "EXACT_MATCH";
      const row = {
        referenceType: REFERENCE_TYPE,
        bankId: first.bankId,
        bankDatasetId: first.bankDatasetId,
        bankContentHash: metadata ? metadata.bankContentHash : "",
        itemId: first.itemId,
        groupId: first.groupId,
        categoryId: first.categoryId,
        conditionCode: first.conditionCode,
        domain: first.domain,
        domainKey: first.domainKey,
        humanItemVersion: first.itemVersion,
        aiItemVersion: metadata ? metadata.itemVersion : "",
        humanContentDigest: first.sourceContentDigest,
        aiContentDigest: metadata ? metadata.sourceContentDigest : "",
        participantCount: unique(rows.map((entry) => entry.participantId)).length,
        rowCount: rows.length,
        stimulusMatchStatus: status,
        eligible,
        mismatches,
        reason,
      };
      itemAudit.push(row);
      itemStatus.set(key, row);
    });
    humanRows.forEach((row) => {
      const audit = itemStatus.get(`${row.bankId}::${row.itemId}`);
      row.bankContentHash = audit ? audit.bankContentHash : "";
      row.stimulusMatchStatus = audit ? audit.stimulusMatchStatus : "AI_ITEM_NOT_FOUND";
      row.included = !!(row.sourceIncluded && audit && audit.eligible && row.participantId && row.logicalRanking);
      row.exclusionReason = row.included ? "" : (row.sourceExclusionReason || (audit ? audit.reason : "AI_ITEM_NOT_FOUND"));
    });
    return { itemAudit, itemStatus, aiMetadataConflicts: Array.from(ai.conflicts.entries()).map(([key, fields]) => ({ key, fields })) };
  }

  function humanConditionMeans(humanRows) {
    const participantCells = [];
    groupBy(humanRows.filter((row) => row.included && row.scoreFamily === "DIRECTIONAL_RANK" && Number.isFinite(row.preference)), (row) => `${row.participantId}::${row.bankId}::${row.groupId}::${row.conditionCode}`).forEach((rows) => {
      const first = rows[0];
      participantCells.push({
        participantId: first.participantId,
        bankId: first.bankId,
        bankDatasetId: first.bankDatasetId,
        bankContentHash: first.bankContentHash,
        groupId: first.groupId,
        categoryId: first.categoryId,
        category: first.category,
        categoryKey: first.categoryKey,
        conditionCode: first.conditionCode,
        condition: first.condition,
        conditionStructure: first.conditionStructure,
        domain: first.domain,
        domainKey: first.domainKey,
        preference: mean(rows.map((row) => row.preference)),
        itemCount: unique(rows.map((row) => row.itemId)).length,
        rowCount: rows.length,
      });
    });
    const conditions = [];
    groupBy(participantCells, (row) => `${row.bankId}::${row.groupId}::${row.conditionCode}`).forEach((rows) => {
      const first = rows[0];
      const values = rows.map((row) => row.preference).filter(Number.isFinite);
      conditions.push({
        referenceType: REFERENCE_TYPE,
        bankId: first.bankId,
        bankDatasetId: first.bankDatasetId,
        bankContentHash: first.bankContentHash,
        groupId: first.groupId,
        categoryId: first.categoryId,
        category: first.category,
        categoryKey: first.categoryKey,
        conditionCode: first.conditionCode,
        condition: first.condition,
        conditionStructure: first.conditionStructure,
        domain: first.domain,
        domainKey: first.domainKey,
        humanMeanP: mean(values),
        humanSdP: sd(values),
        participantCount: unique(rows.map((row) => row.participantId)).length,
        itemCount: Math.max(...rows.map((row) => row.itemCount)),
        humanRows: rows.reduce((sum, row) => sum + row.rowCount, 0),
        participantMeans: rows,
      });
    });
    return { participantCells, conditions };
  }

  function groupGaps(aiAnalysis, humanConditions) {
    const humanLookup = new Map(humanConditions.map((row) => [`${row.bankId}::${row.groupId}::${row.conditionCode}`, row]));
    return (aiAnalysis.effects && aiAnalysis.effects.groupEffects || []).map((ai) => {
      const required = Object.entries(ai.weights || {}).filter(([, weight]) => Number.isFinite(weight) && Math.abs(weight) > 1e-12);
      const missing = required.filter(([condition]) => !humanLookup.has(`${ai.bankId}::${ai.groupId}::${condition}`));
      const humanTerms = required.map(([condition, weight]) => {
        const row = humanLookup.get(`${ai.bankId}::${ai.groupId}::${condition}`);
        return { conditionCode: condition, weight, humanMeanP: row ? row.humanMeanP : null, participantCount: row ? row.participantCount : 0 };
      });
      const humanRawShift = missing.length ? null : humanTerms.reduce((sum, term) => sum + term.weight * term.humanMeanP, 0);
      const humanEffect = Number.isFinite(humanRawShift) ? humanRawShift / 2 : null;
      const computable = !!(ai.valid && Number.isFinite(ai.rawShift) && Number.isFinite(humanRawShift));
      const gapDeltaP = computable ? ai.rawShift - humanRawShift : null;
      return {
        referenceType: REFERENCE_TYPE,
        modelConfig: ai.modelConfig,
        analysisModelKey: ai.analysisModelKey || ai.modelConfig,
        bankId: ai.bankId,
        bankDatasetId: ai.bankDatasetId || ai.bankId,
        bankContentHash: ai.bankContentHash || "",
        bankLabel: ai.bankLabel,
        secondLevel: ai.secondLevel,
        categoryId: ai.categoryId,
        category: ai.category,
        categoryKey: ai.categoryKey,
        groupId: ai.groupId,
        contrastId: ai.contrastId,
        weights: ai.weights,
        domain: ai.domainEligible ? ai.domain : "",
        domainKey: ai.domainEligible ? ai.domainKey : "",
        domainStatus: ai.domainStatus || "",
        domainEligible: !!ai.domainEligible,
        aiRawShift: ai.rawShift,
        humanRawShift,
        gapDeltaP,
        aiE: ai.effect,
        humanE: humanEffect,
        gapE: computable ? ai.effect - humanEffect : null,
        humanTerms,
        humanParticipantCount: humanTerms.length ? Math.min(...humanTerms.map((term) => term.participantCount)) : 0,
        missingHumanConditions: missing.map(([condition]) => condition),
        computable,
        reason: computable ? "AI使用现有groupEffects；Human按参与者内Item等权后再跨参与者等权，并使用同一预登记权重" : missing.length ? `Human缺少非零权重条件：${missing.map(([condition]) => condition).join("、")}` : `AI效应不可计算：${ai.reason || "条件不完整"}`,
      };
    });
  }

  function scenarioInterval(values, key, iterations, seed) {
    const finite = values.filter(Number.isFinite);
    if (finite.length < 2) return { low: null, high: null, sd: null, computable: false, reason: "有效GroupID少于2个，无法估计题组层重采样区间" };
    const random = mulberry32((seed ^ stableHash(key)) >>> 0);
    const samples = new Float64Array(iterations);
    for (let iteration = 0; iteration < iterations; iteration += 1) {
      let total = 0;
      for (let index = 0; index < finite.length; index += 1) total += finite[Math.floor(random() * finite.length)];
      samples[iteration] = total / finite.length;
    }
    const sorted = Array.from(samples).sort((a, b) => a - b);
    return {
      low: percentile(sorted, 0.025),
      high: percentile(sorted, 0.975),
      sd: sd(sorted),
      computable: true,
      reason: "固定当前GroupID集合，以GroupID为单位有放回重采样；仅反映题组构成敏感性",
    };
  }

  function gapSummaries(aiAnalysis, gaps, options) {
    const iterations = number(options.scenarioIterations, DEFAULT_ITERATIONS);
    const seed = number(options.scenarioSeed, DEFAULT_SEED);
    const summaryLookup = new Map((aiAnalysis.effects && aiAnalysis.effects.summaries || []).map((row) => [`${row.modelConfig}::${row.categoryKey}::${row.contrastId}`, row]));
    const summaries = [];
    groupBy(gaps, (row) => `${row.modelConfig}::${row.categoryKey}::${row.contrastId}`).forEach((attempted) => {
      const rows = attempted.filter((row) => row.computable);
      const first = attempted[0];
      const aiSummary = summaryLookup.get(`${first.modelConfig}::${first.categoryKey}::${first.contrastId}`);
      const plannedGroups = aiSummary ? aiSummary.plannedGroups : unique(attempted.map((row) => row.groupId)).length;
      const validGroups = unique(rows.map((row) => row.groupId)).length;
      const coverage = plannedGroups ? validGroups / plannedGroups : null;
      const gapValues = rows.map((row) => row.gapDeltaP);
      const interval = scenarioInterval(gapValues, `${first.modelConfig}::${first.categoryKey}::${first.contrastId}`, iterations, seed);
      const formalComputable = coverage != null && coverage >= 0.8 && validGroups >= 2;
      summaries.push({
        referenceType: REFERENCE_TYPE,
        modelConfig: first.modelConfig,
        analysisModelKey: first.analysisModelKey,
        bankId: first.bankId,
        bankDatasetId: first.bankDatasetId,
        bankContentHash: first.bankContentHash,
        bankLabel: first.bankLabel,
        secondLevel: first.secondLevel,
        categoryId: first.categoryId,
        category: first.category,
        categoryKey: first.categoryKey,
        contrastId: first.contrastId,
        meanAiRawShift: mean(rows.map((row) => row.aiRawShift)),
        meanHumanRawShift: mean(rows.map((row) => row.humanRawShift)),
        gapDeltaP: mean(gapValues),
        meanAiE: mean(rows.map((row) => row.aiE)),
        meanHumanE: mean(rows.map((row) => row.humanE)),
        gapE: mean(rows.map((row) => row.gapE)),
        gapD: formalComputable ? mean(rows.map((row) => row.gapE)) : null,
        descriptiveGapE: mean(rows.map((row) => row.gapE)),
        validGroups,
        observedGroups: unique(attempted.map((row) => row.groupId)).length,
        plannedGroups,
        coverage,
        positiveGroupCount: gapValues.filter((value) => value > 1e-12).length,
        negativeGroupCount: gapValues.filter((value) => value < -1e-12).length,
        zeroGroupCount: gapValues.filter((value) => Math.abs(value) <= 1e-12).length,
        scenarioResamplingInterval95Low: formalComputable && interval.computable ? interval.low : null,
        scenarioResamplingInterval95High: formalComputable && interval.computable ? interval.high : null,
        scenarioResamplingSd: formalComputable && interval.computable ? interval.sd : null,
        gapEScenarioResamplingInterval95Low: formalComputable && interval.computable ? interval.low / 2 : null,
        gapEScenarioResamplingInterval95High: formalComputable && interval.computable ? interval.high / 2 : null,
        scenarioIterations: iterations,
        scenarioSeed: seed,
        scenarioMethod: "GROUP_ID_RESAMPLING_PERCENTILE",
        legacyEDBootstrap: "FROZEN_NOT_RUN",
        computable: formalComputable,
        reason: formalComputable ? interval.reason : validGroups < 2 ? "有效匹配GroupID少于2个，GapD与题组重采样区间不输出" : `匹配覆盖${validGroups}/${plannedGroups}低于80%，GapD不输出`,
        groupGaps: rows,
      });
    });
    return summaries;
  }

  function domainGapSummaries(gaps, options) {
    const iterations = number(options.scenarioIterations, DEFAULT_ITERATIONS);
    const seed = number(options.scenarioSeed, DEFAULT_SEED);
    const summaries = [];
    groupBy(gaps.filter((row) => row.computable && row.domainEligible), (row) => `${row.modelConfig}::${row.categoryKey}::${row.contrastId}::${row.domainKey}`).forEach((rows) => {
      const first = rows[0];
      const gapValues = rows.map((row) => row.gapDeltaP);
      const interval = scenarioInterval(gapValues, `${first.modelConfig}::${first.categoryKey}::${first.contrastId}::${first.domainKey}`, iterations, seed);
      summaries.push({
        referenceType: REFERENCE_TYPE,
        modelConfig: first.modelConfig,
        analysisModelKey: first.analysisModelKey,
        bankId: first.bankId,
        bankDatasetId: first.bankDatasetId,
        bankContentHash: first.bankContentHash,
        bankLabel: first.bankLabel,
        categoryId: first.categoryId,
        category: first.category,
        categoryKey: first.categoryKey,
        contrastId: first.contrastId,
        domain: first.domain,
        domainKey: first.domainKey,
        groupCount: unique(rows.map((row) => row.groupId)).length,
        groupIds: unique(rows.map((row) => row.groupId)).sort(),
        aiRawShift: mean(rows.map((row) => row.aiRawShift)),
        humanRawShift: mean(rows.map((row) => row.humanRawShift)),
        gapDeltaP: mean(gapValues),
        aiE: mean(rows.map((row) => row.aiE)),
        humanE: mean(rows.map((row) => row.humanE)),
        gapE: mean(rows.map((row) => row.gapE)),
        scenarioResamplingInterval95Low: interval.computable ? interval.low : null,
        scenarioResamplingInterval95High: interval.computable ? interval.high : null,
        scenarioIterations: iterations,
        scenarioSeed: seed,
        computable: true,
        intervalComputable: interval.computable,
        intervalReason: interval.reason,
        inferenceStatus: "DESCRIPTIVE_DOMAIN_COMPARISON",
      });
    });
    return summaries;
  }

  function topStats(rows) {
    const participantCells = [];
    groupBy(rows, (row) => `${row.participantId || row.itemId}::${row.bankId}::${row.groupId}::${row.conditionCode}`).forEach((cells) => {
      participantCells.push({
        l1: mean(cells.map((row) => row.l1Top != null ? row.l1Top : row.topChoice === "L1" ? 1 : 0)),
        l2: mean(cells.map((row) => row.l2Top != null ? row.l2Top : row.topChoice === "L2" ? 1 : 0)),
        l3: mean(cells.map((row) => row.l3Top != null ? row.l3Top : row.topChoice === "L3" ? 1 : 0)),
        r1: mean(cells.map((row) => row.rankL1 != null ? row.rankL1 : row.ranks && row.ranks.L1)),
        r2: mean(cells.map((row) => row.rankL2 != null ? row.rankL2 : row.ranks && row.ranks.L2)),
        r3: mean(cells.map((row) => row.rankL3 != null ? row.rankL3 : row.ranks && row.ranks.L3)),
      });
    });
    return {
      l1Top: mean(participantCells.map((row) => row.l1)),
      l2Top: mean(participantCells.map((row) => row.l2)),
      l3Top: mean(participantCells.map((row) => row.l3)),
      meanRankL1: mean(participantCells.map((row) => row.r1)),
      meanRankL2: mean(participantCells.map((row) => row.r2)),
      meanRankL3: mean(participantCells.map((row) => row.r3)),
      unitCount: participantCells.length,
    };
  }

  function singleLevelComparisons(aiAnalysis, humanRows, humanConditions) {
    const aiConditions = (aiAnalysis.effects && aiAnalysis.effects.conditionMeans || []).filter((row) => row.scoreFamily === "DIRECTIONAL_RANK");
    const humanLookup = new Map(humanConditions.map((row) => [`${row.bankId}::${row.groupId}::${row.conditionCode}`, row]));
    const rows = [];
    aiConditions.filter((row) => {
      const item = (aiAnalysis.itemRepeatSummaries || []).find((entry) => entry.bankId === row.bankId && entry.groupId === row.groupId && entry.conditionCode === row.conditionCode);
      return item && clean((aiAnalysis.records || []).find((record) => record.bankId === row.bankId && record.groupId === row.groupId && record.conditionCode === row.conditionCode)?.conditionStructure) === "SINGLE";
    }).forEach((ai) => {
      const human = humanLookup.get(`${ai.bankId}::${ai.groupId}::${ai.conditionCode}`);
      if (!human) return;
      const humanSource = humanRows.filter((row) => row.included && row.bankId === ai.bankId && row.groupId === ai.groupId && row.conditionCode === ai.conditionCode);
      const aiSource = (aiAnalysis.records || []).filter((row) => row.valid && row.modelConfig === ai.modelConfig && row.bankId === ai.bankId && row.groupId === ai.groupId && row.conditionCode === ai.conditionCode);
      const humanTop = topStats(humanSource);
      const aiTop = topStats(aiSource.map((row) => ({ ...row, participantId: row.itemId })));
      rows.push({
        referenceType: REFERENCE_TYPE,
        modelConfig: ai.modelConfig,
        analysisModelKey: ai.analysisModelKey,
        bankId: ai.bankId,
        bankDatasetId: ai.bankDatasetId,
        bankContentHash: ai.bankContentHash,
        bankLabel: ai.bankLabel,
        categoryId: ai.categoryId,
        category: ai.category,
        categoryKey: ai.categoryKey,
        groupId: ai.groupId,
        conditionCode: ai.conditionCode,
        domain: ai.domain,
        domainKey: ai.domainKey,
        aiMeanP: ai.mean,
        humanMeanP: human.humanMeanP,
        aiHumanPLevelDifference: Number.isFinite(ai.mean) ? ai.mean - human.humanMeanP : null,
        aiTop,
        humanTop,
        comparisonType: "SINGLE_LEVEL_P_AND_TOP_RATE",
        gapDeltaP: null,
        reason: "SINGLE不存在条件效应；只比较P水平、首选率与平均名次",
      });
    });
    return rows;
  }

  function nominalDistributions(aiAnalysis, humanRows) {
    const human = humanRows.filter((row) => row.included && row.scoreFamily === "NOMINAL_RANK");
    const results = [];
    groupBy(human, (row) => `${row.bankId}::${row.groupId}::${row.conditionCode}`).forEach((humanCells) => {
      const first = humanCells[0];
      (aiAnalysis.models || []).forEach((modelConfig) => {
        const aiCells = (aiAnalysis.records || []).filter((row) => row.valid && row.modelConfig === modelConfig && row.bankId === first.bankId && row.groupId === first.groupId && row.conditionCode === first.conditionCode && row.scoreFamily === "NOMINAL_RANK");
        if (!aiCells.length) return;
        const aiStats = topStats(aiCells.map((row) => ({ ...row, participantId: row.itemId })));
        const humanStats = topStats(humanCells);
        results.push({
          referenceType: REFERENCE_TYPE,
          modelConfig,
          analysisModelKey: modelConfig,
          bankId: first.bankId,
          bankDatasetId: first.bankDatasetId,
          bankContentHash: aiCells[0].bankContentHash,
          bankLabel: aiCells[0].bankLabel,
          categoryId: first.categoryId,
          category: first.category,
          categoryKey: first.categoryKey,
          groupId: first.groupId,
          conditionCode: first.conditionCode,
          condition: first.condition,
          domain: first.domain,
          domainKey: first.domainKey,
          ai: aiStats,
          human: humanStats,
          l1TopGap: aiStats.l1Top - humanStats.l1Top,
          l2TopGap: aiStats.l2Top - humanStats.l2Top,
          l3TopGap: aiStats.l3Top - humanStats.l3Top,
          comparisonType: "NOMINAL_STRATEGY_DISTRIBUTION",
          preferenceScoreP: null,
          effectE: null,
        });
      });
    });
    return results;
  }

  function cniDescriptive(aiAnalysis, humanRows, config) {
    const rows = humanRows.filter((row) => row.included && row.bankId === "moral_cni" && row.scoreFamily === "CUSTOM");
    if (!config || !Array.isArray(config.comparisons)) return { comparisons: [], l3Top: [], formalComputable: false, status: "CONFIG_MISSING" };
    const comparisons = [];
    const conditionMetric = (sourceRows, groupId, conditionCode, metric, unitField) => {
      const selected = sourceRows.filter((row) => row.groupId === groupId && row.conditionCode === conditionCode);
      const units = [];
      groupBy(selected, (row) => clean(row[unitField]) || row.itemId).forEach((cells) => units.push(mean(cells.map((row) => number(row[metric], null)).filter(Number.isFinite))));
      return { mean: mean(units), units: units.length };
    };
    const groupIds = unique(rows.map((row) => row.groupId));
    (aiAnalysis.models || []).forEach((modelConfig) => {
      const aiRows = (aiAnalysis.records || []).filter((row) => row.valid && row.modelConfig === modelConfig && row.bankId === "moral_cni").map((row) => ({
        ...row,
        pairL1AboveL2: row.ranks.L1 < row.ranks.L2 ? 1 : 0,
        l3Top: row.topChoice === "L3" ? 1 : 0,
      }));
      groupIds.forEach((groupId) => config.comparisons.forEach((spec) => {
        const negativeHuman = conditionMetric(rows, groupId, spec.negativeCondition, "pairL1AboveL2", "participantId");
        const positiveHuman = conditionMetric(rows, groupId, spec.positiveCondition, "pairL1AboveL2", "participantId");
        const negativeAi = conditionMetric(aiRows, groupId, spec.negativeCondition, "pairL1AboveL2", "itemId");
        const positiveAi = conditionMetric(aiRows, groupId, spec.positiveCondition, "pairL1AboveL2", "itemId");
        const computable = [negativeHuman.mean, positiveHuman.mean, negativeAi.mean, positiveAi.mean].every(Number.isFinite);
        const representative = rows.find((row) => row.groupId === groupId && row.conditionCode === spec.negativeCondition) || rows.find((row) => row.groupId === groupId);
        comparisons.push({
          referenceType: REFERENCE_TYPE,
          modelConfig,
          analysisModelKey: modelConfig,
          bankId: "moral_cni",
          bankDatasetId: "moral_cni",
          bankContentHash: aiRows[0] ? aiRows[0].bankContentHash : "",
          bankLabel: aiRows[0] ? aiRows[0].bankLabel : "道德决策 · CNI-Conflict",
          categoryId: spec.categoryId,
          groupId,
          contrastId: spec.id,
          domain: representative ? representative.domain : "",
          domainKey: representative ? representative.domainKey : "",
          aiNegative: negativeAi.mean,
          aiPositive: positiveAi.mean,
          humanNegative: negativeHuman.mean,
          humanPositive: positiveHuman.mean,
          aiDescriptiveDifference: computable ? positiveAi.mean - negativeAi.mean : null,
          humanDescriptiveDifference: computable ? positiveHuman.mean - negativeHuman.mean : null,
          aiHumanDescriptiveGap: computable ? (positiveAi.mean - negativeAi.mean) - (positiveHuman.mean - negativeHuman.mean) : null,
          formalComputable: false,
          computable,
          status: "METADATA_BLOCKED",
          analysisStatus: "EXPLORATORY",
          parameterStatus: "NOT_FORMAL_CNI_PARAMETER",
          reason: config.reason,
        });
      }));
    });
    const l3Top = [];
    groupBy(rows, (row) => `${row.domainKey}::${row.conditionCode}`).forEach((humanCells) => {
      const first = humanCells[0];
      (aiAnalysis.models || []).forEach((modelConfig) => {
        const aiCells = (aiAnalysis.records || []).filter((row) => row.valid && row.modelConfig === modelConfig && row.bankId === "moral_cni" && row.domainKey === first.domainKey && row.conditionCode === first.conditionCode);
        if (!aiCells.length) return;
        const humanRate = mean(humanCells.map((row) => row.l3Top));
        const aiRate = mean(aiCells.map((row) => row.topChoice === "L3" ? 1 : 0));
        l3Top.push({
          referenceType: REFERENCE_TYPE,
          modelConfig,
          bankId: "moral_cni",
          bankContentHash: aiCells[0].bankContentHash,
          domain: first.domain,
          domainKey: first.domainKey,
          conditionCode: first.conditionCode,
          aiL3TopRate: aiRate,
          humanL3TopRate: humanRate,
          l3TopRateGap: aiRate - humanRate,
          status: "EXPLORATORY_DESCRIPTIVE",
        });
      });
    });
    return { comparisons, l3Top, formalComputable: false, status: "METADATA_BLOCKED", configVersion: config.version };
  }

  function analyze(aiAnalysis, rawHumanRows, options = {}) {
    const rows = normalizeHumanRows(rawHumanRows);
    const match = matchHumanRows(rows, aiAnalysis.records || []);
    const conditionResult = humanConditionMeans(rows);
    const gaps = groupGaps(aiAnalysis, conditionResult.conditions);
    const summaries = gapSummaries(aiAnalysis, gaps, options);
    const domainSummaries = domainGapSummaries(gaps, options);
    const nominal = nominalDistributions(aiAnalysis, rows);
    const cni = cniDescriptive(aiAnalysis, rows, options.cniConfig || null);
    const single = singleLevelComparisons(aiAnalysis, rows, conditionResult.conditions);
    return {
      version: "HUMAN_REFERENCE_ANALYSIS_V1",
      referenceType: REFERENCE_TYPE,
      rows,
      manifest: options.manifest || null,
      matchAudit: match.itemAudit,
      conditionMeans: conditionResult.conditions,
      participantConditionMeans: conditionResult.participantCells,
      groupGaps: ModelOrder.sortRows(gaps, aiAnalysis.records),
      gapSummaries: ModelOrder.sortRows(summaries, aiAnalysis.records),
      domainGapSummaries: ModelOrder.sortRows(domainSummaries, aiAnalysis.records),
      singleLevelComparisons: ModelOrder.sortRows(single, aiAnalysis.records),
      nominalDistributions: ModelOrder.sortRows(nominal, aiAnalysis.records),
      cniDescriptive: {
        ...cni,
        comparisons: ModelOrder.sortRows(cni.comparisons, aiAnalysis.records),
        l3Top: ModelOrder.sortRows(cni.l3Top, aiAnalysis.records),
      },
      qa: {
        receivedRows: rows.length,
        includedRows: rows.filter((row) => row.included).length,
        excludedRows: rows.filter((row) => !row.included).length,
        participantCountByBank: Object.fromEntries(Array.from(groupBy(rows.filter((row) => row.included), (row) => row.bankId).entries()).map(([bankId, bankRows]) => [bankId, unique(bankRows.map((row) => row.participantId)).length])),
        itemCountByBank: Object.fromEntries(Array.from(groupBy(match.itemAudit, (row) => row.bankId).entries()).map(([bankId, bankRows]) => [bankId, bankRows.length])),
        exactMatchCount: match.itemAudit.filter((row) => row.eligible).length,
        mismatchCount: match.itemAudit.filter((row) => !row.eligible).length,
        invalidRankingCount: rows.filter((row) => row.sourceExclusionReason === "INVALID_OR_MISSING_RANKING").length,
        aiItemMetadataConflictCount: match.aiMetadataConflicts.length,
      },
      methodology: {
        humanAggregation: "Within participant, equal-weight ItemIDs in GroupID×ConditionCode; then equal-weight participants",
        aiSource: "Reuse analysis.effects.conditionMeans and analysis.effects.groupEffects; no second AI P/E pipeline",
        scenarioResampling: { iterations: number(options.scenarioIterations, DEFAULT_ITERATIONS), seed: number(options.scenarioSeed, DEFAULT_SEED), unit: "GroupID" },
        legacyEDBootstrap: "FROZEN_NOT_RUN",
      },
    };
  }

  return {
    analyze,
    normalizeHumanRows,
    matchHumanRows,
    humanConditionMeans,
    scenarioInterval,
    DEFAULT_ITERATIONS,
    DEFAULT_SEED,
  };
});
