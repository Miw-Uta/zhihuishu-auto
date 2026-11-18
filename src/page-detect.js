/**
 * 页面识别脚本（第一阶段，v0.6.0）。
 *
 * 职责（仅此而已）：
 *  1. 判断当前页面属于旧版（studyvideoh5.zhihuishu.com）还是新版（wisdom-mooc.zhihuishu.com）；
 *  2. 新版页面在 Console 输出识别结果（hostname / pathname / recruitAndCourseId）；
 *  3. 顺带输出 iframe 与 SPA 路由的初步诊断信息，供第二阶段采集。
 *
 * 它不触碰播放器、答题、课程切换 —— 那些仍由 app.js（旧版）/ 未来的新版适配模块负责。
 */
(() => {
  'use strict';
  if (window.__ZHS_PAGE_DETECT__) return;
  window.__ZHS_PAGE_DETECT__ = true;

  const TAG = '[ZhihuishuAuto]';
  const TAG_STYLE = 'color:#1c7ed6;font-weight:700';

  const KNOWN_HOSTS = {
    legacy: 'studyvideoh5.zhihuishu.com',
    modern: 'wisdom-mooc.zhihuishu.com',
  };

  /** 当前页面版本：'legacy' | 'modern' | 'unknown' */
  function detectPageVersion(hostname) {
    const host = String(hostname || location.hostname).toLowerCase();
    if (host === KNOWN_HOSTS.modern || host.endsWith('.wisdom-mooc.zhihuishu.com')) return 'modern';
    if (host === KNOWN_HOSTS.legacy || host.endsWith('.studyvideoh5.zhihuishu.com')) return 'legacy';
    return 'unknown';
  }

  /** 从 URL 查询串或 hash 查询串中取参数（SPA 常把参数挂在 hash 后） */
  function getUrlParam(name) {
    try {
      const v = new URLSearchParams(location.search).get(name);
      if (v) return v;
      const qIdx = location.hash.indexOf('?');
      if (qIdx >= 0) {
        return new URLSearchParams(location.hash.slice(qIdx + 1)).get(name);
      }
    } catch (e) {}
    return null;
  }

  function inspectIframes() {
    const frames = [...document.querySelectorAll('iframe')];
    return frames.map((f, i) => ({
      index: i,
      src: (f.src || '').slice(0, 120),
      id: f.id || '',
      className: String(f.className || '').slice(0, 60),
    }));
  }

  function report(reason) {
    const info = {
      version: detectPageVersion(),
      hostname: location.hostname,
      pathname: location.pathname,
      recruitAndCourseId: getUrlParam('recruitAndCourseId'),
      href: location.href,
      iframes: inspectIframes(),
      topFrame: window.top === window,
    };
    console.groupCollapsed(
      `%c${TAG} New page detected`,
      TAG_STYLE
    );
    console.log('版本:', info.version, `(${reason})`);
    console.log('hostname:', info.hostname);
    console.log('pathname:', info.pathname);
    console.log('recruitAndCourseId:', info.recruitAndCourseId);
    console.log('完整 URL:', info.href);
    console.log('是否顶层窗口:', info.topFrame);
    if (info.iframes.length) {
      console.log(`页面包含 ${info.iframes.length} 个 iframe（若播放器在其中，后续阶段需要 all_frames）:`, info.iframes);
    } else {
      console.log('页面无 iframe');
    }
    console.log('现有旧版逻辑在此页面状态:', window.__ZHS_APP__ === true ? 'app.js 已启动（异常，应仅限旧版）' : 'app.js 未启动（第一阶段预期）');
    console.groupEnd();
    return info;
  }

  // ---- SPA 路由监听：地址变化后重新输出识别信息 ----
  let lastHref = location.href;
  function onRouteChange() {
    if (location.href === lastHref) return;
    lastHref = location.href;
    report('SPA 路由变化');
  }
  try {
    window.addEventListener('popstate', onRouteChange);
    // SPA 改写 pushState/replaceState 后不会触发 popstate，这里包一层
    for (const method of ['pushState', 'replaceState']) {
      const orig = history[method];
      if (typeof orig !== 'function') continue;
      history[method] = function (...args) {
        const r = orig.apply(this, args);
        setTimeout(onRouteChange, 0);
        return r;
      };
    }
  } catch (e) {}

  // ---- 入口 ----
  if (detectPageVersion() === 'modern') {
    report('脚本注入');
  } else if (detectPageVersion() === 'unknown' && window.top === window) {
    // 注入了但不认识的子域：提示一句，便于发现新域名变体
    console.warn(`${TAG} 未识别的智慧树子域: ${location.hostname}`);
  }

  // 定义为不可配置/不可写，防止页面反调试脚本清理未知全局变量
  try {
    Object.defineProperty(window, '__ZHS_PAGE_INFO__', {
      configurable: false,
      writable: false,
      value: () => ({
        version: detectPageVersion(),
        hostname: location.hostname,
        pathname: location.pathname,
        recruitAndCourseId: getUrlParam('recruitAndCourseId'),
      }),
    });
  } catch (e) {}
})();
