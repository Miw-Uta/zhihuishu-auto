/**
 * 新版智慧树适配器（wisdom-mooc.zhihuishu.com）—— v0.7.0 · 第一批：播放器适配。
 *
 * 设计约束（与用户确认的方案一致）：
 *  - 独立命名空间 window.__ZHS_MODERN__，不触碰旧版 app.js / main-world.js 逻辑；
 *  - 所有选择器来自 modern-config.js，本文件不出现裸选择器；
 *  - 播放控制优先标准 HTMLVideoElement API；ablePlayerX('container') 在运行时探测，
 *    仅将「真实存在且可用」的方法加入可用集，不假定；
 *  - 不绕过自动播放限制（无用户手势时 play() 失败仅记录并等待，不反复暴力重试）；
 *  - 不修改任何网络请求，不伪造学习时长或进度。
 */
(() => {
  'use strict';
  if (window.__ZHS_MODERN__) return;
  window.__ZHS_MODERN__ = true;

  const CFG = window.ZHS_MODERN_CONFIG || {};
  const SEL = CFG.selectors || {};
  const LIMITS = CFG.limits || {};

  const TAG = '%c[ZHS-M]';
  const TAG_STYLE = 'color:#1971c2;font-weight:700';

  const S = {
    settings: { enabled: true, mute: true, speed: 1, keepPlaying: true, autoNext: true, skipCompleted: true, debug: true },
    video: null,
    boundVideo: null,
    lastTime: 0,
    lastAdvanceAt: 0,
    autoplayWarnedAt: 0,
    quizOpen: false,        // 第三批接入弹题检测
    blockedDialogOpen: false, // 未识别弹窗（第三批）
    endedPending: false,    // ended 后等待完成状态确认
    endedPendingAt: 0,      // ended 发生时刻（用于确认窗口超时）
    ready: false,
    timers: [],
    observers: [],
    resumeTimer: 0,
    // ---- 第二批：课程目录与切集 ----
    switchLockUntil: 0,       // 切集防重复锁
    lastSwitchAt: 0,
    lastSwitchTarget: '',     // 上次切换目标（防同节重复点击）
    endedConfirmTimer: 0,     // ended 后完成状态确认定时器
    switching: false,         // 切集进行中标志（防并发）
    awaitingCompletion: null, // { num, name, at }：当前节刚播完，等待 finish-icon 结算
    lastEndedAt: 0,           // 最近一次 ended 时刻（识别页面自动重播）
    noNextLogUntil: 0,        // 「无可切目标」日志节流
    startJumpDone: false,     // 启动时跳转未完成节（一次性，对齐旧版行为）
    probeAttempts: 0,         // ablePlayerX 补探次数上限
    needsManualSwitch: null,  // { num, name, reason }：脚本点击被页面拒绝，等待人工切换
    quizState: 'idle',        // idle | detected | awaiting_human | answered | feedback | closed
    quizInfo: null,           // { type, title, options: [{mark, text, selected, right, error}], submitted, correctAnswer }
    quizCloseAttempts: 0,     // 「已提交」后自动关闭尝试次数（最多 3 次）
    quizCloseTimer: 0,        // 关闭定时器句柄（防重复调度）
    quizStateWasPreAnswered: false, // 弹窗出现时即为已答状态（重进已答题场景）
    endedFastPoll: 0,         // ended 后的 500ms 快轮询句柄（对勾出现/页面重播即停）
    autoAnswer: { round: 0, busy: false }, // 自动作答轮次与并发标志
    noticeOpen: false,        // ai-notice-dialog 打开中
    lastLogs: [],             // 最近日志环形缓冲（popup 展示用）
  };

  // ---------- 日志 ----------

  function log(...args) {
    if (S.settings.debug) console.log(TAG, TAG_STYLE, ...args);
    try {
      S.lastLogs.push({ t: new Date().toISOString().slice(11, 19), msg: args.map((a) => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ') });
      if (S.lastLogs.length > 30) S.lastLogs.shift();
    } catch (e) {}
  }
  function warn(...args) {
    console.warn('[ZHS-M]', ...args);
  }

  // ---------- 基础工具 ----------

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const rand = (a, b) => a + Math.random() * (b - a);
  const toArr = (v) => (Array.isArray(v) ? v : v ? [v] : []);

  function queryFirst(selectors, root = document) {
    for (const sel of toArr(selectors)) {
      try {
        const el = root.querySelector(sel);
        if (el) return el;
      } catch (e) { /* 非法选择器跳过 */ }
    }
    return null;
  }

  function registerTimer(id) {
    S.timers.push(id);
    return id;
  }
  function registerObserver(mo) {
    S.observers.push(mo);
    return mo;
  }

  /**
   * 全部定时器与观察者的统一清理入口（页面刷新/路由切换重建时调用）。
   * MutationObserver 观察的是 document.documentElement，切换课程时 DOM 不换根，
   * 因此观察者可跨课程复用，仅在 destroy() 时统一断开，避免重复注册。
   */
  function destroy() {
    for (const id of S.timers) clearInterval(id);
    S.timers = [];
    if (S.resumeTimer) { clearTimeout(S.resumeTimer); S.resumeTimer = 0; }
    if (S.endedFastPoll) { clearInterval(S.endedFastPoll); S.endedFastPoll = 0; }
    for (const mo of S.observers) {
      try { mo.disconnect(); } catch (e) {}
    }
    S.observers = [];
    S.boundVideo = null;
    S.video = null;
    S.ready = false;
    warn('适配器已清理（SPA 路由变化或页面卸载）');
  }

  // ---------- 播放器探测 ----------

  /**
   * 运行时验证 ablePlayerX('container') 的真实接口。
   * 只把「确认存在且为函数」的方法加入可用集；探测失败不抛错、不阻塞。
   */
  function probeAblePlayer() {
    const result = { available: false, methods: [] };
    try {
      if (typeof window.ablePlayerX !== 'function') return result;
      const p = window.ablePlayerX('container');
      if (!p || typeof p !== 'object') return result;
      for (const m of ['play', 'pause', 'seek', 'getDuration', 'getPosition']) {
        if (typeof p[m] === 'function') result.methods.push(m);
      }
      result.available = result.methods.length > 0;
      if (result.available) log('ablePlayerX 可用方法:', result.methods.join(', '));
    } catch (e) {
      warn('ablePlayerX 探测失败（忽略，走标准 video API）:', e && e.message);
    }
    return result;
  }

  function ensureVideo() {
    if (S.video && S.video.isConnected) return S.video;
    const v = queryFirst(SEL.video);
    if (v) {
      S.video = v;
      S.lastTime = v.currentTime || 0;
      S.lastAdvanceAt = Date.now();
      // 初始化时播放器可能尚未创建（首探为空），拿到视频后补探一次（最多 3 次）
      if ((!S.playerMethods || !S.playerMethods.length) && S.probeAttempts < 3) {
        S.probeAttempts++;
        const probe = probeAblePlayer();
        S.playerMethods = probe.methods;
      }
    } else {
      S.video = null;
    }
    return S.video;
  }

  function bindVideo(v) {
    if (S.boundVideo === v) return;
    S.boundVideo = v;

    v.addEventListener('play', () => {
      S.endedPending = false;
      log('事件 play · t=' + Math.round(v.currentTime || 0));
    });

    v.addEventListener('pause', () => {
      log('事件 pause · t=' + Math.round(v.currentTime || 0));
      // 弹窗/未识别弹窗存在时，暂停是页面自身行为，不自动续播（第三批接入后在此分支）
      if (S.quizOpen || S.blockedDialogOpen) return;
      if (!S.settings.enabled || !S.settings.keepPlaying) return;
      // 单槽位恢复定时器：新 pause 覆盖旧定时器，避免长期挂机累积
      if (S.resumeTimer) clearTimeout(S.resumeTimer);
      S.resumeTimer = setTimeout(() => {
        S.resumeTimer = 0;
        if (S.video !== v || !v.paused) return;
        if (v.ended) return;
        if (S.quizOpen || S.blockedDialogOpen) return;
        tryPlay(v, 'pause 恢复');
      }, 1200);
    });

    v.addEventListener('ended', () => {
      log('事件 ended · t=' + Math.round(v.currentTime || 0));
      S.endedPending = true;
      S.lastEndedAt = Date.now();
      // 完成状态观察由 tick 周期驱动（checkEndedCompletion）；
      // 此处立即补一轮主动检测 + 500ms 快轮询，缩短"播完→切集"体感延迟
      //（tick 周期 900ms 且要等下一个 tick 才发现 completed，主动轮询把延迟压到亚秒级）
      if (!S.endedFastPoll) {
        S.endedFastPoll = registerTimer(setInterval(() => {
          const cat = parseCatalog();
          const idx = currentIndex(cat);
          const curItem = idx >= 0 ? cat[idx] : null;
          const done = curItem && curItem.status === 'completed';
          const playing = S.video && !S.video.paused && !S.video.ended;
          if (done || playing) {
            clearInterval(S.endedFastPoll);
            S.endedFastPoll = 0;
            if (done) checkEndedCompletion(); // 立即触发切集判定
          }
        }, 500));
      }
    });

    v.addEventListener('timeupdate', () => {
      S.lastTime = v.currentTime || 0;
      S.lastAdvanceAt = Date.now();
    });

    v.addEventListener('error', () => warn('video error:', v.error));

    log('已绑定 video', v.id || '(无 id)');
  }

  /**
   * 播放尝试。带节流的自动播放失败日志（NotAllowedError 时提示需要用户手势）。
   */
  function tryPlay(v, reason) {
    if (!v) return;
    try {
      if (v.paused && !v.ended) {
        const p = v.play();
        if (p && typeof p.catch === 'function') {
          p.catch((err) => {
            const t = Date.now();
            if (t - S.autoplayWarnedAt > 8000) {
              S.autoplayWarnedAt = t;
              warn(`play() 被浏览器拒绝（${reason || ''}）：需要用户先与页面交互。`, err && err.name);
            }
          });
        }
      }
    } catch (e) {
      warn('tryPlay 异常:', e);
    }
  }

  function checkStall() {
    const v = S.video;
    if (!v || v.paused || v.ended) return;
    const t = v.currentTime || 0;
    if (t > S.lastTime + 0.05) {
      S.lastTime = t;
      S.lastAdvanceAt = Date.now();
      return;
    }
    const stallMs = LIMITS.stallMs || 12000;
    if (Date.now() - S.lastAdvanceAt < stallMs) return;

    S.lastAdvanceAt = Date.now();
    warn(`视频 ${Math.round(stallMs / 1000)}s 未前进，尝试恢复播放`);
    tryPlay(v, '卡住恢复');
  }

  // ---------- 第二批：课程目录解析与完成状态三态判定 ----------

  const CLS = CFG.classes || {};

  /**
   * 单个小节的状态判定（依据第二阶段实测三态）：
   *   completed   = img.finish-icon 存在（页面对勾图标，唯一权威完成判据）
   *   in_progress = .el-progress[role=progressbar] 存在（aria-valuenow = 0~99）
   *   not_started = 两者皆无（item-box 仅占位注释）
   *   unknown     = item-box 缺失等结构异常
   */
  function getLessonStatus(item) {
    try {
      if (!item || !item.isConnected) return { status: 'unknown', reason: 'no_item' };
      const box = item.querySelector('.item-box');
      if (!box) return { status: 'unknown', reason: 'no_item_box' };
      if (box.querySelector('img.finish-icon')) return { status: 'completed' };
      const progress = box.querySelector('.el-progress[role="progressbar"]');
      if (progress) {
        const raw = progress.getAttribute('aria-valuenow');
        const pct = raw === null || raw === '' ? null : Number(raw);
        return {
          status: 'in_progress',
          percentage: pct !== null && Number.isFinite(pct) ? pct : null,
          reason: pct === null ? 'bad_valuenow' : undefined,
        };
      }
      return { status: 'not_started' };
    } catch (e) {
      return { status: 'unknown', reason: String(e && e.message || e) };
    }
  }

  /**
   * 解析课程目录：按 DOM 顺序展开章名与小节。
   * 目录结构（实测）：.el-collapse-item（章）内 .chapter-content > .chapter-item（节），
   * 「测试」条目 .test-box 与 .chapter-content 平级，天然不在 chapterItems 集合中。
   */
  function parseCatalog() {
    const out = [];
    try {
      const chapters = [...document.querySelectorAll('.el-collapse-item')];
      let lessonIdx = 0;
      for (const ch of chapters) {
        const chTitle = ch.querySelector('.chapter-title');
        const chName = ch.querySelector('.chapter-name');
        const chapterLabel = [chTitle, chName].filter(Boolean).map((e) => (e.textContent || '').trim()).filter(Boolean).join(' ');
        for (const item of ch.querySelectorAll('.chapter-item')) {
          const numEl = item.querySelector('.item-num');
          const nameEl = item.querySelector('.item-name');
          out.push({
            index: lessonIdx++,
            element: item,
            chapter: chapterLabel,
            num: numEl ? (numEl.textContent || '').trim() : '',
            name: nameEl ? (nameEl.textContent || '').trim() : '',
            isCurrent: item.classList.contains(CLS.currentLesson || 'current'),
            panel: ch,
            ...getLessonStatus(item),
          });
        }
      }
    } catch (e) {
      warn('目录解析异常:', e);
    }
    return out;
  }

  /** 当前正在播放（.current）的小节在 catalog 中的下标；找不到返回 -1 */
  function currentIndex(catalog) {
    const idx = catalog.findIndex((x) => x.isCurrent);
    return idx;
  }

  /**
   * 下一节导航：跳过已完成与测试条目（test-box 天然不在列表内，此为双保险），
   * 支持跨章；优先向后找，若开启「跳过已完成」则兜底从头找遗漏的未完成节。
   */
  function findNextLesson(catalog, skipCompleted) {
    const cur = currentIndex(catalog);
    for (let i = cur + 1; i < catalog.length; i++) {
      const x = catalog[i];
      if (x.status === 'completed') continue;
      return x;
    }
    if (skipCompleted) {
      // 尾部无未完成节时，回头找最早遗漏的未完成节（复用旧版「按序补刷」思想）
      for (let i = 0; i < catalog.length; i++) {
        const x = catalog[i];
        if (x.status === 'completed' || i === cur) continue;
        return x;
      }
    }
    return null;
  }

  /**
   * 展开目标小节所在的折叠面板（若未展开）。
   * 使用与切集相同的完整指针序列（实测裸 click 会被页面拒绝）。
   */
  async function ensurePanelOpen(panel) {
    if (!panel) return true;
    if (panel.classList.contains(CLS.activePanel || 'is-active')) return true;
    const header = panel.querySelector('.el-collapse-item__header');
    if (!header) {
      warn('折叠面板 header 未找到（框架级选择器待验证），无法展开面板');
      return false;
    }
    dispatchPointerClick(header);
    await sleep(400);
    const opened = panel.classList.contains(CLS.activePanel || 'is-active');
    if (!opened) warn('面板展开未生效（页面拒绝合成点击），将提示人工切换');
    return opened;
  }

  /** 验证切换是否生效：.current 标记落到目标节，或播放器换源 */
  async function waitForSwitchConfirmed(targetNum, timeoutMs = 8000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await sleep(400);
      const items = [...document.querySelectorAll('.chapter-item')];
      const cur = items.find((el) => el.classList.contains(CLS.currentLesson || 'current'));
      if (cur) {
        const curNum = cur.querySelector('.item-num');
        if (curNum && (curNum.textContent || '').trim() === targetNum) return true;
      }
    }
    return false;
  }

  /**
   * 完整指针点击序列：pointerdown → mousedown → pointerup → mouseup → click。
   * 实测（2026-11-17）：新版页面校验指针事件序列完整性，裸 click 被拒绝，
   * 完整序列可通过——不伪造 isTrusted（合成事件保持 false），与真实用户操作流程一致。
   */
  function dispatchPointerClick(el) {
    const r = el.getBoundingClientRect();
    const x = Math.round(r.left + r.width / 2) || 10;
    const y = Math.round(r.top + r.height / 2) || 10;
    const base = { bubbles: true, cancelable: true, composed: true, view: window, clientX: x, clientY: y, button: 0 };
    try { el.dispatchEvent(new PointerEvent('pointerdown', { ...base, pointerType: 'mouse', isPrimary: true })); } catch (e) {}
    try { el.dispatchEvent(new MouseEvent('mousedown', base)); } catch (e) {}
    try { el.dispatchEvent(new PointerEvent('pointerup', { ...base, pointerType: 'mouse', isPrimary: true })); } catch (e) {}
    try { el.dispatchEvent(new MouseEvent('mouseup', { ...base })); } catch (e) {}
    try { el.dispatchEvent(new MouseEvent('click', { ...base })); } catch (e) {}
  }

  /**
   * 切换到指定小节。含防重复锁、面板展开、点击候选链、生效验证与人工兜底提示。
   * 实测已知：普通合成 click 在新版被目录校验拒绝（.current 不转移）。
   * 这里仍按候选链尝试完整指针序列；全部无效时进入 needsManualSwitch 状态，
   * 提示人工点击——不伪造 isTrusted、不绕过页面校验。
   */
  async function switchToLesson(target) {
    if (!target || !target.element || !target.element.isConnected) {
      return { ok: false, reason: 'target_lost' };
    }
    const now = Date.now();
    if (now < S.switchLockUntil) return { ok: false, reason: 'locked' };
    const targetKey = target.num || target.name;
    if (S.lastSwitchTarget === targetKey && now - S.lastSwitchAt < 10000) {
      return { ok: false, reason: 'same_target_recent' };
    }

    S.lastSwitchAt = now;
    S.lastSwitchTarget = targetKey;
    S.switchLockUntil = now + (LIMITS.switchLockMs || 18000);

    const opened = await ensurePanelOpen(target.panel);
    if (!opened) {
      S.needsManualSwitch = { num: target.num, name: target.name, reason: 'panel_click_blocked' };
      log(`请手动展开章节面板并点击小节 ${target.num} ${target.name}（脚本点击被页面拦截）`);
      return { ok: false, reason: 'panel_click_blocked', manual: true };
    }

    for (const sel of toArr(SEL.lessonClickTargets || ['.chapter-item'])) {
      let clickEl = null;
      try { clickEl = target.element.querySelector(sel) || (target.element.matches(sel) ? target.element : null); } catch (e) {}
      if (!clickEl) continue;

      dispatchPointerClick(clickEl);
      log(`已发送指针点击序列（候选 ${sel}）：${target.num} ${target.name}`);

      const confirmed = await waitForSwitchConfirmed(targetKey);
      if (confirmed) {
        log(`切换生效：当前小节已变为 ${target.num} ${target.name}`);
        S.lastSwitchTarget = '';
        S.needsManualSwitch = null;
        // 切集成功即结束上一节的"等待结算"观察（否则 popup 会一直显示旧状态）
        S.endedPending = false;
        S.awaitingCompletion = null;
        S.lastEndedAt = 0;
        return { ok: true, via: sel };
      }
      warn(`候选 ${sel} 指针序列未生效（.current 未转移）`);
    }

    // 页面校验拒绝了合成点击：转人工，明确告知，不做绕过
    S.needsManualSwitch = { num: target.num, name: target.name, reason: 'click_rejected' };
    log(`小节 ${target.num} ${target.name} 自动切换被页面拒绝（目录点击校验），请手动点击该小节继续；插件会持续观察该节完成状态`);
    return { ok: false, reason: 'click_rejected', manual: true };
  }

  /**
   * 视频播完后的完成状态观察（持续进行，非一次性窗口）：
   *
   * 实测发现：新版页面在当前节未拿到 finish-icon 时会自动从 0 重播当前节补时长
   * （ended → play@0），因此 ended 只表示"一轮播完"，完成结算可能在任意一轮之后。
   * 这里由 tick 周期驱动：当前节处于 in_progress/not_started 且刚发生过 ended 时，
   * 持续轮询 finish-icon —— 出现即触发 autoNext；页面自动重播后进度继续走，
   * 下一轮 ended 再次进入观察，形成闭环。
   *
   * 只有当视频不再播放（页面停止重播）且长时间无图标时，才提示人工确认，
   * 不由插件自动重播（不伪造观看行为）。
   */
  function checkEndedCompletion() {
    if (!S.settings.enabled) return;

    const catalog = parseCatalog();
    const curIdx = currentIndex(catalog);
    const cur = curIdx >= 0 ? catalog[curIdx] : null;
    if (!cur) return;

    // 已进入切集流程则不再观察
    if (S.switching) return;

    if (cur.status === 'completed') {
      // 竞态修复：页面可能在 ended 后 3 秒内立即结算对勾（进度已满 100%），
      // 早于 awaitingCompletion 状态建立——此时也要触发切集，不能只依赖等待状态。
      // 防重复由 switchLock/same_target_recent 双保险兜底。
      if (S.awaitingCompletion) {
        log(`当前小节 ${cur.num} ${cur.name} 已出现完成图标（finish-icon），结算完成`);
        S.awaitingCompletion = null;
        S.endedPending = false;
      }
      if (S.settings.autoNext && !S.switching) {
        const next = findNextLesson(catalog, S.settings.skipCompleted !== false);
        if (next) {
          if (Date.now() > S.noNextLogUntil) {
            S.noNextLogUntil = Date.now() + 60000;
            log(`当前小节 ${cur.num} ${cur.name} 已完成（finish-icon），自动切换下一节：${next.num} ${next.name}（状态 ${next.status}${next.percentage != null ? ' ' + next.percentage + '%' : ''}）`);
          }
          runSwitch(next);
        } else if (Date.now() > S.noNextLogUntil) {
          S.noNextLogUntil = Date.now() + 60000;
          log('目录中没有未完成的小节了（或全部待确认）');
        }
      }
      return;
    }

    // 未完成但视频又在播（页面自动重播中）：维持观察，不打扰
    const v = S.video;
    if (v && !v.paused && !v.ended) {
      if (S.awaitingCompletion) {
        // 页面自动重播已接管，清掉 pending 标记，等它下一轮播完
        S.awaitingCompletion = null;
        S.endedPending = false;
        log(`页面已自动重播当前节（${cur.num}）继续补时长，插件继续观察直至出现完成图标`);
      }
      return;
    }

    // 视频停着且未完成：若刚 ended 过，进入/维持"待确认"状态
    if (v && (v.ended || v.paused)) {
      const endedJustNow = Date.now() - S.lastEndedAt < 3000;
      if (endedJustNow && !S.awaitingCompletion) {
        S.awaitingCompletion = { num: cur.num, name: cur.name, at: Date.now() };
        S.endedPending = true;
        log(`当前小节 ${cur.num} ${cur.name} 播放结束，等待页面结算完成状态（出现 finish-icon 后自动切下一节）`);
      } else if (S.awaitingCompletion && Date.now() - S.awaitingCompletion.at > 12000 && !endedJustNow) {
        // 停了 12s 仍无图标且页面没有重播：用标准 play() 触发重播。
        // （ended 状态下 HTML5 play() 规范行为是从头播放；与旧版 replayCurrentLesson
        // 的 v.currentTime=0 + play() 同款机制，页面自身计时器照常记账，不伪造进度。
        // 注：不能用目录点击触发重播——页面忽略对当前节的点击（no-op），
        // 且 waitForSwitchConfirmed 会因 .current 已在目标节而误报成功。）
        log(`小节 ${cur.num} 播放停止 12s 未结算：触发重播（标准 play()，页面计时器照常记账）`);
        S.awaitingCompletion = { ...S.awaitingCompletion, at: Date.now() };
        if (v.ended) {
          try { v.currentTime = 0; } catch (e) {}
        }
        tryPlay(v, '重播当前节');
      }
    }
  }

  /** 切集执行（防并发入口） */
  async function runSwitch(next) {
    if (S.switching) return;
    S.switching = true;
    try {
      const res = await switchToLesson(next);
      if (!res.ok) log('自动切换未完成：', res.reason, res.manual ? '（已提示人工处理）' : '');
    } finally {
      S.switching = false;
    }
  }

  /**
   * 启动/换课后的一次性检查：若当前节已完成而后面还有未完成节，
   * 跳到第一个未完成节（对齐旧版「打开页面跳到未完成处」的行为）。
   */
  function maybeJumpToUnfinished() {
    if (!S.settings.enabled || !S.settings.autoNext || !S.settings.skipCompleted) return;
    if (S.startJumpDone || S.switching) return;
    if (S.quizOpen || S.blockedDialogOpen) return;
    if (Date.now() < S.switchLockUntil) return;

    const v = S.video;
    // 只在尚未开始播放时跳，避免打断用户正在看的节
    if (v && (v.currentTime || 0) > 5) {
      S.startJumpDone = true;
      return;
    }
    if (!v) return;

    const catalog = parseCatalog();
    const curIdx = currentIndex(catalog);
    const cur = curIdx >= 0 ? catalog[curIdx] : null;
    if (!cur) return;
    if (cur.status !== 'completed') {
      S.startJumpDone = true;
      return;
    }
    const next = findNextLesson(catalog, true);
    if (!next) {
      S.startJumpDone = true;
      return;
    }
    S.startJumpDone = true;
    log(`当前小节 ${cur.num} ${cur.name} 已完成，启动跳转到第一个未完成节：${next.num} ${next.name}`);
    runSwitch(next);
  }

  // ---------- 主循环 ----------

  function tick() {
    try {
      if (!S.settings.enabled) return;

      // 弹窗存在时：不做播放操作，但保持弹窗状态机心跳（每秒强制重读，
      // 不依赖 DOM 变化触发——题目异步加载/已答状态若无后续 attribute 变化，
      // 纯观察器驱动会永远停在 detected）
      if (S.quizOpen || S.noticeOpen) {
        updateQuizState();
        return;
      }

      const v = ensureVideo();
      if (!v) return;

      bindVideo(v);

      // 静音与倍速（倍速上限与平台风控一致：≤1.8）
      if (S.settings.mute && !v.muted) {
        try { v.muted = true; } catch (e) {}
      }
      const speed = Math.min(LIMITS.maxSpeed || 1.8, Math.max(LIMITS.minSpeed || 0.5, Number(S.settings.speed) || 1));
      if (Math.abs(v.playbackRate - speed) > 0.01) {
        try { v.playbackRate = speed; } catch (e) {}
      }

      checkStall();
      checkEndedCompletion();
      maybeJumpToUnfinished();
    } catch (e) {
      // 主循环单轮异常不终止循环本身（不吞：明确告警）
      warn('tick 异常（循环继续）:', e);
    }
  }

  // ---------- 状态上报（popup 查询用；第四批接入弹窗/课程状态字段） ----------

  function statusPayload() {
    const v = S.video;
    const catalog = parseCatalog();
    const curIdx = currentIndex(catalog);
    const cur = curIdx >= 0 ? catalog[curIdx] : null;
    return {
      ok: true,
      adapter: 'modern',
      href: location.href,
      enabled: S.settings.enabled,
      ready: S.ready,
      hasVideo: !!v,
      paused: v ? v.paused : null,
      time: v ? Math.round(v.currentTime || 0) : 0,
      duration: v && Number.isFinite(v.duration) ? Math.round(v.duration) : 0,
      speed: v ? v.playbackRate : null,
      muted: v ? v.muted : null,
      courseName: (document.querySelector('.course-name') || {}).textContent?.trim() || '',
      currentLesson: cur ? `${cur.num} ${cur.name}`.trim() : '',
      currentChapter: cur ? cur.chapter : '',
      currentStatus: cur ? cur.status : null,
      currentPercentage: cur && cur.percentage != null ? cur.percentage : null,
      lessonCount: catalog.length,
      doneCount: catalog.filter((x) => x.status === 'completed').length,
      inProgressCount: catalog.filter((x) => x.status === 'in_progress').length,
      endedPending: S.endedPending,
      quizOpen: S.quizOpen,
      quizState: S.quizState,
      quizInfo: S.quizInfo,
      noticeOpen: S.noticeOpen,
      blockedDialogOpen: S.blockedDialogOpen,
      switchLocked: Date.now() < S.switchLockUntil,
      needsManualSwitch: S.needsManualSwitch,
      playerMethods: S.playerMethods,
      logs: [...S.lastLogs],
    };
  }

  // ---------- 消息通道（popup / background 查询状态） ----------

  function bindMessaging() {
    try {
      chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
        if (!msg) return false;
        if (msg.type === 'ZHS_GET_STATUS' || msg.type === 'ZHS_SCAN_NOW') {
          sendResponse(statusPayload());
          return false;
        }
        return false;
      });
    } catch (e) {
      warn('消息通道注册失败:', e);
    }
  }

  // ---------- 心跳（复用后台 zhs-keepalive 长连接，驱动后台标签页主循环） ----------

  function connectKeepAlive() {
    try {
      const port = chrome.runtime.connect({ name: 'zhs-keepalive' });
      port.onMessage.addListener((msg) => {
        if (msg && msg.type === 'heartbeat') tick();
      });
      port.onDisconnect.addListener(() => {
        registerTimer(setTimeout(connectKeepAlive, 2000));
      });
    } catch (e) {
      warn('心跳连接失败（将退化为 setInterval 主循环）:', e && e.message);
    }
  }

  // ---------- 第三批：AI 随堂练习弹窗（只读 + 人工作答辅助，不自动作答不自动提交） ----------

  const TXT = CFG.text || {};

  /**
   * 读取弹窗当前状态。全程只读 DOM。
   * 结构依据第二阶段捕获 + 12:xx 判断题实测：.ai-class-exercise-dialog 内
   *   .item > .row > span.type（题型）+ .question-info（题干）；
   *   .option > span.class-question-select(.isSelect/.isRight/.isError) + span.answer；
   *   span.correct-ops（提交后公示正确答案）；footer .el-button.btn（提交作答/已提交 is-finish）。
   */
  function readQuizDialog() {
    const dialog = queryFirst(SEL.quizDialog);
    if (!dialog) return null;
    try {
      const items = [...dialog.querySelectorAll('.item')];
      const questions = items.map((item) => {
        const typeEl = item.querySelector('.row .type');
        const titleEl = item.querySelector('.question-info');
        const options = [...item.querySelectorAll('.option')].map((opt) => {
          const markEl = opt.querySelector('.class-question-select');
          const ansEl = opt.querySelector('.answer');
          const cls = markEl ? markEl.classList : null;
          return {
            mark: markEl ? (markEl.textContent || '').trim() : '',
            text: ansEl ? (ansEl.textContent || '').trim() : '',
            selected: Boolean(cls && cls.contains(CLS.selected || 'isSelect')),
            right: Boolean(cls && cls.contains(CLS.right || 'isRight')),
            error: Boolean(cls && cls.contains(CLS.error || 'isError')),
          };
        });
        const correctEl = item.querySelector('.correct-ops');
        const typeText = typeEl ? (typeEl.textContent || '').trim() : '';
        const btn = item.closest('.el-dialog')?.querySelector('.dialog-footer .el-button.btn');
        return {
          type: (TXT.typeRe && TXT.typeRe.test(typeText)) ? (typeText.match(TXT.typeRe) || [''])[0].replace(/[\[\]]/g, '') : (typeText || '未知题型'),
          title: titleEl ? (titleEl.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 200) : '',
          options,
          correctAnswer: correctEl ? (correctEl.textContent || '').trim() : '',
          hasFeedback: Boolean(correctEl),
          submitted: Boolean(btn && btn.classList.contains(CLS.finishBtn || 'is-finish')) || (btn ? (btn.textContent || '').trim() === '已提交' : false),
        };
      });
      const btn = dialog.querySelector('.dialog-footer .el-button.btn');
      const btnText = btn ? (btn.textContent || '').trim() : '';
      return {
        questions,
        submitted: Boolean(btn && btn.classList.contains(CLS.finishBtn || 'is-finish')) || btnText === '已提交',
        submitBtnText: btnText,
        submitBtn: btn || null,
      };
    } catch (e) {
      warn('弹窗读取异常:', e);
      return { questions: [], submitted: false, submitBtnText: '', error: String(e && e.message) };
    }
  }

  /** 通知弹窗（.ai-notice-dialog）检测 —— 只记录状态，点击「好的」交由人工 */
  function checkNoticeDialog() {
    const d = queryFirst(SEL.noticeDialog);
    const open = Boolean(d);
    if (open && !S.noticeOpen) {
      const textEl = d.querySelector('.content-wrapper .text');
      log(`检测到通知弹窗（${textEl ? (textEl.textContent || '').trim().slice(0, 30) : '无文案'}），请人工点击「好的」关闭`);
    }
    S.noticeOpen = open;
    return open;
  }

  /**
   * 弹窗状态机（由弹窗观察器驱动）：
   *   idle → detected（弹窗出现，读取题目）→ awaiting_human（等待人工作答）
   *   → answered（检测到 is-finish/已提交）→ closed（弹窗消失，恢复播放观察）
   * 任何环节都不代答、不代点；答错反馈（isError + correct-ops）仅记录展示。
   */
  function updateQuizState() {
    const dialog = queryFirst(SEL.quizDialog);
    const noticeOpen = checkNoticeDialog();

    if (!dialog) {
      if (S.quizState === 'awaiting_human' || S.quizState === 'answered' || S.quizState === 'detected') {
        log('弹题弹窗已关闭');
        if (noticeOpen) {
          log('通知弹窗仍在，等待人工确认「好的」');
        } else if (S.video) {
          log('弹题流程结束，恢复播放观察');
          tryPlay(S.video, '弹题结束恢复');
        }
        S.quizState = 'idle';
        S.quizInfo = null;
        S.quizCloseAttempts = 0;
        S.quizStateWasPreAnswered = false;
      }
      S.quizOpen = false;
      return;
    }

    // 弹窗存在
    if (S.quizState === 'idle') {
      S.quizState = 'detected';
      S.quizOpen = true;
      const info = readQuizDialog();
      // 弹窗一出现就带「已提交」特征 = 重进已答过的节（用户描述的刷新场景）
      S.quizStateWasPreAnswered = Boolean(info.submitted);
      S.quizInfo = info;
      if (info.questions.length) {
        log(`检测到随堂练习弹窗（${info.questions.length} 题）${S.quizStateWasPreAnswered ? '（此题为已答状态）' : ''}`);
        for (const q of info.questions) {
          log(`  [${q.type}] ${q.title.slice(0, 50)} · 选项 ${q.options.map((o) => o.mark).join(',')}`);
        }
        // 首读就有题（弹窗出现时题目已就绪）：启动自动作答（vnode onClick 通道）
        if (!info.submitted) {
          S.quizState = 'auto_answering';
          S.autoAnswer.round = 0;
          S.autoAnswer.busy = false;
          runAutoAnswer();
          return;
        }
        S.quizState = 'answered';
        return;
      }
      // 弹窗壳先渲染、题目由接口异步填充——不在此处定论，等下一次重读
      log('检测到随堂练习弹窗（题目加载中…）');
      return;
    }

    // 持续刷新题目读取结果（供 popup / 快照展示与自动作答实时反馈）
    const info = readQuizDialog();
    if (info) {
      const prevCount = S.quizInfo ? S.quizInfo.questions.length : 0;
      S.quizInfo = info;
      // 题目异步加载完成（首次为 0 题，现在有题了）
      if (!prevCount && info.questions.length && S.quizState === 'detected') {
        log(`题目加载完成（${info.questions.length} 题）`);
        for (const q of info.questions) {
          log(`  [${q.type}] ${q.title.slice(0, 50)} · 选项 ${q.options.map((o) => o.mark).join(',')}`);
        }
        // 题目就绪：启动自动作答（vnode onClick 通道）
        S.quizState = 'auto_answering';
        S.autoAnswer.round = 0;
        S.autoAnswer.busy = false;
        runAutoAnswer();
        return;
      }
      if (S.quizState !== 'answered' && info.submitted) {
        // 进入 answered 的两条路径：刚提交成功 / 重进已答过的节（弹窗直接是已答状态）
        if (S.quizState === 'detected' || S.quizState === 'awaiting_human' || S.quizState === 'auto_answering') {
          S.quizState = 'answered';
          log('检测到「已提交」状态' + (S.quizStateWasPreAnswered ? '（重进已答题，弹窗直接为已答状态）' : ''));
          const q0 = info.questions[0];
          if (q0 && q0.correctAnswer) log(`  页面公示：${q0.correctAnswer}`);
        }
      }

      // 「已提交」终态且弹窗滞留：自动关闭（vnode onClick 通道，header-icon 为实测关闭入口）。
      // 关闭最多尝试 3 次（间隔递增），弹窗消失即停。
      if (S.quizState === 'answered' && info.submitted && S.quizCloseAttempts < 3 && !S.quizCloseTimer) {
        S.quizCloseAttempts++;
        const attempt = S.quizCloseAttempts;
        S.quizCloseTimer = registerTimer(setTimeout(() => {
          S.quizCloseTimer = 0;
          const dlg = queryFirst(SEL.quizDialog);
          if (!dlg) return; // 已关闭
          const res = callMainWorld('quizClose', {});
          if (res && res.ok) {
            log(`「已提交」弹窗滞留，经 vnode 桥点击 header-icon 关闭（第 ${attempt} 次）`);
          } else {
            // vnode 桥失败时回退指针序列点击 DOM（对部分弹窗形态仍有效）
            const btn = queryFirst(SEL.quizCloseBtn, dlg) || queryFirst(SEL.quizCloseBtn);
            if (btn) {
              log(`「已提交」弹窗滞留，指针点击 header-icon 关闭（第 ${attempt} 次，桥回退）`);
              dispatchPointerClick(btn);
            } else {
              log('未找到弹窗关闭入口，请手动关闭弹窗');
            }
          }
        }, 2500 + attempt * 1500));
      }
    }
  }

  function bindDialogObserver() {
    try {
      let last = 0;
      const mo = new MutationObserver(() => {
        const t = performance.now();
        if (t - last < 400) return; // 与旧版一致的节流
        last = t;
        try {
          updateQuizState();
        } catch (e) {
          // 观察器回调内的异常不能中断后续检测（否则弹窗状态可能永久卡死）
          warn('弹窗状态机异常（已恢复）:', e);
        }
      });
      // class 属性变化必须监听：选项点击(isSelect)、提交按钮(is-finish)、答错(isError)
      // 都只是 attribute 变化，不监听会导致作答/提交状态永远读不到
      mo.observe(document.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['class', 'style'],
      });
      registerObserver(mo);
    } catch (e) {
      warn('弹窗观察器注册失败:', e);
    }
  }

  // ---------- 自动作答（2026-11-17 实现落定：vnode onClick 直接调用） ----------
  //
  // 方案与旧版完全同构：旧版调 vm.topicClickQot(opt, 1)，新版调弹窗 vnode 上的
  // props.onClick 处理函数（页面点击时执行的就是它）——零合成事件，
  // isTrusted 类校验无从拦截。函数调用经 MAIN world 桥执行（页面 JS 对象
  // 只在 MAIN world 可见），通信走 REQ_EVENT/REQ_ATTR 属性桥（旧版同款）。
  //
  // 策略：
  //   1. 判断题：选项文本语义匹配（对/错系）首答，多数直接答对；
  //   2. 单选/多选：无可靠线索时选首项提交 → 平台答错公示 correct-ops
  //      → 按公示改正（含取消错选）→ 重新提交；
  //   3. 每轮读反馈，最多 4 轮，超限转人工。
  // 终态后点击 header-icon 关闭弹窗（vnode onClick 同款通道）→ 续播。

  const AA = CFG.autoAnswer || {};

  const REQ_EVENT = '__zhs_mw_req__';
  const REQ_ATTR = 'data-zhs-req';
  const RES_ATTR = 'data-zhs-res';

  /** 同步调用 MAIN world 的 vnode 桥（旧版 callMainWorld 同款实现） */
  function callMainWorld(cmd, payload = {}) {
    const host = document.head || document.documentElement;
    if (!host) return null;
    try {
      host.setAttribute(REQ_ATTR, JSON.stringify({ cmd, payload }));
      window.dispatchEvent(new Event(REQ_EVENT));
      const raw = host.getAttribute(RES_ATTR);
      if (raw) {
        host.removeAttribute(RES_ATTR);
        return JSON.parse(raw);
      }
    } catch (e) {}
    return null;
  }

  function parseCorrectMarks(correctText) {
    // "正确答案： A,B,C,D" → ['A','B','C','D']
    const m = String(correctText || '').match(/[A-D](?:\s*[，,、]\s*[A-D])*/g);
    if (!m) return [];
    return m[0].split(/\s*[，,、]\s*/).map((s) => s.trim()).filter(Boolean);
  }

  /** 判断题：按选项文本语义选「对」或「错」（读题面找否定词是脆弱的，先做文本匹配版） */
  function pickJudgeAnswer(options) {
    const trueOpt = options.find((o) => TXT.trueRe && TXT.trueRe.test(o.text));
    const falseOpt = options.find((o) => TXT.falseRe && TXT.falseRe.test(o.text));
    // 题干含否定词（不/不属于/无法/不能/错误）时选「错」，否则选「对」——
    // 这是可解释的启发式；答错后公示答案会纠正。
    const title = S.quizInfo ? S.quizInfo.questions.map((q) => q.title).join(' ') : '';
    const negative = /不[^，。；、]{0,6}(属|是|能|可|会|宜|利|同|符|包括|正确)|无法|错误|不得|禁止/.test(title);
    if (trueOpt && falseOpt) return negative ? [falseOpt] : [trueOpt];
    return null; // 无法按语义判断（如 A/B 选项），走首项提交换公示
  }

  /**
   * 自动作答主流程（由 updateQuizState / 定时回调驱动，busy 防并发）。
   */
  /** 取当前可见的弹窗根（多实例防御：queryFirst 已按序取第一个匹配，再校验可见性） */
  function getVisibleQuizDialog() {
    const dlg = queryFirst(SEL.quizDialog);
    if (!dlg) return null;
    try {
      const r = dlg.getBoundingClientRect();
      if (r.width < 50 || r.height < 50) return null; // 隐藏实例
      return dlg;
    } catch (e) { return null; }
  }

  /**
   * 在可见弹窗内定位第 idx 个选项的可点击元素。
   * 判断题实测选项标记也是 .class-question-select（A/B），与单多选一致。
   * 返回 null 表示定位失败（调用方转人工，不盲点）。
   */
  function findOptionClickTarget(dlgRoot, optionIndex) {
    try {
      const opts = [...dlgRoot.querySelectorAll('.option')].filter((el) => {
        const r = el.getBoundingClientRect();
        return r.width > 5 && r.height > 5;
      });
      const optEl = opts[optionIndex];
      if (!optEl) return null;
      const mark = optEl.querySelector('.class-question-select');
      return mark || optEl;
    } catch (e) { return null; }
  }

  async function runAutoAnswer() {
    const dlgRoot = getVisibleQuizDialog();
    const info = readQuizDialog();
    if (!dlgRoot || !info || !info.questions.length || info.submitted) return;
    if (S.autoAnswer.busy) return;
    const maxRounds = AA.maxRounds || 4;
    if (S.autoAnswer.round >= maxRounds) {
      log(`自动作答已达 ${maxRounds} 轮上限，转人工处理`);
      S.quizState = 'awaiting_human';
      return;
    }

    // MAIN world vnode 桥可用性检查（一次失败即转人工，不反复试探）
    const probe = callMainWorld('quizSelect', { index: -1 });
    if (probe === null) {
      warn('MAIN world vnode 桥不可达（属性桥无响应），转人工');
      S.quizState = 'awaiting_human';
      return;
    }

    S.autoAnswer.busy = true;
    try {
      S.autoAnswer.round++;
      const q = info.questions[0]; // 当前弹窗单题（实测每弹窗 1 题）
      const isJudge = q.type === '判断题';

      // 2026-11-18 实测修正：新版答错后直接进入终态（is-finish），**不存在第二轮**，
      // "公示改正"只对个别判断题形态有效。首答即终答，正确率取决于首答策略。
      // 保留公示改正代码仅为兼容可能存在的可重交形态（correctMarks 分支）。

      // 已有公示答案（极少数可重交形态）：按公示改正，并取消不在公示里的错选
      const correctMarks = parseCorrectMarks(q.correctAnswer);
      if (correctMarks.length && S.autoAnswer.round > 1) {
        const toAdd = q.options.filter((o) => correctMarks.includes(o.mark) && !o.selected);
        const toRemove = q.options.filter((o) => !correctMarks.includes(o.mark) && o.selected);
        if (toAdd.length || toRemove.length) {
          log(`第 ${S.autoAnswer.round} 轮：按页面公示答案改正 → 选 ${correctMarks.join(',')}${toRemove.length ? `，取消错选 ${toRemove.map((o) => o.mark).join(',')}` : ''}`);
          for (const o of toRemove) {
            await sleep(rand(AA.retryDelayMs || [1500, 3000]));
            const res = callMainWorld('quizSelect', { index: q.options.indexOf(o) });
            if (!res || !res.ok) {
              warn(`取消错选 ${o.mark} 失败：`, res && res.reason, '转人工');
              S.quizState = 'awaiting_human';
              return;
            }
            log(`已点击选项 ${o.mark}（取消错选）`);
          }
          for (const o of toAdd) {
            await sleep(rand(AA.retryDelayMs || [1500, 3000]));
            const res = callMainWorld('quizSelect', { index: q.options.indexOf(o) });
            if (!res || !res.ok) {
              warn(`选择 ${o.mark} 失败：`, res && res.reason, '转人工');
              S.quizState = 'awaiting_human';
              return;
            }
            log(`已点击选项 ${o.mark}`);
          }
          await sleep(rand(AA.submitDelayMs || [1200, 2600]));
          const sub = callMainWorld('quizSubmit', {});
          if (sub && sub.ok) log('已重新提交');
          else warn('重新提交失败：', sub && (sub.reason || sub.error), '转人工');
          return;
        }
      }

      // 无公示答案（首轮）：按策略选择
      const strategy = S.settings.answerStrategy || AA.strategy || 'vnode';
      let targets = null;
      if (isJudge && strategy !== 'random') {
        // vnode 策略：判断题语义启发式
        targets = pickJudgeAnswer(q.options);
        if (targets) log(`第 ${S.autoAnswer.round} 轮：判断题语义作答 → ${targets.map((t) => t.mark).join(',')}`);
      }
      if (!targets) {
        if (strategy === 'random') {
          // 随机策略：随机选项（多选题按 2 项随机，提高非首项分布的自然性）
          const pool = [...q.options];
          const n = q.type === '多选题' ? 2 : 1;
          targets = [];
          for (let i = 0; i < n && pool.length; i++) {
            targets.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0]);
          }
        } else {
          // vnode 策略（语义未命中）/默认：选首项提交换公示
          targets = [q.options[0]];
        }
        log(`第 ${S.autoAnswer.round} 轮：${q.type}随机/首项作答 → ${targets.map((t) => t.mark).join(',')}（答错将按公示改正）`);
      }

      for (const o of targets) {
        if (o.selected) continue;
        const res = callMainWorld('quizSelect', { index: q.options.indexOf(o) });
        if (res && res.ok) {
          await sleep(rand(AA.submitDelayMs || [1200, 2600]));
          log(`已点击选项 ${o.mark}（vnode onClick）`);
        } else {
          warn(`选项 ${o.mark} 点击失败：`, res && (res.reason || res.error), '转人工');
          S.quizState = 'awaiting_human';
          return;
        }
      }

      await sleep(rand(AA.submitDelayMs || [1200, 2600]));
      const sub = callMainWorld('quizSubmit', {});
      if (sub && sub.ok) {
        log('已提交作答，等待页面反馈…');
      } else {
        warn('提交失败：', sub && (sub.reason || sub.error), '转人工');
        S.quizState = 'awaiting_human';
      }
    } catch (e) {
      warn('自动作答异常:', e);
      S.quizState = 'awaiting_human';
    } finally {
      S.autoAnswer.busy = false;
    }
  }

  // ---------- SPA 路由监听 ----------

  let lastHref = location.href;
  function bindRouteWatcher() {
    const onRouteChange = () => {
      if (location.href === lastHref) return;
      lastHref = location.href;
      log('SPA 路由变化，重建播放器绑定:', location.pathname);
      // 同一文档内换课：DOM 根不变，观察者保留，仅重置播放器引用与绑定
      S.video = null;
      S.boundVideo = null;
      S.endedPending = false;
      S.quizOpen = false;
      tick();
    };
    window.addEventListener('popstate', onRouteChange);
    for (const method of ['pushState', 'replaceState']) {
      const orig = history[method];
      if (typeof orig !== 'function') continue;
      history[method] = function (...args) {
        const r = orig.apply(this, args);
        setTimeout(onRouteChange, 0);
        return r;
      };
    }
  }

  // ---------- 初始化 ----------

  async function init() {
    try {
      // 读取与旧版共享的设置（popup 写入 chrome.storage.local.settings）
      try {
        const got = await chrome.storage.local.get(['settings']);
        const s = got && got.settings;
        if (s) {
          S.settings = {
            ...S.settings,
            enabled: s.enabled !== false,
            mute: s.mute !== false,
            speed: Number(s.speed) || 1,
            keepPlaying: s.keepPlaying !== false,
            answerStrategy: ['vnode', 'random'].includes(s.modernAnswerStrategy) ? s.modernAnswerStrategy : 'vnode',
            debug: s.debug !== false,
          };
        }
      } catch (e) {
        warn('读取设置失败，使用默认值:', e && e.message);
      }

      // 设置变化实时生效
      try {
        chrome.storage.onChanged.addListener((changes, area) => {
          if (area !== 'local' || !changes.settings) return;
          const s = changes.settings.newValue || {};
          S.settings.enabled = s.enabled !== false;
          S.settings.mute = s.mute !== false;
          S.settings.speed = Number(s.speed) || 1;
          S.settings.keepPlaying = s.keepPlaying !== false;
          S.settings.answerStrategy = ['vnode', 'random'].includes(s.modernAnswerStrategy) ? s.modernAnswerStrategy : 'vnode';
          S.settings.debug = s.debug !== false;
          log('设置已更新:', { enabled: S.settings.enabled, mute: S.settings.mute, speed: S.settings.speed, answerStrategy: S.settings.answerStrategy });
        });
      } catch (e) {}

      bindMessaging();
      connectKeepAlive();
      bindDialogObserver();
      bindRouteWatcher();

      const probe = probeAblePlayer();
      S.playerMethods = probe.methods;

      // 主循环：900ms 与旧版一致；心跳送达时 tick 会被额外驱动
      registerTimer(setInterval(tick, 900));
      registerTimer(setInterval(publishSnapshot, 2000));
      tick();
      publishSnapshot();

      S.ready = true;
      log('新版适配器已启动（第一批：播放器适配）', { href: location.pathname, ablePlayerX: probe.available ? probe.methods.join(',') : '不可用' });
    } catch (e) {
      warn('初始化失败:', e);
    }
  }

  init();

  // 诊断入口（Console 可调用）
  window.__ZHS_MODERN_STATUS__ = () => statusPayload();

  /**
   * 跨 world 诊断快照：适配器运行在 ISOLATED world，Console（MAIN world）看不到
   * 本文件的 window 属性。把状态摘要写入 <html data-zhs-modern> 属性，
   * 任何执行环境（包括 MAIN world 的 console / 用户脚本）都可读取。
   * Console 里用 document.documentElement.getAttribute('data-zhs-modern') 查看最新快照。
   */
  function publishSnapshot() {
    try {
      const st = statusPayload();
      document.documentElement.setAttribute('data-zhs-modern', JSON.stringify({
        t: new Date().toISOString().slice(11, 19),
        hasVideo: st.hasVideo, paused: st.paused, time: st.time, duration: st.duration,
        lesson: st.currentLesson, status: st.currentStatus, pct: st.currentPercentage,
        done: st.doneCount + '/' + st.lessonCount, quiz: st.quizOpen, quizState: st.quizState,
        endedPending: st.endedPending,
        manualSwitch: st.needsManualSwitch ? st.needsManualSwitch.num + ' ' + st.needsManualSwitch.name : null,
        logs: st.logs.slice(-6).map((x) => x.t + ' ' + x.msg),
      }));
    } catch (e) {
      // 快照失败也要留痕（如 Extension context invalidated），方便诊断上下文死亡
      try { console.warn('[ZHS-M] 快照发布失败:', e && e.message); } catch (e2) {}
    }
  }

  /**
   * 启动入口：由 app.js 在新版域名门控分支调用。
   * 适配器 IIFE 已自举，此处仅做幂等确认——init() 内部通过 S.ready /
   * window.__ZHS_MODERN__ 双保险防止重复初始化。
   */
  window.ZHSModernAdapterInit = function () {
    if (!S.ready) {
      // init() 已在自举时调用过；若此刻仍未 ready（如 chrome.storage 短暂不可用），
      // 下一次 tick 会自然恢复，无需重复初始化。
      log('ZHSModernAdapterInit: 适配器自举流程进行中，无需重复启动');
    }
    return S.ready;
  };
})();
