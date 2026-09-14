(function () {
  "use strict";

  const A = window.DecisionAnalysis;
  const I = window.DecisionInterpretation;
  const C = window.DecisionCharts;
  const CSV = window.DecisionCSV;
  const B = window.DecisionBatchImport;
  const X = window.DecisionFullExport;
  const D = window.DecisionDomainAnalysis;
  const H = window.DecisionHumanReference;
  const R = window.DecisionRiskReference;
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

  const state = {
    batches: [],
    batchCounter: 0,
    bankFiles: [],
    bankSourceNames: [],
    analysis: null,
    cardPage: 1,
    cssText: "",
    exportSelection: null,
    humanRows: [],
    humanManifest: null,
    cniHumanConfig: null,
    riskReferenceConfig: null,
    referenceStatus: "LOADING",
    referenceError: "",
    referenceReady: null,
    domainSelectionByBank: {},
    domainCompareMode: "VIEW_SELECTED",
    domainSyncWithinView: true,
  };

  const STATUS_COLORS = {
    VALID: "#188f82",
    REPAIRED_VALID: "#7357d8",
    REFUSAL: "#b64b62",
    TIE: "#b67b2e",
    DUPLICATE_OPTION: "#8a647a",
    MISSING_OPTION: "#d28a39",
    PARSE_ERROR: "#a45669",
    CONFLICT: "#dc6b50",
    TECH_ERROR: "#716b76",
    UNKNOWN: "#938c96",
  };

  function escape(value) { return C.escapeHTML(value); }
  function pct(value, digits = 1) { return Number.isFinite(value) ? `${(value * 100).toFixed(digits)}%` : "NA"; }
  function num(value, digits = 2) { return Number.isFinite(value) ? Number(value).toFixed(digits).replace(/\.00$/, "").replace(/(\.\d)0$/, "$1") : "NA"; }
  function statusClass(status) { return status === "pass" || status === "good" ? "good" : status === "fail" || status === "bad" ? "bad" : status === "info" ? "info" : "warn"; }
  function statusPill(label, kind = "info") { return `<span class="status-pill ${kind}">${escape(label)}</span>`; }

  function toast(message) {
    const element = $("#toast");
    element.textContent = message;
    element.classList.add("show");
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => element.classList.remove("show"), 2800);
  }

  function metricCard(label, value, sub, kind = "info", tip = "") {
    const help = tip || sub;
    return `<article class="metric-card ${kind}"><div class="metric-card-header"><span class="metric-label">${escape(label)}</span><span class="info-tip static" tabindex="0" data-tip="${escape(help)}">i</span></div><b class="metric-value">${escape(value)}</b><small class="metric-sub">${escape(sub)}</small></article>`;
  }

  function setView(id) {
    $$(".view").forEach((view) => view.classList.toggle("is-active", view.id === id));
    $$(".nav-item").forEach((item) => item.classList.toggle("is-active", item.dataset.target === id));
    const view = $(`#${id}`);
    $("#sectionTitle").textContent = view.dataset.title;
    $("#sectionEyebrow").textContent = view.dataset.eyebrow;
    $("#sectionInfo").dataset.tip = view.dataset.description || view.dataset.eyebrow;
    $("#globalFilter").classList.toggle("is-hidden", !state.analysis || id === "import" || id === "export");
    const domainCapable = ["preference", "quality", "human-reference"].includes(id);
    $("#domainFilter").classList.toggle("is-hidden", !state.analysis || !domainCapable);
    document.body.classList.remove("nav-open");
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  async function readBlob(blob, name) {
    const extension = name.toLowerCase().split(".").pop();
    // JSONL/JSON不参与核心统计。先按扩展名短路，避免在用户选择整个
    // 结果文件夹时把几十或数百MB的原始响应读进浏览器内存。
    if (extension === "jsonl" || extension === "ndjson" || extension === "json") {
      return { type: "optional_ignored", reason: "v1.7.0核心AI分析仅需两份CSV" };
    }
    if (extension === "csv") {
      const parsed = await CSV.parseBlob(blob, { omitForType: (type) => B.omittedFields(type), intern: true });
      return { type: parsed.type, rows: parsed.rows, encoding: parsed.encoding };
    }
    return { type: "unknown" };
  }

  function findBatch(batchId) {
    return state.batches.find((batch) => batch.id === batchId) || null;
  }

  function assignParsed(batchId, name, parsed) {
    const batch = findBatch(batchId);
    if (parsed.type === "complete" && batch) {
      batch.completeRows = B.compactRows("complete", parsed.rows);
      batch.sourceNames.complete = name;
    } else if (parsed.type === "ranking" && batch) {
      batch.rankingRows = B.compactRows("ranking", parsed.rows);
      batch.sourceNames.ranking = name;
    } else if (parsed.type === "bank") {
      const bankId = A.inferBank(name, parsed.rows[0]);
      const existing = state.bankFiles.findIndex((file) => file.bankId === bankId);
      const entry = { name, bankId, rows: parsed.rows };
      if (existing >= 0) state.bankFiles.splice(existing, 1, entry);
      else state.bankFiles.push(entry);
      state.bankSourceNames = state.bankFiles.map((file) => file.name);
    } else {
      throw new Error(`${name} 的字段结构未能识别`);
    }
  }

  function invalidateAnalysis() {
    state.analysis = null;
    state.exportSelection = null;
    $("#exportMenuBtn").disabled = true;
    $("#globalFilter").classList.add("is-hidden");
    $("#domainFilter").classList.add("is-hidden");
    $("#runChip").classList.remove("is-ready");
    $("#runChip").innerHTML = "<i></i>数据已变更，等待分析";
    renderExportCenter();
  }

  async function ingestFiles(batchId, files) {
    const batch = findBatch(batchId);
    if (!batch || !files.length) return;
    const relative = files.find((file) => file.webkitRelativePath && file.webkitRelativePath.includes("/"));
    if (relative && /^结果批次 \d+$/.test(batch.name)) batch.name = relative.webkitRelativePath.split("/")[0] || batch.name;
    let loaded = 0;
    let ignored = 0;
    const errors = [];
    const seenTypes = new Map();
    for (const file of files) {
      try {
        const parsed = await readBlob(file, file.name);
        if (parsed.type === "optional_ignored") { ignored += 1; continue; }
        if (B.REQUIRED_TYPES.includes(parsed.type) && seenTypes.has(parsed.type)) errors.push(`${file.name}：与 ${seenTypes.get(parsed.type)} 属于同一文件类型，已采用后读入文件`);
        if (B.REQUIRED_TYPES.includes(parsed.type)) seenTypes.set(parsed.type, file.name);
        assignParsed(batchId, file.name, parsed);
        loaded += 1;
      } catch (error) {
        errors.push(`${file.name}：${error.message}`);
      }
    }
    invalidateAnalysis();
    renderBatchList();
    updateImportState();
    const ignoredText = ignored ? `；跳过 ${ignored} 个非必需JSON/JSONL文件` : "";
    $("#uploadStatus").textContent = errors.length ? `${batch.name}：识别 ${loaded} 个文件${ignoredText}；${errors.join("；")}` : `${batch.name}：已识别 ${loaded} 个CSV文件${ignoredText}。`;
    if (loaded) toast(`已载入 ${loaded} 个文件`);
  }

  async function fetchFile(path) {
    const requestPath = /%[0-9a-f]{2}/i.test(path) ? path : encodeURI(path);
    const response = await fetch(requestPath, { cache: "no-store" });
    if (!response.ok) throw new Error(`无法读取 ${path}`);
    const blob = await response.blob();
    const cleanPath = path.split("?")[0];
    const name = decodeURIComponent(cleanPath.split("/").pop());
    return { name, blob };
  }

  async function loadProjectFromQuery() {
    const projectId = new URLSearchParams(window.location.search).get("project_id");
    if (!projectId) return false;
    $("#backToPublic").href = `/?project_id=${encodeURIComponent(projectId)}#report`;
    try {
      const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/advanced-files`, { cache: "no-store" });
      if (!response.ok) throw new Error("无法读取项目结果清单");
      const payload = await response.json();
      if (!payload.runs || !payload.runs.length) throw new Error("项目还没有可供分析的完整结果");
      state.batches = [];
      for (const run of payload.runs) {
        state.batchCounter += 1;
        const batch = B.createBatch(state.batchCounter, `batch-${state.batchCounter}`);
        batch.name = run.label || `模型批次 ${state.batchCounter}`;
        state.batches.push(batch);
        const [ranking, complete] = await Promise.all([fetchFile(run.ranking_url), fetchFile(run.complete_url)]);
        assignParsed(batch.id, ranking.name, await readBlob(ranking.blob, ranking.name));
        assignParsed(batch.id, complete.name, await readBlob(complete.blob, complete.name));
      }
      invalidateAnalysis();
      renderBatchList();
      updateImportState();
      $("#uploadStatus").textContent = `已从“${payload.project_name || projectId}”自动载入 ${payload.runs.length} 个模型结果，正在分析…`;
      await runAnalysis();
      return true;
    } catch (error) {
      $("#uploadStatus").textContent = `自动载入项目失败：${error.message}。仍可在下方手动选择结果文件。`;
      toast("项目结果自动载入失败");
      return false;
    }
  }

  async function loadBundledBanks() {
    try {
      const manifest = await (await fetch("sample_manifest.json", { cache: "no-store" })).json();
      for (const path of manifest.banks) {
        const file = await fetchFile(path);
        const parsed = await readBlob(file.blob, file.name);
        assignParsed(null, file.name, parsed);
      }
      updateImportState();
    } catch (error) {
      $("#uploadStatus").textContent = `内置题库未自动载入：${error.message}。可手动拖入题库 CSV。`;
    }
  }

  async function loadBundledReferences() {
    const loadJson = async (path, label) => {
      const response = await fetch(path, { cache: "no-store" });
      if (!response.ok) throw new Error(`无法读取${label}`);
      return response.json();
    };
    const [manifestResult, cniResult, riskResult] = await Promise.allSettled([
      loadJson("human_reference/human_reference_manifest.json", "Human manifest"),
      loadJson("human_reference/cni_human_reference_v1.json", "CNI Human config"),
      loadJson("human_reference/risk_human_reference_v1.json", "Risk Human Reference config"),
    ]);
    const errors = [];
    state.humanManifest = manifestResult.status === "fulfilled" ? manifestResult.value : null;
    state.cniHumanConfig = cniResult.status === "fulfilled" ? cniResult.value : null;
    state.riskReferenceConfig = riskResult.status === "fulfilled" ? riskResult.value : null;
    [manifestResult, cniResult, riskResult].forEach((result) => { if (result.status === "rejected") errors.push(result.reason.message); });
    const humanRows = [];
    if (state.humanManifest) {
      for (const file of state.humanManifest.files || []) {
        try {
          const response = await fetch(encodeURI(file.path), { cache: "no-store" });
          if (!response.ok) throw new Error(`无法读取 ${file.path}`);
          const parsed = await CSV.parseBlob(await response.blob(), { intern: true });
          humanRows.push(...parsed.rows);
        } catch (error) {
          errors.push(error.message);
          console.error(error);
        }
      }
    }
    state.humanRows = humanRows;
    const hasReference = Boolean(state.riskReferenceConfig || state.cniHumanConfig || humanRows.length);
    state.referenceStatus = !hasReference ? "NOT_BUNDLED" : errors.length ? "PARTIAL_READY" : "READY";
    state.referenceError = !hasReference
      ? "公开版未附带参与者衍生参照数据；相关模块保持不可用。"
      : errors.join("；");
  }

  async function loadSample() {
    const button = $("#loadSample");
    button.disabled = true;
    button.textContent = "正在载入…";
    try {
      const manifest = await (await fetch("sample_manifest.json", { cache: "no-store" })).json();
      state.batches = [B.createBatch(++state.batchCounter, `batch-${state.batchCounter}`)];
      state.batches[0].name = "随附示例批次";
      for (const path of manifest.results) {
        const file = await fetchFile(path);
        const parsed = await readBlob(file.blob, file.name);
        assignParsed(state.batches[0].id, file.name, parsed);
      }
      for (const path of manifest.banks) {
        const file = await fetchFile(path);
        const parsed = await readBlob(file.blob, file.name);
        assignParsed(null, file.name, parsed);
      }
      invalidateAnalysis();
      renderBatchList();
      updateImportState();
      $("#uploadStatus").textContent = "四类合成题库样例已载入。可再导入运行结果并开始分析。";
      toast("随附合成样例已载入");
    } catch (error) {
      $("#uploadStatus").textContent = `载入失败：${error.message}`;
    } finally {
      button.disabled = false;
      button.textContent = "载入随附示例";
    }
  }

  function addBatch(initial = false) {
    state.batchCounter += 1;
    state.batches.push(B.createBatch(state.batchCounter, `batch-${state.batchCounter}`));
    if (initial !== true) invalidateAnalysis();
    renderBatchList();
    updateImportState();
  }

  function removeBatch(batchId) {
    if (state.batches.length <= 1) return;
    const batch = findBatch(batchId);
    if (!batch) return;
    if (B.batchProgress(batch) && !window.confirm(`确认移除“${batch.name}”及其已载入文件？`)) return;
    state.batches = state.batches.filter((item) => item.id !== batchId);
    invalidateAnalysis();
    renderBatchList();
    updateImportState();
  }

  function fileSlot(batch, type, label, tip) {
    const loaded = B.hasType(batch, type);
    const counts = type === "complete" ? `${batch.completeRows.length} 条记录`
      : type === "ranking" ? `${batch.rankingRows.length} 条记录`
        : "不支持的文件类型";
    return `<div class="batch-file-slot${loaded ? " is-loaded" : ""}"><i></i><span><b>${escape(label)} <span class="info-tip static" tabindex="0" data-tip="${escape(tip)}">i</span></b><small title="${escape(batch.sourceNames[type] || "")}">${escape(batch.sourceNames[type] || "尚未选择文件")}</small><em>${loaded ? escape(counts) : "待导入"}</em></span></div>`;
  }

  function renderBatchList() {
    $("#batchList").innerHTML = state.batches.map((batch, index) => {
      const model = B.detectedModel(batch);
      const progress = B.batchProgress(batch);
      const ready = B.batchReady(batch);
      return `<section class="result-batch${ready ? " is-ready" : ""}" data-batch-id="${escape(batch.id)}">
        <header class="batch-header"><span class="batch-index">${String(index + 1).padStart(2, "0")}</span><input class="batch-name-input" data-batch-name value="${escape(batch.name)}" aria-label="批次名称"><span class="batch-model${model ? " is-detected" : ""}" title="${escape(model || "尚未识别模型配置")}">${escape(model || "模型配置待识别")}</span><button class="remove-batch" data-remove-batch type="button" aria-label="移除此批次" title="${state.batches.length > 1 ? "移除此批次" : "至少保留一个批次"}" ${state.batches.length > 1 ? "" : "disabled"}>×</button></header>
        <div class="batch-body">
          <div class="batch-drop-zone" data-drop-batch="${escape(batch.id)}"><span class="upload-icon" aria-hidden="true">＋</span><strong>导入本批次两份结果CSV</strong><div class="batch-picker-actions"><label class="folder-pick">选择整个结果文件夹<input data-folder-input type="file" webkitdirectory directory multiple hidden></label><span>或</span><label class="folder-pick">选择两个CSV<input data-batch-input type="file" multiple accept=".csv,text/csv" hidden></label></div><small>需要排序结果.csv与完整运行记录.csv。若文件夹中含JSONL/JSON，平台会直接跳过且不读取其内容。</small></div>
          <div class="batch-file-slots two-required">${fileSlot(batch, "complete", "完整运行记录.csv", "主要分析数据源与唯一模型身份来源；提供状态、重复、逻辑排序、题目键和ModelConfigID。大体积响应正文及重复题干列在解析时跳过。")}${fileSlot(batch, "ranking", "排序结果.csv", "作为独立的排序结果核验表；按批次＋题目/行复合键与完整运行记录对齐，不要求模型版本字段。")}</div>
        </div>
        <footer class="batch-footer"><span>已识别 ${progress}/2 份必需CSV</span><span class="batch-ready-label">${ready ? "批次校验就绪" : `还需 ${2 - progress} 份CSV`}</span></footer>
      </section>`;
    }).join("");
  }

  function updateImportState() {
    const ready = state.batches.filter(B.batchReady).length;
    const total = state.batches.length;
    const allReady = total > 0 && ready === total;
    const bankRows = state.bankFiles.reduce((sum, file) => sum + file.rows.length, 0);
    $("#bankStatus").textContent = state.bankFiles.length ? `${state.bankFiles.length} 份内置题库 · ${bankRows} 条；分析时合并运行记录Source_*目录` : "题库元数据尚未载入";
    $("#analyzeBtn").disabled = !allReady;
    if (!allReady) $("#uploadStatus").textContent = `${ready}/${total} 个批次已就绪；每个批次需导入排序结果.csv与完整运行记录.csv。`;
  }

  async function runAnalysis() {
    try {
      if (state.referenceReady) await state.referenceReady;
      const activeView = $(".view.is-active") ? $(".view.is-active").id : "import";
      const inputs = B.mergeBatches(state.batches, state.bankFiles);
      if (!inputs.importBatches.length || inputs.importBatches.some((batch) => !batch.ready)) throw new Error("每个结果批次必须导入排序结果.csv与完整运行记录.csv");
      state.analysis = null;
      state.analysis = A.analyze(inputs, { includeRepaired: $("#includeRepaired").checked });
      state.analysis.humanReference = H && typeof H.analyze === "function"
        ? H.analyze(state.analysis, state.humanRows, {
          manifest: state.humanManifest,
          cniConfig: state.cniHumanConfig,
          scenarioIterations: 5000,
          scenarioSeed: 20260827,
        })
        : { status: "HUMAN_REFERENCE_MODULE_UNAVAILABLE", groupGaps: [], gapSummaries: [], domainGapSummaries: [] };
      state.analysis.riskReference = R && typeof R.analyze === "function"
        ? R.analyze(state.analysis, state.riskReferenceConfig)
        : { status: "RISK_REFERENCE_MODULE_UNAVAILABLE", referenceParameters: [], curvePoints: [], thresholds: [], binaryRobustness: [] };
      state.exportSelection = null;
      state.cardPage = 1;
      $("#runChip").classList.add("is-ready");
      $("#runChip").innerHTML = `<i></i>${escape(inputs.importBatches.length)} 批 · ${escape(state.analysis.models.length)} 个配置 · ${escape(state.analysis.records.length)} 条记录`;
      $("#exportMenuBtn").disabled = false;
      populateGlobalFilters();
      populateLocalControls();
      populateDomainControls();
      renderAll();
      setView(activeView === "import" ? "overview" : activeView);
      toast("分析完成：旧版P/E/D、Domain、Human、风险参照、d/g与ICC均已更新");
    } catch (error) {
      console.error(error);
      $("#uploadStatus").textContent = `分析失败：${error.message}`;
      toast("分析失败，请检查文件字段");
    }
  }

  function populateSelect(element, options, allLabel, selectedValue) {
    const html = allLabel != null ? `<option value="ALL">${escape(allLabel)}</option>` : "";
    element.innerHTML = html + options.map((option) => `<option value="${escape(option.value)}">${escape(option.label)}</option>`).join("");
    if (selectedValue && options.some((option) => option.value === selectedValue)) element.value = selectedValue;
  }

  function populateGlobalFilters() {
    const analysis = state.analysis;
    const previous = { model: $("#modelFilter").value, bank: $("#bankFilter").value, category: $("#categoryFilter").value };
    populateSelect($("#modelFilter"), analysis.models.map((model) => ({ value: model, label: model })), "全部配置", previous.model);
    const bankIds = Object.keys(analysis.banks.catalog).sort((a, b) => analysis.bankInfo[a].order - analysis.bankInfo[b].order);
    populateSelect($("#bankFilter"), bankIds.map((bankId) => ({ value: bankId, label: analysis.bankInfo[bankId].label })), "全部子测验", previous.bank);
    updateCategoryFilter(previous.category);
  }

  function updateCategoryFilter(selectedValue) {
    const bank = $("#bankFilter").value;
    const options = state.analysis.registry.coverage
      .filter((category, index, rows) => rows.findIndex((item) => item.categoryKey === category.categoryKey) === index)
      .filter((category) => bank === "ALL" || category.bankId === bank)
      .map((category) => ({ value: category.categoryKey, label: `${category.bankLabel} / ${category.categoryId} ${category.category}` }));
    populateSelect($("#categoryFilter"), options, "全部分类", selectedValue);
  }

  function populateLocalControls() {
    const analysis = state.analysis;
    const bankIds = Object.keys(analysis.banks.catalog).sort((a, b) => analysis.bankInfo[a].order - analysis.bankInfo[b].order);
    const bankOptions = bankIds.map((bankId) => ({ value: bankId, label: analysis.bankInfo[bankId].label }));
    const preferred = analysis.bankIds[0] || bankIds[0] || "ALL";
    populateSelect($("#profileBank"), bankOptions, null, $("#profileBank").value || preferred);
    populateSelect($("#effectBank"), bankOptions, null, $("#effectBank").value || preferred);
    updateEffectCategories();
    populateSelect($("#effectModel"), analysis.models.map((model) => ({ value: model, label: model })), "全部配置", $("#effectModel").value);
    const factorialOptions = analysis.factorial.analyses
      .filter((row, index, rows) => rows.findIndex((item) => item.categoryKey === row.categoryKey) === index)
      .map((row) => ({ value: row.categoryKey, label: `${row.bankLabel} / ${row.categoryId} ${row.category}` }));
    populateSelect($("#factorialCategory"), factorialOptions, null, $("#factorialCategory").value || (factorialOptions[0] && factorialOptions[0].value));
    populateSelect($("#factorialModel"), analysis.models.map((model) => ({ value: model, label: model })), null, $("#factorialModel").value || analysis.models[0]);
    updateFactorialOutcomes();
  }

  function allDomainRows(bankId = $("#bankFilter").value) {
    if (!state.analysis || !state.analysis.domain) return [];
    return (state.analysis.domain.catalog || []).filter((row) => bankId === "ALL" || row.bankId === bankId);
  }

  function ensureDomainSelection(bankId) {
    const keys = allDomainRows(bankId).map((row) => row.domainKey);
    if (!Object.prototype.hasOwnProperty.call(state.domainSelectionByBank, bankId)) state.domainSelectionByBank[bankId] = keys.slice();
    else state.domainSelectionByBank[bankId] = state.domainSelectionByBank[bankId].filter((key) => keys.includes(key));
    return state.domainSelectionByBank[bankId];
  }

  function selectedDomainKeys() {
    const bankId = $("#bankFilter").value;
    if (bankId !== "ALL") return new Set(ensureDomainSelection(bankId));
    const selected = [];
    Object.keys(state.analysis.banks.catalog || {}).forEach((id) => selected.push(...ensureDomainSelection(id)));
    return new Set(selected);
  }

  function populateDomainControls() {
    if (!state.analysis || !state.analysis.domain) return;
    const bankId = $("#bankFilter").value;
    const query = $("#domainSearch").value.trim().toLocaleLowerCase("zh-CN");
    const rows = allDomainRows(bankId);
    const selected = selectedDomainKeys();
    const visible = rows.filter((row) => !query || `${row.bankLabel} ${row.domain}`.toLocaleLowerCase("zh-CN").includes(query));
    $("#domainMulti").innerHTML = visible.map((row) => `<option value="${escape(row.domainKey)}"${selected.has(row.domainKey) ? " selected" : ""}>${escape(bankId === "ALL" ? `${row.bankLabel} · ${row.domain}` : row.domain)}</option>`).join("");
    $("#domainCompareMode").value = state.domainCompareMode;
    if (bankId === "ALL" && state.domainCompareMode === "COMPARE_SELECTED") {
      state.domainCompareMode = "VIEW_SELECTED";
      $("#domainCompareMode").value = "VIEW_SELECTED";
    }
    $("#domainCompareMode").querySelector('option[value="COMPARE_SELECTED"]').disabled = bankId === "ALL";
    const selectedCount = rows.filter((row) => selected.has(row.domainKey)).length;
    $("#domainScopeNote").textContent = bankId === "ALL"
      ? `Bank=ALL：当前显示${rows.length}个Bank隔离Domain的覆盖概览；正式横向比较已禁用，不会自动合并近义标签。`
      : `${state.analysis.bankInfo[bankId].label}：已选择 ${selectedCount}/${rows.length} 个Domain；${state.domainCompareMode === "COMPARE_SELECTED" ? "按同一Category与Contrast分别横向展示" : "只限制Domain适用表格与图形的展示范围"}。正式D始终保持完整Category口径。`;
    populateRiskCurveSelector();
  }

  function updateDomainSelectionFromControl() {
    const bankId = $("#bankFilter").value;
    const visibleKeys = Array.from($("#domainMulti").options).map((option) => option.value);
    const selectedVisible = Array.from($("#domainMulti").selectedOptions).map((option) => option.value);
    if (bankId !== "ALL") {
      const previous = ensureDomainSelection(bankId);
      state.domainSelectionByBank[bankId] = previous.filter((key) => !visibleKeys.includes(key)).concat(selectedVisible);
    } else {
      Object.keys(state.analysis.banks.catalog || {}).forEach((id) => {
        const previous = ensureDomainSelection(id);
        const bankVisible = visibleKeys.filter((key) => key.startsWith(`${id}::`));
        const bankSelected = selectedVisible.filter((key) => key.startsWith(`${id}::`));
        state.domainSelectionByBank[id] = previous.filter((key) => !bankVisible.includes(key)).concat(bankSelected);
      });
    }
  }

  function domainSelected(row) {
    if (!row || !row.domainKey) return false;
    return selectedDomainKeys().has(row.domainKey);
  }

  function hasActiveDomainSubset() {
    if (!state.analysis) return false;
    const bankId = $("#bankFilter").value;
    const banks = bankId === "ALL" ? Object.keys(state.analysis.banks.catalog || {}) : [bankId];
    return banks.some((id) => ensureDomainSelection(id).length !== allDomainRows(id).length);
  }

  function localDomainMatch(row) {
    return !hasActiveDomainSubset() || (!!row.domainKey && domainSelected(row));
  }

  function domainGlobalMatch(row) {
    const model = $("#modelFilter").value;
    const bank = $("#bankFilter").value;
    const category = $("#categoryFilter").value;
    return (model === "ALL" || row.modelConfig === model || row.analysisModelKey === model)
      && (bank === "ALL" || row.bankId === bank)
      && (category === "ALL" || row.categoryKey === category);
  }

  function globalFilter(record) {
    const model = $("#modelFilter").value;
    const bank = $("#bankFilter").value;
    const category = $("#categoryFilter").value;
    return (model === "ALL" || record.modelConfig === model)
      && (bank === "ALL" || record.bankId === bank)
      && (category === "ALL" || record.categoryKey === category);
  }

  function filteredRecords() { return state.analysis.records.filter(globalFilter); }
  function matchesSummary(row) { return globalFilter(row); }

  function qualityOf(records) {
    const technical = records.filter((row) => row.technical).length;
    const responses = records.filter((row) => !row.technical);
    const finalValid = responses.filter((row) => row.responseValid).length;
    const firstValid = responses.filter((row) => row.firstStatus === "VALID").length;
    const repaired = responses.filter((row) => row.repaired).length;
    const retry = responses.filter((row) => row.retryUsed).length;
    const firstStatuses = {};
    const finalStatuses = {};
    records.forEach((row) => {
      firstStatuses[row.firstStatus] = (firstStatuses[row.firstStatus] || 0) + 1;
      finalStatuses[row.finalStatus] = (finalStatuses[row.finalStatus] || 0) + 1;
    });
    return {
      total: records.length,
      responseDenominator: responses.length,
      technical,
      firstValid,
      repaired,
      finalValid,
      invalid: responses.length - finalValid,
      retry,
      firstValidRate: responses.length ? firstValid / responses.length : null,
      finalValidRate: responses.length ? finalValid / responses.length : null,
      repairRate: responses.length ? repaired / responses.length : null,
      retryRate: responses.length ? retry / responses.length : null,
      technicalRate: records.length ? technical / records.length : null,
      firstStatuses,
      finalStatuses,
    };
  }

  function renderAll() {
    if (!state.analysis) return;
    renderOverview();
    renderCoverage();
    renderParameterTables();
    renderQuality();
    renderProfile();
    renderEffects();
    renderFactorial();
    renderNonDirectional();
    renderInterpretation();
    renderReliability();
    renderCards();
    renderAudit();
    renderHumanReference();
    renderExportCenter();
  }

  function renderOverview() {
    const analysis = state.analysis;
    const records = filteredRecords();
    const quality = qualityOf(records);
    const models = A.unique(records.map((row) => row.modelConfig));
    const banks = A.unique(records.map((row) => row.bankId));
    const batchIds = A.unique(records.map((row) => row.batchId));
    const runIds = A.unique(records.map((row) => row.runId));
    const repeatValues = batchIds.map((batchId) => analysis.plannedRepeatsByBatch[batchId]).filter(Number.isFinite);
    const repeatMin = repeatValues.length ? Math.min(...repeatValues) : analysis.plannedRepeats;
    const repeatMax = repeatValues.length ? Math.max(...repeatValues) : analysis.plannedRepeatsMax;
    const repeatLabel = repeatMin === repeatMax ? `${repeatMin} 次` : `${repeatMin}–${repeatMax} 次`;
    $("#overviewMetrics").innerHTML = [
      metricCard("结果批次", String(batchIds.length), "独立导入文件夹", batchIds.length ? "info" : "bad", "每个批次只需排序结果.csv与完整运行记录.csv；批次标识贯穿明细、审计与导出。"),
      metricCard("AnalysisModelKey", String(models.length), `${A.unique(records.map((row) => row.rawModelConfigId)).length} 个Raw ModelConfigID`, models.length >= 4 ? "good" : "info", "MODEL_IDENTITY_V2只在候选值唯一时补全缺失配置；多个候选值一律标记歧义并阻断。ApiMode仅作传输审计；明确不同的模型、采样、Prompt或Parser配置严格分开。"),
      metricCard("运行记录", String(records.length), `${runIds.length} 个 RunID`, records.length ? "info" : "bad", "当前全局筛选下进入分析源的记录总数。"),
      metricCard("修复后有效率", pct(quality.finalValidRate), `${quality.finalValid}/${quality.responseDenominator}`, quality.finalValidRate >= 0.98 ? "good" : "warn", "(VALID + REPAIRED_VALID) / 非技术响应；TECH_ERROR 不进入分母。"),
      metricCard("覆盖子测验", String(banks.length), banks.map((id) => analysis.bankInfo[id].label).join("、") || "无", banks.length >= 4 ? "good" : "info", "各题库独立报告，不合成未经验证的总分。"),
      metricCard("计划重复", repeatLabel, "分析配置固定值", repeatMin === 5 ? "good" : "info", "默认PlannedRepeats=5；不会从RunID、导入批次或当前最大RepeatIndex推断，也不会跨批次相加。"),
    ].join("");

    const analysisRecords = records.filter((row) => analysis.options.includeRepaired || !row.repaired);
    const pAttempts = analysisRecords.filter((row) => row.scoreFamily === "DIRECTIONAL_RANK");
    const pRows = pAttempts.filter((row) => Number.isFinite(row.preference));
    const pbarRows = analysis.effects.conditionMeans.filter(matchesSummary);
    const eRows = analysis.effects.groupEffects.filter(matchesSummary);
    const dRows = analysis.effects.summaries.filter(matchesSummary);
    $("#parameterCounts").innerHTML = [
      { symbol: "P", label: "单次偏好分", detail: `${pRows.length}/${pAttempts.length} 条可计算`, value: pRows.length, tip: "P=[rank(L−)−rank(L+)]/(K−1)；只对有效 DIRECTIONAL_RANK 回答计算。" },
      { symbol: "P̄", label: "条件内均值", detail: `${pbarRows.filter((row) => Number.isFinite(row.mean)).length}/${pbarRows.length} 个条件可计算`, value: pbarRows.filter((row) => Number.isFinite(row.mean)).length, tip: "先算每个ItemID的P_Mean，再在条件内对ItemID等权汇总。" },
      { symbol: "E", label: "题组条件效应", detail: `${eRows.filter((row) => row.valid).length}/${eRows.length} 个预登记题组对比可计算`, value: eRows.filter((row) => row.valid).length, tip: "E=ΣwP̄/2；必要ItemID严格完成5次且权重满足零和约束。" },
      { symbol: "Ē", label: "有效题组平均E", detail: `${dRows.filter((row) => Number.isFinite(row.meanE)).length}/${dRows.length} 个分类对比有描述均值`, value: dRows.filter((row) => Number.isFinite(row.meanE)).length, tip: "Ē=ΣE/Gvalid；覆盖不足时仍可描述，但不能替代正式D。" },
      { symbol: "D", label: "分类汇总效应", detail: `${dRows.filter((row) => row.eligible).length}/${dRows.length} 个分类对比通过覆盖门槛`, value: dRows.filter((row) => row.eligible).length, tip: "D=ΣaE/Σa；当前题组等权，同一 CategoryID×ContrastID 覆盖≥80%才输出。" },
    ].map((row) => `<article class="parameter-item"><span class="parameter-symbol">${row.symbol}</span><span><b>${escape(row.label)} <span class="info-tip static" tabindex="0" data-tip="${escape(row.tip)}">i</span></b><small>${escape(row.detail)}</small></span><em>${row.value}</em></article>`).join("");

    const profileRows = analysis.profiles.profiles.filter(matchesSummary);
    const categoryBars = profileRows
      .filter((row) => Number.isFinite(row.mean))
      .sort((a, b) => (analysis.bankInfo[a.bankId].order - analysis.bankInfo[b.bankId].order) || a.categoryId.localeCompare(b.categoryId))
      .map((row) => ({ label: `${models.length > 1 ? `${row.modelConfig} · ` : ""}${row.bankLabel} · ${row.category}`, value: row.mean, color: analysis.bankInfo[row.bankId].color }));
    C.horizontalBars($("#overviewBars"), categoryBars, { min: -1, max: 1, left: 270, rowHeight: 34, empty: "当前筛选没有可比的 DIRECTIONAL_RANK 分类坐标" });

    $("#readinessList").innerHTML = analysis.readiness.map((item) => {
      const kind = item.ready ? (item.score >= 0.8 ? "good" : "warn") : "bad";
      return `<div class="readiness-item ${kind}"><header><span>${escape(item.label)} <span class="info-tip static" tabindex="0" data-tip="${escape(item.formula)}">i</span></span><em>${item.ready ? (item.score >= 0.8 ? "就绪" : "部分就绪") : "证据不足"}</em></header><div class="track"><i style="width:${Math.round(A.clamp(item.score, 0, 1) * 100)}%"></i></div><p>${escape(item.detail)}</p></div>`;
    }).join("");

    const invalidTop = Object.entries(quality.firstStatuses).filter(([status]) => status !== "VALID").sort((a, b) => b[1] - a[1]);
    const blocked = analysis.cards.filter((card) => card.status === "BLOCKED").length;
    const paragraphs = [];
    paragraphs.push(`数据：${batchIds.length} 个结果批次，${models.length} 个AnalysisModelKey（来自${A.unique(records.map((row) => row.rawModelConfigId)).length}个Raw ModelConfigID），${records.length} 条记录；首次有效率 ${pct(quality.firstValidRate)}，修复后有效率 ${pct(quality.finalValidRate)}，REPAIRED_VALID ${quality.repaired} 条。`);
    if (invalidTop.length) paragraphs.push(`首次异常：${invalidTop.slice(0, 4).map(([status, count]) => `${analysis.statusLabels[status] || status} ${count} 条`).join("；")}。无效回答均按缺失处理。`);
    paragraphs.push(`参数：P ${pRows.length} 条；P̄ ${pbarRows.filter((row) => Number.isFinite(row.mean)).length} 个条件；E ${eRows.filter((row) => row.valid).length} 个题组；平均E ${dRows.filter((row) => Number.isFinite(row.meanE)).length} 个分类对比；D ${dRows.filter((row) => row.eligible).length} 个分类对比。`);
    if (models.length < 2 || analysis.plannedRepeats < 3) paragraphs.push("限制：当前模型配置数或重复次数不足，重复一致性与模型区分结果仅在满足条件后输出。" );
    if (blocked) paragraphs.push(`计分阻断：${blocked} 个 GroupID；包括当前三选项 CNI-Conflict 在元数据冲突关闭前仅做描述统计。`);
    $("#overviewNarrative").innerHTML = paragraphs.map((paragraph) => `<p>${escape(paragraph)}</p>`).join("");
  }

  function renderCoverage() {
    const analysis = state.analysis;
    const rows = analysis.registry.coverage.filter(matchesSummary);
    const totals = analysis.registry.totals;
    const runRows = rows.filter((row) => row.runStatus !== "NOT_RUN");
    const computedE = analysis.registry.contrasts.filter(matchesSummary).filter((row) => Number.isFinite(row.meanE)).length;
    const supportedD = analysis.registry.contrasts.filter(matchesSummary).filter((row) => row.evidenceStatus === "SUPPORTED").length;
    $("#registrySummary").innerHTML = [
      metricCard("正式计分单元", String(totals.categoryUnits), "当前有效题库目录", "info", "按Bank×CategoryID形成计分单元；内置目录会与运行记录Source_*元数据合并。"),
      metricCard("正式条件单元", String(totals.conditionUnits), "分类×条件目录", "info", "按当前合并后的CategoryID×ConditionCode目录动态计算；新增条件不会被旧内置题库截断。"),
      metricCard("预登记方向对比", String(totals.registeredDirectionalContrasts), "CategoryID×ContrastID", "info", "40个预登记对比分别形成E/平均E/D，不合成为单一总效应。"),
      metricCard("当前已运行单元", `${runRows.length}/${rows.length}`, "按当前模型与全局筛选", runRows.length ? "good" : "warn", "只要该分类出现至少一条运行记录即计为已运行；完整性另由条件与题目覆盖判断。"),
      metricCard("可描述平均E", String(computedE), "至少一个有效GroupID", computedE ? "good" : "warn", "平均E只描述当前有效题组；不能自动替代覆盖充分的D。"),
      metricCard("D证据获得支持", String(supportedD), "覆盖、CI与Holm同时满足", supportedD ? "good" : "warn", "需D可输出、95%CI不跨0且Holm校正 p < 0.05；覆盖合格不等于证据已支持。"),
    ].join("");

    $("#coverageTable").innerHTML = rows.map((row) => {
      const runLabel = row.runStatus === "COMPLETE" ? "已完整运行" : row.runStatus === "PARTIAL" ? "部分运行" : "未运行";
      const runKind = row.runStatus === "COMPLETE" ? "good" : row.runStatus === "PARTIAL" ? "warn" : "info";
      const pText = row.pApplicability === "适用" ? `${row.pRecords} 条P` : row.pApplicability;
      const eText = row.registeredContrasts ? `${row.computedEContrasts}/${row.registeredContrasts} 个对比有平均E` : row.eApplicability;
      const dText = row.registeredContrasts ? `${row.eligibleDContrasts}/${row.registeredContrasts} 个D可输出` : row.dApplicability;
      return `<tr><td>${escape(row.modelConfig)}</td><td>${escape(row.bankLabel)}</td><td>${escape(row.secondLevel || "NA")}</td><td><code>${escape(row.categoryId)}</code> ${escape(row.category)}</td><td>${escape(row.scoreFamily)}</td><td>${escape(row.conditionStructure)}</td><td class="num">${row.observedConditions}/${row.plannedConditions}</td><td class="num">${row.observedItems}/${row.plannedItems}</td><td>${escape(pText)}</td><td>${escape(eText)}</td><td>${escape(dText)}</td><td>${statusPill(runLabel, runKind)}</td><td class="explanation-cell">${escape(row.applicabilityReason)}</td></tr>`;
    }).join("") || `<tr><td colspan="13" class="na">当前筛选没有正式计分单元。</td></tr>`;
  }

  function mapText(values, digits = 3) {
    return Object.entries(values || {}).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => `${key}=${Number.isFinite(value) ? num(value, digits) : "NA"}`).join("；") || "NA";
  }

  function renderParameterTables() {
    const analysis = state.analysis;
    const includeRepaired = analysis.options.includeRepaired;
    const pRows = filteredRecords().filter(localDomainMatch).filter((row) => includeRepaired || !row.repaired).slice(0, 120);
    $("#pScoreTable").innerHTML = pRows.map((row) => {
      let label;
      let kind;
      if (Number.isFinite(row.preference)) { label = "已计算"; kind = "good"; }
      else if (row.scoreFamily !== "DIRECTIONAL_RANK") { label = "评分族不适用"; kind = "info"; }
      else if (row.responseValid && !row.mappingValid) { label = row.mappingStatus; kind = "bad"; }
      else { label = analysis.statusLabels[row.finalStatus] || row.finalStatus || "缺失"; kind = "bad"; }
      const explanation = I.interpretP(row, row.preference);
      return `<tr><td>${escape(row.batchName)}</td><td>${escape(row.modelConfig)}</td><td>${escape(row.bankLabel)}</td><td>${escape(row.groupId)}</td><td>${escape(row.itemId)}</td><td>${escape(row.conditionCode || "NA")}</td><td class="num">${row.repeatIndex}</td><td>${escape(row.logicalRanking || "NA")}</td><td class="num">${row.rankL1 || "NA"}</td><td class="num">${row.rankL3 || "NA"}</td><td class="num">${Number.isFinite(row.preferenceNumerator) ? row.preferenceNumerator : "NA"}</td><td class="num">${Number.isFinite(row.preferenceDenominator) ? row.preferenceDenominator : "NA"}</td><td class="num">${num(row.preference, 3)}</td><td>${statusPill(label, kind)}</td><td class="explanation-cell">${escape(explanation)}</td></tr>`;
    }).join("") || `<tr><td colspan="15" class="na">当前筛选没有运行记录。</td></tr>`;

    const conditionRows = analysis.effects.conditionMeans.filter(matchesSummary).filter(localDomainMatch).slice(0, 120);
    $("#conditionMeanTable").innerHTML = conditionRows.map((row) => `<tr><td>${escape(row.modelConfig)}</td><td>${escape(row.bankLabel)}</td><td>${escape(row.secondLevel || "NA")}</td><td>${escape(row.category)}</td><td>${escape(row.groupId)}</td><td>${escape(row.conditionCode || "NA")}</td><td class="num">${row.itemIdCount}</td><td class="num">${row.validRepeats}/${row.plannedRepeats}</td><td class="num">${num(row.mean, 3)}</td><td>${statusPill(row.repeatStatus, row.repeatStatus === "COMPLETE" ? "good" : "warn")}</td><td class="explanation-cell">${escape(`${I.interpretP(row, row.mean, { average: true })} ${row.reason || ""}`)}</td></tr>`).join("") || `<tr><td colspan="11" class="na">当前筛选没有 DIRECTIONAL_RANK 条件均值。</td></tr>`;
  }

  function renderQuality() {
    const analysis = state.analysis;
    const records = filteredRecords().filter(localDomainMatch);
    const quality = qualityOf(records);
    $("#qualityMetrics").innerHTML = [
      metricCard("首次有效率", pct(quality.firstValidRate), `${quality.firstValid}/${quality.responseDenominator}`, quality.firstValidRate >= 0.98 ? "good" : "warn", "FirstValidRate=N(FirstStatus=VALID)/N(非技术响应)。"),
      metricCard("重试率", pct(quality.retryRate), `${quality.retry} 条触发格式提醒`, quality.retryRate <= 0.02 ? "good" : "warn", "RetryRate=N(RetryUsed=1)/N(非技术响应)。"),
      metricCard("修复后有效率", pct(quality.finalValidRate), `${quality.finalValid}/${quality.responseDenominator}`, quality.finalValidRate >= 0.98 ? "good" : "warn", "FinalValidRate=[N(VALID)+N(REPAIRED_VALID)]/N(非技术响应)。"),
      metricCard("修复成功", String(quality.repaired), "主分析可纳入；需做敏感性分析", quality.repaired ? "info" : "good", "N(FinalStatus=REPAIRED_VALID)；可通过全局开关执行排除修复回答的敏感性分析。"),
      metricCard("最终无效", String(quality.invalid), "按缺失处理，不记 0", quality.invalid ? "bad" : "good", "N(非技术响应)−N(VALID或REPAIRED_VALID)。"),
      metricCard("技术失败率", pct(quality.technicalRate), `${quality.technical}/${quality.total} 条`, quality.technicalRate === 0 ? "good" : "warn", "TechnicalRate=N(TECH_ERROR)/N(全部任务)。"),
    ].join("");
    const finalItems = Object.entries(quality.finalStatuses).map(([status, value]) => ({ label: analysis.statusLabels[status] || status, value, color: STATUS_COLORS[status] || "#8a96a1" }));
    C.donut($("#statusChart"), finalItems, { centerLabel: "最终记录" });
    const invalidItems = Object.entries(quality.firstStatuses).filter(([status]) => status !== "VALID").map(([status, value]) => ({ label: analysis.statusLabels[status] || status, value, color: STATUS_COLORS[status] || "#8a96a1" }));
    C.donut($("#invalidChart"), invalidItems, { centerLabel: "首次异常", empty: "当前筛选未出现首次格式异常" });

    const layers = analysis.layeredQuality.filter((row) => {
      if ($("#modelFilter").value !== "ALL" && row.level === "模型" && row.object !== $("#modelFilter").value) return false;
      if ($("#bankFilter").value !== "ALL" && row.level === "子测验" && row.object !== analysis.bankInfo[$("#bankFilter").value].label) return false;
      if ($("#categoryFilter").value !== "ALL" && row.level === "三级分类") {
        const category = analysis.categories.find((item) => item.key === $("#categoryFilter").value);
        if (category && !row.object.endsWith(`/ ${category.category}`)) return false;
      }
      return true;
    });
    $("#qualityTable").innerHTML = layers.map((row) => {
      const kind = row.finalValidRate >= 0.98 ? "good" : row.finalValidRate >= 0.9 ? "warn" : "bad";
      return `<tr><td>${escape(row.level)}</td><td>${escape(row.object)}</td><td class="num">${row.total}</td><td class="num">${pct(row.firstValidRate)}</td><td class="num">${pct(row.finalValidRate)}</td><td class="num">${pct(row.technicalRate)}</td><td>${statusPill(kind === "good" ? "通过预警线" : "建议复核", kind)}</td></tr>`;
    }).join("") || `<tr><td colspan="7" class="na">当前筛选没有分层记录</td></tr>`;
  }

  function profileRowsForBank(bankId) {
    const globalModel = $("#modelFilter").value;
    return state.analysis.profiles.profiles.filter((row) => row.bankId === bankId && (globalModel === "ALL" || row.modelConfig === globalModel));
  }

  function renderDimensionProfileGrid(bankId, rows) {
    const bank = I.FRAMEWORK.find((item) => item.bankId === bankId);
    const container = $("#decisionProfileGrid");
    if (!bank) {
      container.innerHTML = `<div class="chart-empty">当前子测验缺少解释字典元数据。</div>`;
      return;
    }
    container.innerHTML = bank.secondLevels.map((second) => {
      const categoryCards = second.categories.map((category) => {
        const categoryRows = rows.filter((row) => row.categoryId === category.id);
        const modelValues = categoryRows.map((row, index) => {
          const position = Number.isFinite(row.mean) ? A.clamp((row.mean + 1) / 2, 0, 1) * 100 : null;
          return `<div class="profile-model-row"><span title="${escape(row.modelConfig)}"><i style="background:${C.palette[index % C.palette.length]}"></i>${escape(row.modelConfig)}</span><div class="mini-axis"><b style="${position == null ? "display:none" : `left:${position}%`};background:${C.palette[index % C.palette.length]}"></b></div><em>${num(row.mean, 3)}</em></div>`;
        }).join("") || `<div class="profile-model-row empty"><span>无方向分数</span><em>NA</em></div>`;
        const endpoints = category.directional === false
          ? `<div class="profile-endpoints nominal"><span>${escape(category.noEffect || "名义排序策略")}</span></div>`
          : `<div class="profile-endpoints"><span>−1 · ${escape(category.low)}</span><span>+1 · ${escape(category.high)}</span></div>`;
        return `<section class="dimension-coordinate"><header><div><code>${escape(category.id)}</code><b>${escape(category.name)}</b></div><span class="info-tip static" tabindex="0" data-tip="${escape(category.definition)}">i</span></header>${modelValues}${endpoints}</section>`;
      }).join("");
      return `<article class="second-level-block"><header><div><small>SECOND LEVEL</small><h3>${escape(second.name)}</h3></div><span class="aggregate-note">${escape(second.aggregate)}</span></header><div class="coordinate-list">${categoryCards}</div></article>`;
    }).join("");
  }

  function renderProfile() {
    const analysis = state.analysis;
    const bankId = $("#profileBank").value || analysis.bankIds[0];
    const metric = $("#profileMetric").value;
    const rows = profileRowsForBank(bankId);
    const categoryMeta = (analysis.banks.catalog[bankId] && analysis.banks.catalog[bankId].categories) || [];
    const categories = categoryMeta.length ? categoryMeta.map((item) => ({ key: item.key, label: item.category, id: item.categoryId })) : A.unique(rows.map((row) => row.categoryKey)).map((key) => { const row = rows.find((item) => item.categoryKey === key); return { key, label: row.category, id: row.categoryId }; });
    const models = A.unique(rows.map((row) => row.modelConfig));
    const series = models.map((model, index) => {
      const modelRows = rows.filter((row) => row.modelConfig === model);
      let rawValues;
      let values;
      if (metric === "coverage") {
        rawValues = categories.map((category) => { const row = modelRows.find((item) => item.categoryKey === category.key); return row ? row.coverage : null; });
        values = rawValues;
      } else if (metric === "stability") {
        rawValues = categories.map((category) => {
          const cells = analysis.reliability.cells.filter((cell) => cell.modelConfig === model && cell.categoryKey === category.key);
          return cells.length ? A.mean(cells.map((cell) => cell.topAgreement)) : null;
        });
        values = rawValues;
      } else {
        rawValues = categories.map((category) => { const row = modelRows.find((item) => item.categoryKey === category.key); return row ? row.mean : null; });
        values = rawValues.map((value) => Number.isFinite(value) ? (value + 1) / 2 : null);
      }
      return { label: model, values, rawValues, color: C.palette[index % C.palette.length] };
    });
    renderDimensionProfileGrid(bankId, rows);
    $("#radarTitle").textContent = `${analysis.bankInfo[bankId] ? analysis.bankInfo[bankId].label : bankId} · 三级分类画像`;
    C.radar($("#radarChart"), categories.map((category) => ({ label: category.label })), series, { empty: metric === "stability" ? "当前没有可估计重复一致性的分类" : "当前子测验没有至少 3 个可比的方向维度" });
    $("#radarNote").textContent = metric === "preference" ? "绘图坐标由原始方向分数 P 线性转换为 (P+1)/2；原始分数与方向说明保留在悬停提示和下表中，不解释为跨构念总分。" : metric === "coverage" ? "覆盖率为有效题组数除以计划题组数；低于 80% 的分类不应生成汇总效应。" : "首选稳定性仅对至少有 2 次有效重复的条件估计；建议每条件 3–5 次。";

    const globalModel = $("#modelFilter").value;
    const topRowsRaw = analysis.profiles.topChoices.filter((row) => row.bankId === bankId && (globalModel === "ALL" || row.modelConfig === globalModel));
    const topRows = [];
    A.groupBy(topRowsRaw, (row) => row.categoryKey).forEach((group) => {
      const counts = { L1: 0, L2: 0, L3: 0 };
      group.forEach((row) => Object.keys(counts).forEach((key) => { counts[key] += row.counts[key] || 0; }));
      topRows.push({ label: group[0].category, values: counts });
    });
    C.stackedBars($("#topChoiceChart"), topRows, [
      { key: "L1", label: "L1 首选", color: "#7357d8" },
      { key: "L2", label: "L2 首选", color: "#9a929c" },
      { key: "L3", label: "L3 首选", color: "#dc6b50" },
    ], { empty: "当前子测验没有可解析的逻辑首选" });

    const heatRows = A.unique(rows.map((row) => row.modelConfig));
    const heatCols = categories.map((category) => category.label);
    const matrix = heatRows.map((model) => categories.map((category) => { const row = rows.find((item) => item.modelConfig === model && item.categoryKey === category.key); return row ? row.mean : null; }));
    C.heatmap($("#profileHeatmap"), heatRows, heatCols, matrix, { min: -1, max: 1, empty: "需要方向分数才能生成画像矩阵" });

    $("#profileTable").innerHTML = rows.sort((a, b) => A.modelCompareRows(a, b, analysis.records) || a.categoryId.localeCompare(b.categoryId)).map((row) => {
      const note = row.coverage < 0.8 ? "覆盖不足，不作分类效应汇总" : row.ciLow == null ? "题组不足，未估计 CI" : "条件内基础偏好";
      return `<tr><td>${escape(row.modelConfig)}</td><td>${escape(row.bankLabel)}</td><td>${escape(row.secondLevel || "NA")}</td><td>${escape(row.category)}</td><td class="num">${num(row.mean, 3)}</td><td class="num">${row.ciLow == null ? "NA" : `[${num(row.ciLow, 3)}, ${num(row.ciHigh, 3)}]`}</td><td class="num">${row.validGroups}/${row.plannedGroups}</td><td class="num">${pct(row.coverage)}</td><td>${escape(note)}</td><td class="explanation-cell">${escape(I.interpretP(row, row.mean, { average: true }))}</td></tr>`;
    }).join("") || `<tr><td colspan="10" class="na">当前子测验没有 DIRECTIONAL_RANK 分类统计；名义排序请查看首选分布。</td></tr>`;
  }

  function updateEffectCategories() {
    if (!state.analysis) return;
    const bankId = $("#effectBank").value || state.analysis.bankIds[0];
    const options = state.analysis.registry.coverage
      .filter((category, index, rows) => rows.findIndex((item) => item.categoryKey === category.categoryKey) === index)
      .filter((category) => category.bankId === bankId)
      .map((category) => ({ value: category.categoryKey, label: `${category.categoryId} ${category.category}` }));
    populateSelect($("#effectCategory"), options, "全部分类", $("#effectCategory").value);
  }

  function effectSelection(row) {
    const bank = $("#effectBank").value;
    const category = $("#effectCategory").value;
    const model = $("#effectModel").value;
    return row.bankId === bank && (category === "ALL" || row.categoryKey === category) && (model === "ALL" || row.modelConfig === model);
  }

  function significance(p) {
    if (!Number.isFinite(p)) return "";
    if (p < 0.001) return "***";
    if (p < 0.01) return "**";
    if (p < 0.05) return "*";
    return "n.s.";
  }

  function renderEffects() {
    const analysis = state.analysis;
    // 正式Category汇总D保持完整预登记口径；Domain只切片可明确归属的
    // Condition与Group E明细，绝不把任意UI子集重新命名为D。
    const summaries = analysis.effects.summaries.filter(effectSelection);
    const attemptedGroupEffects = analysis.effects.groupEffects.filter(effectSelection).filter(localDomainMatch);
    const validGroupEffects = attemptedGroupEffects.filter((row) => row.valid);
    const notice = $("#effectsNotice");
    if (!summaries.some((row) => row.eligible)) {
      notice.classList.remove("is-hidden");
      notice.textContent = validGroupEffects.length
        ? "部分 GroupID 已形成 E，因此描述性平均E仍会显示；但分类有效题组覆盖不足80%或有效题组少于2个时，正式D不输出。"
        : "当前筛选没有可完整计算的 E。E 明细表会列出缺失条件、重复覆盖或权重校验原因；D 因没有有效 E 而不输出。";
    } else notice.classList.add("is-hidden");

    const barData = summaries.filter((row) => row.eligible).map((row, index) => ({
      label: row.contrastId,
      shortLabel: row.contrastId,
      mean: row.dScore,
      ciLow: row.ciLow,
      ciHigh: row.ciHigh,
      points: row.groupEffects.map((effect) => effect.effect),
      color: C.palette[index % C.palette.length],
      significance: significance(row.pHolm),
    }));
    C.barScatter($("#effectBarChart"), barData, { min: -1, max: 1, empty: "当前没有通过 80% 分类覆盖门槛的 D；不会使用缺失条件或不完整 E 生成汇总值" });
    $("#effectNote").textContent = "散点为单个GroupID的E；平均E对当前有效E作描述汇总；D按AggregationRule并在分类覆盖≥80%后正式输出。当前题组等权时，合格D与平均E数值相同，但统计身份不同。";

    const conditionRows = analysis.effects.conditionMeans.filter(effectSelection).filter(localDomainMatch);
    const groups = A.unique(conditionRows.map((row) => row.groupId)).slice(0, 30);
    const conditions = A.unique(conditionRows.map((row) => row.conditionCode)).sort((a, b) => Number(a.replace(/\D/g, "")) - Number(b.replace(/\D/g, "")));
    const conditionMatrix = groups.map((group) => conditions.map((condition) => {
      const rows = conditionRows.filter((row) => row.groupId === group && row.conditionCode === condition);
      return rows.length ? A.mean(rows.map((row) => row.mean)) : null;
    }));
    C.heatmap($("#conditionHeatmap"), groups, conditions, conditionMatrix, { min: -1, max: 1, cell: 34, empty: "当前筛选没有条件内方向分数" });

    const ranked = validGroupEffects.sort((a, b) => b.effect - a.effect).slice(0, 28).map((row) => ({ label: `${row.groupId} · ${row.contrastId}`, value: row.effect }));
    C.horizontalBars($("#rankedEffects"), ranked, { min: -1, max: 1, left: 250, empty: "没有可排序的 E" });

    const attemptedKeys = new Set(attemptedGroupEffects.map((row) => `${row.modelConfig}::${row.categoryKey}::${row.contrastId}`));
    const plannedOnly = hasActiveDomainSubset() ? [] : analysis.registry.contrasts.filter(effectSelection).filter((row) => !attemptedKeys.has(`${row.modelConfig}::${row.categoryKey}::${row.contrastId}`));
    const eRows = [
      ...attemptedGroupEffects.map((row) => ({ ...row, plannedOnly: false })),
      ...plannedOnly.map((row) => ({ ...row, plannedOnly: true, groupId: "—", conditionMeans: {}, effect: null, valid: false, resolvedFormula: "待该题组必要条件完成后代入", reason: row.reason })),
    ];
    $("#eEffectsTable").innerHTML = eRows.slice(0, 180).map((row) => {
      const status = row.plannedOnly ? statusPill("预登记·未运行", "info") : row.valid ? statusPill("可计算", "good") : statusPill("不输出", "warn");
      const explanation = row.plannedOnly ? `该ContrastID已登记，当前结果文件未形成对应题组条件组合。${row.reason}` : I.interpretE(row, row.effect);
      return `<tr><td>${escape(row.modelConfig)}</td><td>${escape(row.secondLevel || "NA")}</td><td>${escape(row.category)}</td><td>${escape(row.groupId)}</td><td>${escape(row.contrastId)}</td><td>${escape(mapText(row.conditionMeans))}</td><td>${escape(mapText(row.weights))}</td><td class="formula-cell">${escape(row.resolvedFormula || I.resolvedEffectFormula(row))}</td><td class="num">${num(row.effect, 3)}</td><td>${status} ${row.valid ? "" : escape(row.reason || "")}</td><td class="explanation-cell">${escape(explanation)}</td></tr>`;
    }).join("") || `<tr><td colspan="11" class="na">该分类没有预登记的方向对比；请按评分路由查看P或非方向结果。</td></tr>`;

    $("#effectsTable").innerHTML = summaries.map((row) => {
      const explanation = `<b>平均E：</b>${escape(I.interpretMeanE(row, row.meanE))}<br><b>D：</b>${escape(I.interpretD(row, row.dScore))}`;
      const evidenceKind = row.evidenceStatus === "SUPPORTED" ? "good" : row.evidenceStatus === "NOT_COMPUTABLE" ? "bad" : "warn";
      return `<tr><td>${escape(row.modelConfig)}</td><td>${escape(row.secondLevel || "NA")}</td><td>${escape(row.category)}</td><td>${escape(row.contrastId)}</td><td class="formula-cell">${escape(row.meanEFormula)}</td><td class="num">${num(row.meanE, 3)}</td><td class="num">${row.meanECiLow == null ? "NA" : `[${num(row.meanECiLow, 3)}, ${num(row.meanECiHigh, 3)}]`}</td><td class="formula-cell">${escape(row.dFormula)}</td><td class="num">${num(row.dScore, 3)}</td><td class="num">${row.validGroups}/${row.plannedGroups} (${pct(row.coverage)})</td><td class="num">${row.positiveGroups}/${row.negativeGroups}/${row.zeroGroups}</td><td class="num">${row.p == null ? "NA" : num(row.p, 4)}</td><td class="num">${row.pHolm == null ? "NA" : `${num(row.pHolm, 4)} ${significance(row.pHolm)}`}</td><td>${statusPill(row.evidenceLabel, evidenceKind)}</td><td class="explanation-cell">${explanation}</td></tr>`;
    }).join("") || analysis.registry.contrasts.filter(effectSelection).map((row) => `<tr><td>${escape(row.modelConfig)}</td><td>${escape(row.secondLevel || "NA")}</td><td>${escape(row.category)}</td><td>${escape(row.contrastId)}</td><td>平均E=NA</td><td class="num">NA</td><td class="num">NA</td><td>D=NA</td><td class="num">NA</td><td class="num">0/${row.plannedGroups} (0%)</td><td class="num">0/0/0</td><td class="num">NA</td><td class="num">NA</td><td>${statusPill("未运行", "info")}</td><td class="explanation-cell">${escape(row.reason)}</td></tr>`).join("") || `<tr><td colspan="15" class="na">该分类没有可识别的预登记方向对比。</td></tr>`;
  }

  function selectedFactorialAnalysis() {
    if (!state.analysis) return null;
    const categoryKey = $("#factorialCategory").value;
    const modelConfig = $("#factorialModel").value;
    return state.analysis.factorial.analyses.find((row) => row.categoryKey === categoryKey && row.modelConfig === modelConfig) || null;
  }

  function updateFactorialOutcomes() {
    const control = $("#factorialOutcome");
    if (!control || !state.analysis) return;
    const selected = selectedFactorialAnalysis();
    const options = selected && selected.outcomeCatalog && selected.outcomeCatalog.length
      ? selected.outcomeCatalog.map((outcome) => ({ value: outcome.id, label: outcome.label }))
      : [{ value: "P", label: "方向偏好P" }];
    populateSelect(control, options, null, options.some((option) => option.value === control.value) ? control.value : options[0].value);
  }

  function orderedLabels(values) {
    return A.unique(values.filter((value) => value != null).map(String)).sort((a, b) => a.localeCompare(b, "zh-CN", { numeric: true }));
  }

  function renderFactorial() {
    const analysis = selectedFactorialAnalysis();
    if (!analysis) {
      C.empty($("#factorialHeatmap"), "当前没有FACTORIAL分类");
      C.empty($("#factorialLineChart"), "当前没有FACTORIAL分类");
      $("#factorialDesignSummary").innerHTML = "";
      $("#factorialEvidence").innerHTML = "";
      $("#factorialCellTable").innerHTML = `<tr><td colspan="11" class="na">当前没有FACTORIAL分类。</td></tr>`;
      $("#factorialTable").innerHTML = `<tr><td colspan="13" class="na">当前没有FACTORIAL分类。</td></tr>`;
      return;
    }
    const outcomeId = $("#factorialOutcome").value || (analysis.outcomeCatalog[0] && analysis.outcomeCatalog[0].id) || "P";
    const outcome = analysis.outcomeCatalog.find((row) => row.id === outcomeId) || analysis.outcomeCatalog[0] || { id: "P", label: "方向偏好P", bounds: [-1, 1] };
    const effectType = $("#factorialEffectType").value || "ALL";
    const design = analysis.design || {};
    const numericFactorial = design.designClass === "PARTIAL_CROSS_NUMERIC" || design.designClass === "FULL_CROSS_NUMERIC";
    const notice = $("#factorialNotice");
    if (analysis.formalBlocked) {
      notice.textContent = `${analysis.blockedReason} 当前仍计算${analysis.outcomeCatalog.length}类响应变量×7个设计矩阵效应，全部明确标记为探索性/元数据阻断。`;
    } else if (design.designClass === "PARTIAL_CROSS_NUMERIC") {
      notice.textContent = `该题库是部分交叉数值设计：${design.plannedCells}个计划单元中已观察${design.observedCells}个；笛卡尔积外的${design.structuralUnplannedCells}个组合属于“结构上未设计”，不是数据缺失。设计矩阵${design.designRank}/${design.designColumns}满秩，参考点为${design.numericFactor}=${num(design.referenceValue, 2)}。`;
    } else if (design.designClass === "FULL_CROSS_NUMERIC") {
      notice.textContent = `该题库是完整交叉数值设计：${analysis.factorKeys.map((key) => `${key}(${(analysis.factorLevels[key] || []).length})`).join(" × ")}共${design.plannedCells}个计划单元，已观察${design.observedCells}个；结构未设计${design.structuralUnplannedCells}个、数据缺失${design.dataMissingCells}个。设计矩阵${design.designRank}/${design.designColumns}满秩，参考点为${design.numericFactor}=${num(design.referenceValue, 2)}。`;
    } else {
      notice.textContent = `${analysis.factorKeys.map((key) => `${key}(${(analysis.factorLevels[key] || []).length})`).join(" × ")}为完整交叉设计；主效应与交互按设计矩阵计算。未登记的效应仅作探索性结果，不输出正式D。`;
    }
    notice.className = `notice ${analysis.blocked ? "warning" : "info"}`;

    const designClassLabel = design.designClass === "FULL_CROSS_NUMERIC" ? "完整交叉·数值因子" : design.designClass === "FULL_CROSS" ? "完整交叉" : design.designClass === "PARTIAL_CROSS_NUMERIC" ? "部分交叉·数值因子" : "部分交叉";
    $("#factorialDesignSummary").innerHTML = [
      metricCard("设计类型", designClassLabel, design.formula || analysis.factorKeys.join(" × "), design.estimable ? "good" : "warn", "先识别因子结构，再选择设计矩阵；不会按C1、C2顺序直接拟合。"),
      metricCard("计划单元覆盖", `${design.observedCells}/${design.plannedCells}`, `数据缺失 ${design.dataMissingCells || 0} 个`, design.dataMissingCells ? "warn" : "good", "计划单元缺失与结构上未设计的组合分别统计。"),
      metricCard("结构未设计", String(design.structuralUnplannedCells || 0), `完整笛卡尔积 ${design.cartesianCells || design.plannedCells} 格`, "info", "这些组合不属于运行失败，不进入缺失率。"),
      metricCard("设计矩阵", design.designRank == null ? (design.fullyCrossed ? "完整" : "待登记") : `${design.designRank}/${design.designColumns}`, design.estimable ? "目标项可识别" : "存在不可识别项", design.estimable ? "good" : "warn", "秩等于设计列数时，参考点主效应和斜率交互可估计。"),
    ].join("");

    const selectedGenerated = (analysis.factorialEffects || []).filter((row) => row.outcomeId === outcomeId);
    const filteredGenerated = selectedGenerated.filter((row) => effectType === "ALL" || (effectType !== "REGISTERED" && row.effectType === effectType));
    const registryRows = state.analysis.registry.contrasts.filter((row) => row.modelConfig === analysis.modelConfig && row.categoryKey === analysis.categoryKey);
    const chartEffects = effectType === "REGISTERED"
      ? registryRows.map((row) => ({
        label: row.contrastId,
        effectLabel: row.contrastId,
        meanE: row.meanE,
        ciLow: row.summary && row.summary.meanECiLow,
        ciHigh: row.summary && row.summary.meanECiHigh,
        groupEffects: row.summary ? row.summary.groupEffects : [],
        pHolm: row.summary && row.summary.pHolm,
      }))
      : filteredGenerated;
    if (numericFactorial && analysis.responseSurface) {
      const groupFactor = analysis.responseSurface.groupFactor;
      const numericFactor = analysis.responseSurface.numericFactor;
      const levels = orderedLabels(analysis.factorLevels[groupFactor] || []);
      $("#factorialChartOneTitle").textContent = "实际观测单元响应曲线";
      $("#factorialChartTwoTitle").textContent = effectType === "REGISTERED" ? "预登记E与D" : "简单斜率与斜率交互";
      C.numericMultiLine($("#factorialHeatmap"), levels.map((level, index) => ({
        label: `${groupFactor}=${level}`,
        color: C.palette[index % C.palette.length],
        points: analysis.cells.filter((cell) => String(cell.factorValues[groupFactor]) === level && Number.isFinite(cell.meanP)).map((cell) => ({ x: Number(cell.factorValues[numericFactor]), y: cell.meanP })),
      })), { min: -1, max: 1, xLabel: numericFactor, referenceX: analysis.responseSurface.referenceValue, referenceLabel: "回归参考成本率", empty: "当前没有可绘制的实际观测单元" });
      C.barScatter($("#factorialLineChart"), chartEffects.map((row, index) => ({
        label: row.label,
        shortLabel: row.effectType === "SIMPLE_SLOPE" ? row.label.replace("时成本率简单斜率", "") : row.effectType === "SLOPE_INTERACTION" ? "端点斜率交互" : row.effectLabel,
        mean: row.meanE,
        ciLow: row.ciLow,
        ciHigh: row.ciHigh,
        points: (row.groupEffects || []).map((item) => item.effect).filter(Number.isFinite),
        color: C.palette[index % C.palette.length],
      })), { height: 430, empty: effectType === "REGISTERED" ? "当前预登记效应尚不可计算" : "当前筛选下没有可估计的简单斜率或交互" });
    } else if (analysis.scoreFamily === "CUSTOM") {
      $("#factorialChartOneTitle").textContent = "8单元逻辑首选分布";
      $("#factorialChartTwoTitle").textContent = effectType === "REGISTERED" ? "预登记效应" : `${outcome.label}的主效应与交互`;
      C.stackedBars($("#factorialHeatmap"), analysis.cells.map((cell) => ({
        label: `${cell.conditionCode} · ${Object.entries(cell.factorValues).map(([key, value]) => `${key}=${value}`).join(" · ")}`,
        values: cell.topCounts,
      })), [
        { key: "L1", label: "L1首选", color: C.palette[0] },
        { key: "L2", label: "L2首选", color: C.palette[1] },
        { key: "L3", label: "L3首选", color: C.palette[2] },
      ], { empty: "当前8个因子单元没有可用首选分布" });
      C.barScatter($("#factorialLineChart"), chartEffects.map((row, index) => ({
        label: row.effectLabel,
        shortLabel: row.effectLabel,
        mean: row.meanE,
        ciLow: row.ciLow,
        ciHigh: row.ciHigh,
        points: (row.groupEffects || []).map((item) => item.effect).filter(Number.isFinite),
        color: C.palette[index % C.palette.length],
        significance: Number.isFinite(row.pHolm) && row.pHolm < 0.05 ? significance(row.pHolm) : "",
      })), { min: -1, max: 1, height: 450, empty: effectType === "REGISTERED" ? "该CUSTOM分类没有可用的预登记方向效应" : "该结果变量与效应筛选下暂无可估计结果" });
    } else {
      const [factorA, factorB] = analysis.factorKeys;
      const rowLabels = orderedLabels(analysis.factorLevels[factorA] || []);
      const colLabels = orderedLabels(analysis.factorLevels[factorB] || []);
      const matrix = rowLabels.map((a) => colLabels.map((b) => {
        const cell = analysis.cells.find((item) => String(item.factorValues[factorA]) === a && String(item.factorValues[factorB]) === b);
        return cell ? cell.meanP : null;
      }));
      $("#factorialChartOneTitle").textContent = "因子单元平均P矩阵";
      $("#factorialChartTwoTitle").textContent = effectType === "REGISTERED" ? "预登记效应" : "设计矩阵效应";
      C.heatmap($("#factorialHeatmap"), rowLabels, colLabels, matrix, { min: -1, max: 1, cell: 42 });
      C.barScatter($("#factorialLineChart"), chartEffects.map((row, index) => ({ label: row.effectLabel, mean: row.meanE, ciLow: row.ciLow, ciHigh: row.ciHigh, points: (row.groupEffects || []).map((item) => item.effect), color: C.palette[index % C.palette.length] })), { min: -1, max: 1, empty: "当前效应筛选下没有可估计结果" });
    }

    const observedCells = analysis.cells.filter((cell) => cell.nValid > 0).length;
    const supported = registryRows.filter((row) => row.evidenceStatus === "SUPPORTED").length;
    $("#factorialEvidence").innerHTML = [
      metricCard("单元有效覆盖", `${observedCells}/${analysis.cells.length}`, "按题库计划条件", observedCells === analysis.cells.length ? "good" : "warn", "有效记录覆盖计划因子单元的数量。"),
      metricCard("预登记效应", String(registryRows.length), `${registryRows.filter((row) => Number.isFinite(row.dScore)).length} 个正式D`, registryRows.length ? "good" : "info", "每个ContrastID独立汇总；不同主效应或交互不得混为同一个D。"),
      metricCard("当前结果变量", outcome.label, `${selectedGenerated.filter((row) => Number.isFinite(row.meanE)).length}/${selectedGenerated.length} 个设计矩阵效应可估计`, "info", "CUSTOM结果必须携带结果变量名称，不能统称为普通P。"),
      metricCard("正式结论状态", analysis.formalBlocked ? "元数据阻断" : supported ? `${supported}项获支持` : "按登记结果判断", analysis.formalBlocked ? "仍提供探索性析因画像" : "覆盖合格不等于显著", analysis.formalBlocked ? "warn" : "good", "未登记或理论标签冲突时，平台保留估计值，但不输出正式D/C/N/I。"),
    ].join("");

    $("#factorialCellTable").innerHTML = analysis.cells.map((cell) => {
      const factorText = Object.entries(cell.factorValues || {}).map(([key, value]) => `${key}=${value}`).join("；") || "NA";
      const ranks = ["L1", "L2", "L3"].map((key) => num(cell.meanRanks[key], 2)).join(" / ");
      const status = cell.nValid ? (cell.coverage >= 0.8 ? statusPill("覆盖合格", "good") : statusPill("覆盖不足", "warn")) : statusPill("计划单元缺失", "bad");
      return `<tr><td>${escape(cell.conditionCode)} · ${escape(cell.conditionLabel)}</td><td>${escape(factorText)}</td><td class="num">${cell.nValid}/${cell.plannedObservations}</td><td class="num">${pct(cell.coverage)}</td><td class="num">${num(cell.meanP, 3)}</td><td class="num">${pct(cell.topProportions.L1)}</td><td class="num">${pct(cell.topProportions.L2)}</td><td class="num">${pct(cell.topProportions.L3)}</td><td class="num">${pct(cell.pairL1AboveL2)}</td><td class="num">${escape(ranks)}</td><td>${status}</td></tr>`;
    }).join("");

    const registeredRows = (effectType === "ALL" || effectType === "REGISTERED" ? registryRows : []).map((row) => {
      const summary = row.summary;
      const evidenceKind = row.evidenceStatus === "SUPPORTED" ? "good" : row.evidenceStatus === "NOT_RUN" ? "info" : "warn";
      const explanation = summary ? `${I.interpretMeanE(summary, summary.meanE)} ${I.interpretD(summary, summary.dScore)}` : row.reason;
      return `<tr><td>预登记ContrastID</td><td>方向偏好P</td><td>${escape(row.contrastId)}</td><td class="num">${num(row.meanE, 3)}</td><td>标准化E</td><td class="num">${summary && summary.meanECiLow != null ? `[${num(summary.meanECiLow, 3)}, ${num(summary.meanECiHigh, 3)}]` : "NA"}</td><td class="num">${row.validGroups}/${row.plannedGroups}</td><td class="num">${summary ? `${summary.positiveGroups}/${summary.negativeGroups}/${summary.zeroGroups}` : "NA"}</td><td class="num">${num(row.meanE, 3)}</td><td class="num">${num(row.dScore, 3)}</td><td class="num">${summary && summary.p != null ? `${num(summary.p, 4)} / ${num(summary.pHolm, 4)}` : "NA"}</td><td>${statusPill(row.evidenceLabel, evidenceKind)}</td><td class="explanation-cell">${escape(explanation)}</td></tr>`;
    });
    const generatedRows = filteredGenerated.map((row) => {
      const statusKind = row.evidenceStatus === "NOT_COMPUTABLE" ? "bad" : row.evidenceStatus === "METADATA_BLOCKED" ? "warn" : "info";
      const source = row.effectType === "SIMPLE_SLOPE" ? "设计矩阵斜率" : row.effectType === "SLOPE_INTERACTION" ? "探索性斜率交互" : "设计矩阵探索性";
      const explanation = I.interpretFactorial(analysis, row);
      return `<tr><td>${escape(source)}</td><td>${escape(row.outcomeLabel)}</td><td>${escape(row.effectLabel || row.label)}</td><td class="num">${num(row.meanE, 3)}</td><td>${escape(row.effectUnit || "标准化E")}</td><td class="num">${row.ciLow == null ? "NA" : `[${num(row.ciLow, 3)}, ${num(row.ciHigh, 3)}]`}</td><td class="num">${row.validGroups}/${row.plannedGroups}</td><td class="num">${row.positiveGroups}/${row.negativeGroups}/${row.zeroGroups}</td><td class="num">${num(row.descriptiveD, 3)}</td><td class="num">${num(row.dScore, 3)}</td><td class="num">${row.p == null ? "NA" : `${num(row.p, 4)} / ${num(row.pHolm, 4)}`}</td><td>${statusPill(row.evidenceLabel, statusKind)}</td><td class="explanation-cell">${escape(explanation)}</td></tr>`;
    });
    $("#factorialTable").innerHTML = registeredRows.join("") + generatedRows.join("") || `<tr><td colspan="13" class="na">当前结果变量与效应筛选下没有可显示的析因结果。</td></tr>`;
  }

  function renderNonDirectional() {
    const domainScoped = hasActiveDomainSubset();
    const rows = domainScoped
      ? (state.analysis.domain && state.analysis.domain.nonDirectionalProfile || [])
        .filter(matchesSummary).filter(localDomainMatch)
        .map((row) => ({ ...row, analysis: row, domainScoped: true }))
      : state.analysis.nonDirectional.analyses.filter(matchesSummary).flatMap((analysis) => analysis.cells.map((cell) => ({ ...cell, analysis, domainScoped: false })));
    $("#nonDirectionalTable").innerHTML = rows.map((row) => {
      const analysis = row.analysis;
      const status = row.n ? statusPill("描述统计", "good") : statusPill("未运行", "info");
      const meanRanks = ["L1", "L2", "L3"].map((key) => `${key}=${num(row.meanRanks[key], 2)}`).join("；");
      const domainLabel = row.domainScoped ? ` · ${row.domain}` : "";
      const groups = row.domainScoped ? ` · Group=${(row.groupIds || []).join("/")}` : "";
      const reason = row.domainScoped ? "当前表按所选Domain×Condition×Strategy切片；不构造P、E或正式D。" : analysis.reason;
      return `<tr><td>${escape(analysis.modelConfig)}</td><td>${escape(analysis.bankLabel)}</td><td><code>${escape(analysis.categoryId)}</code> ${escape(`${analysis.category}${domainLabel}`)}</td><td>${escape(analysis.scoreFamily)}</td><td>${escape(row.conditionCode)} · ${escape(row.conditionLabel)}${escape(groups)}</td><td class="num">${row.n}</td><td class="num">${pct(row.topProportions.L1)}</td><td class="num">${pct(row.topProportions.L2)}</td><td class="num">${pct(row.topProportions.L3)}</td><td>${escape(meanRanks)}</td><td class="explanation-cell">${status} ${escape(reason)}</td></tr>`;
    }).join("") || `<tr><td colspan="11" class="na">当前筛选没有NOMINAL_RANK或CUSTOM计分单元。</td></tr>`;
  }

  function initializeInterpretationControls() {
    const bankOptions = I.FRAMEWORK.map((bank) => ({ value: bank.bankId, label: bank.bankLabel }));
    populateSelect($("#interpretBank"), bankOptions, "全部决策 / 子测验", $("#interpretBank").value || "ALL");
    updateInterpretSecond();
    renderInterpretation();
  }

  function updateInterpretSecond() {
    const bankId = $("#interpretBank").value;
    const rows = I.rows.filter((row) => bankId === "ALL" || row.bankId === bankId);
    const options = A.unique(rows.map((row) => row.secondLevel)).map((name) => ({ value: name, label: name }));
    populateSelect($("#interpretSecond"), options, "全部二级维度", $("#interpretSecond").value);
  }

  function renderInterpretation() {
    const ladder = [
      { symbol: "P", title: "单次P", formula: "[rank(L1)−rank(L3)] / 2", question: "这一次完整排序更偏向L1还是L3？" },
      { symbol: "P̄", title: "条件内平均P", formula: "ΣP / nvalid", question: "同一题、同一条件重复测量后的平均偏好是什么？" },
      { symbol: "P̄d", title: "分类平均P", formula: "meanGroup(P̄)", question: "同一三级分类的题组平均偏好坐标是什么？" },
      { symbol: "E", title: "单个E", formula: "ΣwP̄ / 2", question: "同一GroupID中，条件改变使偏好向哪里移动？" },
      { symbol: "Ē", title: "平均E", formula: "ΣE / Gvalid", question: "当前有效题组的条件效应平均方向是什么？" },
      { symbol: "D", title: "正式D", formula: "ΣaE / Σa", question: "覆盖充分后，该分类跨题组的总体条件效应是什么？" },
    ];
    $("#metricLadder").innerHTML = ladder.map((item, index) => `<article><header><span>${escape(item.symbol)}</span><small>${String(index + 1).padStart(2, "0")}</small></header><h3>${escape(item.title)}</h3><code>${escape(item.formula)}</code><p>${escape(item.question)}</p></article>`).join("");

    const bankId = $("#interpretBank").value;
    const second = $("#interpretSecond").value;
    const rows = I.rows.filter((row) => (bankId === "ALL" || row.bankId === bankId) && (second === "ALL" || row.secondLevel === second));
    $("#frameworkInterpretationTable").innerHTML = rows.map((row) => {
      const pHigh = row.directional ? `正P / 越接近+1：${row.high}` : row.noEffect;
      const pLow = row.directional ? `负P / 越接近−1：${row.low}` : row.noEffect;
      const limit = [row.aggregate, row.noEffect].filter(Boolean).join(" ");
      return `<tr><td><b>${escape(row.bankLabel)}</b><small>${escape(row.decisionDefinition)}</small></td><td><b>${escape(row.secondLevel)}</b></td><td><code>${escape(row.id)}</code><b>${escape(row.name)}</b><small>${escape(row.definition)}</small></td><td>${escape(pHigh)}</td><td>${escape(pLow)}</td><td>${escape(I.staticEffectText(row, true, "E"))}</td><td>${escape(I.staticEffectText(row, false, "E"))}</td><td>${escape(I.staticEffectText(row, true, "D"))}</td><td>${escape(I.staticEffectText(row, false, "D"))}</td><td>${escape(limit)}</td></tr>`;
    }).join("") || `<tr><td colspan="10" class="na">没有符合筛选条件的分类。</td></tr>`;
  }

  function renderReliability() {
    const analysis = state.analysis;
    const itemRows = analysis.itemRepeatSummaries.filter(matchesSummary).filter(localDomainMatch);
    const itemKeys = new Set(itemRows.map((row) => `${row.modelConfig}::${row.bankId}::${row.itemId}`));
    const cells = analysis.reliability.cells.filter(matchesSummary).filter((row) => itemKeys.has(`${row.modelConfig}::${row.bankId}::${row.itemId}`));
    const positionCells = analysis.reliability.positionCells.filter(matchesSummary).filter((row) => itemKeys.has(`${row.modelConfig}::${row.bankId}::${row.itemId}`));
    const models = A.unique(filteredRecords().map((row) => row.modelConfig));
    const top = A.mean(cells.map((cell) => cell.topAgreement));
    const full = A.mean(cells.map((cell) => cell.fullAgreement));
    const tau = A.mean(cells.map((cell) => cell.kendallTau));
    const positionTop = A.mean(positionCells.map((cell) => cell.topAgreement));
    const varianceDiagnostic = analysis.reliability.varianceDiagnostics || {};
    const ratio = varianceDiagnostic.ratio;
    const completeItems = itemRows.filter((row) => row.repeatStatus === "COMPLETE").length;
    $("#reliabilityMetrics").innerHTML = [
      metricCard("严格完整ItemID", `${completeItems}/${itemRows.length}`, `RepeatIndex 1—${analysis.plannedRepeats}`, completeItems === itemRows.length && itemRows.length ? "good" : "warn", "计划重复固定为5；每个ItemID必须恰有一条1、2、3、4、5且映射与元数据无冲突。"),
      metricCard("首选一致率", pct(top), "内部复查线 80%", Number.isFinite(top) ? (top >= 0.8 ? "good" : "bad") : "warn", "先按单元计算 max_l count(TopChoice=l)/R，再跨单元取均值。"),
      metricCard("完整排序一致", pct(full), "内部重点复查线 70%", Number.isFinite(full) ? (full >= 0.7 ? "good" : "bad") : "warn", "先按单元计算 max_π count(Ranking=π)/R，再跨单元取均值。"),
      metricCard("平均 Kendall τ", num(tau, 3), "排序层面的成对一致", Number.isFinite(tau) ? (tau >= 0.6 ? "good" : "warn") : "warn", "同一单元的有效重复两两计算 τ=(C−D)/(C+D)，再跨单元取均值。"),
      metricCard("位置首选一致", pct(positionTop), `${positionCells.length} 个多排列条件`, Number.isFinite(positionTop) ? (positionTop >= 0.8 ? "good" : "bad") : "warn", "仅在同一 ItemID 出现至少2种 PermutationID 时，对其首选一致率取均值。"),
      metricCard("描述性模型间/模型内方差比", num(ratio, 2), varianceDiagnostic.ratioStatus || `${models.length} 个配置`, Number.isFinite(ratio) ? "info" : "warn", "按BankDatasetID×ItemID匹配；该比值仅作描述，不称ICC。模型内方差为0时返回NA。"),
    ].join("");
    C.horizontalBars($("#reliabilityChart"), cells.sort((a, b) => a.topAgreement - b.topAgreement).slice(0, 35).map((cell) => ({ label: `${cell.modelConfig} · ${cell.itemId}`, value: cell.topAgreement, color: cell.topAgreement >= 0.8 ? "#188f82" : "#b64b62" })), { min: 0, max: 1, left: 260, empty: "当前每题只有 1 次有效运行，无法计算重复一致性" });

    $("#itemRepeatTable").innerHTML = itemRows.slice(0, 200).map((row) => `<tr><td>${escape(row.modelConfig)}</td><td>${escape(row.bankLabel)}</td><td>${escape(row.itemId)}</td><td class="num">${row.validRepeats}/${row.plannedRepeats}</td><td class="num">${num(row.pMean, 3)}</td><td class="num">${num(row.pSd, 3)}</td><td class="num">${row.permutationCount}</td><td>${statusPill(row.repeatStatus, row.repeatStatus === "COMPLETE" ? "good" : "warn")}</td><td>${escape(row.repeatReason)}</td></tr>`).join("") || `<tr><td colspan="9" class="na">当前筛选没有ItemID重复汇总。</td></tr>`;
    const globalModel = $("#modelFilter").value;
    const globalBank = $("#bankFilter").value;
    const positionRows = analysis.positionDiagnostics.filter((row) => (globalModel === "ALL" || row.modelConfig === globalModel) && (globalBank === "ALL" || row.bankId === globalBank));
    $("#positionDiagnosticsTable").innerHTML = positionRows.map((row) => `<tr><td>${escape(row.modelConfig)}</td><td>${escape(row.bankLabel)}</td><td>${row.observedPermutationCount}/6<br><small>${escape(row.observedPermutationIds.join("、"))}</small></td><td class="num">${pct(row.displayTopProportions.opt1)}</td><td class="num">${pct(row.displayTopProportions.opt2)}</td><td class="num">${pct(row.displayTopProportions.opt3)}</td><td class="num">${pct(row.itemCenteredDisplayTopProportions.opt1)} / ${pct(row.itemCenteredDisplayTopProportions.opt2)} / ${pct(row.itemCenteredDisplayTopProportions.opt3)}</td><td class="num">${row.eligibleItemCount}</td><td>${statusPill(row.status, "info")}</td></tr>`).join("") || `<tr><td colspan="9" class="na">当前筛选没有位置随机化诊断。</td></tr>`;

    const sim = analysis.similarity;
    if (sim.models.length >= 2) {
      C.heatmap($("#similarityHeatmap"), sim.models, sim.models, sim.matrix, { min: -1, max: 1, cell: 48 });
      $("#similarityNote").textContent = "每个模型以共享三级分类的方向均值组成画像向量，矩阵单元为 Pearson r。ModelConfig 少于 4 或共享坐标很少时仅作描述。";
    } else {
      C.empty($("#similarityHeatmap"), "只有 1 个 ModelConfig，无法生成模型画像相似性矩阵");
      $("#similarityNote").textContent = "建议导入 4–8 个 ModelConfig，覆盖 2–3 个模型家族。";
    }

    const comparisons = analysis.comparisons.filter((row) => {
      const model = $("#modelFilter").value;
      const bank = $("#bankFilter").value;
      const category = $("#categoryFilter").value;
      return (model === "ALL" || row.modelA === model || row.modelB === model) && (bank === "ALL" || row.bankId === bank) && (category === "ALL" || row.categoryKey === category);
    });
    $("#modelComparisonTable").innerHTML = comparisons.map((row) => `<tr><td>${escape(`${row.bankLabel} / ${row.category}`)}</td><td>${escape(row.modelA)}</td><td>${escape(row.modelB)}</td><td class="num">${row.n}</td><td class="num">${num(row.difference, 3)}</td><td class="num">${row.ciLow == null ? "NA" : `[${num(row.ciLow, 3)}, ${num(row.ciHigh, 3)}]`}</td><td class="num">${row.p == null ? "NA" : num(row.p, 4)}</td><td class="num">${row.pHolm == null ? "NA" : `${num(row.pHolm, 4)} ${significance(row.pHolm)}`}</td></tr>`).join("") || `<tr><td colspan="8" class="na">至少需要 2 个 ModelConfig 在相同 GroupID 上有匹配结果；n&lt;5 时不进行置换检验。</td></tr>`;
  }

  function renderCards() {
    const analysis = state.analysis;
    const query = $("#cardSearch").value.trim().toLowerCase();
    const status = $("#cardStatus").value;
    const filtered = analysis.cards.filter((card) => {
      const globalMatch = globalFilter({ modelConfig: $("#modelFilter").value === "ALL" ? "" : $("#modelFilter").value, bankId: card.bankId, categoryKey: `${card.bankId}::${card.categoryId}` });
      const bank = $("#bankFilter").value;
      const category = $("#categoryFilter").value;
      const visible = (bank === "ALL" || card.bankId === bank) && (category === "ALL" || `${card.bankId}::${card.categoryId}` === category);
      const model = $("#modelFilter").value;
      const domainVisible = !hasActiveDomainSubset() || (analysis.domain && analysis.domain.groupAudit || []).some((row) => row.bankId === card.bankId && row.groupId === card.groupId && (model === "ALL" || row.modelConfig === model) && localDomainMatch(row));
      const text = `${card.groupId} ${card.itemIds.join(" ")} ${card.category} ${card.bankLabel}`.toLowerCase();
      return globalMatch && visible && domainVisible && (status === "ALL" || card.status === status) && (!query || text.includes(query));
    });
    const pageSize = 20;
    const pages = Math.max(1, Math.ceil(filtered.length / pageSize));
    state.cardPage = Math.min(state.cardPage, pages);
    const rows = filtered.slice((state.cardPage - 1) * pageSize, state.cardPage * pageSize);
    const kindMap = { REVIEW: "bad", MORE_DATA: "warn", PROVISIONAL: "good", BLOCKED: "bad" };
    $("#decisionCards").innerHTML = rows.map((card) => `<article class="decision-card">
      <header><div><span class="card-bank">${escape(card.bankLabel)} · ${escape(card.category)}</span><h3>${escape(card.groupId)}</h3></div>${statusPill(card.statusLabel, kindMap[card.status])}</header>
      <div class="body">
        <div class="decision-mini-grid"><div><small>修复后有效 <span class="info-tip static" tabindex="0" data-tip="VALID 与 REPAIRED_VALID 占非技术响应的比例。">i</span></small><b>${pct(card.finalValidRate)}</b></div><div><small>首选一致 <span class="info-tip static" tabindex="0" data-tip="众数 TopChoice 次数 / 有效重复数。">i</span></small><b>${pct(card.topAgreement)}</b></div><div><small>条件覆盖 <span class="info-tip static" tabindex="0" data-tip="观察到的 ConditionCode 数 / 题库计划条件数。">i</span></small><b>${card.observedConditions}/${card.expectedConditions}</b></div><div><small>模型配置 <span class="info-tip static" tabindex="0" data-tip="覆盖该 GroupID 的不同 ModelConfig 数。">i</span></small><b>${card.models}</b></div></div>
        <ul class="issue-list">${card.issues.length ? card.issues.map((issue) => `<li>${escape(issue)}</li>`).join("") : "<li>未触发数据预警</li>"}</ul>
        <details><summary>查看证据与建议</summary><p><b>ItemID：</b>${escape(card.itemIds.join("、"))}</p><p><b>题组 E：</b>${card.effects.length ? card.effects.map((effect) => `${escape(effect.contrastId)}=${num(effect.effect, 3)}`).join("；") : "尚不可估计"}</p><p><b>处理建议：</b>${escape(card.recommendation)}</p></details>
      </div></article>`).join("") + (filtered.length ? `<div class="pagination"><button class="btn btn-quiet btn-small" data-page="prev" ${state.cardPage === 1 ? "disabled" : ""}>上一页</button><span>${state.cardPage} / ${pages} · ${filtered.length} 个 GroupID</span><button class="btn btn-quiet btn-small" data-page="next" ${state.cardPage === pages ? "disabled" : ""}>下一页</button></div>` : `<div class="chart-empty">没有符合筛选条件的题目决策卡</div>`);
  }

  function renderAudit() {
    const analysis = state.analysis;
    const score = analysis.audit.score;
    $("#auditScore").innerHTML = `<div class="audit-score-card"><div><strong>${score}</strong><small>/ 100 链路完整度 <span class="info-tip static" tabindex="0" data-tip="round{100×(通过项+0.5×警告项)/全部检查项}；失败项计0分。">i</span></small></div><p>${score >= 80 ? "两个必需CSV、评分映射与主要分析链路已建立；仍应逐条处理警告项。" : "当前链路存在缺口。建议补齐两个必需CSV、题库元数据或关键评分字段后再形成正式报告。"}</p></div>`;
    $("#auditList").innerHTML = analysis.audit.checks.map((check) => `<div class="audit-row ${check.status === "pass" ? "" : check.status}"><i>${check.status === "pass" ? "✓" : check.status === "warn" ? "!" : "×"}</i><span><b>${escape(check.label)}</b><small>${escape(check.detail)}</small></span><em>${check.status === "pass" ? "通过" : check.status === "warn" ? "需留意" : "未通过"}</em></div>`).join("");
    const identityRows = [
      ...analysis.datasetManifest.map((row) => ({ type: "BankDataset", identity: row.bankDatasetId, sources: row.bankPartIds.join("；"), fingerprint: row.bankContentHash, status: row.compositionConflictCount ? "DATASET_COMPOSITION_CONFLICT" : "VALID", reason: `${row.itemCount}个ItemID；${row.bankPartCount}个BankPart` })),
      ...analysis.modelConfigAudit.map((row) => ({ type: "AnalysisModel", identity: row.analysisModelKey, sources: `${row.rawModelConfigIds.join("；")}｜ApiMode=${(row.apiModes || []).join("/") || "NA"}${row.inferredRecordCount ? `｜唯一值补全=${row.inferredRecordCount}条` : ""}`, fingerprint: row.coreFingerprint, status: row.status, reason: row.reason })),
    ];
    $("#identityAuditTable").innerHTML = identityRows.map((row) => `<tr><td>${escape(row.type)}</td><td><code>${escape(row.identity)}</code></td><td>${escape(row.sources)}</td><td><code>${escape(row.fingerprint)}</code></td><td>${statusPill(row.status, /(CONFLICT|AMBIGUOUS)/.test(row.status) ? "bad" : "good")}</td><td>${escape(row.reason)}</td></tr>`).join("") || `<tr><td colspan="6" class="na">暂无身份审计结果</td></tr>`;
    $("#auditRows").innerHTML = filteredRecords().slice(0, 80).map((row) => `<tr><td>${escape(row.batchName)}</td><td>${escape(row.requestId || "NA")}</td><td>${escape(row.modelConfig)}</td><td>${escape(row.itemId)}</td><td>${escape(row.permutationId || "NA")}</td><td>${escape(row.displayedRanking || "NA")}</td><td>${escape(row.sourceRanking || "NA")}</td><td>${escape(row.logicalRanking || "NA")}</td><td>${escape(`${row.mappingStatus} / ${row.repeatStatus}`)}</td><td class="num">${num(row.preference, 2)}</td></tr>`).join("") || `<tr><td colspan="10" class="na">当前筛选没有记录</td></tr>`;
  }

  function domainEffectStats(rows) {
    const grouped = new Map();
    rows.filter((row) => row.valid && Number.isFinite(row.effect)).forEach((row) => {
      const key = `${row.modelConfig}::${row.categoryKey}::${row.contrastId}::${row.domainKey}`;
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key).push(row);
    });
    const summaries = new Map((state.analysis.effects.summaries || []).map((row) => [`${row.modelConfig}::${row.categoryKey}::${row.contrastId}`, row]));
    const result = new Map();
    grouped.forEach((effects, key) => {
      const values = effects.map((row) => row.effect);
      const n = values.length;
      const meanE = D.mean(values);
      const sdE = D.sd(values);
      const summary = summaries.get(`${effects[0].modelConfig}::${effects[0].categoryKey}::${effects[0].contrastId}`);
      const computable = !!(summary && summary.eligible && n >= 2 && Number.isFinite(sdE) && Math.abs(sdE) > 1e-12);
      const cohenD = computable ? meanE / sdE : null;
      const correction = n > 1 ? 1 - 3 / (4 * (n - 1) - 1) : null;
      result.set(key, {
        n, meanE, sdE, cohenD, hedgesG: computable ? cohenD * correction : null, computable,
        reason: !summary || !summary.eligible ? "原Category正式覆盖不足" : n < 2 ? "当前Domain仅1个有效GroupID" : !Number.isFinite(sdE) || Math.abs(sdE) <= 1e-12 ? "Domain内Group E的SD为0" : "探索性Domain标准化效应",
      });
    });
    return result;
  }

  function renderDomainProfile() {
    const domain = state.analysis.domain || { qa: {}, catalog: [], effectProfile: [], reliabilitySummary: [] };
    const qa = domain.qa || {};
    const selected = selectedDomainKeys();
    const catalog = (domain.catalog || []).filter((row) => selected.has(row.domainKey) && ($("#bankFilter").value === "ALL" || row.bankId === $("#bankFilter").value));
    $("#domainMetrics").innerHTML = [
      metricCard("Bank隔离Domain", String(catalog.length), `${domain.catalog.length} 个目录项`, "info", "DomainKey=BankDatasetID::Source_Domain；跨Bank近义名称不自动合并。"),
      metricCard("Item Domain冲突", String(qa.itemConflictCount || 0), `${qa.missingItemCount || 0} 个Item缺失`, qa.itemConflictCount || qa.missingItemCount ? "bad" : "good", "只有同一BankDatasetID＋ItemID跨Repeat出现多个Domain才是DOMAIN_ITEM_CONFLICT。"),
      metricCard("混合Domain题组", String(qa.mixedGroupCount || 0), `${qa.homogeneousGroupCount || 0} homogeneous`, qa.mixedGroupCount ? "warn" : "good", "MIXED_DOMAIN_GROUP不是数据错误；旧P/E/D保留，仅禁止整组E归入单一Domain。"),
      metricCard("Domain可归属题组", String(qa.eligibleGroupCount || 0), `${qa.missingGroupCount || 0} missing`, "info", "只有HOMOGENEOUS_DOMAIN_GROUP可进入Domain E与Domain Gap。"),
      metricCard("操作模式", state.domainCompareMode === "COMPARE_SELECTED" ? "横向比较" : "查看所选", $("#bankFilter").value === "ALL" ? "Bank=ALL仅覆盖概览" : "不重算正式D", "info", "任意Domain子集只形成描述性SelectedDomainMeanE。"),
    ].join("");
    $("#domainCatalogTable").innerHTML = catalog.map((row) => `<tr><td>${escape(row.bankLabel)}</td><td><b>${escape(row.domain)}</b><br><code>${escape(row.domainKey)}</code></td><td class="num">${row.recordCount}</td><td class="num">${row.itemCount}</td><td class="num">${row.groupCount}</td><td>${escape((row.sourceTypes || []).join("、") || "NA")}</td></tr>`).join("") || `<tr><td colspan="6" class="na">当前未选择Domain；旧版正式统计未被删除。</td></tr>`;

    const conditions = (domain.conditionProfile || []).filter((row) => domainGlobalMatch(row) && selected.has(row.domainKey));
    $("#domainConditionTable").innerHTML = conditions.map((row) => `<tr><td>${escape(row.modelConfig)}<br>${escape(row.bankLabel)}</td><td>${escape(`${row.categoryId} ${row.category}`)}</td><td>${escape(row.domain)}</td><td>${escape(row.conditionCode)}<br><small>${escape(row.conditionLabel || "")}</small></td><td class="num">${num(row.meanP, 3)} / ${num(row.sdP, 3)}</td><td class="num">${row.itemCount}</td><td class="num">${row.groupCount}</td><td class="num">${row.validN}</td></tr>`).join("") || `<tr><td colspan="8" class="na">当前筛选没有可比较的Domain条件P画像。</td></tr>`;

    const effects = (domain.effectProfile || []).filter((row) => domainGlobalMatch(row) && selected.has(row.domainKey));
    const domainStats = domainEffectStats(effects);
    $("#domainEffectTable").innerHTML = effects.map((row) => {
      const stats = domainStats.get(`${row.modelConfig}::${row.categoryKey}::${row.contrastId}::${row.domainKey}`) || {};
      const domainG = Number.isFinite(stats.hedgesG) ? num(stats.hedgesG, 3) : `NA（${stats.reason || "不可计算"}）`;
      return `<tr><td>${escape(row.modelConfig)}</td><td>${escape(row.bankLabel)}<br>${escape(`${row.categoryId} ${row.category}`)}</td><td>${escape(row.domain)}</td><td>${escape(row.groupId)}</td><td>${escape(row.contrastId)}</td><td class="num">${num(row.effect, 3)}</td><td>${escape(domainG)}</td><td>${statusPill(row.valid ? "E可比较" : "E不可计算", row.valid ? "good" : "warn")}</td></tr>`;
    }).join("") || `<tr><td colspan="8" class="na">当前筛选没有可归属单一Domain的题组E。</td></tr>`;

    const reliability = (domain.reliabilitySummary || []).filter((row) => domainGlobalMatch(row) && selected.has(row.domainKey));
    $("#domainReliabilityTable").innerHTML = reliability.map((row) => `<tr><td>${escape(row.modelConfig)}<br>${escape(row.bankLabel)}</td><td>${escape(row.domain)}</td><td class="num">${row.itemCount}</td><td class="num">${num(row.meanKendallTau, 3)}</td><td class="num">${num(row.meanPSd, 3)}</td><td class="num">${row.directionFlipCount}/${row.directionalItemCount} · ${pct(row.directionFlipRate)}</td></tr>`).join("") || `<tr><td colspan="6" class="na">当前筛选没有Domain重复稳定性结果。</td></tr>`;

    const heterogeneityGroups = new Map();
    effects.filter((row) => row.valid && Number.isFinite(row.effect)).forEach((row) => {
      const key = `${row.modelConfig}::${row.categoryKey}::${row.contrastId}`;
      if (!heterogeneityGroups.has(key)) heterogeneityGroups.set(key, []);
      heterogeneityGroups.get(key).push(row);
    });
    const heterogeneityRows = [];
    heterogeneityGroups.forEach((rows) => {
      const byDomain = new Map();
      rows.forEach((row) => { if (!byDomain.has(row.domainKey)) byDomain.set(row.domainKey, []); byDomain.get(row.domainKey).push(row.effect); });
      const values = Array.from(byDomain.values()).map((domainValues) => D.mean(domainValues));
      const first = rows[0];
      const q1 = D.quantile(values, .25); const q3 = D.quantile(values, .75);
      const signs = values.map((value) => value > 1e-12 ? 1 : value < -1e-12 ? -1 : 0);
      const consistency = values.length ? Math.max(...[1, -1, 0].map((sign) => signs.filter((value) => value === sign).length)) / values.length : null;
      heterogeneityRows.push({ ...first, domainCount: values.length, min: Math.min(...values), max: Math.max(...values), sd: D.sd(values), iqr: Number.isFinite(q1) && Number.isFinite(q3) ? q3 - q1 : null, consistency });
    });
    $("#domainHeterogeneityTable").innerHTML = state.domainCompareMode === "COMPARE_SELECTED"
      ? heterogeneityRows.map((row) => `<tr><td>${escape(`${row.categoryId}/${row.contrastId}`)}</td><td class="num">${row.domainCount}</td><td class="num">${num(row.min, 3)} – ${num(row.max, 3)}</td><td class="num">${num(row.sd, 3)}</td><td class="num">${num(row.iqr, 3)}</td><td class="num">${pct(row.consistency)}</td></tr>`).join("") || `<tr><td colspan="6" class="na">至少需要一个可归属Domain的有效题组E。</td></tr>`
      : `<tr><td colspan="6" class="na">“查看所选情境”仅限制展示范围；切换到“横向比较所选情境”后显示描述性Domain差值与异质性摘要。</td></tr>`;
  }

  function renderSameTaskHuman() {
    const human = state.analysis.humanReference || {};
    const qa = human.qa || {};
    const selected = selectedDomainKeys();
    $("#humanMetrics").innerHTML = [
      metricCard("Human有效记录", String(qa.includedRows || 0), `${qa.excludedRows || 0} 排除`, qa.excludedRows ? "warn" : "good", "仅保留匿名ParticipantID与排序/匹配分析字段；不导出IP、位置、设备或人口学字段。"),
      metricCard("严格同题匹配", String(qa.exactMatchCount || 0), `${qa.mismatchCount || 0} mismatch`, qa.mismatchCount ? "bad" : "good", "按BankDatasetID、ItemID、ConditionCode、ItemVersion和兼容Source_ContentDigest核验。"),
      metricCard("Human参与者", Object.values(qa.participantCountByBank || {}).join(" / ") || "0", "模糊 / 跨期 / CNI", "info", "每个数据集按匿名ParticipantID等权；不以记录数给参与者隐性加权。"),
      metricCard("Scenario resampling", "5,000", "固定seed 20260827", "info", "仅Human Gap独立模块按GroupID重采样；旧E/D Bootstrap仍为FROZEN_NOT_RUN。"),
      metricCard("CNI正式参数", "阻断", "METADATA_BLOCKED", "warn", "只允许探索性Pr(L1>L2)条件差与L3首选，不宣称C/N/I参数。"),
    ].join("");
    const gaps = (human.groupGaps || []).filter((row) => row.computable && domainGlobalMatch(row) && (!row.domainKey || selected.has(row.domainKey)));
    $("#humanGapTable").innerHTML = gaps.map((row) => `<tr><td>${escape(row.modelConfig)}<br>${escape(row.bankLabel)}</td><td>${escape(`${row.categoryId} ${row.category}`)}</td><td>${escape(row.domain || "未归属")}</td><td>${escape(row.groupId)}</td><td>${escape(row.contrastId)}</td><td class="num">${num(row.aiRawShift, 3)}</td><td class="num">${num(row.humanRawShift, 3)}</td><td class="num">${num(row.gapDeltaP, 3)}</td><td class="num">${num(row.aiE, 3)}</td><td class="num">${num(row.humanE, 3)}</td><td class="num">${num(row.gapE, 3)}</td><td>${statusPill("可比较", "good")}</td></tr>`).join("") || `<tr><td colspan="12" class="na">当前筛选没有可计算的同题AI—Human方向效应。</td></tr>`;
    const gapSummaries = (human.gapSummaries || []).filter(domainGlobalMatch);
    $("#humanGapSummaryTable").innerHTML = gapSummaries.map((row) => {
      const interval = Number.isFinite(row.scenarioResamplingInterval95Low) && Number.isFinite(row.scenarioResamplingInterval95High)
        ? `[${num(row.scenarioResamplingInterval95Low, 3)}, ${num(row.scenarioResamplingInterval95High, 3)}]`
        : "NA";
      return `<tr><td>${escape(row.modelConfig)}<br>${escape(row.bankLabel)}</td><td>${escape(`${row.categoryId}/${row.contrastId}`)}</td><td class="num">${num(row.meanAiRawShift, 3)}</td><td class="num">${num(row.meanHumanRawShift, 3)}</td><td class="num">${num(row.gapDeltaP, 3)}</td><td class="num">${num(row.gapE, 3)}</td><td class="num">${row.validGroups}/${row.plannedGroups} · ${pct(row.coverage)}</td><td class="num">${interval}</td><td>${statusPill(row.computable ? "可计算" : "描述性", row.computable ? "good" : "warn")}<br><small>${escape(row.reason)}</small></td></tr>`;
    }).join("") || `<tr><td colspan="9" class="na">当前筛选没有Human分类Gap汇总。</td></tr>`;
    const singles = (human.singleLevelComparisons || []).filter((row) => domainGlobalMatch(row) && (!row.domainKey || selected.has(row.domainKey)));
    $("#humanSingleTable").innerHTML = singles.map((row) => `<tr><td>${escape(row.modelConfig)}<br>${escape(`${row.categoryId} ${row.category}`)}</td><td>${escape(row.domain || "NA")}</td><td>${escape(`${row.groupId}/${row.conditionCode}`)}</td><td class="num">${num(row.aiMeanP, 3)} / ${num(row.humanMeanP, 3)}</td><td class="num">${num(row.aiHumanPLevelDifference, 3)}</td><td>${[row.aiTop.l1Top, row.aiTop.l2Top, row.aiTop.l3Top].map((value) => pct(value)).join(" / ")}</td><td>${[row.humanTop.l1Top, row.humanTop.l2Top, row.humanTop.l3Top].map((value) => pct(value)).join(" / ")}</td><td>${[row.aiTop.meanRankL1, row.aiTop.meanRankL2, row.aiTop.meanRankL3].map((value) => num(value, 2)).join(" / ")}</td><td>${[row.humanTop.meanRankL1, row.humanTop.meanRankL2, row.humanTop.meanRankL3].map((value) => num(value, 2)).join(" / ")}</td></tr>`).join("") || `<tr><td colspan="9" class="na">当前筛选没有DIRECTIONAL_RANK＋SINGLE同题比较。</td></tr>`;
    const nominal = (human.nominalDistributions || []).filter((row) => domainGlobalMatch(row) && (!row.domainKey || selected.has(row.domainKey)));
    $("#humanNominalTable").innerHTML = nominal.map((row) => `<tr><td>${escape(row.modelConfig)}<br>${escape(`${row.categoryId} ${row.category}`)}</td><td>${escape(row.domain || "NA")}</td><td>${escape(`${row.groupId}/${row.conditionCode}`)}</td><td>${[row.ai.l1Top, row.ai.l2Top, row.ai.l3Top].map((value) => pct(value)).join(" / ")}</td><td>${[row.human.l1Top, row.human.l2Top, row.human.l3Top].map((value) => pct(value)).join(" / ")}</td><td>${[row.l1TopGap, row.l2TopGap, row.l3TopGap].map((value) => num(value, 3)).join(" / ")}</td><td>${[row.ai.meanRankL1, row.ai.meanRankL2, row.ai.meanRankL3].map((value) => num(value, 2)).join(" / ")}</td><td>${[row.human.meanRankL1, row.human.meanRankL2, row.human.meanRankL3].map((value) => num(value, 2)).join(" / ")}</td></tr>`).join("") || `<tr><td colspan="8" class="na">当前筛选没有NOMINAL策略比较；A3E/B5不会进入P/E/GapΔP。</td></tr>`;
    const cni = human.cniDescriptive || { comparisons: [], l3Top: [] };
    const comparisonRows = (cni.comparisons || []).filter((row) => domainGlobalMatch(row) && (!row.domainKey || selected.has(row.domainKey))).map((row) => ({ type: `L1>L2 · ${row.contrastId}`, modelConfig: row.modelConfig, domain: row.domain, groupCondition: row.groupId, ai: row.aiDescriptiveDifference, human: row.humanDescriptiveDifference, gap: row.aiHumanDescriptiveGap, status: `${row.status} / ${row.parameterStatus}` }));
    const l3Rows = (cni.l3Top || []).filter((row) => domainGlobalMatch(row) && (!row.domainKey || selected.has(row.domainKey))).map((row) => ({ type: "Pr(L3 top)", modelConfig: row.modelConfig, domain: row.domain, groupCondition: row.conditionCode, ai: row.aiL3TopRate, human: row.humanL3TopRate, gap: row.l3TopRateGap, status: row.status }));
    $("#cniHumanTable").innerHTML = comparisonRows.concat(l3Rows).map((row) => `<tr><td>${escape(row.type)}</td><td>${escape(row.modelConfig)}<br>${escape(row.domain || "NA")}</td><td>${escape(row.groupCondition)}</td><td class="num">${num(row.ai, 3)}</td><td class="num">${num(row.human, 3)}</td><td class="num">${num(row.gap, 3)}</td><td>${statusPill(row.status, "warn")}</td></tr>`).join("") || `<tr><td colspan="7" class="na">当前筛选没有CNI探索性Human结果。</td></tr>`;
  }

  function riskSelectionKey(row) { return `${row.modelConfig}::${row.categoryId}::${row.groupId}`; }
  function sameRiskBase(left, right) { return left == null && right == null || Number(left) === Number(right); }
  function riskScopeName() { return $("#riskCurveScope") && $("#riskCurveScope").value === "GROUP" ? "GROUP" : "CATEGORY_EQUAL_GROUP"; }
  function riskDomainVisible(row, scope) { return scope !== "GROUP" || !hasActiveDomainSubset() || selectedDomainKeys().has(row.domainKey); }

  function populateRiskCurveSelector() {
    if (!state.analysis || !state.analysis.riskReference || !$("#riskCurveSelector")) return;
    const previous = $("#riskCurveSelector").value;
    const scope = riskScopeName();
    const seen = new Set();
    const options = (state.analysis.riskReference.curvePoints || [])
      .filter((row) => row.curveScope === scope && domainGlobalMatch(row) && riskDomainVisible(row, scope))
      .filter((row) => { const key = riskSelectionKey(row); if (seen.has(key)) return false; seen.add(key); return true; })
      .map((row) => ({
        value: riskSelectionKey(row),
        label: scope === "CATEGORY_EQUAL_GROUP"
          ? `${row.modelConfig} · ${row.categoryId} ${row.category} · 四情境等权总体`
          : `${row.modelConfig} · ${row.categoryId} ${row.category} · ${row.domain || row.groupId} · ${row.groupId}`,
      }));
    populateSelect($("#riskCurveSelector"), options, null, previous || (options[0] && options[0].value));
  }

  function appendRiskChart(container, basePoints, thresholdRow, comparisonPoints, compareMode) {
    const panel = document.createElement("section");
    panel.className = "risk-chart-panel";
    const heading = document.createElement("h3");
    heading.textContent = basePoints[0].baseProbability == null ? "本维度综合曲线" : `基础概率 ${num(basePoints[0].baseProbability, 2)}（单独计算）`;
    const summary = document.createElement("p");
    const thresholdText = thresholdRow && Number.isFinite(thresholdRow.thresholdEstimate) ? num(thresholdRow.thresholdEstimate, 4) : thresholdRow && thresholdRow.thresholdInequality || "无唯一范围内拐点";
    summary.textContent = `P=0拐点：${thresholdText}；状态：${thresholdRow ? thresholdRow.thresholdStatus : "NA"}；计划横轴点覆盖：${thresholdRow ? `${thresholdRow.eligiblePointCount}/${thresholdRow.expectedPointCount}` : "NA"}。`;
    const chart = document.createElement("div");
    chart.className = "chart tall-chart";
    panel.append(heading, summary, chart);
    container.appendChild(panel);
    const curves = new Map();
    (comparisonPoints || basePoints).forEach((row) => {
      const key = `${row.domainKey}::${row.groupId}`;
      if (!curves.has(key)) curves.set(key, []);
      curves.get(key).push(row);
    });
    const rawColors = ["#7357d8", "#d17432", "#2e75b6", "#9a4772", "#4c7d3e", "#b64c4c"];
    const isoColors = ["#188f82", "#c49a2b", "#65a9d8", "#bd7da1", "#82a96a", "#dc8b83"];
    const series = [];
    Array.from(curves.values()).forEach((curve, index) => {
      curve.sort((a, b) => a.x - b.x);
      const prefix = compareMode ? curve[0].domain : (curve[0].curveScope === "CATEGORY_EQUAL_GROUP" ? "四情境等权" : curve[0].domain);
      series.push({ label: `${prefix} · 原始mean P`, color: rawColors[index % rawColors.length], points: curve.map((row) => ({ x: row.x, y: row.meanP })) });
      series.push({ label: `${prefix} · Isotonic敏感性`, color: isoColors[index % isoColors.length], points: curve.map((row) => ({ x: row.x, y: row.isotonicP })) });
    });
    C.numericMultiLine(chart, series, {
      min: -1, max: 1, xLabel: basePoints[0].xFactor,
      referenceX: thresholdRow && thresholdRow.humanReference,
      referenceLabel: "全球学生模型参照",
      label: "风险原始P曲线、isotonic敏感性和文献外部参照",
    });
  }

  function renderRiskReference() {
    const risk = state.analysis.riskReference || { referenceParameters: [], curvePoints: [], thresholds: [], rankingDistributions: [] };
    const scope = riskScopeName();
    const selectedDomains = selectedDomainKeys();
    const thresholds = (risk.thresholds || []).filter((row) => row.curveScope === scope && domainGlobalMatch(row) && riskDomainVisible(row, scope));
    const familyCount = new Set(thresholds.map((row) => `${row.modelConfig}::${row.categoryId}::${row.groupId}`)).size;
    $("#riskReferenceMetrics").innerHTML = [
      metricCard("当前分析层级", scope === "CATEGORY_EQUAL_GROUP" ? "维度综合" : "分应用情境", scope === "CATEGORY_EQUAL_GROUP" ? "四个GroupID等权" : "单个GroupID", "info", "维度综合是主结果；分情境用于检查异质性及单独查看金钱领域。"),
      metricCard("曲线族", String(familyCount), `${thresholds.length} 条基础概率曲线`, "info", "A1/B1各含三个互不合并的基础概率曲线。"),
      metricCard("唯一原始跨零", String(thresholds.filter((row) => row.thresholdStatus === "OK").length), "P=0正式主结果", "good", "仅相邻真实测试点形成唯一跨越时插值；不外推。"),
      metricCard("覆盖阻断", String(thresholds.filter((row) => row.thresholdStatus === "COVERAGE_BLOCKED").length), "缺情境/缺横轴点时不求正式拐点", thresholds.some((row) => row.thresholdStatus === "COVERAGE_BLOCKED") ? "warn" : "good", "每Item至少4/5有效重复；综合点还必须覆盖全部四个应用情境。"),
      metricCard("外部参照", String((risk.referenceParameters || []).filter((row) => row.primary).length), "2939名学生 / 30国", "info", "这是论文总体模型换算值，不是当前题库同题Human样本；跨非金钱情境只作探索性参照。"),
    ].join("");
    populateRiskCurveSelector();
    const key = $("#riskCurveSelector").value;
    const points = (risk.curvePoints || []).filter((row) => row.curveScope === scope && riskSelectionKey(row) === key).sort((a, b) => (a.baseProbability == null ? -Infinity : a.baseProbability) - (b.baseProbability == null ? -Infinity : b.baseProbability) || a.x - b.x);
    const chartContainer = $("#riskReferenceChart");
    chartContainer.innerHTML = "";
    if (points.length) {
      const compareMode = scope === "GROUP" && state.domainCompareMode === "COMPARE_SELECTED" && $("#bankFilter").value === "risk";
      const baseValues = [];
      points.forEach((row) => { if (!baseValues.some((value) => sameRiskBase(value, row.baseProbability))) baseValues.push(row.baseProbability); });
      baseValues.forEach((baseProbability) => {
        const basePoints = points.filter((row) => sameRiskBase(row.baseProbability, baseProbability));
        const thresholdRow = (risk.thresholds || []).find((row) => riskSelectionKey(row) === key && sameRiskBase(row.baseProbability, baseProbability));
        const comparisonPoints = compareMode
          ? (risk.curvePoints || []).filter((row) => row.curveScope === "GROUP" && row.modelConfig === basePoints[0].modelConfig && row.categoryId === basePoints[0].categoryId && sameRiskBase(row.baseProbability, baseProbability) && selectedDomains.has(row.domainKey))
          : basePoints;
        appendRiskChart(chartContainer, basePoints, thresholdRow, comparisonPoints, compareMode);
      });
      $("#riskReferenceNote").textContent = scope === "CATEGORY_EQUAL_GROUP"
        ? `${points[0].modelConfig} · ${points[0].categoryId}：每个横轴点先求各应用情境的ItemID-first均值，再对四个GroupID等权。${baseValues.length > 1 ? `本维度含${baseValues.length}个基础概率，因此上方分成${baseValues.length}幅图并分别求拐点；不存在共同拐点。` : ""} 人类竖线是论文总体模型的外部参照，跨非金钱情境的总体比较只作探索性描述。`
        : `${points[0].modelConfig} · ${points[0].categoryId}/${points[0].groupId} · ${points[0].domain}：分情境结果用于检查异质性；金融与财产情境是与论文任务最接近的补充比较。原始P为主，isotonic只作敏感性。`;
    } else {
      C.empty(chartContainer, scope === "CATEGORY_EQUAL_GROUP" ? "当前筛选没有风险维度综合曲线" : "当前筛选没有分应用情境曲线");
      $("#riskReferenceNote").textContent = "请将顶部子测验/分类筛选恢复到风险决策，或调整Domain选择。";
    }
    $("#riskThresholdTable").innerHTML = thresholds.map((row) => {
      const bracket = Number.isFinite(row.thresholdLowTested) || Number.isFinite(row.thresholdHighTested) ? `${num(row.thresholdLowTested, 3)} – ${num(row.thresholdHighTested, 3)}` : "NA";
      const estimate = Number.isFinite(row.thresholdEstimate) ? num(row.thresholdEstimate, 4) : row.thresholdInequality || "NA";
      const bridge = row.binaryBridgeSource === "NOT_AVAILABLE" || !Number.isFinite(row.binaryBridgeThreshold) ? `${row.binaryRawStatus} / ${row.logisticStatus}` : `${row.binaryBridgeSource} · ${num(row.binaryBridgeThreshold, 4)}`;
      const level = row.curveScope === "CATEGORY_EQUAL_GROUP" ? "维度综合（四情境等权）" : "分应用情境";
      const scenario = `${row.curveScope === "CATEGORY_EQUAL_GROUP" ? "总体" : row.domain || row.groupId}${row.baseProbability == null ? "" : ` / p=${num(row.baseProbability, 2)}`}`;
      return `<tr><td>${escape(row.modelConfig)}<br>${escape(`${row.categoryId} ${row.category}`)}</td><td>${escape(level)}</td><td>${escape(scenario)}</td><td class="num">${row.eligiblePointCount}/${row.expectedPointCount}</td><td>${escape(bracket)}</td><td>${escape(estimate)}</td><td>${statusPill(row.thresholdStatus, row.thresholdStatus === "OK" ? "good" : "warn")}<br><small>${escape(row.thresholdReason)}</small></td><td class="num">${num(row.humanReference, 4)}</td><td class="num">${num(row.differenceFromHuman, 4)}</td><td>${escape(bridge)}</td><td>${escape(row.referenceApplicability)}</td></tr>`;
    }).join("") || `<tr><td colspan="11" class="na">当前筛选没有该层级的风险拐点。</td></tr>`;

    const rankingRows = (risk.rankingDistributions || []).filter((row) => row.curveScope === scope && riskSelectionKey(row) === key).sort((a, b) => (a.baseProbability == null ? -Infinity : a.baseProbability) - (b.baseProbability == null ? -Infinity : b.baseProbability) || a.x - b.x);
    const rankings = R.COMPLETE_RANKINGS || ["L1>L2>L3", "L1>L3>L2", "L2>L1>L3", "L2>L3>L1", "L3>L1>L2", "L3>L2>L1"];
    $("#riskRankingTable").innerHTML = rankingRows.map((row) => {
      const proportions = row.rankingProportions || {};
      const level = row.curveScope === "CATEGORY_EQUAL_GROUP" ? "四情境等权" : row.domain || row.groupId;
      const xText = `${row.baseProbability == null ? "" : `p=${num(row.baseProbability, 2)} / `}${row.xFactor}=${num(row.x, 3)}`;
      const coverage = row.formalEligible ? statusPill("完整", "good") : statusPill("不足", "warn");
      return `<tr><td>${escape(row.modelConfig)}<br>${escape(row.categoryId)}</td><td>${escape(level)}</td><td>${escape(xText)}</td>${rankings.map((ranking) => `<td class="num">${pct(proportions[ranking])}</td>`).join("")}<td class="num">${pct(row.l2TopRate)}</td><td>${escape(row.modalRanking)}<br><small>${pct(row.modalProportion)}</small></td><td>${coverage}</td></tr>`;
    }).join("") || `<tr><td colspan="12" class="na">当前所选曲线没有逐横轴点的完整排序分布。</td></tr>`;
  }

  function renderEffectSizesAndIcc() {
    const effectRows = ((state.analysis.effectSizes || {}).categoryEffectSizes || []).filter(domainGlobalMatch);
    const modelFilter = $("#modelFilter").value;
    const bankFilter = $("#bankFilter").value;
    const categoryFilter = $("#categoryFilter").value;
    const modelEffectRows = ((state.analysis.effectSizes || {}).effectModelComparisons || []).filter((row) => (modelFilter === "ALL" || row.modelA === modelFilter || row.modelB === modelFilter) && (bankFilter === "ALL" || row.bankId === bankFilter) && (categoryFilter === "ALL" || row.categoryKey === categoryFilter));
    const icc = state.analysis.icc || { withinAiProfiles: [], crossAiCoreEffects: [] };
    const selected = selectedDomainKeys();
    const iccRows = (icc.withinAiProfiles || []).concat(icc.crossAiCoreEffects || []).filter((row) => domainGlobalMatch(row)).filter((row) => !row.domainKey || selected.has(row.domainKey));
    $("#effectSizeMetrics").innerHTML = [
      metricCard("Category d/g", String(effectRows.filter((row) => row.computable).length), `${effectRows.length} 个Category×Contrast`, "info", "以原Group E样本SD标准化；dScore仍是正式D。"),
      metricCard("d/g不可计算", String(effectRows.filter((row) => !row.computable).length), "n<2 / SD=0 / coverage不足", effectRows.some((row) => !row.computable) ? "warn" : "good", "不可计算返回null，不输出Infinity或0。"),
      metricCard("ICC可计算", String(iccRows.filter((row) => row.computable).length), `${iccRows.length} 个估计对象`, "info", "ICC是独立对象，不替换DescriptiveBetweenWithinVarianceRatio。"),
      metricCard("跨AI ICC", String((icc.crossAiCoreEffects || []).filter((row) => row.computable).length), `${state.analysis.models.length} 个AI配置`, state.analysis.models.length >= 2 ? "info" : "warn", "少于2个AI配置时明确INSUFFICIENT_MODELS。"),
    ].join("");
    $("#effectSizeTable").innerHTML = effectRows.map((row) => `<tr><td>${escape(row.modelConfig)}<br>${escape(row.bankLabel)}</td><td>${escape(`${row.categoryId}/${row.contrastId}`)}</td><td class="num">${num(row.dScore, 3)}</td><td class="num">${num(row.meanE, 3)} / ${num(row.sdE, 3)}</td><td class="num">${row.validGroups}/${row.plannedGroups} · ${pct(row.coverage)}</td><td class="num">${num(row.cohenD, 3)}</td><td class="num">${num(row.hedgesG, 3)}</td><td>${escape(row.effectLabel)}</td><td>${statusPill(row.computable ? "可计算" : "NA", row.computable ? "good" : "warn")}<br><small>${escape(row.reason)}</small></td></tr>`).join("") || `<tr><td colspan="9" class="na">当前筛选没有Category效应量。</td></tr>`;
    $("#modelEffectSizeTable").innerHTML = modelEffectRows.map((row) => `<tr><td>${escape(row.bankLabel)}<br>${escape(`${row.categoryId}/${row.contrastId}`)}</td><td>${escape(row.modelA)}</td><td>${escape(row.modelB)}</td><td class="num">${row.validPairs}</td><td class="num">${num(row.meanDiff, 3)} / ${num(row.sdDiff, 3)}</td><td class="num">${num(row.cohenDz, 3)}</td><td class="num">${num(row.hedgesGz, 3)}</td><td>${statusPill(row.computable ? "可计算" : "NA", row.computable ? "good" : "warn")}<br><small>${escape(row.reason)}</small></td></tr>`).join("") || `<tr><td colspan="8" class="na">至少需要两个模型在相同BankContentHash与Group E上严格配对。</td></tr>`;
    $("#iccTable").innerHTML = iccRows.map((row) => `<tr><td>${escape(row.iccType)}<br>${escape(row.scope)}</td><td>${escape(row.modelConfig || (row.models || []).join(" / ") || "跨AI")}<br>${escape(row.bankLabel)}</td><td>${escape(`${row.categoryId || ""}${row.groupId ? ` / ${row.groupId}` : ""}${row.domain ? ` / ${row.domain}` : ""}`)}</td><td class="num">${row.targetCount || row.n || row.modelCount || 0}</td><td class="num">${num(row.icc1k, 3)}</td><td>${statusPill(row.status, row.computable ? "good" : "warn")}</td><td>${escape(row.reason)}</td></tr>`).join("") || `<tr><td colspan="7" class="na">当前筛选没有ICC诊断对象。</td></tr>`;
  }

  function renderHumanReference() {
    if (!state.analysis) return;
    renderDomainProfile();
    renderSameTaskHuman();
    renderRiskReference();
    renderEffectSizesAndIcc();
  }

  function download(filename, content, type) {
    const blob = new Blob(Array.isArray(content) ? content : [content], { type });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
  }

  function exportCSV(filename, rows, columns) {
    if (!rows.length) return toast("当前没有可导出的记录");
    download(filename, CSV.stringify(rows, columns), "text/csv;charset=utf-8");
    toast(`已导出 ${filename}`);
  }

  function qualityExportRows() {
    return state.analysis.layeredQuality.map((row) => ({
      Level: row.level, Object: row.object, Records: row.total, FirstValidRate: row.firstValidRate, RetryRate: row.retryRate,
      FinalValidRate: row.finalValidRate, Invalid: row.invalid, TechnicalRate: row.technicalRate,
    }));
  }

  function pExportRows(full = false) {
    const includeRepaired = state.analysis.options.includeRepaired;
    return state.analysis.records.filter((row) => (full || (globalFilter(row) && localDomainMatch(row))) && (includeRepaired || !row.repaired)).map((row) => ({
      ImportBatchID: row.batchId, ImportBatchName: row.batchName, AnalysisModelKey: row.modelConfig, RawModelConfigID: row.rawModelConfigId, ModelConfigID: row.modelConfig,
      BankDatasetID: row.bankDatasetId, BankPartID: row.bankPartId, BankContentHash: row.bankContentHash, Bank: row.bankLabel, SecondLevel: row.secondLevel, CategoryID: row.categoryId, Category: row.category,
      GroupID: row.groupId, ItemID: row.itemId, ConditionCode: row.conditionCode, RepeatIndex: row.repeatIndex,
      Domain: row.domainRaw || row.domain, DomainKey: row.domainKey, DomainStatus: row.domainStatus, DomainEligible: row.domainEligible,
      FinalStatus: row.finalStatus, ScoreFamily: row.scoreFamily, DisplayedRanking: row.displayedRanking, SourceRanking: row.sourceRanking,
      LogicalRanking: row.logicalRanking, MappingStatus: row.mappingStatus, RepeatStatus: row.repeatStatus,
      Rank_L1: row.rankL1, Rank_L3: row.rankL3, K: row.optionCount,
      P_Numerator: row.preferenceNumerator, P_Denominator: row.preferenceDenominator, P: row.preference,
      P_Interpretation: I.interpretP(row, row.preference),
    }));
  }

  function pMeanExportRows(full = false) {
    return state.analysis.effects.conditionMeans.filter((row) => full || (matchesSummary(row) && localDomainMatch(row))).map((row) => ({
      ModelConfigID: row.modelConfig, Bank: row.bankLabel, SecondLevel: row.secondLevel,
      CategoryID: row.categoryId, Category: row.category, GroupID: row.groupId,
      Domain: row.domain, DomainKey: row.domainKey, DomainStatus: row.domainStatus, DomainEligible: row.domainEligible,
      ConditionCode: row.conditionCode, Condition: row.conditionLabel,
      ItemIDCount: row.itemIdCount, CompleteItemCount: row.completeItemCount, ItemIDs: (row.itemIds || []).join(";"),
      SumOfItemMeans: row.numerator, ItemMeansCount: row.denominator, PreferenceMean_Pbar: row.mean,
      ConditionSD_P: row.sd, ValidRepeats: row.validRepeats, PlannedRepeats: row.plannedRepeats,
      RepeatCoverage: row.coverage, RepeatStatus: row.repeatStatus, Reason: row.reason,
      Pbar_Interpretation: I.interpretP(row, row.mean, { average: true }),
    }));
  }

  function eExportRows(useLocalSelection = true, full = false) {
    return state.analysis.effects.groupEffects.filter((row) => full || ((useLocalSelection ? effectSelection(row) : matchesSummary(row)) && localDomainMatch(row))).map((row) => ({
      ModelConfigID: row.modelConfig, Bank: row.bankLabel, SecondLevel: row.secondLevel, CategoryID: row.categoryId, Category: row.category,
      Domain: row.domain, DomainKey: row.domainKey, DomainStatus: row.domainStatus, DomainEligible: row.domainEligible,
      GroupID: row.groupId, ContrastID: row.contrastId, ConditionMeans: mapText(row.conditionMeans, 6),
      ConditionLabels: Object.entries(row.conditionLabels || {}).map(([key, value]) => `${key}=${value}`).join("；"),
      ConditionCounts: mapText(row.conditionCounts, 0), ConditionStatuses: Object.entries(row.conditionStatuses || {}).map(([key, value]) => `${key}=${value}`).join("；"), ContrastWeights: mapText(row.weights, 6),
      WeightsValid: row.weightsValid, E_Numerator: row.numerator, E_Denominator: row.denominator, ResolvedFormula: row.resolvedFormula, RawWeightedPShift: row.rawShift, E: row.effect,
      Eligible: row.valid, Reason: row.reason, E_Interpretation: I.interpretE(row, row.effect),
    }));
  }

  function dExportRows(useLocalSelection = true, full = false) {
    return state.analysis.effects.summaries.filter((row) => full || (useLocalSelection ? effectSelection(row) : matchesSummary(row))).map((row) => ({
      ModelConfigID: row.modelConfig, Bank: row.bankLabel, SecondLevel: row.secondLevel, CategoryID: row.categoryId, Category: row.category,
      ContrastID: row.contrastId, MeanE_Numerator: row.meanENumerator, MeanE_Denominator: row.meanEDenominator,
      MeanE_Formula: row.meanEFormula, MeanE: row.meanE, MeanE_CI95_Low: row.meanECiLow, MeanE_CI95_High: row.meanECiHigh,
      MeanE_Interpretation: I.interpretMeanE(row, row.meanE),
      D_Numerator: row.dNumerator, D_Denominator: row.dDenominator,
      D_Formula: row.dFormula, D: row.dScore, DescriptiveD: row.descriptiveD, CI95_Low: row.ciLow, CI95_High: row.ciHigh,
      ValidGroups: row.validGroups, PlannedGroups: row.plannedGroups, Coverage: row.coverage,
      PositiveGroups: row.positiveGroups, NegativeGroups: row.negativeGroups, ZeroGroups: row.zeroGroups,
      Eligible: row.eligible, SameDirection: row.sameDirection, DirectionDenominator: row.directionDenominator,
      PermutationP: row.p, HolmP: row.pHolm, EvidenceStatus: row.evidenceStatus, EvidenceLabel: row.evidenceLabel,
      CIExcludesZero: row.ciExcludesZero, HolmSupported: row.adjustedSupported, Reason: row.reason, D_Interpretation: I.interpretD(row, row.dScore),
    }));
  }

  function coverageExportRows(full = false) {
    return state.analysis.registry.coverage.filter((row) => full || matchesSummary(row)).map((row) => ({
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

  function factorialExportRows(useLocalSelection = true, full = false) {
    const selected = selectedFactorialAnalysis();
    const analyses = state.analysis.factorial.analyses.filter((row) => useLocalSelection
      ? full || (selected && row.modelConfig === selected.modelConfig && row.categoryKey === selected.categoryKey)
      : full || matchesSummary(row));
    const rows = [];
    analyses.forEach((analysis) => {
      const design = analysis.design || {};
      rows.push({
        Table: "DesignSummary", ModelConfigID: analysis.modelConfig, Bank: analysis.bankLabel, SecondLevel: analysis.secondLevel,
        CategoryID: analysis.categoryId, Category: analysis.category, ScoreFamily: analysis.scoreFamily,
        DesignClass: design.designClass, DesignFormula: design.formula, FactorKeys: (analysis.factorKeys || []).join("×"),
        FactorLevels: Object.entries(analysis.factorLevels || {}).map(([key, value]) => `${key}=${(value || []).join("|")}`).join("；"),
        PlannedCells: design.plannedCells, ObservedCells: design.observedCells, CartesianCells: design.cartesianCells,
        StructuralUnplannedCells: design.structuralUnplannedCells, DataMissingCells: design.dataMissingCells,
        DesignRank: design.designRank, DesignColumns: design.designColumns, Estimable: design.estimable,
        NumericFactor: design.numericFactor, GroupFactor: design.groupFactor, CommonSupport: (design.commonSupport || []).join(";"),
        ReferenceValue: design.referenceValue, OutcomeID: "", OutcomeLabel: "", EffectID: "", EffectType: "", EffectUnit: "",
        ConditionCode: "", ConditionLabel: "", MeanP: "", ValidN: "", PlannedN: "", Coverage: "", MeanE: "", DescriptiveD: "", D: "",
        EvidenceStatus: analysis.formalBlocked ? "METADATA_BLOCKED" : (design.estimable ? "ESTIMABLE" : "NOT_ESTIMABLE"),
        Interpretation: analysis.formalBlocked ? analysis.blockedReason : "先识别设计结构与可估计性，再解释主效应、简单斜率和交互。结构上未设计的单元不计为数据缺失。",
      });
      analysis.cells.forEach((cell) => rows.push({
        Table: "FactorCell", ModelConfigID: analysis.modelConfig, Bank: analysis.bankLabel, SecondLevel: analysis.secondLevel,
        CategoryID: analysis.categoryId, Category: analysis.category, ScoreFamily: analysis.scoreFamily,
        DesignClass: design.designClass, OutcomeID: "CELL", OutcomeLabel: "因子单元描述", EffectID: "", EffectType: "", EffectUnit: "",
        ConditionCode: cell.conditionCode, ConditionLabel: cell.conditionLabel,
        FactorLevels: Object.entries(cell.factorValues || {}).map(([key, value]) => `${key}=${value}`).join("；"),
        MeanP: cell.meanP, ValidN: cell.nValid, PlannedN: cell.plannedObservations, Coverage: cell.coverage,
        L1TopRate: cell.topProportions.L1, L2TopRate: cell.topProportions.L2, L3TopRate: cell.topProportions.L3,
        PairL1AboveL2: cell.pairL1AboveL2, MeanRankL1: cell.meanRanks.L1, MeanRankL2: cell.meanRanks.L2, MeanRankL3: cell.meanRanks.L3,
        RankScoreL1: cell.rankScores.L1, RankScoreL2: cell.rankScores.L2, RankScoreL3: cell.rankScores.L3,
        FullRankingCounts: Object.entries(cell.rankingCounts || {}).map(([key, value]) => `${key}=${value}`).join("；"),
        OutcomeMeans: Object.entries(cell.outcomeMeans || {}).map(([key, value]) => `${key}=${Number.isFinite(value) ? value : "NA"}`).join("；"),
        MeanE: "", CI95Low: "", CI95High: "", DescriptiveD: "", D: "", EvidenceStatus: cell.nValid ? "DESCRIPTIVE" : "NOT_RUN",
        Interpretation: analysis.blocked ? analysis.blockedReason : "因子单元内描述统计；跨单元差异必须按设计矩阵效应解释。",
      }));
      const registered = analysis.registeredEffects || [];
      registered.forEach((row) => rows.push({
        Table: "RegisteredEffect", ModelConfigID: analysis.modelConfig, Bank: analysis.bankLabel, SecondLevel: analysis.secondLevel,
        CategoryID: analysis.categoryId, Category: analysis.category, ScoreFamily: analysis.scoreFamily,
        DesignClass: design.designClass, OutcomeID: "P", OutcomeLabel: "方向偏好P", EffectID: row.contrastId,
        EffectType: "REGISTERED_CONTRAST", EffectUnit: "标准化E", ConditionCode: "", ConditionLabel: "", FactorLevels: "",
        MeanP: "", ValidN: row.validGroups, PlannedN: row.plannedGroups, Coverage: row.coverage,
        L1TopRate: "", L2TopRate: "", L3TopRate: "", MeanE: row.meanE,
        CI95Low: row.meanECiLow, CI95High: row.meanECiHigh, DescriptiveD: row.descriptiveD, D: row.dScore,
        PositiveGroups: row.positiveGroups, NegativeGroups: row.negativeGroups, ZeroGroups: row.zeroGroups,
        PermutationP: row.p, HolmP: row.pHolm, EvidenceStatus: row.evidenceStatus,
        Interpretation: `${I.interpretMeanE(row, row.meanE)} ${I.interpretD(row, row.dScore)}`.trim(),
      }));
      (analysis.factorialEffects || []).forEach((effect) => rows.push({
        Table: "GeneratedFactorialEffect", ModelConfigID: analysis.modelConfig, Bank: analysis.bankLabel, SecondLevel: analysis.secondLevel,
        CategoryID: analysis.categoryId, Category: analysis.category, ScoreFamily: analysis.scoreFamily,
        DesignClass: design.designClass, OutcomeID: effect.outcomeId, OutcomeLabel: effect.outcomeLabel,
        EffectID: effect.effectId || effect.id, EffectType: effect.effectType, EffectUnit: effect.effectUnit,
        ConditionCode: "", ConditionLabel: "", FactorLevels: (effect.factors || []).join("×"),
        FactorDirections: (effect.factorDirections || []).map((row) => `${row.factor}:${row.positiveLevel}−${row.negativeLevel}`).join("；"),
        ContrastWeights: Object.entries(effect.weights || {}).map(([key, value]) => `${key}=${value}`).join("；"),
        MeanP: "", ValidN: effect.validGroups, PlannedN: effect.plannedGroups, Coverage: effect.coverage,
        L1TopRate: "", L2TopRate: "", L3TopRate: "", MeanE: effect.meanE,
        CI95Low: effect.ciLow, CI95High: effect.ciHigh, DescriptiveD: effect.descriptiveD, D: effect.dScore,
        PositiveGroups: effect.positiveGroups, NegativeGroups: effect.negativeGroups, ZeroGroups: effect.zeroGroups,
        PermutationP: effect.p, HolmP: effect.pHolm, Registered: effect.registered, Formal: effect.formal,
        MetadataBlocked: effect.metadataBlocked, EvidenceStatus: effect.evidenceStatus,
        Interpretation: I.interpretFactorial(analysis, effect),
      }));
    });
    return rows;
  }

  function nominalExportRows(full = false) {
    return state.analysis.nonDirectional.analyses.filter((row) => full || matchesSummary(row)).flatMap((analysis) => analysis.cells.map((cell) => ({
      ModelConfigID: analysis.modelConfig, Bank: analysis.bankLabel, SecondLevel: analysis.secondLevel,
      CategoryID: analysis.categoryId, Category: analysis.category, ScoreFamily: analysis.scoreFamily, ConditionStructure: analysis.conditionStructure,
      ConditionCode: cell.conditionCode, ConditionLabel: cell.conditionLabel,
      FactorLevels: Object.entries(cell.factorValues || {}).map(([key, value]) => `${key}=${value}`).join("；"), ValidN: cell.n,
      L1TopCount: cell.topCounts.L1, L1TopRate: cell.topProportions.L1,
      L2TopCount: cell.topCounts.L2, L2TopRate: cell.topProportions.L2,
      L3TopCount: cell.topCounts.L3, L3TopRate: cell.topProportions.L3,
      MeanRankL1: cell.meanRanks.L1, MeanRankL2: cell.meanRanks.L2, MeanRankL3: cell.meanRanks.L3,
      FullRankingCounts: Object.entries(cell.rankingCounts).map(([key, value]) => `${key}=${value}`).join("；"),
      Interpretation: analysis.reason,
    })));
  }

  function profileExportRows() {
    return state.analysis.profiles.profiles.map((row) => ({
      ModelConfigID: row.modelConfig, Bank: row.bankLabel, SecondLevel: row.secondLevel, CategoryID: row.categoryId, Category: row.category,
      PreferenceMean: row.mean, CI95_Low: row.ciLow, CI95_High: row.ciHigh, ValidGroups: row.validGroups,
      PlannedGroups: row.plannedGroups, Coverage: row.coverage, PreferenceMean_Interpretation: I.interpretP(row, row.mean, { average: true }),
    }));
  }

  function interpretationExportRows() {
    return I.rows.map((row) => ({
      Decision: row.decision, Bank: row.bankLabel, DecisionDefinition: row.decisionDefinition,
      SecondLevel: row.secondLevel, CategoryID: row.id, Category: row.name, CategoryDefinition: row.definition,
      PositiveP_High: row.directional ? row.high : row.noEffect,
      NegativeP_Low: row.directional ? row.low : row.noEffect,
      PositiveE: I.staticEffectText(row, true, "E"), NegativeE: I.staticEffectText(row, false, "E"),
      PositiveD: I.staticEffectText(row, true, "D"), NegativeD: I.staticEffectText(row, false, "D"),
      AggregationLimit: [row.aggregate, row.noEffect].filter(Boolean).join(" "),
    }));
  }

  function effectsExportRows() {
    return dExportRows();
  }

  function cardsExportRows() {
    return state.analysis.cards.map((card) => ({
      Bank: card.bankLabel, CategoryID: card.categoryId, Category: card.category, GroupID: card.groupId,
      ItemIDs: card.itemIds.join(";"), Status: card.status, StatusLabel: card.statusLabel, Records: card.records,
      Models: card.models, ConditionsObserved: card.observedConditions, ConditionsExpected: card.expectedConditions,
      FirstValidRate: card.firstValidRate, FinalValidRate: card.finalValidRate, TopAgreement: card.topAgreement,
      FullRankingAgreement: card.fullAgreement, PositionTopAgreement: card.positionTopAgreement,
      Issues: card.issues.join(";"), Recommendation: card.recommendation,
    }));
  }

  function rowExportRows() {
    return state.analysis.records.map((row) => ({
      ImportBatchID: row.batchId, ImportBatchName: row.batchName, RunID: row.runId, RequestID: row.requestId,
      AnalysisModelKey: row.modelConfig, RawModelConfigID: row.rawModelConfigId, ModelConfigID: row.modelConfig, Model: row.model,
      BankDatasetID: row.bankDatasetId, BankPartID: row.bankPartId, BankContentHash: row.bankContentHash, Bank: row.bankLabel,
      CategoryID: row.categoryId, Category: row.category, GroupID: row.groupId, ItemID: row.itemId,
      Domain: row.domainRaw || row.domain, DomainKey: row.domainKey, DomainStatus: row.domainStatus, DomainEligible: row.domainEligible,
      ConditionCode: row.conditionCode, RepeatIndex: row.repeatIndex, PermutationID: row.permutationId,
      FirstStatus: row.firstStatus, RetryUsed: row.retryUsed ? 1 : 0, FinalStatus: row.finalStatus,
      DisplayedRanking: row.displayedRanking, SourceRanking: row.sourceRanking, LogicalRanking: row.logicalRanking,
      MappingStatus: row.mappingStatus, MappingReason: row.mappingReason, RepeatStatus: row.repeatStatus,
      TopChoice: row.topChoice, Rank_L1: row.rankL1, Rank_L3: row.rankL3,
      P_Numerator: row.preferenceNumerator, P_Denominator: row.preferenceDenominator, PreferenceScore_P: row.preference,
      ScoreFamily: row.scoreFamily, ConditionStructure: row.conditionStructure, ContrastID: row.contrastId,
      ItemVersion: row.itemVersion, PromptVersion: row.promptVersion, ParserVersion: row.parserVersion, Timestamp: row.timestamp,
    }));
  }

  function formulaDictionaryRows() {
    return $$(".formula-row").map((row) => ({
      Symbol: row.querySelector("b") ? row.querySelector("b").textContent.trim() : "",
      Metric: row.querySelector("span") ? row.querySelector("span").textContent.trim() : "",
      Formula: row.querySelector("code") ? row.querySelector("code").textContent.trim() : "",
      Note: row.querySelector("p") ? row.querySelector("p").textContent.trim() : "",
    }));
  }

  function scoringRouteRows() {
    return $$("#audit-methods .method-table tbody tr").map((row) => {
      const cells = Array.from(row.cells).map((cell) => cell.textContent.trim());
      return { StructureOrScoreFamily: cells[0] || "", PlatformComputes: cells[1] || "", PlatformDoesNotCompute: cells[2] || "" };
    });
  }

  function fullExportDatasets() {
    if (!state.analysis) return [];
    return X.buildDatasets(state.analysis, I, {
      formulas: formulaDictionaryRows(),
      routes: scoringRouteRows(),
    });
  }

  function fullExportManifest() {
    if (!state.analysis) return [];
    return X.datasetManifest(state.analysis, I, {
      formulas: formulaDictionaryRows(),
      routes: scoringRouteRows(),
    });
  }

  function fullStatisticsRows(selectedIds) {
    return X.combineDatasets(fullExportDatasets(), selectedIds);
  }

  function exportFullStatisticsCSV(selectedIds = null) {
    const output = X.datasetCsvParts(fullExportDatasets(), selectedIds);
    if (!output.rowCount) return toast("所选数据表没有可导出的记录");
    const scope = selectedIds ? "所选统计数据" : "全量统计数据";
    const filename = `AI决策偏好_${scope}_${new Date().toISOString().slice(0, 10)}.csv`;
    download(filename, output.parts, "text/csv;charset=utf-8");
    toast(`已导出 ${filename}`);
  }

  function exportSingleDataset(datasetId) {
    const dataset = fullExportDatasets().find((entry) => entry.id === datasetId);
    if (!dataset) return toast("未找到该统计数据表");
    exportCSV(`${dataset.label}_${new Date().toISOString().slice(0, 10)}.csv`, dataset.rows);
  }

  function renderExportCenter() {
    const empty = $("#exportEmpty");
    const ready = $("#exportReady");
    if (!empty || !ready) return;
    if (!state.analysis) {
      empty.classList.remove("is-hidden");
      ready.classList.add("is-hidden");
      return;
    }
    empty.classList.add("is-hidden");
    ready.classList.remove("is-hidden");
    const datasets = fullExportManifest();
    if (!state.exportSelection) state.exportSelection = new Set(datasets.map((dataset) => dataset.id));
    const totalRows = datasets.reduce((sum, dataset) => sum + dataset.count, 0);
    $("#exportScopeMetrics").innerHTML = [
      ["MODEL CONFIG", state.analysis.models.length, state.analysis.models.join(" · ") || "未识别"],
      ["RESULT BATCH", state.analysis.importBatches.length || 1, "全部导入批次"],
      ["ANALYSIS RECORD", state.analysis.records.length, "不受页面筛选影响"],
      ["CSV DATASET", datasets.length, `${totalRows} 个数据行`],
    ].map(([label, value, note]) => `<article class="export-scope-metric"><small>${escape(label)}</small><b>${escape(value)}</b><span title="${escape(note)}">${escape(note)}</span></article>`).join("");
    $("#exportDatasetTable").innerHTML = datasets.map((dataset) => `<tr><td><input type="checkbox" data-export-select="${escape(dataset.id)}" aria-label="选择${escape(dataset.label)}" ${state.exportSelection.has(dataset.id) ? "checked" : ""}></td><td><b>${escape(dataset.label)}</b><code>${escape(dataset.id)}</code></td><td>${escape(dataset.description)}</td><td class="num">${dataset.count}</td><td><button class="btn btn-quiet btn-small" type="button" data-export-dataset="${escape(dataset.id)}" ${dataset.count ? "" : "disabled"}>导出</button></td></tr>`).join("");
  }

  function coreExportRows() {
    const rows = [];
    const q = state.analysis.quality;
    [
      ["FirstValidRate", q.firstValidRate], ["FinalValidRate", q.finalValidRate], ["RetryRate", q.retryRate],
      ["TechnicalRate", q.technicalRate], ["Records", q.total], ["ModelConfigs", state.analysis.models.length],
    ].forEach(([metric, value]) => rows.push({ Table: "RunSummary", Metric: metric, Value: value }));
    pExportRows().filter((row) => Number.isFinite(row.P)).forEach((row) => rows.push({ Table: "PreferenceP", Metric: `${row.ModelConfigID}|${row.Bank}|${row.ItemID}|R${row.RepeatIndex}`, Value: row.P }));
    pMeanExportRows().filter((row) => Number.isFinite(row.PreferenceMean_Pbar)).forEach((row) => rows.push({ Table: "ConditionMeanP", Metric: `${row.ModelConfigID}|${row.Bank}|${row.GroupID}|${row.ConditionCode}`, Value: row.PreferenceMean_Pbar, Coverage: row.RepeatCoverage }));
    eExportRows(false).filter((row) => Number.isFinite(row.E)).forEach((row) => rows.push({ Table: "GroupEffectE", Metric: `${row.ModelConfigID}|${row.Bank}|${row.GroupID}|${row.ContrastID}`, Value: row.E }));
    dExportRows(false).filter((row) => Number.isFinite(row.MeanE)).forEach((row) => rows.push({ Table: "CategoryMeanE", Metric: `${row.ModelConfigID}|${row.Bank}|${row.CategoryID}|${row.ContrastID}`, Value: row.MeanE, Coverage: row.Coverage }));
    dExportRows(false).forEach((row) => rows.push({ Table: "CategoryEffectD", Metric: `${row.ModelConfigID}|${row.Bank}|${row.CategoryID}|${row.ContrastID}`, Value: row.D, Coverage: row.Coverage, P_Holm: row.HolmP }));
    profileExportRows().forEach((row) => rows.push({ Table: "CategoryProfileP", Metric: `${row.ModelConfigID}|${row.Bank}|${row.CategoryID}|PreferenceMean`, Value: row.PreferenceMean, Coverage: row.Coverage }));
    coverageExportRows().forEach((row) => rows.push({ Table: "MetricCoverage", Metric: `${row.ModelConfigID}|${row.Bank}|${row.CategoryID}`, Value: row.RunStatus, Coverage: `${row.ObservedItems}/${row.PlannedItems}` }));
    return rows;
  }

  function chartSVG(id) {
    const svgElement = $(`${id} svg`);
    return svgElement ? svgElement.outerHTML : `<div class="report-note">当前数据不足，未生成该图。</div>`;
  }

  function buildReportMarkup() {
    const analysis = state.analysis;
    const q = analysis.quality;
    const datasets = Object.fromEntries(fullExportDatasets().map((dataset) => [dataset.id, dataset.rows]));
    const rows = (id) => datasets[id] || [];
    const narrative = `本报告固定使用本次分析中的全部 ${analysis.models.length} 个模型配置、${analysis.importBatches.length || 1} 个结果批次和 ${analysis.records.length} 条标准化记录。导出不读取当前页面的模型、子测验、三级分类或Domain筛选器，也不受表格分页或局部E/FACTORIAL选择影响。修复成功回答当前${analysis.options.includeRepaired ? "纳入" : "不纳入"}统计计算；原始记录仍完整列入附录。`;
    return `<section class="report-cover"><div><small>AI DECISION PREFERENCE · FULL EXPORT · v1.7.0</small><h1>AI 决策偏好<br>全量分析报告</h1><p>覆盖v1.5.2既有P/E/D与FACTORIAL统计，并新增Bank隔离Domain、同题Human、风险文献外部参照、风险维度综合曲线、Cohen's d / Hedges' g与独立ICC诊断。</p></div><footer><b>${escape(analysis.models.join(" · "))}</b><p>${new Date().toLocaleString("zh-CN")} · 本地生成 · 全量范围锁定</p></footer></section>
      <section class="report-page"><h2>1. 数据范围、运行与总体质量</h2><div class="report-metrics">
        <div class="report-metric"><small>RESULT BATCH</small><b>${analysis.importBatches.length || 1}</b><span>独立结果批次</span></div>
        <div class="report-metric"><small>MODEL CONFIG</small><b>${analysis.models.length}</b><span>独立配置</span></div>
        <div class="report-metric"><small>运行记录</small><b>${q.total}</b><span>总调用记录</span></div>
        <div class="report-metric"><small>首次有效率</small><b>${pct(q.firstValidRate)}</b><span>${q.firstValid}/${q.responseDenominator}</span></div>
        <div class="report-metric"><small>修复后有效率</small><b>${pct(q.finalValidRate)}</b><span>${q.finalValid}/${q.responseDenominator}</span></div>
      </div><div class="report-note">${escape(narrative)}</div>
      ${reportSubsection("结果批次清单", rows("run_manifest"), ["ImportBatchID", "ImportBatchName", "ModelConfigID", "RequiredFileProgress", "CompleteRows", "RankingRows", "PlannedRepetitions", "RepetitionInferenceSource", "RunIDs", "CompleteFile", "RankingFile"])}
      ${reportSubsection("总体指标", rows("run_summary"), ["ResultBatches", "ModelConfigCount", "RawModelConfigCount", "Records", "FirstValidRate", "FinalValidRate", "RetryRate", "TechnicalRate", "PlannedRepetitions", "AuditScore", "ActiveCatalogRows", "RuntimeMetadataRows", "RuntimeAddedItems", "RuntimeOverriddenItems", "RuntimeMetadataConflicts"])}
      ${reportSubsection("分析设置与冻结项", rows("analysis_settings"), ["Setting", "Value", "Source"])}
      ${reportSubsection("题库数据集身份", rows("dataset_manifest"), ["BankDatasetID", "Bank", "BankPartCount", "BankPartIDs", "BankContentHash", "ItemCount", "CompositionStatus"])}
      ${reportSubsection("模型配置兼容审计", rows("model_config_audit"), ["AnalysisModelKey", "RawModelConfigIDs", "IdentityPolicy", "ApiModes", "InferredRecordCount", "InferredFields", "InferenceSources", "AmbiguousRecordCount", "AmbiguousFields", "ExplicitVariantFields", "CoreFingerprint", "MaxOutputTokens", "MaxObservedCompletionTokens", "OutputCapNonBinding", "Status", "Reason"])}
      ${reportSubsection("回答状态分布", rows("status_distribution"), ["Stage", "Status", "Count"])}
      ${reportSubsection("分析就绪度", rows("analysis_readiness"), ["Module", "Ready", "Score", "Formula", "Detail"])}
      ${reportSubsection("分层数据质量", rows("layered_quality"), ["Level", "Object", "Records", "FirstValidRate", "RetryRate", "FinalValidRate", "Invalid", "TechnicalRate"])}
      </section>
      <section class="report-page"><h2>2. 单次偏好分 P 与条件内平均 P̄</h2><p class="report-note">保留全部运行记录；评分族不适用或无效回答的P保持缺失，不编码为0。</p>
      ${reportSubsection("单次偏好分P", rows("preference_p"), ["ImportBatchName", "RunID", "RequestID", "AnalysisModelKey", "RawModelConfigID", "Bank", "Category", "GroupID", "ItemID", "RepeatIndex", "FinalStatus", "DisplayedRanking", "SourceRanking", "LogicalRanking", "MappingStatus", "RepeatStatus", "P", "P_Interpretation"])}
      ${reportSubsection("ItemID重复汇总", rows("item_repeat_summary"), ["AnalysisModelKey", "Bank", "Category", "GroupID", "ConditionCode", "ItemID", "P_Mean", "P_SD", "TopChoiceAgreement", "FullRankingAgreement", "MeanKendallTau", "ValidRepeats", "PlannedRepeats", "RepeatStatus", "PermutationCount", "RepeatReason"])}
      ${reportSubsection("条件内平均P̄", rows("condition_summary"), ["ModelConfigID", "Bank", "Category", "GroupID", "ConditionCode", "ItemIDCount", "CompleteItemCount", "PreferenceMean_Pbar", "ConditionSD_P", "ValidRepeats", "PlannedRepeats", "RepeatStatus", "Reason", "Pbar_Interpretation"])}
      </section>
      <section class="report-page"><h2>3. 题组与分类多维偏好画像</h2>
      ${reportSubsection("题组平均P", rows("group_mean_p"), ["ModelConfigID", "Bank", "SecondLevel", "Category", "GroupID", "GroupMeanP", "ObservedItems", "ObservedConditions", "Interpretation"])}
      ${reportSubsection("三级分类平均P画像", rows("category_profile_p"), ["ModelConfigID", "Bank", "SecondLevel", "CategoryID", "Category", "PreferenceMean", "CI95_Low", "CI95_High", "SD", "ValidGroups", "PlannedGroups", "Coverage", "PreferenceMean_Interpretation"])}
      ${reportSubsection("逻辑首选分布", rows("category_top_choice"), ["ModelConfigID", "Bank", "CategoryID", "Category", "ValidN", "L1TopCount", "L1TopRate", "L2TopCount", "L2TopRate", "L3TopCount", "L3TopRate", "ScoreFamilies"])}
      </section>
      <section class="report-page"><h2>4. 题组条件效应 E</h2><p class="report-note">E回答同一题组从一个预登记条件组合变化到另一个条件组合后，偏好向哪一端移动以及移动多少。</p>
      ${reportSubsection("全部题组E", rows("group_effect_e"), ["ModelConfigID", "Bank", "SecondLevel", "Category", "GroupID", "ContrastID", "ConditionMeans", "ContrastWeights", "WeightsValid", "E_Numerator", "E_Denominator", "ResolvedFormula", "E", "Eligible", "Reason", "E_Interpretation"])}
      </section>
      <section class="report-page"><h2>5. 有效题组平均 E 与分类汇总 D</h2><p class="report-note">平均E为当前有效题组描述均值；D仅在分类覆盖达到登记门槛后作为正式汇总输出。覆盖充分不自动等于方向稳定获得统计支持。</p>
      ${reportSubsection("平均E与D", rows("category_mean_e_d"), ["ModelConfigID", "Bank", "SecondLevel", "Category", "ContrastID", "MeanE_Formula", "MeanE", "MeanE_CI95_Low", "MeanE_CI95_High", "D_Formula", "D", "Coverage", "PositiveGroups", "NegativeGroups", "ZeroGroups", "PermutationP", "HolmP", "EvidenceLabel", "Reason", "MeanE_Interpretation", "D_Interpretation"])}
      </section>
      <section class="report-page"><h2>6. 正式分类覆盖与预登记对比</h2>
      ${reportSubsection("计分单元与指标覆盖", rows("metric_coverage"), ["ModelConfigID", "Bank", "SecondLevel", "CategoryID", "Category", "ScoreFamily", "ConditionStructure", "ObservedConditions", "PlannedConditions", "ObservedItems", "PlannedItems", "ObservedGroups", "PlannedGroups", "RegisteredContrasts", "ComputedMeanEContrasts", "EligibleDContrasts", "PApplicability", "EApplicability", "DApplicability", "RunStatus", "ScoringRouteExplanation"])}
      ${reportSubsection("预登记对比注册表", rows("registered_contrasts"), ["ModelConfigID", "Bank", "SecondLevel", "Category", "ConditionStructure", "ContrastID", "ContrastWeights", "AttemptedGroups", "ValidGroups", "PlannedGroups", "Coverage", "MeanE", "D", "EvidenceLabel", "Reason", "MeanE_Interpretation", "D_Interpretation"])}
      </section>
      <section class="report-page"><h2>7. FACTORIAL 分析</h2><p class="report-note">先报告设计识别与可估计性，再区分计划单元、预登记效应和设计矩阵生成效应。风险A1/B1完整题库应识别为3×21、63/63单元。</p>${reportSubsection("设计、因子单元与全部析因效应", rows("factorial_results"), ["Table", "ModelConfigID", "Bank", "Category", "DesignClass", "PlannedCells", "ObservedCells", "StructuralUnplannedCells", "DataMissingCells", "DesignRank", "DesignColumns", "OutcomeID", "EffectID", "EffectType", "MeanP", "ValidN", "PlannedN", "Coverage", "MeanE", "D", "EvidenceStatus", "Interpretation"])}${reportSubsection("风险斜率诊断", rows("risk_slope_diagnostics"), ["AnalysisModelKey", "CategoryID", "GroupID", "BaseProbability", "SlopePer0_01", "Fit_R2", "Fit_N", "CostRate_Min", "CostRate_Max", "ConstantOutcome", "FitStatus", "Reason"])}</section>
      <section class="report-page"><h2>8. NOMINAL_RANK 与 CUSTOM 非方向评分</h2>${reportSubsection("非方向条件结果", rows("non_directional_results"), ["ModelConfigID", "Bank", "SecondLevel", "Category", "ScoreFamily", "ConditionStructure", "ConditionCode", "ConditionLabel", "FactorLevels", "ValidN", "L1TopCount", "L1TopRate", "L2TopCount", "L2TopRate", "L3TopCount", "L3TopRate", "MeanRankL1", "MeanRankL2", "MeanRankL3", "FullRankingCounts", "Blocked", "Interpretation"])}</section>
      <section class="report-page"><h2>9. 重复一致性与模型区分</h2>
      ${reportSubsection("重复与位置稳健性", rows("repeat_reliability"), ["ModelConfigID", "Model", "Bank", "Category", "GroupID", "ItemID", "ValidRepeats", "TopChoiceAgreement", "FullRankingAgreement", "MeanKendallTau", "PermutationCount", "PositionEffectEligible"])}
      ${reportSubsection("位置随机化总体诊断", rows("position_randomization_diagnostics"), ["AnalysisModelKey", "Bank", "ObservedPermutationCount", "ObservedPermutationIDs", "DisplayPosition1TopRate", "DisplayPosition2TopRate", "DisplayPosition3TopRate", "ItemCenteredPosition1TopRate", "ItemCenteredPosition2TopRate", "ItemCenteredPosition3TopRate", "EligibleItemCount", "PositionBalanceStatus"])}
      ${reportSubsection("描述性模型方差诊断", rows("model_variance_diagnostics"), ["Metric", "MeanBetweenModelVariance", "MeanWithinModelVariance", "MatchedItemCount", "AnalysisModelKeyCount", "Ratio", "RatioStatus", "Reason"])}
      ${reportSubsection("配对模型差异", rows("model_comparisons"), ["Bank", "Category", "ModelA", "ModelB", "MatchedGroups", "MeanDifference", "CI95_Low", "CI95_High", "PermutationP", "HolmP"])}
      ${reportSubsection("模型画像相似性", rows("profile_similarity"), ["ModelA", "ModelB", "PearsonR", "SharedCategoryUniverse"])}
      </section>
      <section class="report-page"><h2>10. 题目质量检测与处理决策</h2>${reportSubsection("全部GroupID题目决策卡", rows("item_quality_cards"), ["Bank", "CategoryID", "Category", "GroupID", "ItemIDs", "Status", "StatusLabel", "Records", "Models", "ConditionsObserved", "ConditionsExpected", "FirstValidRate", "FinalValidRate", "TopAgreement", "FullRankingAgreement", "PositionTopAgreement", "Effects", "Issues", "Recommendation"])}</section>
      <section class="report-page"><h2>11. 文件链路与计算审计</h2>${reportSubsection("全部审计检查项", rows("audit_checks"), ["AuditScore", "Check", "Status", "Detail", "Value"])}${reportSubsection("映射审计", rows("mapping_audit"), ["ImportBatchID", "SourceFile", "SourceRow", "ItemID", "RepeatIndex", "DisplayedRanking", "SourceRanking", "LogicalRanking", "MappingStatus", "Reason"])}${reportSubsection("重复审计", rows("repeat_audit"), ["AnalysisModelKey", "BankDatasetID", "ItemID", "PlannedRepeats", "ObservedRows", "ValidRepeats", "RepeatStatus", "MissingRepeatIndices", "DuplicateRepeatIndices", "Reason"])}</section>
      <section class="report-page"><h2>12. 理论解释与统计口径</h2>
      ${reportSubsection("P/E/D分类方向解释字典", rows("interpretation_dictionary"), ["Decision", "Bank", "DecisionDefinition", "SecondLevel", "CategoryID", "Category", "CategoryDefinition", "PositiveP_High", "NegativeP_Low", "PositiveE", "NegativeE", "PositiveD", "NegativeD", "AggregationLimit"])}
      ${reportSubsection("公式字典", rows("formula_dictionary"), ["Symbol", "Metric", "Formula", "Note"])}
      ${reportSubsection("结构与评分路由", rows("scoring_routes"), ["StructureOrScoreFamily", "PlatformComputes", "PlatformDoesNotCompute"])}
      </section>
      <section class="report-page"><h2>13. Source_Domain 情境领域</h2><p class="report-note">DomainKey固定为BankDatasetID::Source_Domain，不做跨Bank语义合并。MIXED_DOMAIN_GROUP不是数据错误：旧P/E/D继续，仅禁止将整组E归入单一Domain。任意Domain子集不生成新的正式D。</p>
      ${reportSubsection("Domain目录与元数据版本", rows("domain_catalog"), ["BankDatasetID", "Bank", "Domain", "DomainKey", "Records", "Items", "Groups", "Conditions", "DomainSources"])}
      ${reportSubsection("Group Domain审计", rows("domain_group_audit"), ["AnalysisModelKey", "Bank", "CategoryID", "GroupID", "GroupDomains", "DomainStatus", "DomainEligible", "ConditionDomains", "Reason"])}
      ${reportSubsection("Domain重复信度", rows("domain_reliability_summary"), ["AnalysisModelKey", "Bank", "Domain", "ItemCount", "DirectionalItemCount", "MeanKendallTau", "MeanP_SD", "MeanTopChoiceAgreement", "MeanFullRankingAgreement", "DirectionFlipCount", "DirectionFlipRate"])}
      ${reportSubsection("Domain条件P画像", rows("domain_condition_profile"), ["AnalysisModelKey", "Bank", "CategoryID", "Domain", "ConditionCode", "MeanP", "SD_P", "ItemCount", "ValidN", "GroupCount"])}
      ${reportSubsection("Domain题组E", rows("domain_effect_profile"), ["AnalysisModelKey", "Bank", "CategoryID", "ContrastID", "Domain", "GroupID", "RawShift", "E", "Eligible", "FormalD", "AnalysisStatus"])}
      ${reportSubsection("Domain Heterogeneity Summary", rows("domain_heterogeneity"), ["AnalysisModelKey", "Bank", "CategoryID", "ContrastID", "DomainCount", "Domains", "Min", "Max", "Range", "SD", "IQR", "DirectionConsistency", "FormalTest"])}
      ${reportSubsection("Domain名义与CUSTOM策略画像", rows("domain_non_directional_profile"), ["AnalysisModelKey", "Bank", "CategoryID", "Domain", "GroupIDs", "ConditionCode", "ScoreFamily", "ValidN", "L1TopRate", "L2TopRate", "L3TopRate", "MeanRankL1", "MeanRankL2", "MeanRankL3"])}
      </section>
      <section class="report-page"><h2>14. Human Reference &amp; External Validity</h2><p class="report-note">SAME_TASK_HUMAN_SAMPLE仅用于模糊、跨期与CNI同题比较；Human不是答案，Gap不是误差率，Gap≈0不等于统计等效。CNI仍为METADATA_BLOCKED探索性结果。</p>
      ${reportSubsection("Human派生数据与隐私清单", rows("human_reference_manifest"), ["ReferenceType", "HumanReferenceVersion", "BankDatasetID", "SourceWorkbook", "Participants", "Items", "Rows", "ExactStimulusMatches", "ParticipantPrivacyRule", "SourceContentDigestCompatibility"])}
      ${reportSubsection("严格同题匹配审计", rows("human_match_audit"), ["ReferenceType", "BankDatasetID", "ItemID", "GroupID", "ConditionCode", "Domain", "Participants", "StimulusMatchStatus", "Eligible", "Reason"])}
      ${reportSubsection("方向题AI—Human Group Gap", rows("human_gap_group"), ["ReferenceType", "AnalysisModelKey", "Bank", "CategoryID", "GroupID", "ContrastID", "Domain", "AI_RawShift", "Human_RawShift", "GapDeltaP", "AI_E", "Human_E", "GapE", "Computable", "Reason"])}
      ${reportSubsection("Human分类Gap与Scenario Resampling", rows("human_gap_summary"), ["ReferenceType", "AnalysisModelKey", "Bank", "CategoryID", "ContrastID", "MeanAI_RawShift", "MeanHuman_RawShift", "GapDeltaP", "MeanAI_E", "MeanHuman_E", "GapE", "GapD", "ValidGroups", "PlannedGroups", "Coverage", "ScenarioResamplingInterval95_Low", "ScenarioResamplingInterval95_High", "ScenarioResamplingSD", "ScenarioIterations", "ScenarioSeed", "ScenarioMethod", "LegacyEDBootstrap", "Computable", "Reason"])}
      ${reportSubsection("Domain Human Gap", rows("human_domain_gap"), ["ReferenceType", "AnalysisModelKey", "Bank", "CategoryID", "ContrastID", "Domain", "GroupCount", "AI_RawShift", "Human_RawShift", "GapDeltaP", "AI_E", "Human_E", "GapE", "IntervalComputable", "IntervalReason"])}
      ${reportSubsection("SINGLE题P水平、首选与平均名次", rows("human_single_level_comparison"), ["ReferenceType", "AnalysisModelKey", "Bank", "CategoryID", "GroupID", "ConditionCode", "Domain", "AI_MeanP", "Human_MeanP", "AIHumanPLevelDifference", "AI_L1TopRate", "AI_L2TopRate", "AI_L3TopRate", "Human_L1TopRate", "Human_L2TopRate", "Human_L3TopRate", "AI_MeanRankL1", "AI_MeanRankL2", "AI_MeanRankL3", "Human_MeanRankL1", "Human_MeanRankL2", "Human_MeanRankL3", "GapDeltaP", "Reason"])}
      ${reportSubsection("NOMINAL策略比例与平均名次比较", rows("human_nominal_distribution"), ["ReferenceType", "AnalysisModelKey", "Bank", "CategoryID", "GroupID", "ConditionCode", "Domain", "AI_L1TopRate", "AI_L2TopRate", "AI_L3TopRate", "Human_L1TopRate", "Human_L2TopRate", "Human_L3TopRate", "L1ProportionGap", "L2ProportionGap", "L3ProportionGap", "AI_MeanRankL1", "AI_MeanRankL2", "AI_MeanRankL3", "Human_MeanRankL1", "Human_MeanRankL2", "Human_MeanRankL3"])}
      ${reportSubsection("CNI探索性Human比较", rows("cni_human_descriptive"), ["Table", "ReferenceType", "AnalysisModelKey", "GroupID", "ContrastID", "Domain", "AI_DescriptiveDifference", "Human_DescriptiveDifference", "AIHumanDescriptiveGap", "AI_L3TopRate", "Human_L3TopRate", "FormalComputable", "Status", "ParameterStatus"])}
      </section>
      <section class="report-page"><h2>15. Risk Literature-derived Human Reference</h2><p class="report-note">LITERATURE_DERIVED_REFERENCE来自2939名、30国样本的前景理论模型，不是当前风险题库同题实验。P=0仅称“排序倾向拐点”；原始多次跨0时报告NON_MONOTONIC，isotonic只作敏感性，不进行范围外外推。</p>
      ${reportSubsection("论文参数换算参照", rows("risk_reference_parameters"), ["ReferenceType", "ReferenceVersion", "Citation", "CategoryID", "BaseProbability", "Assumption", "FormulaID", "HumanReference", "Primary"])}
      ${reportSubsection("风险原始曲线点", rows("risk_curve_points"), ["AnalysisModelKey", "CategoryID", "GroupID", "Domain", "BaseProbability", "XFactor", "X", "MeanP", "SD_P", "MinP", "MaxP", "ValidN", "RawBinaryRate", "IsotonicP", "ReferenceApplicability"])}
      ${reportSubsection("P=0排序倾向拐点", rows("risk_threshold_comparison"), ["ReferenceType", "AnalysisModelKey", "CategoryID", "GroupID", "Domain", "BaseProbability", "ThresholdStatus", "ThresholdReason", "LowerTestedPoint", "UpperTestedPoint", "InterpolatedEstimate", "ThresholdInequality", "RawCrossingCount", "HumanReference", "DifferenceFromHuman", "ReferenceApplicability"])}
      ${reportSubsection("二元稳健性与Logistic诊断", rows("risk_binary_robustness"), ["AnalysisModelKey", "CategoryID", "GroupID", "Domain", "BaseProbability", "RawBinaryStatus", "RawBinaryThreshold", "LogisticStatus", "LogisticReason", "LogisticThreshold", "LogisticSlope", "PThreshold", "PvsBinaryDifference"])}
      ${reportSubsection("风险六种完整排序与L2首选", rows("risk_ranking_distribution"), ["AnalysisModelKey", "CategoryID", "GroupID", "Domain", "BaseProbability", "ValidN", "L2TopRate", "ModalRanking", "ModalCount", "RankingCounts", "RankingProportions"])}
      </section>
      <section class="report-page"><h2>16. Cohen's d / Hedges' g 与 ICC</h2><p class="report-note">dScore仍是平台正式D；cohenD/hedgesG使用有效Group E标准化。ICC是独立新对象，DescriptiveBetweenWithinVarianceRatio保持原名与原义。</p>
      ${reportSubsection("Category标准化效应量", rows("category_effect_sizes"), ["AnalysisModelKey", "Bank", "CategoryID", "ContrastID", "D", "MeanE", "SD_E", "ValidGroups", "PlannedGroups", "Coverage", "CohenD", "HedgesG", "EffectLabel", "Computable", "Reason"])}
      ${reportSubsection("模型E配对效应量", rows("model_effect_sizes"), ["Bank", "CategoryID", "ContrastID", "ModelA", "ModelB", "ValidPairs", "MeanDiff", "SD_Diff", "CohenDz", "HedgesGz", "Computable", "Reason"])}
      ${reportSubsection("独立ICC结果", rows("icc_results"), ["ICCType", "Estimand", "Scope", "AnalysisModelKey", "Bank", "CategoryID", "GroupID", "Domain", "TargetCount", "ModelCount", "Repetitions", "ICC_1_K", "Computable", "Status", "Reason", "DBWVR_PreservedAs"])}
      ${reportSubsection("ICC逐Repeat核心效应theta诊断", rows("icc_theta_by_repeat"), ["AnalysisModelKey", "Bank", "CategoryID", "GroupID", "ContrastID", "RepeatIndex", "ThetaType", "Theta", "Domain", "DomainEligible", "Computable", "Reason"])}
      </section>
      <section class="report-page"><h2>17. 标准化分析记录附录</h2><p class="report-note">本附录完整保留全部记录的批次、RunID、RequestID、模型身份、Domain、状态、逻辑映射、P与版本字段，用于复核任一统计结果。</p>
      ${reportSubsection("标准化分析明细", rows("analysis_records"), ["ImportBatchID", "ImportBatchName", "RunID", "RequestID", "ModelConfigID", "Model", "Bank", "SecondLevel", "CategoryID", "Category", "GroupID", "ItemID", "Domain", "DomainKey", "DomainStatus", "ConditionCode", "RepeatIndex", "PermutationID", "FirstStatus", "RetryUsed", "FinalStatus", "LogicalRanking", "TopChoice", "Rank_L1", "Rank_L2", "Rank_L3", "P_Numerator", "P_Denominator", "PreferenceScore_P", "ScoreFamily", "ConditionStructure", "ContrastID", "ItemVersion", "PromptVersion", "ParserVersion", "Timestamp"])}
      </section>`;
  }

  function reportSubsection(title, rows, columns) {
    return `<div class="report-subsection"><h3>${escape(title)} <small>n=${rows.length}</small></h3>${rows.length ? `<div class="report-table-wrap">${htmlTable(rows, columns)}</div>` : '<p class="report-note">当前数据中没有该模块的可报告记录。</p>'}</div>`;
  }

  function htmlTable(rows, columns) {
    return `<table><thead><tr>${columns.map((column) => `<th>${escape(column)}</th>`).join("")}</tr></thead><tbody>${rows.map((row) => `<tr>${columns.map((column) => `<td>${escape(Number.isFinite(row[column]) ? num(row[column], 4) : row[column] == null ? "NA" : row[column])}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
  }

  async function exportHTML() {
    if (!state.analysis) return toast("请先完成数据分析");
    if (!state.cssText) state.cssText = await (await fetch("assets/styles.css")).text();
    const reportCSS = state.cssText + `
body{background:#f3f1ed;padding:28px}.app-shell,.export-popover,.toast{display:none!important}.print-report{display:block!important;color:#28252c;font-family:Inter,"Noto Sans SC","Microsoft YaHei",sans-serif}.report-cover,.report-page{max-width:1600px;margin:0 auto 28px}.report-cover{min-height:520px;display:flex;flex-direction:column;justify-content:space-between;padding:54px;color:#fff;background:#2b2630;border-radius:14px}.report-cover h1{margin:70px 0 18px;font-size:46px;line-height:1.15}.report-cover p{max-width:900px;color:rgba(255,255,255,.76);line-height:1.75}.report-page{padding:28px;border:1px solid #ded9d2;border-radius:12px;background:#fff}.report-page h2{margin:0 0 22px;font-size:24px}.report-subsection{margin:28px 0}.report-subsection h3{display:flex;align-items:baseline;gap:8px;margin:0 0 10px;font-size:16px}.report-subsection h3 small{color:#938c96;font-size:11px;font-weight:600}.report-metrics{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:12px}.report-metric{padding:16px;border:1px solid #ded9d2;border-top:3px solid #7357d8}.report-metric small,.report-metric b,.report-metric span{display:block}.report-metric b{margin:7px 0;font-size:28px}.report-metric span{color:#716b76;font-size:11px}.report-note{padding:15px;border-left:3px solid #7357d8;background:#f3f1ed;line-height:1.7}.report-table-wrap{max-width:100%;overflow:auto;border:1px solid #ded9d2;border-radius:8px}.report-table-wrap table{width:max-content;min-width:100%;margin:0;border-collapse:collapse}.report-table-wrap th,.report-table-wrap td{max-width:360px;padding:8px 9px;border:1px solid #e8e4de;font-size:10px;line-height:1.45;text-align:left;vertical-align:top;overflow-wrap:anywhere}.report-table-wrap th{position:sticky;top:0;color:#48434d;background:#f8f7f4}.report-table-wrap tbody tr:nth-child(even){background:#fcfbf9}
@media(max-width:760px){body{padding:10px}.report-cover,.report-page{padding:18px}.report-metrics{grid-template-columns:repeat(2,minmax(0,1fr))}.report-cover h1{font-size:34px}}
@media print{@page{size:A4 landscape;margin:8mm}body{padding:0;background:#fff}.report-cover{min-height:180mm;border-radius:0;break-after:page}.report-page{max-width:none;margin:0;padding:0;border:0;border-radius:0;break-before:page}.report-subsection{margin:5mm 0}.report-subsection h3{font-size:10pt}.report-table-wrap{overflow:visible;border:0}.report-table-wrap table{width:100%;min-width:0;table-layout:auto}.report-table-wrap th,.report-table-wrap td{max-width:42mm;padding:1.1mm;font-size:5.5pt;line-height:1.25}.report-table-wrap th{position:static}.report-note{font-size:8pt}.report-metrics{grid-template-columns:repeat(5,1fr)}}`;
    const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="generator" content="AI决策偏好分析平台 v1.7.0"><title>AI决策偏好全量分析报告</title><style>${reportCSS}</style></head><body><main class="print-report">${buildReportMarkup()}</main></body></html>`;
    download(`AI决策偏好_全量分析报告_${new Date().toISOString().slice(0, 10)}.html`, html, "text/html;charset=utf-8");
    toast("全量 HTML 报告已导出");
  }

  function exportPDF() {
    if (!state.analysis) return toast("请先完成数据分析");
    const report = $("#printReport");
    report.replaceChildren();
    report.innerHTML = buildReportMarkup();
    const releasePrintReport = () => report.replaceChildren();
    window.addEventListener("afterprint", releasePrintReport, { once: true });
    setTimeout(releasePrintReport, 180000);
    toast("全量报告已生成，请在打印窗口选择“另存为 PDF”");
    setTimeout(() => window.print(), 420);
  }

  function bindEvents() {
    $$(".nav-item").forEach((item) => item.addEventListener("click", () => setView(item.dataset.target)));
    $("#brandHome").addEventListener("click", (event) => { event.preventDefault(); setView("import"); });
    $$(".subtab").forEach((button) => button.addEventListener("click", () => {
      const group = button.closest(".subtabs").dataset.tabGroup;
      $$(`.subtab`, button.closest(".subtabs")).forEach((item) => item.classList.toggle("is-active", item === button));
      $$(`[data-panel-group="${group}"]`).forEach((panel) => panel.classList.toggle("is-active", panel.id === button.dataset.panel));
    }));
    $("#mobileNav").addEventListener("click", () => document.body.classList.toggle("nav-open"));
    $("#addBatchBtn").addEventListener("click", addBatch);
    $("#batchList").addEventListener("change", (event) => {
      const input = event.target.closest("[data-batch-input], [data-folder-input]");
      if (!input) return;
      const batch = input.closest("[data-batch-id]");
      ingestFiles(batch.dataset.batchId, Array.from(input.files));
      input.value = "";
    });
    $("#batchList").addEventListener("input", (event) => {
      if (!event.target.matches("[data-batch-name]")) return;
      const batch = findBatch(event.target.closest("[data-batch-id]").dataset.batchId);
      if (batch) batch.name = event.target.value.trim() || batch.name;
    });
    $("#batchList").addEventListener("click", (event) => {
      const remove = event.target.closest("[data-remove-batch]");
      if (remove) removeBatch(remove.closest("[data-batch-id]").dataset.batchId);
    });
    ["dragenter", "dragover"].forEach((name) => $("#batchList").addEventListener(name, (event) => {
      const zone = event.target.closest("[data-drop-batch]");
      if (!zone) return;
      event.preventDefault();
      zone.classList.add("is-dragging");
    }));
    ["dragleave", "drop"].forEach((name) => $("#batchList").addEventListener(name, (event) => {
      const zone = event.target.closest("[data-drop-batch]");
      if (!zone) return;
      event.preventDefault();
      zone.classList.remove("is-dragging");
      if (name === "drop") ingestFiles(zone.dataset.dropBatch, Array.from(event.dataTransfer.files));
    }));
    $("#loadSample").addEventListener("click", loadSample);
    $("#analyzeBtn").addEventListener("click", runAnalysis);
    $("#includeRepaired").addEventListener("change", runAnalysis);
    $("#modelFilter").addEventListener("change", () => { populateRiskCurveSelector(); renderAll(); });
    $("#bankFilter").addEventListener("change", () => { updateCategoryFilter(); $("#domainSearch").value = ""; populateDomainControls(); renderAll(); });
    $("#categoryFilter").addEventListener("change", () => { populateRiskCurveSelector(); renderAll(); });
    $("#resetFilters").addEventListener("click", () => { $("#modelFilter").value = "ALL"; $("#bankFilter").value = "ALL"; updateCategoryFilter(); $("#domainSearch").value = ""; populateDomainControls(); renderAll(); });
    $("#domainSearch").addEventListener("input", populateDomainControls);
    $("#domainMulti").addEventListener("change", () => { updateDomainSelectionFromControl(); populateDomainControls(); renderAll(); });
    $("#domainCompareMode").addEventListener("change", () => { state.domainCompareMode = $("#domainCompareMode").value; populateDomainControls(); renderAll(); });
    $("#selectAllDomains").addEventListener("click", () => {
      const bankId = $("#bankFilter").value;
      if (bankId === "ALL") Object.keys(state.analysis.banks.catalog || {}).forEach((id) => { state.domainSelectionByBank[id] = allDomainRows(id).map((row) => row.domainKey); });
      else state.domainSelectionByBank[bankId] = allDomainRows(bankId).map((row) => row.domainKey);
      populateDomainControls(); renderAll();
    });
    $("#clearDomains").addEventListener("click", () => {
      const bankId = $("#bankFilter").value;
      if (bankId === "ALL") Object.keys(state.analysis.banks.catalog || {}).forEach((id) => { state.domainSelectionByBank[id] = []; });
      else state.domainSelectionByBank[bankId] = [];
      populateDomainControls(); renderAll();
    });
    $("#restoreDomains").addEventListener("click", () => {
      state.domainSelectionByBank = {};
      populateDomainControls(); renderAll();
    });
    $("#riskCurveScope").addEventListener("change", () => { populateRiskCurveSelector(); renderRiskReference(); });
    $("#riskCurveSelector").addEventListener("change", renderRiskReference);
    $("#profileBank").addEventListener("change", renderProfile);
    $("#profileMetric").addEventListener("change", renderProfile);
    $("#effectBank").addEventListener("change", () => { updateEffectCategories(); renderEffects(); });
    $("#effectCategory").addEventListener("change", renderEffects);
    $("#effectModel").addEventListener("change", renderEffects);
    $("#factorialCategory").addEventListener("change", () => { updateFactorialOutcomes(); renderFactorial(); });
    $("#factorialModel").addEventListener("change", () => { updateFactorialOutcomes(); renderFactorial(); });
    $("#factorialOutcome").addEventListener("change", renderFactorial);
    $("#factorialEffectType").addEventListener("change", renderFactorial);
    $("#interpretBank").addEventListener("change", () => { updateInterpretSecond(); renderInterpretation(); });
    $("#interpretSecond").addEventListener("change", renderInterpretation);
    $("#cardSearch").addEventListener("input", () => { state.cardPage = 1; renderCards(); });
    $("#cardStatus").addEventListener("change", () => { state.cardPage = 1; renderCards(); });
    $("#decisionCards").addEventListener("click", (event) => { const button = event.target.closest("[data-page]"); if (!button) return; state.cardPage += button.dataset.page === "next" ? 1 : -1; renderCards(); });
    $("#exportMenuBtn").addEventListener("click", () => $("#exportPopover").classList.toggle("is-hidden"));
    document.addEventListener("click", (event) => { if (!event.target.closest("#exportMenuBtn") && !event.target.closest("#exportPopover")) $("#exportPopover").classList.add("is-hidden"); });
    $("#openExportWorkspace").addEventListener("click", () => { setView("export"); $("#exportPopover").classList.add("is-hidden"); });
    $("#exportQualityCsv").addEventListener("click", () => exportCSV("数据质量_分层统计.csv", qualityExportRows()));
    $("#exportPCsv").addEventListener("click", () => exportCSV("P偏好分_计算明细.csv", pExportRows()));
    $("#exportPMeanCsv").addEventListener("click", () => exportCSV("平均P_条件内计算明细.csv", pMeanExportRows()));
    $("#exportECsv").addEventListener("click", () => exportCSV("E题组效应_计算明细.csv", eExportRows()));
    $("#exportProfileCsv").addEventListener("click", () => exportCSV("多维偏好_分类描述统计.csv", profileExportRows()));
    $("#exportInterpretationCsv").addEventListener("click", () => exportCSV("P_E_D_分类方向解释字典.csv", interpretationExportRows()));
    $("#exportEffectsCsv").addEventListener("click", () => exportCSV("D分类汇总_计算明细.csv", dExportRows()));
    $("#exportCoverageCsv").addEventListener("click", () => exportCSV("正式分类与指标覆盖.csv", coverageExportRows()));
    $("#exportFactorialCsv").addEventListener("click", () => exportCSV("FACTORIAL_单元与效应.csv", factorialExportRows()));
    $("#exportNominalCsv").addEventListener("click", () => exportCSV("非方向评分_条件分布.csv", nominalExportRows()));
    $("#exportCardsCsv").addEventListener("click", () => exportCSV("题目决策卡.csv", cardsExportRows()));
    $("#exportRowsCsv").addEventListener("click", () => exportCSV("锁定分析明细.csv", rowExportRows()));
    $("#exportAllCsv").addEventListener("click", () => { exportFullStatisticsCSV(); $("#exportPopover").classList.add("is-hidden"); });
    $("#exportPMenu").addEventListener("click", () => { exportCSV("P偏好分_计算明细.csv", pExportRows()); $("#exportPopover").classList.add("is-hidden"); });
    $("#exportPMeanMenu").addEventListener("click", () => { exportCSV("平均P_条件内计算明细.csv", pMeanExportRows()); $("#exportPopover").classList.add("is-hidden"); });
    $("#exportEMenu").addEventListener("click", () => { exportCSV("E题组效应_计算明细.csv", eExportRows()); $("#exportPopover").classList.add("is-hidden"); });
    $("#exportDMenu").addEventListener("click", () => { exportCSV("D分类汇总_计算明细.csv", dExportRows()); $("#exportPopover").classList.add("is-hidden"); });
    $("#exportFactorialMenu").addEventListener("click", () => { exportCSV("FACTORIAL_单元与效应.csv", factorialExportRows(false, true)); $("#exportPopover").classList.add("is-hidden"); });
    $("#exportCoverageMenu").addEventListener("click", () => { exportCSV("正式分类与指标覆盖.csv", coverageExportRows()); $("#exportPopover").classList.add("is-hidden"); });
    $("#exportHtml").addEventListener("click", () => { exportHTML(); $("#exportPopover").classList.add("is-hidden"); });
    $("#exportPdf").addEventListener("click", () => { exportPDF(); $("#exportPopover").classList.add("is-hidden"); });
    $("#exportFullHtml").addEventListener("click", exportHTML);
    $("#exportFullPdf").addEventListener("click", exportPDF);
    $("#exportFullCsv").addEventListener("click", () => exportFullStatisticsCSV());
    $("#selectAllExportDatasets").addEventListener("click", () => { state.exportSelection = new Set(fullExportManifest().map((dataset) => dataset.id)); renderExportCenter(); });
    $("#clearExportDatasets").addEventListener("click", () => { state.exportSelection = new Set(); renderExportCenter(); });
    $("#exportSelectedCsv").addEventListener("click", () => {
      const selected = Array.from(state.exportSelection || []);
      if (!selected.length) return toast("请至少选择一个统计数据表");
      exportFullStatisticsCSV(selected);
    });
    $("#exportDatasetTable").addEventListener("change", (event) => {
      const input = event.target.closest("[data-export-select]");
      if (!input) return;
      if (!state.exportSelection) state.exportSelection = new Set();
      if (input.checked) state.exportSelection.add(input.dataset.exportSelect);
      else state.exportSelection.delete(input.dataset.exportSelect);
    });
    $("#exportDatasetTable").addEventListener("click", (event) => {
      const button = event.target.closest("[data-export-dataset]");
      if (button) exportSingleDataset(button.dataset.exportDataset);
    });
    $$(".copy-text").forEach((button) => button.addEventListener("click", async () => { const element = $(`#${button.dataset.copy}`); await navigator.clipboard.writeText(element.innerText); toast("摘要已复制"); }));
  }

  async function initialize() {
    bindEvents();
    initializeInterpretationControls();
    addBatch(true);
    renderExportCenter();
    state.referenceReady = loadBundledReferences();
    await Promise.all([loadBundledBanks(), state.referenceReady]);
    await loadProjectFromQuery();
  }
  initialize();
})();
