(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.DecisionBatchImport = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  // 核心统计只依赖两份结构化 CSV。JSONL/JSON 曾用于附加链路审计，
  // v1.4.0 起不再作为分析前置条件，避免大体积原始响应占用浏览器内存。
  const REQUIRED_TYPES = ["complete", "ranking"];
  const OPTIONAL_TYPES = ["raw", "summary"];
  const HEAVY_RESULT_FIELDS = new Set([
    "OriginalProviderResponseJSON", "FinalProviderResponseJSON", "ProviderResponseJSON", "RawProviderResponseJSON",
    "RequestPayloadJSON", "ResponsePayloadJSON", "ResponseRaw", "RawResponse", "ResponseBody",
    "Prompt", "PromptText", "SystemPrompt", "Messages",
    "Context", "Question", "Opt1", "Opt2", "Opt3",
  ]);
  const SOURCE_CONTENT_FIELDS = ["Source_Context", "Source_Question", "Source_Opt1", "Source_Opt2", "Source_Opt3"];

  function stableHash(value) {
    const text = String(value == null ? "" : value);
    let hash = 2166136261 >>> 0;
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 16777619) >>> 0;
    }
    return hash.toString(16).padStart(8, "0");
  }
  const RAW_AUDIT_FIELDS = new Set([
    "RunID", "RequestID", "RequestAttempt", "CallKind", "Provider", "Model", "ModelVersion", "ModelConfigID",
    "PromptVersion", "ItemID", "GroupID", "RepeatIndex", "PermutationID", "Status", "FirstStatus", "FinalStatus",
    "LatencyMs", "Timestamp", "SessionID", "ProviderRequestID", "SourceFile", "SourceRow", "ExtractionSource",
    "run_id", "request_id", "request_attempt", "call_kind", "provider", "model", "model_version", "model_config_id",
    "prompt_version", "item_id", "group_id", "repeat_index", "permutation_id", "status", "first_status", "final_status",
    "latency_ms", "timestamp", "session_id", "provider_request_id", "source_file", "source_row", "extraction_source",
  ]);

  function compactRow(type, row) {
    if (type === "raw") {
      const compact = {};
      Object.entries(row || {}).forEach(([key, value]) => {
        if (RAW_AUDIT_FIELDS.has(key)) compact[key] = value;
      });
      return compact;
    }
    if (type !== "complete" && type !== "ranking") return row;
    const compact = {};
    if (type === "complete") {
      compact.Source_ContentDigest = row.Source_ContentDigest || `BCD-${stableHash(SOURCE_CONTENT_FIELDS.map((field) => `${field}=${String(row[field] == null ? "" : row[field]).trim()}`).join("|"))}`;
    }
    Object.entries(row || {}).forEach(([key, value]) => {
      if (!HEAVY_RESULT_FIELDS.has(key) && !SOURCE_CONTENT_FIELDS.includes(key)) compact[key] = value;
    });
    return compact;
  }

  function compactRows(type, rows) {
    if (!Array.isArray(rows) || !rows.length) return [];
    return rows.map((row) => compactRow(type, row));
  }

  function omittedFields(type) {
    return type === "complete" || type === "ranking" ? Array.from(HEAVY_RESULT_FIELDS) : [];
  }

  function finiteNumber(value) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  function positiveNumber(...values) {
    for (const value of values) {
      const parsed = finiteNumber(value);
      if (parsed != null && parsed > 0) return parsed;
    }
    return null;
  }

  function unique(values) {
    return Array.from(new Set((values || []).map((value) => String(value == null ? "" : value).trim()).filter(Boolean)));
  }

  function summaryInfo(summary) {
    const data = summary && typeof summary === "object" && !Array.isArray(summary) ? summary : null;
    if (!data) return { recognized: false, kind: "unknown", label: "未识别摘要", completed: null, total: null, repetitions: null, repetitionsMax: null, runIds: [], modelConfigIds: [], providers: [], models: [], sourcePackageCount: 0 };
    const packages = Array.isArray(data.source_packages) ? data.source_packages : [];
    const counts = data.counts && typeof data.counts === "object" ? data.counts : {};
    const repeatIndex = data.repeat_index && typeof data.repeat_index === "object" ? data.repeat_index : {};
    const merged = data.summary_type === "merged_ai_test_runs" || packages.length > 0 || finiteNumber(counts.output_csv_rows) != null;
    const direct = !!(data.run_id || data.model_config_id || data.options || data.config);
    const runIds = unique([
      data.run_id,
      ...(Array.isArray(data.run_ids) ? data.run_ids : []),
      ...packages.flatMap((entry) => [
        ...(Array.isArray(entry && entry.run_ids) ? entry.run_ids : []),
        entry && entry.original_summary && entry.original_summary.run_id,
      ]),
    ]);
    const modelConfigIds = unique([
      data.model_config_id,
      data.modelConfigId,
      ...packages.flatMap((entry) => [
        ...(Array.isArray(entry && entry.model_config_ids) ? entry.model_config_ids : []),
        entry && entry.original_summary && entry.original_summary.model_config_id,
      ]),
    ]);
    const providers = unique([
      data.config && data.config.provider,
      ...packages.flatMap((entry) => [
        ...(Array.isArray(entry && entry.providers) ? entry.providers : []),
        entry && entry.original_summary && entry.original_summary.config && entry.original_summary.config.provider,
      ]),
    ]);
    const models = unique([
      data.config && data.config.model,
      ...packages.flatMap((entry) => [
        ...(Array.isArray(entry && entry.models) ? entry.models : []),
        entry && entry.original_summary && entry.original_summary.config && entry.original_summary.config.model,
      ]),
    ]);
    const repetitions = merged
      ? positiveNumber(repeatIndex.balanced_repeat_limit, repeatIndex.output_max_repeats, repeatIndex.output_min_repeats, repeatIndex.global_min_legal_repeats)
      : positiveNumber(data.options && data.options.repetitions);
    const repetitionsMax = merged ? positiveNumber(repeatIndex.output_max_repeats, repetitions) : repetitions;
    const completed = merged ? finiteNumber(counts.output_csv_rows) : finiteNumber(data.completed);
    const total = merged ? finiteNumber(counts.output_csv_rows) : finiteNumber(data.total);
    const sourcePackageCount = merged ? (positiveNumber(counts.source_package_count, packages.length) || 0) : (runIds.length || (direct ? 1 : 0));
    return {
      recognized: merged || direct,
      kind: merged ? "merged" : direct ? "direct" : "unknown",
      label: merged ? (data.mode_name || "合并运行摘要") : "单次运行摘要",
      summaryType: String(data.summary_type || "single_ai_test_run"),
      summaryVersion: String(data.summary_version || ""),
      mode: String(data.mode || ""),
      completed,
      total,
      repetitions,
      repetitionsMax,
      runIds,
      modelConfigIds,
      providers,
      models,
      sourcePackageCount,
      outputJsonlLines: finiteNumber(counts.output_jsonl_lines),
      validation: data.validation || null,
    };
  }

  function createBatch(index, id) {
    const batchIndex = Number.isFinite(Number(index)) && Number(index) > 0 ? Number(index) : 1;
    return {
      id: id || `batch-${batchIndex}`,
      name: `结果批次 ${batchIndex}`,
      completeRows: [],
      rankingRows: [],
      rawRecords: [],
      rawErrors: [],
      summary: null,
      sourceNames: { complete: "", ranking: "", raw: "", summary: "" },
    };
  }

  function hasType(batch, type) {
    if (!batch) return false;
    if (type === "complete") return Array.isArray(batch.completeRows) && batch.completeRows.length > 0;
    if (type === "ranking") return Array.isArray(batch.rankingRows) && batch.rankingRows.length > 0;
    if (type === "raw") return Array.isArray(batch.rawRecords) && batch.rawRecords.length > 0;
    if (type === "summary") return !!batch.summary;
    return false;
  }

  function batchProgress(batch) {
    return REQUIRED_TYPES.reduce((count, type) => count + (hasType(batch, type) ? 1 : 0), 0);
  }

  function optionalProgress(batch) {
    return OPTIONAL_TYPES.reduce((count, type) => count + (hasType(batch, type) ? 1 : 0), 0);
  }

  function batchReady(batch) {
    return batchProgress(batch) === REQUIRED_TYPES.length;
  }

  function detectedModel(batch) {
    if (!batch) return "";
    const summary = batch.summary || {};
    const config = summary.config || {};
    const first = (batch.completeRows && batch.completeRows[0]) || (batch.rankingRows && batch.rankingRows[0]) || {};
    return String(first.ModelConfigID || first.Model || summary.model_config_id || summary.modelConfigId || config.model || "").trim();
  }

  function cloneWithBatch(row, batch, sourceType) {
    const decorated = Object.create(row && typeof row === "object" ? row : null);
    decorated.ImportBatchID = batch.id;
    decorated.ImportBatchName = batch.name;
    decorated.ImportSourceType = sourceType;
    return decorated;
  }

  function mergeBatches(batches, bankFiles) {
    const active = (batches || []).filter(Boolean);
    const completeRows = [];
    const rankingRows = [];
    const rawRecords = [];
    const rawErrors = [];
    const batchSummaries = [];
    const importBatches = [];

    active.forEach((batch) => {
      const info = summaryInfo(batch.summary);
      (batch.completeRows || []).forEach((row) => completeRows.push(cloneWithBatch(row, batch, "complete")));
      (batch.rankingRows || []).forEach((row) => rankingRows.push(cloneWithBatch(row, batch, "ranking")));
      (batch.rawRecords || []).forEach((row) => rawRecords.push(cloneWithBatch(row, batch, "raw")));
      (batch.rawErrors || []).forEach((error) => rawErrors.push({ ...error, ImportBatchID: batch.id, ImportBatchName: batch.name }));
      if (batch.summary) batchSummaries.push({ batchId: batch.id, batchName: batch.name, summary: batch.summary, info });
      importBatches.push({
        batchId: batch.id,
        batchName: batch.name,
        modelConfig: detectedModel(batch),
        ready: batchReady(batch),
        progress: batchProgress(batch),
        optionalProgress: optionalProgress(batch),
        summaryInfo: info,
        sourceNames: { ...batch.sourceNames },
        counts: {
          complete: (batch.completeRows || []).length,
          ranking: (batch.rankingRows || []).length,
          raw: (batch.rawRecords || []).length,
          rawErrors: (batch.rawErrors || []).length,
        },
      });
    });

    const completedValues = batchSummaries.map((entry) => entry.info.completed).filter(Number.isFinite);
    const totalValues = batchSummaries.map((entry) => entry.info.total).filter(Number.isFinite);
    const repetitionValues = batchSummaries.map((entry) => entry.info.repetitions).filter((value) => Number.isFinite(value) && value > 0);
    const allRunIds = unique(batchSummaries.flatMap((entry) => entry.info.runIds));
    const aggregateSummary = batchSummaries.length ? {
      run_id: allRunIds.length === 1 ? allRunIds[0] : allRunIds.length ? "MULTI_RUN" : active.length === 1 ? "" : "MULTI_BATCH",
      run_ids: allRunIds,
      model_config_id: active.length === 1 ? detectedModel(active[0]) : "MULTI_MODEL",
      completed: completedValues.length ? completedValues.reduce((sum, value) => sum + value, 0) : completeRows.length,
      total: totalValues.length ? totalValues.reduce((sum, value) => sum + value, 0) : completeRows.length,
      options: { repetitions: repetitionValues.length ? Math.min(...repetitionValues) : 1 },
      import_batch_count: active.length,
    } : null;

    return {
      completeRows,
      rankingRows,
      rawRecords,
      rawErrors,
      summary: aggregateSummary,
      batchSummaries,
      importBatches,
      bankFiles: bankFiles || [],
    };
  }

  return {
    REQUIRED_TYPES,
    OPTIONAL_TYPES,
    createBatch,
    hasType,
    batchProgress,
    optionalProgress,
    batchReady,
    summaryInfo,
    detectedModel,
    compactRow,
    compactRows,
    omittedFields,
    mergeBatches,
  };
});
