/**
 * 扩展弹窗：开关 + 选项 + AI 安全验证配置 + 当前页面状态 + 统计。
 */

const PROVIDER_PRESETS = {
  siliconflow: {
    baseUrl: 'https://api.siliconflow.cn/v1',
    model: 'Qwen/Qwen2.5-VL-72B-Instruct',
  },
  deepseek: {
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-flash',
  },
  dashscope: {
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: 'qwen-vl-max',
  },
  zhipu: {
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    model: 'glm-4v-flash',
  },
};

const DEFAULTS = {
  enabled: true,
  mute: true,
  speed: 1,
  autoNext: true,
  skipCompleted: true,
  keepPlaying: true,
  quiz: true,
  answerStrategy: 'first',
  showBadge: false,
  debug: true,
  autoCaptcha: true,
  aiProvider: 'siliconflow',
  aiBaseUrl: 'https://api.siliconflow.cn/v1',
  aiApiKey: '',
  aiModel: 'Qwen/Qwen2.5-VL-72B-Instruct',
};

const CHECKBOX_FIELDS = [
  'enabled',
  'mute',
  'autoNext',
  'skipCompleted',
  'keepPlaying',
  'quiz',
  'showBadge',
  'autoCaptcha',
];
// 新版答题策略（vnode=语义/首项+公示改正 | random=随机+公示改正 | reload=刷新跳过）
const MODERN_STRATEGY_FIELDS = ['modernAnswerStrategy'];
const EMPTY_STATS = {
  quizAnswered: 0,
  captchaSolved: 0,
  nextClicked: 0,
  resumeClicked: 0,
  since: Date.now(),
};

let settings = { ...DEFAULTS };
let refreshTimer = 0;

const $ = (id) => document.getElementById(id);

function fmt(sec) {
  const s = Math.max(0, Math.round(Number(sec) || 0));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${String(r).padStart(2, '0')}`;
}

/**
 * 新版页面（modern 适配器）状态渲染。
 * 只展示适配器上报的真实字段，不推断、不造状态。
 */
function renderModernStatus(resp) {
  const quizStateText = {
    detected: '弹窗已识别',
    awaiting_human: '等待人工作答（弹题）',
    answered: '已提交，自动关闭中',
    auto_answering: '自动作答中',
  };
  const lines = [];

  if (!resp.enabled) {
    setStatus('off', '总开关已关闭');
    return;
  }
  if (resp.quizOpen) {
    const q = resp.quizInfo && resp.quizInfo.questions && resp.quizInfo.questions[0];
    const qText = q ? ` [${q.type}] ${q.title.slice(0, 24)}` : '';
    if (resp.quizState === 'answered') {
      setStatus('warn', `已提交，自动关闭弹窗中…${qText}`);
    } else {
      setStatus('warn', `弹题处理中，等待人工作答${qText}`);
    }
    lines.push(`弹窗状态：${quizStateText[resp.quizState] || resp.quizState}`);
  } else if (resp.noticeOpen) {
    setStatus('warn', '通知弹窗待人工确认「好的」');
  } else if (resp.needsManualSwitch) {
    setStatus('warn', `请手动点击小节 ${resp.needsManualSwitch.num} ${resp.needsManualSwitch.name}`);
    lines.push('自动切换被页面拒绝，需人工点击一次');
  } else if (!resp.hasVideo) {
    setStatus('warn', '已识别新版页面，尚未找到视频（请进入课程播放页）');
  } else if (resp.endedPending) {
    setStatus('warn', '播放结束，完成状态待确认');
  } else if (resp.paused) {
    setStatus('warn', `已暂停 ${fmt(resp.time)} / ${fmt(resp.duration)}`);
  } else {
    setStatus('on', `播放中 ${fmt(resp.time)} / ${fmt(resp.duration)}`);
  }

  // 详情行
  const prog = typeof resp.currentPercentage === 'number' ? ` · 进度 ${resp.currentPercentage}%` : '';
  const statusMap = { completed: '已完成✓', in_progress: '进行中', not_started: '未开始', unknown: '未知' };
  lines.unshift(
    `${resp.courseName || '课程'} · 当前 ${resp.currentLesson || '—'}${prog}（${statusMap[resp.currentStatus] || '—'}）`,
    `完成 ${resp.doneCount || 0}/${resp.lessonCount || 0} 节${resp.switchLocked ? ' · 切集冷却中' : ''}`
  );
  if (Array.isArray(resp.logs) && resp.logs.length) {
    lines.push(`最近日志：${resp.logs[resp.logs.length - 1].msg.slice(0, 40)}`);
  }
  const t = $('statusText');
  if (t) t.title = lines.join('\n');

  renderStopTimer(resp);

  // 统计区沿用同一组计数（新版暂无独立统计字段，展示完成度替代）
  if ($('quizAnswered')) $('quizAnswered').textContent = resp.doneCount || 0;
  if ($('nextClicked')) $('nextClicked').textContent = '—';
  if ($('resumeClicked')) $('resumeClicked').textContent = '—';
  const capEl = $('captchaSolved');
  if (capEl) capEl.textContent = '—';
  const statEls = document.querySelectorAll('.stats .stat span');
  if (statEls.length >= 4) {
    statEls[0].textContent = '完成小节';
    statEls[1].textContent = '章节状态';
    statEls[2].textContent = '自动切集';
    statEls[3].textContent = '人工提示';
  }
}

/* ---- 定时停止 ---- */

function fmtRemaining(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor(s % 3600 / 60);
  const sec = s % 60;
  return (h ? `${h}时` : '') + `${String(m).padStart(2, '0')}分${String(sec).padStart(2, '0')}秒`;
}

function renderStopTimer(resp) {
  const box = $('timerStatus');
  if (!box) return;
  const timer = resp.stopTimer;
  if (timer && timer.deadline && resp.stopTimerRemaining != null) {
    box.textContent = `⏱ 剩余 ${fmtRemaining(resp.stopTimerRemaining)} · 到期${timer.action === 'close' ? '关闭标签页' : '暂停视频'}`;
    box.classList.add('active');
  } else {
    box.textContent = '未设置';
    box.classList.remove('active');
    const cancelBtn = $('timerCancel'); // 本函数内自行获取（bindStopTimerUI 里的局部变量在此不可见）
    if (cancelBtn) cancelBtn.disabled = false;
  }
}

function bindStopTimerUI() {
  const startBtn = $('timerStart');
  const cancelBtn = $('timerCancel');
  if (!startBtn || !cancelBtn) return;

  startBtn.addEventListener('click', async () => {
    const h = Number($('timerHours').value) || 0;
    const m = Number($('timerMinutes').value) || 0;
    const s = Number($('timerSeconds').value) || 0;
    const action = document.querySelector('input[name="timerAction"]:checked')?.value || 'pause';
    const statusEl = $('timerStatus');
    const durMs = h * 3600000 + m * 60000 + s * 1000;
    if (durMs < 10000) {
      statusEl.textContent = '设置失败：时长至少 10 秒';
      statusEl.classList.remove('active');
      return;
    }
    const timer = { deadline: Date.now() + durMs, action, durationMs: durMs };
    // 双通道写入：① 发给内容脚本（立即生效，页面内判定到期）；② 写 storage（持久化，
    // 内容脚本不在线时由适配器下次初始化恢复；过期设置会被自动清除）
    let viaContent = false;
    try {
      const res = await chrome.runtime.sendMessage({ type: 'ZHS_SET_STOP_TIMER', payload: { hours: h, minutes: m, seconds: s, action } });
      if (res && res.ok) {
        viaContent = true;
        renderStopTimer({ stopTimer: res.timer, stopTimerRemaining: res.timer.deadline - Date.now() });
      } else if (res && !res.ok) {
        statusEl.textContent = `设置失败：${res.error || '未知错误'}`;
        statusEl.classList.remove('active');
        return;
      }
    } catch (e) { /* 内容脚本不可达，走 storage 通道 */ }
    try {
      await chrome.storage.local.set({ stopTimer: timer });
    } catch (e) {}
    if (!viaContent) {
      statusEl.textContent = `⏱ 已设置（${fmtRemaining(durMs)}后${action === 'close' ? '关闭标签页' : '暂停视频'}）· 课程页未就绪，刷新页面后生效`;
      statusEl.classList.add('active');
    }
  });

  cancelBtn.addEventListener('click', async () => {
    try {
      await chrome.runtime.sendMessage({ type: 'ZHS_CANCEL_STOP_TIMER' });
      renderStopTimer({ stopTimer: null, stopTimerRemaining: null });
    } catch (e) {
      renderStopTimer({ stopTimer: null, stopTimerRemaining: null });
    }
  });
}

function render() {
  for (const key of CHECKBOX_FIELDS) {
    const el = $(key);
    if (el) el.checked = settings[key] !== false;
  }
  const sel = $('answerStrategy');
  if (sel) sel.value = settings.answerStrategy || 'first';
  const msel = $('modernAnswerStrategy');
  if (msel) msel.value = settings.modernAnswerStrategy || 'vnode';

  const prov = $('aiProvider');
  if (prov) prov.value = settings.aiProvider || 'siliconflow';
  const base = $('aiBaseUrl');
  if (base) base.value = settings.aiBaseUrl || DEFAULTS.aiBaseUrl;
  const model = $('aiModel');
  if (model) model.value = settings.aiModel || DEFAULTS.aiModel;
  const key = $('aiApiKey');
  if (key) key.value = settings.aiApiKey || '';

  const wrap = $('aiConfigWrap');
  if (wrap) {
    wrap.style.display = settings.autoCaptcha !== false ? 'flex' : 'none';
  }
}

function readForm() {
  const next = { ...settings };
  for (const key of CHECKBOX_FIELDS) {
    const el = $(key);
    if (el) next[key] = el.checked;
  }
  const sel = $('answerStrategy');
  if (sel) next.answerStrategy = sel.value;
  for (const key of MODERN_STRATEGY_FIELDS) {
    const el = $(key);
    if (el) next[key] = el.value;
  }

  const prov = $('aiProvider');
  if (prov) next.aiProvider = prov.value;
  const base = $('aiBaseUrl');
  if (base) next.aiBaseUrl = base.value.trim();
  const model = $('aiModel');
  if (model) next.aiModel = model.value.trim();
  const key = $('aiApiKey');
  if (key) next.aiApiKey = key.value.trim();

  return next;
}

function persist() {
  settings = readForm();
  const wrap = $('aiConfigWrap');
  if (wrap) {
    wrap.style.display = settings.autoCaptcha !== false ? 'flex' : 'none';
  }
  try {
    chrome.storage.local.set({ settings });
  } catch (e) {}
}

function setStatus(kind, text) {
  const dot = $('dot');
  const t = $('statusText');
  if (!dot || !t) return;
  dot.className = `dot ${kind}`;
  t.textContent = text;
  t.title = text;
}

function renderStats(stats) {
  $('quizAnswered').textContent = stats.quizAnswered || 0;
  if ($('captchaSolved')) $('captchaSolved').textContent = stats.captchaSolved || 0;
  $('nextClicked').textContent = stats.nextClicked || 0;
  $('resumeClicked').textContent = stats.resumeClicked || 0;
}

function renderStatus(resp) {
  if (!resp || !resp.ok) {
    setStatus('warn', '当前标签页不是智慧树课程页');
    return;
  }
  const progTag = resp.curDone
    ? ' · 已完成✓'
    : typeof resp.curPercentage === 'number'
      ? ` · 结算进度 ${resp.curPercentage}%${resp.replaying ? `(重播第${resp.replayCount || 1}次)` : ''}`
      : '';
  if (!resp.enabled) {
    setStatus('off', '总开关已关闭');
  } else if (resp.blocked) {
    setStatus('off', '检测到平台拦截，已停止；关闭插件并重新进入页面');
  } else if (resp.captchaOpen) {
    const tip = resp.captchaErrorHint
      ? `安全验证：${resp.captchaErrorHint}`
      : `正在自动识别安全验证（${resp.captchaPrompt || '点选字符'}）…`;
    setStatus('warn', tip);
  } else if (!resp.hasVideo) {
    setStatus('warn', '已连接页面，但还没找到视频（请进入课程并点播放）');
  } else if (resp.quizOpen) {
    setStatus('warn', `检测到弹题，正在作答… ${fmt(resp.time)} / ${fmt(resp.duration)}${progTag}`);
  } else if (resp.paused) {
    setStatus('warn', `视频暂停中 ${fmt(resp.time)} / ${fmt(resp.duration)}${progTag}`);
  } else {
    setStatus('on', `播放中 ${fmt(resp.time)} / ${fmt(resp.duration)}${progTag}`);
  }
  if (resp.stats) renderStats(resp.stats);
}

async function refreshStatus() {
  // 定时器状态独立于内容脚本：直接读 storage（即使消息通道不可达也持续显示倒计时）
  let storageTimer = null;
  try {
    const got = await chrome.storage.local.get('stopTimer');
    storageTimer = (got && got.stopTimer) || null;
  } catch (e) {}

  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const tab = tabs && tabs[0];
    if (!tab || !tab.id) {
      setStatus('off', '没有活动标签页');
      renderStopTimer({ stopTimer: storageTimer, stopTimerRemaining: storageTimer ? storageTimer.deadline - Date.now() : null });
      return;
    }
    // 优先读 storage 快照（hostname 键，零消息依赖、100% 可靠）：
    // 活动标签页 URL 与快照 href 匹配才采用（避免读错标签页的快照）
    let storedSnap = null;
    let failReason = 'storage无快照';
    try {
      const host = new URL(tab.url || '').hostname;
      const key = 'zhs-snap-' + host;
      const got = await chrome.storage.local.get(key);
      const entry = got && got[key];
      if (!entry || !entry.payload) failReason = 'storage无快照';
      else if (Date.now() - entry.ts >= 15000) failReason = `快照过期(${Math.round((Date.now() - entry.ts) / 1000)}s)`;
      else if (entry.href.split('#')[0] !== (tab.url || '').split('#')[0]) failReason = 'URL不匹配';
      else storedSnap = entry.payload;
    } catch (e) { failReason = '读取异常:' + String(e && e.message || e).slice(0, 40); }
    if (storedSnap) {
      renderModernStatus(storedSnap);
      renderStopTimer({ stopTimer: storageTimer, stopTimerRemaining: storageTimer ? storageTimer.deadline - Date.now() : null });
      return;
    }
    // storage 快照缺失/过期：background 快照表兜底
    const snap = await chrome.runtime.sendMessage({ type: 'ZHS_GET_SNAPSHOT', tabId: tab.id }).catch(() => null);
    if (snap && snap.ok && snap.snapshot) {
      renderModernStatus(snap.snapshot);
      renderStopTimer({ stopTimer: storageTimer, stopTimerRemaining: storageTimer ? storageTimer.deadline - Date.now() : null });
      return;
    }
    const resp = await chrome.tabs.sendMessage(tab.id, { type: 'ZHS_GET_STATUS' }).catch(() => null);
    // 新版适配器响应（adapter: 'modern'）：展示新版真实状态
    if (resp && resp.ok && resp.adapter === 'modern') {
      renderModernStatus(resp);
      return;
    }
    if (resp && resp.ok) {
      renderStatus(resp);
      return;
    }
    // 快照与直连均失败：若 background 有 60s 内的陈旧快照也用它（内容脚本可能被节流）
    const stale = snap && snap.ok ? snap.snapshot : null;
    if (stale) {
      renderModernStatus({ ...stale, paused: true });
      renderStopTimer({ stopTimer: storageTimer, stopTimerRemaining: storageTimer ? storageTimer.deadline - Date.now() : null });
      return;
    }
    // 全部失败：区分「新版页面但适配器未就绪」与「非课程页」，并附失败阶段
    if (/^https?:\/\/([^/]+\.)?wisdom-mooc\.zhihuishu\.com\//i.test(tab.url || '')) {
      setStatus('warn', `新版页面已注入但状态获取失败（${failReason}）；请刷新页面`);
    } else {
      setStatus('warn', `当前标签页不是智慧树课程页（${failReason}）`);
    }
  } catch (e) {
    setStatus('warn', '当前标签页不是智慧树课程页');
  }
  // 内容脚本不可达时仍展示定时倒计时（storage 数据）
  if (storageTimer && storageTimer.deadline) {
    renderStopTimer({ stopTimer: storageTimer, stopTimerRemaining: storageTimer.deadline - Date.now() });
  }
}

async function loadStats() {
  try {
    const { stats } = await chrome.storage.local.get('stats');
    renderStats({ ...EMPTY_STATS, ...(stats || {}) });
  } catch (e) {}
}

function setAiHint(text, cls = '') {
  const hint = $('aiHint');
  if (!hint) return;
  hint.textContent = text;
  hint.className = `ai-hint ${cls}`.trim();
}

async function init() {
  try {
    const { settings: s } = await chrome.storage.local.get('settings');
    settings = { ...DEFAULTS, ...(s || {}) };
  } catch (e) {}

  render();
  await loadStats();
  await refreshStatus();

  for (const key of [...CHECKBOX_FIELDS, 'answerStrategy', ...MODERN_STRATEGY_FIELDS]) {
    const el = $(key);
    if (!el) continue;
    el.addEventListener('change', persist);
  }

  $('aiProvider').addEventListener('change', (ev) => {
    const preset = PROVIDER_PRESETS[ev.target.value];
    if (preset) {
      $('aiBaseUrl').value = preset.baseUrl;
      $('aiModel').value = preset.model;
    }
    persist();
  });

  for (const id of ['aiBaseUrl', 'aiModel', 'aiApiKey']) {
    const el = $(id);
    if (!el) continue;
    el.addEventListener('input', persist);
    el.addEventListener('change', persist);
  }

  $('testAi').addEventListener('click', async () => {
    persist();
    const btn = $('testAi');
    btn.disabled = true;
    btn.textContent = '测试中…';
    setAiHint('正在测试视觉模型连通性…');
    try {
      const res = await chrome.runtime.sendMessage({
        type: 'ZHS_TEST_AI_KEY',
        payload: {
          aiBaseUrl: settings.aiBaseUrl,
          aiApiKey: settings.aiApiKey,
          aiModel: settings.aiModel,
        },
      });
      if (res && res.ok) {
        setAiHint(`✓ 连接成功！模型 ${settings.aiModel} 支持图像识别`, 'ok');
      } else {
        setAiHint(`✗ 失败：${(res && res.error) || '未知错误'}`, 'err');
      }
    } catch (e) {
      setAiHint(`✗ 调用异常：${String(e && e.message ? e.message : e)}`, 'err');
    } finally {
      btn.disabled = false;
      btn.textContent = '测试';
    }
  });

  $('scan').addEventListener('click', async () => {
    try {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      const tab = tabs && tabs[0];
      if (tab && tab.id) await chrome.tabs.sendMessage(tab.id, { type: 'ZHS_SCAN_NOW' });
    } catch (e) {}
    await refreshStatus();
  });

  $('reset').addEventListener('click', async () => {
    try {
      await chrome.storage.local.set({ stats: { ...EMPTY_STATS, since: Date.now() } });
    } catch (e) {}
    renderStats(EMPTY_STATS);
  });

  bindStopTimerUI();

  refreshTimer = setInterval(refreshStatus, 1500);
  window.addEventListener('unload', () => clearInterval(refreshTimer));
}

init();
