/* drawer.js —— §6 情景抽屉模块（L0→L1 基础层 + L1→L2 下钻）
 *
 * 设计纪律（DESIGN.md §6）：
 *   - L0 列表 → L1 抽屉：从列表条目点开，滑入面板展示详情
 *   - L1 抽屉 → L2 下钻：Drawer.push 在同屏面板内叠加一层，栈式导航
 *   - 左栏条目从左滑出、右栏从右滑出（CSS 预留 .from-left，本轮只做右栏）
 *   - 同屏仅一个抽屉；Esc / 遮罩 / × 均可关闭
 *   - 打开时 focus 移入抽屉并 Tab 锁循环；关闭后焦点还原创发条目
 *   - URL hash 同步（#drawer=type:id 或 #drawer=type:id>subType:subId），刷新可还原
 *   - 导航栈最大深度 MAX_DEPTH=3（防止无限下钻）
 *   - <1400px 改底部全屏上滑（CSS 预留，本轮暂不实现）
 *
 * 约束：
 *   - 零外部库、零写死 hex、全走 CSS 变量
 *   - 不新建 canvas / rAF 链（抽屉是 DOM 元素，slide-in 用 CSS transform + transition）
 *   - 320ms cubic-bezier(.22,1,.36,1)，符合 §4 L3 150-300ms 窗口
 *   - Esc 关闭整个抽屉（不逐层 pop）；只有 ← 返回 按钮走 pop()
 *
 * 复用点：
 *   - 现有 drawer 模式：#ops（ui/index.html:542）/ #tbmenuPanel（:118）的 click-outside / Esc / toggle 关闭纪律
 *   - 焦点锁：标准 focus trap（遍历抽屉内 focusable 元素构建循环列表）
 *   - URL hash：history.replaceState（不产生历史记录，避免浏览器后退按钮混乱）
 */
(function(){
  'use strict';

  /* ═══ 状态 ═══ */
  let _open = false;
  /* stack: [{type, id, title, side, render, sourceEl, data}]
   *   - stack[0] 永远是 L1（Drawer.open 建立）
   *   - push 追加到栈尾；pop 从栈尾弹出
   *   - 关闭抽屉时整体清空
   */
  let _stack = [];
  let MAX_DEPTH = 3;
  let _fetchers = {};     // { type: { fetcher(id)→Promise<data>, render(data)→HTML, title? } }
  let _prevFocus = null;  // 打开前的 activeElement（用于 close 后还焦兜底）
  let _onKeydown = null;  // keydown 监听器引用（便于 removeEventListener）
  let _init = false;

  /* ═══ DOM 引用 ═══ */
  let _panel, _backdrop, _headerEl, _titleEl, _bodyEl, _closeBtn, _backBtn;

  /* ═══ 初始化 ═══ */
  function init(){
    if(_init) return;
    _init = true;

    _panel = document.getElementById('drawerPanel');
    _backdrop = document.getElementById('drawerBackdrop');
    _headerEl = document.getElementById('drawerHeader');
    _titleEl = document.getElementById('drawerTitle');
    _bodyEl = document.getElementById('drawerBody');
    _closeBtn = document.getElementById('drawerClose');
    if(!_panel || !_backdrop) return;

    // × 按钮关闭
    if(_closeBtn){
      _closeBtn.addEventListener('click', function(){ close(); });
    }
    // 遮罩点击关闭（点面板本身不关）
    _backdrop.addEventListener('click', function(){ close(); });

    // 抽屉内容内事件委托：
    //   - .drw-ask + data-code   → 问 AI：填对话框 + 关闭抽屉
    //   - .drw-ask + data-sector → L2 下钻 sectorDetail
    //   - .drw-ask + data-stock  → L3 下钻 stockDetail
    if(_bodyEl){
      _bodyEl.addEventListener('click', function(e){
        var btn = e.target.closest && e.target.closest('.drw-ask');
        if(!btn) return;
        var sector = btn.getAttribute('data-sector');
        var stock = btn.getAttribute('data-stock');
        if(sector && typeof window.Drawer !== 'undefined'){
          // L2 下钻：sectorDetail（stack 深度限制由 Drawer.push 把关）
          if(window.Drawer.push('sectorDetail', sector, { sourceEl: btn, side: 'right', title: '板块详情：' + sector })){
            return;
          }
        }
        if(stock && typeof window.Drawer !== 'undefined'){
          if(window.Drawer.push('stockDetail', stock, { sourceEl: btn, side: 'right', title: '个股详情 ' + stock })){
            return;
          }
        }
        var code = btn.getAttribute('data-code') || '';
        var name = btn.getAttribute('data-name') || '';
        var inp = document.getElementById('inp');
        if(inp && code){
          inp.value = name + '(' + code + ') 现在怎么样';
          inp.focus();
          if(typeof inp.dispatchEvent === 'function'){
            inp.dispatchEvent(new Event('input', { bubbles: true }));
          }
        }
        close();
      });
    }

    // ← 返回 按钮（L2 下钻可见）：动态创建，样式与 #drawerClose 一致
    if(_headerEl){
      _backBtn = document.createElement('button');
      _backBtn.className = 'drw-back';
      _backBtn.type = 'button';
      _backBtn.textContent = '← 返回';
      _backBtn.setAttribute('aria-label', '返回上一层');
      _backBtn.setAttribute('title', '返回上一层');
      _backBtn.style.display = 'none';
      _backBtn.addEventListener('click', function(){ pop(); });
      // 插到 header 最前面（在 #drawerTitle 之前）
      _headerEl.appendChild(_backBtn);
    }

    // 页面加载时读 hash 自动开（fetcher 已在外部 IIFE 注册）
    restoreFromHash();
  }

  /* ═══ 公共 API ═══ */

  /**
   * 打开抽屉（L1）。若抽屉已开则先静默关闭再重建栈。
   * @param {string} type - 条目类型（'leader' / 'sectorDetail' / ...）
   * @param {string} id   - 条目 ID（leader code / sector name / ...）
   * @param {object} opts - 配置
   * @param {Element} [opts.sourceEl] - 触发元素（关闭后还焦）
   * @param {string} [opts.side] - 'right'（默认）或 'left'
   * @param {string} [opts.title] - 抽屉标题（覆盖注册时的默认标题）
   * @param {function} [opts.render] - 渲染函数（覆盖注册时的默认渲染）
   * @param {object} [opts.data] - 预加载数据（跳过 fetcher）
   */
  function open(type, id, opts){
    if(!_panel || !_backdrop) return;
    opts = opts || {};

    // 同屏仅一个抽屉：已开则先静默关闭并清栈
    if(_open) close(true);

    var cfg = _fetchers[type] || {};
    var render = opts.render || cfg.render;
    var fetcher = cfg.fetcher;
    var title = opts.title || cfg.title || type;

    var entry = {
      type: type,
      id: id,
      side: opts.side || 'right',
      title: title,
      render: render,
      mount: opts.mount || cfg.mount || null,
      sourceEl: opts.sourceEl || null,
      data: opts.data || null,
      fetcher: fetcher || null,
    };
    _stack = [entry];
    _prevFocus = opts.sourceEl || document.activeElement;

    _renderBody(entry);
    _openDrawer(entry);
    _writeHash();
  }

  /**
   * 下钻到 L2。在同屏抽屉内叠加一层，保留当前 L1 状态。
   * 导航栈最大深度 MAX_DEPTH=3；已满时拒绝。
   *
   * @param {string} type - 目标类型（已 register）
   * @param {string} id   - 目标 ID
   * @param {object} opts - 同 open() 的 opts
   * @returns {boolean} 是否成功下钻
   */
  function push(type, id, opts){
    if(!_open) return false;
    opts = opts || {};
    if(_stack.length >= MAX_DEPTH) return false;  // 深度上限

    var cfg = _fetchers[type] || {};
    var entry = {
      type: type,
      id: id,
      side: opts.side || 'right',
      title: opts.title || cfg.title || type,
      render: opts.render || cfg.render,
      mount: opts.mount || cfg.mount || null,
      sourceEl: opts.sourceEl || null,
      data: opts.data || null,
      fetcher: cfg.fetcher || null,
    };
    _stack.push(entry);
    _prevFocus = opts.sourceEl || document.activeElement;

    _renderBody(entry);
    _updateBackBtn();
    _moveFocusInto();
    _writeHash();
    return true;
  }

  /**
   * 返回上一层（L2 → L1）。栈为空或只剩 L1 时返回 false。
   * @returns {boolean} 是否成功回退
   */
  function pop(){
    if(!_open) return false;
    if(_stack.length <= 1) return false;  // L1 无上一层

    _stack.pop();
    var prev = _stack[_stack.length - 1];

    if(_titleEl) _titleEl.textContent = prev.title;
    // 面板方向：pop 时不切换侧，与 L1 保持一致
    _renderBody(prev);
    _updateBackBtn();
    _moveFocusInto();
    _writeHash();
    return true;
  }

  /**
   * 关闭抽屉（Esc / 遮罩 / ×）。
   * 会清空整个导航栈，hash 也清空。
   * @param {boolean} [silent] - 静默关闭（不写 hash），用于 open() 前清理
   */
  function close(silent){
    if(!_open) return;

    _open = false;
    _panel.classList.remove('open');
    _panel.setAttribute('aria-hidden', 'true');
    _backdrop.classList.remove('open');
    document.body.classList.remove('drawer-open');

    // 清空 hash
    if(!silent){
      try {
        history.replaceState(null, '', location.pathname + location.search);
      } catch(e){}
    }

    // 移除 keydown 监听
    if(_onKeydown){
      document.removeEventListener('keydown', _onKeydown, true);
      _onKeydown = null;
    }

    // 还焦：优先 L1 的 sourceEl（用户点开的原始触发点），否则 _prevFocus
    var target = (_stack[0] && _stack[0].sourceEl) || _prevFocus;
    if(target && typeof target.focus === 'function'){
      setTimeout(function(){ target.focus(); }, 80);
    }

    _stack = [];
    _prevFocus = null;
  }

  /**
   * 抽屉是否打开。
   * @returns {boolean}
   */
  function isOpen(){
    return _open;
  }

  /**
   * 注册条目类型的数据获取器 + 渲染器。
   * @param {string} type - 条目类型
   * @param {object} cfg - { fetcher(id)→Promise<data>, render(data)→HTML, title?,
   *                         mount?(bodyEl, data)→void 渲染注入后钩子（canvas 初始化等） }
   */
  function register(type, cfg){
    _fetchers[type] = cfg;
  }

  /* ═══ 内部：栈 / 焦点 / Hash / 渲染 ═══ */

  /** 渲染栈顶条目到 #drawerBody，并更新标题 */
  function _renderBody(entry){
    if(_titleEl) _titleEl.textContent = entry.title;
    var body = entry.data;

    if(!body && entry.fetcher){
      if(_bodyEl) _bodyEl.innerHTML = '<div class="drw-loading">加载中…</div>';
      entry.fetcher(entry.id).then(function(data){
        // 只接受当前栈顶；期间已切换或已关闭则丢弃
        if(!_open || _stack.length === 0 || _stack[_stack.length-1] !== entry) return;
        entry.data = data;  // 缓存到栈，pop 回来不重抓
        if(_bodyEl && entry.render){
          _bodyEl.innerHTML = entry.render(data);
          if(entry.mount) entry.mount(_bodyEl, data);
        }
      }).catch(function(){
        if(!_open || _stack.length === 0 || _stack[_stack.length-1] !== entry) return;
        if(_bodyEl) _bodyEl.innerHTML = '<div class="drw-error">数据暂不可用</div>';
      });
      return;
    }

    if(entry.render){
      if(_bodyEl){
        _bodyEl.innerHTML = entry.render(body || {});
        if(entry.mount) entry.mount(_bodyEl, body || {});
      }
    } else {
      if(_bodyEl) _bodyEl.innerHTML = '<div class="drw-error">未注册渲染器</div>';
    }
  }

  /** 打开面板（L1 首次调用；不做 slide-in 重放） */
  function _openDrawer(entry){
    _panel.classList.remove('from-left', 'from-right');
    if(entry.side === 'left'){
      _panel.classList.add('from-left');
    } else {
      _panel.classList.add('from-right');
    }

    _panel.classList.add('open');
    _panel.setAttribute('aria-hidden', 'false');
    _backdrop.classList.add('open');
    document.body.classList.add('drawer-open');
    _open = true;

    _onKeydown = handleKeydown;
    document.addEventListener('keydown', _onKeydown, true); // 捕获阶段拦截 Esc

    _updateBackBtn();
    _moveFocusInto();
  }

  /** ← 返回 按钮的可见性：仅当栈深 > 1 时显示 */
  function _updateBackBtn(){
    if(!_backBtn) return;
    if(_stack.length > 1){
      _backBtn.style.display = '';
      _backBtn.removeAttribute('hidden');
    } else {
      _backBtn.style.display = 'none';
      _backBtn.setAttribute('hidden', 'hidden');
    }
  }

  /** 焦点移入抽屉（等 slide-in 动画启动后） */
  function _moveFocusInto(){
    setTimeout(function(){
      if(!_open) return;
      var focusable = getFocusable();
      var first = focusable[0];
      if(first) first.focus();
      else if(_panel) _panel.focus(); // 面板自身 tabindex="-1" 兜底
    }, 80);
  }

  /** 栈 → hash 字符串。L1 单层返回 null（走 close 的清理路径）。 */
  function _serializeHash(){
    return '#drawer=' + _stack.map(function(e){
      var t = encodeURIComponent(e.type);
      var i = encodeURIComponent(String(e.id));
      return t + ':' + i;
    }).join('>');
  }

  function _writeHash(){
    try {
      history.replaceState(null, '', _serializeHash());
    } catch(e){}
  }

  /** hash → 栈（还原时逐级 push，栈深 ≤ MAX_DEPTH） */
  function _deserializeHash(hash){
    var m = hash.match(/^#drawer=(.+)$/);
    if(!m) return [];
    return m[1].split('>').map(function(seg){
      var i = seg.indexOf(':');
      if(i < 0) return null;
      var t, id;
      try {
        t = decodeURIComponent(seg.slice(0, i));
        id = decodeURIComponent(seg.slice(i+1));
      } catch(e){ return null; }
      return { type: t, id: id };
    }).filter(Boolean);
  }

  /* ═══ 内部：Hash 还原 ═══ */
  function restoreFromHash(){
    var hash = location.hash || '';
    var stack = _deserializeHash(hash);
    if(!stack.length) return;
    if(stack.length > MAX_DEPTH) stack = stack.slice(0, MAX_DEPTH);

    var first = stack[0];
    var cfg = _fetchers[first.type];
    if(!cfg){
      console.warn('[drawer] hash #' + hash + ' 但 ' + first.type + ' 未注册，跳过');
      return;
    }
    // 还原时 side 未知，默认 right
    open(first.type, first.id, { side: 'right', title: cfg.title || first.type });
    for(var i = 1; i < stack.length; i++){
      var seg = stack[i];
      var c = _fetchers[seg.type];
      if(!c){
        console.warn('[drawer] hash 段 ' + seg.type + ' 未注册，跳过');
        continue;
      }
      push(seg.type, seg.id, { side: 'right', title: c.title || seg.type });
    }
  }

  /* ═══ 内部：焦点锁 ═══ */
  function getFocusable(){
    if(!_panel) return [];
    return Array.prototype.slice.call(_panel.querySelectorAll(
      'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), ' +
      'textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
    ));
  }

  function handleKeydown(e){
    if(e.key === 'Escape'){
      // 关闭整个抽屉，不逐层 pop
      e.preventDefault();
      e.stopPropagation();
      close();
      return;
    }
    if(e.key === 'Tab'){
      var focusable = getFocusable();
      if(!focusable.length) return;
      var first = focusable[0];
      var last = focusable[focusable.length - 1];
      var active = document.activeElement;

      if(e.shiftKey){
        // Shift+Tab：在首个元素或抽屉外时跳到末尾
        if(active === first || !_panel.contains(active)){
          e.preventDefault();
          last.focus();
        }
      } else {
        // Tab：在末个元素或抽屉外时跳到开头
        if(active === last || !_panel.contains(active)){
          e.preventDefault();
          first.focus();
        }
      }
    }
  }

  /* ═══ 启动 ═══ */
  if(document.readyState === 'loading'){
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  window.Drawer = {
    open: open,
    close: close,
    isOpen: isOpen,
    register: register,
    push: push,
    pop: pop,
    stackSize: function(){ return _stack.length; },
    current: function(){ return _stack.length ? _stack[_stack.length-1] : null; },
    MAX_DEPTH: MAX_DEPTH,
  };
})();
