(function (root, factory) {
  const ModelOrder = typeof module === "object" && module.exports
    ? require("./model-order.js")
    : root.DecisionModelOrder;
  const api = factory(ModelOrder);
  if (typeof module === "object" && module.exports) module.exports = api;
  root.DecisionFullExport = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function (ModelOrder) {
  "use strict";

  function num(value) { return Number.isFinite(value) ? value : value == null ? "" : value; }
  function mapText(values, digits = 6) {
    return Object.entries(values || {}).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => `${key}=${Number.isFinite(value) ? Number(value).toFixed(digits).replace(/0+$/, "").replace(/\.$/, "") : "NA"}`).join("；") || "NA";
  }
  function objectText(values) {
    return Object.entries(values || {}).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => `${key}=${value}`).join("；") || "NA";
  }
  function domainFields(row) {
    return {
      Domain: row && (row.domain || row.domainRaw) || "",
      DomainKey: row && row.domainKey || "",
      DomainStatus: row && row.domainStatus || "",
      DomainEligible: row && row.domainEligible === true,
      DomainEligibilityReason: row && row.domainEligibilityReason || "",
    };
  }
  function interpret(api, name, ...args) {
    try { return api && typeof api[name] === "function" ? api[name](...args) : ""; }
    catch (error) { void error; return ""; }
  }

  function runManifestRows(analysis) {
    return (analysis.importBatches || []).map((batch) => ({
      ImportBatchID: batch.batchId,
      ImportBatchName: batch.batchName,
      ModelConfigID: batch.modelConfig,
      Ready: batch.ready,
      RequiredFileProgress: `${batch.progress}/2`,
      CompleteRows: batch.counts && batch.counts.complete,
      RankingRows: batch.counts && batch.counts.ranking,
      PlannedRepetitions: analysis.plannedRepeatsByBatch && analysis.plannedRepeatsByBatch[batch.batchId],
      RepetitionInferenceSource: "分析配置固定值（默认5）；不从RunID、批次或最大RepeatIndex推断",
      RunIDs: (analysis.records || []).filter((row) => row.batchId === batch.batchId).map((row) => row.runId).filter((value, index, values) => value && values.indexOf(value) === index).join(";"),
      CompleteFile: batch.sourceNames && batch.sourceNames.complete,
      RankingFile: batch.sourceNames && batch.sourceNames.ranking,
    }));
  }

  function runSummaryRows(analysis) {
    const q = analysis.quality || {};
    return [{
      GeneratedAt: new Date().toISOString(),
      IncludeRepaired: analysis.options && analysis.options.includeRepaired,
      ResultBatches: (analysis.importBatches || []).length || 1,
      ModelConfigCount: (analysis.models || []).length,
      AnalysisModelKeys: (analysis.models || []).join(";"),
      RawModelConfigCount: new Set((analysis.records || []).map((row) => row.rawModelConfigId)).size,
      RawModelConfigIDs: Array.from(new Set((analysis.records || []).map((row) => row.rawModelConfigId))).join(";"),
      Records: q.total,
      ResponseDenominator: q.responseDenominator,
      FirstValid: q.firstValid,
      FirstValidRate: q.firstValidRate,
      RepairedValid: q.repaired,
      FinalValid: q.finalValid,
      FinalValidRate: q.finalValidRate,
      Invalid: q.invalid,
      RetryCount: q.retry,
      RetryRate: q.retryRate,
      TechnicalErrors: q.technical,
      TechnicalRate: q.technicalRate,
      PlannedRepetitions: analysis.plannedRepeats,
      PlannedRepetitionSource: "analysis_settings",
      AuditScore: analysis.audit && analysis.audit.score,
      BundledBankRows: analysis.banks && analysis.banks.files ? analysis.banks.files.reduce((sum, file) => sum + (file.rows || []).length, 0) : 0,
      ActiveCatalogRows: analysis.banks && analysis.banks.catalog ? Object.values(analysis.banks.catalog).reduce((sum, bank) => sum + bank.rows, 0) : 0,
      RuntimeMetadataRows: analysis.banks && analysis.banks.runtimeMetadataRows,
      RuntimeAddedItems: analysis.banks && analysis.banks.runtimeAddedItems,
      RuntimeOverriddenItems: analysis.banks && analysis.banks.runtimeOverriddenItems,
      RuntimeMetadataConflicts: analysis.banks && analysis.banks.metadataConflicts ? analysis.banks.metadataConflicts.length : 0,
      RegisteredCategoryUnits: analysis.registry && analysis.registry.totals.categoryUnits,
      RegisteredConditionUnits: analysis.registry && analysis.registry.totals.conditionUnits,
      RegisteredDirectionalContrasts: analysis.registry && analysis.registry.totals.registeredDirectionalContrasts,
    }];
  }

  function statusRows(analysis) {
    const quality = analysis.quality || {};
    const first = Object.entries(quality.firstStatuses || {}).map(([status, count]) => ({ Stage: "FirstStatus", Status: status, Count: count }));
    const final = Object.entries(quality.finalStatuses || {}).map(([status, count]) => ({ Stage: "FinalStatus", Status: status, Count: count }));
    return first.concat(final);
  }

  function readinessRows(analysis) {
    return (analysis.readiness || []).map((row) => ({
      Key: row.key, Module: row.label, Ready: row.ready, Score: row.score, Formula: row.formula, Detail: row.detail,
    }));
  }

  function qualityRows(analysis) {
    return (analysis.layeredQuality || []).map((row) => ({
      Level: row.level, Object: row.object, Records: row.total, ResponseDenominator: row.responseDenominator,
      FirstValid: row.firstValid, FirstValidRate: row.firstValidRate, RepairedValid: row.repaired,
      RetryCount: row.retry, RetryRate: row.retryRate, FinalValid: row.finalValid,
      FinalValidRate: row.finalValidRate, Invalid: row.invalid, TechnicalErrors: row.technical, TechnicalRate: row.technicalRate,
    }));
  }

  function pRows(analysis, api) {
    const includeRepaired = analysis.options && analysis.options.includeRepaired;
    return (analysis.records || []).map((row) => ({
      ImportBatchID: row.batchId, ImportBatchName: row.batchName, RunID: row.runId, RequestID: row.requestId,
      AnalysisModelKey: row.modelConfig, RawModelConfigID: row.rawModelConfigId, ModelConfigID: row.modelConfig, Model: row.model,
      BankDatasetID: row.bankDatasetId, BankPartID: row.bankPartId, BankContentHash: row.bankContentHash, Bank: row.bankLabel, SecondLevel: row.secondLevel,
      CategoryID: row.categoryId, Category: row.category, GroupID: row.groupId, ItemID: row.itemId,
      ...domainFields(row),
      ConditionCode: row.conditionCode, RepeatIndex: row.repeatIndex, PermutationID: row.permutationId,
      FinalStatus: row.finalStatus, Repaired: row.repaired, IncludedInStatistics: !!(row.valid && (includeRepaired || !row.repaired)),
      ModelIdentityPolicy: "MODEL_IDENTITY_V2", ModelIdentityBlocked: row.modelIdentityBlocked,
      ModelIdentityInferredFields: (row.modelIdentityInferredFields || []).join(";"),
      ModelIdentityInferenceSources: (row.modelIdentityInferenceSources || []).join(";"),
      ModelIdentityAmbiguousFields: (row.modelIdentityAmbiguousFields || []).join(";"),
      ModelIdentityUnresolvedFields: (row.modelIdentityUnresolvedFields || []).join(";"),
      ScoreFamily: row.scoreFamily, DisplayedRanking: row.displayedRanking, SourceRanking: row.sourceRanking,
      LogicalRanking: row.logicalRanking, MappingStatus: row.mappingStatus, MappingReason: row.mappingReason,
      RepeatStatus: row.repeatStatus, TopChoice: row.topChoice,
      Rank_L1: row.rankL1, Rank_L2: row.ranks && row.ranks.L2, Rank_L3: row.rankL3, K: row.optionCount,
      P_Numerator: row.preferenceNumerator, P_Denominator: row.preferenceDenominator, P: row.preference,
      P_Interpretation: interpret(api, "interpretP", row, row.preference),
    }));
  }

  function conditionMeanRows(analysis, api) {
    return (analysis.effects && analysis.effects.conditionMeans || []).map((row) => ({
      ModelConfigID: row.modelConfig, Bank: row.bankLabel, SecondLevel: row.secondLevel,
      CategoryID: row.categoryId, Category: row.category, GroupID: row.groupId,
      ...domainFields(row),
      ConditionCode: row.conditionCode, Condition: row.conditionLabel,
      ItemIDCount: row.itemIdCount, CompleteItemCount: row.completeItemCount, ItemIDs: (row.itemIds || []).join(";"),
      P_SumOfItemMeans: row.numerator, ItemMeansCount: row.denominator, PreferenceMean_Pbar: row.mean,
      ConditionSD_P: row.sd, ValidRepeats: row.validRepeats, PlannedRepeats: row.plannedRepeats,
      RepeatCoverage: row.coverage, RepeatStatus: row.repeatStatus, Reason: row.reason,
      Pbar_Interpretation: interpret(api, "interpretP", row, row.mean, { average: true }),
    }));
  }

  function groupMeanRows(analysis, api) {
    return (analysis.profiles && analysis.profiles.groupMeans || []).map((row) => ({
      ModelConfigID: row.modelConfig, Bank: row.bankLabel, SecondLevel: row.secondLevel,
      CategoryID: row.categoryId, Category: row.category, GroupID: row.groupId,
      ...domainFields(row),
      GroupMeanP: row.value, ObservedItems: row.nItems, ObservedConditions: row.nConditions,
      Interpretation: interpret(api, "interpretP", row, row.value, { average: true }),
    }));
  }

  function profileRows(analysis, api) {
    return (analysis.profiles && analysis.profiles.profiles || []).map((row) => ({
      ModelConfigID: row.modelConfig, Bank: row.bankLabel, SecondLevel: row.secondLevel,
      CategoryID: row.categoryId, Category: row.category, PreferenceMean: row.mean,
      CI95_Low: row.ciLow, CI95_High: row.ciHigh, SD: row.sd, ValidGroups: row.validGroups,
      PlannedGroups: row.plannedGroups, Coverage: row.coverage,
      PreferenceMean_Interpretation: interpret(api, "interpretP", row, row.mean, { average: true }),
    }));
  }

  function topChoiceRows(analysis) {
    return (analysis.profiles && analysis.profiles.topChoices || []).map((row) => ({
      ModelConfigID: row.modelConfig, Bank: row.bankLabel, CategoryID: row.categoryId, Category: row.category,
      ValidN: row.total, L1TopCount: row.counts.L1, L1TopRate: row.proportions.L1,
      L2TopCount: row.counts.L2, L2TopRate: row.proportions.L2,
      L3TopCount: row.counts.L3, L3TopRate: row.proportions.L3,
      ScoreFamilies: (row.scoreFamilies || []).join(";"),
    }));
  }

  function eRows(analysis, api) {
    return (analysis.effects && analysis.effects.groupEffects || []).map((row) => ({
      ModelConfigID: row.modelConfig, Bank: row.bankLabel, SecondLevel: row.secondLevel,
      CategoryID: row.categoryId, Category: row.category, GroupID: row.groupId, ContrastID: row.contrastId,
      ...domainFields(row),
      ConditionMeans: mapText(row.conditionMeans), ConditionLabels: objectText(row.conditionLabels),
      ConditionCounts: mapText(row.conditionCounts, 0), ConditionStatuses: objectText(row.conditionStatuses), ContrastWeights: mapText(row.weights), WeightsValid: row.weightsValid,
      E_Numerator: row.numerator, E_Denominator: row.denominator, ResolvedFormula: row.resolvedFormula,
      RawWeightedPShift: row.rawShift, E: row.effect, Eligible: row.valid, Reason: row.reason,
      E_Interpretation: interpret(api, "interpretE", row, row.effect),
    }));
  }

  function dRows(analysis, api) {
    return (analysis.effects && analysis.effects.summaries || []).map((row) => ({
      ModelConfigID: row.modelConfig, Bank: row.bankLabel, SecondLevel: row.secondLevel,
      CategoryID: row.categoryId, Category: row.category, ContrastID: row.contrastId,
      MeanE_Numerator: row.meanENumerator, MeanE_Denominator: row.meanEDenominator,
      MeanE_Formula: row.meanEFormula, MeanE: row.meanE, MeanE_CI95_Low: row.meanECiLow, MeanE_CI95_High: row.meanECiHigh,
      MeanE_Interpretation: interpret(api, "interpretMeanE", row, row.meanE),
      D_Numerator: row.dNumerator, D_Denominator: row.dDenominator, D_Formula: row.dFormula,
      D: row.dScore, DescriptiveD: row.descriptiveD, CI95_Low: row.ciLow, CI95_High: row.ciHigh,
      ValidGroups: row.validGroups, PlannedGroups: row.plannedGroups, Coverage: row.coverage,
      PositiveGroups: row.positiveGroups, NegativeGroups: row.negativeGroups, ZeroGroups: row.zeroGroups,
      Eligible: row.eligible, SameDirection: row.sameDirection, DirectionDenominator: row.directionDenominator,
      PermutationP: row.p, HolmP: row.pHolm, EvidenceStatus: row.evidenceStatus, EvidenceLabel: row.evidenceLabel,
      CIExcludesZero: row.ciExcludesZero, HolmSupported: row.adjustedSupported, Reason: row.reason,
      D_Interpretation: interpret(api, "interpretD", row, row.dScore),
    }));
  }

  function coverageRows(analysis) {
    return (analysis.registry && analysis.registry.coverage || []).map((row) => ({
      ModelConfigID: row.modelConfig, Bank: row.bankLabel, SecondLevel: row.secondLevel,
      CategoryID: row.categoryId, Category: row.category, ScoreFamily: row.scoreFamily, ConditionStructure: row.conditionStructure,
      PlannedConditions: row.plannedConditions, ObservedConditions: row.observedConditions,
      PlannedItems: row.plannedItems, ObservedItems: row.observedItems, PlannedGroups: row.plannedGroups, ObservedGroups: row.observedGroups,
      ValidRecords: row.validRecords, PRecords: row.pRecords, RegisteredContrasts: row.registeredContrasts,
      ComputedMeanEContrasts: row.computedEContrasts, EligibleDContrasts: row.eligibleDContrasts,
      PApplicability: row.pApplicability, EApplicability: row.eApplicability, DApplicability: row.dApplicability,
      RunStatus: row.runStatus, ScoringRouteExplanation: row.applicabilityReason,
    }));
  }

  function contrastRows(analysis, api) {
    return (analysis.registry && analysis.registry.contrasts || []).map((row) => ({
      ModelConfigID: row.modelConfig, Bank: row.bankLabel, SecondLevel: row.secondLevel,
      CategoryID: row.categoryId, Category: row.category, ConditionStructure: row.conditionStructure,
      ContrastID: row.contrastId, ContrastWeights: mapText(row.weights), ConditionLabels: objectText(row.conditionLabels),
      AttemptedGroups: row.attemptedGroups, ValidGroups: row.validGroups, PlannedGroups: row.plannedGroups,
      MeanE: row.meanE, D: row.dScore, Coverage: row.coverage, EvidenceStatus: row.evidenceStatus,
      EvidenceLabel: row.evidenceLabel, Reason: row.reason,
      MeanE_Interpretation: row.summary ? interpret(api, "interpretMeanE", row.summary, row.summary.meanE) : "",
      D_Interpretation: row.summary ? interpret(api, "interpretD", row.summary, row.summary.dScore) : "",
    }));
  }

  function factorialRows(analysis, api) {
    const rows = [];
    (analysis.factorial && analysis.factorial.analyses || []).forEach((entry) => {
      const design = entry.design || {};
      rows.push({
        Table: "DesignSummary", ModelConfigID: entry.modelConfig, Bank: entry.bankLabel, SecondLevel: entry.secondLevel,
        CategoryID: entry.categoryId, Category: entry.category, ScoreFamily: entry.scoreFamily,
        DesignClass: design.designClass, DesignFormula: design.formula, FactorKeys: (entry.factorKeys || []).join("×"),
        FactorLevels: objectText(entry.factorLevels), PlannedCells: design.plannedCells, ObservedCells: design.observedCells,
        CartesianCells: design.cartesianCells, StructuralUnplannedCells: design.structuralUnplannedCells,
        DataMissingCells: design.dataMissingCells, DesignRank: design.designRank, DesignColumns: design.designColumns,
        Estimable: design.estimable, NumericFactor: design.numericFactor, GroupFactor: design.groupFactor,
        CommonSupport: (design.commonSupport || []).join(";"), ReferenceValue: design.referenceValue,
        OutcomeID: "", OutcomeLabel: "", EffectID: "", EffectType: "", EffectUnit: "",
        ConditionCode: "", ConditionLabel: "", MeanP: "", ValidN: "", PlannedN: "", Coverage: "",
        MeanE: "", DescriptiveD: "", D: "", EvidenceStatus: entry.formalBlocked ? "METADATA_BLOCKED" : (design.estimable ? "ESTIMABLE" : "NOT_ESTIMABLE"),
        Interpretation: entry.formalBlocked ? entry.blockedReason : "先识别设计结构与可估计性，再解释主效应、简单斜率和交互。结构上未设计的单元不计为数据缺失。",
      });
      (entry.cells || []).forEach((cell) => rows.push({
        Table: "FactorCell", ModelConfigID: entry.modelConfig, Bank: entry.bankLabel, SecondLevel: entry.secondLevel,
        CategoryID: entry.categoryId, Category: entry.category, ScoreFamily: entry.scoreFamily,
        DesignClass: design.designClass, OutcomeID: "CELL", OutcomeLabel: "因子单元描述", EffectID: "", EffectType: "", EffectUnit: "",
        ConditionCode: cell.conditionCode, ConditionLabel: cell.conditionLabel,
        FactorLevels: objectText(cell.factorValues), MeanP: cell.meanP, ValidN: cell.nValid,
        PlannedN: cell.plannedObservations, Coverage: cell.coverage,
        L1TopRate: cell.topProportions.L1, L2TopRate: cell.topProportions.L2, L3TopRate: cell.topProportions.L3,
        PairL1AboveL2: cell.pairL1AboveL2, MeanRankL1: cell.meanRanks.L1, MeanRankL2: cell.meanRanks.L2, MeanRankL3: cell.meanRanks.L3,
        RankScoreL1: cell.rankScores.L1, RankScoreL2: cell.rankScores.L2, RankScoreL3: cell.rankScores.L3,
        FullRankingCounts: objectText(cell.rankingCounts), OutcomeMeans: mapText(cell.outcomeMeans),
        MeanE: "", CI95Low: "", CI95High: "", DescriptiveD: "", D: "", EvidenceStatus: cell.nValid ? "DESCRIPTIVE" : "NOT_RUN",
        Interpretation: entry.blocked ? entry.blockedReason : "因子单元内描述统计；跨单元差异必须按设计矩阵效应解释。",
      }));
      (entry.registeredEffects || []).forEach((effect) => rows.push({
        Table: "RegisteredEffect", ModelConfigID: entry.modelConfig, Bank: entry.bankLabel, SecondLevel: entry.secondLevel,
        CategoryID: entry.categoryId, Category: entry.category, ScoreFamily: entry.scoreFamily,
        DesignClass: design.designClass, OutcomeID: "P", OutcomeLabel: "方向偏好P", EffectID: effect.contrastId,
        EffectType: "REGISTERED_CONTRAST", EffectUnit: "标准化E", ConditionCode: "", ConditionLabel: "", FactorLevels: "",
        MeanP: "", ValidN: effect.validGroups, PlannedN: effect.plannedGroups, Coverage: effect.coverage,
        L1TopRate: "", L2TopRate: "", L3TopRate: "", MeanE: effect.meanE,
        CI95Low: effect.meanECiLow, CI95High: effect.meanECiHigh, DescriptiveD: effect.descriptiveD, D: effect.dScore,
        PositiveGroups: effect.positiveGroups, NegativeGroups: effect.negativeGroups, ZeroGroups: effect.zeroGroups,
        PermutationP: effect.p, HolmP: effect.pHolm,
        EvidenceStatus: effect.evidenceStatus,
        Interpretation: `${interpret(api, "interpretMeanE", effect, effect.meanE)} ${interpret(api, "interpretD", effect, effect.dScore)}`.trim(),
      }));
      (entry.factorialEffects || []).forEach((effect) => rows.push({
          Table: "GeneratedFactorialEffect", ModelConfigID: entry.modelConfig, Bank: entry.bankLabel, SecondLevel: entry.secondLevel,
          CategoryID: entry.categoryId, Category: entry.category, ScoreFamily: entry.scoreFamily,
          DesignClass: design.designClass, OutcomeID: effect.outcomeId, OutcomeLabel: effect.outcomeLabel,
          EffectID: effect.effectId || effect.id, EffectType: effect.effectType, EffectUnit: effect.effectUnit,
          ConditionCode: "", ConditionLabel: "", FactorLevels: (effect.factors || []).join("×"),
          FactorDirections: (effect.factorDirections || []).map((row) => `${row.factor}:${row.positiveLevel}−${row.negativeLevel}`).join("；"),
          ContrastWeights: mapText(effect.weights),
          MeanP: "", ValidN: effect.validGroups, PlannedN: effect.plannedGroups, Coverage: effect.coverage,
          L1TopRate: "", L2TopRate: "", L3TopRate: "", MeanE: effect.meanE,
          CI95Low: effect.ciLow, CI95High: effect.ciHigh, DescriptiveD: effect.descriptiveD, D: effect.dScore,
          PositiveGroups: effect.positiveGroups, NegativeGroups: effect.negativeGroups, ZeroGroups: effect.zeroGroups,
          PermutationP: effect.p, HolmP: effect.pHolm, Registered: effect.registered, Formal: effect.formal,
          MetadataBlocked: effect.metadataBlocked, EvidenceStatus: effect.evidenceStatus,
          Interpretation: interpret(api, "interpretFactorial", entry, effect),
        }));
    });
    return rows;
  }

  function nominalRows(analysis) {
    return (analysis.nonDirectional && analysis.nonDirectional.analyses || []).flatMap((entry) => (entry.cells || []).map((cell) => ({
      ModelConfigID: entry.modelConfig, Bank: entry.bankLabel, SecondLevel: entry.secondLevel,
      CategoryID: entry.categoryId, Category: entry.category, ScoreFamily: entry.scoreFamily, ConditionStructure: entry.conditionStructure,
      ConditionCode: cell.conditionCode, ConditionLabel: cell.conditionLabel, FactorLevels: objectText(cell.factorValues), ValidN: cell.n,
      L1TopCount: cell.topCounts.L1, L1TopRate: cell.topProportions.L1,
      L2TopCount: cell.topCounts.L2, L2TopRate: cell.topProportions.L2,
      L3TopCount: cell.topCounts.L3, L3TopRate: cell.topProportions.L3,
      MeanRankL1: cell.meanRanks.L1, MeanRankL2: cell.meanRanks.L2, MeanRankL3: cell.meanRanks.L3,
      FullRankingCounts: objectText(cell.rankingCounts), Blocked: entry.blocked, Interpretation: entry.reason,
    })));
  }

  function reliabilityRows(analysis) {
    return (analysis.reliability && analysis.reliability.cells || []).map((row) => ({
      ModelConfigID: row.modelConfig, Model: row.model, Bank: row.bankLabel, CategoryID: row.categoryId,
      Category: row.category, GroupID: row.groupId, ItemID: row.itemId, ValidRepeats: row.n,
      ...domainFields(row),
      TopChoiceAgreement: row.topAgreement, FullRankingAgreement: row.fullAgreement, MeanKendallTau: row.kendallTau,
      PermutationCount: row.permutations, PositionEffectEligible: row.positionEligible,
    }));
  }

  function itemRepeatRows(analysis) {
    return (analysis.itemRepeatSummaries || []).map((row) => ({
      AnalysisModelKey: row.modelConfig, RawModelConfigIDs: (row.rawModelConfigIds || []).join(";"),
      BankDatasetID: row.bankDatasetId, BankContentHash: row.bankContentHash, Bank: row.bankLabel,
      CategoryID: row.categoryId, Category: row.category, GroupID: row.groupId,
      ...domainFields(row), DirectionFlip: row.directionFlip,
      ConditionCode: row.conditionCode, ItemID: row.itemId,
      P_Mean: row.pMean, P_SD: row.pSd, P_Min: row.pMin, P_Max: row.pMax, P_Range: row.pRange,
      TopChoiceAgreement: row.topAgreement, FullRankingAgreement: row.fullAgreement, MeanKendallTau: row.kendallTau,
      ValidRepeats: row.validRepeats, PlannedRepeats: row.plannedRepeats, ObservedRows: row.observedRows,
      ValidRepeatIndices: (row.validRepeatIndices || []).join(";"), MissingRepeatIndices: (row.missingRepeatIndices || []).join(";"),
      DuplicateRepeatIndices: (row.duplicateRepeatIndices || []).join(";"), RepeatStatus: row.repeatStatus,
      RepeatReason: row.repeatReason, PermutationCount: row.permutationCount,
      ObservedPermutationIDs: (row.observedPermutationIds || []).join(";"),
      LogicalRankings: (row.logicalRankings || []).join(" | "), P_Values: (row.pValues || []).map(num).join(" | "),
      ModeTie: row.modeTie, MappingBlocked: row.mappingBlocked, ModelConfigBlocked: row.modelConfigBlocked,
    }));
  }

  function repeatAuditRows(analysis) {
    return (analysis.itemRepeatSummaries || []).map((row) => ({
      AnalysisModelKey: row.modelConfig, BankDatasetID: row.bankDatasetId, ItemID: row.itemId,
      PlannedRepeats: row.plannedRepeats, ObservedRows: row.observedRows, ValidRepeats: row.validRepeats,
      RepeatStatus: row.repeatStatus, MissingRepeatIndices: (row.missingRepeatIndices || []).join(";"),
      DuplicateRepeatIndices: (row.duplicateRepeatIndices || []).join(";"),
      MetadataConflictFields: (row.metadataConflictFields || []).join(";"), MappingBlocked: row.mappingBlocked,
      ModelConfigBlocked: row.modelConfigBlocked,
      Reason: row.repeatReason,
    }));
  }

  function datasetRows(analysis) {
    return (analysis.datasetManifest || []).map((row) => ({
      BankDatasetID: row.bankDatasetId, Bank: row.bankLabel, BankPartCount: row.bankPartCount,
      BankPartIDs: (row.bankPartIds || []).join(";"), BankContentHash: row.bankContentHash,
      ItemCount: row.itemCount, GroupCount: row.groupCount, CatalogRows: row.rowCount,
      CompositionConflictCount: row.compositionConflictCount,
      CompositionStatus: row.compositionConflictCount ? "DATASET_COMPOSITION_CONFLICT" : "VALID",
    }));
  }

  function mappingRows(analysis) {
    return (analysis.records || []).map((row) => ({
      ImportBatchID: row.batchId, SourceFile: row.sourceFile, SourceRow: row.sourceRow,
      ItemID: row.itemId, RepeatIndex: row.repeatIndex, PermutationID: row.permutationId,
      AnalysisModelKey: row.modelConfig, RawModelConfigID: row.rawModelConfigId,
      ModelIdentityBlocked: row.modelIdentityBlocked,
      ModelIdentityInferredFields: (row.modelIdentityInferredFields || []).join(";"),
      ModelIdentityAmbiguousFields: (row.modelIdentityAmbiguousFields || []).join(";"),
      DisplayedRanking: row.displayedRanking, DisplayToSourceMap: row.displayToSourceMap,
      SourceRanking: row.sourceRanking, OptToLMap: row.optToLMap, LogicalRanking: row.logicalRanking,
      MappingPaths: (row.mappingPaths || []).join(";"), MappingStatus: row.mappingStatus,
      MappingValid: row.mappingValid, Reason: row.mappingReason,
    }));
  }

  function modelConfigAuditRows(analysis) {
    return (analysis.modelConfigAudit || []).map((row) => ({
      AnalysisModelKey: row.analysisModelKey, RawModelConfigCount: row.rawModelConfigCount,
      RawModelConfigIDs: (row.rawModelConfigIds || []).join(";"), CoreFingerprint: row.coreFingerprint,
      IdentityPolicy: row.identityPolicy,
      ApiModes: (row.apiModes || []).join(";"), TransportModeVariation: row.transportModeVariation,
      InferredRecordCount: row.inferredRecordCount, InferredFields: (row.inferredFields || []).map((field) => field).join(";"),
      InferenceSources: (row.inferenceSources || []).join(";"),
      AmbiguousRecordCount: row.ambiguousRecordCount, AmbiguousFields: (row.ambiguousFields || []).join(";"),
      UnresolvedFields: (row.unresolvedFields || []).join(";"), ExplicitVariantFields: (row.explicitVariantFields || []).join(";"),
      MaxOutputTokens: (row.maxOutputTokens || []).join(";"), MaxObservedCompletionTokens: row.maxObservedCompletionTokens,
      OutputCapNonBinding: row.capNonBinding, Compatible: row.compatible, Status: row.status, Reason: row.reason,
      CoreSignature: row.coreSignature,
    }));
  }

  function positionRows(analysis) {
    return (analysis.positionDiagnostics || []).map((row) => ({
      AnalysisModelKey: row.modelConfig, BankDatasetID: row.bankDatasetId, BankContentHash: row.bankContentHash,
      Bank: row.bankLabel, ValidRecords: row.recordCount, ObservedPermutationCount: row.observedPermutationCount,
      ObservedPermutationIDs: (row.observedPermutationIds || []).join(";"),
      PermutationCounts: objectText(row.permutationCounts), PermutationProportions: mapText(row.permutationProportions),
      DisplayPosition1TopCount: row.displayTopCounts.opt1, DisplayPosition1TopRate: row.displayTopProportions.opt1,
      DisplayPosition2TopCount: row.displayTopCounts.opt2, DisplayPosition2TopRate: row.displayTopProportions.opt2,
      DisplayPosition3TopCount: row.displayTopCounts.opt3, DisplayPosition3TopRate: row.displayTopProportions.opt3,
      ItemCenteredPosition1TopRate: row.itemCenteredDisplayTopProportions.opt1,
      ItemCenteredPosition2TopRate: row.itemCenteredDisplayTopProportions.opt2,
      ItemCenteredPosition3TopRate: row.itemCenteredDisplayTopProportions.opt3,
      EligibleItemCount: row.eligibleItemCount, PositionBalanceStatus: row.status, Reason: row.reason,
    }));
  }

  function modelVarianceRows(analysis) {
    const row = analysis.reliability && analysis.reliability.varianceDiagnostics;
    if (!row) return [];
    return [{
      Metric: row.name, MeanBetweenModelVariance: row.meanBetweenModelVariance,
      MeanWithinModelVariance: row.meanWithinModelVariance, MatchedItemCount: row.matchedItemCount,
      AnalysisModelKeyCount: row.modelConfigCount, Ratio: row.ratio, RatioStatus: row.ratioStatus,
      Reason: row.reason,
    }];
  }

  function riskSlopeRows(analysis) {
    const rows = [];
    (analysis.factorial && analysis.factorial.analyses || []).filter((entry) => entry.bankId === "risk" && entry.responseSurface).forEach((entry) => {
      (entry.responseSurface.groupFits || []).forEach((fit) => rows.push({
        AnalysisModelKey: entry.modelConfig, BankDatasetID: entry.bankId, CategoryID: entry.categoryId,
        Category: entry.category, GroupID: fit.groupId, BaseProbability: fit.level,
        ...domainFields(fit),
        SlopePer0_01: fit.slopePer01, Fit_R2: fit.r2, Fit_N: fit.fitN,
        CostRate_Min: fit.minX, CostRate_Max: fit.maxX, ConstantOutcome: fit.constantOutcome,
        FitStatus: fit.fitStatus, Eligible: fit.valid, Reason: fit.reason,
      }));
    });
    return rows;
  }

  function analysisSettingsRows(analysis) {
    return [
      { Setting: "AnalysisCoreVersion", Value: "1.7.0", Source: "analysis component" },
      { Setting: "PlannedRepeats", Value: analysis.plannedRepeats, Source: "analysis_config" },
      { Setting: "IncludeRepaired", Value: analysis.options && analysis.options.includeRepaired, Source: "user_switch" },
      { Setting: "ModelIdentityPolicy", Value: "MODEL_IDENTITY_V2", Source: "v1.5.2" },
      { Setting: "MissingConfigResolution", Value: "UNIQUE_VALUE_ONLY_ELSE_BLOCK", Source: "v1.5.2" },
      { Setting: "ApiModeIdentityRole", Value: "TRANSPORT_AUDIT_ONLY", Source: "v1.5.2" },
      { Setting: "Legacy_E_D_Bootstrap", Value: "FROZEN_NOT_RUN", Source: "v1.5.2_frozen_statistics" },
      { Setting: "Human_Gap_Scenario_Resampling", Value: "5000 iterations; seed=20260827; unit=GroupID", Source: "human_reference_v1" },
      { Setting: "SmallGInferenceRefactor", Value: "FROZEN_CURRENT_V1.4.1_BEHAVIOR", Source: "v1.5.2_scope" },
      { Setting: "DFormula", Value: "UNCHANGED_EQUAL_WEIGHT_80_PERCENT_COVERAGE", Source: "v1.5.2_scope" },
      { Setting: "ConditionAggregation", Value: "ItemID_P_Mean_then_equal_weight_items", Source: "v1.5.2" },
      { Setting: "DomainKey", Value: "BankDatasetID::Source_Domain", Source: "domain_analysis_v1" },
      { Setting: "CrossBankDomainSemanticMerge", Value: "DISABLED", Source: "domain_analysis_v1" },
      { Setting: "RiskPrimaryAssumption", Value: "NET_OUTCOME_INTEGRATION", Source: "risk_human_reference_v1" },
      { Setting: "RiskSensitivityAssumption", Value: "SEPARATED_COST", Source: "risk_human_reference_v1" },
      { Setting: "CNIHumanFormalParameter", Value: "METADATA_BLOCKED", Source: "cni_human_reference_v1" },
    ];
  }

  function comparisonRows(analysis) {
    return (analysis.comparisons || []).map((row) => ({
      Bank: row.bankLabel, CategoryID: row.categoryId, Category: row.category,
      ModelA: row.modelA, ModelB: row.modelB, MatchedGroups: row.n,
      MeanDifference: row.difference, CI95_Low: row.ciLow, CI95_High: row.ciHigh,
      PermutationP: row.p, HolmP: row.pHolm,
    }));
  }

  function similarityRows(analysis) {
    const similarity = analysis.similarity || { models: [], matrix: [] };
    return (similarity.models || []).flatMap((modelA, i) => (similarity.models || []).map((modelB, j) => ({
      ModelA: modelA, ModelB: modelB, PearsonR: similarity.matrix[i] && similarity.matrix[i][j],
      SharedCategoryUniverse: (similarity.categories || []).length,
    })));
  }

  function cardRows(analysis) {
    return (analysis.cards || []).map((card) => ({
      Bank: card.bankLabel, CategoryID: card.categoryId, Category: card.category, GroupID: card.groupId,
      ItemIDs: card.itemIds.join(";"), Status: card.status, StatusLabel: card.statusLabel, Records: card.records,
      Models: card.models, ConditionsObserved: card.observedConditions, ConditionsExpected: card.expectedConditions,
      FirstValidRate: card.firstValidRate, FinalValidRate: card.finalValidRate, TopAgreement: card.topAgreement,
      FullRankingAgreement: card.fullAgreement, PositionTopAgreement: card.positionTopAgreement,
      Effects: (card.effects || []).map((effect) => `${effect.contrastId}=${num(effect.effect)}`).join(";"),
      Issues: card.issues.join(";"), Recommendation: card.recommendation,
    }));
  }

  function auditRows(analysis) {
    return (analysis.audit && analysis.audit.checks || []).map((row) => ({
      AuditScore: analysis.audit.score, Check: row.label, Status: row.status, Detail: row.detail, Value: row.value,
    }));
  }

  function recordRows(analysis) {
    return (analysis.records || []).map((row) => ({
      ImportBatchID: row.batchId, ImportBatchName: row.batchName, RunID: row.runId, RequestID: row.requestId,
      AnalysisModelKey: row.modelConfig, RawModelConfigID: row.rawModelConfigId, ModelConfigID: row.modelConfig,
      Model: row.model, BankDatasetID: row.bankDatasetId, BankPartID: row.bankPartId,
      BankContentHash: row.bankContentHash, Bank: row.bankLabel, SecondLevel: row.secondLevel,
      CategoryID: row.categoryId, Category: row.category, GroupID: row.groupId, ItemID: row.itemId,
      Source_ContentDigest: row.sourceContentDigest, ...domainFields(row),
      ConditionCode: row.conditionCode, RepeatIndex: row.repeatIndex, PermutationID: row.permutationId,
      FirstStatus: row.firstStatus, RetryUsed: row.retryUsed ? 1 : 0, FinalStatus: row.finalStatus,
      DisplayedRanking: row.displayedRanking, SourceRanking: row.sourceRanking, LogicalRanking: row.logicalRanking,
      MappingStatus: row.mappingStatus, MappingReason: row.mappingReason, RepeatStatus: row.repeatStatus,
      ItemFormalEligible: row.itemFormalEligible, TopChoice: row.topChoice, Rank_L1: row.rankL1, Rank_L2: row.ranks && row.ranks.L2, Rank_L3: row.rankL3,
      P_Numerator: row.preferenceNumerator, P_Denominator: row.preferenceDenominator, PreferenceScore_P: row.preference,
      ScoreFamily: row.scoreFamily, ConditionStructure: row.conditionStructure, ContrastID: row.contrastId,
      ItemVersion: row.itemVersion, PromptVersion: row.promptVersion, ParserVersion: row.parserVersion, Timestamp: row.timestamp,
    }));
  }

  function interpretationRows(api) {
    return (api && api.rows || []).map((row) => ({
      Decision: row.decision, Bank: row.bankLabel, DecisionDefinition: row.decisionDefinition,
      SecondLevel: row.secondLevel, CategoryID: row.id, Category: row.name, CategoryDefinition: row.definition,
      PositiveP_High: row.directional ? row.high : row.noEffect,
      NegativeP_Low: row.directional ? row.low : row.noEffect,
      PositiveE: interpret(api, "staticEffectText", row, true, "E"),
      NegativeE: interpret(api, "staticEffectText", row, false, "E"),
      PositiveD: interpret(api, "staticEffectText", row, true, "D"),
      NegativeD: interpret(api, "staticEffectText", row, false, "D"),
      AggregationLimit: [row.aggregate, row.noEffect].filter(Boolean).join(" "),
    }));
  }

  function domainCatalogRows(analysis) {
    return (analysis.domain && analysis.domain.catalog || []).map((row) => ({
      BankDatasetID: row.bankDatasetId, BankContentHash: row.bankContentHash, Bank: row.bankLabel,
      Domain: row.domain, DomainRaw: row.domainRaw, DomainKey: row.domainKey,
      Records: row.recordCount, Items: row.itemCount, Groups: row.groupCount,
      Conditions: row.conditionCount, Models: row.modelCount, DomainSources: (row.sourceTypes || []).join(";"),
    }));
  }

  function domainItemAuditRows(analysis) {
    return (analysis.domain && analysis.domain.itemAudit || []).map((row) => ({
      BankDatasetID: row.bankDatasetId, BankContentHash: row.bankContentHash, Bank: row.bankLabel,
      ItemID: row.itemId, GroupID: row.groupId, ConditionCode: row.conditionCode,
      Domain: row.domain, DomainKey: row.domainKey, ObservedDomains: (row.domains || []).join(";"),
      DomainCount: row.domainCount, DomainStatus: row.status, DomainEligible: row.eligible,
      Records: row.recordCount, RepeatIndices: (row.repeatIndices || []).join(";"),
      AnalysisModelKeys: (row.modelConfigs || []).join(";"), DomainSources: (row.domainSources || []).join(";"),
      ItemVersions: (row.itemVersions || []).join(";"), SourceContentDigests: (row.sourceContentDigests || []).join(";"), Reason: row.reason,
    }));
  }

  function domainGroupAuditRows(analysis) {
    return (analysis.domain && analysis.domain.groupAudit || []).map((row) => ({
      AnalysisModelKey: row.modelConfig, BankDatasetID: row.bankDatasetId, BankContentHash: row.bankContentHash,
      Bank: row.bankLabel, CategoryID: row.categoryId, Category: row.category, GroupID: row.groupId,
      Domain: row.domain, DomainKey: row.domainKey, GroupDomains: (row.groupDomains || []).join(";"),
      DomainCount: row.domainCount, DomainStatus: row.status, DomainEligible: row.eligible,
      ConditionDomains: objectText(row.conditions), ItemIDs: (row.itemIds || []).join(";"),
      BlockedItemIDs: (row.blockedItemIds || []).join(";"), Reason: row.reason,
    }));
  }

  function domainReliabilityRows(analysis) {
    return (analysis.domain && analysis.domain.reliabilitySummary || []).map((row) => ({
      AnalysisModelKey: row.modelConfig, BankDatasetID: row.bankDatasetId, BankContentHash: row.bankContentHash,
      Bank: row.bankLabel, Domain: row.domain, DomainKey: row.domainKey,
      DomainStatus: row.domainStatus, DomainEligible: row.domainEligible,
      ItemCount: row.itemCount, DirectionalItemCount: row.directionalItemCount,
      MeanKendallTau: row.meanKendallTau, MeanP_SD: row.meanPSd,
      MeanTopChoiceAgreement: row.meanTopChoiceAgreement, MeanFullRankingAgreement: row.meanFullRankingAgreement,
      DirectionFlipCount: row.directionFlipCount, DirectionFlipRate: row.directionFlipRate,
    }));
  }

  function domainConditionRows(analysis) {
    return (analysis.domain && analysis.domain.conditionProfile || []).map((row) => ({
      AnalysisModelKey: row.modelConfig, BankDatasetID: row.bankDatasetId, BankContentHash: row.bankContentHash,
      Bank: row.bankLabel, CategoryID: row.categoryId, Category: row.category,
      Domain: row.domain, DomainKey: row.domainKey, ConditionCode: row.conditionCode,
      MeanP: row.meanP, SD_P: row.sdP, ItemCount: row.itemCount, ValidN: row.validN,
      GroupCount: row.groupCount, GroupIDs: (row.groupIds || []).join(";"), DomainStatus: row.domainStatus, DomainEligible: row.domainEligible,
    }));
  }

  function domainEffectRows(analysis) {
    return (analysis.domain && analysis.domain.effectProfile || []).map((row) => ({
      AnalysisModelKey: row.modelConfig, BankDatasetID: row.bankDatasetId, BankContentHash: row.bankContentHash,
      Bank: row.bankLabel, CategoryID: row.categoryId, Category: row.category, ContrastID: row.contrastId,
      GroupID: row.groupId, Domain: row.domain, DomainKey: row.domainKey,
      RawShift: row.rawShift, E: row.effect, Eligible: row.valid, Reason: row.reason,
      DomainStatus: row.domainStatus, DomainEligible: row.domainEligible,
      FormalD: false, AnalysisStatus: "DESCRIPTIVE_EXPLORATORY_SUBSET",
    }));
  }

  function domainHeterogeneityRows(analysis) {
    return (analysis.domain && analysis.domain.heterogeneity || []).map((row) => ({
      AnalysisModelKey: row.modelConfig, BankDatasetID: row.bankDatasetId, Bank: row.bankLabel,
      CategoryID: row.categoryId, Category: row.category, ContrastID: row.contrastId,
      DomainCount: row.domainCount, Domains: (row.domains || []).map((item) => `${item.domain}=${num(item.meanE)}`).join(";"), Min: row.min,
      Max: row.max, Range: row.range, SD: row.sd, IQR: row.iqr,
      PositiveDomainCount: row.positiveDomainCount, NegativeDomainCount: row.negativeDomainCount,
      ZeroDomainCount: row.zeroDomainCount, DirectionConsistency: row.directionConsistency,
      MetricName: "Domain Heterogeneity Summary", FormalTest: false,
    }));
  }

  function domainNonDirectionalRows(analysis) {
    return (analysis.domain && analysis.domain.nonDirectionalProfile || []).map((row) => ({
      AnalysisModelKey: row.modelConfig, BankDatasetID: row.bankDatasetId, BankContentHash: row.bankContentHash,
      Bank: row.bankLabel, CategoryID: row.categoryId, Category: row.category,
      Domain: row.domain, DomainKey: row.domainKey, ConditionCode: row.conditionCode,
      GroupID: row.groupId, GroupIDs: (row.groupIds || []).join(";"), GroupCount: row.groupCount,
      ScoreFamily: row.scoreFamily, ValidN: row.n,
      L1TopRate: row.topProportions && row.topProportions.L1, L2TopRate: row.topProportions && row.topProportions.L2,
      L3TopRate: row.topProportions && row.topProportions.L3,
      MeanRankL1: row.meanRanks && row.meanRanks.L1, MeanRankL2: row.meanRanks && row.meanRanks.L2,
      MeanRankL3: row.meanRanks && row.meanRanks.L3,
      DomainStatus: row.domainStatus, DomainEligible: row.domainEligible,
    }));
  }

  function domainMetadataRows(analysis) {
    return (analysis.domain && analysis.domain.metadataManifest || []).map((row) => ({
      BankDatasetID: row.bankDatasetId, BankContentHash: row.bankContentHash,
      DomainMetadataHash: row.domainMetadataHash, DomainCount: row.domainCount,
      ItemCount: row.itemCount,
      BankContentHashCompatibility: "UNCHANGED",
    }));
  }

  function humanManifestRows(analysis) {
    const human = analysis.humanReference || {};
    const manifest = human.manifest || {};
    return (manifest.files || []).map((row) => ({
      ReferenceType: manifest.referenceType, HumanReferenceVersion: manifest.version,
      BankDatasetID: row.bankDatasetId, Path: row.path, SourceWorkbook: row.sourceWorkbook,
      Participants: row.participants, Items: row.items, Rows: row.rows,
      ExactStimulusMatches: row.exactStimulusMatches, SHA256: row.sha256,
      ParticipantPrivacyRule: manifest.privacy && manifest.privacy.participantId,
      RawWorkbooksDistributed: manifest.privacy && manifest.privacy.rawWorkbooksDistributed,
      SourceContentDigestAlgorithm: manifest.stimulusDigest && manifest.stimulusDigest.algorithm,
      SourceContentDigestCompatibility: manifest.stimulusDigest && manifest.stimulusDigest.compatibility,
    }));
  }

  function humanMatchRows(analysis) {
    return (analysis.humanReference && analysis.humanReference.matchAudit || []).map((row) => ({
      ReferenceType: row.referenceType, BankDatasetID: row.bankDatasetId, BankContentHash: row.bankContentHash,
      ItemID: row.itemId, GroupID: row.groupId, CategoryID: row.categoryId, ConditionCode: row.conditionCode,
      Domain: row.domain, DomainKey: row.domainKey, HumanItemVersion: row.humanItemVersion,
      AIItemVersion: row.aiItemVersion, HumanContentDigest: row.humanContentDigest,
      AIContentDigest: row.aiContentDigest, Participants: row.participantCount, Rows: row.rowCount,
      StimulusMatchStatus: row.stimulusMatchStatus, Eligible: row.eligible,
      Mismatches: (row.mismatches || []).join(";"), Reason: row.reason,
    }));
  }

  function humanConditionRows(analysis) {
    return (analysis.humanReference && analysis.humanReference.conditionMeans || []).map((row) => ({
      ReferenceType: row.referenceType, BankDatasetID: row.bankDatasetId, BankContentHash: row.bankContentHash,
      CategoryID: row.categoryId, Category: row.category, GroupID: row.groupId,
      ConditionCode: row.conditionCode, Condition: row.condition, ConditionStructure: row.conditionStructure,
      Domain: row.domain, DomainKey: row.domainKey, HumanMeanP: row.humanMeanP, HumanSD_P: row.humanSdP,
      ParticipantCount: row.participantCount, ItemCount: row.itemCount, HumanRows: row.humanRows,
      Aggregation: "participant-within-cell item equal weight, then participant equal weight",
    }));
  }

  function humanGapGroupRows(analysis) {
    return (analysis.humanReference && analysis.humanReference.groupGaps || []).map((row) => ({
      ReferenceType: row.referenceType, AnalysisModelKey: row.modelConfig,
      BankDatasetID: row.bankDatasetId, BankContentHash: row.bankContentHash, Bank: row.bankLabel,
      CategoryID: row.categoryId, Category: row.category, GroupID: row.groupId, ContrastID: row.contrastId,
      Domain: row.domain, DomainKey: row.domainKey, DomainStatus: row.domainStatus, DomainEligible: row.domainEligible,
      ContrastWeights: mapText(row.weights), AI_RawShift: row.aiRawShift, Human_RawShift: row.humanRawShift,
      GapDeltaP: row.gapDeltaP, AI_E: row.aiE, Human_E: row.humanE, GapE: row.gapE,
      HumanParticipantCount: row.humanParticipantCount, MissingHumanConditions: (row.missingHumanConditions || []).join(";"),
      Computable: row.computable, Reason: row.reason,
    }));
  }

  function humanGapSummaryRows(analysis) {
    return (analysis.humanReference && analysis.humanReference.gapSummaries || []).map((row) => ({
      ReferenceType: row.referenceType, AnalysisModelKey: row.modelConfig,
      BankDatasetID: row.bankDatasetId, BankContentHash: row.bankContentHash, Bank: row.bankLabel,
      CategoryID: row.categoryId, Category: row.category, ContrastID: row.contrastId,
      MeanAI_RawShift: row.meanAiRawShift, MeanHuman_RawShift: row.meanHumanRawShift,
      GapDeltaP: row.gapDeltaP, MeanAI_E: row.meanAiE, MeanHuman_E: row.meanHumanE,
      GapE: row.gapE, GapD: row.gapD, DescriptiveGapE: row.descriptiveGapE,
      ValidGroups: row.validGroups, ObservedGroups: row.observedGroups, PlannedGroups: row.plannedGroups,
      Coverage: row.coverage, PositiveGroups: row.positiveGroupCount, NegativeGroups: row.negativeGroupCount, ZeroGroups: row.zeroGroupCount,
      ScenarioResamplingInterval95_Low: row.scenarioResamplingInterval95Low,
      ScenarioResamplingInterval95_High: row.scenarioResamplingInterval95High,
      ScenarioResamplingSD: row.scenarioResamplingSd, ScenarioIterations: row.scenarioIterations,
      ScenarioSeed: row.scenarioSeed, ScenarioMethod: row.scenarioMethod,
      LegacyEDBootstrap: row.legacyEDBootstrap, Computable: row.computable, Reason: row.reason,
    }));
  }

  function humanDomainGapRows(analysis) {
    return (analysis.humanReference && analysis.humanReference.domainGapSummaries || []).map((row) => ({
      ReferenceType: row.referenceType, AnalysisModelKey: row.modelConfig,
      BankDatasetID: row.bankDatasetId, BankContentHash: row.bankContentHash, Bank: row.bankLabel,
      CategoryID: row.categoryId, Category: row.category, ContrastID: row.contrastId,
      Domain: row.domain, DomainKey: row.domainKey, GroupCount: row.groupCount, GroupIDs: (row.groupIds || []).join(";"),
      AI_RawShift: row.aiRawShift, Human_RawShift: row.humanRawShift, GapDeltaP: row.gapDeltaP,
      AI_E: row.aiE, Human_E: row.humanE, GapE: row.gapE,
      ScenarioResamplingInterval95_Low: row.scenarioResamplingInterval95Low,
      ScenarioResamplingInterval95_High: row.scenarioResamplingInterval95High,
      ScenarioIterations: row.scenarioIterations, ScenarioSeed: row.scenarioSeed,
      IntervalComputable: row.intervalComputable, IntervalReason: row.intervalReason,
      InferenceStatus: row.inferenceStatus,
    }));
  }

  function humanNominalRows(analysis) {
    return (analysis.humanReference && analysis.humanReference.nominalDistributions || []).map((row) => ({
      ReferenceType: row.referenceType, AnalysisModelKey: row.modelConfig,
      BankDatasetID: row.bankDatasetId, BankContentHash: row.bankContentHash, Bank: row.bankLabel,
      CategoryID: row.categoryId, Category: row.category, GroupID: row.groupId,
      ConditionCode: row.conditionCode, Domain: row.domain, DomainKey: row.domainKey,
      AI_L1TopRate: row.ai && row.ai.l1Top, AI_L2TopRate: row.ai && row.ai.l2Top,
      AI_L3TopRate: row.ai && row.ai.l3Top, Human_L1TopRate: row.human && row.human.l1Top,
      Human_L2TopRate: row.human && row.human.l2Top, Human_L3TopRate: row.human && row.human.l3Top,
      L1ProportionGap: row.l1TopGap, L2ProportionGap: row.l2TopGap, L3ProportionGap: row.l3TopGap,
      AI_MeanRankL1: row.ai && row.ai.meanRankL1, AI_MeanRankL2: row.ai && row.ai.meanRankL2,
      AI_MeanRankL3: row.ai && row.ai.meanRankL3, Human_MeanRankL1: row.human && row.human.meanRankL1,
      Human_MeanRankL2: row.human && row.human.meanRankL2, Human_MeanRankL3: row.human && row.human.meanRankL3,
      ScoreFamily: "NOMINAL_RANK", P_Applicable: false, E_Applicable: false,
    }));
  }

  function humanSingleRows(analysis) {
    return (analysis.humanReference && analysis.humanReference.singleLevelComparisons || []).map((row) => ({
      ReferenceType: row.referenceType, AnalysisModelKey: row.modelConfig,
      BankDatasetID: row.bankDatasetId, BankContentHash: row.bankContentHash, Bank: row.bankLabel,
      CategoryID: row.categoryId, Category: row.category, GroupID: row.groupId,
      ConditionCode: row.conditionCode, Domain: row.domain, DomainKey: row.domainKey,
      AI_MeanP: row.aiMeanP, Human_MeanP: row.humanMeanP, AIHumanPLevelDifference: row.aiHumanPLevelDifference,
      AI_L1TopRate: row.aiTop && row.aiTop.l1Top, AI_L2TopRate: row.aiTop && row.aiTop.l2Top, AI_L3TopRate: row.aiTop && row.aiTop.l3Top,
      Human_L1TopRate: row.humanTop && row.humanTop.l1Top, Human_L2TopRate: row.humanTop && row.humanTop.l2Top, Human_L3TopRate: row.humanTop && row.humanTop.l3Top,
      AI_MeanRankL1: row.aiTop && row.aiTop.meanRankL1, AI_MeanRankL2: row.aiTop && row.aiTop.meanRankL2,
      AI_MeanRankL3: row.aiTop && row.aiTop.meanRankL3, Human_MeanRankL1: row.humanTop && row.humanTop.meanRankL1,
      Human_MeanRankL2: row.humanTop && row.humanTop.meanRankL2, Human_MeanRankL3: row.humanTop && row.humanTop.meanRankL3,
      ComparisonType: row.comparisonType, GapDeltaP: null, Reason: row.reason,
    }));
  }

  function cniHumanRows(analysis) {
    const cni = analysis.humanReference && analysis.humanReference.cniDescriptive || {};
    const comparisons = (cni.comparisons || []).map((row) => ({
      Table: "ExploratoryPairL1AboveL2", ReferenceType: row.referenceType, AnalysisModelKey: row.modelConfig,
      BankDatasetID: row.bankId, GroupID: row.groupId, ContrastID: row.contrastId,
      Domain: row.domain, DomainKey: row.domainKey, AI_Negative: row.aiNegative, AI_Positive: row.aiPositive,
      Human_Negative: row.humanNegative, Human_Positive: row.humanPositive,
      AI_DescriptiveDifference: row.aiDescriptiveDifference, Human_DescriptiveDifference: row.humanDescriptiveDifference,
      AIHumanDescriptiveGap: row.aiHumanDescriptiveGap, FormalComputable: row.formalComputable,
      Status: row.status, AnalysisStatus: row.analysisStatus, ParameterStatus: row.parameterStatus, Reason: row.reason,
    }));
    const l3 = (cni.l3Top || []).map((row) => ({
      Table: "L3Top", ReferenceType: row.referenceType, AnalysisModelKey: row.modelConfig,
      BankDatasetID: row.bankId, BankContentHash: row.bankContentHash,
      Domain: row.domain, DomainKey: row.domainKey, ConditionCode: row.conditionCode,
      AI_L3TopRate: row.aiL3TopRate, Human_L3TopRate: row.humanL3TopRate,
      L3TopRateGap: row.l3TopRateGap, FormalComputable: false,
      Status: row.status, AnalysisStatus: "EXPLORATORY", ParameterStatus: "NOT_FORMAL_CNI_PARAMETER",
    }));
    return comparisons.concat(l3);
  }

  function riskReferenceParameterRows(analysis) {
    return (analysis.riskReference && analysis.riskReference.referenceParameters || []).map((row) => ({
      ReferenceType: row.referenceType, ReferenceVersion: row.referenceVersion, Citation: row.citation,
      CategoryID: row.categoryId, BaseProbability: row.baseProbability, Assumption: row.assumption,
      FormulaID: row.formulaId, HumanReference: row.humanReference, Primary: row.primary,
    }));
  }

  function riskCurveRows(analysis) {
    return (analysis.riskReference && analysis.riskReference.curvePoints || []).map((row) => ({
      AnalysisModelKey: row.modelConfig, BankDatasetID: row.bankDatasetId,
      CategoryID: row.categoryId, Category: row.category, GroupID: row.groupId, CurveScope: row.curveScope,
      ComparisonLevel: row.comparisonLevel,
      Domain: row.domain, DomainKey: row.domainKey, DomainStatus: row.domainStatus, DomainEligible: row.domainEligible,
      DomainSource: row.domainSource,
      ReferenceApplicability: row.referenceApplicability, BaseProbability: row.baseProbability,
      XFactor: row.xFactor, X: row.x, MeanP: row.meanP, SD_P: row.sdP, MinP: row.minP, MaxP: row.maxP,
      ValidN: row.validN, ItemCount: row.itemCount, RawBinaryRate: row.rawBinaryRate,
      PlannedRepeats: row.plannedRepeats, MinimumValidRepeats: row.minimumValidRepeats,
      PlannedItemCount: row.plannedItemCount, EligibleItemCount: row.eligibleItemCount,
      PlannedGroupCount: row.plannedGroupCount, ObservedGroupCount: row.observedGroupCount, EligibleGroupCount: row.eligibleGroupCount,
      ExpectedPointCount: row.expectedPointCount, FormalEligible: row.formalEligible, FormalEligibilityReason: row.formalEligibilityReason,
      IsotonicP: row.isotonicP, L2TopRate: row.l2TopRate, RankingCounts: objectText(row.rankingCounts),
      RankingProportions: mapText(row.rankingProportions), RankingAggregation: row.rankingAggregation,
    }));
  }

  function riskThresholdRows(analysis) {
    return (analysis.riskReference && analysis.riskReference.thresholds || []).map((row) => ({
      ReferenceType: "LITERATURE_DERIVED_REFERENCE", AnalysisModelKey: row.modelConfig,
      BankDatasetID: row.bankDatasetId, CategoryID: row.categoryId, Category: row.category,
      GroupID: row.groupId, CurveScope: row.curveScope, Domain: row.domain, DomainKey: row.domainKey,
      DomainStatus: row.domainStatus, DomainEligible: row.domainEligible,
      ReferenceApplicability: row.referenceApplicability, BaseProbability: row.baseProbability,
      XFactor: row.xFactor, ExpectedDirection: row.expectedDirection,
      ThresholdName: "P=0排序倾向拐点", ThresholdStatus: row.thresholdStatus, ThresholdReason: row.thresholdReason,
      LowerTestedPoint: row.thresholdLowTested, UpperTestedPoint: row.thresholdHighTested,
      InterpolatedEstimate: row.thresholdEstimate, ThresholdInequality: row.thresholdInequality,
      ThresholdDiagnosticStatus: row.thresholdDiagnosticStatus, RawCrossingCount: row.rawCrossingCount, IsotonicStatus: row.isotonicStatus,
      IsotonicEstimate: row.isotonicEstimate, IsotonicRole: row.isotonicRole,
      HumanReference: row.humanReference, HumanReferenceAssumption: row.humanReferenceAssumption,
      DifferenceFromHuman: row.differenceFromHuman, PointCount: row.pointCount,
      EligiblePointCount: row.eligiblePointCount, ExpectedPointCount: row.expectedPointCount,
      CoverageComplete: row.coverageComplete, CoverageReason: row.coverageReason,
      PlannedGroupCount: row.plannedGroupCount, MinimumValidRepeats: row.minimumValidRepeats, ValidN: row.validN,
    }));
  }

  function riskBinaryRows(analysis) {
    return (analysis.riskReference && analysis.riskReference.binaryRobustness || []).map((row) => ({
      AnalysisModelKey: row.modelConfig, BankDatasetID: row.bankId, CategoryID: row.categoryId,
      Category: row.category, GroupID: row.groupId, CurveScope: row.curveScope,
      Domain: row.domain, DomainKey: row.domainKey, BaseProbability: row.baseProbability,
      RawBinaryStatus: row.rawBinaryStatus, RawBinaryThreshold: row.rawBinaryThreshold,
      RawBinaryLowerTested: row.rawBinaryLowTested, RawBinaryUpperTested: row.rawBinaryHighTested,
      LogisticStatus: row.logisticStatus, LogisticReason: row.logisticReason,
      LogisticThreshold: row.logisticThreshold, LogisticSlope: row.logisticSlope, LogisticRole: row.logisticRole,
      BinaryBridgeThreshold: row.binaryBridgeThreshold, BinaryBridgeSource: row.binaryBridgeSource,
      BinaryBridgeDifferenceFromHuman: row.binaryBridgeDifferenceFromHuman,
      PThreshold: row.pThreshold, PvsBinaryDifference: row.pVsBinaryDifference, PvsLogisticDifference: row.pVsLogisticDifference,
      CoverageComplete: row.coverageComplete, EligiblePointCount: row.eligiblePointCount, ExpectedPointCount: row.expectedPointCount,
    }));
  }

  function riskRankingRows(analysis) {
    return (analysis.riskReference && analysis.riskReference.rankingDistributions || []).map((row) => ({
      AnalysisModelKey: row.modelConfig, BankDatasetID: row.bankId, CategoryID: row.categoryId,
      Category: row.category, GroupID: row.groupId, CurveScope: row.curveScope, ComparisonLevel: row.comparisonLevel,
      Domain: row.domain, DomainKey: row.domainKey,
      BaseProbability: row.baseProbability, XFactor: row.xFactor, X: row.x,
      ValidN: row.validN, L2TopRate: row.l2TopRate,
      ModalRanking: row.modalRanking, ModalProportion: row.modalProportion, ModalCount: row.modalCount,
      FormalEligible: row.formalEligible, RankingAggregation: row.rankingAggregation,
      RankingCounts: objectText(row.rankingCounts), RankingProportions: mapText(row.rankingProportions),
    }));
  }

  function categoryEffectSizeRows(analysis) {
    return (analysis.effectSizes && analysis.effectSizes.categoryEffectSizes || []).map((row) => ({
      AnalysisModelKey: row.modelConfig, BankDatasetID: row.bankDatasetId, BankContentHash: row.bankContentHash,
      Bank: row.bankLabel, CategoryID: row.categoryId, Category: row.category, ContrastID: row.contrastId,
      D: row.dScore, MeanE: row.meanE, SD_E: row.sdE, ValidGroups: row.validGroups,
      PlannedGroups: row.plannedGroups, Coverage: row.coverage, DF: row.df,
      CohenD: row.cohenD, HedgesG: row.hedgesG, HedgesCorrection: row.hedgesCorrection,
      EffectLabel: row.effectLabel, CeilingFloor: row.ceilingFloor, Computable: row.computable, Reason: row.reason,
    }));
  }

  function modelEffectSizeRows(analysis) {
    return (analysis.effectSizes && analysis.effectSizes.effectModelComparisons || []).map((row) => ({
      BankDatasetID: row.bankDatasetId, Bank: row.bankLabel, CategoryID: row.categoryId,
      Category: row.category, ContrastID: row.contrastId, ModelA: row.modelA, ModelB: row.modelB,
      MatchedGroupIDs: (row.matchedGroupIds || []).join(";"), ValidPairs: row.validPairs,
      MeanDiff: row.meanDiff, SD_Diff: row.sdDiff, DF: row.df,
      CohenDz: row.cohenDz, HedgesGz: row.hedgesGz, HedgesCorrection: row.hedgesCorrection,
      EffectLabel: row.effectLabel, Computable: row.computable, Reason: row.reason,
    }));
  }

  function iccRows(analysis) {
    const icc = analysis.icc || {};
    const within = (icc.withinAiProfiles || []).map((row) => ({
      ICCType: row.iccType, Estimand: row.estimand, Scope: row.scope, AnalysisModelKey: row.modelConfig,
      BankDatasetID: row.bankDatasetId, Bank: row.bankLabel, CategoryID: row.categoryId,
      Category: row.category, Domain: row.domain, DomainKey: row.domainKey,
      ScoreFamily: row.scoreFamily, TargetCount: row.targetCount, Repetitions: row.repetitions,
      ICC_1_1: row.icc11, ICC_1_K: row.icc1k, MS_Between: row.msBetween, MS_Within: row.msWithin,
      SigmaTarget: row.sigmaTarget, SigmaError: row.sigmaError,
      Computable: row.computable, Status: row.status, Reason: row.reason,
      DBWVR_PreservedAs: icc.varianceDiagnosticsPreservedAs,
    }));
    const cross = (icc.crossAiCoreEffects || []).map((row) => ({
      ICCType: row.iccType, Estimand: row.estimand, Scope: row.scope,
      BankDatasetID: row.bankDatasetId, Bank: row.bankLabel, CategoryID: row.categoryId,
      Category: row.category, ContrastID: row.contrastId, GroupID: row.groupId,
      Domain: row.domain, DomainKey: row.domainKey, DomainEligible: row.domainEligible,
      ThetaType: row.thetaType, ModelCount: row.modelCount, EligibleModelCount: row.eligibleModelCount,
      Models: (row.models || []).join(";"), Repetitions: row.repetitions,
      ICC_1_1: row.icc11, ICC_1_K: row.icc1k, MS_Between: row.msBetween, MS_Within: row.msWithin,
      SigmaTarget: row.sigmaTarget, SigmaError: row.sigmaError,
      Computable: row.computable, Status: row.status, Reason: row.reason,
      InterpretationCaution: row.interpretationCaution, DBWVR_PreservedAs: icc.varianceDiagnosticsPreservedAs,
    }));
    return within.concat(cross);
  }

  function iccThetaRows(analysis) {
    return (analysis.icc && analysis.icc.thetaByRepeat || []).map((row) => ({
      AnalysisModelKey: row.modelConfig, BankDatasetID: row.bankDatasetId, BankContentHash: row.bankContentHash,
      Bank: row.bankLabel, CategoryID: row.categoryId, Category: row.category,
      GroupID: row.groupId, ContrastID: row.contrastId, RepeatIndex: row.repeatIndex,
      ThetaType: row.thetaType, Theta: row.theta, Domain: row.domain, DomainKey: row.domainKey,
      DomainEligible: row.domainEligible, Computable: row.computable, Reason: row.reason,
    }));
  }

  const DATASET_INFO = [
    ["run_manifest", "结果批次清单", "导入批次、两个必需CSV、RunID与分析配置固定的计划重复数"],
    ["run_summary", "运行与总体指标", "全部模型、记录数、有效率、重复次数、题库目录动态合并、审计与注册表规模"],
    ["analysis_settings", "分析设置", "版本、固定重复数、修复回答开关和本版统计冻结项"],
    ["dataset_manifest", "题库数据集清单", "BankDatasetID、互补BankPart、内容指纹和组成冲突"],
    ["model_config_audit", "模型配置审计", "MODEL_IDENTITY_V2唯一值补全、歧义阻断、明确配置差异、接口协议与输出上限审计"],
    ["status_distribution", "回答状态分布", "首次状态与最终状态的完整频数"],
    ["analysis_readiness", "分析就绪度", "质量、映射、效应、重复、模型区分与链路模块状态"],
    ["layered_quality", "分层数据质量", "批次、模型、子测验和三级分类的有效率、重试与技术失败"],
    ["preference_p", "单次偏好分 P", "全部记录的逻辑排序、秩、P分子分母、纳入状态与解释"],
    ["mapping_audit", "排序映射审计", "DisplayedRanking、SourceRanking、LogicalRanking及多路径冲突状态"],
    ["item_repeat_summary", "ItemID重复汇总", "每题P均值/标准差、排序一致性、严格重复状态、排列和五次追溯"],
    ["repeat_audit", "重复完整性审计", "固定RepeatIndex 1—5的缺失、重复、超额、元数据和映射阻断"],
    ["condition_mean_p", "条件内平均 P", "模型×题组×条件的P̄、重复覆盖与解释"],
    ["condition_summary", "条件汇总", "先算ItemID P_Mean再对ItemID等权的条件统计、SD与完整性"],
    ["group_mean_p", "题组平均 P", "形成三级分类画像前的GroupID等权统计单元"],
    ["category_profile_p", "分类偏好画像", "全部模型和三级分类的平均P、区间、覆盖与解释"],
    ["category_top_choice", "分类首选分布", "各三级分类L1/L2/L3成为第一顺位的频数和比例"],
    ["group_effect_e", "题组条件效应 E", "全部预登记题组对比的权重、代入公式、E、阻断原因和解释"],
    ["category_mean_e_d", "平均 E 与分类 D", "分类汇总、置信区间、覆盖、方向复现、检验及E/D解释"],
    ["metric_coverage", "正式分类与指标覆盖", "全部计分单元的P/E/D适用性、计划与观察覆盖及运行状态"],
    ["registered_contrasts", "预登记对比注册表", "全部模型×分类×ContrastID的权重、覆盖、平均E与D"],
    ["factorial_results", "FACTORIAL结果", "设计识别、因子单元、预登记效应、简单斜率及多结果变量主效应与交互"],
    ["risk_slope_diagnostics", "风险斜率诊断", "GroupID×基础概率的斜率、R²、N、成本范围和常数响应状态"],
    ["non_directional_results", "非方向评分", "NOMINAL_RANK与CUSTOM的首选率、平均排名和排序分布"],
    ["repeat_reliability", "重复与位置稳健性", "ItemID级首选一致、完整排序一致、Kendall tau和排列覆盖"],
    ["position_randomization_diagnostics", "位置随机化诊断", "六种PermutationID及显示位置1/2/3成为首选的总体和ItemID控制比例"],
    ["model_variance_diagnostics", "模型方差描述诊断", "按BankDatasetID×ItemID匹配的模型间/模型内描述性方差比"],
    ["model_comparisons", "配对模型差异", "共享GroupID上的模型均值差、区间、置换p与Holm校正"],
    ["profile_similarity", "模型画像相似性", "所有模型两两画像Pearson相关矩阵"],
    ["item_quality_cards", "题目质量决策卡", "全部GroupID的数据问题、稳定性证据、处理状态和建议"],
    ["audit_checks", "链路审计", "两个必需CSV、排序复合键、AnalysisModelKey、固定重复数和评分映射核验"],
    ["analysis_records", "标准化分析明细", "全部运行记录的批次、请求、状态、映射、P与版本字段"],
    ["domain_catalog", "Domain目录", "按BankDatasetID隔离的Source_Domain原始标签、覆盖与来源"],
    ["domain_item_audit", "Item Domain审计", "同一ItemID跨Repeat的Domain缺失、冲突与严格匹配状态"],
    ["domain_group_audit", "Group Domain审计", "HOMOGENEOUS、MIXED与MISSING题组状态；混合题组不删除旧统计"],
    ["domain_metadata_manifest", "Domain元数据版本", "独立DomainMetadataHash；不改变BankContentHash语义"],
    ["domain_reliability_summary", "Domain重复信度", "按Domain汇总Kendall tau、P_SD、一致率与DirectionFlip"],
    ["domain_condition_profile", "Domain条件画像", "同一Bank×Category×Condition下各Domain的P描述统计"],
    ["domain_effect_profile", "Domain题组E画像", "单一Domain题组的正式旧E附加Domain；不重算正式D"],
    ["domain_heterogeneity", "Domain异质性描述", "Domain间最小、最大、范围、SD、IQR与方向一致性"],
    ["domain_non_directional_profile", "Domain名义策略画像", "NOMINAL/CUSTOM在Domain×Condition下的策略分布"],
    ["human_reference_manifest", "Human参照清单", "同题Human派生文件、隐私规则、摘要算法与版本"],
    ["human_match_audit", "Human严格匹配审计", "ItemVersion、ConditionCode和Source_ContentDigest的同题匹配"],
    ["human_condition_means", "Human条件均值", "先参与者内Item等权，再跨参与者等权的P条件均值"],
    ["human_gap_group", "Human题组Gap", "同一预登记权重下AI/Human ΔP、E与Gap"],
    ["human_gap_summary", "Human分类Gap", "匹配覆盖、GapD与独立GroupID情境重采样区间"],
    ["human_domain_gap", "Domain Human Gap", "单一Domain题组的AI/Human差异；单Group不伪造区间"],
    ["human_single_level_comparison", "Human单条件比较", "B3等SINGLE题的P水平、首选率与平均名次比较"],
    ["human_nominal_distribution", "Human名义策略比较", "A3E/B5等NOMINAL题的策略比例与比例差"],
    ["cni_human_descriptive", "CNI Human探索比较", "L1/L2描述性条件差与L3首选；正式C/N/I持续阻断"],
    ["risk_reference_parameters", "风险文献参照参数", "论文参数经显式公式换算的复合行为外部参照"],
    ["risk_curve_points", "风险原始曲线", "ItemID-first后按应用情境等权的综合/分情境曲线、覆盖与isotonic敏感性值"],
    ["risk_threshold_comparison", "风险拐点比较", "真实跨零区间、插值、非单调/范围外状态及文献差值"],
    ["risk_binary_robustness", "风险二元稳健性", "原始Y比例与Logistic分离、反向和范围外诊断"],
    ["risk_domain_thresholds", "风险Domain拐点", "单一Domain风险题组的拐点、适用性与外部参照"],
    ["risk_ranking_distribution", "风险完整排序诊断", "每个真实横轴点的六种完整排序、L2首选与众数排序；不跨成本水平混合"],
    ["category_effect_sizes", "分类标准化效应量", "以Group E样本SD计算Cohen d与Hedges g；D保持原义"],
    ["model_effect_sizes", "模型E配对效应量", "相同Group E配对差的Cohen dz与Hedges gz"],
    ["icc_results", "ICC结果", "独立ICC(1,5)结果；不改名或替换DBWVR"],
    ["icc_theta_by_repeat", "ICC逐Repeat核心效应", "合法DIRECTIONAL预登记E的逐Repeat theta诊断"],
    ["interpretation_dictionary", "P/E/D解释字典", "全部决策、二级维度和三级分类的高低方向与汇总限制"],
    ["formula_dictionary", "公式字典", "平台展示的全部统计公式及适用说明"],
    ["scoring_routes", "结构与评分路由", "各ConditionStructure/ScoreFamily可计算与禁止计算的指标"],
  ];

  function buildDatasets(analysis, interpretationApi, extras = {}) {
    if (!analysis) return [];
    const rowsById = {
      run_manifest: runManifestRows(analysis),
      run_summary: runSummaryRows(analysis),
      analysis_settings: analysisSettingsRows(analysis),
      dataset_manifest: datasetRows(analysis),
      model_config_audit: modelConfigAuditRows(analysis),
      status_distribution: statusRows(analysis),
      analysis_readiness: readinessRows(analysis),
      layered_quality: qualityRows(analysis),
      preference_p: pRows(analysis, interpretationApi),
      mapping_audit: mappingRows(analysis),
      item_repeat_summary: itemRepeatRows(analysis),
      repeat_audit: repeatAuditRows(analysis),
      condition_mean_p: conditionMeanRows(analysis, interpretationApi),
      condition_summary: conditionMeanRows(analysis, interpretationApi),
      group_mean_p: groupMeanRows(analysis, interpretationApi),
      category_profile_p: profileRows(analysis, interpretationApi),
      category_top_choice: topChoiceRows(analysis),
      group_effect_e: eRows(analysis, interpretationApi),
      category_mean_e_d: dRows(analysis, interpretationApi),
      metric_coverage: coverageRows(analysis),
      registered_contrasts: contrastRows(analysis, interpretationApi),
      factorial_results: factorialRows(analysis, interpretationApi),
      risk_slope_diagnostics: riskSlopeRows(analysis),
      non_directional_results: nominalRows(analysis),
      repeat_reliability: reliabilityRows(analysis),
      position_randomization_diagnostics: positionRows(analysis),
      model_variance_diagnostics: modelVarianceRows(analysis),
      model_comparisons: comparisonRows(analysis),
      profile_similarity: similarityRows(analysis),
      item_quality_cards: cardRows(analysis),
      audit_checks: auditRows(analysis),
      analysis_records: recordRows(analysis),
      domain_catalog: domainCatalogRows(analysis),
      domain_item_audit: domainItemAuditRows(analysis),
      domain_group_audit: domainGroupAuditRows(analysis),
      domain_metadata_manifest: domainMetadataRows(analysis),
      domain_reliability_summary: domainReliabilityRows(analysis),
      domain_condition_profile: domainConditionRows(analysis),
      domain_effect_profile: domainEffectRows(analysis),
      domain_heterogeneity: domainHeterogeneityRows(analysis),
      domain_non_directional_profile: domainNonDirectionalRows(analysis),
      human_reference_manifest: humanManifestRows(analysis),
      human_match_audit: humanMatchRows(analysis),
      human_condition_means: humanConditionRows(analysis),
      human_gap_group: humanGapGroupRows(analysis),
      human_gap_summary: humanGapSummaryRows(analysis),
      human_domain_gap: humanDomainGapRows(analysis),
      human_single_level_comparison: humanSingleRows(analysis),
      human_nominal_distribution: humanNominalRows(analysis),
      cni_human_descriptive: cniHumanRows(analysis),
      risk_reference_parameters: riskReferenceParameterRows(analysis),
      risk_curve_points: riskCurveRows(analysis),
      risk_threshold_comparison: riskThresholdRows(analysis),
      risk_binary_robustness: riskBinaryRows(analysis),
      risk_domain_thresholds: riskThresholdRows(analysis).filter((row) => row.CurveScope === "GROUP" && row.DomainKey),
      risk_ranking_distribution: riskRankingRows(analysis),
      category_effect_sizes: categoryEffectSizeRows(analysis),
      model_effect_sizes: modelEffectSizeRows(analysis),
      icc_results: iccRows(analysis),
      icc_theta_by_repeat: iccThetaRows(analysis),
      interpretation_dictionary: interpretationRows(interpretationApi),
      formula_dictionary: extras.formulas || [],
      scoring_routes: extras.routes || [],
    };
    return DATASET_INFO.map(([id, label, description]) => ({
      id,
      label,
      description,
      rows: ModelOrder.sortRows(rowsById[id] || [], analysis.records),
    }));
  }

  function datasetManifest(analysis, interpretationApi, extras = {}) {
    if (!analysis) return [];
    return buildDatasets(analysis, interpretationApi, extras).map((dataset) => ({
      id: dataset.id, label: dataset.label, description: dataset.description, count: (dataset.rows || []).length,
    }));
  }

  function combineDatasets(datasets, selectedIds) {
    const selected = selectedIds ? new Set(selectedIds) : null;
    return (datasets || []).filter((dataset) => !selected || selected.has(dataset.id)).flatMap((dataset) => (dataset.rows || []).map((row, index) => ({
      Dataset: dataset.id,
      DatasetLabel: dataset.label,
      DatasetRow: index + 1,
      ...row,
    })));
  }

  function csvEscape(value) {
    if (value == null) return "";
    const string = typeof value === "object" ? JSON.stringify(value) : String(value);
    return /[",\r\n]/.test(string) ? `"${string.replace(/"/g, '""')}"` : string;
  }

  function datasetCsvParts(datasets, selectedIds, chunkRows = 1000) {
    const selected = selectedIds ? new Set(selectedIds) : null;
    const included = (datasets || []).filter((dataset) => !selected || selected.has(dataset.id));
    const reserved = new Set(["Dataset", "DatasetLabel", "DatasetRow"]);
    const dataColumns = Array.from(included.reduce((set, dataset) => {
      (dataset.rows || []).forEach((row) => Object.keys(row || {}).forEach((key) => {
        if (!key.startsWith("__") && !reserved.has(key)) set.add(key);
      }));
      return set;
    }, new Set()));
    const columns = ["Dataset", "DatasetLabel", "DatasetRow", ...dataColumns];
    const parts = [`\uFEFF${columns.map(csvEscape).join(",")}\r\n`];
    const lines = [];
    let rowCount = 0;
    const flush = () => {
      if (!lines.length) return;
      parts.push(`${lines.join("\r\n")}\r\n`);
      lines.length = 0;
    };
    included.forEach((dataset) => (dataset.rows || []).forEach((row, index) => {
      const prefix = [dataset.id, dataset.label, index + 1];
      lines.push([...prefix, ...dataColumns.map((key) => row && row[key])].map(csvEscape).join(","));
      rowCount += 1;
      if (lines.length >= Math.max(1, chunkRows)) flush();
    }));
    flush();
    return { parts, rowCount, columns };
  }

  return { buildDatasets, datasetManifest, combineDatasets, datasetCsvParts };
});
