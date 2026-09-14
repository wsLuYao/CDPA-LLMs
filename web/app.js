(() => {
  "use strict";

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));
  const nf = new Intl.NumberFormat("zh-CN");
  const state = {
    presets: {}, banks: [], projects: [], currentProjectId: "",
    currentProject: null, analysis: null, currentStep: 1, modelSerial: 0, pollTimer: null,
    csrfToken: "", user: null, online: false, authenticated: false, appBound: false,
  };
  const BANK_ORDER = ["risk", "ambiguity", "intertemporal", "moral_cni"];
  const MODEL_DISPLAY_ORDER = ["Deepseek-v4-flash", "Doubao-2.0-pro", "Qwen-3.7-flash", "Gemini-3.7-flash", "GPT-5.6-sol", "Grok-4.6"];
  const STATUS_LABELS = {
    queued: "等待启动", running: "正在施测", paused: "已暂停", completed: "已完成",
    completed_with_issues: "部分完成", interrupted: "需要恢复", cancelled: "已停止", failed: "失败",
  };
  const TOUR_STEPS = [
    {route:"home", selector:"#homeHero .hero-copy", icon:"01", title:"欢迎来到测评工作台", description:"这里是一次测评的起点。你可以直接新建正式测评，也可以先用演示模型完整体验流程。", padding:10},
    {route:"home", selector:"#homeHero .hero-actions", icon:"02", title:"第一次使用，先点演示", description:"“先用演示模型体验”不需要 API Key，也不会产生研究数据，适合先熟悉运行和报告页面。", padding:9},
    {route:"home", selector:"#homeBankPreview .bank-tile:first-child", icon:"03", title:"四类题库分别报告", description:"风险、模糊、跨期和道德决策会分别呈现，不会被简单合成为一个未经验证的总分。", padding:8},
    {route:"new", selector:"#measurementStepper", icon:"04", title:"按三步完成配置", description:"依次选择方案、连接模型并确认启动。顶部步骤条会持续提示当前位置，也可以返回已经完成的步骤。", padding:8, wizard:1},
    {route:"new", selector:".mode-card.is-recommended", icon:"05", title:"先选适合的测评方案", description:"正式研究建议选择完整测评；探索性运行可改用自定义方案。流程体验不会调用外部模型。", padding:9, wizard:1},
    {route:"new", selector:"#bankSelectGrid .bank-option:first-child", icon:"06", title:"按需要选择测评内容", description:"可单独选择某类题库，也可保留四类完整测评。预计调用量会随题库和重复次数自动更新。", padding:8, wizard:1},
    {route:"home", selector:"#sidebar .main-nav", icon:"07", title:"运行、报告和项目都在这里", description:"测评启动后到“测评进度”查看状态，完成后进入“结果报告”；历史项目和旧结果导入集中在“项目与导入”。", padding:8, openSidebar:true},
    {route:"home", selector:"#tourReplayButton", icon:"08", title:"随时重新查看引导", description:"以后忘记某个入口，可以点击顶部“新手引导”，或在“使用说明”页面重新播放。现在可以开始你的第一次测评了。", padding:7},
  ];
  let tourIndex = 0;
  let tourActive = false;
  let tourPositionTimer = 0;

  function esc(value) {
    return String(value ?? "").replace(/[&<>'"]/g, (char) => ({"&":"&amp;","<":"&lt;",">":"&gt;","'":"&#39;",'"':"&quot;"})[char]);
  }
  function pct(value, digits = 1) { return `${(Number(value || 0) * 100).toFixed(digits)}%`; }
  function clamp(value, low, high) { return Math.max(low, Math.min(high, Number(value) || 0)); }
  function fmtDate(value) {
    if (!value) return "—";
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString("zh-CN", {month:"2-digit", day:"2-digit", hour:"2-digit", minute:"2-digit"});
  }
  function statusLabel(status) { return STATUS_LABELS[status] || status || "未知"; }
  function modelOrderRank(model) {
    const text = [model?.label, model?.model, model?.provider].filter(Boolean).join(" ").toLowerCase().replace(/[^a-z0-9]+/g, "");
    const rank = MODEL_DISPLAY_ORDER.findIndex((name) => text.includes(name.toLowerCase().replace(/[^a-z0-9]+/g, "")));
    return rank < 0 ? MODEL_DISPLAY_ORDER.length : rank;
  }
  function compareModels(a, b) {
    return modelOrderRank(a) - modelOrderRank(b) || String(a?.label || a?.model || "").localeCompare(String(b?.label || b?.model || ""), "zh-CN", {numeric:true, sensitivity:"base"});
  }
  function toast(message, error = false) {
    const el = $("#toast"); el.textContent = message; el.className = `toast show${error ? " error" : ""}`;
    clearTimeout(toast.timer); toast.timer = setTimeout(() => el.className = "toast", 3300);
  }
  async function api(path, options = {}) {
    const method = String(options.method || "GET").toUpperCase();
    const headers = {"Content-Type": "application/json", ...(options.headers || {})};
    if (!["GET", "HEAD"].includes(method) && state.csrfToken) headers["X-CSRF-Token"] = state.csrfToken;
    const response = await fetch(path, {...options, method, credentials:"same-origin", headers});
    const type = response.headers.get("content-type") || "";
    const payload = type.includes("application/json") ? await response.json() : null;
    if (!response.ok || (payload && payload.ok === false)) {
      if (response.status === 401 && !path.startsWith("/api/auth/")) showAuth();
      throw new Error(payload?.error || `请求失败（${response.status}）`);
    }
    return payload;
  }

  function projectStorageKey() { return `cdpa_current_project_${state.user?.id || "local"}`; }
  function showAuth() {
    state.authenticated = false;
    clearInterval(state.pollTimer);
    $("#appShell").classList.add("is-hidden");
    $("#authGate").classList.remove("is-hidden");
    document.body.classList.remove("is-booting");
  }
  function showApp(auth) {
    state.authenticated = true; state.online = Boolean(auth.online); state.user = auth.user; state.csrfToken = auth.csrf_token || "";
    state.currentProjectId = localStorage.getItem(projectStorageKey()) || "";
    $("#authGate").classList.add("is-hidden"); $("#appShell").classList.remove("is-hidden");
    $("#userEmail").textContent = auth.user?.email || "本地账号";
    $("#userInitial").textContent = String(auth.user?.email || "U").slice(0, 1).toUpperCase();
    $("#deploymentLabel").textContent = state.online ? "云端在线" : "本机运行";
    $("#deploymentNote").textContent = state.online ? "数据保存在专属工作区" : "数据保存在当前电脑";
    $("#logoutButton").classList.toggle("is-hidden", !state.online);
    document.body.classList.remove("is-booting");
  }
  function showAuthTab(name) {
    $$('[data-auth-tab]').forEach((button) => button.classList.toggle("is-active", button.dataset.authTab === name));
    $$('[data-auth-form]').forEach((form) => form.classList.toggle("is-hidden", form.dataset.authForm !== name));
  }
  async function submitAuth(event, action) {
    event.preventDefault();
    const form = event.currentTarget; const button = $('button[type="submit"]', form); const original = button.innerHTML;
    button.disabled = true; button.textContent = action === "login" ? "正在验证…" : "正在创建…";
    const payload = action === "login" ? {email:$("#loginEmail").value, password:$("#loginPassword").value} : {email:$("#registerEmail").value, password:$("#registerPassword").value, registration_code:$("#registrationCode").value};
    try {
      const result = await api(`/api/auth/${action}`, {method:"POST", body:JSON.stringify(payload)});
      state.csrfToken = result.csrf_token || ""; toast(action === "login" ? "登录成功" : "账号已创建");
      setTimeout(() => location.reload(), 180);
    } catch (error) { toast(error.message, true); }
    finally { button.disabled = false; button.innerHTML = original; }
  }
  function bindAuthEvents() {
    $$('[data-auth-tab]').forEach((button) => button.addEventListener("click", () => showAuthTab(button.dataset.authTab)));
    $("#loginForm").addEventListener("submit", (event) => submitAuth(event, "login"));
    $("#registerForm").addEventListener("submit", (event) => submitAuth(event, "register"));
    $("#logoutButton").addEventListener("click", async () => {
      try { await api("/api/auth/logout", {method:"POST", body:"{}"}); } catch (_) { /* session may already be gone */ }
      localStorage.removeItem(projectStorageKey()); location.reload();
    });
  }

  function navigate(route) {
    const target = $(`#view-${route}`) ? route : "home";
    $$(".view").forEach((el) => el.classList.toggle("is-active", el.id === `view-${target}`));
    $$(".nav-item").forEach((el) => el.classList.toggle("is-active", el.dataset.route === target));
    const view = $(`#view-${target}`);
    $("#pageTitle").textContent = view.dataset.title;
    $("#pageEyebrow").textContent = view.dataset.eyebrow;
    $("#sidebar").classList.remove("is-open");
    history.replaceState(null, "", `#${target}`);
    window.scrollTo({top: 0, behavior: "smooth"});
    if (target === "history" || target === "home") refreshProjects();
    if (target === "run" && state.currentProjectId) refreshCurrentProject();
    if (target === "report" && state.currentProjectId) loadReport(state.currentProjectId);
  }

  function tourStorageKey() { return `cdpa_tour_seen_${state.user?.id || "local"}`; }
  function markTourSeen() {
    try { localStorage.setItem(tourStorageKey(), "1"); } catch (_) { /* private browsing may block storage */ }
  }
  function hasSeenTour() {
    try { return localStorage.getItem(tourStorageKey()) === "1"; } catch (_) { return false; }
  }
  function positionTour(step) {
    if (!tourActive) return;
    const fallback = $(".view.is-active");
    let target = $(step.selector) || fallback;
    if (!target || !target.getClientRects().length) target = fallback;
    if (!target) return;
    target.scrollIntoView({block:"center", inline:"nearest", behavior:"auto"});
    window.requestAnimationFrame(() => {
      if (!tourActive) return;
      const rect = target.getBoundingClientRect();
      const pad = Number(step.padding || 8);
      const viewportWidth = window.innerWidth;
      const viewportHeight = window.innerHeight;
      const left = Math.max(8, rect.left - pad);
      const top = Math.max(8, rect.top - pad);
      const width = Math.max(40, Math.min(viewportWidth - left - 8, rect.width + pad * 2));
      const height = Math.max(40, Math.min(viewportHeight - top - 8, rect.height + pad * 2));
      const spotlight = $("#tourSpotlight");
      spotlight.style.left = `${left}px`;
      spotlight.style.top = `${top}px`;
      spotlight.style.width = `${width}px`;
      spotlight.style.height = `${height}px`;
      spotlight.style.borderRadius = step.selector.includes("nav") ? "15px" : "18px";

      const bubble = $("#tourBubble");
      const bubbleWidth = bubble.offsetWidth;
      const bubbleHeight = bubble.offsetHeight;
      const gap = 18;
      let bubbleLeft;
      let bubbleTop;
      if (rect.right + gap + bubbleWidth <= viewportWidth - 12) {
        bubbleLeft = rect.right + gap;
        bubbleTop = rect.top + Math.min(18, Math.max(0, rect.height / 2 - bubbleHeight / 2));
      } else if (rect.left - gap - bubbleWidth >= 12) {
        bubbleLeft = rect.left - gap - bubbleWidth;
        bubbleTop = rect.top + Math.min(18, Math.max(0, rect.height / 2 - bubbleHeight / 2));
      } else if (rect.bottom + gap + bubbleHeight <= viewportHeight - 12) {
        bubbleLeft = rect.left + Math.max(0, Math.min(rect.width - bubbleWidth, 20));
        bubbleTop = rect.bottom + gap;
      } else {
        bubbleLeft = rect.left + Math.max(0, Math.min(rect.width - bubbleWidth, 20));
        bubbleTop = rect.top - gap - bubbleHeight;
      }
      bubble.style.left = `${clamp(bubbleLeft, 12, Math.max(12, viewportWidth - bubbleWidth - 12))}px`;
      bubble.style.top = `${clamp(bubbleTop, 12, Math.max(12, viewportHeight - bubbleHeight - 12))}px`;
    });
  }
  function renderTourStep() {
    if (!tourActive) return;
    const step = TOUR_STEPS[tourIndex];
    navigate(step.route);
    if (step.wizard) showStep(step.wizard);
    if (step.openSidebar && window.matchMedia("(max-width: 960px)").matches) $("#sidebar").classList.add("is-open");
    $("#tourCounter").textContent = `${tourIndex + 1} / ${TOUR_STEPS.length}`;
    $("#tourIcon").textContent = step.icon;
    $("#tourTitle").textContent = step.title;
    $("#tourDescription").textContent = step.description;
    $("#tourBack").classList.toggle("is-hidden", tourIndex === 0);
    $("#tourNext").textContent = tourIndex === TOUR_STEPS.length - 1 ? "完成引导" : "下一步";
    $("#tourProgress").innerHTML = TOUR_STEPS.map((_, index) => `<i class="${index === tourIndex ? "is-active" : index < tourIndex ? "is-done" : ""}"></i>`).join("");
    clearTimeout(tourPositionTimer);
    const sidebarDelay = step.openSidebar && window.matchMedia("(max-width: 960px)").matches ? 260 : 40;
    tourPositionTimer = setTimeout(() => positionTour(step), sidebarDelay);
    $("#tourBubble").focus({preventScroll:true});
  }
  function startTour() {
    if (!state.authenticated) return;
    tourIndex = 0;
    tourActive = true;
    $("#productTour").classList.remove("is-hidden");
    document.body.classList.add("tour-open");
    renderTourStep();
  }
  function closeTour(remember = true) {
    if (!tourActive) return;
    tourActive = false;
    clearTimeout(tourPositionTimer);
    $("#productTour").classList.add("is-hidden");
    $("#sidebar").classList.remove("is-open");
    document.body.classList.remove("tour-open");
    if (remember) markTourSeen();
    $("#tourReplayButton").focus({preventScroll:true});
  }
  function nextTourStep() {
    if (tourIndex >= TOUR_STEPS.length - 1) return closeTour(true);
    tourIndex += 1;
    renderTourStep();
  }
  function previousTourStep() {
    if (tourIndex <= 0) return;
    tourIndex -= 1;
    renderTourStep();
  }
  function handleTourKeydown(event) {
    if (!tourActive) return;
    if (event.key === "Escape") { event.preventDefault(); closeTour(true); }
    if (event.key === "ArrowRight") { event.preventDefault(); nextTourStep(); }
    if (event.key === "ArrowLeft") { event.preventDefault(); previousTourStep(); }
    if (event.key === "Tab") {
      const bubble = $("#tourBubble");
      const focusable = $$("button:not([disabled]):not(.is-hidden)", bubble);
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && (document.activeElement === first || document.activeElement === bubble)) {
        event.preventDefault(); last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault(); first.focus();
      }
    }
  }

  function bankMeta(id) { return state.banks.find((bank) => bank.bank_id === id) || {bank_id:id, label:id, short:"", row_count:0, color:"#26746a"}; }
  function renderBanks() {
    const home = $("#homeBankPreview");
    home.innerHTML = BANK_ORDER.map((id) => {
      const bank = bankMeta(id); const abbr = {risk:"R", ambiguity:"A", intertemporal:"T", moral_cni:"M"}[id];
      return `<article class="bank-tile" style="--bank-color:${esc(bank.color)}" data-abbr="${abbr}"><i></i><h3>${esc(bank.label)}</h3><p>${esc(bank.short)}</p><strong>${nf.format(bank.row_count)}<small>个测量条件</small></strong></article>`;
    }).join("");
    $("#bankSelectGrid").innerHTML = BANK_ORDER.map((id) => {
      const bank = bankMeta(id);
      return `<label class="bank-option" style="--bank-color:${esc(bank.color)}"><input type="checkbox" name="bank" value="${id}" checked><i></i><b>${esc(bank.label)}</b><small>${esc(bank.short)}</small><em>${nf.format(bank.row_count)} 个条件</em></label>`;
    }).join("");
    $$('[name="bank"]').forEach((el) => el.addEventListener("change", updateEstimate));
  }

  function updateEstimate() {
    const rows = $$('[name="bank"]:checked').reduce((sum, el) => sum + Number(bankMeta(el.value).row_count || 0), 0);
    const repetitions = Number($("#repetitions").value || 1);
    const multiplier = $("#balanced6").checked ? 6 : 1;
    const perModel = rows * repetitions * multiplier;
    const models = Math.max(1, $$(".model-card", $("#modelList")).length);
    $("#callEstimate").textContent = `${nf.format(perModel)} 次 / 模型`;
    $("#reviewCalls").textContent = `${nf.format(perModel * models)} 次`;
    $("#estimateNote").textContent = multiplier === 6 ? "已开启六种选项顺序平衡，调用量为常规随机呈现的 6 倍。" : "实际用时和费用取决于服务商；平台不会自动扣费。";
    return {rows, repetitions, multiplier, perModel, total: perModel * models};
  }

  function providerOptions(selected) {
    return Object.entries(state.presets).map(([id, preset]) => `<option value="${esc(id)}" ${id === selected ? "selected" : ""}>${esc(preset.label)}</option>`).join("");
  }
  function applyPreset(card, providerId, preserveModel = false) {
    const preset = state.presets[providerId]; if (!preset) return;
    $(".provider", card).value = providerId;
    $(".base-url", card).value = preset.base_url || "";
    $(".api-mode", card).value = preset.api_mode || "chat";
    if (!preserveModel || !$(".model-id", card).value) $(".model-id", card).value = preset.model || "";
    $(".model-id", card).placeholder = preset.model_placeholder || "填写模型 ID";
    $(".model-note", card).textContent = preset.note || "";
    const isDemo = providerId === "demo";
    $(".api-key", card).disabled = isDemo;
    $(".api-key", card).placeholder = isDemo ? "本地演示无需密钥" : "仅保留在当前内存";
    $(".connection-state", card).textContent = isDemo ? "本地就绪" : "未测试";
    $(".connection-state", card).className = `connection-state${isDemo ? " ok" : ""}`;
  }
  function renumberModels() {
    $$(".model-card", $("#modelList")).forEach((card, index) => {
      $(".model-number", card).textContent = `M${index + 1}`;
      if (!$(".model-label", card).dataset.edited) $(".model-label", card).value = `模型 ${index + 1}`;
      $(".remove-model", card).classList.toggle("is-hidden", $$(".model-card", $("#modelList")).length === 1);
    });
    updateEstimate();
  }
  function addModel(config = {}) {
    if ($$(".model-card", $("#modelList")).length >= 6) return toast("一个项目最多添加 6 个模型", true);
    const card = $("#modelTemplate").content.firstElementChild.cloneNode(true);
    const provider = config.provider || "openai";
    $(".provider", card).innerHTML = providerOptions(provider);
    $(".model-label", card).value = config.label || `模型 ${++state.modelSerial}`;
    if (config.label) $(".model-label", card).dataset.edited = "1";
    applyPreset(card, provider);
    const mapping = {model:".model-id", api_key:".api-key", base_url:".base-url", api_mode:".api-mode", timeout_sec:".timeout-sec", temperature:".temperature", top_p:".top-p", max_output_tokens:".max-tokens", seed:".model-seed"};
    Object.entries(mapping).forEach(([key, selector]) => { if (config[key] !== undefined && config[key] !== null) $(selector, card).value = config[key]; });
    if (config.send_sampling === false) $(".send-sampling", card).checked = false;
    $(".provider", card).addEventListener("change", (event) => applyPreset(card, event.target.value));
    $(".model-label", card).addEventListener("input", (event) => event.target.dataset.edited = "1");
    $(".remove-model", card).addEventListener("click", () => { card.remove(); renumberModels(); });
    $(".toggle-model-advanced", card).addEventListener("click", (event) => { $(".model-advanced", card).classList.toggle("is-hidden"); event.target.textContent = $(".model-advanced", card).classList.contains("is-hidden") ? "高级设置⌄" : "收起高级设置⌃"; });
    $(".reveal-key", card).addEventListener("click", (event) => { const field = $(".api-key", card); field.type = field.type === "password" ? "text" : "password"; event.target.textContent = field.type === "password" ? "显示" : "隐藏"; });
    $(".test-connection", card).addEventListener("click", () => testConnection(card));
    $("#modelList").append(card); renumberModels(); return card;
  }
  function resetModels(config = {}) { $("#modelList").innerHTML = ""; state.modelSerial = 0; addModel(config); }
  function collectModel(card, includeId = false) {
    const number = (selector, fallback = null) => { const value = $(selector, card).value; return value === "" ? fallback : Number(value); };
    const payload = {
      label: $(".model-label", card).value.trim(), provider: $(".provider", card).value,
      model: $(".model-id", card).value.trim(), api_key: $(".api-key", card).value.trim(),
      base_url: $(".base-url", card).value.trim(), api_mode: $(".api-mode", card).value,
      timeout_sec: number(".timeout-sec", 60), temperature: number(".temperature", null), top_p: number(".top-p", null),
      max_output_tokens: number(".max-tokens", 256), seed: number(".model-seed", null), send_sampling: $(".send-sampling", card).checked,
    };
    if (includeId && card.dataset.modelId) payload.model_id = card.dataset.modelId;
    return payload;
  }
  async function testConnection(card) {
    const button = $(".test-connection", card); const badge = $(".connection-state", card); button.disabled = true; button.textContent = "测试中…";
    try {
      const result = await api("/api/test-connection", {method:"POST", body:JSON.stringify(collectModel(card))});
      badge.textContent = result.result.message; badge.className = `connection-state ${result.result.ok ? "ok" : "bad"}`;
      toast(`${collectModel(card).label}：${result.result.message}`);
    } catch (error) { badge.textContent = "连接失败"; badge.className = "connection-state bad"; toast(error.message, true); }
    finally { button.disabled = false; button.textContent = "测试连接"; }
  }

  function setMode(mode) {
    if (mode === "demo") {
      $("#repetitions").value = "1"; $("#concurrency").value = "8"; $("#delayMs").value = "0";
      resetModels({provider:"demo", label:"本地演示模型"});
    } else if (mode === "full") {
      $("#repetitions").value = "5"; $("#concurrency").value = "2"; $("#delayMs").value = "250";
      if ($$(".model-card").length === 1 && $(".provider", $(".model-card")).value === "demo") resetModels({provider:"openai"});
      $$('[name="bank"]').forEach((el) => el.checked = true);
    }
    updateEstimate();
  }
  function showStep(step) {
    if (step > 1 && !validateStep(step - 1)) return;
    state.currentStep = step;
    $$(".wizard-panel").forEach((el) => el.classList.toggle("is-active", Number(el.dataset.wizard) === step));
    $$(".step").forEach((el) => { const n = Number(el.dataset.step); el.classList.toggle("is-active", n === step); el.classList.toggle("is-done", n < step); });
    if (step === 3) renderReview();
    window.scrollTo({top:0, behavior:"smooth"});
  }
  function validateStep(step) {
    if (step === 1) {
      if (!$$('[name="bank"]:checked').length) { toast("请至少选择一类测评内容", true); return false; }
      if (!$("#projectName").value.trim()) { $("#projectName").focus(); toast("请填写项目名称", true); return false; }
    }
    if (step === 2) {
      const cards = $$(".model-card", $("#modelList"));
      if (!cards.length) { toast("请至少添加一个模型", true); return false; }
      for (const card of cards) {
        const model = collectModel(card);
        if (!model.label || !model.model) { toast("请完整填写模型名称和模型 ID", true); card.scrollIntoView({behavior:"smooth", block:"center"}); return false; }
        if (model.provider !== "demo" && !model.api_key) { toast(`${model.label} 还没有填写 API Key`, true); $(".api-key", card).focus(); return false; }
      }
    }
    return true;
  }
  function projectPayload() {
    const mode = $('[name="mode"]:checked').value;
    return {
      name: $("#projectName").value.trim(), mode,
      bank_ids: $$('[name="bank"]:checked').map((el) => el.value), repetitions: Number($("#repetitions").value),
      models: $$(".model-card", $("#modelList")).map((card) => collectModel(card)).sort(compareModels),
      run_options: {
        permutation_mode: $("#balanced6").checked ? "balanced6" : "random", shuffle_items: $("#shuffleItems").checked,
        random_seed: Number($("#randomSeed").value), concurrency: Number($("#concurrency").value), delay_ms: Number($("#delayMs").value),
        technical_retries: Number($("#technicalRetries").value), format_repair: $("#formatRepair").checked,
      },
    };
  }
  function renderReview() {
    const payload = projectPayload(); const estimate = updateEstimate();
    const banks = payload.bank_ids.map((id) => bankMeta(id).label).join("、");
    $("#reviewSummary").innerHTML = `<div class="review-block"><h3>项目设置</h3><div class="review-line"><span>项目名称</span><b>${esc(payload.name)}</b></div><div class="review-line"><span>测评方案</span><b>${payload.mode === "demo" ? "流程体验" : payload.mode === "full" ? "完整测评" : "自定义测评"}</b></div><div class="review-line"><span>测评内容</span><b>${esc(banks)}</b></div><div class="review-line"><span>独立重复</span><b>每题 ${payload.repetitions} 次</b></div></div><div class="review-block"><h3>模型（${payload.models.length}）</h3>${payload.models.map((model) => `<div class="review-line"><span>${esc(model.label)}</span><b>${esc(state.presets[model.provider]?.label || model.provider)} · ${esc(model.model)}</b></div>`).join("")}</div><div class="review-block"><h3>运行控制</h3><div class="review-line"><span>选项位置</span><b>${payload.run_options.permutation_mode === "balanced6" ? "六种顺序完全平衡" : "每次随机呈现"}</b></div><div class="review-line"><span>并发 / 间隔</span><b>${payload.run_options.concurrency} / ${payload.run_options.delay_ms} ms</b></div></div>`;
    $("#reviewCalls").textContent = `${nf.format(estimate.total)} 次`;
  }

  async function startProject(event) {
    event.preventDefault();
    if (!validateStep(2)) { showStep(2); return; }
    if (!$("#boundaryConsent").checked) return toast("请先确认已理解结果的适用边界", true);
    const button = $("#startProject"); button.disabled = true; button.textContent = "正在建立项目…";
    try {
      const result = await api("/api/projects", {method:"POST", body:JSON.stringify(projectPayload())});
      selectProject(result.project.project_id); state.currentProject = result.project; renderRun(result.project); navigate("run"); startPolling();
      toast("项目已启动，结果将持续保存");
    } catch (error) { toast(error.message, true); }
    finally { button.disabled = false; button.textContent = "开始测评"; }
  }

  function selectProject(projectId) {
    state.currentProjectId = projectId; state.analysis = null;
    localStorage.setItem(projectStorageKey(), projectId);
  }
  async function refreshProjects() {
    try {
      const result = await api("/api/projects"); state.projects = result.projects || []; renderRecent(); renderProjectTable();
    } catch (error) { toast(error.message, true); }
  }
  function renderRecent() {
    const root = $("#recentProjects"); if (!root) return;
    if (!state.projects.length) { root.innerHTML = '<div class="empty-inline">还没有项目。创建测评后，运行状态和报告会显示在这里。</div>'; return; }
    root.innerHTML = state.projects.slice(0, 3).map((project) => `<article class="recent-card" data-project="${esc(project.project_id)}"><div class="row"><span class="status-chip ${esc(project.status)}">${esc(statusLabel(project.status))}</span><small>${esc(fmtDate(project.updated_at))}</small></div><h3>${esc(project.name)}</h3><p>${project.models?.length || 0} 个模型 · ${project.bank_ids?.length || 0} 类测评 · ${Number(project.progress || 0).toFixed(1)}%</p></article>`).join("");
    $$('[data-project]', root).forEach((el) => el.addEventListener("click", () => openProject(el.dataset.project)));
  }
  function renderProjectTable() {
    const body = $("#projectTableBody"); if (!body) return;
    if (!state.projects.length) { body.innerHTML = '<tr><td colspan="6"><div class="empty-inline">暂无项目。你可以新建测评，或导入原平台结果。</div></td></tr>'; return; }
    body.innerHTML = state.projects.map((project) => {
      const banks = (project.bank_ids || []).map((id) => bankMeta(id).label).join("、") || "历史结果";
      const reportReady = (project.models || []).some((model) => model.run_id && Number(model.completed || 0) > 0);
      return `<tr><td class="project-name"><b>${esc(project.name)}</b><small>${esc(project.project_id)}</small></td><td>${project.models?.length || 0} 个</td><td>${esc(banks)}</td><td><span class="status-chip ${esc(project.status)}">${esc(statusLabel(project.status))}</span></td><td>${esc(fmtDate(project.updated_at))}</td><td><div class="table-actions"><button class="mini-btn" data-action="progress" data-id="${esc(project.project_id)}">进度</button>${reportReady ? `<button class="mini-btn" data-action="report" data-id="${esc(project.project_id)}">报告</button>` : ""}<a class="mini-btn" href="/api/projects/${encodeURIComponent(project.project_id)}/download">下载</a></div></td></tr>`;
    }).join("");
    $$('[data-action]', body).forEach((button) => button.addEventListener("click", () => { selectProject(button.dataset.id); navigate(button.dataset.action === "report" ? "report" : "run"); }));
  }
  function openProject(id) {
    const project = state.projects.find((item) => item.project_id === id); selectProject(id);
    navigate(project && ["completed", "completed_with_issues"].includes(project.status) ? "report" : "run");
  }

  async function refreshCurrentProject() {
    if (!state.currentProjectId) { renderRun(null); return; }
    try { const result = await api(`/api/projects/${encodeURIComponent(state.currentProjectId)}`); state.currentProject = result.project; renderRun(result.project); }
    catch (error) { renderRun(null); if (!/未找到/.test(error.message)) toast(error.message, true); }
  }
  function renderRun(project) {
    $("#runEmpty").classList.toggle("is-hidden", Boolean(project)); $("#runContent").classList.toggle("is-hidden", !project); if (!project) return;
    $("#runProjectName").textContent = project.name; $("#runStatusLabel").textContent = project.status_label || statusLabel(project.status);
    $("#runStatusDot").style.background = ["failed","cancelled","interrupted"].includes(project.status) ? "#e38e83" : project.status === "paused" ? "#d4a263" : "#75c89f";
    const progress = clamp(project.progress, 0, 100); $("#overallProgressText").textContent = `${progress.toFixed(1)}%`; $("#overallProgressBar").style.width = `${progress}%`;
    $("#overallCount").textContent = `${nf.format(project.completed || 0)} / ${nf.format(project.total || project.estimated_calls || 0)} 次调用`;
    $("#pauseProject").classList.toggle("is-hidden", !["queued","running"].includes(project.status));
    $("#continueProject").classList.toggle("is-hidden", project.status !== "paused");
    $("#cancelProject").classList.toggle("is-hidden", !["queued","running","paused"].includes(project.status));
    $("#viewReport").classList.toggle("is-hidden", !["completed","completed_with_issues"].includes(project.status));
    $("#resumeProject").classList.toggle("is-hidden", !["interrupted","cancelled","failed","completed_with_issues"].includes(project.status) || !(project.models || []).some((m) => m.status !== "completed"));
    $("#modelProgressList").innerHTML = (project.models || []).map((model) => {
      const total = Number(model.total || project.calls_per_model || 0), done = Number(model.completed || 0), rate = total ? clamp(done / total * 100, 0, 100) : 0;
      const recent = (model.recent_results || []).slice(-4).map((row) => `<span>${esc(row.ItemID || "—")} · ${esc(row.FinalStatus || "")}</span>`).join("");
      return `<article class="model-progress-card"><div class="model-progress-head"><div><h3>${esc(model.label)}</h3><p>${esc(state.presets[model.provider]?.label || model.provider)} · ${esc(model.model)}</p></div><span class="status-chip ${esc(model.status)}">${esc(statusLabel(model.status))}</span></div><div class="progress-track"><i style="width:${rate}%"></i></div><div class="model-stats"><span>完成 <b>${nf.format(done)} / ${nf.format(total)}</b></span><span>直接有效 <b>${nf.format(Math.max(0, Number(model.valid || 0) - Number(model.repaired_valid || 0)))}</b></span><span>格式修复 <b>${nf.format(model.repaired_valid || 0)}</b></span><span>技术失败 <b>${nf.format(model.tech_error || 0)}</b></span></div>${recent ? `<div class="recent-mini">${recent}</div>` : ""}${model.error ? `<p class="chart-note">${esc(model.error)}</p>` : ""}</article>`;
    }).join("");
  }
  function startPolling() {
    clearInterval(state.pollTimer);
    state.pollTimer = setInterval(async () => {
      if (!state.currentProjectId) return;
      try {
        const result = await api(`/api/projects/${encodeURIComponent(state.currentProjectId)}`); state.currentProject = result.project;
        if ($("#view-run").classList.contains("is-active")) renderRun(result.project);
        if (["completed","completed_with_issues","failed","interrupted","cancelled"].includes(result.project.status)) { clearInterval(state.pollTimer); refreshProjects(); }
      } catch (_) { clearInterval(state.pollTimer); }
    }, 900);
  }
  async function projectAction(action, payload = {}) {
    if (!state.currentProjectId) return;
    try {
      const result = await api(`/api/projects/${encodeURIComponent(state.currentProjectId)}/${action}`, {method:"POST", body:JSON.stringify(payload)});
      state.currentProject = result.project; renderRun(result.project); toast(result.project.status_label || "操作完成"); startPolling();
    } catch (error) { toast(error.message, true); }
  }

  async function loadReport(projectId) {
    if (!projectId) { renderReport(null); return; }
    $("#reportEmpty").innerHTML = '<div>…</div><h2>正在生成报告</h2><p>读取有效回答、覆盖与情境结果。</p>';
    $("#reportEmpty").classList.remove("is-hidden"); $("#reportContent").classList.add("is-hidden");
    try {
      const [projectResult, analysisResult] = await Promise.all([api(`/api/projects/${encodeURIComponent(projectId)}`), api(`/api/projects/${encodeURIComponent(projectId)}/analysis`)]);
      state.currentProject = projectResult.project; state.analysis = analysisResult.analysis; renderReport(state.analysis);
    } catch (error) {
      $("#reportEmpty").innerHTML = `<div>!</div><h2>暂时还不能生成报告</h2><p>${esc(error.message)}</p><button class="btn btn-secondary" type="button" data-route="run">查看运行进度</button>`;
      $('[data-route="run"]', $("#reportEmpty")).addEventListener("click", () => navigate("run"));
    }
  }
  function renderReport(analysis) {
    $("#reportEmpty").classList.toggle("is-hidden", Boolean(analysis)); $("#reportContent").classList.toggle("is-hidden", !analysis); if (!analysis) return;
    $("#reportTitle").textContent = analysis.project_name || "AI决策偏好测评报告";
    $("#reportSubtitle").textContent = `${analysis.models.length} 个模型 · ${analysis.selected_banks.length} 类决策 · ${nf.format(analysis.quality.total_records)} 条记录`;
    $("#downloadProject").href = `/api/projects/${encodeURIComponent(analysis.project_id)}/download`;
    $("#advancedLink").href = `/advanced/index.html?project_id=${encodeURIComponent(analysis.project_id)}`;
    const quality = analysis.quality;
    $("#reportQuality").innerHTML = [
      ["结果状态", quality.status, quality.formal_ready ? "覆盖与重复达到正式阈值" : "请结合覆盖与重复次数解读"],
      ["有效回答", pct(quality.valid_rate), `${nf.format(quality.valid_records)} / ${nf.format(quality.non_technical_records)} 条非技术记录`],
      ["首次格式合格", pct(quality.first_valid_rate), `格式修复 ${nf.format(quality.repaired_records)} · 技术失败 ${nf.format(quality.technical_errors)}`],
      ["独立重复", `${quality.repetitions} 次`, quality.repetitions >= 5 ? "达到正式推荐次数" : "当前仅作描述性参考"],
    ].map(([label,value,note]) => `<div class="quality-card"><span>${esc(label)}</span><strong>${esc(value)}</strong><small>${esc(note)}</small></div>`).join("");
    const select = $("#reportModel"); select.innerHTML = analysis.models.map((model) => `<option>${esc(model)}</option>`).join("");
    select.onchange = () => renderReportModel(select.value);
    $("#boundaryList").innerHTML = analysis.interpretation_boundaries.map((item) => `<li>${esc(item)}</li>`).join("");
    renderCrossModelReport();
    renderReportModel(select.value || analysis.models[0]);
  }
  function renderReportModel(model) {
    const analysis = state.analysis; if (!analysis) return;
    const profiles = analysis.profiles.filter((row) => row.model === model);
    $("#profileList").innerHTML = analysis.selected_banks.map((bankId) => {
      const meta = analysis.bank_meta[bankId] || bankMeta(bankId); const rows = profiles.filter((row) => row.bank_id === bankId);
      if (!rows.length) return `<article class="profile-bank" style="--bank-color:${meta.color}"><div class="profile-bank-head"><div><h3>${esc(meta.label)}</h3><p>${esc(meta.short)}</p></div><span>暂无足够有效数据</span></div></article>`;
      return `<article class="profile-bank" style="--bank-color:${meta.color}"><div class="profile-bank-head"><div><h3>${esc(meta.label)}</h3><p>${esc(meta.short)}</p></div><span>${rows.length} 个观察维度</span></div><div class="profile-rows">${rows.map(profileRow).join("")}</div></article>`;
    }).join("");
    renderDomainChart(model); renderContextEffects(model); renderStability(model); renderStabilityDetails(model); renderOptionDistribution(model); renderHumanChart(model); renderHumanGapSummary(model);
    const insights = analysis.insights.filter((row) => row.model === model);
    $("#insightGrid").innerHTML = insights.length ? insights.map((row, i) => `<article class="insight-card"><span>OBSERVATION ${String(i + 1).padStart(2,"0")}</span><h3>${esc(row.title)}</h3><p>${esc(row.text)}</p></article>`).join("") : '<div class="empty-inline">当前有效信息不足，尚不能生成可靠观察。</div>';
  }
  function profileRow(row) {
    if (row.mean_p === null || row.mean_p === undefined) {
      const l1 = Math.round(row.l1_top_rate * 100), l2 = Math.round(row.l2_top_rate * 100), l3 = Math.max(0, 100 - l1 - l2);
      return `<div class="profile-row"><div class="profile-label"><b>${esc(row.category || row.category_id)}</b><small>${esc(row.second_level || "名义排序结果")}</small></div><div><div style="height:10px;display:flex;overflow:hidden;border-radius:8px"><i style="width:${l1}%;background:#879d98"></i><i style="width:${l2}%;background:#d4b68c"></i><i style="width:${l3}%;background:var(--bank-color)"></i></div><div class="preference-ends"><span>L1首选 ${l1}%</span><span>L2 ${l2}% · L3 ${l3}%</span></div></div><div class="profile-score"><strong>排序</strong><small>不计算方向分</small></div></div>`;
    }
    const score = clamp(row.score_0_100, 0, 100); const leaning = score >= 52 ? row.positive_label : score <= 48 ? row.negative_label : "相对平衡";
    return `<div class="profile-row"><div class="profile-label"><b>${esc(row.category || row.category_id)}</b><small>${esc(row.second_level || "")} · ${esc(leaning)}</small></div><div class="preference-scale" style="--value:${score}"><i class="preference-dot"></i><div class="preference-ends"><span>${esc(row.negative_label)}</span><span>${esc(row.positive_label)}</span></div></div><div class="profile-score"><strong>${score.toFixed(1)}</strong><small>偏好位置 / 100</small></div></div>`;
  }

  function numberOrDash(value, digits = 3) {
    return value === null || value === undefined || !Number.isFinite(Number(value)) ? "—" : Number(value).toFixed(digits);
  }
  function rateOrDash(value, digits = 1) {
    return value === null || value === undefined || !Number.isFinite(Number(value)) ? "—" : `${(Number(value) * 100).toFixed(digits)}%`;
  }
  function signedOrDash(value, digits = 3) {
    if (value === null || value === undefined || !Number.isFinite(Number(value))) return "—";
    const number = Number(value); return `${number > 0 ? "+" : ""}${number.toFixed(digits)}`;
  }
  function heatStyle(value, kind = "p") {
    if (value === null || value === undefined || !Number.isFinite(Number(value))) return {fill:"#eef1f5", opacity:1, text:"#8b95a5"};
    const number = Number(value);
    const magnitude = kind === "r" ? Math.min(1, Math.abs(number)) : Math.min(1, Math.abs(number));
    const positive = kind === "r" ? "#236e63" : "#d27a2c";
    const negative = "#326fbe";
    return {fill:number >= 0 ? positive : negative, opacity:0.16 + magnitude * 0.78, text:magnitude >= 0.55 ? "#ffffff" : "#344052"};
  }
  function renderCrossModelReport() {
    const analysis = state.analysis; if (!analysis) return;
    const findings = analysis.report_findings || [];
    $("#reportFindings").innerHTML = findings.length ? findings.map((row, index) => `<article class="finding-card"><span>${String(index + 1).padStart(2,"0")} · ${esc(row.label)}</span><strong>${esc(row.value)}</strong><p>${esc(row.detail)}</p></article>`).join("") : '<div class="empty-inline">至少需要两个模型和足够的共同维度才能生成横向摘要。</div>';

    $("#modelScorecardTable").innerHTML = (analysis.model_scorecards || []).map((row) => `<tr><th scope="row">${esc(row.model)}</th><td>${rateOrDash(row.valid_rate)}</td><td>${rateOrDash(row.first_valid_rate)}</td><td>${rateOrDash(row.coverage)}</td><td>${rateOrDash(row.top_consistency)}</td><td>${rateOrDash(row.full_consistency)}</td><td>${row.largest_context_category ? `<b>${esc(row.largest_context_category)}</b><small>${numberOrDash(row.largest_context_range,2)}</small>` : "—"}</td><td>${numberOrDash(row.human_mean_absolute_gap,3)}</td></tr>`).join("") || '<tr><td colspan="8">暂无足够数据</td></tr>';

    renderPublicProfileHeatmap();
    renderDivergenceReport();
    renderPublicSimilarity();
    $("#coverageReportTable").innerHTML = (analysis.coverage || []).map((row) => `<tr><th scope="row">${esc(row.model)}</th><td>${esc(row.bank)}</td><td>${nf.format(row.complete_items)} / ${nf.format(row.planned_items)}</td><td>${rateOrDash(row.coverage)}</td><td>每题 ≥ ${nf.format(row.threshold)} 次</td><td><span class="readiness-pill ${row.ready ? "ready" : "limited"}">${row.ready ? "正式就绪" : "描述性"}</span></td></tr>`).join("") || '<tr><td colspan="6">暂无覆盖数据</td></tr>';
    const method = analysis.report_method || {};
    $("#reportMethod").innerHTML = Object.entries(method).map(([key, value]) => `<article><span>${esc({profile_unit:"画像单位",similarity:"相似性",context:"情境范围",human:"人类参照",p_value_format:"统计格式"}[key] || key)}</span><p>${esc(value)}</p></article>`).join("");
  }
  function renderPublicProfileHeatmap() {
    const analysis = state.analysis, rows = (analysis.category_divergence || []).slice().sort((a,b) => analysis.selected_banks.indexOf(a.bank_id)-analysis.selected_banks.indexOf(b.bank_id) || String(a.category).localeCompare(String(b.category),"zh-CN"));
    const root = $("#publicProfileHeatmap"); if (!rows.length || !analysis.models.length) { root.innerHTML = '<div class="chart-empty">至少需要两个模型的共同方向性画像</div>'; return; }
    const models = analysis.models, left=245, top=112, cellW=112, cellH=27, width=left+models.length*cellW+28, height=top+rows.length*cellH+28;
    const cells = rows.map((row, rowIndex) => { const lookup = new Map((row.model_values || []).map((item)=>[item.model,item.mean_p])); return models.map((model,colIndex)=>{ const value=lookup.get(model), style=heatStyle(value), x=left+colIndex*cellW, y=top+rowIndex*cellH; return `<rect x="${x}" y="${y}" width="${cellW-3}" height="${cellH-3}" rx="4" fill="${style.fill}" fill-opacity="${style.opacity}"/><text x="${x+(cellW-3)/2}" y="${y+17}" text-anchor="middle" fill="${style.text}" font-size="9">${value===null||value===undefined?"—":signedOrDash(value,2)}</text>`; }).join("") }).join("");
    root.innerHTML = `<svg viewBox="0 0 ${width} ${height}" width="100%" style="min-width:${Math.max(820,width)}px" role="img" aria-label="模型与三级分类平均P热图">${models.map((model,index)=>`<text transform="translate(${left+index*cellW+14},${top-12}) rotate(-38)" fill="#536071" font-size="9">${esc(model)}</text>`).join("")}${rows.map((row,index)=>`<rect x="12" y="${top+index*cellH+7}" width="5" height="10" rx="2" fill="${analysis.bank_meta[row.bank_id]?.color || "#64748b"}"/><text x="${left-12}" y="${top+index*cellH+17}" text-anchor="end" fill="#526071" font-size="9">${esc(`${row.bank} · ${row.category}`.slice(0,28))}</text>`).join("")}${cells}<text x="${left}" y="${height-5}" fill="#7c8797" font-size="8">蓝：负P · 浅色：接近0 · 橙：正P；空白表示不可计算</text></svg>`;
  }
  function renderDivergenceReport() {
    const rows = (state.analysis.category_divergence || []).slice(0,12), root = $("#divergenceChart");
    if (!rows.length) { root.innerHTML = '<div class="chart-empty">暂无跨模型共同维度</div>'; $("#divergenceTable").innerHTML='<tr><td colspan="8">暂无数据</td></tr>'; return; }
    const width=760,left=245,right=60,rowH=34,height=rows.length*rowH+48,scaleW=width-left-right,toX=(value)=>left+clamp((Number(value)+1)/2,0,1)*scaleW;
    root.innerHTML = `<svg viewBox="0 0 ${width} ${height}" width="100%" style="min-width:680px" role="img" aria-label="跨模型分歧维度"><line x1="${toX(0)}" x2="${toX(0)}" y1="12" y2="${height-25}" stroke="#aab2bf"/>${rows.map((row,index)=>{const y=24+index*rowH,a=toX(row.minimum_p),b=toX(row.maximum_p),color=state.analysis.bank_meta[row.bank_id]?.color||"#4c73be";return `<text x="${left-12}" y="${y+3}" text-anchor="end" font-size="9">${esc(`${row.bank} · ${row.category}`.slice(0,27))}</text><line x1="${a}" x2="${b}" y1="${y}" y2="${y}" stroke="${color}" stroke-width="5" stroke-linecap="round" opacity=".65"/><circle cx="${a}" cy="${y}" r="5" fill="#fff" stroke="${color}" stroke-width="2"/><circle cx="${b}" cy="${y}" r="5" fill="${color}"/><text x="${Math.min(width-4,b+10)}" y="${y+3}" font-size="8">Δ ${Number(row.range).toFixed(2)}</text>`}).join("")}<text x="${left}" y="${height-6}" font-size="8">−1</text><text x="${toX(0)}" y="${height-6}" text-anchor="middle" font-size="8">0</text><text x="${left+scaleW}" y="${height-6}" text-anchor="end" font-size="8">+1</text></svg>`;
    $("#divergenceTable").innerHTML = (state.analysis.category_divergence || []).slice(0,24).map((row)=>`<tr><td>${esc(row.bank)}</td><th scope="row">${esc(row.category)}</th><td>${row.models}</td><td>${signedOrDash(row.mean_p)}</td><td>${numberOrDash(row.sd)}</td><td><b>${numberOrDash(row.range)}</b></td><td>${esc(row.minimum_model)}<small>${signedOrDash(row.minimum_p)}</small></td><td>${esc(row.maximum_model)}<small>${signedOrDash(row.maximum_p)}</small></td></tr>`).join("");
  }
  function renderPublicSimilarity() {
    const analysis=state.analysis, models=analysis.models||[], rows=analysis.model_similarity||[], root=$("#publicSimilarityHeatmap");
    if (models.length<2 || !rows.length) { root.innerHTML='<div class="chart-empty">至少需要两个模型的共同画像</div>'; $("#similarityTable").innerHTML='<tr><td colspan="5">暂无数据</td></tr>'; return; }
    const lookup=new Map(rows.map((row)=>[`${row.model_a}::${row.model_b}`,row])),cell=72,left=162,top=112,width=left+models.length*cell+20,height=top+models.length*cell+25;
    root.innerHTML=`<svg viewBox="0 0 ${width} ${height}" width="100%" style="min-width:${Math.max(650,width)}px" role="img" aria-label="模型画像Pearson相关矩阵">${models.map((model,index)=>`<text transform="translate(${left+index*cell+12},${top-10}) rotate(-40)" font-size="9">${esc(model)}</text><text x="${left-10}" y="${top+index*cell+42}" text-anchor="end" font-size="9">${esc(model)}</text>`).join("")}${models.map((a,rowIndex)=>models.map((b,colIndex)=>{const row=lookup.get(`${a}::${b}`)||{},value=row.pearson_r,style=heatStyle(value,"r"),x=left+colIndex*cell,y=top+rowIndex*cell;return `<rect x="${x}" y="${y}" width="${cell-4}" height="${cell-4}" rx="7" fill="${style.fill}" fill-opacity="${style.opacity}"/><text x="${x+(cell-4)/2}" y="${y+31}" text-anchor="middle" fill="${style.text}" font-size="11" font-weight="700">${numberOrDash(value,2)}</text><text x="${x+(cell-4)/2}" y="${y+47}" text-anchor="middle" fill="${style.text}" font-size="7">n=${row.shared_categories||0}</text>`}).join("")).join("")}</svg>`;
    const order=new Map(models.map((model,index)=>[model,index]));
    const pairs=rows.filter((row)=>order.get(row.model_a)<order.get(row.model_b)).sort((a,b)=>(b.pearson_r??-Infinity)-(a.pearson_r??-Infinity));
    $("#similarityTable").innerHTML=pairs.map((row)=>`<tr><th scope="row">${esc(row.model_a)}</th><td>${esc(row.model_b)}</td><td>${row.shared_categories}</td><td><b>${numberOrDash(row.pearson_r)}</b></td><td>${numberOrDash(row.mean_absolute_difference)}</td></tr>`).join("")||'<tr><td colspan="5">暂无可计算模型对</td></tr>';
  }
  function renderDomainChart(model) {
    const rows = state.analysis.domains.filter((row) => row.model === model).sort((a,b) => a.category.localeCompare(b.category,"zh-CN") || a.domain.localeCompare(b.domain,"zh-CN")).slice(0, 18);
    const root = $("#domainChart"); if (!rows.length) { root.innerHTML = '<div class="chart-empty">当前题库没有可显示的情境画像</div>'; return; }
    const width = 900, left = 240, right = 70, rowH = 31, height = rows.length * rowH + 50, scaleW = width - left - right;
    const ticks = [0,25,50,75,100];
    root.innerHTML = `<svg viewBox="0 0 ${width} ${height}" width="100%" style="min-width:700px" role="img" aria-label="不同情境的偏好位置"><g>${ticks.map((tick) => `<line x1="${left + tick/100*scaleW}" x2="${left + tick/100*scaleW}" y1="20" y2="${height-25}" stroke="${tick===50?'#9da9a5':'#e5e7e3'}" stroke-width="${tick===50?1.4:1}"/><text x="${left + tick/100*scaleW}" y="${height-6}" text-anchor="middle" fill="#89938f" font-size="9">${tick}</text>`).join("")}${rows.map((row,index) => { const y = 30 + index*rowH, value = clamp(row.score_0_100,0,100), color = state.analysis.bank_meta[row.bank_id]?.color || "#26746a"; return `<text x="${left-12}" y="${y+4}" text-anchor="end" fill="#48534f" font-size="9">${esc((row.category || row.category_id).slice(0,15))} · ${esc(row.domain.slice(0,13))}</text><line x1="${left+50/100*scaleW}" x2="${left+value/100*scaleW}" y1="${y}" y2="${y}" stroke="${color}" stroke-width="4" stroke-linecap="round" opacity=".55"/><circle cx="${left+value/100*scaleW}" cy="${y}" r="5" fill="${color}"/><text x="${left+value/100*scaleW + (value>88?-10:10)}" y="${y+3}" text-anchor="${value>88?'end':'start'}" fill="#48534f" font-size="8">${value.toFixed(1)}</text>`; }).join("")}</g></svg>`;
  }
  function renderContextEffects(model) {
    const rows = (state.analysis.context_effects || []).filter((row)=>row.model===model).slice(0,10);
    $("#contextEffectsTable").innerHTML = rows.map((row)=>`<tr><th scope="row"><b>${esc(row.category)}</b><small>${esc(row.bank)}</small></th><td>${row.domains}</td><td><b>${numberOrDash(row.range,2)}</b></td><td><small>${esc(row.minimum_domain)} ${signedOrDash(row.minimum_p,2)}</small><span class="range-arrow">→</span><small>${esc(row.maximum_domain)} ${signedOrDash(row.maximum_p,2)}</small></td></tr>`).join("") || '<tr><td colspan="4">至少需要同一维度中的两个有效Domain</td></tr>';
  }
  function renderStability(model) {
    const rows = state.analysis.profiles.filter((row) => row.model === model && row.top_consistency !== null && row.top_consistency !== undefined);
    const banks = state.analysis.selected_banks.map((bankId) => { const subset = rows.filter((row) => row.bank_id === bankId); const avg = subset.length ? subset.reduce((sum,row) => sum + Number(row.top_consistency || 0),0)/subset.length : 0; return {bankId, avg, n:subset.length}; }).filter((row) => row.n);
    $("#stabilityGrid").innerHTML = banks.length ? banks.map((row) => { const meta = state.analysis.bank_meta[row.bankId]; const value = Math.round(row.avg*100); return `<article class="stability-card"><h3>${esc(meta.label)}</h3><div class="stability-ring" style="--pct:${value}" data-value="${value}%"></div><p>${value >= 80 ? "多次调用的首选较一致" : value >= 60 ? "存在一定重复波动" : "重复波动较明显，谨慎解读"}</p></article>`; }).join("") : '<div class="empty-inline">至少需要有效的重复调用才能观察稳定性。</div>';
  }
  function renderStabilityDetails(model) {
    const rows=(state.analysis.stability_details||[]).filter((row)=>row.model===model);
    $("#stabilityDetailTable").innerHTML=rows.map((row)=>`<tr><th scope="row">${esc(row.bank)}</th><td>${nf.format(row.items)}</td><td>${rateOrDash(row.mean_top_consistency)}</td><td>${rateOrDash(row.mean_full_consistency)}</td><td>${numberOrDash(row.mean_repeat_p_sd,3)}</td><td>${rateOrDash(row.stable_item_rate)}</td></tr>`).join("")||'<tr><td colspan="6">暂无重复稳定性数据</td></tr>';
  }
  function renderOptionDistribution(model) {
    const rows=(state.analysis.option_distributions||[]).filter((row)=>row.model===model),root=$("#optionDistributionChart");
    if(!rows.length){root.innerHTML='<div class="chart-empty">暂无有效完整排序</div>';return;}
    root.innerHTML=`<div class="stacked-legend"><span><i class="l1"></i>L1</span><span><i class="l2"></i>L2</span><span><i class="l3"></i>L3</span></div>${rows.map((row)=>{const l1=Number(row.l1_top_rate||0)*100,l2=Number(row.l2_top_rate||0)*100,l3=Number(row.l3_top_rate||0)*100;return `<div class="stacked-row"><div><b>${esc(row.bank)}</b><small>n = ${nf.format(row.valid_records)}</small></div><div class="stacked-track" role="img" aria-label="${esc(row.bank)}：L1 ${l1.toFixed(1)}%，L2 ${l2.toFixed(1)}%，L3 ${l3.toFixed(1)}%"><i class="l1" style="width:${l1}%"><span>${l1>=12?l1.toFixed(0)+"%":""}</span></i><i class="l2" style="width:${l2}%"><span>${l2>=12?l2.toFixed(0)+"%":""}</span></i><i class="l3" style="width:${l3}%"><span>${l3>=12?l3.toFixed(0)+"%":""}</span></i></div></div>`}).join("")}`;
  }
  function renderHumanChart(model) {
    const summary = (state.analysis.human_gap_summary || []).find((row) => row.model === model);
    const rows = state.analysis.human_comparisons.filter((row) => row.model === model && (!summary || row.metric === summary.metric)).slice(0, 16); const root = $("#humanChart");
    if (!rows.length) { root.innerHTML = '<div class="chart-empty">没有通过严格题目版本匹配的人类参照</div>'; renderHumanStatus(); return; }
    const width=900,left=250,right=70,rowH=33,height=rows.length*rowH+55,scaleW=width-left-right;
    const toX = (value) => left + clamp((Number(value)+1)/2*100,0,100)/100*scaleW;
    root.innerHTML = `<svg viewBox="0 0 ${width} ${height}" width="100%" style="min-width:700px" role="img" aria-label="AI与人类样本对比"><line x1="${left+scaleW/2}" x2="${left+scaleW/2}" y1="15" y2="${height-30}" stroke="#a6afac"/><text x="${left}" y="${height-8}" fill="#89938f" font-size="9">−1</text><text x="${left+scaleW/2}" y="${height-8}" text-anchor="middle" fill="#89938f" font-size="9">0</text><text x="${left+scaleW}" y="${height-8}" text-anchor="end" fill="#89938f" font-size="9">+1</text>${rows.map((row,i)=>{const y=26+i*rowH,a=toX(row.ai),h=toX(row.human);return `<text x="${left-12}" y="${y+3}" text-anchor="end" fill="#48534f" font-size="9">${esc((row.category||row.category_id).slice(0,18))}</text><line x1="${a}" x2="${h}" y1="${y}" y2="${y}" stroke="#c8cfcc" stroke-width="3"/><circle cx="${h}" cy="${y}" r="5" fill="#fff" stroke="#8c9692" stroke-width="2"/><circle cx="${a}" cy="${y}" r="5" fill="#26746a"/><text x="${Math.max(a,h)+10}" y="${y+3}" fill="#89938f" font-size="8">差 ${row.gap>=0?'+':''}${Number(row.gap).toFixed(2)}</text>`}).join("")}<g transform="translate(${left},8)"><circle cx="0" cy="0" r="4" fill="#26746a"/><text x="9" y="3" font-size="8" fill="#68736f">AI</text><circle cx="42" cy="0" r="4" fill="#fff" stroke="#8c9692"/><text x="51" y="3" font-size="8" fill="#68736f">同题人类样本</text></g></svg>`; renderHumanStatus();
  }
  function renderHumanStatus() {
    const status = state.analysis.human_status || {}; const notes = [];
    Object.entries(status).forEach(([bank,value]) => { if (value?.blocked) notes.push(`${bankMeta(bank).label}有 ${value.blocked} 条参照因未运行或题目版本不一致而未显示`); });
    $("#humanStatus").textContent = notes.length ? notes.join("；") + "。" : "仅显示同题、同版本的人类样本描述均值；不进行正确性判断。";
  }
  function renderHumanGapSummary(model) {
    const row=(state.analysis.human_gap_summary||[]).find((item)=>item.model===model),root=$("#humanGapSummary");
    if(!row){root.innerHTML='<div class="chart-empty">没有通过严格题目版本匹配的人类参照</div>';return;}
    root.innerHTML=[
      ["主要可比指标",row.metric||"—","不同量尺分别汇总，不跨量尺平均"],
      ["匹配画像坐标",nf.format(row.comparisons),"仅统计严格同题同版本"],
      ["平均Gap",signedOrDash(row.mean_gap),"正值表示AI平均位置更偏正P端"],
      ["平均绝对Gap",numberOrDash(row.mean_absolute_gap),"不让正负差异相互抵消"],
      ["|Gap| ≤ 0.10",rateOrDash(row.within_0_10_rate),"描述接近比例，不表示等效"],
      ["AI—Human画像相关",numberOrDash(row.profile_correlation),"比较共同坐标的变化模式"],
      ["最大差异维度",row.largest_gap_category||"—",`Gap ${signedOrDash(row.largest_gap)}`],
    ].map(([label,value,note])=>`<div><span>${esc(label)}</span><strong>${esc(value)}</strong><small>${esc(note)}</small></div>`).join("");
  }

  async function exportReportHtml() {
    if (!state.analysis) return;
    try {
      const css = await (await fetch("/styles.css")).text(); const report = $("#reportContent").cloneNode(true);
      $$(".report-tools,.model-filter", report).forEach((el) => el.remove());
      const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${esc(state.analysis.project_name)} · 测评报告</title><style>${css}body{padding:32px;background:#f3f1eb}.report{max-width:1200px;margin:auto}</style></head><body><main class="report">${report.innerHTML}</main></body></html>`;
      downloadBlob(`${safeFilename(state.analysis.project_name)}_通俗报告.html`, new Blob([html], {type:"text/html;charset=utf-8"}));
    } catch (error) { toast(`导出失败：${error.message}`, true); }
  }
  function safeFilename(value) { return String(value || "测评项目").replace(/[\\/:*?"<>|]+/g,"_").slice(0,60); }
  function downloadBlob(filename, blob) { const url=URL.createObjectURL(blob),a=document.createElement("a");a.href=url;a.download=filename;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000); }

  async function importFolder(files) {
    const groups = new Map();
    for (const file of files) {
      if (!["排序结果.csv","完整运行记录.csv"].includes(file.name)) continue;
      const path = file.webkitRelativePath || file.name; const folder = path.slice(0, -(file.name.length + (path.includes("/") ? 1 : 0)));
      if (!groups.has(folder)) groups.set(folder, {}); groups.get(folder)[file.name] = file;
    }
    const completeGroups = Array.from(groups.entries()).filter(([,group]) => group["排序结果.csv"] && group["完整运行记录.csv"]);
    if (!completeGroups.length) return toast("没有找到同时包含两个必需 CSV 的结果文件夹", true);
    if (completeGroups.length > 12) return toast("一次最多导入 12 个结果批次", true);
    $("#importNote").textContent = `正在读取 ${completeGroups.length} 个结果批次…`;
    try {
      const batches = await Promise.all(completeGroups.map(async ([folder,group], index) => ({label: folder.split("/").pop() || `历史模型${index + 1}`, ranking:await group["排序结果.csv"].text(), complete:await group["完整运行记录.csv"].text()})));
      const rootName = (files[0]?.webkitRelativePath || "历史结果").split("/")[0];
      const result = await api("/api/import", {method:"POST", body:JSON.stringify({name:`${rootName}（导入）`, batches})});
      selectProject(result.project.project_id); await refreshProjects(); toast(`已导入 ${batches.length} 个结果批次`); navigate("report");
    } catch (error) { toast(error.message, true); }
    finally { $("#importNote").innerHTML = '<b>可直接接入原分析平台：</b>选择包含“排序结果.csv”和“完整运行记录.csv”的文件夹；可同时识别多个模型批次。'; $("#folderInput").value = ""; }
  }

  function openResumeDialog() {
    const project = state.currentProject; if (!project) return;
    const unfinished = project.models.filter((model) => model.status !== "completed");
    $("#resumeModels").innerHTML = unfinished.map((model) => `<div class="resume-row" data-model-id="${esc(model.model_id)}"><b>${esc(model.label)} · ${esc(model.model)}</b><div class="form-row"><label class="field grow"><span>API Key</span><input class="resume-key" type="password" autocomplete="off" ${model.provider === "demo" ? "disabled placeholder=本地演示无需密钥" : "required"}></label></div></div>`).join("");
    $("#resumeDialog").showModal();
  }
  async function confirmResume(event) {
    event.preventDefault(); const project = state.currentProject;
    const models = $$(".resume-row").map((row) => { const target=project.models.find((m)=>m.model_id===row.dataset.modelId); const config={...target.config, model_id:target.model_id, label:target.label, provider:target.provider, model:target.model, api_key:$(".resume-key",row).value}; return config; });
    if (models.some((model)=>model.provider!=="demo"&&!model.api_key)) return toast("请为所有未完成模型填写 API Key", true);
    $("#resumeDialog").close(); await projectAction("resume", {models});
  }

  function bindEvents() {
    $$('[data-route]').forEach((el) => el.addEventListener("click", (event) => { event.preventDefault(); navigate(el.dataset.route); }));
    $("#mobileMenu").addEventListener("click", () => $("#sidebar").classList.toggle("is-open"));
    $("#sidebarScrim").addEventListener("click", () => $("#sidebar").classList.remove("is-open"));
    $("#tourReplayButton").addEventListener("click", startTour);
    $("#tourReplayButtonHelp").addEventListener("click", startTour);
    $("#tourSkip").addEventListener("click", () => closeTour(true));
    $("#tourNext").addEventListener("click", nextTourStep);
    $("#tourBack").addEventListener("click", previousTourStep);
    document.addEventListener("keydown", handleTourKeydown);
    window.addEventListener("resize", () => { if (tourActive) positionTour(TOUR_STEPS[tourIndex]); });
    $$("[data-next]").forEach((el) => el.addEventListener("click", () => showStep(Number(el.dataset.next))));
    $$("[data-back]").forEach((el) => el.addEventListener("click", () => showStep(Number(el.dataset.back))));
    $$(".step").forEach((el) => el.addEventListener("click", () => { if (Number(el.dataset.step) <= state.currentStep) showStep(Number(el.dataset.step)); }));
    $$('[name="mode"]').forEach((el) => el.addEventListener("change", () => setMode(el.value)));
    $("#repetitions").addEventListener("change", updateEstimate); $("#balanced6").addEventListener("change", updateEstimate);
    $("#selectAllBanks").addEventListener("click", () => { const all = $$('[name="bank"]').every((el)=>el.checked); $$('[name="bank"]').forEach((el)=>el.checked=!all); $("#selectAllBanks").textContent=all?"全选":"取消全选"; updateEstimate(); });
    $("#addModel").addEventListener("click", () => addModel()); $("#projectForm").addEventListener("submit", startProject);
    $("#quickDemo").addEventListener("click", () => { navigate("new"); $('[name="mode"][value="demo"]').checked=true; setMode("demo"); showStep(1); });
    $("#pauseProject").addEventListener("click", () => projectAction("pause")); $("#continueProject").addEventListener("click", () => projectAction("continue"));
    $("#cancelProject").addEventListener("click", () => { if (confirm("确定安全停止？已完成结果会保留，稍后可重新填写密钥继续。")) projectAction("cancel"); });
    $("#viewReport").addEventListener("click", () => navigate("report")); $("#resumeProject").addEventListener("click", openResumeDialog);
    $("#printReport").addEventListener("click", () => window.print()); $("#exportHtml").addEventListener("click", exportReportHtml);
    $("#importButton").addEventListener("click", () => $("#folderInput").click()); $("#folderInput").addEventListener("change", (event) => importFolder(Array.from(event.target.files || [])));
    $("#confirmResume").addEventListener("click", confirmResume);
  }

  async function bootstrapWorkspace() {
    if (!state.appBound) { bindEvents(); state.appBound = true; }
    const today = new Date(); $("#projectName").value = `AI模型决策偏好测评 ${today.getFullYear()}-${String(today.getMonth()+1).padStart(2,"0")}-${String(today.getDate()).padStart(2,"0")}`;
    try {
      const [presets, banks, projects] = await Promise.all([api("/api/presets"), api("/api/banks"), api("/api/projects")]);
      state.presets = presets.presets || {}; state.banks = banks.banks || []; state.projects = projects.projects || [];
      renderBanks(); resetModels({provider:"openai"}); renderRecent(); renderProjectTable(); updateEstimate();
      const queryProject = new URLSearchParams(location.search).get("project_id");
      if (queryProject) selectProject(queryProject);
      const route = location.hash.slice(1) || "home"; navigate(route);
      if (state.currentProjectId) { await refreshCurrentProject(); if (state.currentProject && ["queued","running","paused"].includes(state.currentProject.status)) startPolling(); }
      if (route === "home" && !hasSeenTour()) setTimeout(startTour, 650);
    } catch (error) {
      toast(`平台初始化失败：${error.message}`, true);
      $("#recentProjects").innerHTML = `<div class="empty-inline">暂时无法连接平台服务：${esc(error.message)}。请稍后刷新；若持续出现，请联系站点管理员。</div>`;
    }
  }
  async function init() {
    bindAuthEvents();
    try {
      const auth = await api("/api/auth/me");
      if (!auth.authenticated) {
        if (!auth.registration_enabled) {
          $('[data-auth-tab="register"]').classList.add("is-hidden");
          showAuthTab("login");
        }
        showAuth(); return;
      }
      showApp(auth);
      await bootstrapWorkspace();
    } catch (error) {
      showAuth();
      toast(`平台暂时不可用：${error.message}`, true);
    }
  }
  init();
})();
