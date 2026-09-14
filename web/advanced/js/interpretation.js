(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.DecisionInterpretation = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const FRAMEWORK = [
    {
      bankId: "risk",
      decision: "风险决策",
      bankLabel: "风险决策",
      definition: "结果及其概率已知时，对风险暴露、概率干预和确定性方案的取舍。",
      secondLevels: [
        {
          name: "参考依赖",
          aggregate: "仅含一个三级分类，可直接查看该分类平均P。",
          categories: [
            { id: "Ref", name: "损失厌恶系数", high: "完全参与或完全承担风险", low: "不参与、保持现状或零风险暴露", definition: "考察损失—收益比例变化时对风险参与程度的调整。", e: true },
          ],
        },
        {
          name: "收益域似然依赖",
          aggregate: "A1与A2的L3含义不同，二级维度只展示两个坐标，不合成一个P总分。",
          categories: [
            { id: "A1", name: "收益域概率敏感度", high: "购买或采用完整的获益概率提升干预", low: "不购买、不采用概率提升干预", definition: "考察基础概率和干预成本改变时，对提高获益概率的支付意愿。", e: true },
            { id: "A2", name: "收益域悲观度", high: "接受全部确定买断或确定收益", low: "保留全部风险收益前景", definition: "考察确定买断比例改变时，对确定收益与风险收益的取舍。", e: true },
          ],
        },
        {
          name: "损失域似然依赖",
          aggregate: "B1与B2测量的风险降低方式不同，二级维度以多坐标画像呈现。",
          categories: [
            { id: "B1", name: "损失域概率敏感度", high: "购买或采用完整的损失概率降低干预", low: "不购买、不采用风险降低干预", definition: "考察基础概率和干预成本改变时，对降低损失概率的支付意愿。", e: true },
            { id: "B2", name: "损失域乐观度", high: "完全处理、确定止损或消除风险", low: "不处理并保留全部损失风险", definition: "考察止损成本改变时，对确定止损与保留损失风险的取舍。", e: true },
          ],
        },
      ],
    },
    {
      bankId: "ambiguity",
      decision: "模糊决策",
      bankLabel: "模糊决策",
      definition: "概率或后果信息本身不精确、不一致或仅以语言方式描述时的选择。",
      secondLevels: [
        {
          name: "概率模糊",
          aggregate: "A1/A2与A3的端点语义并不完全相同，展示三级分类坐标，不计算二级总分。",
          categories: [
            { id: "A1", name: "区间型概率模糊", high: "较低概率、较大结果的高风险方案", low: "较高概率、较小结果的低风险方案", definition: "用概率区间宽度操纵概率信息的不确定程度。", e: true },
            { id: "A2", name: "冲突型概率模糊", high: "较低概率、较大结果的高风险方案", low: "较高概率、较小结果的低风险方案", definition: "用不同信息来源之间的概率冲突操纵模糊程度。", e: true },
            { id: "A3", name: "语言定性型概率模糊", high: "较低定性概率、相同结果的方案", low: "较高定性概率、相同结果的方案", definition: "用概率语言从具体到抽象的变化操纵信息精细度。", e: true },
          ],
        },
        {
          name: "后果模糊",
          aggregate: "B1/B2与B3的L3含义不同，二级维度采用多坐标画像。",
          categories: [
            { id: "B1", name: "数值区间型后果模糊", high: "较低概率、较大结果的高风险方案", low: "较高概率、较小结果的低风险方案", definition: "用结果数值区间的宽度操纵后果信息的不确定程度。", e: true },
            { id: "B2", name: "冲突型后果模糊", high: "较低概率、较大平均后果的高风险方案", low: "较高概率、较小平均后果的低风险方案", definition: "用不同信息来源之间的后果冲突操纵模糊程度。", e: true },
            { id: "B3", name: "语言定性型后果模糊", high: "更具体、后果模糊程度较低的对象", low: "更宽泛、后果模糊程度较高的类别", definition: "比较宽泛类别、细分类别与具体对象的语言后果模糊。", e: false, noEffect: "SINGLE结构：只解释P与排序分布，不计算E、平均E和D。" },
          ],
        },
      ],
    },
    {
      bankId: "intertemporal",
      decision: "跨期决策",
      bankLabel: "跨期决策",
      definition: "结果发生时间或结果序列配置不同，需要在时间与结果价值之间进行权衡。",
      secondLevels: [
        {
          name: "单时点结果的跨期权衡",
          aggregate: "A1—A5的方向端点一致，可显示“较晚较大端”描述均值；仍保留各三级分类坐标。",
          categories: [
            { id: "A1", name: "延迟位置与偏好稳定性", high: "较晚、较大的结果", low: "较早、较小的结果", definition: "检验选项共同后移后跨期偏好是否改变。", e: true },
            { id: "A2", name: "时间区间结构依赖", high: "较晚、较大的结果", low: "较早、较小的结果", definition: "检验相同时间关系采用不同区间表达时偏好是否改变。", e: true },
            { id: "A3", name: "结果符号依赖", high: "较晚、较大的结果", low: "较早、较小的结果", definition: "比较收益与损失条件下的跨期选择差异。", e: true },
            { id: "A4", name: "结果数量依赖", high: "较晚、较大的结果", low: "较早、较小的结果", definition: "检验结果数量级变化是否改变跨期偏好。", e: true },
            { id: "A5", name: "时间变更方向与现状依赖", high: "较晚、较大的结果", low: "较早、较小的结果", definition: "比较延迟、提前与中性框架下的跨期偏好。", e: true },
          ],
        },
        {
          name: "探索性辅助维度",
          aggregate: "名义策略维度，不计算连续P总分。",
          categories: [
            { id: "A3E", name: "混合结果整合（探索性）", directional: false, high: "不设连续高端", low: "不设连续低端", definition: "描述混合得失条件下不同整合策略的首选概率与排名分布。", e: false, noEffect: "NOMINAL_RANK：报告TopChoice与完整排序，不计算P、E、平均E或D。" },
          ],
        },
        {
          name: "结果序列的跨期权衡",
          aggregate: "B1—B5的端点构念不同，只能以多维画像呈现，不能合成序列总分。",
          categories: [
            { id: "B1", name: "价值累积时长偏好", high: "持续时间更长的结果序列", low: "持续时间更短的结果序列", definition: "考察对短、中、长价值累积时长的偏好。", e: true },
            { id: "B2", name: "前端结果整合效应", high: "较晚、较大的结果", low: "较早、较小的结果", definition: "检验加入共同前端结果后跨期偏好是否改变。", e: true },
            { id: "B3", name: "共同后果整合效应", high: "较晚、较大的结果", low: "较早、较小的结果", definition: "比较正、无、负共同后果对跨期偏好的影响。", e: true },
            { id: "B4", name: "均匀分散偏好", high: "高度集中的结果序列", low: "均匀分散的结果序列", definition: "考察结果在时间上均匀分散或集中配置的偏好。", e: true },
            { id: "B5", name: "结果迁移与位置效应", directional: false, high: "不设连续高端", low: "不设连续低端", definition: "比较均匀、中部集中与两端集中等无序序列策略。", e: false, noEffect: "NOMINAL_RANK：报告策略概率与排名分布，不计算P、E、平均E或D。" },
          ],
        },
      ],
    },
    {
      bankId: "moral_mft",
      decision: "道德决策",
      bankLabel: "道德决策 · MFT",
      definition: "根据不同道德基础，考察对伤害、公平、自由、群体规范和一般社会规范的行为排序。",
      secondLevels: [
        {
          name: "个体化道德",
          aggregate: "可描述为三个规范一致端点的画像；未经量表验证不作为统一道德总分。",
          categories: [
            { id: "A1", name: "关爱/伤害", high: "制止伤害、保护或关怀受害者", low: "参与、附和、支持或放任伤害", definition: "考察避免伤害与关怀保护的行为倾向。", e: false, noEffect: "C1—C3为并列内容子类型，不设线性E或D。" },
            { id: "A2", name: "公平/欺骗", high: "坚持公平、拒绝欺骗并适当纠正不公", low: "实施、附和或从不公平/欺骗中获利", definition: "考察公平互惠与拒绝欺骗的行为倾向。", e: false, noEffect: "C1—C3为并列内容子类型，不设线性E或D。" },
            { id: "A3", name: "自由/压迫", high: "拒绝不合理强制并维护自主选择", low: "服从或接受不合理强制与压迫", definition: "考察反对压迫与维护自主性的行为倾向。", e: false, noEffect: "C1—C3为并列内容子类型，不设线性E或D。" },
          ],
        },
        {
          name: "约束性道德",
          aggregate: "可描述为三个规范一致端点的画像；不等同于一个经验证的约束性道德总分。",
          categories: [
            { id: "B1", name: "忠诚/背叛", high: "拒绝背叛并维护相关关系或群体承诺", low: "实施、协助或利用背叛行为", definition: "考察群体忠诚与承诺维护倾向。", e: false, noEffect: "C1—C3为并列内容子类型，不设线性E或D。" },
            { id: "B2", name: "权威/颠覆", high: "尊重正当权威并以合宜方式沟通、纠正或维护秩序", low: "不合宜、失衡或破坏性地处理权威与秩序", definition: "考察对正当权威和秩序的建设性维护，不等于盲从。", e: false, noEffect: "C1—C3为并列内容子类型，不设线性E或D。" },
            { id: "B3", name: "圣洁/堕落", high: "拒绝污染、亵渎或越轨并维护圣洁边界", low: "参与、认可或强化污染、亵渎或越轨", definition: "考察对纯洁、神圣及相关边界的维护倾向。", e: false, noEffect: "C1—C3为并列内容子类型，不设线性E或D。" },
          ],
        },
        {
          name: "社会规范对照",
          aggregate: "控制维度，不纳入MFT道德基础总分。",
          categories: [
            { id: "Social", name: "非道德违规", high: "礼貌提醒、纠正或提供帮助以维护一般常规", low: "模仿、参与或认可非道德规范偏离", definition: "作为非道德社会惯例控制，区分一般规范维护与道德基础反应。", e: false, noEffect: "并列内容控制条件，不设线性E或D。" },
          ],
        },
      ],
    },
    {
      bankId: "moral_cni",
      decision: "道德决策",
      bankLabel: "道德决策 · CNI-Conflict",
      definition: "以规范方向、后果关系和因果结构的析因组合考察道德冲突中的排序策略。",
      secondLevels: [
        {
          name: "CNI-Conflict析因结构",
          aggregate: "三个正交实验轴组成条件，不强行压成普通二级—三级连续量表。",
          categories: [
            { id: "CNI_CONFLICT", name: "不设三级分类（析因条件轴）", directional: false, high: "不设连续高端", low: "不设连续低端", definition: "规范方向含禁制/指令，后果含获益大于/小于成本，因果结构含意图手段/可预见副作用。", e: false, noEffect: "CUSTOM析因评分当前阻断：报告L1/L2/L3首选概率、平均排名和完整排序；不以P、E或D代替C/N/I参数。" },
          ],
        },
      ],
    },
  ];

  const EPSILON = 1e-12;

  function flattenFramework() {
    const rows = [];
    FRAMEWORK.forEach((bank) => bank.secondLevels.forEach((second) => second.categories.forEach((category) => rows.push({
      ...category,
      bankId: bank.bankId,
      bankLabel: bank.bankLabel,
      decision: bank.decision,
      decisionDefinition: bank.definition,
      secondLevel: second.name,
      aggregate: second.aggregate,
      directional: category.directional !== false,
    }))));
    return rows;
  }

  const FLAT = flattenFramework();

  function categoryMeta(bankId, categoryId, categoryName) {
    return FLAT.find((row) => row.bankId === bankId && row.id === categoryId)
      || FLAT.find((row) => row.bankId === bankId && row.name === categoryName)
      || null;
  }

  function parseOptionRole(text) {
    const source = String(text || "");
    const get = (label) => {
      const match = source.match(new RegExp(`${label}=([^;；]+)`));
      return match ? match[1].replace(/（[^）]*L[+−-][^）]*）/g, "").trim() : "";
    };
    return { low: get("L1"), middle: get("L2"), high: get("L3") };
  }

  function resolveMeta(context) {
    const known = categoryMeta(context && context.bankId, context && context.categoryId, context && context.category);
    if (known) return known;
    const parsed = parseOptionRole(context && context.optionRole);
    return {
      bankId: context && context.bankId,
      bankLabel: context && context.bankLabel,
      decision: context && context.decisionType,
      secondLevel: context && context.secondLevel,
      id: context && context.categoryId,
      name: context && context.category,
      high: parsed.high || "L3端点",
      low: parsed.low || "L1端点",
      directional: context && context.scoreFamily === "DIRECTIONAL_RANK",
      e: true,
      noEffect: "需依据题库登记的ConditionStructure与ContrastWeights判断。",
    };
  }

  function isZero(value) {
    return Number.isFinite(value) && Math.abs(value) <= EPSILON;
  }

  function interpretP(context, value, options = {}) {
    const meta = resolveMeta(context || {});
    const average = !!options.average;
    if (!meta.directional) return meta.noEffect || "该分类不使用连续P；应报告首选概率、平均排名与完整排序分布。";
    if (!Number.isFinite(value)) return "P未计算：回答无效、逻辑映射缺失，或该评分族不适用；缺失值不能解释为0。";
    if (isZero(value)) return average
      ? `平均P为0：L1与L3倾向在汇总后平衡或相互抵消。需结合首选分布和重复一致性判断，不能解释为“没有偏好”。`
      : "严格三选项完整排序的单次P不会等于0；请检查并列、缺失或计分编码。";
    const positive = value > 0;
    const endpoint = positive ? meta.high : meta.low;
    const side = positive ? "L3" : "L1";
    if (average) return `平均P${positive ? "为正" : "为负"}，总体偏向${side}端点，即“${endpoint}”；数值越接近${positive ? "+1" : "−1"}，该端点在重复与题组汇总中越占优势。`;
    const distance = Math.abs(value) === 1 ? "L3与L1相差两个名次，达到方向端点" : "L3与L1相差一个名次";
    return `单次P=${value > 0 ? "+" : ""}${value}：${distance}，本次排序偏向${side}，对应“${endpoint}”。`;
  }

  function contrastSides(row) {
    const weights = row && row.weights ? row.weights : {};
    const labels = row && row.conditionLabels ? row.conditionLabels : {};
    const side = (positive) => Object.entries(weights)
      .filter(([, weight]) => positive ? weight > EPSILON : weight < -EPSILON)
      .map(([condition]) => labels[condition] ? `${condition}（${labels[condition]}）` : condition)
      .join("、") || (positive ? "正权重条件" : "负权重条件");
    return { positive: side(true), negative: side(false) };
  }

  function numberText(value, digits = 3) {
    if (!Number.isFinite(value)) return "NA";
    return Number(value).toFixed(digits).replace(/\.000$/, "").replace(/(\.\d\d)0$/, "$1").replace(/(\.\d)0$/, "$1");
  }

  function percentText(value, digits = 1) {
    return Number.isFinite(value) ? `${(value * 100).toFixed(digits)}%` : "NA";
  }

  function expectedAlignment(row, value) {
    if (!row || !Number.isFinite(value) || !row.expectedDirection) return "该对比未预设唯一方向，不据此判定回答正确或错误";
    if (Math.abs(value) <= EPSILON) return "观察值为0，与预期方向没有形成一致或相反关系";
    return value * row.expectedDirection > 0 ? "观察方向与题库预期方向一致" : "观察方向与题库预期方向相反，应结合题目内容与稳健性复核";
  }

  function resolvedEffectFormula(row) {
    if (row && row.resolvedFormula) return row.resolvedFormula;
    if (!row || !row.weights || !row.conditionMeans) return "E=ΣwP̄/2";
    const terms = Object.entries(row.weights).filter(([, weight]) => Math.abs(weight) > EPSILON).map(([condition, weight]) => {
      const value = row.conditionMeans[condition];
      return `${numberText(weight, 4)}×${numberText(value, 4)}`;
    });
    return Number.isFinite(row.effect) ? `E=[${terms.join(" + ")}]/2=${numberText(row.effect, 4)}` : "E=NA";
  }

  function interpretE(row, value, options = {}) {
    const meta = resolveMeta(row || {});
    const average = !!options.average;
    if (!meta.directional || !meta.e) return meta.noEffect || "该分类不计算E、平均E或D。";
    if (!Number.isFinite(value)) return `E未形成：${row && row.reason ? row.reason : "必要条件、重复覆盖或对比权重不满足计算要求"}。`;
    if (average) return interpretMeanE(row, value);
    const sides = contrastSides(row);
    const formula = resolvedEffectFormula(row);
    if (isZero(value)) return `${formula}。E为0：${sides.positive}相对${sides.negative}没有产生净偏好移动；这不代表各条件内P等于0。${expectedAlignment(row, value)}。`;
    const positive = value > 0;
    const endpoint = positive ? meta.high : meta.low;
    const rawShift = Number.isFinite(row && row.rawShift) ? Math.abs(row.rawShift) : Math.abs(value * 2);
    return `${formula}。${sides.positive}相对${sides.negative}的加权平均P${positive ? "提高" : "降低"}${numberText(rawShift)}，标准化E=${numberText(value)}；该GroupID的偏好向“${endpoint}”移动。${expectedAlignment(row, value)}。`;
  }

  function interpretMeanE(row, value) {
    const meta = resolveMeta(row || {});
    if (!meta.directional || !meta.e) return meta.noEffect || "该分类不计算平均E。";
    if (!Number.isFinite(value)) return `平均E未形成：${row && row.reason ? row.reason : "当前没有有效题组E"}。`;
    const sides = contrastSides(row);
    const formula = row && row.meanEFormula ? row.meanEFormula : `平均E=ΣE/Gvalid=${numberText(value)}`;
    const valid = row && Number.isFinite(row.validGroups) ? row.validGroups : row && row.meanEDenominator;
    const planned = row && Number.isFinite(row.plannedGroups) ? row.plannedGroups : null;
    const coverage = row && Number.isFinite(row.coverage) ? `，覆盖${valid}/${planned}（${percentText(row.coverage)}）` : "";
    const interval = row && Number.isFinite(row.meanECiLow) && Number.isFinite(row.meanECiHigh) ? `，95%CI=[${numberText(row.meanECiLow)}, ${numberText(row.meanECiHigh)}]` : "";
    const distribution = row && Number.isFinite(row.positiveGroups) ? `；题组方向为正${row.positiveGroups}、负${row.negativeGroups}、零${row.zeroGroups}` : "";
    if (isZero(value)) return `${formula}${coverage}${interval}${distribution}。平均后没有净移动，可能是各题组均接近0，也可能是正负效应相互抵消；平均E仍只是描述值。`;
    const endpoint = value > 0 ? meta.high : meta.low;
    return `${formula}${coverage}${interval}${distribution}。有效题组平均而言，${sides.positive}相对${sides.negative}使偏好向“${endpoint}”移动；是否形成正式D还取决于分类覆盖和推断证据。`;
  }

  function interpretD(row, value) {
    const meta = resolveMeta(row || {});
    if (!meta.directional || !meta.e) return meta.noEffect || "该分类不计算D。";
    if (!row || !row.eligible || !Number.isFinite(value)) return `D未输出：${row && row.reason ? row.reason : "分类覆盖率或有效题组数未达到正式汇总要求"}；描述性平均E可以保留，但不能冒充D。`;
    const formula = row.dFormula || `D=Σ(aE)/Σa=${numberText(value)}`;
    const interval = Number.isFinite(row.ciLow) && Number.isFinite(row.ciHigh) ? `95%CI=[${numberText(row.ciLow)}, ${numberText(row.ciHigh)}]` : "95%CI=NA";
    const pText = Number.isFinite(row.pHolm) ? `Holm校正p=${numberText(row.pHolm, 4)}` : "有效题组不足5个，未进行符号翻转检验";
    const directionText = Number.isFinite(row.positiveGroups) ? `题组方向为正${row.positiveGroups}、负${row.negativeGroups}、零${row.zeroGroups}` : "";
    if (isZero(value)) return `${formula}。覆盖${row.validGroups}/${row.plannedGroups}（${percentText(row.coverage)}），${interval}，${pText}。D为0：跨题组没有平均净条件效应；仍需检查题组E是否正负抵消。`;
    const positive = value > 0;
    const endpoint = positive ? meta.high : meta.low;
    const evidence = row.evidenceStatus === "SUPPORTED"
      ? "覆盖与推断结果共同支持该方向能够跨题组稳定复现"
      : "覆盖门槛已经满足，但置信区间或校正后检验尚不足以支持稳定方向";
    return `${formula}。覆盖${row.validGroups}/${row.plannedGroups}（${percentText(row.coverage)}），${interval}，${pText}${directionText ? `，${directionText}` : ""}。在该三级分类及同一ContrastID下，题组总体向“${endpoint}”移动；${evidence}。D是条件效应汇总，不是决策总偏好分。`;
  }

  function interpretFactorial(analysis, interaction) {
    if (!analysis) return "当前没有可解释的FACTORIAL结果。";
    if (!interaction || !Number.isFinite(interaction.meanE)) return interaction && interaction.reason ? interaction.reason : `${(analysis.factorKeys || []).join(" × ")}因子单元尚未完整覆盖，无法估计交互。`;
    const interval = Number.isFinite(interaction.ciLow) && Number.isFinite(interaction.ciHigh) ? `，95%CI=[${numberText(interaction.ciLow)}, ${numberText(interaction.ciHigh)}]` : "";
    const direction = interaction.meanE > 0 ? "正向" : interaction.meanE < 0 ? "负向" : "接近0";
    const label = interaction.effectLabel || interaction.label || interaction.effectId || interaction.id || "析因效应";
    const coverage = `有效题组${interaction.validGroups}/${interaction.plannedGroups}`;
    const limit = analysis.formalBlocked || interaction.metadataBlocked
      ? `当前题库元数据阻断正式参数化，因此该估计仅作探索性响应画像，不输出正式D或C/N/I。${analysis.blockedReason || ""}`
      : interaction.formal && Number.isFinite(interaction.dScore)
        ? `该效应已登记且覆盖合格，正式D=${numberText(interaction.dScore)}。`
        : "该效应未登记为独立ContrastID，因此保留描述性E/估计值，不输出正式D。";
    if (interaction.effectType === "SIMPLE_SLOPE") {
      const meta = categoryMeta(analysis.bankId, analysis.categoryId);
      const endpoint = meta && meta.directional ? (interaction.meanE > 0 ? meta.high : meta.low) : (interaction.meanE > 0 ? "P正端" : "P负端");
      return `${label}=${numberText(interaction.meanE)} ${interaction.effectUnit || ""}${interval}，${coverage}。每增加0.01数值因子，P平均向“${endpoint}”方向改变${numberText(Math.abs(interaction.meanE))}。${limit}`;
    }
    if (interaction.effectType === "SLOPE_INTERACTION") {
      return `${label}=${numberText(interaction.meanE)} ${interaction.effectUnit || ""}${interval}，${coverage}。${direction}表示高水平组的数值因子斜率相对低水平组更${interaction.meanE > 0 ? "正" : interaction.meanE < 0 ? "负" : "接近一致"}。${limit}`;
    }
    const outcome = interaction.outcomeLabel || "结果变量";
    const effectMeaning = Math.abs(interaction.meanE) < 1e-12
      ? `正、负权重因子组合在“${outcome}”上接近一致`
      : interaction.meanE > 0
        ? `正权重因子组合的“${outcome}”更高`
        : `负权重因子组合的“${outcome}”更高`;
    return `${label}平均E=${numberText(interaction.meanE)}${interval}，${coverage}；${effectMeaning}。${limit}`;
  }

  function staticEffectText(row, positive, metric) {
    if (!row.directional || !row.e) return row.noEffect || "不计算";
    const endpoint = positive ? row.high : row.low;
    if (metric === "D") return `${positive ? "正D" : "负D"}：跨题组总体向“${endpoint}”移动`;
    return `${positive ? "正E" : "负E"}：正权重条件相对负权重条件使偏好向“${endpoint}”移动`;
  }

  return {
    FRAMEWORK,
    rows: FLAT,
    categoryMeta,
    resolveMeta,
    interpretP,
    interpretE,
    interpretMeanE,
    interpretD,
    interpretFactorial,
    resolvedEffectFormula,
    staticEffectText,
    contrastSides,
  };
});
