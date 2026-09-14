(function (root, factory) {
  const DomainAnalysis = typeof module === "object" && module.exports
    ? require("./domain-analysis.js")
    : root.DecisionDomainAnalysis;
  const EffectSizes = typeof module === "object" && module.exports
    ? require("./effect-sizes.js")
    : root.DecisionEffectSizes;
  const ICC = typeof module === "object" && module.exports
    ? require("./icc.js")
    : root.DecisionICC;
  const ModelOrder = typeof module === "object" && module.exports
    ? require("./model-order.js")
    : root.DecisionModelOrder;
  const api = factory(DomainAnalysis, EffectSizes, ICC, ModelOrder);
  if (typeof module === "object" && module.exports) module.exports = api;
  root.DecisionAnalysis = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function (DomainAnalysis, EffectSizes, ICC, ModelOrder) {
  "use strict";

  const VALID = new Set(["VALID", "REPAIRED_VALID"]);
  const BANKS = {
    risk: { label: "风险决策", decision: "风险决策", order: 1, color: "#7357d8" },
    ambiguity: { label: "模糊决策", decision: "模糊决策", order: 2, color: "#188f82" },
    intertemporal: { label: "跨期决策", decision: "跨期决策", order: 3, color: "#dc6b50" },
    moral_mft: { label: "道德决策 · MFT", decision: "道德决策", order: 4, color: "#8a647a" },
    moral_cni: { label: "道德决策 · CNI-Conflict", decision: "道德决策", order: 5, color: "#b67b2e" },
    unknown: { label: "未识别子测验", decision: "未识别", order: 99, color: "#716b76" },
  };

  const STATUS_LABELS = {
    VALID: "首次有效",
    REPAIRED_VALID: "修复后有效",
    MISSING_OPTION: "漏项",
    DUPLICATE_OPTION: "重复选项",
    TIE: "并列",
    CONFLICT: "冲突排序",
    OUT_OF_RANGE: "越界",
    REFUSAL: "拒答",
    PARSE_ERROR: "无法解析",
    TECH_ERROR: "技术失败",
    SESSION_LEAK: "会话泄漏",
  };

  const PLANNED_REPEATS_DEFAULT = 5;
  const MODEL_IDENTITY_POLICY = "MODEL_IDENTITY_V2";
  const MODEL_IDENTITY_FIELDS = [
    "provider", "model", "modelVersion", "temperature", "topP", "seed",
    "samplingSent", "promptVersion", "parserVersion",
  ];
  const MODEL_IDENTITY_LABELS = {
    provider: "Provider",
    model: "Model",
    modelVersion: "ModelVersion",
    temperature: "Temperature",
    topP: "TopP",
    seed: "Seed",
    samplingSent: "SamplingSent",
    promptVersion: "PromptVersion",
    parserVersion: "ParserVersion",
  };
  const MODEL_BEHAVIOR_ANCHOR_FIELDS = [
    "provider", "model", "modelVersion", "temperature", "topP", "seed", "samplingSent",
  ];
  const DATASET_CRITICAL_FIELDS = [
    "GroupID", "ID", "ConditionCode", "CategoryID", "Dimension", "ScoreFamily",
    "ConditionStructure", "ConditionLevel", "OptionRole", "Opt_to_L_Map",
    "Context", "Question", "Opt1", "Opt2", "Opt3", "ContentDigest", "ContrastID",
    "ContrastWeights", "ItemVersion",
  ];

  function clean(value) {
    return value == null ? "" : String(value).trim();
  }

  function number(value, fallback = null) {
    const parsed = Number(String(value == null ? "" : value).replace(/,/g, "").replace(/%$/, ""));
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  function truthy(value) {
    return ["1", "true", "yes", "y", "是"].includes(clean(value).toLowerCase());
  }

  function unique(values) {
    return Array.from(new Set(values.filter((value) => value !== "" && value != null)));
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

  function normalizedScalar(value) {
    const text = clean(value);
    if (text === "") return "";
    const numeric = Number(text);
    return Number.isFinite(numeric) ? String(numeric) : text;
  }

  function stableObjectText(object) {
    return Object.keys(object || {}).sort().map((key) => `${key}=${clean(object[key]).replace(/\s+/g, " ")}`).join("|");
  }

  function normalizeModelIdentityValue(field, value) {
    if (["provider", "model", "modelVersion", "promptVersion", "parserVersion"].includes(field)) {
      return clean(value).replace(/\s+/g, " ").toLowerCase();
    }
    if (field === "samplingSent") {
      const text = clean(value).toLowerCase();
      if (["1", "true", "yes", "y", "是"].includes(text)) return "1";
      if (["0", "false", "no", "n", "否"].includes(text)) return "0";
      return normalizedScalar(value);
    }
    return normalizedScalar(value);
  }

  function modelIdentityValue(record, field) {
    const resolved = record && record.modelIdentityResolved;
    const value = resolved && Object.prototype.hasOwnProperty.call(resolved, field)
      ? resolved[field]
      : normalizeModelIdentityValue(field, record && record[field]);
    if (value === "" && record && (record.modelIdentityAmbiguousFields || []).includes(field)) return "__AMBIGUOUS__";
    return value;
  }

  function resolveModelIdentityMetadata(records) {
    const addEvidence = (record, field, values, source) => {
      if (!record.modelIdentityAmbiguityEvidence[field]) record.modelIdentityAmbiguityEvidence[field] = [];
      record.modelIdentityAmbiguityEvidence[field].push({ source, values: values.slice().sort() });
    };
    const inferValue = (record, field, value, source) => {
      if (!value || record.modelIdentityResolved[field]) return false;
      record.modelIdentityResolved[field] = value;
      record.modelIdentityInferences.push({ field, value, source });
      return true;
    };
    const inferUniqueWithinGroups = (groups, fields, source) => {
      groups.forEach((rows) => {
        fields.forEach((field) => {
          const known = unique(rows.map((row) => row.modelIdentityResolved[field])).sort();
          if (known.length === 1) {
            rows.forEach((row) => inferValue(row, field, known[0], source));
          } else if (known.length > 1) {
            rows.filter((row) => !row.modelIdentityResolved[field]).forEach((row) => addEvidence(row, field, known, source));
          }
        });
      });
    };

    records.forEach((record) => {
      record.modelIdentityResolved = Object.fromEntries(MODEL_IDENTITY_FIELDS.map((field) => [field, normalizeModelIdentityValue(field, record[field])]));
      record.modelIdentityOriginalMissingFields = MODEL_IDENTITY_FIELDS.filter((field) => !record.modelIdentityResolved[field]);
      record.modelIdentityInferences = [];
      record.modelIdentityAmbiguityEvidence = {};
      record.modelIdentityAmbiguousFields = [];
      record.modelIdentityBlocked = false;
    });

    const runGroups = groupBy(records, (record) => record.runId
      ? `RUN::${record.runId}`
      : `NO_RUN::${record.batchId}::${record.rawModelConfigId}`);
    inferUniqueWithinGroups(runGroups, MODEL_IDENTITY_FIELDS, "RUN_UNIQUE_VALUE");

    const rawConfigGroups = groupBy(records, (record) => `RAW::${clean(record.rawModelConfigId).toLowerCase() || "unspecified"}`);
    inferUniqueWithinGroups(rawConfigGroups, MODEL_IDENTITY_FIELDS, "RAW_CONFIG_UNIQUE_VALUE");

    records.forEach((record) => {
      if (!record.modelIdentityResolved.modelVersion && record.modelIdentityResolved.model) {
        inferValue(record, "modelVersion", record.modelIdentityResolved.model, "MODEL_NAME_VERSION_FALLBACK");
      }
    });

    const behaviorAnchorGroups = groupBy(
      records.filter((record) => record.modelIdentityResolved.provider && record.modelIdentityResolved.model),
      (record) => stableObjectText(Object.fromEntries(MODEL_BEHAVIOR_ANCHOR_FIELDS.map((field) => [MODEL_IDENTITY_LABELS[field], record.modelIdentityResolved[field]]))),
    );
    inferUniqueWithinGroups(behaviorAnchorGroups, ["promptVersion", "parserVersion"], "BEHAVIOR_ANCHOR_UNIQUE_VALUE");

    records.forEach((record) => {
      record.modelIdentityAmbiguousFields = Object.entries(record.modelIdentityAmbiguityEvidence)
        .filter(([field, evidence]) => !record.modelIdentityResolved[field] && evidence.some((entry) => entry.values.length > 1))
        .map(([field]) => field)
        .sort();
      record.modelIdentityInferredFields = unique(record.modelIdentityInferences.map((entry) => entry.field)).sort();
      record.modelIdentityInferenceSources = unique(record.modelIdentityInferences.map((entry) => entry.source)).sort();
      record.modelIdentityUnresolvedFields = MODEL_IDENTITY_FIELDS.filter((field) => !record.modelIdentityResolved[field] && !record.modelIdentityAmbiguousFields.includes(field));
      record.modelIdentityBlocked = record.modelIdentityAmbiguousFields.length > 0;
    });
  }

  function mean(values) {
    const finite = values.filter(Number.isFinite);
    return finite.length ? finite.reduce((sum, value) => sum + value, 0) / finite.length : null;
  }

  function variance(values, sample = true) {
    const finite = values.filter(Number.isFinite);
    const divisor = finite.length - (sample ? 1 : 0);
    if (divisor <= 0) return null;
    const avg = mean(finite);
    return finite.reduce((sum, value) => sum + (value - avg) ** 2, 0) / divisor;
  }

  function sd(values, sample = true) {
    const v = variance(values, sample);
    return v == null ? null : Math.sqrt(v);
  }

  function clamp(value, low, high) {
    return Math.max(low, Math.min(high, value));
  }

  function groupBy(rows, keyFn) {
    const map = new Map();
    rows.forEach((row) => {
      const key = keyFn(row);
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(row);
    });
    return map;
  }

  function modeRatio(values) {
    if (!values.length) return { value: null, ratio: null, count: 0, n: 0 };
    const counts = new Map();
    values.forEach((value) => counts.set(value, (counts.get(value) || 0) + 1));
    const sorted = Array.from(counts.entries()).sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])));
    return { value: sorted[0][0], ratio: sorted[0][1] / values.length, count: sorted[0][1], n: values.length };
  }

  function tCritical95(df) {
    const table = [
      12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262, 2.228,
      2.201, 2.179, 2.160, 2.145, 2.131, 2.120, 2.110, 2.101, 2.093, 2.086,
      2.080, 2.074, 2.069, 2.064, 2.060, 2.056, 2.052, 2.048, 2.045, 2.042,
    ];
    if (df <= 0) return null;
    if (df <= table.length) return table[df - 1];
    if (df <= 40) return 2.021;
    if (df <= 60) return 2.000;
    if (df <= 120) return 1.980;
    return 1.960;
  }

  function ci95(values) {
    const finite = values.filter(Number.isFinite);
    if (finite.length < 2) return { mean: mean(finite), low: null, high: null, n: finite.length, sd: null };
    const avg = mean(finite);
    const spread = sd(finite);
    const margin = tCritical95(finite.length - 1) * spread / Math.sqrt(finite.length);
    return { mean: avg, low: avg - margin, high: avg + margin, n: finite.length, sd: spread };
  }

  function pearson(xs, ys) {
    const pairs = xs.map((x, index) => [x, ys[index]]).filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y));
    if (pairs.length < 3) return null;
    const ax = mean(pairs.map((pair) => pair[0]));
    const ay = mean(pairs.map((pair) => pair[1]));
    const numerator = pairs.reduce((sum, [x, y]) => sum + (x - ax) * (y - ay), 0);
    const dx = Math.sqrt(pairs.reduce((sum, [x]) => sum + (x - ax) ** 2, 0));
    const dy = Math.sqrt(pairs.reduce((sum, [, y]) => sum + (y - ay) ** 2, 0));
    return dx && dy ? numerator / (dx * dy) : null;
  }

  function inferBank(name, row) {
    const text = `${clean(name)} ${clean(row && row.SourceFile)} ${clean(row && row.BankID)} ${clean(row && row.Source_BankID)}`.toLowerCase();
    if (/cni|cnis|conflict/.test(text)) return "moral_cni";
    if (/mft|道德.*mft/.test(text)) return "moral_mft";
    if (/风险|risk/.test(text)) return "risk";
    if (/模糊|ambigu/.test(text)) return "ambiguity";
    if (/跨期|intertemporal|delay/.test(text)) return "intertemporal";
    const second = clean(row && (row.Source_SecondLevel || row.SecondLevel));
    const category = clean(row && (row.Source_Category || row.Category));
    if (/关爱|公平|自由|忠诚|权威|圣洁|非道德/.test(category)) return "moral_mft";
    if (/概率模糊|后果模糊/.test(second)) return "ambiguity";
    if (/单时点|结果序列|跨期/.test(second)) return "intertemporal";
    if (/似然|参考依赖|损失厌恶|概率敏感/.test(`${second} ${category}`)) return "risk";
    if (/禁制性规范|指令性规范/.test(second)) return "moral_cni";
    return "unknown";
  }

  function runtimeBankFiles(sourceRows) {
    const byBank = new Map();
    const conflicts = new Map();
    (sourceRows || []).forEach((sourceRow) => {
      const bankId = inferBank(sourceRow.SourceFile, sourceRow);
      if (bankId === "unknown") return;
      const row = {};
      // mergeBatches uses a lightweight prototype wrapper to avoid copying large rows;
      // for...in intentionally includes those inherited enumerable Source_* fields.
      for (const key in (sourceRow || {})) {
        const value = sourceRow[key];
        if (key.startsWith("Source_") && clean(value) !== "") row[key.slice(7)] = value;
      }
      ["ItemID", "GroupID", "ID", "ConditionCode"].forEach((key) => {
        if (clean(row[key]) === "" && clean(sourceRow[key]) !== "") row[key] = sourceRow[key];
      });
      const itemId = clean(row.ItemID);
      const conditionCode = clean(row.ConditionCode);
      const groupId = clean(row.GroupID || row.ID);
      if (!itemId || !conditionCode || !groupId) return;
      if (!byBank.has(bankId)) byBank.set(bankId, new Map());
      const items = byBank.get(bankId);
      const previous = items.get(itemId);
      if (previous) {
        Object.entries(row).forEach(([key, value]) => {
          const before = clean(previous[key]);
          const after = clean(value);
          if (before && after && before !== after) {
            const signature = `${bankId}::${itemId}::${key}`;
            if (!conflicts.has(signature)) conflicts.set(signature, { bankId, itemId, field: key, before, after });
          }
        });
      }
      const merged = { ...(previous || {}) };
      Object.entries(row).forEach(([key, value]) => { if (clean(value) !== "") merged[key] = value; });
      items.set(itemId, merged);
    });
    return {
      files: Array.from(byBank.entries()).map(([bankId, items]) => ({
        name: `运行记录内嵌题库元数据_${bankId}.csv`,
        bankId,
        rows: Array.from(items.values()),
        runtimeDerived: true,
      })),
      conflicts: Array.from(conflicts.values()),
    };
  }

  function mergeNonBlank(previous, incoming) {
    const merged = { ...(previous || {}) };
    Object.entries(incoming || {}).forEach(([key, value]) => { if (clean(value) !== "") merged[key] = value; });
    return merged;
  }

  function normalizeBanks(bankFiles, sourceRows) {
    const files = (bankFiles || []).map((file) => ({
      name: file.name || "题库.csv",
      bankId: file.bankId || inferBank(file.name, file.rows && file.rows[0]),
      rows: file.rows || [],
    }));
    const runtime = runtimeBankFiles(sourceRows);
    const mergedByBank = new Map();
    const staticKeys = new Set();
    const compositionConflicts = [];
    const conflictSignatures = new Set();
    files.forEach((file) => {
      if (!mergedByBank.has(file.bankId)) mergedByBank.set(file.bankId, new Map());
      file.rows.forEach((row, index) => {
        const itemId = clean(row.ItemID);
        const key = itemId || `${clean(row.GroupID || row.ID)}::${clean(row.ConditionCode)}::${index}`;
        if (!key) return;
        staticKeys.add(`${file.bankId}::${key}`);
        const items = mergedByBank.get(file.bankId);
        items.set(key, mergeNonBlank(items.get(key), row));
      });
    });
    let runtimeAddedItems = 0;
    let runtimeOverriddenItems = 0;
    runtime.files.forEach((file) => {
      if (!mergedByBank.has(file.bankId)) mergedByBank.set(file.bankId, new Map());
      const items = mergedByBank.get(file.bankId);
      file.rows.forEach((row, index) => {
        const itemId = clean(row.ItemID);
        const key = itemId || `${clean(row.GroupID || row.ID)}::${clean(row.ConditionCode)}::runtime-${index}`;
        if (!key) return;
        if (staticKeys.has(`${file.bankId}::${key}`)) runtimeOverriddenItems += 1;
        else runtimeAddedItems += 1;
        // 完整运行记录中的 Source_* 是本次实际运行题库的权威快照；内置题库仅作
        // 缺失字段回填，因此静态目录与运行快照的差异形成新的内容指纹，不构成
        // BankPart 组成冲突。只有本次运行的不同BankPart对同一ItemID给出相互矛盾
        // 的关键字段时才阻断。
        items.set(key, mergeNonBlank(items.get(key), row));
      });
    });
    runtime.conflicts.filter((conflict) => DATASET_CRITICAL_FIELDS.includes(conflict.field)).forEach((conflict) => {
      const signature = `${conflict.bankId}::${conflict.itemId}::${conflict.field}`;
      if (conflictSignatures.has(signature)) return;
      conflictSignatures.add(signature);
      compositionConflicts.push({ ...conflict, source: "RUNTIME_PARTS" });
    });
    const conflictItemKeys = new Set(compositionConflicts.map((row) => `${row.bankId}::${row.itemId}`));

    const byExact = new Map();
    const byItem = new Map();
    mergedByBank.forEach((items, bankId) => {
      items.forEach((row) => {
        const item = clean(row.ItemID);
        if (!item) return;
        byExact.set(`${bankId}::${item}`, row);
        if (!byItem.has(item)) byItem.set(item, []);
        byItem.get(item).push({ bankId, row });
      });
    });

    const catalog = {};
    mergedByBank.forEach((itemMap, bankId) => {
      const mergedRows = Array.from(itemMap.values());
      const categories = {};
      mergedRows.forEach((row) => {
        const categoryId = clean(row.CategoryID || row.Dimension || row.Category) || "UNSPECIFIED";
        const key = `${bankId}::${categoryId}`;
        if (!categories[key]) {
          categories[key] = {
            key,
            bankId,
            categoryId,
            category: clean(row.Category) || categoryId,
            secondLevel: clean(row.SecondLevel),
            definition: clean(row.Category_Definition),
            groups: new Set(),
            items: new Set(),
            conditions: new Set(),
            scoreFamilies: new Set(),
            structures: new Set(),
            conditionDetails: new Map(),
            contrastTexts: new Set(),
            baselines: new Set(),
            expectedEffects: new Set(),
            aggregationRules: new Set(),
            minValidRules: new Set(),
            manipulatedVariables: new Set(),
          };
        }
        const item = categories[key];
        const groupId = clean(row.GroupID || row.ID);
        const itemId = clean(row.ItemID);
        const conditionCode = clean(row.ConditionCode);
        item.groups.add(groupId);
        item.items.add(itemId);
        item.conditions.add(conditionCode);
        item.scoreFamilies.add(clean(row.ScoreFamily));
        item.structures.add(clean(row.ConditionStructure));
        item.contrastTexts.add(clean(row.ContrastWeights));
        item.baselines.add(clean(row.Baseline));
        item.expectedEffects.add(clean(row.Expected_Effect));
        item.aggregationRules.add(clean(row.AggregationRule));
        item.minValidRules.add(clean(row.MinValidRule));
        item.manipulatedVariables.add(clean(row.Manipulated_Variable));
        if (!item.conditionDetails.has(conditionCode)) {
          item.conditionDetails.set(conditionCode, {
            conditionCode,
            labels: new Set(),
            levels: new Set(),
            groups: new Set(),
            items: new Set(),
            factorValues: {},
          });
        }
        const detail = item.conditionDetails.get(conditionCode);
        detail.labels.add(clean(row.Condition));
        detail.levels.add(clean(row.ConditionLevel));
        detail.groups.add(groupId);
        detail.items.add(itemId);
        const parsedFactors = parseFactorLevel(row.ConditionLevel);
        if (Object.keys(parsedFactors).length) detail.factorValues = parsedFactors;
      });
      const catRows = Object.values(categories).map((item) => {
        const conditionDetails = Array.from(item.conditionDetails.values()).map((detail) => ({
          conditionCode: detail.conditionCode,
          label: unique(Array.from(detail.labels))[0] || detail.conditionCode,
          labels: unique(Array.from(detail.labels)),
          levels: unique(Array.from(detail.levels)),
          factorValues: detail.factorValues,
          plannedGroups: unique(Array.from(detail.groups)).length,
          plannedItems: unique(Array.from(detail.items)).length,
        })).sort((a, b) => naturalCompare(a.conditionCode.replace(/^C/i, ""), b.conditionCode.replace(/^C/i, "")));
        const contrastText = unique(Array.from(item.contrastTexts))[0] || "";
        const registeredContrasts = parseContrasts(contrastText);
        const factorKeys = unique(conditionDetails.flatMap((detail) => Object.keys(detail.factorValues)));
        const factorLevels = Object.fromEntries(factorKeys.map((factor) => [factor, unique(conditionDetails.map((detail) => detail.factorValues[factor]).filter(Boolean)).sort(naturalCompare)]));
        return {
          key: item.key,
          bankId: item.bankId,
          categoryId: item.categoryId,
          category: item.category,
          secondLevel: item.secondLevel,
          definition: item.definition,
          plannedGroups: unique(Array.from(item.groups)).length,
          plannedItems: unique(Array.from(item.items)).length,
          conditionCodes: unique(Array.from(item.conditions)),
          conditionDetails,
          scoreFamilies: unique(Array.from(item.scoreFamilies)),
          structures: unique(Array.from(item.structures)),
          registeredContrasts,
          contrastText,
          factorKeys,
          factorLevels,
          baselines: unique(Array.from(item.baselines)),
          expectedEffects: unique(Array.from(item.expectedEffects)),
          aggregationRules: unique(Array.from(item.aggregationRules)),
          minValidRules: unique(Array.from(item.minValidRules)),
          manipulatedVariables: unique(Array.from(item.manipulatedVariables)),
        };
      });
      const sourceNames = unique([
        ...files.filter((file) => file.bankId === bankId).map((file) => file.name),
        ...runtime.files.filter((file) => file.bankId === bankId).map((file) => file.name),
      ]);
      const observedPartNames = unique((sourceRows || [])
        .filter((row) => inferBank(row.SourceFile, row) === bankId)
        .map((row) => clean(row.SourceFile)));
      const bankPartIds = observedPartNames.length ? observedPartNames : sourceNames.filter((name) => !/^运行记录内嵌题库元数据_/.test(name));
      const contentRows = mergedRows.map((row) => stableObjectText(Object.fromEntries([
        ["ItemID", clean(row.ItemID)],
        ...DATASET_CRITICAL_FIELDS.map((field) => [field, row[field]]),
        ["Expected_Effect", row.Expected_Effect],
        ["AggregationRule", row.AggregationRule],
      ]))).sort();
      const contentHash = `BCH-${stableHash(contentRows.join("\n"))}`;
      catalog[bankId] = {
        bankId,
        bankDatasetId: bankId,
        name: BANKS[bankId] ? BANKS[bankId].label : sourceNames[0] || bankId,
        sourceName: sourceNames.join("；"),
        bankPartIds,
        contentHash,
        rows: mergedRows.length,
        groups: unique(mergedRows.map((row) => clean(row.GroupID || row.ID))).length,
        items: unique(mergedRows.map((row) => clean(row.ItemID))).length,
        categories: catRows,
      };
    });
    return {
      files,
      runtimeFiles: runtime.files,
      runtimeMetadataRows: runtime.files.reduce((sum, file) => sum + file.rows.length, 0),
      runtimeAddedItems,
      runtimeOverriddenItems,
      metadataConflicts: runtime.conflicts,
      datasetCompositionConflicts: compositionConflicts,
      conflictItemKeys,
      byExact,
      byItem,
      catalog,
    };
  }

  function pick(row, bankRow, key) {
    const source = row[`Source_${key}`];
    if (source != null && clean(source) !== "") return source;
    if (row[key] != null && clean(row[key]) !== "") return row[key];
    return bankRow && bankRow[key] != null ? bankRow[key] : "";
  }

  function parseAssignments(text) {
    const map = {};
    clean(text).split(/[;；]/).forEach((part) => {
      const match = part.match(/^\s*([^=]+)\s*=\s*([^=]+)\s*$/);
      if (match) map[clean(match[1]).toLowerCase()] = clean(match[2]);
    });
    return map;
  }

  function parseFactorLevel(text) {
    const factors = {};
    clean(text).split(/[;；]/).forEach((part) => {
      const match = part.match(/^\s*([^=]+)\s*=\s*(.+?)\s*$/);
      if (match) factors[clean(match[1])] = clean(match[2]);
    });
    return factors;
  }

  function naturalValue(value) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : clean(value);
  }

  function naturalCompare(a, b) {
    const left = naturalValue(a);
    const right = naturalValue(b);
    if (typeof left === "number" && typeof right === "number") return left - right;
    return String(left).localeCompare(String(right), "zh-CN", { numeric: true });
  }

  function normalizedLinearWeights(levels) {
    const ordered = Array.from(levels || []).sort(naturalCompare);
    if (ordered.length < 2) return {};
    const center = (ordered.length - 1) / 2;
    const raw = ordered.map((level, index) => ({ level, weight: index - center }));
    const positive = raw.filter((row) => row.weight > 0).reduce((sum, row) => sum + row.weight, 0);
    const negative = Math.abs(raw.filter((row) => row.weight < 0).reduce((sum, row) => sum + row.weight, 0));
    return Object.fromEntries(raw.map((row) => [row.level, row.weight > 0 ? row.weight / positive : row.weight < 0 ? row.weight / negative : 0]));
  }

  function normalizedInteractionWeights(levelsA, levelsB) {
    const weightsA = normalizedLinearWeights(levelsA);
    const weightsB = normalizedLinearWeights(levelsB);
    const raw = [];
    Object.entries(weightsA).forEach(([levelA, weightA]) => Object.entries(weightsB).forEach(([levelB, weightB]) => {
      raw.push({ key: `${levelA}::${levelB}`, levelA, levelB, weight: weightA * weightB });
    }));
    const positive = raw.filter((row) => row.weight > 0).reduce((sum, row) => sum + row.weight, 0);
    const negative = Math.abs(raw.filter((row) => row.weight < 0).reduce((sum, row) => sum + row.weight, 0));
    return raw.map((row) => ({
      ...row,
      weight: row.weight > 0 ? row.weight / positive : row.weight < 0 ? row.weight / negative : 0,
    }));
  }

  const FACTOR_LABELS = {
    BaseProbability: "基础概率",
    CostRate: "成本率",
    Norm: "规范类型",
    Consequence: "后果关系",
    Conflict: "冲突方式",
  };

  function factorLabel(key) {
    return FACTOR_LABELS[key] || key;
  }

  function factorType(levels) {
    const values = (levels || []).map((value) => Number(value));
    return values.length > 2 && values.every(Number.isFinite) ? "NUMERIC" : "CATEGORICAL";
  }

  function matrixRank(matrix, tolerance = 1e-10) {
    if (!matrix.length || !matrix[0].length) return 0;
    const a = matrix.map((row) => row.map((value) => Number(value) || 0));
    const rows = a.length;
    const cols = a[0].length;
    let rank = 0;
    for (let col = 0; col < cols && rank < rows; col += 1) {
      let pivot = rank;
      for (let row = rank + 1; row < rows; row += 1) if (Math.abs(a[row][col]) > Math.abs(a[pivot][col])) pivot = row;
      if (Math.abs(a[pivot][col]) <= tolerance) continue;
      [a[rank], a[pivot]] = [a[pivot], a[rank]];
      const divisor = a[rank][col];
      for (let c = col; c < cols; c += 1) a[rank][c] /= divisor;
      for (let row = 0; row < rows; row += 1) {
        if (row === rank) continue;
        const multiple = a[row][col];
        if (Math.abs(multiple) <= tolerance) continue;
        for (let c = col; c < cols; c += 1) a[row][c] -= multiple * a[rank][c];
      }
      rank += 1;
    }
    return rank;
  }

  function linearRegression(points) {
    const rows = (points || []).filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y));
    if (rows.length < 2) return { valid: false, n: rows.length, slope: null, intercept: null, r2: null, constantOutcome: false, fitStatus: "INSUFFICIENT_N", reason: "有效点少于2个" };
    const meanX = mean(rows.map((row) => row.x));
    const meanY = mean(rows.map((row) => row.y));
    const ssx = rows.reduce((sum, row) => sum + (row.x - meanX) ** 2, 0);
    if (ssx <= 1e-15) return { valid: false, n: rows.length, slope: null, intercept: meanY, r2: null, constantOutcome: false, fitStatus: "X_RANGE_ZERO", reason: "自变量没有变化" };
    const slope = rows.reduce((sum, row) => sum + (row.x - meanX) * (row.y - meanY), 0) / ssx;
    const intercept = meanY - slope * meanX;
    const sst = rows.reduce((sum, row) => sum + (row.y - meanY) ** 2, 0);
    const sse = rows.reduce((sum, row) => sum + (row.y - (intercept + slope * row.x)) ** 2, 0);
    const constantOutcome = sst <= 1e-15;
    return {
      valid: true,
      n: rows.length,
      slope: constantOutcome ? 0 : slope,
      intercept: meanY,
      r2: constantOutcome ? null : 1 - sse / sst,
      minX: Math.min(...rows.map((row) => row.x)),
      maxX: Math.max(...rows.map((row) => row.x)),
      constantOutcome,
      fitStatus: constantOutcome ? "CONSTANT_OUTCOME" : "OK",
      reason: constantOutcome ? "结果恒定：斜率记为0，R²不定义" : "线性拟合完成",
    };
  }

  function rankScore(record, logical) {
    const rank = record && record.ranks ? record.ranks[logical] : null;
    const k = record ? record.optionCount : null;
    return Number.isFinite(rank) && Number.isFinite(k) && k > 1 ? (k + 1 - 2 * rank) / (k - 1) : null;
  }

  function factorialOutcomeSpecs(scoreFamily) {
    if (scoreFamily === "DIRECTIONAL_RANK") return [{
      id: "P", label: "方向偏好P", shortLabel: "P", bounds: [-1, 1], unit: "标准化偏好", value: (record) => record.preference,
    }];
    return [
      { id: "TOP_L1", label: "L1首选率", shortLabel: "L1首选", bounds: [0, 1], unit: "概率差", value: (record) => record.valid ? (record.topChoice === "L1" ? 1 : 0) : null },
      { id: "TOP_L2", label: "L2首选率", shortLabel: "L2首选", bounds: [0, 1], unit: "概率差", value: (record) => record.valid ? (record.topChoice === "L2" ? 1 : 0) : null },
      { id: "TOP_L3", label: "L3首选率", shortLabel: "L3首选", bounds: [0, 1], unit: "概率差", value: (record) => record.valid ? (record.topChoice === "L3" ? 1 : 0) : null },
      { id: "PAIR_L1_GT_L2", label: "L1优于L2概率", shortLabel: "L1>L2", bounds: [0, 1], unit: "概率差", value: (record) => record.valid && record.ranks.L1 && record.ranks.L2 ? (record.ranks.L1 < record.ranks.L2 ? 1 : 0) : null },
      { id: "RANK_SCORE_L1", label: "L1标准化排名", shortLabel: "L1排名", bounds: [-1, 1], unit: "标准化排名差", value: (record) => rankScore(record, "L1") },
      { id: "RANK_SCORE_L2", label: "L2标准化排名", shortLabel: "L2排名", bounds: [-1, 1], unit: "标准化排名差", value: (record) => rankScore(record, "L2") },
      { id: "RANK_SCORE_L3", label: "L3标准化排名", shortLabel: "L3排名", bounds: [-1, 1], unit: "标准化排名差", value: (record) => rankScore(record, "L3") },
    ];
  }

  function normalizeContrastWeights(rows) {
    const positive = rows.filter((row) => row.weight > 0).reduce((sum, row) => sum + row.weight, 0);
    const negative = Math.abs(rows.filter((row) => row.weight < 0).reduce((sum, row) => sum + row.weight, 0));
    if (!positive || !negative) return [];
    return rows.map((row) => ({ ...row, weight: row.weight > 0 ? row.weight / positive : row.weight < 0 ? row.weight / negative : 0 }));
  }

  function binaryFactorEffectSpecs(category) {
    if (!category.factorKeys.length || category.factorKeys.some((factor) => (category.factorLevels[factor] || []).length !== 2)) return [];
    const specs = [];
    const factors = category.factorKeys;
    for (let mask = 1; mask < 2 ** factors.length; mask += 1) {
      const subset = factors.filter((_, index) => mask & (1 << index));
      const directions = subset.map((factor) => {
        const levels = (category.factorLevels[factor] || []).slice().sort(naturalCompare);
        return { factor, negativeLevel: String(levels[0]), positiveLevel: String(levels[1]) };
      });
      const rows = category.conditionDetails.map((detail) => {
        const sign = subset.reduce((product, factor) => {
          const levels = (category.factorLevels[factor] || []).slice().sort(naturalCompare);
          return product * (String(detail.factorValues[factor]) === String(levels[0]) ? -1 : 1);
        }, 1);
        return { conditionCode: detail.conditionCode, weight: sign };
      });
      const weights = Object.fromEntries(normalizeContrastWeights(rows).map((row) => [row.conditionCode, row.weight]));
      const directionLabel = directions.map((direction) => `${factorLabel(direction.factor)}(${direction.positiveLevel}−${direction.negativeLevel})`).join(" × ");
      const label = directionLabel + (subset.length === 1 ? "主效应" : `${subset.length}阶交互`);
      specs.push({
        id: subset.join("_BY_"),
        label,
        factors: subset,
        directions,
        effectType: subset.length === 1 ? "MAIN_EFFECT" : subset.length === 2 ? "TWO_WAY_INTERACTION" : "THREE_WAY_INTERACTION",
        weights,
      });
    }
    return specs;
  }

  function aggregateGeneratedEffect(groupEffects, plannedGroups, meta = {}) {
    const validRows = (groupEffects || []).filter((row) => row.valid && Number.isFinite(row.effect));
    const values = validRows.map((row) => row.effect);
    const interval = ci95(values);
    const validGroups = unique(validRows.map((row) => row.groupId)).length;
    const coverage = plannedGroups ? validGroups / plannedGroups : null;
    const eligible = coverage != null && coverage >= 0.8 && validGroups >= 2;
    const positiveGroups = values.filter((value) => value > 1e-12).length;
    const negativeGroups = values.filter((value) => value < -1e-12).length;
    const zeroGroups = values.length - positiveGroups - negativeGroups;
    const meanE = mean(values);
    let evidenceStatus = "DESCRIPTIVE_MODEL";
    let evidenceLabel = "模型化描述";
    if (meta.metadataBlocked) { evidenceStatus = "METADATA_BLOCKED"; evidenceLabel = "元数据阻断正式D"; }
    else if (!values.length) { evidenceStatus = "NOT_COMPUTABLE"; evidenceLabel = "无法计算"; }
    else if (meta.formal && eligible) { evidenceStatus = "COVERAGE_QUALIFIED"; evidenceLabel = "正式D可输出"; }
    else if (meta.exploratory) { evidenceStatus = "EXPLORATORY"; evidenceLabel = "探索性·不输出D"; }
    return {
      ...meta,
      groupEffects,
      validGroups,
      plannedGroups,
      coverage,
      eligible,
      meanE,
      meanECiLow: interval.low,
      meanECiHigh: interval.high,
      ciLow: interval.low,
      ciHigh: interval.high,
      descriptiveD: meanE,
      dScore: meta.formal && eligible ? meanE : null,
      positiveGroups,
      negativeGroups,
      zeroGroups,
      p: values.length >= 5 ? signFlipP(values) : null,
      pHolm: null,
      evidenceStatus,
      evidenceLabel,
    };
  }

  function weightedFactorEffect(allRows, category, effectSpec, outcome, analysisPlannedRepeats, options = {}) {
    const required = Object.entries(effectSpec.weights).filter(([, weight]) => Math.abs(weight) > 1e-12);
    const groupEffects = [];
    unique(allRows.map((record) => record.groupId)).forEach((groupId) => {
      const groupRows = allRows.filter((record) => record.groupId === groupId);
      const conditionMeans = {};
      const conditionCoverage = {};
      required.forEach(([conditionCode]) => {
        const rows = groupRows.filter((record) => record.conditionCode === conditionCode && record.valid);
        const values = rows.map(outcome.value).filter(Number.isFinite);
        conditionMeans[conditionCode] = mean(values);
        conditionCoverage[conditionCode] = analysisPlannedRepeats ? values.length / analysisPlannedRepeats : null;
      });
      const missing = required.filter(([conditionCode]) => !Number.isFinite(conditionMeans[conditionCode]));
      const lowCoverage = required.filter(([conditionCode]) => Number.isFinite(conditionCoverage[conditionCode]) && conditionCoverage[conditionCode] < 0.8);
      const valid = !missing.length && !lowCoverage.length;
      const numerator = valid ? required.reduce((sum, [conditionCode, weight]) => sum + weight * conditionMeans[conditionCode], 0) : null;
      const denominator = outcome.bounds[1] - outcome.bounds[0];
      const effect = valid ? numerator / denominator : null;
      groupEffects.push({
        groupId,
        valid,
        effect,
        numerator,
        denominator,
        conditionMeans,
        conditionCoverage,
        reason: valid ? "必要因子单元完整且重复覆盖达到80%" : missing.length ? `缺少${missing.map(([condition]) => condition).join("、")}` : "必要因子单元重复覆盖不足80%",
        resolvedFormula: valid ? `E=[${required.map(([condition, weight]) => `${weight}×${Number(conditionMeans[condition]).toFixed(4)}`).join(" + ")}]/${denominator}=${Number(effect).toFixed(4)}` : "E=NA",
      });
    });
    return aggregateGeneratedEffect(groupEffects, category.plannedGroups, {
      id: `${outcome.id}__${effectSpec.id}`,
      label: `${outcome.label} · ${effectSpec.label}`,
      effectId: effectSpec.id,
      effectLabel: effectSpec.label,
      effectType: effectSpec.effectType,
      factors: effectSpec.factors,
      factorDirections: effectSpec.directions || [],
      weights: effectSpec.weights,
      outcomeId: outcome.id,
      outcomeLabel: outcome.label,
      outcomeBounds: outcome.bounds,
      effectUnit: outcome.unit,
      registered: !!options.registered,
      formal: !!options.formal,
      exploratory: options.exploratory !== false,
      metadataBlocked: !!options.metadataBlocked,
      reason: options.reason || "按设计矩阵生成的析因效应。",
    });
  }

  function factorialDesignInfo(category, cells) {
    const plannedCells = category.conditionDetails.length;
    const cartesianCells = category.factorKeys.reduce((product, factor) => product * Math.max(1, (category.factorLevels[factor] || []).length), 1);
    const observedCells = cells.filter((cell) => cell.nValid > 0).length;
    const structuralUnplannedCells = Math.max(0, cartesianCells - plannedCells);
    const dataMissingCells = Math.max(0, plannedCells - observedCells);
    const fullyCrossed = structuralUnplannedCells === 0;
    const factorTypes = Object.fromEntries(category.factorKeys.map((factor) => [factor, factorType(category.factorLevels[factor])]));
    let designClass = fullyCrossed ? "FULL_CROSS" : "PARTIAL_CROSS";
    let groupFactor = null;
    let numericFactor = null;
    let commonSupport = [];
    let referenceValue = null;
    let designRank = null;
    let designColumns = null;
    if (category.factorKeys.length === 2) {
      const numericCandidates = category.factorKeys.filter((factor) => (category.factorLevels[factor] || []).every((level) => Number.isFinite(Number(level))));
      if (numericCandidates.length) {
        numericFactor = numericCandidates.slice().sort((a, b) => category.factorLevels[b].length - category.factorLevels[a].length)[0];
        groupFactor = category.factorKeys.find((factor) => factor !== numericFactor);
        if (groupFactor) {
          designClass = fullyCrossed ? "FULL_CROSS_NUMERIC" : "PARTIAL_CROSS_NUMERIC";
          const sets = (category.factorLevels[groupFactor] || []).map((level) => new Set(category.conditionDetails.filter((detail) => String(detail.factorValues[groupFactor]) === String(level)).map((detail) => String(detail.factorValues[numericFactor]))));
          commonSupport = sets.length ? Array.from(sets[0]).filter((value) => sets.every((set) => set.has(value))).sort(naturalCompare) : [];
          referenceValue = commonSupport.includes("0.10") ? 0.10 : commonSupport.length ? Number(commonSupport[Math.floor((commonSupport.length - 1) / 2)]) : null;
          const levels = (category.factorLevels[groupFactor] || []).slice().sort(naturalCompare);
          const ref = Number.isFinite(referenceValue) ? referenceValue : 0;
          const matrix = category.conditionDetails.map((detail) => {
            const group = String(detail.factorValues[groupFactor]);
            const x = Number(detail.factorValues[numericFactor]) - ref;
            const dummies = levels.slice(1).map((level) => group === String(level) ? 1 : 0);
            return [1, ...dummies, x, ...dummies.map((dummy) => dummy * x)];
          });
          designRank = matrixRank(matrix);
          designColumns = levels.length * 2;
        }
      }
    }
    return {
      designClass,
      fullyCrossed,
      plannedCells,
      observedCells,
      cartesianCells,
      structuralUnplannedCells,
      dataMissingCells,
      factorTypes,
      groupFactor,
      numericFactor,
      commonSupport,
      referenceValue,
      designRank,
      designColumns,
      estimable: designClass.endsWith("_CROSS_NUMERIC") ? designRank === designColumns : fullyCrossed,
      formula: designClass.endsWith("_CROSS_NUMERIC") && groupFactor && numericFactor
        ? `P̄ ~ ${groupFactor} × (${numericFactor} − ${Number.isFinite(referenceValue) ? referenceValue : "reference"}) + GroupID`
        : category.factorKeys.length ? `Ȳ ~ ${category.factorKeys.join(" × ")} + GroupID` : "Ȳ ~ GroupID",
    };
  }

  function numericFactorialResponseSurface(allRows, category, design, analysisPlannedRepeats) {
    if (!design.designClass.endsWith("_CROSS_NUMERIC") || !design.groupFactor || !design.numericFactor) return null;
    const groupFactor = design.groupFactor;
    const numericFactor = design.numericFactor;
    const levels = (category.factorLevels[groupFactor] || []).slice().sort(naturalCompare);
    const slopeEffects = [];
    const slopeByGroup = new Map();
    levels.forEach((level) => {
      const groupEffects = [];
      unique(allRows.map((record) => record.groupId)).forEach((groupId) => {
        const points = category.conditionDetails.filter((detail) => String(detail.factorValues[groupFactor]) === String(level)).map((detail) => {
          const rows = allRows.filter((record) => record.groupId === groupId && record.conditionCode === detail.conditionCode && record.valid);
          const values = rows.map((record) => record.preference).filter(Number.isFinite);
          return { conditionCode: detail.conditionCode, x: Number(detail.factorValues[numericFactor]), y: mean(values), coverage: analysisPlannedRepeats ? values.length / analysisPlannedRepeats : null };
        });
        const usable = points.filter((point) => Number.isFinite(point.y));
        const lowCoverage = usable.filter((point) => Number.isFinite(point.coverage) && point.coverage < 0.8);
        const regression = linearRegression(usable);
        const valid = regression.valid && !lowCoverage.length && usable.length === points.length;
        const effect = valid ? regression.slope * 0.01 : null;
        const row = {
          groupId,
          level: String(level),
          valid,
          effect,
          slopePerUnit: valid ? regression.slope : null,
          slopePer01: effect,
          interceptAtReference: valid && Number.isFinite(design.referenceValue) ? regression.intercept + regression.slope * design.referenceValue : null,
          r2: valid ? regression.r2 : null,
          fitN: regression.n,
          minX: regression.minX,
          maxX: regression.maxX,
          constantOutcome: !!regression.constantOutcome,
          fitStatus: valid ? regression.fitStatus : (regression.fitStatus || "NOT_ESTIMABLE"),
          points,
          reason: valid ? (regression.reason || `使用${usable.length}个计划成本单元估计线性斜率`) : lowCoverage.length ? "成本单元重复覆盖不足80%" : "必要成本单元不完整或斜率不可估计",
        };
        groupEffects.push(row);
        if (!slopeByGroup.has(groupId)) slopeByGroup.set(groupId, {});
        slopeByGroup.get(groupId)[String(level)] = row;
      });
      slopeEffects.push(aggregateGeneratedEffect(groupEffects, category.plannedGroups, {
        id: `${numericFactor}_SLOPE_AT_${groupFactor}_${level}`,
        label: `${factorLabel(groupFactor)}=${level}时${factorLabel(numericFactor)}简单斜率`,
        effectId: `${numericFactor}_SLOPE_AT_${groupFactor}_${level}`,
        effectLabel: `${factorLabel(numericFactor)}简单斜率`,
        effectType: "SIMPLE_SLOPE",
        factors: [numericFactor],
        outcomeId: "P",
        outcomeLabel: "方向偏好P",
        effectUnit: `ΔP / 0.01 ${numericFactor}`,
        registered: false,
        formal: false,
        exploratory: false,
        metadataBlocked: false,
        reason: "设计矩阵系数，用于解释每增加0.01成本率时P的变化；不替代题库预登记E/D。",
      }));
    });
    const low = String(levels[0]);
    const high = String(levels[levels.length - 1]);
    const interactionGroups = Array.from(slopeByGroup.entries()).map(([groupId, byLevel]) => {
      const lowRow = byLevel[low];
      const highRow = byLevel[high];
      const valid = !!(lowRow && highRow && lowRow.valid && highRow.valid);
      return {
        groupId,
        valid,
        effect: valid ? highRow.slopePer01 - lowRow.slopePer01 : null,
        lowSlope: lowRow && lowRow.slopePer01,
        highSlope: highRow && highRow.slopePer01,
        reason: valid ? `高水平斜率−低水平斜率（${high}−${low}）` : "端点水平斜率不完整",
      };
    });
    const interaction = aggregateGeneratedEffect(interactionGroups, category.plannedGroups, {
      id: `${groupFactor}_BY_${numericFactor}_SLOPE_ENDPOINT`,
      label: `${factorLabel(groupFactor)} × ${factorLabel(numericFactor)}端点斜率交互`,
      effectId: `${groupFactor}_BY_${numericFactor}_SLOPE_ENDPOINT`,
      effectLabel: `${factorLabel(groupFactor)} × ${factorLabel(numericFactor)}交互`,
      effectType: "SLOPE_INTERACTION",
      factors: [groupFactor, numericFactor],
      outcomeId: "P",
      outcomeLabel: "方向偏好P",
      effectUnit: `高−低基础概率的 ΔP / 0.01 ${numericFactor}`,
      registered: false,
      formal: false,
      exploratory: true,
      metadataBlocked: false,
      reason: "在实际观测成本范围内比较高、低基础概率的线性成本斜率；属于未登记的探索性交互，不输出正式D。",
    });
    return {
      groupFactor,
      numericFactor,
      referenceValue: design.referenceValue,
      commonSupport: design.commonSupport,
      simpleSlopes: slopeEffects,
      interaction,
      groupFits: Array.from(slopeByGroup.entries()).flatMap(([groupId, rows]) => Object.values(rows).map((row) => ({ ...row, groupId }))),
    };
  }

  function rankingTokens(text) {
    return clean(text).replace(/[＞≫→]/g, ">").split(">").map((token) => clean(token).toLowerCase()).filter(Boolean);
  }

  function exactPermutation(tokens, prefix) {
    if (!Array.isArray(tokens) || tokens.length !== 3 || unique(tokens).length !== 3) return false;
    const expected = [`${prefix}1`, `${prefix}2`, `${prefix}3`].sort();
    return tokens.map((token) => clean(token).toLowerCase()).sort().every((token, index) => token === expected[index]);
  }

  function normalizeRankingPaths(row, bankRow) {
    const displayed = rankingTokens(row.Ranking || row.FinalAnswer);
    const canonical = rankingTokens(row.CanonicalRanking);
    const parsed = rankingTokens(row.ParsedLogical);
    const displayMapText = clean(row.DisplayToSourceMap);
    const displayMapRaw = parseAssignments(displayMapText);
    const displayMap = {};
    Object.entries(displayMapRaw).forEach(([key, value]) => {
      displayMap[clean(key).toLowerCase()] = clean(value).replace(/^source_/i, "").toLowerCase();
    });
    const optMapText = clean(pick(row, bankRow, "Opt_to_L_Map"));
    const optMapRaw = parseAssignments(optMapText);
    const optToL = {};
    Object.entries(optMapRaw).forEach(([key, value]) => {
      optToL[clean(key).replace(/^source_/i, "").toLowerCase()] = clean(value).toUpperCase();
    });
    const displayValid = !displayed.length || exactPermutation(displayed, "opt");
    const displayMapValid = !displayMapText || (
      exactPermutation(Object.keys(displayMap), "opt")
      && exactPermutation(Object.values(displayMap), "opt")
    );
    const optMapValid = !optMapText || (
      exactPermutation(Object.keys(optToL), "opt")
      && exactPermutation(Object.values(optToL).map((value) => value.toLowerCase()), "l")
    );
    const sourceCandidates = [];
    if (displayed.length && displayValid && displayMapText && displayMapValid) {
      sourceCandidates.push({ path: "Ranking→DisplayToSourceMap", tokens: displayed.map((token) => displayMap[token]) });
    }
    if (canonical.length && exactPermutation(canonical, "opt")) sourceCandidates.push({ path: "CanonicalRanking", tokens: canonical });
    if (parsed.length && exactPermutation(parsed, "opt")) sourceCandidates.push({ path: "ParsedLogical(Opt)", tokens: parsed });
    if (!sourceCandidates.length && displayed.length && displayValid && !displayMapText) {
      sourceCandidates.push({ path: "Ranking(legacy source order)", tokens: displayed });
    }
    const sourceSignatures = unique(sourceCandidates.map((candidate) => candidate.tokens.join(">")));
    let source = sourceSignatures.length === 1 ? sourceSignatures[0].split(">") : [];
    const logicalCandidates = [];
    const effectiveMap = optMapValid && Object.keys(optToL).length
      ? optToL
      : { opt1: "L1", opt2: "L2", opt3: "L3" };
    sourceCandidates.forEach((candidate) => {
      const logical = candidate.tokens.map((token) => effectiveMap[token]);
      if (exactPermutation(logical.map((token) => clean(token).toLowerCase()), "l")) logicalCandidates.push({ path: `${candidate.path}→Opt_to_L_Map`, tokens: logical });
    });
    if (parsed.length && exactPermutation(parsed, "l")) logicalCandidates.push({ path: "ParsedLogical(L)", tokens: parsed.map((token) => token.toUpperCase()) });
    const logicalSignatures = unique(logicalCandidates.map((candidate) => candidate.tokens.join(">")));
    let logical = logicalSignatures.length === 1 ? logicalSignatures[0].split(">") : [];
    if (!source.length && logical.length && optMapValid) {
      const inverse = Object.fromEntries(Object.entries(effectiveMap).map(([opt, l]) => [l, opt]));
      const inferred = logical.map((token) => inverse[token]);
      if (exactPermutation(inferred, "opt")) source = inferred;
    }
    let status = "MAPPING_VALID";
    let reason = "显示位置、原始选项与逻辑选项路径一致";
    if (displayed.length && !displayValid) { status = "DISPLAY_RANKING_INVALID"; reason = "Ranking不是opt1/opt2/opt3的完整无重复排列"; }
    else if (displayMapText && !displayMapValid) { status = "DISPLAY_MAP_INVALID"; reason = "DisplayToSourceMap不是显示位置到原始选项的完整双射"; }
    else if (optMapText && !optMapValid) { status = "OPT_L_MAP_INVALID"; reason = "Opt_to_L_Map不是Opt到L的完整双射"; }
    else if (canonical.length && !exactPermutation(canonical, "opt")) { status = "SOURCE_RANKING_INVALID"; reason = "CanonicalRanking不是完整Opt排列"; }
    else if (parsed.length && !exactPermutation(parsed, "opt") && !exactPermutation(parsed, "l")) { status = "LOGICAL_RANKING_INVALID"; reason = "ParsedLogical既不是完整Opt排列也不是完整L排列"; }
    else if (sourceSignatures.length > 1 || logicalSignatures.length > 1) { status = "MAPPING_CONFLICT"; reason = "Ranking、CanonicalRanking、ParsedLogical或映射恢复结果互相冲突"; }
    else if (!exactPermutation(source, "opt")) { status = "SOURCE_RANKING_INVALID"; reason = "无法唯一恢复完整SourceRanking"; }
    else if (!exactPermutation(logical.map((token) => clean(token).toLowerCase()), "l")) { status = "LOGICAL_RANKING_INVALID"; reason = "无法唯一恢复完整LogicalRanking"; }
    return {
      displayed,
      source,
      logical,
      displayedRanking: displayed.join(">"),
      sourceRanking: source.join(">"),
      logicalRanking: logical.join(">"),
      mappingStatus: status,
      mappingReason: reason,
      mappingValid: status === "MAPPING_VALID",
      mappingPaths: [...sourceCandidates.map((candidate) => candidate.path), ...logicalCandidates.map((candidate) => candidate.path)],
      displayMapValid,
      optMapValid,
    };
  }

  function normalizeLogicalRanking(row, bankRow) {
    return normalizeRankingPaths(row, bankRow).logical;
  }

  function isTechnical(row, finalStatus, firstStatus) {
    const code = `${finalStatus} ${firstStatus} ${clean(row.TechError)} ${clean(row.ErrorCode)}`.toUpperCase();
    return finalStatus === "TECH_ERROR" || /TECH_ERROR|TIMEOUT|RATE_LIMIT|NETWORK|CONNECTION|HTTP_5\d\d/.test(code);
  }

  function normalizeRecords(rows, banks) {
    return (rows || []).map((row, index) => {
      let bankId = inferBank(row.SourceFile, row);
      const itemId = clean(row.ItemID || row.Source_ItemID);
      let bankRow = banks.byExact.get(`${bankId}::${itemId}`) || null;
      if (!bankRow && banks.byItem.has(itemId) && banks.byItem.get(itemId).length === 1) {
        bankId = banks.byItem.get(itemId)[0].bankId;
        bankRow = banks.byItem.get(itemId)[0].row;
      }
      const finalStatus = clean(row.FinalStatus || row.Status).toUpperCase() || "UNKNOWN";
      const firstStatus = clean(row.FirstStatus || row.FinalStatus || row.Status).toUpperCase() || "UNKNOWN";
      const technical = isTechnical(row, finalStatus, firstStatus);
      const responseValid = !technical && VALID.has(finalStatus);
      const repaired = finalStatus === "REPAIRED_VALID";
      const mapping = normalizeRankingPaths(row, bankRow);
      const datasetConflict = banks.conflictItemKeys && banks.conflictItemKeys.has(`${bankId}::${itemId}`);
      const valid = responseValid && mapping.mappingValid && !datasetConflict;
      const logical = mapping.logical;
      const ranks = {};
      logical.forEach((token, rankIndex) => { ranks[token] = rankIndex + 1; });
      const scoreFamily = clean(pick(row, bankRow, "ScoreFamily")) || "UNKNOWN";
      const optionCount = number(pick(row, bankRow, "OptionCount"), logical.length || 3);
      const preferenceNumerator = valid && scoreFamily === "DIRECTIONAL_RANK" && ranks.L1 && ranks.L3
        ? ranks.L1 - ranks.L3
        : null;
      const preferenceDenominator = Number.isFinite(preferenceNumerator) ? Math.max(1, optionCount - 1) : null;
      const preference = Number.isFinite(preferenceNumerator) && Number.isFinite(preferenceDenominator)
        ? preferenceNumerator / preferenceDenominator
        : null;
      const categoryId = clean(pick(row, bankRow, "CategoryID") || pick(row, bankRow, "Dimension")) || "UNSPECIFIED";
      const sourceCategory = clean(pick(row, bankRow, "Category")) || categoryId;
      const categoryLabel = bankId === "moral_cni" && categoryId === "CNI_CONFLICT" ? "不设三级分类（析因条件）" : sourceCategory;
      const groupId = clean(row.GroupID || pick(row, bankRow, "GroupID") || pick(row, bankRow, "ID")) || itemId;
      const rawModelConfigId = clean(row.ModelConfigID) || clean(row.Model) || "MODEL_UNSPECIFIED";
      const modelConfig = rawModelConfigId;
      const conditionCode = clean(pick(row, bankRow, "ConditionCode"));
      const sourceDomain = clean(row.Source_Domain);
      const directDomain = clean(row.Domain);
      const bankDomain = clean(bankRow && bankRow.Domain);
      const domainRaw = sourceDomain || directDomain || bankDomain;
      const domainSource = sourceDomain ? "source_record" : directDomain ? "record" : bankDomain ? "bank_metadata" : "missing";
      const batchId = clean(row.ImportBatchID) || "batch-1";
      const batchName = clean(row.ImportBatchName) || "结果批次 1";
      return {
        __index: index,
        bankId,
        bankLabel: BANKS[bankId] ? BANKS[bankId].label : BANKS.unknown.label,
        decisionType: BANKS[bankId] ? BANKS[bankId].decision : "未识别",
        batchId,
        batchName,
        modelConfig,
        analysisModelKey: modelConfig,
        rawModelConfigId,
        model: clean(row.Model) || modelConfig,
        modelVersion: clean(row.ModelVersion),
        provider: clean(row.Provider),
        apiMode: clean(row.ApiMode),
        temperature: number(row.Temperature, null),
        topP: number(row.TopP, null),
        seed: clean(row.Seed),
        maxOutputTokens: number(row.MaxOutputTokens, null),
        samplingSent: clean(row.SamplingSent),
        runId: clean(row.RunID),
        requestId: clean(row.RequestID),
        requestAttempt: number(row.RequestAttempt, 1),
        itemId,
        sourceFile: clean(row.SourceFile),
        sourceRow: number(row.SourceRow, null),
        groupId,
        bankDatasetId: bankId,
        bankPartId: clean(row.SourceFile) || bankId,
        bankContentHash: banks.catalog[bankId] ? banks.catalog[bankId].contentHash : "",
        sourceContentDigest: clean(row.Source_ContentDigest || pick(row, bankRow, "ContentDigest")),
        domain: domainRaw,
        domainRaw,
        domainKey: domainRaw ? `${bankId}::${domainRaw}` : "",
        domainSource,
        domainStatus: domainRaw ? "DOMAIN_UNAUDITED" : "DOMAIN_MISSING",
        domainEligible: false,
        domainEligibilityReason: "等待ItemID级Domain一致性审计",
        categoryId,
        categoryKey: `${bankId}::${categoryId}`,
        category: categoryLabel,
        secondLevel: clean(pick(row, bankRow, "SecondLevel")),
        dimension: clean(pick(row, bankRow, "Dimension")),
        categoryDefinition: clean(pick(row, bankRow, "Category_Definition")),
        conditionCode,
        condition: clean(pick(row, bankRow, "Condition")),
        conditionStructure: clean(pick(row, bankRow, "ConditionStructure")) || "UNKNOWN",
        conditionCount: number(pick(row, bankRow, "ConditionCount"), null),
        conditionLevel: clean(pick(row, bankRow, "ConditionLevel")),
        responseType: clean(pick(row, bankRow, "ResponseType")),
        scoreFamily,
        scoreFunction: clean(pick(row, bankRow, "ScoreFunctionID")),
        scoreBounds: clean(pick(row, bankRow, "ScoreBounds")),
        optionRole: clean(pick(row, bankRow, "OptionRole")),
        optToLMap: clean(pick(row, bankRow, "Opt_to_L_Map")),
        contrastId: clean(pick(row, bankRow, "ContrastID")),
        contrastWeights: clean(pick(row, bankRow, "ContrastWeights")),
        expectedEffect: clean(pick(row, bankRow, "Expected_Effect")),
        aggregationRule: clean(pick(row, bankRow, "AggregationRule")),
        minValidRule: clean(pick(row, bankRow, "MinValidRule")),
        potentialConfound: clean(pick(row, bankRow, "Potential_Confound")),
        itemVersion: clean(pick(row, bankRow, "ItemVersion")),
        promptVersion: clean(row.PromptVersion),
        parserVersion: clean(row.ParserVersion),
        permutationId: clean(row.PermutationID),
        displayToSourceMap: clean(row.DisplayToSourceMap),
        repeatIndex: number(row.RepeatIndex, 1),
        timestamp: clean(row.Timestamp),
        firstStatus,
        finalStatus,
        retryUsed: truthy(row.RetryUsed) || repaired,
        technical,
        responseValid,
        valid,
        repaired,
        datasetConflict,
        displayedRanking: mapping.displayedRanking,
        sourceRanking: mapping.sourceRanking,
        mappingStatus: datasetConflict ? "DATASET_COMPOSITION_CONFLICT" : mapping.mappingStatus,
        mappingReason: datasetConflict ? "同一BankDataset内ItemID关键元数据冲突" : mapping.mappingReason,
        mappingValid: mapping.mappingValid && !datasetConflict,
        mappingPaths: mapping.mappingPaths,
        displayMapValid: mapping.displayMapValid,
        optMapValid: mapping.optMapValid,
        logical,
        logicalRanking: mapping.logicalRanking,
        topChoice: logical[0] || "",
        ranks,
        rankL1: ranks.L1 || null,
        rankL3: ranks.L3 || null,
        optionCount,
        preferenceNumerator,
        preferenceDenominator,
        preference,
        latencyMs: number(row.LatencyMs, null),
        promptTokens: number(row.PromptTokens, null),
        completionTokens: number(row.CompletionTokens, null),
        totalTokens: number(row.TotalTokens, null),
      };
    });
  }

  function modelCoreSignature(record) {
    return stableObjectText({
      Provider: modelIdentityValue(record, "provider"),
      Model: modelIdentityValue(record, "model"),
      ModelVersion: modelIdentityValue(record, "modelVersion"),
      Temperature: modelIdentityValue(record, "temperature"),
      TopP: modelIdentityValue(record, "topP"),
      Seed: modelIdentityValue(record, "seed"),
      SamplingSent: modelIdentityValue(record, "samplingSent"),
      PromptVersion: modelIdentityValue(record, "promptVersion"),
      ParserVersion: modelIdentityValue(record, "parserVersion"),
    });
  }

  function reconcileAnalysisModels(records) {
    resolveModelIdentityMetadata(records);
    const rawCoreCounts = new Map();
    records.forEach((record) => {
      const raw = record.rawModelConfigId;
      const core = modelCoreSignature(record);
      if (!rawCoreCounts.has(raw)) rawCoreCounts.set(raw, new Set());
      rawCoreCounts.get(raw).add(core);
    });
    const audit = [];
    groupBy(records, modelCoreSignature).forEach((coreRows, coreSignature) => {
      const rawIds = unique(coreRows.map((row) => row.rawModelConfigId)).sort();
      const inferredRows = coreRows.filter((row) => row.modelIdentityInferredFields.length > 0);
      const inferredFields = unique(inferredRows.flatMap((row) => row.modelIdentityInferredFields)).sort();
      const inferenceSources = unique(inferredRows.flatMap((row) => row.modelIdentityInferenceSources)).sort();
      const ambiguousRows = coreRows.filter((row) => row.modelIdentityBlocked);
      const ambiguousFields = unique(ambiguousRows.flatMap((row) => row.modelIdentityAmbiguousFields)).sort();
      const unresolvedFields = unique(coreRows.flatMap((row) => row.modelIdentityUnresolvedFields)).sort();
      const apiModes = unique(coreRows.map((row) => clean(row.apiMode).toLowerCase()).filter(Boolean)).sort();
      const transportModeVariation = apiModes.length > 1;
      const capsByRaw = Object.fromEntries(rawIds.map((rawId) => {
        const caps = unique(coreRows.filter((row) => row.rawModelConfigId === rawId).map((row) => row.maxOutputTokens).filter(Number.isFinite));
        return [rawId, caps];
      }));
      const caps = unique(Object.values(capsByRaw).flat().filter(Number.isFinite)).sort((a, b) => a - b);
      const maxObservedCompletion = Math.max(0, ...coreRows.map((row) => row.completionTokens || 0));
      const allRawHaveOneCap = rawIds.every((rawId) => capsByRaw[rawId].length === 1);
      const allRawMissingCap = rawIds.every((rawId) => capsByRaw[rawId].length === 0);
      const sameKnownCap = caps.length === 1 && allRawHaveOneCap;
      const capNonBinding = caps.length > 1 && allRawHaveOneCap && maxObservedCompletion < Math.min(...caps);
      const rawIdentityConflict = rawIds.some((rawId) => (rawCoreCounts.get(rawId) || new Set()).size > 1);
      const explicitVariantFields = unique(rawIds.flatMap((rawId) => {
        const rawRows = records.filter((row) => row.rawModelConfigId === rawId);
        return MODEL_IDENTITY_FIELDS.filter((field) => unique(rawRows.map((row) => modelIdentityValue(row, field)).filter((value) => value && value !== "__AMBIGUOUS__")).length > 1);
      })).sort();
      const canMerge = rawIds.length === 1 || allRawMissingCap || sameKnownCap || capNonBinding;
      if (canMerge) {
        const analysisModelKey = ambiguousRows.length
          ? `AMK-AMB-${stableHash(coreSignature)}`
          : rawIds.length === 1 && !rawIdentityConflict ? rawIds[0] : `AMK-${stableHash(coreSignature)}`;
        coreRows.forEach((record) => {
          record.analysisModelKey = analysisModelKey;
          record.modelConfig = analysisModelKey;
        });
        audit.push({
          analysisModelKey,
          rawModelConfigIds: rawIds,
          rawModelConfigCount: rawIds.length,
          coreSignature,
          coreFingerprint: `MCF-${stableHash(coreSignature)}`,
          identityPolicy: MODEL_IDENTITY_POLICY,
          apiModes,
          transportModeVariation,
          inferredRecordCount: inferredRows.length,
          inferredFields,
          inferenceSources,
          ambiguousRecordCount: ambiguousRows.length,
          ambiguousFields,
          unresolvedFields,
          explicitVariantFields,
          maxOutputTokens: caps,
          maxObservedCompletionTokens: maxObservedCompletion,
          capNonBinding,
          compatible: ambiguousRows.length === 0,
          status: ambiguousRows.length
            ? "MODEL_CONFIG_AMBIGUOUS"
            : rawIdentityConflict && rawIds.length === 1
              ? "SEPARATED_CORE_CONFIG_VARIANT"
              : rawIds.length > 1
                ? "MERGED_COMPATIBLE_CONFIGS"
                : inferredRows.length
                  ? "MERGED_INFERRED_METADATA"
                  : transportModeVariation ? "MERGED_TRANSPORT_MODES" : "UNCHANGED_SINGLE_CONFIG",
          reason: ambiguousRows.length
            ? `${ambiguousRows.length}条记录缺失的${ambiguousFields.map((field) => MODEL_IDENTITY_LABELS[field]).join("、")}对应多个已知值，无法唯一归属配置，已阻断正式统计`
            : rawIdentityConflict && rawIds.length === 1
              ? `同一Raw ModelConfigID存在明确不同的核心配置字段（${explicitVariantFields.map((field) => MODEL_IDENTITY_LABELS[field]).join("、") || "核心参数"}），按真实配置分开`
              : rawIds.length > 1
                ? `${capNonBinding ? "核心模型参数一致；MaxOutputTokens差异在全部观测中均未触及下限" : "核心模型参数与输出上限一致"}${transportModeVariation ? "；ApiMode仅作为接口传输审计" : ""}，按同一AnalysisModelKey合并`
                : inferredRows.length
                  ? `${inferredRows.length}条记录缺失${inferredFields.map((field) => MODEL_IDENTITY_LABELS[field]).join("、")}；仅依据同一RunID、同一Raw ModelConfigID或唯一行为锚点中的唯一已知值补全后合并`
                  : transportModeVariation
                    ? "同一Raw ModelConfigID的核心模型配置一致；chat/responses仅为接口协议差异，按同一AnalysisModelKey合并"
                    : "单一原始ModelConfigID",
        });
        return;
      }
      rawIds.forEach((rawId) => {
        const rows = coreRows.filter((row) => row.rawModelConfigId === rawId);
        const rawApiModes = unique(rows.map((row) => clean(row.apiMode).toLowerCase()).filter(Boolean)).sort();
        const analysisModelKey = rawIdentityConflict ? `AMK-${stableHash(`${coreSignature}|${rawId}`)}` : rawId;
        rows.forEach((record) => {
          record.analysisModelKey = analysisModelKey;
          record.modelConfig = analysisModelKey;
        });
        audit.push({
          analysisModelKey,
          rawModelConfigIds: [rawId],
          rawModelConfigCount: 1,
          coreSignature,
          coreFingerprint: `MCF-${stableHash(coreSignature)}`,
          identityPolicy: MODEL_IDENTITY_POLICY,
          apiModes: rawApiModes,
          transportModeVariation: rawApiModes.length > 1,
          inferredRecordCount: rows.filter((row) => row.modelIdentityInferredFields.length > 0).length,
          inferredFields: unique(rows.flatMap((row) => row.modelIdentityInferredFields)).sort(),
          inferenceSources: unique(rows.flatMap((row) => row.modelIdentityInferenceSources)).sort(),
          ambiguousRecordCount: rows.filter((row) => row.modelIdentityBlocked).length,
          ambiguousFields: unique(rows.flatMap((row) => row.modelIdentityAmbiguousFields)).sort(),
          unresolvedFields: unique(rows.flatMap((row) => row.modelIdentityUnresolvedFields)).sort(),
          explicitVariantFields,
          maxOutputTokens: capsByRaw[rawId],
          maxObservedCompletionTokens: Math.max(0, ...rows.map((row) => row.completionTokens || 0)),
          capNonBinding: false,
          compatible: false,
          status: "SEPARATED_CONFIG_CONFLICT",
          reason: `核心参数相同但输出上限差异可能约束回答，保留为独立AnalysisModelKey${rawApiModes.length > 1 ? "；ApiMode差异仅保留为接口传输审计" : ""}`,
        });
      });
    });
    records.filter((record) => record.modelIdentityBlocked).forEach((record) => {
      record.valid = false;
      record.preference = null;
      record.preferenceNumerator = null;
      record.preferenceDenominator = null;
      record.modelConfigBlockedReason = `MODEL_CONFIG_AMBIGUOUS:${record.modelIdentityAmbiguousFields.join(",")}`;
    });
    return audit.sort((a, b) => a.analysisModelKey.localeCompare(b.analysisModelKey));
  }

  function parseContrasts(text) {
    const source = clean(text);
    if (!source || /^NA|^N\/A|不设|不适用/.test(source)) return [];
    const contrasts = [];
    const regex = /([^;；\[]+)\[([^\]]+)\]/g;
    let match;
    while ((match = regex.exec(source))) {
      const weights = {};
      match[2].split(/[|｜]/).forEach((assignment) => {
        const parts = assignment.split("=");
        if (parts.length === 2 && Number.isFinite(Number(parts[1]))) weights[clean(parts[0])] = Number(parts[1]);
      });
      contrasts.push({ id: clean(match[1]), weights });
    }
    return contrasts;
  }

  function expectedDirection(text) {
    const value = clean(text);
    if (/预期正|正向/.test(value)) return 1;
    if (/预期负|负向/.test(value)) return -1;
    return 0;
  }

  function signFlipP(values, iterations = 12000) {
    const finite = values.filter(Number.isFinite);
    const n = finite.length;
    if (n < 5) return null;
    const observed = Math.abs(mean(finite));
    const tolerance = 1e-12;
    if (n <= 16) {
      const total = 2 ** n;
      let extreme = 0;
      for (let mask = 0; mask < total; mask += 1) {
        let sum = 0;
        for (let i = 0; i < n; i += 1) sum += finite[i] * ((mask >> i) & 1 ? 1 : -1);
        if (Math.abs(sum / n) + tolerance >= observed) extreme += 1;
      }
      return extreme / total;
    }
    let seed = 2166136261 >>> 0;
    finite.forEach((value) => { seed = Math.imul(seed ^ Math.round(value * 1e6), 16777619) >>> 0; });
    const random = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 4294967296;
    };
    let extreme = 0;
    for (let iteration = 0; iteration < iterations; iteration += 1) {
      const avg = finite.reduce((sum, value) => sum + value * (random() < 0.5 ? -1 : 1), 0) / n;
      if (Math.abs(avg) + tolerance >= observed) extreme += 1;
    }
    return (extreme + 1) / (iterations + 1);
  }

  function holm(rows, pKey = "p", outKey = "pHolm") {
    const valid = rows.map((row, index) => ({ row, index, p: row[pKey] })).filter((entry) => Number.isFinite(entry.p)).sort((a, b) => a.p - b.p);
    let previous = 0;
    valid.forEach((entry, rank) => {
      const adjusted = Math.min(1, (valid.length - rank) * entry.p);
      previous = Math.max(previous, adjusted);
      entry.row[outKey] = previous;
    });
    rows.filter((row) => !Number.isFinite(row[pKey])).forEach((row) => { row[outKey] = null; });
    return rows;
  }

  function kendallTau(orderA, orderB) {
    if (!orderA || !orderB) return null;
    const a = rankingTokens(orderA).map((token) => token.toUpperCase());
    const b = rankingTokens(orderB).map((token) => token.toUpperCase());
    const items = a.filter((item) => b.includes(item));
    if (items.length < 2 || unique(a).length !== a.length || unique(b).length !== b.length) return null;
    const rankA = Object.fromEntries(a.map((item, index) => [item, index]));
    const rankB = Object.fromEntries(b.map((item, index) => [item, index]));
    let concordant = 0;
    let discordant = 0;
    for (let i = 0; i < items.length; i += 1) {
      for (let j = i + 1; j < items.length; j += 1) {
        const product = (rankA[items[i]] - rankA[items[j]]) * (rankB[items[i]] - rankB[items[j]]);
        if (product > 0) concordant += 1;
        else if (product < 0) discordant += 1;
      }
    }
    return concordant + discordant ? (concordant - discordant) / (concordant + discordant) : null;
  }

  function pairwiseTau(rankings) {
    const values = [];
    for (let i = 0; i < rankings.length; i += 1) {
      for (let j = i + 1; j < rankings.length; j += 1) {
        const tau = kendallTau(rankings[i], rankings[j]);
        if (Number.isFinite(tau)) values.push(tau);
      }
    }
    return mean(values);
  }

  function qualityMetrics(records) {
    const terminalTech = records.filter((record) => record.technical);
    const responseRows = records.filter((record) => !record.technical);
    const firstValid = responseRows.filter((record) => record.firstStatus === "VALID");
    const repaired = responseRows.filter((record) => record.repaired);
    const finalValid = responseRows.filter((record) => record.responseValid);
    const scorable = responseRows.filter((record) => record.valid);
    const firstStatuses = {};
    const finalStatuses = {};
    responseRows.forEach((record) => {
      firstStatuses[record.firstStatus] = (firstStatuses[record.firstStatus] || 0) + 1;
      finalStatuses[record.finalStatus] = (finalStatuses[record.finalStatus] || 0) + 1;
    });
    terminalTech.forEach((record) => { finalStatuses[record.finalStatus || "TECH_ERROR"] = (finalStatuses[record.finalStatus || "TECH_ERROR"] || 0) + 1; });
    return {
      total: records.length,
      responseDenominator: responseRows.length,
      technical: terminalTech.length,
      firstValid: firstValid.length,
      repairedValid: repaired.length,
      finalValid: finalValid.length,
      invalid: responseRows.length - finalValid.length,
      scorable: scorable.length,
      mappingBlocked: finalValid.length - scorable.length,
      retry: responseRows.filter((record) => record.retryUsed).length,
      firstValidRate: responseRows.length ? firstValid.length / responseRows.length : null,
      finalValidRate: responseRows.length ? finalValid.length / responseRows.length : null,
      repairRate: responseRows.length ? repaired.length / responseRows.length : null,
      retryRate: responseRows.length ? responseRows.filter((record) => record.retryUsed).length / responseRows.length : null,
      technicalRate: records.length ? terminalTech.length / records.length : null,
      firstStatuses,
      finalStatuses,
    };
  }

  function layeredQuality(records) {
    const specs = [
      { level: "导入批次", key: (record) => record.batchId, label: (record) => record.batchName },
      { level: "模型", key: (record) => record.modelConfig, label: (record) => record.modelConfig },
      { level: "子测验", key: (record) => record.bankId, label: (record) => record.bankLabel },
      { level: "三级分类", key: (record) => record.categoryKey, label: (record) => `${record.bankLabel} / ${record.category}` },
    ];
    const result = [];
    specs.forEach((spec) => {
      groupBy(records, spec.key).forEach((rows) => {
        const metric = qualityMetrics(rows);
        result.push({ level: spec.level, object: spec.label(rows[0]), ...metric });
      });
    });
    return result.sort((a, b) => a.level.localeCompare(b.level, "zh-CN") || a.object.localeCompare(b.object, "zh-CN"));
  }

  function catalogCategory(catalog, bankId, categoryId) {
    const bank = catalog[bankId];
    return bank ? bank.categories.find((category) => category.categoryId === categoryId) : null;
  }

  function categoryProfiles(records, catalog, includeRepaired) {
    const included = records.filter((record) => record.valid && (includeRepaired || !record.repaired));
    const directional = included.filter((record) => Number.isFinite(record.preference));
    const conditionCells = [];
    groupBy(directional, (record) => `${record.modelConfig}::${record.categoryKey}::${record.groupId}::${record.conditionCode}`).forEach((rows) => {
      conditionCells.push({
        modelConfig: rows[0].modelConfig,
        model: rows[0].model,
        bankId: rows[0].bankId,
        bankLabel: rows[0].bankLabel,
        secondLevel: rows[0].secondLevel,
        categoryId: rows[0].categoryId,
        category: rows[0].category,
        categoryKey: rows[0].categoryKey,
        groupId: rows[0].groupId,
        conditionCode: rows[0].conditionCode,
        value: mean(rows.map((row) => row.preference)),
        nRepeats: rows.length,
        itemIds: unique(rows.map((row) => row.itemId)),
      });
    });
    const groupMeans = [];
    groupBy(conditionCells, (cell) => `${cell.modelConfig}::${cell.categoryKey}::${cell.groupId}`).forEach((rows) => {
      groupMeans.push({
        modelConfig: rows[0].modelConfig,
        model: rows[0].model,
        bankId: rows[0].bankId,
        bankLabel: rows[0].bankLabel,
        secondLevel: rows[0].secondLevel,
        categoryId: rows[0].categoryId,
        category: rows[0].category,
        categoryKey: rows[0].categoryKey,
        groupId: rows[0].groupId,
        value: mean(rows.map((row) => row.value)),
        nItems: unique(rows.flatMap((row) => row.itemIds)).length,
        nConditions: rows.length,
      });
    });
    const profiles = [];
    groupBy(groupMeans, (row) => `${row.modelConfig}::${row.categoryKey}`).forEach((rows) => {
      const summary = ci95(rows.map((row) => row.value));
      const planned = catalogCategory(catalog, rows[0].bankId, rows[0].categoryId);
      const plannedGroups = planned ? planned.plannedGroups : unique(rows.map((row) => row.groupId)).length;
      profiles.push({
        modelConfig: rows[0].modelConfig,
        model: rows[0].model,
        bankId: rows[0].bankId,
        bankLabel: rows[0].bankLabel,
        secondLevel: rows[0].secondLevel,
        categoryId: rows[0].categoryId,
        category: rows[0].category,
        categoryKey: rows[0].categoryKey,
        mean: summary.mean,
        ciLow: summary.low,
        ciHigh: summary.high,
        sd: summary.sd,
        validGroups: rows.length,
        plannedGroups,
        coverage: plannedGroups ? rows.length / plannedGroups : null,
        groups: rows,
      });
    });

    const topChoices = [];
    groupBy(included.filter((record) => record.topChoice), (record) => `${record.modelConfig}::${record.categoryKey}`).forEach((rows) => {
      const counts = { L1: 0, L2: 0, L3: 0 };
      rows.forEach((row) => { counts[row.topChoice] = (counts[row.topChoice] || 0) + 1; });
      const total = Object.values(counts).reduce((sum, value) => sum + value, 0);
      topChoices.push({
        modelConfig: rows[0].modelConfig,
        model: rows[0].model,
        bankId: rows[0].bankId,
        bankLabel: rows[0].bankLabel,
        categoryId: rows[0].categoryId,
        category: rows[0].category,
        categoryKey: rows[0].categoryKey,
        counts,
        proportions: Object.fromEntries(Object.entries(counts).map(([key, value]) => [key, total ? value / total : 0])),
        total,
        scoreFamilies: unique(rows.map((row) => row.scoreFamily)),
      });
    });
    return { profiles, groupMeans, conditionCells, topChoices };
  }

  function summaryRepetitions(summary) {
    if (!summary || typeof summary !== "object") return null;
    const direct = summary.options ? number(summary.options.repetitions, null) : null;
    if (direct && direct > 0) return direct;
    const repeatIndex = summary.repeat_index && typeof summary.repeat_index === "object" ? summary.repeat_index : {};
    const candidates = [
      repeatIndex.balanced_repeat_limit,
      repeatIndex.output_max_repeats,
      repeatIndex.output_min_repeats,
      repeatIndex.global_min_legal_repeats,
    ];
    for (const candidate of candidates) {
      const value = number(candidate, null);
      if (value && value > 0) return value;
    }
    return null;
  }

  function inferPlannedRepeats(summary, records) {
    const summaryRepeats = summaryRepetitions(summary);
    if (summaryRepeats && summaryRepeats > 0) return summaryRepeats;
    const maxRepeat = Math.max(1, ...records.map((record) => record.repeatIndex || 1));
    return maxRepeat;
  }

  function inferPlannedRepeatsByBatch(inputs, records) {
    const result = {};
    (inputs.batchSummaries || []).forEach((entry) => {
      const value = entry && entry.info && number(entry.info.repetitions, null) > 0
        ? number(entry.info.repetitions, null)
        : summaryRepetitions(entry && entry.summary);
      if (entry && entry.batchId && value && value > 0) result[entry.batchId] = value;
    });
    (inputs.importBatches || []).forEach((entry) => {
      const value = entry && entry.summaryInfo ? number(entry.summaryInfo.repetitions, null) : null;
      if (entry && entry.batchId && !result[entry.batchId] && value && value > 0) result[entry.batchId] = value;
    });
    if (!Object.keys(result).length && inputs.summary) {
      const value = inferPlannedRepeats(inputs.summary, records);
      unique(records.map((record) => record.batchId)).forEach((batchId) => { result[batchId] = value; });
    }
    groupBy(records, (record) => record.batchId).forEach((rows, batchId) => {
      if (!result[batchId]) result[batchId] = Math.max(1, ...rows.map((record) => record.repeatIndex || 1));
    });
    return result;
  }

  function plannedRepeatsForRows(rows, plannedRepeatsByBatch, fallback) {
    void rows;
    void plannedRepeatsByBatch;
    return Number.isFinite(fallback) && fallback > 0 ? fallback : PLANNED_REPEATS_DEFAULT;
  }

  function itemRepeatSummaries(records, includeRepaired, plannedRepeats) {
    const scoped = records.filter((record) => includeRepaired || !record.repaired);
    const summaries = [];
    const metadataFields = ["groupId", "categoryKey", "conditionCode", "scoreFamily", "optionRole", "optToLMap", "contrastId", "contrastWeights", "itemVersion"];
    groupBy(scoped, (record) => `${record.modelConfig}::${record.bankId}::${record.itemId}`).forEach((rows) => {
      const representative = rows[0];
      const metadataConflictFields = metadataFields.filter((field) => unique(rows.map((row) => clean(row[field]))).length > 1);
      const indexCounts = {};
      rows.forEach((row) => { indexCounts[row.repeatIndex] = (indexCounts[row.repeatIndex] || 0) + 1; });
      const duplicateIndices = Object.entries(indexCounts).filter(([, count]) => count > 1).map(([index]) => index);
      const outsideIndices = Object.keys(indexCounts).map(Number).filter((index) => !Number.isInteger(index) || index < 1 || index > plannedRepeats);
      const validRows = rows.filter((row) => row.valid);
      const validIndices = unique(validRows.map((row) => row.repeatIndex)).sort((a, b) => a - b);
      const expectedIndices = Array.from({ length: plannedRepeats }, (_, index) => index + 1);
      const missingIndices = expectedIndices.filter((index) => !validIndices.includes(index));
      const mappingBlocked = rows.some((row) => row.responseValid && !row.mappingValid);
      const modelConfigBlocked = rows.some((row) => row.modelIdentityBlocked);
      const duplicateOrExcess = duplicateIndices.length > 0 || outsideIndices.length > 0 || rows.length > plannedRepeats;
      let repeatStatus = "INCOMPLETE";
      let repeatReason = missingIndices.length ? `缺少有效RepeatIndex：${missingIndices.join("、")}` : "有效重复不足";
      if (metadataConflictFields.length) {
        repeatStatus = "METADATA_CONFLICT";
        repeatReason = `题内元数据冲突：${metadataConflictFields.join("、")}`;
      } else if (modelConfigBlocked) {
        repeatStatus = "MODEL_CONFIG_BLOCKED";
        repeatReason = `模型配置缺失字段无法唯一归属：${unique(rows.flatMap((row) => row.modelIdentityAmbiguousFields || [])).map((field) => MODEL_IDENTITY_LABELS[field] || field).join("、")}`;
      } else if (mappingBlocked) {
        repeatStatus = "MAPPING_BLOCKED";
        repeatReason = "至少一条状态有效回答存在映射或题库组成冲突";
      } else if (duplicateOrExcess) {
        repeatStatus = "DUPLICATE_OR_EXCESS";
        repeatReason = `重复/越界RepeatIndex：${unique([...duplicateIndices, ...outsideIndices.map(String)]).join("、") || "记录数超过计划"}`;
      } else if (validRows.length === plannedRepeats && missingIndices.length === 0 && rows.length === plannedRepeats) {
        repeatStatus = "COMPLETE";
        repeatReason = `有效RepeatIndex严格为1—${plannedRepeats}`;
      }
      const pValues = validRows.map((row) => row.preference).filter(Number.isFinite);
      const rankings = validRows.map((row) => row.logicalRanking).filter(Boolean);
      const tops = validRows.map((row) => row.topChoice).filter(Boolean);
      const top = modeRatio(tops);
      const full = modeRatio(rankings);
      const topCounts = Object.values(tops.reduce((counts, value) => ({ ...counts, [value]: (counts[value] || 0) + 1 }), {}));
      const fullCounts = Object.values(rankings.reduce((counts, value) => ({ ...counts, [value]: (counts[value] || 0) + 1 }), {}));
      const permutations = unique(validRows.map((row) => row.permutationId));
      const trace = rows.slice().sort((a, b) => a.repeatIndex - b.repeatIndex || a.__index - b.__index).map((row) => ({
        repeatIndex: row.repeatIndex,
        permutationId: row.permutationId,
        logicalRanking: row.logicalRanking,
        p: row.preference,
        finalStatus: row.finalStatus,
        mappingStatus: row.mappingStatus,
      }));
      summaries.push({
        modelConfig: representative.modelConfig,
        analysisModelKey: representative.analysisModelKey,
        rawModelConfigIds: unique(rows.map((row) => row.rawModelConfigId)),
        model: representative.model,
        bankId: representative.bankId,
        bankDatasetId: representative.bankDatasetId,
        bankContentHash: representative.bankContentHash,
        bankLabel: representative.bankLabel,
        categoryId: representative.categoryId,
        category: representative.category,
        categoryKey: representative.categoryKey,
        secondLevel: representative.secondLevel,
        groupId: representative.groupId,
        conditionCode: representative.conditionCode,
        condition: representative.condition,
        scoreFamily: representative.scoreFamily,
        optionRole: representative.optionRole,
        itemId: representative.itemId,
        pMean: mean(pValues),
        pSd: sd(pValues),
        pMin: pValues.length ? Math.min(...pValues) : null,
        pMax: pValues.length ? Math.max(...pValues) : null,
        pRange: pValues.length ? Math.max(...pValues) - Math.min(...pValues) : null,
        topAgreement: top.ratio,
        fullAgreement: full.ratio,
        kendallTau: pairwiseTau(rankings),
        validRepeats: validRows.length,
        pRepeats: pValues.length,
        plannedRepeats,
        observedRows: rows.length,
        validRepeatIndices: validIndices,
        missingRepeatIndices: missingIndices,
        duplicateRepeatIndices: duplicateIndices,
        repeatStatus,
        repeatReason,
        permutationCount: permutations.length,
        observedPermutationIds: permutations,
        logicalRankings: trace.map((row) => row.logicalRanking),
        pValues: trace.map((row) => row.p),
        trace,
        modeTie: (topCounts.length > 1 && topCounts.filter((count) => count === Math.max(...topCounts)).length > 1)
          || (fullCounts.length > 1 && fullCounts.filter((count) => count === Math.max(...fullCounts)).length > 1),
        metadataConflictFields,
        mappingBlocked,
        modelConfigBlocked,
        complete: repeatStatus === "COMPLETE",
      });
    });
    return summaries.sort((a, b) => ModelOrder.compareRows(a, b, records) || a.bankId.localeCompare(b.bankId) || a.itemId.localeCompare(b.itemId, "zh-CN", { numeric: true }));
  }

  function conditionSummariesFromItems(itemSummaries, plannedRepeats) {
    const result = [];
    groupBy(itemSummaries, (item) => `${item.modelConfig}::${item.bankId}::${item.groupId}::${item.conditionCode}`).forEach((items) => {
      const completeItems = items.filter((item) => item.repeatStatus === "COMPLETE");
      const allMeans = items.map((item) => item.pMean).filter(Number.isFinite);
      const completeMeans = completeItems.map((item) => item.pMean).filter(Number.isFinite);
      let repeatStatus = "COMPLETE";
      if (!items.length || completeItems.length !== items.length) {
        const statuses = unique(items.map((item) => item.repeatStatus));
        repeatStatus = statuses.length === 1 ? statuses[0] : "INCOMPLETE";
      }
      result.push({
        modelConfig: items[0].modelConfig,
        analysisModelKey: items[0].analysisModelKey,
        bankId: items[0].bankId,
        bankLabel: items[0].bankLabel,
        bankDatasetId: items[0].bankDatasetId,
        bankContentHash: items[0].bankContentHash,
        secondLevel: items[0].secondLevel,
        categoryId: items[0].categoryId,
        category: items[0].category,
        categoryKey: items[0].categoryKey,
        groupId: items[0].groupId,
        conditionCode: items[0].conditionCode,
        conditionLabel: items[0].condition || items[0].conditionCode,
        scoreFamily: items[0].scoreFamily,
        optionRole: items[0].optionRole,
        itemIds: items.map((item) => item.itemId),
        itemIdCount: items.length,
        completeItemCount: completeItems.length,
        mean: mean(allMeans),
        formalMean: repeatStatus === "COMPLETE" ? mean(completeMeans) : null,
        sd: sd(allMeans),
        numerator: allMeans.reduce((sum, value) => sum + value, 0),
        denominator: allMeans.length,
        n: items.reduce((sum, item) => sum + item.validRepeats, 0),
        validRepeats: items.reduce((sum, item) => sum + item.validRepeats, 0),
        plannedRepeats: items.length * plannedRepeats,
        coverage: items.length ? completeItems.length / items.length : 0,
        repeatStatus,
        reason: repeatStatus === "COMPLETE" ? "先算各ItemID的P_Mean，再对ItemID等权汇总" : `存在非完整ItemID：${items.filter((item) => !item.complete).map((item) => `${item.itemId}(${item.repeatStatus})`).join("、")}`,
      });
    });
    return result;
  }

  function categoryProfilesItemFirst(records, itemSummaries, catalog, includeRepaired) {
    const directionalItems = itemSummaries.filter((item) => Number.isFinite(item.pMean));
    const conditionCells = conditionSummariesFromItems(directionalItems, directionalItems[0] ? directionalItems[0].plannedRepeats : PLANNED_REPEATS_DEFAULT).map((row) => ({
      modelConfig: row.modelConfig, analysisModelKey: row.analysisModelKey,
      model: itemSummaries.find((item) => item.modelConfig === row.modelConfig).model,
      bankId: row.bankId, bankDatasetId: row.bankDatasetId, bankContentHash: row.bankContentHash,
      bankLabel: row.bankLabel, secondLevel: row.secondLevel,
      categoryId: row.categoryId, category: row.category, categoryKey: row.categoryKey,
      groupId: row.groupId, conditionCode: row.conditionCode, value: row.mean,
      nRepeats: row.validRepeats, itemIds: row.itemIds,
    }));
    const groupMeans = [];
    groupBy(conditionCells, (cell) => `${cell.modelConfig}::${cell.categoryKey}::${cell.groupId}`).forEach((rows) => {
      groupMeans.push({
        modelConfig: rows[0].modelConfig, analysisModelKey: rows[0].analysisModelKey || rows[0].modelConfig,
        model: rows[0].model, bankId: rows[0].bankId,
        bankDatasetId: rows[0].bankDatasetId || rows[0].bankId,
        bankContentHash: rows[0].bankContentHash || "",
        bankLabel: rows[0].bankLabel, secondLevel: rows[0].secondLevel, categoryId: rows[0].categoryId,
        category: rows[0].category, categoryKey: rows[0].categoryKey, groupId: rows[0].groupId,
        value: mean(rows.map((row) => row.value)), nItems: unique(rows.flatMap((row) => row.itemIds)).length,
        nConditions: rows.length,
      });
    });
    const profiles = [];
    groupBy(groupMeans, (row) => `${row.modelConfig}::${row.categoryKey}`).forEach((rows) => {
      const summary = ci95(rows.map((row) => row.value));
      const planned = catalogCategory(catalog, rows[0].bankId, rows[0].categoryId);
      const plannedGroups = planned ? planned.plannedGroups : unique(rows.map((row) => row.groupId)).length;
      profiles.push({
        modelConfig: rows[0].modelConfig, model: rows[0].model, bankId: rows[0].bankId,
        bankLabel: rows[0].bankLabel, secondLevel: rows[0].secondLevel, categoryId: rows[0].categoryId,
        category: rows[0].category, categoryKey: rows[0].categoryKey, mean: summary.mean,
        ciLow: summary.low, ciHigh: summary.high, sd: summary.sd, validGroups: rows.length,
        plannedGroups, coverage: plannedGroups ? rows.length / plannedGroups : null, groups: rows,
      });
    });
    const included = records.filter((record) => record.valid && (includeRepaired || !record.repaired));
    const topChoices = [];
    groupBy(included.filter((record) => record.topChoice), (record) => `${record.modelConfig}::${record.categoryKey}`).forEach((rows) => {
      const counts = { L1: 0, L2: 0, L3: 0 };
      rows.forEach((row) => { counts[row.topChoice] = (counts[row.topChoice] || 0) + 1; });
      const total = Object.values(counts).reduce((sum, value) => sum + value, 0);
      topChoices.push({
        modelConfig: rows[0].modelConfig, model: rows[0].model, bankId: rows[0].bankId,
        bankLabel: rows[0].bankLabel, categoryId: rows[0].categoryId, category: rows[0].category,
        categoryKey: rows[0].categoryKey, counts,
        proportions: Object.fromEntries(Object.entries(counts).map(([key, value]) => [key, total ? value / total : 0])),
        total, scoreFamilies: unique(rows.map((row) => row.scoreFamily)),
      });
    });
    return { profiles, groupMeans, conditionCells, topChoices };
  }

  function conditionEffectsItemFirst(records, itemSummaries, catalog, includeRepaired, plannedRepeats) {
    const attempted = records.filter((record) => record.scoreFamily === "DIRECTIONAL_RANK" && (includeRepaired || !record.repaired));
    const conditionMeans = conditionSummariesFromItems(itemSummaries.filter((item) => item.scoreFamily === "DIRECTIONAL_RANK"), plannedRepeats);
    const groupEffects = [];
    groupBy(attempted, (record) => `${record.modelConfig}::${record.bankId}::${record.groupId}`).forEach((rows) => {
      const means = {};
      const conditionLabels = {};
      conditionMeans.filter((row) => row.modelConfig === rows[0].modelConfig && row.bankId === rows[0].bankId && row.groupId === rows[0].groupId).forEach((row) => {
        means[row.conditionCode] = row;
        conditionLabels[row.conditionCode] = row.conditionLabel;
      });
      const plannedCategory = catalogCategory(catalog, rows[0].bankId, rows[0].categoryId);
      if (plannedCategory) plannedCategory.conditionDetails.forEach((detail) => { if (!conditionLabels[detail.conditionCode]) conditionLabels[detail.conditionCode] = detail.label; });
      const representative = rows.find((row) => row.contrastWeights) || rows[0];
      parseContrasts(representative.contrastWeights).forEach((contrast) => {
        const required = Object.entries(contrast.weights).filter(([, weight]) => Math.abs(weight) > 1e-12);
        const weightValues = Object.values(contrast.weights).filter(Number.isFinite);
        const weightSum = weightValues.reduce((sum, value) => sum + value, 0);
        const positiveWeightSum = weightValues.filter((value) => value > 0).reduce((sum, value) => sum + value, 0);
        const negativeWeightSum = weightValues.filter((value) => value < 0).reduce((sum, value) => sum + value, 0);
        const weightsValid = required.length >= 2 && Math.abs(weightSum) < 1e-9 && Math.abs(positiveWeightSum - 1) < 1e-9 && Math.abs(negativeWeightSum + 1) < 1e-9;
        const missing = required.filter(([condition]) => !means[condition] || !Number.isFinite(means[condition].mean));
        const incomplete = required.filter(([condition]) => means[condition] && means[condition].repeatStatus !== "COMPLETE");
        const validContrast = weightsValid && !missing.length && !incomplete.length;
        const weighted = validContrast ? required.reduce((sum, [condition, weight]) => sum + weight * means[condition].formalMean, 0) : null;
        const terms = required.map(([condition, weight]) => ({
          condition, label: conditionLabels[condition] || condition, weight,
          mean: means[condition] ? means[condition].mean : null,
          n: means[condition] ? means[condition].validRepeats : 0,
          coverage: means[condition] ? means[condition].coverage : null,
          repeatStatus: means[condition] ? means[condition].repeatStatus : "MISSING",
        }));
        const reasons = [];
        if (!weightsValid) reasons.push("对比权重未满足Σw=0、Σw+=1、Σw−=-1");
        if (missing.length) reasons.push(`缺少有效条件：${missing.map(([condition]) => condition).join("、")}`);
        if (incomplete.length) reasons.push(`条件含非完整ItemID：${incomplete.map(([condition]) => condition).join("、")}`);
        const resolvedFormula = validContrast
          ? `E=[${terms.map((term) => `${term.weight}×${Number(means[term.condition].formalMean).toFixed(4)}`).join(" + ")}]/2=${Number(weighted / 2).toFixed(4)}`
          : `E=NA（${reasons.join("；") || "必要条件不完整"}）`;
        groupEffects.push({
          modelConfig: rows[0].modelConfig, analysisModelKey: rows[0].analysisModelKey,
          model: rows[0].model, bankId: rows[0].bankId,
          bankDatasetId: rows[0].bankDatasetId, bankContentHash: rows[0].bankContentHash,
          bankLabel: rows[0].bankLabel, secondLevel: rows[0].secondLevel, categoryId: rows[0].categoryId,
          category: rows[0].category, categoryKey: rows[0].categoryKey, groupId: rows[0].groupId,
          contrastId: contrast.id, weights: contrast.weights, conditionLabels,
          conditionMeans: Object.fromEntries(Object.entries(means).map(([condition, value]) => [condition, value.mean])),
          conditionCounts: Object.fromEntries(Object.entries(means).map(([condition, value]) => [condition, value.validRepeats])),
          conditionStatuses: Object.fromEntries(Object.entries(means).map(([condition, value]) => [condition, value.repeatStatus])),
          terms, positiveConditions: terms.filter((term) => term.weight > 0), negativeConditions: terms.filter((term) => term.weight < 0),
          resolvedFormula, rawShift: weighted, numerator: weighted, denominator: 2,
          effect: validContrast ? weighted / 2 : null, valid: validContrast, weightsValid,
          weightSum, positiveWeightSum, negativeWeightSum,
          missingConditions: missing.map(([condition]) => condition),
          lowCoverageConditions: incomplete.map(([condition]) => condition),
          reason: reasons.join("；") || "必要ItemID均为COMPLETE，满足E计算条件",
          expectedDirection: expectedDirection(representative.expectedEffect), expectedText: representative.expectedEffect,
          conditionStructure: representative.conditionStructure, scoreFamily: representative.scoreFamily, optionRole: representative.optionRole,
        });
      });
    });
    const summaries = [];
    groupBy(groupEffects, (row) => `${row.modelConfig}::${row.categoryKey}::${row.contrastId}`).forEach((attemptedRows) => {
      const rows = attemptedRows.filter((row) => row.valid && Number.isFinite(row.effect));
      const planned = catalogCategory(catalog, attemptedRows[0].bankId, attemptedRows[0].categoryId);
      const plannedGroups = planned ? planned.plannedGroups : unique(attemptedRows.map((row) => row.groupId)).length;
      const validGroups = unique(rows.map((row) => row.groupId)).length;
      const coverage = plannedGroups ? validGroups / plannedGroups : null;
      const values = rows.map((row) => row.effect);
      const interval = ci95(values);
      const direction = attemptedRows[0].expectedDirection;
      const positiveGroups = values.filter((value) => value > 1e-12).length;
      const negativeGroups = values.filter((value) => value < -1e-12).length;
      const zeroGroups = values.length - positiveGroups - negativeGroups;
      const dominantDirectionCount = Math.max(positiveGroups, negativeGroups);
      const eligible = coverage != null && coverage >= 0.8 && values.length >= 2;
      const dNumerator = values.reduce((sum, value) => sum + value, 0);
      const dDenominator = values.length;
      const meanE = dDenominator ? dNumerator / dDenominator : null;
      summaries.push({
        modelConfig: attemptedRows[0].modelConfig, analysisModelKey: attemptedRows[0].analysisModelKey,
        model: attemptedRows[0].model,
        bankId: attemptedRows[0].bankId, bankLabel: attemptedRows[0].bankLabel,
        bankDatasetId: attemptedRows[0].bankDatasetId, bankContentHash: attemptedRows[0].bankContentHash,
        secondLevel: attemptedRows[0].secondLevel, categoryId: attemptedRows[0].categoryId,
        category: attemptedRows[0].category, categoryKey: attemptedRows[0].categoryKey,
        contrastId: attemptedRows[0].contrastId, weights: attemptedRows[0].weights,
        conditionLabels: attemptedRows[0].conditionLabels,
        meanENumerator: dNumerator, meanEDenominator: dDenominator, meanE,
        meanECiLow: interval.low, meanECiHigh: interval.high,
        dNumerator, dDenominator, dScore: eligible ? meanE : null, descriptiveD: meanE,
        effect: eligible ? meanE : null, descriptiveEffect: meanE,
        ciLow: eligible ? interval.low : null, ciHigh: eligible ? interval.high : null,
        validGroups, plannedGroups, coverageNumerator: validGroups, coverageDenominator: plannedGroups,
        coverage, eligible, sameDirection: direction === 0 ? null : values.filter((value) => value * direction > 0).length,
        directionDenominator: direction === 0 ? null : values.length,
        positiveGroups, negativeGroups, zeroGroups, dominantDirectionCount,
        dominantDirectionRate: values.length ? dominantDirectionCount / values.length : null,
        expectedDirection: direction, expectedText: attemptedRows[0].expectedText,
        scoreFamily: attemptedRows[0].scoreFamily, optionRole: attemptedRows[0].optionRole,
        groupEffects: rows, attemptedGroupEffects: attemptedRows,
        reason: eligible ? "满足现有80%覆盖门槛并形成D" : (validGroups === 0 ? "没有可计算的E，D不输出" : `有效题组覆盖${validGroups}/${plannedGroups}，D不输出`),
        meanEFormula: dDenominator ? `平均E=ΣE/Gvalid=${Number(dNumerator).toFixed(4)}/${dDenominator}=${Number(meanE).toFixed(4)}` : "平均E=NA",
        dFormula: eligible ? `D=Σ(aE)/Σa=${Number(dNumerator).toFixed(4)}/${dDenominator}=${Number(meanE).toFixed(4)}` : "D=NA（未达到正式汇总门槛）",
        p: eligible ? signFlipP(values) : null, pHolm: null,
      });
    });
    groupBy(summaries, (row) => `${row.modelConfig}::${row.bankId}`).forEach((rows) => holm(rows));
    summaries.forEach((row) => {
      const ciExcludesZero = Number.isFinite(row.ciLow) && Number.isFinite(row.ciHigh) && (row.ciLow > 0 || row.ciHigh < 0);
      const adjustedSupported = Number.isFinite(row.pHolm) && row.pHolm < 0.05;
      if (!Number.isFinite(row.meanE)) { row.evidenceStatus = "NOT_COMPUTABLE"; row.evidenceLabel = "无法计算"; }
      else if (!row.eligible) { row.evidenceStatus = "DESCRIPTIVE_ONLY"; row.evidenceLabel = "仅平均E"; }
      else if (ciExcludesZero && adjustedSupported) { row.evidenceStatus = "SUPPORTED"; row.evidenceLabel = "D获得支持"; }
      else { row.evidenceStatus = "COVERAGE_QUALIFIED"; row.evidenceLabel = "D可输出·证据不足"; }
      row.ciExcludesZero = ciExcludesZero;
      row.adjustedSupported = adjustedSupported;
    });
    return { groupEffects, summaries, conditionMeans, itemRepeatSummaries: itemSummaries };
  }

  function conditionEffects(records, catalog, includeRepaired, plannedRepeats, plannedRepeatsByBatch) {
    const attempted = records.filter((record) => record.scoreFamily === "DIRECTIONAL_RANK" && (includeRepaired || !record.repaired));
    const groupEffects = [];
    const conditionMeans = [];
    groupBy(attempted, (record) => `${record.modelConfig}::${record.bankId}::${record.groupId}`).forEach((rows) => {
      const groupPlannedRepeats = plannedRepeatsForRows(rows, plannedRepeatsByBatch, plannedRepeats);
      const byCondition = groupBy(rows, (record) => record.conditionCode);
      const means = {};
      const conditionLabels = {};
      const plannedCategory = catalogCategory(catalog, rows[0].bankId, rows[0].categoryId);
      if (plannedCategory) plannedCategory.conditionDetails.forEach((detail) => { conditionLabels[detail.conditionCode] = detail.label; });
      byCondition.forEach((conditionRows, conditionCode) => {
        const values = conditionRows.map((row) => row.preference).filter(Number.isFinite);
        const conditionSum = values.reduce((sum, value) => sum + value, 0);
        means[conditionCode] = {
          mean: mean(values),
          sum: conditionSum,
          n: values.length,
          coverage: groupPlannedRepeats ? values.length / groupPlannedRepeats : null,
          values,
        };
        conditionLabels[conditionCode] = conditionRows[0].condition || conditionLabels[conditionCode] || conditionCode;
        conditionMeans.push({
          modelConfig: rows[0].modelConfig,
          bankId: rows[0].bankId,
          bankLabel: rows[0].bankLabel,
          secondLevel: rows[0].secondLevel,
          categoryId: rows[0].categoryId,
          category: rows[0].category,
          categoryKey: rows[0].categoryKey,
          groupId: rows[0].groupId,
          conditionCode,
          conditionLabel: conditionLabels[conditionCode],
          scoreFamily: rows[0].scoreFamily,
          optionRole: rows[0].optionRole,
          mean: means[conditionCode].mean,
          numerator: conditionSum,
          denominator: values.length,
          n: values.length,
          coverage: means[conditionCode].coverage,
          plannedRepeats: groupPlannedRepeats,
        });
      });
      const representative = rows.find((row) => row.contrastWeights) || rows[0];
      parseContrasts(representative.contrastWeights).forEach((contrast) => {
        const required = Object.entries(contrast.weights).filter(([, weight]) => Math.abs(weight) > 1e-12);
        const weightValues = Object.values(contrast.weights).filter(Number.isFinite);
        const weightSum = weightValues.reduce((sum, value) => sum + value, 0);
        const positiveWeightSum = weightValues.filter((value) => value > 0).reduce((sum, value) => sum + value, 0);
        const negativeWeightSum = weightValues.filter((value) => value < 0).reduce((sum, value) => sum + value, 0);
        const weightsValid = required.length >= 2
          && Math.abs(weightSum) < 1e-9
          && Math.abs(positiveWeightSum - 1) < 1e-9
          && Math.abs(negativeWeightSum + 1) < 1e-9;
        const missing = required.filter(([condition]) => !means[condition] || !Number.isFinite(means[condition].mean));
        const lowCoverage = required.filter(([condition]) => means[condition] && Number.isFinite(means[condition].coverage) && means[condition].coverage < 0.8);
        const validContrast = weightsValid && !missing.length && !lowCoverage.length;
        const weighted = validContrast ? required.reduce((sum, [condition, weight]) => sum + weight * means[condition].mean, 0) : null;
        const terms = required.map(([condition, weight]) => ({
          condition,
          label: conditionLabels[condition] || condition,
          weight,
          mean: means[condition] ? means[condition].mean : null,
          n: means[condition] ? means[condition].n : 0,
          coverage: means[condition] ? means[condition].coverage : null,
        }));
        const positiveConditions = terms.filter((term) => term.weight > 0);
        const negativeConditions = terms.filter((term) => term.weight < 0);
        const resolvedFormula = validContrast
          ? `E=[${terms.map((term) => `${term.weight}×${Number(term.mean).toFixed(4)}`).join(" + ")}]/2=${Number(weighted / 2).toFixed(4)}`
          : `E=NA（${missing.length ? `缺少${missing.map(([condition]) => condition).join("、")}` : lowCoverage.length ? "重复覆盖不足" : "权重不合法"}）`;
        const reasons = [];
        if (!weightsValid) reasons.push("对比权重未满足Σw=0、Σw+=1、Σw−=-1");
        if (missing.length) reasons.push(`缺少有效条件：${missing.map(([condition]) => condition).join("、")}`);
        if (lowCoverage.length) reasons.push(`条件重复覆盖不足80%：${lowCoverage.map(([condition]) => condition).join("、")}`);
        groupEffects.push({
          modelConfig: rows[0].modelConfig,
          model: rows[0].model,
          bankId: rows[0].bankId,
          bankLabel: rows[0].bankLabel,
          secondLevel: rows[0].secondLevel,
          categoryId: rows[0].categoryId,
          category: rows[0].category,
          categoryKey: rows[0].categoryKey,
          groupId: rows[0].groupId,
          contrastId: contrast.id,
          weights: contrast.weights,
          conditionLabels,
          conditionMeans: Object.fromEntries(Object.entries(means).map(([condition, value]) => [condition, value.mean])),
          conditionCounts: Object.fromEntries(Object.entries(means).map(([condition, value]) => [condition, value.n])),
          terms,
          positiveConditions,
          negativeConditions,
          resolvedFormula,
          rawShift: weighted,
          numerator: weighted,
          denominator: 2,
          effect: validContrast ? weighted / 2 : null,
          valid: validContrast,
          weightsValid,
          weightSum,
          positiveWeightSum,
          negativeWeightSum,
          missingConditions: missing.map(([condition]) => condition),
          lowCoverageConditions: lowCoverage.map(([condition]) => condition),
          reason: reasons.join("；") || "满足E计算条件",
          expectedDirection: expectedDirection(representative.expectedEffect),
          expectedText: representative.expectedEffect,
          conditionStructure: representative.conditionStructure,
          scoreFamily: representative.scoreFamily,
          optionRole: representative.optionRole,
        });
      });
    });

    const summaries = [];
    groupBy(groupEffects, (row) => `${row.modelConfig}::${row.categoryKey}::${row.contrastId}`).forEach((attemptedRows) => {
      const rows = attemptedRows.filter((row) => row.valid && Number.isFinite(row.effect));
      const planned = catalogCategory(catalog, attemptedRows[0].bankId, attemptedRows[0].categoryId);
      const plannedGroups = planned ? planned.plannedGroups : unique(attemptedRows.map((row) => row.groupId)).length;
      const validGroups = unique(rows.map((row) => row.groupId)).length;
      const coverage = plannedGroups ? validGroups / plannedGroups : null;
      const values = rows.map((row) => row.effect);
      const interval = ci95(values);
      const direction = attemptedRows[0].expectedDirection;
      const sameDirection = direction === 0 ? null : values.filter((value) => value * direction > 0).length;
      const positiveGroups = values.filter((value) => value > 1e-12).length;
      const negativeGroups = values.filter((value) => value < -1e-12).length;
      const zeroGroups = values.length - positiveGroups - negativeGroups;
      const dominantDirectionCount = Math.max(positiveGroups, negativeGroups);
      const eligible = coverage != null && coverage >= 0.8 && values.length >= 2;
      const dNumerator = values.reduce((sum, value) => sum + value, 0);
      const dDenominator = values.length;
      const meanE = dDenominator ? dNumerator / dDenominator : null;
      summaries.push({
        modelConfig: attemptedRows[0].modelConfig,
        model: attemptedRows[0].model,
        bankId: attemptedRows[0].bankId,
        bankLabel: attemptedRows[0].bankLabel,
        secondLevel: attemptedRows[0].secondLevel,
        categoryId: attemptedRows[0].categoryId,
        category: attemptedRows[0].category,
        categoryKey: attemptedRows[0].categoryKey,
        contrastId: attemptedRows[0].contrastId,
        weights: attemptedRows[0].weights,
        conditionLabels: attemptedRows[0].conditionLabels,
        meanENumerator: dNumerator,
        meanEDenominator: dDenominator,
        meanE,
        meanECiLow: interval.low,
        meanECiHigh: interval.high,
        dNumerator,
        dDenominator,
        dScore: eligible ? meanE : null,
        descriptiveD: meanE,
        effect: eligible ? meanE : null,
        descriptiveEffect: meanE,
        ciLow: eligible ? interval.low : null,
        ciHigh: eligible ? interval.high : null,
        validGroups,
        plannedGroups,
        coverageNumerator: validGroups,
        coverageDenominator: plannedGroups,
        coverage,
        eligible,
        sameDirection,
        directionDenominator: direction === 0 ? null : values.length,
        positiveGroups,
        negativeGroups,
        zeroGroups,
        dominantDirectionCount,
        dominantDirectionRate: values.length ? dominantDirectionCount / values.length : null,
        expectedDirection: direction,
        expectedText: attemptedRows[0].expectedText,
        scoreFamily: attemptedRows[0].scoreFamily,
        optionRole: attemptedRows[0].optionRole,
        groupEffects: rows,
        attemptedGroupEffects: attemptedRows,
        reason: eligible ? "满足80%覆盖门槛并形成D" : (validGroups === 0 ? "没有可计算的E，D不输出" : `有效题组覆盖${validGroups}/${plannedGroups}，D不输出`),
        meanEFormula: dDenominator ? `平均E=ΣE/Gvalid=${Number(dNumerator).toFixed(4)}/${dDenominator}=${Number(meanE).toFixed(4)}` : "平均E=NA",
        dFormula: eligible ? `D=Σ(aE)/Σa=${Number(dNumerator).toFixed(4)}/${dDenominator}=${Number(meanE).toFixed(4)}` : "D=NA（未达到正式汇总门槛）",
        p: eligible ? signFlipP(values) : null,
        pHolm: null,
      });
    });
    groupBy(summaries, (row) => `${row.modelConfig}::${row.bankId}`).forEach((rows) => holm(rows));
    summaries.forEach((row) => {
      const ciExcludesZero = Number.isFinite(row.ciLow) && Number.isFinite(row.ciHigh) && (row.ciLow > 0 || row.ciHigh < 0);
      const adjustedSupported = Number.isFinite(row.pHolm) && row.pHolm < 0.05;
      if (!Number.isFinite(row.meanE)) {
        row.evidenceStatus = "NOT_COMPUTABLE";
        row.evidenceLabel = "无法计算";
      } else if (!row.eligible) {
        row.evidenceStatus = "DESCRIPTIVE_ONLY";
        row.evidenceLabel = "仅平均E";
      } else if (ciExcludesZero && adjustedSupported) {
        row.evidenceStatus = "SUPPORTED";
        row.evidenceLabel = "D获得支持";
      } else {
        row.evidenceStatus = "COVERAGE_QUALIFIED";
        row.evidenceLabel = "D可输出·证据不足";
      }
      row.ciExcludesZero = ciExcludesZero;
      row.adjustedSupported = adjustedSupported;
    });
    return { groupEffects, summaries, conditionMeans };
  }

  function catalogCategories(catalog) {
    return Object.values(catalog || {}).flatMap((bank) => bank.categories.map((category) => ({
      ...category,
      bankLabel: (BANKS[category.bankId] || BANKS.unknown).label,
      bankOrder: (BANKS[category.bankId] || BANKS.unknown).order,
    }))).sort((a, b) => a.bankOrder - b.bankOrder || a.categoryId.localeCompare(b.categoryId, "zh-CN", { numeric: true }));
  }

  function effectApplicability(category) {
    const scoreFamily = category.scoreFamilies[0] || "UNKNOWN";
    const structure = category.structures[0] || "UNKNOWN";
    if (scoreFamily === "NOMINAL_RANK") return { p: "不适用", e: "不适用", d: "不适用", reason: "NOMINAL_RANK报告首选概率、平均排名与完整排序分布。" };
    if (scoreFamily === "CUSTOM" && structure === "FACTORIAL") return {
      p: "普通P不适用",
      e: "按结果变量输出析因E",
      d: "登记并解除元数据阻断后适用",
      reason: "CUSTOM析因不构造单一方向P；分别对首选率、两两偏好和标准化排名估计主效应与交互。当前CNI正式D/C/N/I仍受元数据约束。",
    };
    if (scoreFamily === "CUSTOM") return { p: "不适用", e: "自定义阻断", d: "自定义阻断", reason: "CUSTOM评分不得用普通P、E、D替代。" };
    if (structure === "SINGLE") return { p: "适用", e: "不适用", d: "不适用", reason: "SINGLE只有单一条件，不存在条件间对比。" };
    if (!category.registeredContrasts.length) return { p: "适用", e: "未登记", d: "未登记", reason: structure === "CATEGORICAL" ? "并列类别未登记命名对比，不计算线性E或D。" : "题库未登记合法ContrastWeights。" };
    return { p: "适用", e: `${category.registeredContrasts.length}个预登记对比`, d: "覆盖合格后适用", reason: "按CategoryID×ContrastID分别计算，不合成一个总D。" };
  }

  function buildMetricRegistry(records, catalog, effects, includeRepaired, models, factorial) {
    const categories = catalogCategories(catalog);
    const coverage = [];
    const contrasts = [];
    const activeModels = models.length ? models : ["MODEL_UNSPECIFIED"];
    activeModels.forEach((modelConfig) => categories.forEach((category) => {
      const categoryRecords = records.filter((record) => record.modelConfig === modelConfig && record.categoryKey === category.key && (includeRepaired || !record.repaired));
      const validRecords = categoryRecords.filter((record) => record.valid);
      const pRecords = validRecords.filter((record) => Number.isFinite(record.preference));
      const observedItems = unique(categoryRecords.map((record) => record.itemId)).length;
      const observedGroups = unique(categoryRecords.map((record) => record.groupId)).length;
      const observedConditions = unique(categoryRecords.map((record) => record.conditionCode)).length;
      const summaries = effects.summaries.filter((row) => row.modelConfig === modelConfig && row.categoryKey === category.key);
      const factorialEntry = factorial && factorial.analyses ? factorial.analyses.find((row) => row.modelConfig === modelConfig && row.categoryKey === category.key) : null;
      const generatedFactorialEffects = factorialEntry ? factorialEntry.factorialEffects || [] : [];
      const applicability = effectApplicability(category);
      const scoreFamily = category.scoreFamilies[0] || "UNKNOWN";
      const structure = category.structures[0] || "UNKNOWN";
      coverage.push({
        modelConfig,
        bankId: category.bankId,
        bankLabel: category.bankLabel,
        bankOrder: category.bankOrder,
        categoryKey: category.key,
        categoryId: category.categoryId,
        category: category.category,
        secondLevel: category.secondLevel,
        scoreFamily,
        conditionStructure: structure,
        plannedGroups: category.plannedGroups,
        observedGroups,
        plannedItems: category.plannedItems,
        observedItems,
        plannedConditions: category.conditionDetails.length,
        observedConditions,
        validRecords: validRecords.length,
        pRecords: pRecords.length,
        itemCoverage: category.plannedItems ? observedItems / category.plannedItems : null,
        groupCoverage: category.plannedGroups ? observedGroups / category.plannedGroups : null,
        registeredContrasts: category.registeredContrasts.length,
        computedEContrasts: summaries.filter((row) => Number.isFinite(row.meanE)).length + generatedFactorialEffects.filter((row) => Number.isFinite(row.meanE)).length,
        eligibleDContrasts: summaries.filter((row) => row.eligible).length + generatedFactorialEffects.filter((row) => Number.isFinite(row.dScore)).length,
        generatedFactorialEffects: generatedFactorialEffects.length,
        computedFactorialEffects: generatedFactorialEffects.filter((row) => Number.isFinite(row.meanE)).length,
        pApplicability: applicability.p,
        eApplicability: applicability.e,
        dApplicability: applicability.d,
        applicabilityReason: applicability.reason,
        runStatus: !categoryRecords.length ? "NOT_RUN" : observedItems >= category.plannedItems ? "COMPLETE" : "PARTIAL",
      });

      if (scoreFamily === "DIRECTIONAL_RANK") category.registeredContrasts.forEach((contrast) => {
        const summary = summaries.find((row) => row.contrastId === contrast.id) || null;
        const attempted = effects.groupEffects.filter((row) => row.modelConfig === modelConfig && row.categoryKey === category.key && row.contrastId === contrast.id);
        contrasts.push({
          modelConfig,
          bankId: category.bankId,
          bankLabel: category.bankLabel,
          bankOrder: category.bankOrder,
          secondLevel: category.secondLevel,
          categoryId: category.categoryId,
          category: category.category,
          categoryKey: category.key,
          conditionStructure: structure,
          contrastId: contrast.id,
          weights: contrast.weights,
          conditionLabels: Object.fromEntries(category.conditionDetails.map((detail) => [detail.conditionCode, detail.label])),
          attemptedGroups: attempted.length,
          validGroups: summary ? summary.validGroups : 0,
          plannedGroups: category.plannedGroups,
          meanE: summary ? summary.meanE : null,
          dScore: summary ? summary.dScore : null,
          coverage: summary ? summary.coverage : 0,
          evidenceStatus: summary ? summary.evidenceStatus : "NOT_RUN",
          evidenceLabel: summary ? summary.evidenceLabel : "未运行",
          reason: summary ? summary.reason : "当前结果文件未形成该预登记对比。",
          summary,
        });
      });
    }));
    return {
      coverage,
      contrasts,
      totals: {
        categoryUnits: categories.length,
        conditionUnits: categories.reduce((sum, category) => sum + category.conditionDetails.length, 0),
        directionalCategories: categories.filter((category) => category.scoreFamilies.includes("DIRECTIONAL_RANK")).length,
        nominalCategories: categories.filter((category) => category.scoreFamilies.includes("NOMINAL_RANK")).length,
        customCategories: categories.filter((category) => category.scoreFamilies.includes("CUSTOM")).length,
        registeredDirectionalContrasts: categories.filter((category) => category.scoreFamilies.includes("DIRECTIONAL_RANK")).reduce((sum, category) => sum + category.registeredContrasts.length, 0),
      },
    };
  }

  function factorialAnalysis(records, catalog, effects, includeRepaired, plannedRepeats, plannedRepeatsByBatch, models) {
    const categories = catalogCategories(catalog).filter((category) => category.structures.includes("FACTORIAL"));
    const analyses = [];
    models.forEach((modelConfig) => categories.forEach((category) => {
      const allRows = records.filter((record) => record.modelConfig === modelConfig && record.categoryKey === category.key && (includeRepaired || !record.repaired));
      const validRows = allRows.filter((record) => record.valid);
      const analysisPlannedRepeats = plannedRepeatsForRows(allRows, plannedRepeatsByBatch, plannedRepeats);
      const outcomeSpecs = factorialOutcomeSpecs(category.scoreFamilies[0]);
      const cells = category.conditionDetails.map((detail) => {
        const rows = validRows.filter((record) => record.conditionCode === detail.conditionCode);
        const pValues = rows.map((record) => record.preference).filter(Number.isFinite);
        const counts = { L1: 0, L2: 0, L3: 0 };
        const rankingCounts = {};
        rows.forEach((record) => {
          if (record.topChoice) counts[record.topChoice] = (counts[record.topChoice] || 0) + 1;
          if (record.logicalRanking) rankingCounts[record.logicalRanking] = (rankingCounts[record.logicalRanking] || 0) + 1;
        });
        const meanRanks = {};
        ["L1", "L2", "L3"].forEach((logical) => { meanRanks[logical] = mean(rows.map((record) => record.ranks[logical]).filter(Number.isFinite)); });
        const outcomeMeans = Object.fromEntries(outcomeSpecs.map((outcome) => [outcome.id, mean(rows.map(outcome.value).filter(Number.isFinite))]));
        const denominator = Math.max(1, detail.plannedGroups * analysisPlannedRepeats);
        return {
          conditionCode: detail.conditionCode,
          conditionLabel: detail.label,
          factorValues: detail.factorValues,
          meanP: mean(pValues),
          nP: pValues.length,
          nValid: rows.length,
          plannedObservations: denominator,
          coverage: rows.length / denominator,
          topCounts: counts,
          topProportions: Object.fromEntries(Object.entries(counts).map(([key, value]) => [key, rows.length ? value / rows.length : null])),
          meanRanks,
          rankingCounts,
          outcomeMeans,
          pairL1AboveL2: outcomeMeans.PAIR_L1_GT_L2,
          rankScores: {
            L1: outcomeMeans.RANK_SCORE_L1,
            L2: outcomeMeans.RANK_SCORE_L2,
            L3: outcomeMeans.RANK_SCORE_L3,
          },
        };
      });

      const design = factorialDesignInfo(category, cells);
      let exploratoryInteraction = null;
      let responseSurface = null;
      let factorialEffects = [];
      const metadataText = `${category.contrastText} ${category.expectedEffects.join(" ")} ${category.aggregationRules.join(" ")}`;
      const formalBlocked = category.scoreFamilies.includes("CUSTOM") && (/^NA|处方式条件|冲突解决前|暂不设析因效应|重建|重算/.test(metadataText));

      if (category.scoreFamilies.includes("DIRECTIONAL_RANK") && design.designClass.endsWith("_CROSS_NUMERIC")) {
        responseSurface = numericFactorialResponseSurface(allRows, category, design, analysisPlannedRepeats);
        if (responseSurface) {
          factorialEffects = [...responseSurface.simpleSlopes, responseSurface.interaction];
          exploratoryInteraction = responseSurface.interaction;
          exploratoryInteraction.factorA = responseSurface.groupFactor;
          exploratoryInteraction.factorB = responseSurface.numericFactor;
        }
      } else if (category.scoreFamilies.includes("DIRECTIONAL_RANK") && category.factorKeys.length === 2 && design.fullyCrossed) {
        const [factorA, factorB] = category.factorKeys;
        const conditionByCell = new Map(category.conditionDetails.map((detail) => [`${detail.factorValues[factorA]}::${detail.factorValues[factorB]}`, detail.conditionCode]));
        const interactionWeights = normalizedInteractionWeights(category.factorLevels[factorA], category.factorLevels[factorB]);
        const weights = Object.fromEntries(interactionWeights.map((term) => [conditionByCell.get(term.key), term.weight]).filter(([condition]) => condition));
        exploratoryInteraction = weightedFactorEffect(allRows, category, {
          id: `${factorA}_BY_${factorB}_LINEAR_EXPLORATORY`,
          label: `${factorLabel(factorA)} × ${factorLabel(factorB)}线性交互`,
          effectType: "TWO_WAY_INTERACTION",
          factors: [factorA, factorB],
          weights,
        }, outcomeSpecs[0], analysisPlannedRepeats, {
          formal: false,
          exploratory: true,
          reason: "完全交叉二维设计的探索性交互；题库未登记独立交互ContrastID，因此不输出正式D。",
        });
        exploratoryInteraction.factorA = factorA;
        exploratoryInteraction.factorB = factorB;
        factorialEffects = [exploratoryInteraction];
      } else if (category.scoreFamilies.includes("CUSTOM") && design.fullyCrossed) {
        const effectSpecs = binaryFactorEffectSpecs(category);
        outcomeSpecs.forEach((outcome) => effectSpecs.forEach((effectSpec) => {
          factorialEffects.push(weightedFactorEffect(allRows, category, effectSpec, outcome, analysisPlannedRepeats, {
            formal: false,
            exploratory: true,
            metadataBlocked: formalBlocked,
            reason: formalBlocked
              ? "当前元数据明确要求在题干—后果标签冲突关闭前仅作探索性响应析因，不输出正式D或C/N/I。"
              : "CUSTOM结果变量的设计矩阵析因效应；只有登记ContrastID后才能输出正式D。",
          }));
        }));
        groupBy(factorialEffects, (row) => row.outcomeId).forEach((rows) => holm(rows));
      }

      const factorialCompleteness = {
        fullyCrossed: design.fullyCrossed,
        plannedCells: design.plannedCells,
        cartesianCells: design.cartesianCells,
        structuralMissingCells: design.structuralUnplannedCells,
        structuralUnplannedCells: design.structuralUnplannedCells,
        dataMissingCells: design.dataMissingCells,
      };
      analyses.push({
        modelConfig,
        bankId: category.bankId,
        bankLabel: category.bankLabel,
        bankOrder: category.bankOrder,
        categoryId: category.categoryId,
        category: category.category,
        categoryKey: category.key,
        secondLevel: category.secondLevel,
        scoreFamily: category.scoreFamilies[0],
        conditionStructure: "FACTORIAL",
        factorKeys: category.factorKeys,
        factorLevels: category.factorLevels,
        cells,
        design,
        outcomeCatalog: outcomeSpecs.map(({ value, ...outcome }) => outcome),
        factorialEffects,
        responseSurface,
        registeredEffects: effects.summaries.filter((row) => row.modelConfig === modelConfig && row.categoryKey === category.key),
        exploratoryInteraction,
        factorialCompleteness,
        blocked: formalBlocked,
        formalBlocked,
        blockedReason: formalBlocked ? "当前CNI题库元数据标记C3/C4/C7/C8题干—后果标签冲突；平台提供三选项响应的探索性2×2×2析因画像，但不输出正式D或未经验证的C/N/I参数。" : "",
      });
    }));
    return { analyses };
  }

  function nonDirectionalAnalysis(records, catalog, includeRepaired, models) {
    const categories = catalogCategories(catalog).filter((category) => category.scoreFamilies.some((family) => family === "NOMINAL_RANK" || family === "CUSTOM"));
    const analyses = [];
    models.forEach((modelConfig) => categories.forEach((category) => {
      const rows = records.filter((record) => record.modelConfig === modelConfig && record.categoryKey === category.key && record.valid && (includeRepaired || !record.repaired));
      const cells = category.conditionDetails.map((detail) => {
        const cellRows = rows.filter((record) => record.conditionCode === detail.conditionCode);
        const topCounts = { L1: 0, L2: 0, L3: 0 };
        const rankingCounts = {};
        cellRows.forEach((record) => {
          if (record.topChoice) topCounts[record.topChoice] = (topCounts[record.topChoice] || 0) + 1;
          if (record.logicalRanking) rankingCounts[record.logicalRanking] = (rankingCounts[record.logicalRanking] || 0) + 1;
        });
        const meanRanks = {};
        ["L1", "L2", "L3"].forEach((logical) => { meanRanks[logical] = mean(cellRows.map((record) => record.ranks[logical]).filter(Number.isFinite)); });
        return {
          conditionCode: detail.conditionCode,
          conditionLabel: detail.label,
          factorValues: detail.factorValues,
          n: cellRows.length,
          topCounts,
          topProportions: Object.fromEntries(Object.entries(topCounts).map(([key, value]) => [key, cellRows.length ? value / cellRows.length : null])),
          meanRanks,
          rankingCounts,
        };
      });
      analyses.push({
        modelConfig,
        bankId: category.bankId,
        bankLabel: category.bankLabel,
        categoryId: category.categoryId,
        category: category.category,
        categoryKey: category.key,
        secondLevel: category.secondLevel,
        scoreFamily: category.scoreFamilies[0],
        conditionStructure: category.structures[0],
        cells,
        blocked: category.scoreFamilies.includes("CUSTOM") && (/^NA|处方式条件|冲突解决前|重建|重算/.test(`${category.contrastText} ${category.expectedEffects.join(" ")}`)),
        reason: category.scoreFamilies.includes("CUSTOM")
          ? "CUSTOM不构造单一普通P；本表报告首选率、平均排名与完整排序分布，主效应和交互请在FACTORIAL工作区按结果变量查看。正式D/C/N/I仍受元数据约束。"
          : "NOMINAL_RANK不设连续高低端，报告首选概率、平均排名和完整排序分布。",
      });
    }));
    return { analyses };
  }

  function reliability(records, includeRepaired, itemSummaries) {
    const summaries = itemSummaries || itemRepeatSummaries(records, includeRepaired, PLANNED_REPEATS_DEFAULT);
    const cells = summaries.filter((item) => item.validRepeats >= 2).map((item) => ({
      modelConfig: item.modelConfig, model: item.model, bankId: item.bankId, bankLabel: item.bankLabel,
      categoryId: item.categoryId, category: item.category, categoryKey: item.categoryKey,
      groupId: item.groupId, itemId: item.itemId, n: item.validRepeats,
      topAgreement: item.topAgreement, fullAgreement: item.fullAgreement, kendallTau: item.kendallTau,
      permutations: item.permutationCount, observedPermutationIds: item.observedPermutationIds,
      positionEligible: item.permutationCount >= 2, repeatStatus: item.repeatStatus,
      pMean: item.pMean, pSd: item.pSd,
    }));
    const positionCells = cells.filter((cell) => cell.positionEligible);
    const scoreCells = summaries.filter((item) => Number.isFinite(item.pMean)).map((item) => ({
      modelConfig: item.modelConfig, bankId: item.bankId, itemId: item.itemId,
      mean: item.pMean, withinVariance: Number.isFinite(item.pSd) ? item.pSd ** 2 : null,
    }));
    const withinValues = scoreCells.map((cell) => cell.withinVariance).filter(Number.isFinite);
    const betweenValues = [];
    let matchedItemCount = 0;
    groupBy(scoreCells, (cell) => `${cell.bankId}::${cell.itemId}`).forEach((rows) => {
      if (unique(rows.map((row) => row.modelConfig)).length < 2) return;
      const value = variance(rows.map((row) => row.mean));
      if (Number.isFinite(value)) { betweenValues.push(value); matchedItemCount += 1; }
    });
    const withinVariance = mean(withinValues);
    const betweenVariance = mean(betweenValues);
    const modelConfigCount = unique(scoreCells.map((cell) => cell.modelConfig)).length;
    let ratio = null;
    let ratioStatus = "INSUFFICIENT_MATCHED_MODELS";
    let ratioReason = "至少需要两个AnalysisModelKey在同一BankDatasetID×ItemID上有匹配结果";
    if (modelConfigCount >= 2 && matchedItemCount > 0 && Number.isFinite(withinVariance) && withinVariance === 0) {
      ratioStatus = "WITHIN_VARIANCE_ZERO";
      ratioReason = "模型内重复方差为0，描述性方差比不定义";
    } else if (modelConfigCount >= 2 && matchedItemCount > 0 && Number.isFinite(withinVariance) && withinVariance > 0 && Number.isFinite(betweenVariance)) {
      ratio = betweenVariance / withinVariance;
      ratioStatus = "AVAILABLE";
      ratioReason = "按BankDatasetID×ItemID匹配后的描述性模型间/模型内方差比";
    }
    const varianceDiagnostics = {
      name: "DescriptiveBetweenWithinVarianceRatio",
      meanBetweenModelVariance: betweenVariance,
      meanWithinModelVariance: withinVariance,
      matchedItemCount,
      modelConfigCount,
      ratio,
      ratioStatus,
      reason: ratioReason,
    };
    return {
      cells, positionCells, eligibleCells: cells.length,
      topAgreement: mean(cells.map((cell) => cell.topAgreement)),
      fullAgreement: mean(cells.map((cell) => cell.fullAgreement)),
      kendallTau: mean(cells.map((cell) => cell.kendallTau)),
      positionTopAgreement: mean(positionCells.map((cell) => cell.topAgreement)),
      positionFullAgreement: mean(positionCells.map((cell) => cell.fullAgreement)),
      withinVariance, betweenVariance, varianceRatio: ratio, varianceDiagnostics,
    };
  }

  function positionRandomizationDiagnostics(records, includeRepaired) {
    const included = records.filter((record) => record.valid && (includeRepaired || !record.repaired));
    const diagnostics = [];
    groupBy(included, (record) => `${record.modelConfig}::${record.bankId}`).forEach((rows) => {
      const permutationCounts = {};
      const displayTopCounts = { opt1: 0, opt2: 0, opt3: 0 };
      rows.forEach((row) => {
        if (row.permutationId) permutationCounts[row.permutationId] = (permutationCounts[row.permutationId] || 0) + 1;
        const top = rankingTokens(row.displayedRanking)[0];
        if (Object.hasOwn(displayTopCounts, top)) displayTopCounts[top] += 1;
      });
      const permutationTotal = Object.values(permutationCounts).reduce((sum, value) => sum + value, 0);
      const displayTopTotal = Object.values(displayTopCounts).reduce((sum, value) => sum + value, 0);
      const itemCentered = { opt1: [], opt2: [], opt3: [] };
      let eligibleItemCount = 0;
      groupBy(rows, (row) => row.itemId).forEach((itemRows) => {
        const usable = itemRows.map((row) => rankingTokens(row.displayedRanking)[0]).filter((top) => Object.hasOwn(displayTopCounts, top));
        if (!usable.length) return;
        if (unique(itemRows.map((row) => row.permutationId)).length >= 2) eligibleItemCount += 1;
        Object.keys(itemCentered).forEach((position) => itemCentered[position].push(usable.filter((top) => top === position).length / usable.length));
      });
      const observedPermutationIds = Object.keys(permutationCounts).sort();
      diagnostics.push({
        modelConfig: rows[0].modelConfig, bankId: rows[0].bankId, bankLabel: rows[0].bankLabel,
        bankDatasetId: rows[0].bankDatasetId, bankContentHash: rows[0].bankContentHash,
        recordCount: rows.length, permutationCounts,
        permutationProportions: Object.fromEntries(Object.entries(permutationCounts).map(([key, value]) => [key, permutationTotal ? value / permutationTotal : null])),
        observedPermutationIds, observedPermutationCount: observedPermutationIds.length,
        displayTopCounts,
        displayTopProportions: Object.fromEntries(Object.entries(displayTopCounts).map(([key, value]) => [key, displayTopTotal ? value / displayTopTotal : null])),
        itemCenteredDisplayTopProportions: Object.fromEntries(Object.entries(itemCentered).map(([key, values]) => [key, mean(values)])),
        eligibleItemCount,
        status: observedPermutationIds.length === 6 ? "DESCRIPTIVE_ALL_SIX_PERMUTATIONS" : "DESCRIPTIVE_PARTIAL_PERMUTATIONS",
        reason: "仅作总体位置随机化诊断；每题5次重复不要求覆盖全部6种排列",
      });
    });
    return diagnostics;
  }

  function profileSimilarity(profiles) {
    const models = unique(profiles.map((profile) => profile.modelConfig));
    const lookup = new Map(profiles.map((profile) => [`${profile.modelConfig}::${profile.categoryKey}`, profile.mean]));
    const categories = unique(profiles.map((profile) => profile.categoryKey));
    const matrix = models.map((modelA) => models.map((modelB) => {
      if (modelA === modelB) return 1;
      const xs = [];
      const ys = [];
      categories.forEach((category) => {
        const a = lookup.get(`${modelA}::${category}`);
        const b = lookup.get(`${modelB}::${category}`);
        if (Number.isFinite(a) && Number.isFinite(b)) { xs.push(a); ys.push(b); }
      });
      return pearson(xs, ys);
    }));
    return { models, categories, matrix };
  }

  function modelComparisons(groupMeans) {
    const models = unique(groupMeans.map((row) => row.modelConfig));
    const results = [];
    for (let i = 0; i < models.length; i += 1) {
      for (let j = i + 1; j < models.length; j += 1) {
        const modelA = models[i];
        const modelB = models[j];
        const rowsA = groupMeans.filter((row) => row.modelConfig === modelA);
        const rowsB = groupMeans.filter((row) => row.modelConfig === modelB);
        const mapB = new Map(rowsB.map((row) => [`${row.categoryKey}::${row.groupId}`, row]));
        const matched = rowsA.map((row) => ({ a: row, b: mapB.get(`${row.categoryKey}::${row.groupId}`) })).filter((pair) => pair.b);
        groupBy(matched, (pair) => pair.a.categoryKey).forEach((pairs) => {
          const differences = pairs.map((pair) => pair.a.value - pair.b.value);
          const interval = ci95(differences);
          results.push({
            bankId: pairs[0].a.bankId,
            bankLabel: pairs[0].a.bankLabel,
            categoryId: pairs[0].a.categoryId,
            category: pairs[0].a.category,
            categoryKey: pairs[0].a.categoryKey,
            modelA,
            modelB,
            n: differences.length,
            difference: interval.mean,
            ciLow: interval.low,
            ciHigh: interval.high,
            p: signFlipP(differences),
            pHolm: null,
          });
        });
      }
    }
    groupBy(results, (row) => `${row.modelA}::${row.modelB}`).forEach((rows) => holm(rows));
    return results;
  }

  function buildAudit(inputs, records, banks, modelConfigAudit = [], itemSummaries = [], plannedRepeats = PLANNED_REPEATS_DEFAULT) {
    const completeRows = inputs.completeRows || [];
    const rankingRows = inputs.rankingRows || [];
    const rawRecords = inputs.rawRecords || [];
    const summary = inputs.summary || null;
    const importBatches = inputs.importBatches || [];
    const checks = [];
    const add = (label, status, detail, value) => checks.push({ label, status, detail, value });

    if (importBatches.length) {
      const ready = importBatches.filter((batch) => batch.ready).length;
      add("导入批次完整性", ready === importBatches.length ? "pass" : "fail", `${ready}/${importBatches.length} 个批次具备排序结果.csv与完整运行记录.csv`, ready / importBatches.length);
      importBatches.forEach((batch) => {
        const summaryEntry = (inputs.batchSummaries || []).find((entry) => entry.batchId === batch.batchId);
        const info = summaryEntry && summaryEntry.info ? summaryEntry.info : batch.summaryInfo;
        const observed = batch.counts ? batch.counts.complete : null;
        if (info && info.recognized) {
          const expected = number(info.completed, number(info.total, null));
          const matched = expected == null || observed == null || expected === observed;
          add(`${batch.batchName}：可选摘要核验`, matched ? "pass" : "warn", expected == null ? `完整记录 ${observed == null ? "NA" : observed} 条；可选摘要未给出完成数` : `可选摘要 ${expected} 条；完整记录 ${observed} 条`, observed);
        } else {
          add(`${batch.batchName}：两CSV独立分析`, "pass", `未使用运行摘要；分析配置固定PlannedRepeats=${plannedRepeats}，当前完整记录${observed == null ? "NA" : observed}条`, observed);
        }
      });
    }
    add("主要分析数据源", records.length ? "pass" : "fail", records.length ? `识别 ${records.length} 条运行记录` : "未识别完整运行记录或排序结果", records.length);
    if (summary) {
      const expected = number(summary.completed, number(summary.total, null));
      const matched = expected == null || expected === records.length;
      add("摘要与记录数量", matched ? "pass" : "warn", expected == null ? "摘要未提供完成数" : `摘要 ${expected} 条；分析源 ${records.length} 条`, expected);
    } else add("运行摘要非必需", "pass", `未导入；PlannedRepeats由分析配置固定为${plannedRepeats}，不从批次或最大RepeatIndex推断`, null);

    if (rankingRows.length && completeRows.length) {
      add("排序结果与完整记录数量", rankingRows.length === completeRows.length ? "pass" : "warn", `排序结果 ${rankingRows.length} 条；完整记录 ${completeRows.length} 条`, rankingRows.length);
      const rankingKey = (row) => ["ImportBatchID", "SourceFile", "SourceRow", "ItemID", "RepeatIndex", "PermutationID"].map((field) => clean(row[field])).join("::");
      const rankingMap = new Map(rankingRows.map((row) => [rankingKey(row), clean(row.CanonicalRanking)]));
      let compared = 0;
      let equal = 0;
      completeRows.forEach((row) => {
        const key = rankingKey(row);
        if (rankingMap.has(key)) { compared += 1; if (rankingMap.get(key) === clean(row.CanonicalRanking)) equal += 1; }
      });
      add("排序内容交叉核验", compared && equal === compared ? "pass" : (compared ? "warn" : "fail"), compared ? `${equal}/${compared} 条 CanonicalRanking 一致` : "无法建立跨文件匹配键", compared ? equal / compared : 0);
    } else add("排序结果交叉核验", "warn", "未同时导入排序结果与完整运行记录", null);

    if (rawRecords.length && completeRows.length) {
      const responseKey = (row) => {
        const batchId = clean(row.ImportBatchID);
        const runId = clean(row.RunID);
        const requestId = clean(row.RequestID);
        return runId && requestId ? `${batchId}::${runId}::${requestId}` : "";
      };
      const rawIds = new Set(rawRecords.map(responseKey).filter(Boolean));
      const completeIds = unique(completeRows.map(responseKey).filter(Boolean));
      const covered = completeIds.filter((id) => rawIds.has(id)).length;
      add("原始响应 RunID＋RequestID 覆盖", covered === completeIds.length ? "pass" : "warn", `${covered}/${completeIds.length} 个完整记录复合请求键可追到原始响应`, completeIds.length ? covered / completeIds.length : 0);
    } else add("原始响应非必需", "pass", "未导入原始响应.jsonl；不影响P/E/D、FACTORIAL与题目质量统计", null);

    add("跨文件对齐口径", "pass", "两份CSV按ImportBatchID＋SourceFile＋SourceRow＋ItemID＋RepeatIndex＋PermutationID复合键核验；RunID、RequestID与ModelConfigID不参与文件间匹配", 1);

    const validRecords = records.filter((record) => record.responseValid);
    const parsed = validRecords.filter((record) => record.mappingValid && record.logical.length === 3).length;
    add("有效回答逻辑映射", parsed === validRecords.length ? "pass" : "fail", `${parsed}/${validRecords.length} 条状态有效回答经DisplayedRanking→SourceRanking→LogicalRanking多路径核验一致`, validRecords.length ? parsed / validRecords.length : null);
    const mappingConflicts = records.filter((record) => record.mappingStatus === "MAPPING_CONFLICT").length;
    add("映射路径冲突", mappingConflicts === 0 ? "pass" : "fail", mappingConflicts ? `${mappingConflicts} 条记录的多路径排序结果冲突，已阻断统计` : "未发现MAPPING_CONFLICT", mappingConflicts);
    const metadata = records.filter((record) => record.scoreFamily && record.conditionStructure && record.groupId).length;
    add("阶段一元数据覆盖", metadata === records.length ? "pass" : "warn", `${metadata}/${records.length} 条记录具备评分族、条件结构和 GroupID`, records.length ? metadata / records.length : null);
    add("题库元数据", banks.files.length ? "pass" : "warn", banks.files.length ? `已加载 ${banks.files.length} 个题库；${Object.values(banks.catalog).reduce((sum, bank) => sum + bank.rows, 0)} 个条件题` : "未加载独立题库，优先使用完整记录内嵌 Source_ 字段", banks.files.length);
    if (banks.runtimeMetadataRows) {
      const conflicts = banks.metadataConflicts.length;
      add(
        "运行记录题库目录同步",
        banks.datasetCompositionConflicts.length ? "fail" : (conflicts ? "warn" : "pass"),
        `从 Source_* 字段恢复 ${banks.runtimeMetadataRows} 个唯一题项；新增 ${banks.runtimeAddedItems} 个、与内置目录同ItemID ${banks.runtimeOverriddenItems} 个${banks.datasetCompositionConflicts.length ? `；发现 ${banks.datasetCompositionConflicts.length} 个关键字段冲突并阻断相关ItemID` : conflicts ? `；另有${conflicts}个非关键字段差异供审计` : "；未发现组成冲突"}`,
        banks.runtimeMetadataRows,
      );
    }
    const invalidScored = records.filter((record) => !record.valid && Number.isFinite(record.preference)).length;
    add("无效回答未计零分", invalidScored === 0 ? "pass" : "fail", invalidScored ? `${invalidScored} 条无效回答被错误计分` : "未发现无效回答进入偏好分", invalidScored);
    const models = unique(records.filter((record) => !record.modelIdentityBlocked).map((record) => record.modelConfig));
    const rawModels = unique(records.map((record) => record.rawModelConfigId));
    const mergedConfigs = modelConfigAudit.filter((row) => row.status === "MERGED_COMPATIBLE_CONFIGS");
    const mergedTransports = modelConfigAudit.filter((row) => row.status === "MERGED_TRANSPORT_MODES");
    const inferredConfigs = modelConfigAudit.filter((row) => row.inferredRecordCount > 0);
    const inferredRecords = inferredConfigs.reduce((sum, row) => sum + row.inferredRecordCount, 0);
    const ambiguousRecords = modelConfigAudit.reduce((sum, row) => sum + (row.ambiguousRecordCount || 0), 0);
    add("AnalysisModelKey 身份", models.length && models.every((model) => model !== "MODEL_UNSPECIFIED") ? "pass" : "warn", `按${MODEL_IDENTITY_POLICY}从完整运行记录识别 ${rawModels.length} 个原始ModelConfigID，形成 ${models.length} 个可分析AnalysisModelKey${mergedConfigs.length ? `；${mergedConfigs.length}组通过核心参数与非约束输出上限核验后合并` : ""}${mergedTransports.length ? `；${mergedTransports.length}组chat/responses接口协议差异仅保留审计、未拆分模型` : ""}`, models.length);
    add("模型配置缺失元数据解析", "pass", inferredRecords ? `${inferredRecords}条记录仅在同一RunID、Raw ModelConfigID或唯一行为锚点只有一个已知值时补全；推断字段与来源已进入审计` : "未发现需要唯一值补全的模型配置元数据", inferredRecords);
    add("模型配置歧义阻断", ambiguousRecords === 0 ? "pass" : "fail", ambiguousRecords ? `${ambiguousRecords}条记录的缺失字段对应多个已知配置，未自动合并且已阻断正式统计` : "未发现无法唯一归属的模型配置记录", ambiguousRecords);
    const completeItems = itemSummaries.filter((item) => item.repeatStatus === "COMPLETE").length;
    const duplicateItems = itemSummaries.filter((item) => item.repeatStatus === "DUPLICATE_OR_EXCESS").length;
    add("固定重复完整性", completeItems === itemSummaries.length && duplicateItems === 0 ? "pass" : "warn", `${completeItems}/${itemSummaries.length} 个ItemID统计单元严格具备RepeatIndex 1—${plannedRepeats}；重复或超额 ${duplicateItems} 个`, itemSummaries.length ? completeItems / itemSummaries.length : null);
    const parserVersions = unique(records.map((record) => record.parserVersion));
    add("解析器版本", parserVersions.length === 1 && parserVersions[0] ? "pass" : "warn", parserVersions.length ? `检测到 ${parserVersions.join("、")}` : "未记录 ParserVersion", parserVersions.length);
    const score = Math.round(100 * checks.reduce((sum, check) => sum + (check.status === "pass" ? 1 : check.status === "warn" ? 0.5 : 0), 0) / Math.max(1, checks.length));
    return { checks, score };
  }

  function decisionCards(records, catalog, reliabilityResult, effectsResult, plannedRepeats) {
    const reliabilityByGroup = groupBy(reliabilityResult.cells, (cell) => `${cell.bankId}::${cell.groupId}`);
    const effectsByGroup = groupBy(effectsResult.groupEffects, (effect) => `${effect.bankId}::${effect.groupId}`);
    const cards = [];
    groupBy(records, (record) => `${record.bankId}::${record.groupId}`).forEach((rows) => {
      const quality = qualityMetrics(rows);
      const rel = reliabilityByGroup.get(`${rows[0].bankId}::${rows[0].groupId}`) || [];
      const effects = effectsByGroup.get(`${rows[0].bankId}::${rows[0].groupId}`) || [];
      const expectedConditions = Math.max(...rows.map((row) => row.conditionCount || 1));
      const observedConditions = unique(rows.map((row) => row.conditionCode)).length;
      const models = unique(rows.map((row) => row.modelConfig));
      const repeatMax = Math.max(1, ...rows.map((row) => row.repeatIndex || 1));
      const topAgreement = mean(rel.map((cell) => cell.topAgreement));
      const fullAgreement = mean(rel.map((cell) => cell.fullAgreement));
      const positionTop = mean(rel.filter((cell) => cell.positionEligible).map((cell) => cell.topAgreement));
      const conflictText = `${rows[0].contrastId} ${rows[0].contrastWeights} ${rows[0].potentialConfound} ${rows[0].aggregationRule}`;
      const blocked = rows[0].scoreFamily === "CUSTOM" && (/处方式条件|冲突解决前|重建|重算|仅做描述/.test(conflictText) || /^NA/.test(rows[0].contrastWeights));
      const issues = [];
      if (blocked) issues.push("计分元数据标记为阻断");
      if (quality.finalValidRate != null && quality.finalValidRate < 0.98) issues.push(`修复后有效率 ${(quality.finalValidRate * 100).toFixed(1)}%`);
      if (repeatMax < 3 || rel.length === 0) issues.push(`重复不足（当前最多 ${repeatMax} 次）`);
      if (models.length < 2) issues.push("仅 1 个模型配置");
      if (observedConditions < expectedConditions) issues.push(`条件覆盖 ${observedConditions}/${expectedConditions}`);
      if (Number.isFinite(topAgreement) && topAgreement < 0.8) issues.push("首选一致率低于 80%");
      if (Number.isFinite(fullAgreement) && fullAgreement < 0.7) issues.push("完整排序一致率低于 70%");
      if (Number.isFinite(positionTop) && positionTop < 0.8) issues.push("位置首选一致率低于 80%");
      const reverse = effects.filter((effect) => effect.valid && effect.expectedDirection && Number.isFinite(effect.effect) && effect.effect * effect.expectedDirection < 0);
      if (reverse.length) issues.push(`发现 ${reverse.length} 个反向预登记效应`);

      let status = "PROVISIONAL";
      let statusLabel = "初步可用（待内容证据）";
      if (blocked) { status = "BLOCKED"; statusLabel = "计分阻断 / 理论复核"; }
      else if ((quality.finalValidRate != null && quality.finalValidRate < 0.98) || (Number.isFinite(positionTop) && positionTop < 0.8)) { status = "REVIEW"; statusLabel = "数据问题复核"; }
      else if (repeatMax < Math.max(3, plannedRepeats) || models.length < 2 || observedConditions < expectedConditions) { status = "MORE_DATA"; statusLabel = "补充数据后判断"; }
      cards.push({
        bankId: rows[0].bankId,
        bankLabel: rows[0].bankLabel,
        categoryId: rows[0].categoryId,
        category: rows[0].category,
        groupId: rows[0].groupId,
        itemIds: unique(rows.map((row) => row.itemId)),
        models: models.length,
        records: rows.length,
        observedConditions,
        expectedConditions,
        firstValidRate: quality.firstValidRate,
        finalValidRate: quality.finalValidRate,
        topAgreement,
        fullAgreement,
        positionTopAgreement: positionTop,
        effects: effects.filter((effect) => effect.valid),
        invalidStatuses: Object.fromEntries(Object.entries(quality.finalStatuses).filter(([statusName]) => !VALID.has(statusName))),
        issues,
        status,
        statusLabel,
        recommendation: blocked
          ? "当前题库元数据明确要求在题干—条件冲突关闭前仅做描述统计；请完成理论与内容复核后重建 ScoreFunctionID/ContrastID 并重新验证。"
          : status === "REVIEW"
            ? "先定位无效回答、位置或解析问题；如需修改题目或映射，建立新 ItemVersion 并返回预跑。"
            : status === "MORE_DATA"
              ? "补足每条件 3–5 次独立重复，并增加模型配置；条件题需覆盖预登记对比所需的全部条件。"
              : "数据证据未触发内部预警线；仍需与专家内容效度、操纵审定和版本记录共同形成最终去留结论。",
      });
    });
    return cards.sort((a, b) => BANKS[a.bankId].order - BANKS[b.bankId].order || a.categoryId.localeCompare(b.categoryId) || a.groupId.localeCompare(b.groupId));
  }

  function analyze(inputs, options = {}) {
    const includeRepaired = options.includeRepaired !== false;
    const sourceRows = (inputs.completeRows && inputs.completeRows.length) ? inputs.completeRows : (inputs.rankingRows || []);
    const banks = normalizeBanks(inputs.bankFiles || [], sourceRows);
    const records = normalizeRecords(sourceRows, banks);
    const modelConfigAudit = reconcileAnalysisModels(records);
    records.sort((a, b) => ModelOrder.compare(a, b));
    const models = unique(records.filter((record) => !record.modelIdentityBlocked).map((record) => record.modelConfig))
      .sort((a, b) => ModelOrder.compare(a, b, records));
    modelConfigAudit.sort((a, b) => ModelOrder.compareRows(a, b, records));
    const configuredRepeats = number(options.plannedRepeats, PLANNED_REPEATS_DEFAULT);
    const plannedRepeats = Number.isInteger(configuredRepeats) && configuredRepeats > 0 ? configuredRepeats : PLANNED_REPEATS_DEFAULT;
    const plannedRepeatsMax = plannedRepeats;
    const plannedRepeatsByBatch = {};
    unique([
      ...(inputs.importBatches || []).map((batch) => batch.batchId),
      ...records.map((record) => record.batchId),
    ]).forEach((batchId) => { plannedRepeatsByBatch[batchId] = plannedRepeats; });
    const itemSummaries = itemRepeatSummaries(records, includeRepaired, plannedRepeats);
    const itemStatus = new Map(itemSummaries.map((item) => [`${item.modelConfig}::${item.bankId}::${item.itemId}`, item]));
    records.forEach((record) => {
      const summary = itemStatus.get(`${record.modelConfig}::${record.bankId}::${record.itemId}`);
      record.repeatStatus = summary ? summary.repeatStatus : "INCOMPLETE";
      record.itemFormalEligible = !!(summary && summary.complete);
    });
    const quality = qualityMetrics(records);
    const profiles = categoryProfilesItemFirst(records, itemSummaries, banks.catalog, includeRepaired);
    const effects = conditionEffectsItemFirst(records, itemSummaries, banks.catalog, includeRepaired, plannedRepeats);
    const factorial = factorialAnalysis(records, banks.catalog, effects, includeRepaired, plannedRepeats, plannedRepeatsByBatch, models);
    const registry = buildMetricRegistry(records, banks.catalog, effects, includeRepaired, models, factorial);
    const nonDirectional = nonDirectionalAnalysis(records, banks.catalog, includeRepaired, models);
    const reliabilityResult = reliability(records, includeRepaired, itemSummaries);
    const positionDiagnostics = positionRandomizationDiagnostics(records, includeRepaired);
    const comparisons = modelComparisons(profiles.groupMeans);
    const similarity = profileSimilarity(profiles.profiles);
    const domain = DomainAnalysis && typeof DomainAnalysis.analyze === "function"
      ? DomainAnalysis.analyze({
        records,
        itemRepeatSummaries: itemSummaries,
        conditionSummaries: effects.conditionMeans,
        profiles,
        effects,
        factorial,
        nonDirectional,
        reliability: reliabilityResult,
      })
      : {
        version: "DOMAIN_ANALYSIS_UNAVAILABLE",
        catalog: [], itemAudit: [], groupAudit: [], reliabilitySummary: [], conditionProfile: [],
        effectProfile: [], heterogeneity: [], nonDirectionalProfile: [], metadataManifest: [],
        qa: { rawLabelCount: 0, missingRecordCount: records.length, missingItemCount: 0, itemConflictCount: 0, homogeneousGroupCount: 0, mixedGroupCount: 0, missingGroupCount: 0, eligibleGroupCount: 0 },
      };
    const incrementalAnalysisInput = {
      options: { includeRepaired, plannedRepeats }, records, effects,
      itemRepeatSummaries: itemSummaries, plannedRepeats,
      reliability: reliabilityResult,
    };
    const effectSizes = EffectSizes && typeof EffectSizes.analyze === "function"
      ? EffectSizes.analyze(incrementalAnalysisInput)
      : { categoryEffectSizes: [], effectModelComparisons: [], status: "EFFECT_SIZE_MODULE_UNAVAILABLE" };
    const icc = ICC && typeof ICC.analyze === "function"
      ? ICC.analyze(incrementalAnalysisInput, { repetitions: plannedRepeats })
      : { withinAiProfiles: [], crossAiCoreEffects: [], thetaByRepeat: [], status: "ICC_MODULE_UNAVAILABLE" };
    const audit = buildAudit(inputs, records, banks, modelConfigAudit, itemSummaries, plannedRepeats);
    const cards = decisionCards(records, banks.catalog, reliabilityResult, effects, plannedRepeats);
    const bankIds = unique(records.map((record) => record.bankId)).sort((a, b) => (BANKS[a] || BANKS.unknown).order - (BANKS[b] || BANKS.unknown).order);
    const categories = unique(records.map((record) => record.categoryKey)).map((key) => {
      const row = records.find((record) => record.categoryKey === key);
      return { key, bankId: row.bankId, secondLevel: row.secondLevel, categoryId: row.categoryId, category: row.category, bankLabel: row.bankLabel };
    });
    const validRecords = records.filter((record) => record.responseValid);
    const mappedValid = validRecords.filter((record) => record.mappingValid && record.logical.length === 3).length;
    const datasetManifest = Object.values(banks.catalog).map((bank) => ({
      bankDatasetId: bank.bankDatasetId,
      bankLabel: bank.name,
      bankPartIds: bank.bankPartIds,
      bankPartCount: bank.bankPartIds.length,
      bankContentHash: bank.contentHash,
      itemCount: bank.items,
      groupCount: bank.groups,
      rowCount: bank.rows,
      compositionConflictCount: banks.datasetCompositionConflicts.filter((row) => row.bankId === bank.bankId).length,
    }));
    const readiness = [
      { key: "quality", label: "数据质量", ready: quality.finalValidRate != null, score: quality.finalValidRate == null ? 0 : quality.finalValidRate, formula: "(VALID + REPAIRED_VALID) / 非技术响应", detail: quality.finalValidRate == null ? "没有可用记录" : `修复后有效率 ${(quality.finalValidRate * 100).toFixed(1)}%` },
      { key: "mapping", label: "逻辑映射", ready: validRecords.length > 0 && mappedValid === validRecords.length, score: validRecords.length ? mappedValid / validRecords.length : 0, formula: "可恢复完整 L 排序的有效回答 / 全部有效回答", detail: "有效回答需唯一恢复为 L 编码" },
      { key: "effects", label: "条件效应", ready: effects.summaries.some((row) => row.eligible), score: effects.summaries.length ? effects.summaries.filter((row) => row.eligible).length / effects.summaries.length : 0, formula: "可输出 D 的分类对比 / 已登记分类对比", detail: effects.summaries.some((row) => row.eligible) ? "存在覆盖充分的预登记对比" : "尚无覆盖充分的完整条件对比" },
      { key: "reliability", label: "重复一致性", ready: reliabilityResult.cells.length > 0, score: reliabilityResult.topAgreement || 0, formula: "mean[max_l count(TopChoice=l) / R]", detail: reliabilityResult.cells.length ? `${reliabilityResult.cells.length} 个条件可估计重复一致性` : "需每条件至少 2 次，建议 3–5 次" },
      { key: "discrimination", label: "模型区分", ready: models.length >= 2 && Number.isFinite(reliabilityResult.withinVariance), score: Math.min(1, models.length / 4), formula: "覆盖进度=min(ModelConfig 数 / 4, 1)；正式就绪还需可估计模型内方差", detail: models.length >= 2 ? `已识别 ${models.length} 个 ModelConfig` : "至少需要 2 个，建议 4–8 个 ModelConfig" },
      { key: "trace", label: "链路审计", ready: audit.score >= 80, score: audit.score / 100, formula: "round{100×(通过项+0.5×警告项)/检查项}/100", detail: `跨文件与字段核验 ${audit.score}/100` },
    ];
    return {
      options: { includeRepaired, plannedRepeats },
      banks,
      records,
      models,
      modelConfigAudit,
      datasetManifest,
      itemRepeatSummaries: itemSummaries,
      conditionSummaries: effects.conditionMeans,
      positionDiagnostics,
      bankIds,
      categories,
      plannedRepeats,
      plannedRepeatsMax,
      plannedRepeatsByBatch,
      importBatches: inputs.importBatches || [],
      quality,
      layeredQuality: layeredQuality(records),
      profiles,
      effects,
      registry,
      factorial,
      nonDirectional,
      reliability: reliabilityResult,
      domain,
      effectSizes,
      icc,
      comparisons,
      similarity,
      audit,
      cards,
      readiness,
      summary: inputs.summary || null,
      bankInfo: BANKS,
      statusLabels: STATUS_LABELS,
    };
  }

  return {
    analyze,
    BANKS,
    STATUS_LABELS,
    inferBank,
    parseContrasts,
    parseFactorLevel,
    normalizedLinearWeights,
    normalizedInteractionWeights,
    kendallTau,
    signFlipP,
    ci95,
    mean,
    sd,
    variance,
    pearson,
    linearRegression,
    clean,
    number,
    groupBy,
    unique,
    clamp,
    MODEL_DISPLAY_ORDER: ModelOrder.DISPLAY_ORDER,
    modelCompare: ModelOrder.compare,
    modelCompareRows: ModelOrder.compareRows,
  };
});
