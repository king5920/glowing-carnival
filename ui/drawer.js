/* drawer.js —— §6 情景抽屉模块（L0→L1 基础层）
 *
 * 设计纪律（DESIGN.md §6）：
 *   - L0 列表 → L1 抽屉：从列表条目点开，滑入面板展示详情
 *   - 左栏条目从左滑出、右栏从右滑出（CSS 预留 .from-left，本轮只做右栏）
 *   - 同屏仅一个抽屉；Esc / 遮罩 / × 均可关闭
 *   - 打开时 focus 移入抽屉并 Tab 锁循环；关闭后焦点还原创发条目
 *   - URL hash 同步（#drawer=type:id）刷新可还原
 *   - <1400px 改底部全屏上滑（CSS 预留，本轮暂不实现）
 *
 * 约束：
 *   - 零外部库、零写死 hex、全走 CSS 变量
 *   - 不新建 canvas / rAF 链（抽屉是 DOM 元素，slide-in 用 CSS transform + transition）
 *   - 320ms cubic-bezier(.22,1,.36,1)，符合 §4 L3 150-300ms 窗口
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
  let _state = null;      // { type, id, side, title, render, sourceEl }
  let _fetchers = {};     // { type: { fetcher(id)→Promise<data>, render(data)→HTML, title? } }
  let _prevFocus = null;  // 打开前的 activeElement（用于关闭后还焦）
  let _onKeydown = null;  // keydown 监听器引用（便于 removeEventListener）
  let _init = false;

  /* ═══ DOM 引用 ═══ */
  let _panel, _backdrop, _titleEl, _bodyEl, _closeBtn;

  /* ═══ 初始化 ═══ */
  function init(){
    if(_init) return;
    _init = true;

    _panel = document.getElementById('drawerPanel');
    _backdrop = document.getElementById('drawerBackdrop');
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

    // 抽屉内容内事件委托（如"问 AI"按钮）
    if(_bodyEl){
      _bodyEl.addEventListener('click', function(e){
        var btn = e.target.closest('.drw-ask');
        if(btn){
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
        }
      });
    }

    // 页面加载时读 hash 自动开（fetcher 已在外部 IIFE 注册）
    restoreFromHash();
  }

  /* ═══ 公共 API ═══ */

  /**
   * 打开抽屉。
   * @param {string} type - 条目类型（'leader' / 'sector' / ...）
   * @param {string} id   - 条目 ID（leader code / sector key）
   * @param {object} opts - 配置
   * @param {Element} [opts.sourceEl] - 触发元素（关闭后还焦）
   * @param {string} [opts.side] - 'right'（默认）或 'left'
   * @param {string} [opts.title] - 抽屉标题（覆盖注册时的默认标题）
   * @param {function} [opts.render] - 渲染函数（覆盖注册时的默认渲染）
   */
  function open(type, id, opts){
    if(!_panel || !_backdrop) return;
    opts = opts || {};

    // 同屏仅一个抽屉：已开则先静默关闭
    if(_open) close(true);

    var cfg = _fetchers[type] || {};
    var render = opts.render || cfg.render;
    var fetcher = cfg.fetcher;
    var title = opts.title || cfg.title || type;

    _state = {
      type: type,
      id: id,
      side: opts.side || 'right',
      title: title,
      render: render,
      sourceEl: opts.sourceEl || null,
    };
    _prevFocus = opts.sourceEl || document.activeElement;

    // 设置方向类
    _panel.classList.remove('from-left', 'from-right');
    if(opts.side === 'left'){
      _panel.classList.add('from-left');
    } else {
      _panel.classList.add('from-right');
    }

    // 设置标题
    if(_titleEl) _titleEl.textContent = title;

    // 渲染内容
    if(_bodyEl){
      if(render){
        if(opts.data){
          // 有预加载数据：直接渲染（点击 .lrow 时数据已在手，无需 fetch）
          _bodyEl.innerHTML = render(opts.data);
        } else if(fetcher){
          // 无预加载数据：走 fetcher（hash 还原时）
          _bodyEl.innerHTML = '<div class="drw-loading">加载中…</div>';
          fetcher(id).then(function(data){
            if(!_open || _state.type !== type) return; // 已关闭或已切换，丢弃
            if(_bodyEl) _bodyEl.innerHTML = render(data);
          }).catch(function(){
            if(!_open || _state.type !== type) return;
            if(_bodyEl) _bodyEl.innerHTML = '<div class="drw-error">数据暂不可用</div>';
          });
        } else {
          _bodyEl.innerHTML = render({});
        }
      } else {
        _bodyEl.innerHTML = '<div class="drw-error">未注册渲染器</div>';
      }
    }

    // 显示抽屉
    _panel.classList.add('open');
    _panel.setAttribute('aria-hidden', 'false');
    _backdrop.classList.add('open');
    document.body.classList.add('drawer-open');

    // Hash 同步（用 replaceState 不产生历史记录）
    try {
      history.replaceState(null, '', '#drawer=' + type + ':' + id);
    } catch(e){}

    // 焦点锁
    _open = true;
    _onKeydown = handleKeydown;
    document.addEventListener('keydown', _onKeydown, true); // 捕获阶段拦截 Esc

    // 移动焦点进抽屉（等 slide-in 动画启动后）
    setTimeout(function(){
      if(!_open) return;
      var focusable = getFocusable();
      var first = focusable[0];
      if(first) first.focus();
      else if(_panel) _panel.focus(); // 面板自身 tabindex="-1" 兜底
    }, 80);
  }

  /**
   * 关闭抽屉。
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

    // 还焦
    var target = (_state && _state.sourceEl) || _prevFocus;
    if(target && typeof target.focus === 'function'){
      setTimeout(function(){ target.focus(); }, 80);
    }

    _state = null;
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
   * @param {object} cfg - { fetcher(id)→Promise<data>, render(data)→HTML, title? }
   */
  function register(type, cfg){
    _fetchers[type] = cfg;
  }

  /* ═══ 内部：Hash 还原 ═══ */
  function restoreFromHash(){
    var hash = location.hash || '';
    var m = hash.match(/^#drawer=([^:]+):(.+)$/);
    if(!m) return;
    var type = m[1];
    var id = m[2];
    var cfg = _fetchers[type];
    if(!cfg){
      console.warn('[drawer] hash #drawer=' + type + ':' + id + ' 但 fetcher 未注册，跳过');
      return;
    }
    // 还原时 side 未知，默认 right
    open(type, id, { side: 'right', title: cfg.title || type });
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

  window.Drawer = { open: open, close: close, isOpen: isOpen, register: register };
})();
