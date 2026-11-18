(() => {
  const r = { scanned: 0, dialogComps: [], apps: [] };
  const dialogEl = document.querySelector('.ai-class-exercise-dialog');
  if (!dialogEl) return '弹窗不在屏幕上，等弹题出现再跑';

  const seen = new WeakSet();
  const collect = (comp) => {
    const fns = [];
    for (const src of [comp.setupState, comp.ctx, comp.proxy]) {
      try {
        for (const k of Object.keys(src || {})) {
          try { if (typeof src[k] === 'function') fns.push(k); } catch (e) {}
        }
      } catch (e) {}
    }
    return [...new Set(fns)].slice(0, 60);
  };

  const visitComp = (comp, depth, path) => {
    if (!comp || depth > 35 || r.scanned > 6000 || seen.has(comp)) return;
    seen.add(comp);
    r.scanned++;
    try {
      const el = comp.subTree?.el;
      const owns = el && (el === dialogEl || (el.contains && (el.contains(dialogEl) || dialogEl.contains(el))));
      if (owns) {
        r.dialogComps.push({
          path,
          name: comp.type?.__name || comp.type?.name || '(anon)',
          fns: collect(comp),
        });
      }
      if (comp.subTree) walkVnode(comp.subTree, depth + 1, path + '>');
    } catch (e) {}
  };

  const walkVnode = (v, depth, path) => {
    if (!v || r.scanned > 6000 || depth > 45) return;
    if (seen.has(v)) return;
    seen.add(v);
    try {
      // vnode 自身 el 命中弹窗（无 component 的普通 vnode 也记一条路径线索）
      const el = v.el;
      if (el && (el === dialogEl || (el.contains && el.contains(dialogEl))) && !r.dialogComps.length) {
        r.teleportHint = { at: path, tag: v.type?.toString?.().slice(0, 30) || String(v.type).slice(0, 30) };
      }
      if (v.component) visitComp(v.component, depth, path + '/c');
      // Teleport / Fragment / children 展开
      const ch = v.children;
      if (Array.isArray(ch)) for (const c of ch) walkVnode(c, depth + 1, path);
      else if (ch && typeof ch === 'object' && !ch.component) {
        for (const k of Object.keys(ch)) {
          const s = ch[k];
          try { if (typeof s === 'function') walkVnode(s(), depth + 1, path + ':' + k); else walkVnode(s, depth + 1, path + ':' + k); } catch (e) {}
        }
      }
      if (v.dynamicChildren) for (const c of v.dynamicChildren) walkVnode(c, depth + 1, path + '~');
      if (v.suspense?.activeBranch) walkVnode(v.suspense.activeBranch, depth + 1, path + '!');
    } catch (e) {}
  };

  // 两个 app 的容器都扫（弹窗可能挂任一），__vnode 直接在容器元素上
  for (const sel of ['#current-node-box', '#app']) {
    const host = document.querySelector(sel);
    const v = host && host._vnode;
    if (v) {
      r.apps.push(sel);
      walkVnode(v, 0, sel);
    }
  }
  // 兜底：body 直下的 teleport 容器（Element Plus 弹窗的 comment 锚点旁）
  if (!r.dialogComps.length) {
    const anchor = dialogEl.parentElement;
    r.anchorInfo = anchor ? anchor.tagName + '.' + String(anchor.className).slice(0, 40) : null;
  }
  return r;
})();
