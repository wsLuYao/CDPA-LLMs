(function (root, factory) {
  const ModelOrder = typeof module === "object" && module.exports
    ? require("./model-order.js")
    : root.DecisionModelOrder;
  const api = factory(ModelOrder);
  if (typeof module === "object" && module.exports) module.exports = api;
  root.DecisionRiskReference = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function (ModelOrder) {
  "use strict";

  const EPS = 1e-12;
  const COMPLETE_RANKINGS = ["L1>L2>L3", "L1>L3>L2", "L2>L1>L3", "L2>L3>L1", "L3>L1>L2", "L3>L2>L1"];

  function clean(value) { return value == null ? "" : String(value).trim(); }
  function finite(values) { return (values || []).filter(Number.isFinite); }
  function mean(values) { const xs = finite(values); return xs.length ? xs.reduce((sum, value) => sum + value, 0) / xs.length : null; }
  function sd(values) {
    const xs = finite(values);
    if (xs.length < 2) return null;
    const m = mean(xs);
    return Math.sqrt(xs.reduce((sum, value) => sum + (value - m) ** 2, 0) / (xs.length - 1));
  }
  function unique(values) { return Array.from(new Set((values || []).filter((value) => value !== "" && value != null))); }
  function groupBy(rows, keyFn) {
    const groups = new Map();
    (rows || []).forEach((row) => {
      const key = keyFn(row);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(row);
    });
    return groups;
  }
  function factors(text) {
    const result = {};
    clean(text).split(/[;；]/).forEach((part) => {
      const match = part.match(/^\s*([^=]+)\s*=\s*(.+?)\s*$/);
      if (!match) return;
      const raw = clean(match[2]);
      const value = Number(raw);
      result[clean(match[1])] = Number.isFinite(value) ? value : raw;
    });
    return result;
  }
  function seeded(seed) {
    let state = Number(seed) >>> 0;
    return () => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state / 4294967296;
    };
  }

  function sameNumber(left, right) {
    if (left == null && right == null) return true;
    const a = Number(left); const b = Number(right);
    return Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= 1e-9;
  }

  function completeCounts(counts) {
    return Object.fromEntries(COMPLETE_RANKINGS.map((ranking) => [ranking, Number(counts && counts[ranking]) || 0]));
  }

  function proportionsFromCounts(counts) {
    const completed = completeCounts(counts);
    const total = Object.values(completed).reduce((sum, count) => sum + count, 0);
    return Object.fromEntries(COMPLETE_RANKINGS.map((ranking) => [ranking, total ? completed[ranking] / total : null]));
  }

  function fallbackDomain(groupId, config) {
    const suffix = (clean(groupId).match(/_(\d\d)$/) || [])[1] || "";
    const map = config && config.domainApplicability && config.domainApplicability.groupSuffixFallback || {};
    return clean(map[suffix]);
  }

  function categoryDesign(analysis, config, categoryId, baseProbability) {
    const bank = analysis && analysis.banks && analysis.banks.catalog && analysis.banks.catalog.risk;
    const category = bank && (bank.categories || []).find((row) => row.categoryId === categoryId);
    const xKey = config.assumptions.xFactorByCategory[categoryId] || "";
    const baseKey = config.assumptions.baseFactorByCategory[categoryId] || "";
    if (!category) return { plannedGroups: null, expectedPointCount: null, expectedItemsByX: new Map() };
    const details = (category.conditionDetails || []).filter((detail) => {
      if (!baseKey) return true;
      return sameNumber(detail.factorValues && detail.factorValues[baseKey], baseProbability);
    });
    const expectedItemsByX = new Map();
    details.forEach((detail) => {
      const x = Number(detail.factorValues && detail.factorValues[xKey]);
      if (!Number.isFinite(x)) return;
      const perGroup = category.plannedGroups ? Number(detail.plannedItems) / category.plannedGroups : null;
      expectedItemsByX.set(x, (expectedItemsByX.get(x) || 0) + (Number.isFinite(perGroup) ? perGroup : 0));
    });
    return {
      plannedGroups: Number(category.plannedGroups) || null,
      expectedPointCount: expectedItemsByX.size || null,
      expectedItemsByX,
    };
  }

  function prelec(p, alpha, beta) {
    if (p <= 0) return 0;
    if (p >= 1) return 1;
    return Math.exp(-beta * ((-Math.log(p)) ** alpha));
  }

  function referenceParameters(config) {
    const p = config && config.model && config.model.parameters || {};
    const wg = (value) => prelec(value, Number(p.alphaGain), Number(p.betaGain));
    const wl = (value) => prelec(value, Number(p.alphaLoss), Number(p.betaLoss));
    const lambda = Number(p.lambda);
    const rows = [
      { categoryId: "Ref", baseProbability: null, assumption: "ARTICLE_MODEL_COMPOSITE", humanReference: wg(0.5) / (lambda * wl(0.5)), formulaId: "Ref" },
      { categoryId: "A2", baseProbability: null, assumption: "ARTICLE_MODEL_COMPOSITE", humanReference: 2 * wg(0.5), formulaId: "A2" },
      { categoryId: "B2", baseProbability: null, assumption: "ARTICLE_MODEL_COMPOSITE", humanReference: 2 * wl(0.5), formulaId: "B2" },
    ];
    [0, 0.45, 0.90].forEach((baseProbability) => {
      const delta = wg(baseProbability + 0.10) - wg(baseProbability);
      rows.push({
        categoryId: "A1", baseProbability, assumption: "NET_OUTCOME_INTEGRATION", formulaId: "A1_primary",
        humanReference: delta / (wg(baseProbability + 0.10) + lambda * wl(0.90 - baseProbability)),
      });
      rows.push({
        categoryId: "A1", baseProbability, assumption: "SEPARATED_COST", formulaId: "A1_sensitivity",
        humanReference: delta,
      });
    });
    [0.10, 0.55, 1.00].forEach((baseProbability) => rows.push({
      categoryId: "B1", baseProbability, assumption: "NET_OUTCOME_INTEGRATION", formulaId: "B1",
      humanReference: wl(baseProbability) - wl(baseProbability - 0.10),
    }));
    return rows.map((row) => ({
      ...row,
      referenceType: "LITERATURE_DERIVED_REFERENCE",
      referenceVersion: config.referenceVersion,
      citation: config.citation,
      primary: row.assumption !== "SEPARATED_COST",
    }));
  }

  function isotonic(points, direction) {
    const sign = direction === "DECREASING" ? -1 : 1;
    const blocks = (points || []).map((point, index) => ({
      start: index, end: index, weight: Number.isFinite(point.weight) && point.weight > 0 ? point.weight : 1,
      sum: sign * point.y * (Number.isFinite(point.weight) && point.weight > 0 ? point.weight : 1),
    }));
    let index = 0;
    while (index < blocks.length - 1) {
      const left = blocks[index];
      const right = blocks[index + 1];
      if (left.sum / left.weight <= right.sum / right.weight + EPS) { index += 1; continue; }
      blocks.splice(index, 2, {
        start: left.start, end: right.end, weight: left.weight + right.weight, sum: left.sum + right.sum,
      });
      if (index > 0) index -= 1;
    }
    const fitted = Array(points.length).fill(null);
    blocks.forEach((block) => {
      const value = sign * block.sum / block.weight;
      for (let i = block.start; i <= block.end; i += 1) fitted[i] = value;
    });
    return fitted;
  }

  function crossingIntervals(points, target = 0, yKey = "meanP") {
    const sorted = (points || []).filter((point) => Number.isFinite(point.x) && Number.isFinite(point[yKey])).slice().sort((a, b) => a.x - b.x);
    const exact = [];
    const exactGroups = [];
    const crossings = [];
    sorted.forEach((point, index) => {
      if (Math.abs(point[yKey] - target) > EPS) return;
      exact.push(point.x);
      const previous = exactGroups[exactGroups.length - 1];
      if (previous && previous.endIndex === index - 1) {
        previous.endIndex = index;
        previous.high = point.x;
        previous.values.push(point.x);
      } else {
        exactGroups.push({ startIndex: index, endIndex: index, low: point.x, high: point.x, values: [point.x] });
      }
    });
    for (let i = 0; i < sorted.length - 1; i += 1) {
      const left = sorted[i];
      const right = sorted[i + 1];
      const y1 = left[yKey] - target;
      const y2 = right[yKey] - target;
      if (Math.abs(y1) <= EPS || Math.abs(y2) <= EPS) continue;
      if (y1 * y2 < 0) {
        crossings.push({
          lowTested: left.x,
          highTested: right.x,
          estimate: left.x + (target - left[yKey]) * (right.x - left.x) / (right[yKey] - left[yKey]),
          leftValue: left[yKey],
          rightValue: right[yKey],
        });
      }
    }
    return { sorted, exact, exactGroups, crossings, crossingCount: exactGroups.length + crossings.length };
  }

  function threshold(points, direction, yKey = "meanP", target = 0) {
    const found = crossingIntervals(points, target, yKey);
    const values = found.sorted.map((point) => point[yKey]);
    const minX = found.sorted.length ? found.sorted[0].x : null;
    const maxX = found.sorted.length ? found.sorted[found.sorted.length - 1].x : null;
    if (found.sorted.length < 2) return { status: "INSUFFICIENT_DATA", reason: "至少需要两个不同测试点", minX, maxX, crossings: found.crossings, crossingCount: found.crossingCount };
    if (found.crossingCount > 1) return { status: "NON_MONOTONIC", reason: "原始曲线在分离位置多次到达或跨越目标值，无唯一稳定拐点", minX, maxX, crossings: found.crossings, exactGroups: found.exactGroups, crossingCount: found.crossingCount };
    if (found.exactGroups.length === 1) {
      const exactGroup = found.exactGroups[0];
      const low = exactGroup.low;
      const high = exactGroup.high;
      return { status: "OK", reason: low === high ? "真实测试点恰等于目标值" : "连续真实测试点形成目标值区间", lowTested: low, highTested: high, estimate: (low + high) / 2, exactRange: exactGroup.values, exactGroups: found.exactGroups, crossings: found.crossings, crossingCount: 1 };
    }
    if (found.crossings.length === 1) return { status: "OK", reason: "相邻真实测试点实际跨越目标值，采用描述性线性插值", ...found.crossings[0], crossings: found.crossings, crossingCount: 1 };
    const allAbove = values.every((value) => value > target);
    const allBelow = values.every((value) => value < target);
    if (allAbove || allBelow) {
      const increasing = direction === "INCREASING";
      const status = (allAbove && increasing) || (allBelow && !increasing) ? "OUT_OF_RANGE_LOW" : "OUT_OF_RANGE_HIGH";
      return {
        status,
        reason: status === "OUT_OF_RANGE_LOW" ? `拐点低于最小测试值${minX}` : `拐点高于最大测试值${maxX}`,
        inequality: status === "OUT_OF_RANGE_LOW" ? `<${minX}` : `>${maxX}`,
        minX, maxX, crossings: found.crossings, crossingCount: 0,
      };
    }
    return { status: "NON_UNIQUE", reason: "未形成唯一相邻跨越区间", minX, maxX, crossings: found.crossings, crossingCount: found.crossingCount };
  }

  function logisticFit(observations, direction) {
    const rows = (observations || []).filter((row) => Number.isFinite(row.x) && (row.y === 0 || row.y === 1));
    const xs = rows.map((row) => row.x);
    const ys = rows.map((row) => row.y);
    if (rows.length < 4 || unique(xs).length < 2) return { status: "INSUFFICIENT_DATA", reason: "有效二元观察或测试点不足" };
    if (ys.every((value) => value === ys[0])) return { status: "INSUFFICIENT_DATA", diagnostic: "ALL_Y_IDENTICAL", reason: `所有Y均为${ys[0]}` };
    const x0 = rows.filter((row) => row.y === 0).map((row) => row.x);
    const x1 = rows.filter((row) => row.y === 1).map((row) => row.x);
    const separatedIncreasing = Math.max(...x0) < Math.min(...x1);
    const separatedDecreasing = Math.max(...x1) < Math.min(...x0);
    if (separatedIncreasing || separatedDecreasing) return { status: "SEPARATED", reason: "二元结果发生完全分离，标准Logistic无有限稳定估计" };
    const xMean = mean(xs);
    const xScale = Math.sqrt(mean(xs.map((x) => (x - xMean) ** 2))) || 1;
    let a = Math.log((mean(ys) + 0.01) / (1 - mean(ys) + 0.01));
    let b = 0;
    let converged = false;
    for (let iteration = 0; iteration < 100; iteration += 1) {
      let g0 = 0; let g1 = 0; let h00 = 0; let h01 = 0; let h11 = 0;
      rows.forEach((row) => {
        const z = (row.x - xMean) / xScale;
        const eta = Math.max(-35, Math.min(35, a + b * z));
        const probability = 1 / (1 + Math.exp(-eta));
        const weight = Math.max(1e-9, probability * (1 - probability));
        g0 += row.y - probability;
        g1 += (row.y - probability) * z;
        h00 += weight;
        h01 += weight * z;
        h11 += weight * z * z;
      });
      const determinant = h00 * h11 - h01 * h01;
      if (!Number.isFinite(determinant) || Math.abs(determinant) < 1e-10) return { status: "SEPARATED", reason: "Logistic信息矩阵奇异或近分离" };
      const da = (g0 * h11 - g1 * h01) / determinant;
      const db = (g1 * h00 - g0 * h01) / determinant;
      a += da; b += db;
      if (Math.max(Math.abs(da), Math.abs(db)) < 1e-8) { converged = true; break; }
      if (Math.abs(a) > 30 || Math.abs(b) > 30) return { status: "SEPARATED", diagnostic: "NEAR_SEPARATION", reason: "Logistic系数发散，判定为近分离" };
    }
    if (!converged || Math.abs(b) < 1e-10) return { status: "INSUFFICIENT_DATA", reason: "Logistic未稳定收敛或斜率接近0" };
    const slope = b / xScale;
    const intercept = a - b * xMean / xScale;
    const estimate = -intercept / slope;
    const expectedSign = direction === "INCREASING" ? 1 : -1;
    if (slope * expectedSign < 0) return { status: "REVERSE_DIRECTION", reason: "Logistic斜率与预设方向相反", intercept, slope, estimate };
    const minX = Math.min(...xs); const maxX = Math.max(...xs);
    if (estimate < minX || estimate > maxX) return { status: "OUT_OF_RANGE", reason: "Logistic 0.5阈值位于测试范围外", intercept, slope, estimate, minX, maxX };
    return { status: "OK", reason: "标准Logistic有限收敛且阈值位于测试范围内", intercept, slope, estimate, minX, maxX };
  }

  function domainApplicability(domain) {
    return /金融|财产|金钱|投资/.test(clean(domain)) ? "CLOSEST_MONETARY_ANALOGUE" : "EXPLORATORY_EXTERNAL_REFERENCE";
  }

  function conditionPoints(analysis, config) {
    const xByCategory = config.assumptions.xFactorByCategory || {};
    const baseByCategory = config.assumptions.baseFactorByCategory || {};
    const representative = new Map();
    const plannedRepeats = Number(analysis && (analysis.plannedRepeats || analysis.options && analysis.options.plannedRepeats)) || 5;
    const repeatCoverageGate = Number(config.assumptions.minimumRepeatCoverage) || 0.8;
    const minimumValidRepeats = Math.ceil(plannedRepeats * repeatCoverageGate);
    (analysis.records || []).filter((row) => row.bankId === "risk").forEach((row) => {
      const key = `${row.modelConfig}::${row.bankId}::${row.itemId}`;
      if (!representative.has(key)) representative.set(key, row);
    });
    const validByItem = groupBy((analysis.records || []).filter((row) => row.bankId === "risk" && row.valid && (analysis.options.includeRepaired || !row.repaired)), (row) => `${row.modelConfig}::${row.itemId}`);
    const itemRows = (analysis.itemRepeatSummaries || []).filter((item) => item.bankId === "risk" && Number.isFinite(item.pMean)).map((item) => {
      const record = representative.get(`${item.modelConfig}::${item.bankId}::${item.itemId}`) || {};
      const parsed = factors(record.conditionLevel);
      const xKey = xByCategory[item.categoryId];
      const baseKey = baseByCategory[item.categoryId];
      const x = Number(parsed[xKey]);
      const baseProbability = baseKey ? Number(parsed[baseKey]) : null;
      const validRecords = validByItem.get(`${item.modelConfig}::${item.itemId}`) || [];
      const binary = validRecords.map((row) => Number.isFinite(row.rankL1) && Number.isFinite(row.rankL3) ? (row.rankL3 < row.rankL1 ? 1 : 0) : null).filter(Number.isFinite);
      const sourceDomain = clean(item.domain || record.domain);
      const resolvedDomain = sourceDomain || fallbackDomain(item.groupId, config);
      return {
        modelConfig: item.modelConfig, bankId: "risk", bankDatasetId: item.bankDatasetId || "risk",
        categoryId: item.categoryId, category: item.category, categoryKey: item.categoryKey,
        groupId: item.groupId, itemId: item.itemId, conditionCode: item.conditionCode,
        domain: resolvedDomain, domainKey: item.domainKey || record.domainKey || (resolvedDomain ? `risk::${resolvedDomain}` : ""),
        domainSource: sourceDomain ? "SOURCE_METADATA" : (resolvedDomain ? "GROUP_SUFFIX_FALLBACK" : "MISSING"),
        domainStatus: item.domainStatus || record.domainStatus || (resolvedDomain ? "DOMAIN_FALLBACK" : "DOMAIN_UNAUDITED"),
        domainEligible: item.domainEligible !== false && record.domainEligible !== false,
        xFactor: xKey || "", x, baseFactor: baseKey || "", baseProbability: Number.isFinite(baseProbability) ? baseProbability : null,
        meanP: item.pMean, sdP: item.pSd, minP: item.pMin, maxP: item.pMax, validN: item.pRepeats,
        plannedRepeats, minimumValidRepeats, repeatFormalEligible: Number(item.pRepeats) >= minimumValidRepeats,
        binarySuccesses: binary.reduce((sum, value) => sum + value, 0), binaryN: binary.length,
        rankingCounts: validRecords.reduce((counts, row) => ({ ...counts, [row.logicalRanking]: (counts[row.logicalRanking] || 0) + 1 }), {}),
      };
    }).filter((row) => row.xFactor && Number.isFinite(row.x));
    const points = [];
    groupBy(itemRows, (row) => `${row.modelConfig}::${row.categoryId}::${row.groupId}::${row.baseProbability == null ? "NA" : row.baseProbability}::${row.x}`).forEach((rows) => {
      const design = categoryDesign(analysis, config, rows[0].categoryId, rows[0].baseProbability);
      const plannedItemCount = design.expectedItemsByX.get(rows[0].x) || rows.length;
      const pMeans = rows.map((row) => row.meanP);
      const rankingCounts = {};
      rows.forEach((row) => Object.entries(row.rankingCounts || {}).forEach(([ranking, count]) => { rankingCounts[ranking] = (rankingCounts[ranking] || 0) + count; }));
      const binaryN = rows.reduce((sum, row) => sum + row.binaryN, 0);
      const binarySuccesses = rows.reduce((sum, row) => sum + row.binarySuccesses, 0);
      const completedRankingCounts = completeCounts(rankingCounts);
      const rankingProportions = proportionsFromCounts(completedRankingCounts);
      const eligibleItemCount = rows.filter((row) => row.repeatFormalEligible).length;
      const formalEligible = rows.length >= plannedItemCount && eligibleItemCount >= plannedItemCount;
      points.push({
        modelConfig: rows[0].modelConfig, bankId: "risk", bankDatasetId: rows[0].bankDatasetId,
        categoryId: rows[0].categoryId, category: rows[0].category, categoryKey: rows[0].categoryKey,
        groupId: rows[0].groupId, curveScope: "GROUP", comparisonLevel: "APPLICATION_SCENARIO", domain: rows[0].domain, domainKey: rows[0].domainKey,
        domainSource: rows[0].domainSource,
        domainStatus: rows[0].domainStatus, domainEligible: rows.every((row) => row.domainEligible),
        referenceApplicability: domainApplicability(rows[0].domain), xFactor: rows[0].xFactor, x: rows[0].x,
        baseFactor: rows[0].baseFactor, baseProbability: rows[0].baseProbability,
        // ItemID-first:多个Item落在同一测试点时报告Item均值之间的样本SD；
        // 单Item测试点直接沿用该Item五次P的样本SD，不能用min/max伪造SD。
        meanP: mean(pMeans), sdP: rows.length > 1 ? sd(pMeans) : rows[0].sdP,
        minP: Math.min(...rows.map((row) => row.minP).filter(Number.isFinite)), maxP: Math.max(...rows.map((row) => row.maxP).filter(Number.isFinite)),
        validN: rows.reduce((sum, row) => sum + row.validN, 0), itemCount: rows.length,
        plannedRepeats, minimumValidRepeats, plannedItemCount, eligibleItemCount, formalEligible,
        formalEligibilityReason: formalEligible ? "满足每个Item至少80%有效重复及计划Item覆盖" : `当前测试点有效Item ${eligibleItemCount}/${plannedItemCount}`,
        plannedGroupCount: design.plannedGroups, observedGroupCount: 1, eligibleGroupCount: formalEligible ? 1 : 0,
        expectedPointCount: design.expectedPointCount,
        rawBinaryRate: binaryN ? binarySuccesses / binaryN : null, binarySuccesses, binaryN,
        rankingCounts: completedRankingCounts, rankingProportions, rankingAggregation: "RAW_COUNTS_WITHIN_GROUP_POINT",
        l2TopRate: COMPLETE_RANKINGS.filter((ranking) => ranking.startsWith("L2>")).reduce((sum, ranking) => sum + (rankingProportions[ranking] || 0), 0),
      });
    });
    groupBy(points, (row) => `${row.modelConfig}::${row.categoryId}::${row.baseProbability == null ? "NA" : row.baseProbability}::${row.x}`).forEach((rows) => {
      const complete = rows.filter((row) => Number.isFinite(row.meanP));
      if (!complete.length) return;
      const design = categoryDesign(analysis, config, complete[0].categoryId, complete[0].baseProbability);
      const binaryRates = complete.map((row) => row.rawBinaryRate).filter(Number.isFinite);
      const plannedGroupCount = design.plannedGroups || complete.length;
      const eligibleGroupCount = complete.filter((row) => row.formalEligible).length;
      const formalEligible = complete.length === plannedGroupCount && eligibleGroupCount === plannedGroupCount;
      const pooledRankingCounts = complete.reduce((counts, row) => {
        COMPLETE_RANKINGS.forEach((ranking) => { counts[ranking] += row.rankingCounts[ranking] || 0; });
        return counts;
      }, completeCounts({}));
      const rankingProportions = Object.fromEntries(COMPLETE_RANKINGS.map((ranking) => [ranking, mean(complete.map((row) => row.rankingProportions[ranking]))]));
      points.push({
        ...complete[0], groupId: "ALL_GROUPS_EQUAL_WEIGHT", curveScope: "CATEGORY_EQUAL_GROUP", comparisonLevel: "DIMENSION_OVERALL", domain: "四类应用情境等权总体", domainKey: "risk::ALL_APPLICATION_SCENARIOS",
        domainSource: "EQUAL_WEIGHT_ACROSS_GROUPS",
        domainStatus: unique(complete.map((row) => row.domain)).length === 1 ? "HOMOGENEOUS" : "MIXED",
        domainEligible: false,
        referenceApplicability: "OVERALL_MIXED_DOMAINS_EXPLORATORY_REFERENCE", meanP: mean(complete.map((row) => row.meanP)),
        sdP: sd(complete.map((row) => row.meanP)), minP: Math.min(...complete.map((row) => row.meanP)), maxP: Math.max(...complete.map((row) => row.meanP)),
        validN: complete.reduce((sum, row) => sum + row.validN, 0), itemCount: complete.reduce((sum, row) => sum + row.itemCount, 0),
        plannedItemCount: complete.reduce((sum, row) => sum + row.plannedItemCount, 0), eligibleItemCount: complete.reduce((sum, row) => sum + row.eligibleItemCount, 0),
        plannedGroupCount, observedGroupCount: complete.length, eligibleGroupCount, formalEligible,
        formalEligibilityReason: formalEligible ? "四个应用情境均满足覆盖要求并按GroupID等权" : `当前测试点有效情境 ${eligibleGroupCount}/${plannedGroupCount}`,
        expectedPointCount: design.expectedPointCount,
        rawBinaryRate: mean(binaryRates), binarySuccesses: null, binaryN: complete.reduce((sum, row) => sum + row.binaryN, 0),
        rankingCounts: pooledRankingCounts, rankingProportions, rankingAggregation: "EQUAL_WEIGHT_GROUP_PROPORTIONS_AT_SAME_X",
        l2TopRate: COMPLETE_RANKINGS.filter((ranking) => ranking.startsWith("L2>")).reduce((sum, ranking) => sum + (rankingProportions[ranking] || 0), 0), groupCount: complete.length,
      });
    });
    return points.sort((a, b) => ModelOrder.compareRows(a, b, analysis.records) || a.categoryId.localeCompare(b.categoryId) || a.groupId.localeCompare(b.groupId) || (a.baseProbability == null ? -Infinity : a.baseProbability) - (b.baseProbability == null ? -Infinity : b.baseProbability) || a.x - b.x);
  }

  function curveResults(points, config, references) {
    const results = [];
    groupBy(points, (row) => `${row.modelConfig}::${row.categoryId}::${row.groupId}::${row.baseProbability == null ? "NA" : row.baseProbability}`).forEach((rows) => {
      const ordered = rows.slice().sort((a, b) => a.x - b.x);
      const direction = config.assumptions.expectedMonotonicDirection[rows[0].categoryId];
      const fitted = isotonic(ordered.map((row) => ({ x: row.x, y: row.meanP, weight: row.validN })), direction);
      ordered.forEach((row, index) => { row.isotonicP = fitted[index]; });
      const primaryDiagnostic = threshold(ordered, direction, "meanP", 0);
      const sensitivityDiagnostic = threshold(ordered.map((row) => ({ ...row, fitted: row.isotonicP })), direction, "fitted", 0);
      const expectedPointCount = Number(rows[0].expectedPointCount) || unique(ordered.map((row) => row.x)).length;
      const eligiblePointCount = ordered.filter((row) => row.formalEligible !== false).length;
      const coverageComplete = ordered.length === expectedPointCount && eligiblePointCount === expectedPointCount;
      const coverageReason = coverageComplete
        ? "所有计划横轴点均满足重复与情境覆盖要求"
        : `正式拐点被覆盖门槛阻断：有效测试点 ${eligiblePointCount}/${expectedPointCount}，实际观测 ${ordered.length}/${expectedPointCount}`;
      const primary = coverageComplete ? primaryDiagnostic : { ...primaryDiagnostic, status: "COVERAGE_BLOCKED", reason: coverageReason, estimate: null, inequality: "" };
      const sensitivity = coverageComplete ? sensitivityDiagnostic : { ...sensitivityDiagnostic, status: "COVERAGE_BLOCKED", reason: coverageReason, estimate: null, inequality: "" };
      const ref = references.find((row) => row.categoryId === rows[0].categoryId && row.primary && (row.baseProbability == null || Math.abs(row.baseProbability - rows[0].baseProbability) <= 1e-9));
      const observations = [];
      if (rows[0].curveScope === "GROUP") {
        const relevant = points.filter((point) => point.curveScope === "GROUP" && point.modelConfig === rows[0].modelConfig && point.categoryId === rows[0].categoryId && point.groupId === rows[0].groupId && point.baseProbability === rows[0].baseProbability);
        relevant.forEach((point) => {
          for (let i = 0; i < point.binaryN; i += 1) observations.push({ x: point.x, y: i < point.binarySuccesses ? 1 : 0 });
        });
      }
      const binaryRawDiagnostic = threshold(ordered, direction, "rawBinaryRate", 0.5);
      const binaryRaw = coverageComplete ? binaryRawDiagnostic : { ...binaryRawDiagnostic, status: "COVERAGE_BLOCKED", reason: coverageReason, estimate: null, inequality: "" };
      const rawBinaryNonUnique = binaryRawDiagnostic.status === "NON_MONOTONIC";
      const logistic = !coverageComplete
        ? { status: "COVERAGE_BLOCKED", reason: coverageReason }
        : rows[0].curveScope !== "GROUP"
        ? { status: "NOT_RUN_EQUAL_GROUP_AGGREGATE", reason: "总体二元曲线按GroupID概率等权；不把四类情境的重复回答伪装成独立人类被试来拟合Logistic" }
        : rawBinaryNonUnique
          ? { status: "NON_UNIQUE", reason: "原始Y比例存在多次0.5跨越或多个分离的精确0.5测试点，不输出唯一Logistic阈值" }
          : logisticFit(observations, direction);
      const estimate = Number.isFinite(primary.estimate) ? primary.estimate : null;
      const binaryBridgeThreshold = logistic.status === "OK" && Number.isFinite(logistic.estimate)
        ? logistic.estimate
        : binaryRaw.status === "OK" && Number.isFinite(binaryRaw.estimate) ? binaryRaw.estimate : null;
      const binaryBridgeSource = logistic.status === "OK" && Number.isFinite(logistic.estimate)
        ? "GROUP_LOGISTIC"
        : binaryRaw.status === "OK" && Number.isFinite(binaryRaw.estimate) ? "RAW_BINARY_0.5_CROSSOVER" : "NOT_AVAILABLE";
      results.push({
        modelConfig: rows[0].modelConfig, bankId: "risk", bankDatasetId: rows[0].bankDatasetId,
        categoryId: rows[0].categoryId, category: rows[0].category, categoryKey: rows[0].categoryKey,
        groupId: rows[0].groupId, curveScope: rows[0].curveScope, domain: rows[0].domain, domainKey: rows[0].domainKey,
        domainStatus: rows[0].domainStatus, domainEligible: rows[0].domainEligible,
        referenceApplicability: rows[0].referenceApplicability, baseProbability: rows[0].baseProbability,
        xFactor: rows[0].xFactor, expectedDirection: direction,
        thresholdStatus: primary.status, thresholdReason: primary.reason, thresholdLowTested: primary.lowTested,
        thresholdHighTested: primary.highTested, thresholdEstimate: estimate, thresholdInequality: primary.inequality || "",
        thresholdDiagnosticStatus: primaryDiagnostic.status, rawCrossingCount: primaryDiagnostic.crossingCount || 0,
        isotonicStatus: sensitivity.status, isotonicEstimate: sensitivity.estimate, isotonicLowTested: sensitivity.lowTested, isotonicHighTested: sensitivity.highTested,
        isotonicRole: "SENSITIVITY_ONLY",
        humanReference: ref ? ref.humanReference : null, humanReferenceAssumption: ref ? ref.assumption : "",
        differenceFromHuman: estimate != null && ref ? estimate - ref.humanReference : null,
        binaryRawStatus: binaryRaw.status, binaryRawEstimate: binaryRaw.estimate, binaryRawLowTested: binaryRaw.lowTested, binaryRawHighTested: binaryRaw.highTested,
        binaryRawDiagnosticStatus: binaryRawDiagnostic.status,
        logisticStatus: logistic.status, logisticReason: logistic.reason, logisticThreshold: logistic.estimate,
        logisticSlope: logistic.slope, logisticIntercept: logistic.intercept,
        logisticRole: "DESCRIPTIVE_BINARY_ROBUSTNESS_NOT_INDEPENDENT_HUMAN_SAMPLE",
        binaryBridgeThreshold, binaryBridgeSource,
        binaryBridgeDifferenceFromHuman: binaryBridgeThreshold != null && ref ? binaryBridgeThreshold - ref.humanReference : null,
        pVsBinaryDifference: estimate != null && binaryBridgeThreshold != null ? estimate - binaryBridgeThreshold : null,
        pVsLogisticDifference: estimate != null && Number.isFinite(logistic.estimate) ? estimate - logistic.estimate : null,
        pointCount: ordered.length, expectedPointCount, eligiblePointCount, coverageComplete, coverageReason,
        plannedGroupCount: rows[0].plannedGroupCount, minimumValidRepeats: rows[0].minimumValidRepeats,
        validN: ordered.reduce((sum, row) => sum + row.validN, 0),
      });
    });
    return results;
  }

  function rankingDistributions(points) {
    return (points || []).map((point) => {
      const counts = completeCounts(point.rankingCounts);
      const proportions = point.rankingProportions || proportionsFromCounts(counts);
      const modal = COMPLETE_RANKINGS.map((ranking) => [ranking, proportions[ranking]])
        .filter(([, proportion]) => Number.isFinite(proportion))
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
      const total = Object.values(counts).reduce((sum, count) => sum + count, 0);
      return {
        modelConfig: point.modelConfig, bankId: "risk", categoryId: point.categoryId, category: point.category,
        groupId: point.groupId, curveScope: point.curveScope, comparisonLevel: point.comparisonLevel,
        domain: point.domain, domainKey: point.domainKey, baseProbability: point.baseProbability,
        xFactor: point.xFactor, x: point.x, rankingCounts: counts, rankingProportions: proportions,
        rankingAggregation: point.rankingAggregation, l2TopRate: point.l2TopRate,
        modalRanking: modal ? modal[0] : "", modalProportion: modal ? modal[1] : null,
        modalCount: point.curveScope === "GROUP" && modal ? counts[modal[0]] : null,
        validN: total, formalEligible: point.formalEligible,
      };
    });
  }

  function analyze(analysis, config) {
    if (!analysis || !config) return { status: "REFERENCE_NOT_LOADED", referenceParameters: [], curvePoints: [], thresholds: [], binaryRobustness: [], rankingDistributions: [] };
    const referenceRows = referenceParameters(config);
    const points = conditionPoints(analysis, config);
    const thresholds = curveResults(points, config, referenceRows);
    return {
      status: points.length ? "READY" : "NO_RISK_CURVE_DATA",
      referenceType: "LITERATURE_DERIVED_REFERENCE",
      referenceVersion: config.referenceVersion,
      referenceParameters: referenceRows,
      curvePoints: points,
      thresholds,
      binaryRobustness: thresholds.map((row) => ({
        modelConfig: row.modelConfig, bankId: row.bankId, categoryId: row.categoryId, category: row.category,
        groupId: row.groupId, curveScope: row.curveScope, domain: row.domain, domainKey: row.domainKey,
        baseProbability: row.baseProbability, rawBinaryStatus: row.binaryRawStatus,
        rawBinaryThreshold: row.binaryRawEstimate, rawBinaryLowTested: row.binaryRawLowTested, rawBinaryHighTested: row.binaryRawHighTested,
        logisticStatus: row.logisticStatus, logisticReason: row.logisticReason, logisticThreshold: row.logisticThreshold,
        logisticSlope: row.logisticSlope, logisticRole: row.logisticRole,
        binaryBridgeThreshold: row.binaryBridgeThreshold, binaryBridgeSource: row.binaryBridgeSource,
        binaryBridgeDifferenceFromHuman: row.binaryBridgeDifferenceFromHuman,
        pThreshold: row.thresholdEstimate, pVsBinaryDifference: row.pVsBinaryDifference, pVsLogisticDifference: row.pVsLogisticDifference,
        coverageComplete: row.coverageComplete, eligiblePointCount: row.eligiblePointCount, expectedPointCount: row.expectedPointCount,
      })),
      rankingDistributions: rankingDistributions(points),
      methodology: {
        thresholdName: "P=0排序倾向拐点 / sorting-preference crossover",
        rawCurvePrimary: true, isotonicRole: "SENSITIVITY_ONLY",
        comprehensiveCurve: "ITEM_FIRST_THEN_EQUAL_WEIGHT_ACROSS_APPLICATION_GROUPS_AT_EACH_X",
        baseProbabilityRule: "A1/B1基础概率分别成曲线、分别求拐点，禁止合并三个基础概率",
        formalCoverageRule: "每Item至少80%计划重复；综合点必须覆盖全部计划GroupID；曲线必须覆盖全部计划横轴点",
        rankingDistributionRule: "六种完整排序按每个真实横轴点保留，不跨成本水平混合",
        noExtrapolation: true, primaryRiskAssumption: config.assumptions.riskPrimaryAssumption,
        sensitivityRiskAssumption: config.assumptions.riskSensitivityAssumption,
      },
    };
  }

  return { COMPLETE_RANKINGS, prelec, referenceParameters, isotonic, crossingIntervals, threshold, logisticFit, conditionPoints, curveResults, rankingDistributions, analyze, seeded };
});
