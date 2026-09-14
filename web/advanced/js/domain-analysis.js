(function (root, factory) {
  const ModelOrder = typeof module === "object" && module.exports
    ? require("./model-order.js")
    : root.DecisionModelOrder;
  const api = factory(ModelOrder);
  if (typeof module === "object" && module.exports) module.exports = api;
  root.DecisionDomainAnalysis = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function (ModelOrder) {
  "use strict";

  function clean(value) {
    return value == null ? "" : String(value).trim();
  }

  function unique(values) {
    return Array.from(new Set((values || []).filter((value) => value != null && clean(value) !== "")));
  }

  function groupBy(rows, keyFn) {
    const result = new Map();
    (rows || []).forEach((row) => {
      const key = keyFn(row);
      if (!result.has(key)) result.set(key, []);
      result.get(key).push(row);
    });
    return result;
  }

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

  function quantile(values, probability) {
    const finite = (values || []).filter(Number.isFinite).sort((a, b) => a - b);
    if (!finite.length) return null;
    if (finite.length === 1) return finite[0];
    const position = (finite.length - 1) * probability;
    const low = Math.floor(position);
    const high = Math.ceil(position);
    if (low === high) return finite[low];
    return finite[low] + (finite[high] - finite[low]) * (position - low);
  }

  function stableHash(value) {
    const text = String(value == null ? "" : value);
    let hash = 2166136261 >>> 0;
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 16777619) >>> 0;
    }
    return hash.toString(16).padStart(8, "0");
  }

  function domainKey(bankId, domain) {
    return clean(domain) ? `${clean(bankId)}::${clean(domain)}` : "";
  }

  function itemStatus(domains) {
    if (!domains.length) return { status: "DOMAIN_MISSING", eligible: false, reason: "ItemID缺少Source_Domain" };
    if (domains.length > 1) return { status: "DOMAIN_ITEM_CONFLICT", eligible: false, reason: `同一BankDatasetID＋ItemID出现多个Domain：${domains.join("、")}` };
    return { status: "DOMAIN_VALID", eligible: true, reason: "ItemID的Domain在全部重复记录中一致" };
  }

  function conditionStatus(domains, blockedItems) {
    if (blockedItems.length) return { status: "DOMAIN_CONDITION_ITEM_BLOCKED", eligible: false, reason: `包含Domain冲突或缺失Item：${blockedItems.join("、")}` };
    if (!domains.length) return { status: "MISSING_DOMAIN_CONDITION", eligible: false, reason: "Condition缺少可用Domain" };
    if (domains.length > 1) return { status: "MIXED_DOMAIN_CONDITION", eligible: false, reason: `Condition包含多个Domain：${domains.join("、")}` };
    return { status: "HOMOGENEOUS_DOMAIN_CONDITION", eligible: true, reason: "Condition内Item均属于同一Domain" };
  }

  function groupStatus(domains, blockedItems) {
    if (blockedItems.length) return { status: "DOMAIN_GROUP_ITEM_BLOCKED", eligible: false, reason: `题组包含Domain冲突或缺失Item：${blockedItems.join("、")}` };
    if (!domains.length) return { status: "MISSING_DOMAIN_GROUP", eligible: false, reason: "题组缺少可用Domain" };
    if (domains.length > 1) return { status: "MIXED_DOMAIN_GROUP", eligible: false, reason: `题组条件跨越多个Domain：${domains.join("、")}` };
    return { status: "HOMOGENEOUS_DOMAIN_GROUP", eligible: true, reason: "题组全部Item属于同一Domain" };
  }

  function attach(target, source) {
    if (!target || !source) return target;
    target.domain = source.domain || "";
    target.domainRaw = source.domain || "";
    target.domainKey = source.domainKey || "";
    target.domainStatus = source.status;
    target.domainEligible = !!source.eligible;
    target.domainEligibilityReason = source.reason;
    target.groupDomains = source.domains ? source.domains.slice() : source.domain ? [source.domain] : [];
    return target;
  }

  function domainCatalog(records) {
    const rows = [];
    groupBy(records.filter((record) => record.domainRaw), (record) => `${record.bankId}::${record.domainRaw}`).forEach((items) => {
      const first = items[0];
      rows.push({
        bankId: first.bankId,
        bankDatasetId: first.bankDatasetId,
        bankContentHash: first.bankContentHash,
        bankLabel: first.bankLabel,
        domain: first.domainRaw,
        domainRaw: first.domainRaw,
        domainKey: domainKey(first.bankId, first.domainRaw),
        recordCount: items.length,
        itemCount: unique(items.map((row) => row.itemId)).length,
        groupCount: unique(items.map((row) => row.groupId)).length,
        conditionCount: unique(items.map((row) => `${row.groupId}::${row.conditionCode}`)).length,
        modelCount: unique(items.map((row) => row.modelConfig)).length,
        sourceTypes: unique(items.map((row) => row.domainSource)).sort(),
      });
    });
    return rows.sort((a, b) => a.bankId.localeCompare(b.bankId) || a.domain.localeCompare(b.domain, "zh-CN"));
  }

  function domainItemAudit(records) {
    const audit = [];
    const lookup = new Map();
    groupBy(records, (record) => `${record.bankId}::${record.itemId}`).forEach((rows, key) => {
      const domains = unique(rows.map((row) => row.domainRaw)).sort((a, b) => a.localeCompare(b, "zh-CN"));
      const status = itemStatus(domains);
      const first = rows[0];
      const row = {
        bankId: first.bankId,
        bankDatasetId: first.bankDatasetId,
        bankContentHash: first.bankContentHash,
        bankLabel: first.bankLabel,
        itemId: first.itemId,
        groupId: first.groupId,
        conditionCode: first.conditionCode,
        domain: status.eligible ? domains[0] : "",
        domainRaw: status.eligible ? domains[0] : "",
        domainKey: status.eligible ? domainKey(first.bankId, domains[0]) : "",
        domains,
        domainCount: domains.length,
        status: status.status,
        domainStatus: status.status,
        eligible: status.eligible,
        domainEligible: status.eligible,
        reason: status.reason,
        domainEligibilityReason: status.reason,
        recordCount: rows.length,
        repeatIndices: unique(rows.map((record) => record.repeatIndex)).sort((a, b) => a - b),
        modelConfigs: unique(rows.map((record) => record.modelConfig)).sort((a, b) => ModelOrder.compare(a, b, rows)),
        domainSources: unique(rows.map((record) => record.domainSource)).sort(),
        itemVersions: unique(rows.map((record) => record.itemVersion)).sort(),
        sourceContentDigests: unique(rows.map((record) => record.sourceContentDigest)).sort(),
      };
      audit.push(row);
      lookup.set(key, row);
      rows.forEach((record) => {
        record.domainStatus = row.status;
        record.domainEligible = row.eligible;
        record.domainEligibilityReason = row.reason;
        if (!row.eligible) {
          record.domain = "";
          record.domainKey = "";
        }
      });
    });
    return { rows: audit.sort((a, b) => a.bankId.localeCompare(b.bankId) || a.itemId.localeCompare(b.itemId, "zh-CN", { numeric: true })), lookup };
  }

  function domainGroupAudit(records, itemLookup) {
    const audit = [];
    const lookup = new Map();
    groupBy(records, (record) => `${record.modelConfig}::${record.bankId}::${record.groupId}`).forEach((rows, key) => {
      const itemIds = unique(rows.map((row) => row.itemId));
      const itemRows = itemIds.map((itemId) => itemLookup.get(`${rows[0].bankId}::${itemId}`)).filter(Boolean);
      const blockedItems = itemRows.filter((item) => !item.eligible).map((item) => item.itemId);
      const domains = unique(itemRows.filter((item) => item.eligible).map((item) => item.domain)).sort((a, b) => a.localeCompare(b, "zh-CN"));
      const status = groupStatus(domains, blockedItems);
      const first = rows[0];
      const conditions = {};
      groupBy(rows, (row) => row.conditionCode).forEach((conditionRows, conditionCode) => {
        conditions[conditionCode] = unique(conditionRows.map((row) => row.domainRaw)).sort((a, b) => a.localeCompare(b, "zh-CN"));
      });
      const row = {
        modelConfig: first.modelConfig,
        analysisModelKey: first.analysisModelKey,
        bankId: first.bankId,
        bankDatasetId: first.bankDatasetId,
        bankContentHash: first.bankContentHash,
        bankLabel: first.bankLabel,
        categoryId: first.categoryId,
        category: first.category,
        categoryKey: first.categoryKey,
        groupId: first.groupId,
        domain: status.eligible ? domains[0] : "",
        domainRaw: status.eligible ? domains[0] : "",
        domainKey: status.eligible ? domainKey(first.bankId, domains[0]) : "",
        domains,
        groupDomains: domains,
        domainCount: domains.length,
        conditions,
        itemIds,
        blockedItemIds: blockedItems,
        status: status.status,
        domainStatus: status.status,
        eligible: status.eligible,
        domainEligible: status.eligible,
        reason: status.reason,
        domainEligibilityReason: status.reason,
      };
      audit.push(row);
      lookup.set(key, row);
    });
    return { rows: audit.sort((a, b) => ModelOrder.compareRows(a, b, records) || a.bankId.localeCompare(b.bankId) || a.groupId.localeCompare(b.groupId, "zh-CN", { numeric: true })), lookup };
  }

  function annotateItems(itemSummaries, itemLookup) {
    (itemSummaries || []).forEach((item) => {
      const audit = itemLookup.get(`${item.bankId}::${item.itemId}`);
      if (!audit) return;
      attach(item, audit);
      item.directionFlip = Number.isFinite(item.pMin) && Number.isFinite(item.pMax) && item.pMin < 0 && item.pMax > 0;
    });
  }

  function annotateConditions(conditionSummaries, itemLookup) {
    (conditionSummaries || []).forEach((condition) => {
      const items = (condition.itemIds || []).map((itemId) => itemLookup.get(`${condition.bankId}::${itemId}`)).filter(Boolean);
      const blocked = items.filter((item) => !item.eligible).map((item) => item.itemId);
      const domains = unique(items.filter((item) => item.eligible).map((item) => item.domain)).sort((a, b) => a.localeCompare(b, "zh-CN"));
      const status = conditionStatus(domains, blocked);
      attach(condition, {
        ...status,
        domain: status.eligible ? domains[0] : "",
        domainKey: status.eligible ? domainKey(condition.bankId, domains[0]) : "",
        domains,
      });
    });
  }

  function annotateGroups(rows, groupLookup) {
    (rows || []).forEach((row) => {
      const audit = groupLookup.get(`${row.modelConfig}::${row.bankId}::${row.groupId}`);
      if (audit) attach(row, audit);
    });
  }

  function domainReliability(itemSummaries) {
    const rows = [];
    groupBy((itemSummaries || []).filter((item) => item.domainEligible), (item) => `${item.modelConfig}::${item.bankId}::${item.domainKey}`).forEach((items) => {
      const first = items[0];
      const directional = items.filter((item) => Number.isFinite(item.pMean));
      rows.push({
        modelConfig: first.modelConfig,
        analysisModelKey: first.analysisModelKey,
        bankId: first.bankId,
        bankDatasetId: first.bankDatasetId,
        bankContentHash: first.bankContentHash,
        bankLabel: first.bankLabel,
        domain: first.domain,
        domainRaw: first.domain,
        domainKey: first.domainKey,
        domainStatus: "DOMAIN_VALID",
        domainEligible: true,
        itemCount: items.length,
        directionalItemCount: directional.length,
        meanKendallTau: mean(items.map((item) => item.kendallTau)),
        meanPSd: mean(directional.map((item) => item.pSd)),
        meanTopChoiceAgreement: mean(items.map((item) => item.topAgreement)),
        meanFullRankingAgreement: mean(items.map((item) => item.fullAgreement)),
        directionFlipCount: directional.filter((item) => item.directionFlip).length,
        directionFlipRate: directional.length ? directional.filter((item) => item.directionFlip).length / directional.length : null,
        completeItemCount: items.filter((item) => item.repeatStatus === "COMPLETE").length,
      });
    });
    return rows;
  }

  function domainConditionProfile(conditionSummaries) {
    const rows = [];
    groupBy((conditionSummaries || []).filter((row) => row.domainEligible), (row) => `${row.modelConfig}::${row.bankId}::${row.categoryKey}::${row.domainKey}::${row.conditionCode}`).forEach((cells) => {
      const first = cells[0];
      const means = cells.map((row) => row.mean).filter(Number.isFinite);
      rows.push({
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
        domain: first.domain,
        domainRaw: first.domain,
        domainKey: first.domainKey,
        domainStatus: first.domainStatus,
        domainEligible: true,
        conditionCode: first.conditionCode,
        conditionLabel: first.conditionLabel,
        meanP: mean(means),
        sdP: sd(means),
        groupCount: unique(cells.map((row) => row.groupId)).length,
        groupIds: unique(cells.map((row) => row.groupId)).sort((a, b) => a.localeCompare(b, "zh-CN", { numeric: true })),
        itemCount: unique(cells.flatMap((row) => row.itemIds || [])).length,
        validN: cells.reduce((sum, row) => sum + (row.validRepeats || 0), 0),
        cells,
      });
    });
    return rows;
  }

  function domainEffectProfile(groupEffects) {
    return (groupEffects || []).filter((row) => row.domainEligible).map((row) => ({
      modelConfig: row.modelConfig,
      analysisModelKey: row.analysisModelKey || row.modelConfig,
      bankId: row.bankId,
      bankDatasetId: row.bankDatasetId || row.bankId,
      bankContentHash: row.bankContentHash || "",
      bankLabel: row.bankLabel,
      secondLevel: row.secondLevel,
      categoryId: row.categoryId,
      category: row.category,
      categoryKey: row.categoryKey,
      contrastId: row.contrastId,
      groupId: row.groupId,
      domain: row.domain,
      domainRaw: row.domain,
      domainKey: row.domainKey,
      domainStatus: row.domainStatus,
      domainEligible: true,
      rawShift: row.rawShift,
      effect: row.effect,
      valid: row.valid,
      reason: row.reason,
    }));
  }

  function domainHeterogeneity(effectProfile) {
    const rows = [];
    groupBy((effectProfile || []).filter((row) => row.valid && Number.isFinite(row.effect)), (row) => `${row.modelConfig}::${row.bankId}::${row.categoryKey}::${row.contrastId}`).forEach((effects) => {
      const byDomain = [];
      groupBy(effects, (row) => row.domainKey).forEach((domainRows) => {
        const first = domainRows[0];
        byDomain.push({
          domain: first.domain,
          domainKey: first.domainKey,
          meanE: mean(domainRows.map((row) => row.effect)),
          groupCount: unique(domainRows.map((row) => row.groupId)).length,
          groupIds: unique(domainRows.map((row) => row.groupId)).sort(),
        });
      });
      const values = byDomain.map((row) => row.meanE).filter(Number.isFinite);
      const first = effects[0];
      const positiveCount = values.filter((value) => value > 1e-12).length;
      const negativeCount = values.filter((value) => value < -1e-12).length;
      const zeroCount = values.length - positiveCount - negativeCount;
      rows.push({
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
        domainCount: byDomain.length,
        min: values.length ? Math.min(...values) : null,
        max: values.length ? Math.max(...values) : null,
        range: values.length ? Math.max(...values) - Math.min(...values) : null,
        sd: sd(values),
        iqr: values.length ? quantile(values, 0.75) - quantile(values, 0.25) : null,
        positiveDomainCount: positiveCount,
        negativeDomainCount: negativeCount,
        zeroDomainCount: zeroCount,
        directionConsistency: values.length ? Math.max(positiveCount, negativeCount, zeroCount) / values.length : null,
        domains: byDomain.sort((a, b) => a.domain.localeCompare(b.domain, "zh-CN")),
        label: "Domain Heterogeneity Summary",
        inferenceStatus: "DESCRIPTIVE_ONLY",
      });
    });
    return rows;
  }

  function nonDirectionalProfile(records) {
    const included = (records || []).filter((record) => record.valid && record.domainEligible && ["NOMINAL_RANK", "CUSTOM"].includes(record.scoreFamily));
    const rows = [];
    groupBy(included, (record) => `${record.modelConfig}::${record.bankId}::${record.categoryKey}::${record.domainKey}::${record.conditionCode}`).forEach((cells) => {
      const first = cells[0];
      const topCounts = { L1: 0, L2: 0, L3: 0 };
      const rankSums = { L1: 0, L2: 0, L3: 0 };
      cells.forEach((record) => {
        if (Object.hasOwn(topCounts, record.topChoice)) topCounts[record.topChoice] += 1;
        Object.keys(rankSums).forEach((logical) => {
          if (Number.isFinite(record.ranks[logical])) rankSums[logical] += record.ranks[logical];
        });
      });
      rows.push({
        modelConfig: first.modelConfig,
        analysisModelKey: first.analysisModelKey,
        bankId: first.bankId,
        bankDatasetId: first.bankDatasetId,
        bankContentHash: first.bankContentHash,
        bankLabel: first.bankLabel,
        categoryId: first.categoryId,
        category: first.category,
        categoryKey: first.categoryKey,
        groupId: unique(cells.map((row) => row.groupId)).length === 1 ? first.groupId : "",
        groupIds: unique(cells.map((row) => row.groupId)).sort((a, b) => a.localeCompare(b, "zh-CN", { numeric: true })),
        groupCount: unique(cells.map((row) => row.groupId)).length,
        conditionCode: first.conditionCode,
        conditionLabel: first.condition,
        scoreFamily: first.scoreFamily,
        domain: first.domainRaw,
        domainRaw: first.domainRaw,
        domainKey: first.domainKey,
        domainStatus: first.domainStatus,
        domainEligible: true,
        n: cells.length,
        topCounts,
        topProportions: Object.fromEntries(Object.entries(topCounts).map(([key, value]) => [key, cells.length ? value / cells.length : null])),
        meanRanks: Object.fromEntries(Object.entries(rankSums).map(([key, value]) => [key, cells.length ? value / cells.length : null])),
      });
    });
    return rows;
  }

  function metadataManifest(records) {
    const rows = [];
    groupBy(records, (record) => record.bankId).forEach((bankRows, bankId) => {
      const tuples = unique(bankRows.map((record) => `${record.itemId}=${record.domainRaw}`)).sort();
      rows.push({
        bankId,
        bankDatasetId: bankRows[0].bankDatasetId,
        bankContentHash: bankRows[0].bankContentHash,
        domainMetadataHash: `DMH-${stableHash(tuples.join("\n"))}`,
        itemCount: unique(bankRows.map((record) => record.itemId)).length,
        domainCount: unique(bankRows.map((record) => record.domainRaw)).length,
      });
    });
    return rows;
  }

  function selectedDomainMeanE(effectProfile, selectedDomainKeys) {
    const selected = new Set(selectedDomainKeys || []);
    const source = (effectProfile || []).filter((row) => row.valid && Number.isFinite(row.effect) && (!selected.size || selected.has(row.domainKey)));
    const rows = [];
    groupBy(source, (row) => `${row.modelConfig}::${row.bankId}::${row.categoryKey}::${row.contrastId}`).forEach((effects) => {
      const first = effects[0];
      rows.push({
        modelConfig: first.modelConfig,
        bankId: first.bankId,
        bankLabel: first.bankLabel,
        categoryId: first.categoryId,
        category: first.category,
        categoryKey: first.categoryKey,
        contrastId: first.contrastId,
        selectedDomainKeys: unique(effects.map((row) => row.domainKey)).sort(),
        selectedDomains: unique(effects.map((row) => row.domain)).sort((a, b) => a.localeCompare(b, "zh-CN")),
        groupCount: unique(effects.map((row) => row.groupId)).length,
        selectedDomainMeanE: mean(effects.map((row) => row.effect)),
        status: "DESCRIPTIVE_EXPLORATORY_SUBSET",
        formalD: false,
        reason: "任意Domain子集不是预登记Category，不继承正式D、coverage、sign-flip或Holm结论",
      });
    });
    return rows;
  }

  function analyze(input) {
    const records = input.records || [];
    const itemAuditResult = domainItemAudit(records);
    annotateItems(input.itemRepeatSummaries, itemAuditResult.lookup);
    annotateConditions(input.conditionSummaries, itemAuditResult.lookup);
    const groupAuditResult = domainGroupAudit(records, itemAuditResult.lookup);

    annotateGroups(input.effects && input.effects.groupEffects, groupAuditResult.lookup);
    annotateGroups(input.profiles && input.profiles.groupMeans, groupAuditResult.lookup);
    annotateGroups(input.reliability && input.reliability.cells, groupAuditResult.lookup);
    if (input.factorial && input.factorial.analyses) {
      input.factorial.analyses.forEach((analysis) => {
        if (analysis.responseSurface && analysis.responseSurface.groupFits) {
          analysis.responseSurface.groupFits.forEach((row) => {
            row.modelConfig = analysis.modelConfig;
            row.analysisModelKey = analysis.modelConfig;
            row.bankId = analysis.bankId;
            row.bankDatasetId = analysis.bankId;
            row.bankLabel = analysis.bankLabel;
            row.categoryId = analysis.categoryId;
            row.category = analysis.category;
            row.categoryKey = analysis.categoryKey;
            const audit = groupAuditResult.lookup.get(`${analysis.modelConfig}::${analysis.bankId}::${row.groupId}`);
            if (audit) attach(row, audit);
          });
        }
      });
    }

    const catalog = domainCatalog(records);
    const effectProfile = domainEffectProfile(input.effects && input.effects.groupEffects);
    const output = {
      version: "DOMAIN_ANALYSIS_V1",
      catalog,
      itemAudit: itemAuditResult.rows,
      groupAudit: groupAuditResult.rows,
      reliabilitySummary: domainReliability(input.itemRepeatSummaries),
      conditionProfile: domainConditionProfile(input.conditionSummaries),
      effectProfile,
      heterogeneity: domainHeterogeneity(effectProfile),
      nonDirectionalProfile: nonDirectionalProfile(records),
      metadataManifest: metadataManifest(records),
      qa: {
        rawLabelCount: unique(records.map((record) => record.domainRaw)).length,
        missingRecordCount: records.filter((record) => !record.domainRaw).length,
        missingItemCount: itemAuditResult.rows.filter((row) => row.status === "DOMAIN_MISSING").length,
        itemConflictCount: itemAuditResult.rows.filter((row) => row.status === "DOMAIN_ITEM_CONFLICT").length,
        homogeneousGroupCount: groupAuditResult.rows.filter((row) => row.status === "HOMOGENEOUS_DOMAIN_GROUP").length,
        mixedGroupCount: groupAuditResult.rows.filter((row) => row.status === "MIXED_DOMAIN_GROUP").length,
        missingGroupCount: groupAuditResult.rows.filter((row) => row.status === "MISSING_DOMAIN_GROUP").length,
        eligibleGroupCount: groupAuditResult.rows.filter((row) => row.eligible).length,
      },
    };
    return output;
  }

  return {
    analyze,
    selectedDomainMeanE,
    domainKey,
    mean,
    sd,
    quantile,
  };
});
