// FRM preview page script. Loaded once per page; the extension sends later renders as
// { command: 'frmUpdate', body, data } messages. The page then patches its body to match the new
// markup, keeping every element that is still there, and runs the page logic again with the new data.

// Bootstrap: runs once per page load
(function() {
  if (window.__frmBoot) return;
  window.__frmBoot = true;
  window.__frmScriptStart = performance.now();
  var api = null;
  try { if (typeof acquireVsCodeApi === 'function') { api = acquireVsCodeApi(); } } catch { /* ignore */ }
  window.__frmVscodeApi = api;

  // Track every listener the page logic adds, so an update can remove them all before the logic runs
  // again. Elements that stay in the page would otherwise get each listener twice.
  var tracked = [];
  var origAdd = EventTarget.prototype.addEventListener;
  EventTarget.prototype.addEventListener = function(type, fn, opts) {
    tracked.push([this, type, fn, opts]);
    return origAdd.call(this, type, fn, opts);
  };

  var pending = null;
  var retryTimer = null;
  window.__frmUpdatePending = function() { return pending !== null; };

  function isBusy() {
    try { return !!(window.__frmHooks && window.__frmHooks.isBusy()); } catch { return false; }
  }

  function tryApply() {
    if (pending === null) return;
    if (isBusy()) {
      // Hold the update until the drag, dialog or tab-order mode ends
      if (!retryTimer) retryTimer = setInterval(tryApply, 200);
      return;
    }
    if (retryTimer) { clearInterval(retryTimer); retryTimer = null; }
    var next = pending;
    pending = null;
    applyUpdate(next);
  }

  // ---- Patching the body ----------------------------------------------------------------------
  // The result is the same as replacing the body's markup, but elements that are still there stay
  // the same DOM nodes: only changed attributes and text are written, images don't reload, and
  // unchanged parts of the page aren't rebuilt.

  // Elements with a stable identity across renders: ids, and form elements by type and index
  function keyOf(n) {
    if (n.nodeType !== 1) return null;
    if (n.id) return '#' + n.id;
    var type = n.getAttribute('data-type');
    if (!type) return null;
    var idx = n.getAttribute('data-text-idx') || n.getAttribute('data-field-idx') || n.getAttribute('data-push-idx') ||
      n.getAttribute('data-image-idx') || n.getAttribute('data-preview-idx') || n.getAttribute('data-bgimage-idx') ||
      n.getAttribute('data-listview-idx');
    if (idx === null) return null;
    return type + ':' + idx + (n.classList.contains('hidden-field-item') ? ':hidden' : '');
  }

  function sameKind(a, b) {
    return a.nodeType === b.nodeType && a.nodeName === b.nodeName;
  }

  function patchAttributes(el, next) {
    for (var i = el.attributes.length - 1; i >= 0; i--) {
      var name = el.attributes[i].name;
      if (!next.hasAttribute(name)) el.removeAttribute(name);
    }
    for (var j = 0; j < next.attributes.length; j++) {
      var a = next.attributes[j];
      if (el.getAttribute(a.name) !== a.value) el.setAttribute(a.name, a.value);
    }
  }

  function patchNode(node, next) {
    if (node.nodeType !== 1) {
      if (node.nodeValue !== next.nodeValue) node.nodeValue = next.nodeValue;
      return;
    }
    patchAttributes(node, next);
    // The page script owns what is inside (the Properties panel): an input there keeps its focus and text
    if (node.hasAttribute('data-keep-children')) return;
    patchChildren(node, next, null);
    // Form controls reset to what the markup says, as freshly created ones would be
    if (node.nodeName === 'INPUT') {
      if (node.value !== next.value) node.value = next.value;
      if (node.checked !== next.checked) node.checked = next.checked;
    } else if (node.nodeName === 'TEXTAREA') {
      if (node.value !== next.value) node.value = next.value;
    } else if (node.nodeName === 'SELECT') {
      if (node.selectedIndex !== next.selectedIndex) node.selectedIndex = next.selectedIndex;
    }
  }

  // Make parent's children match next's children. skip(node) marks children of parent to leave alone.
  function patchChildren(parent, next, skip) {
    var old = [];
    var keyed = Object.create(null);
    for (var c = parent.firstChild; c; c = c.nextSibling) {
      if (skip && skip(c)) continue;
      old.push(c);
      var k = keyOf(c);
      if (k && !keyed[k]) keyed[k] = c;
    }
    var used = new Set();
    function nextFree(n) {
      while (n && ((skip && skip(n)) || used.has(n))) n = n.nextSibling;
      return n;
    }
    var cursor = nextFree(parent.firstChild);
    var wanted = Array.prototype.slice.call(next.childNodes);
    for (var i = 0; i < wanted.length; i++) {
      var w = wanted[i];
      var key = keyOf(w);
      var match = null;
      if (key) {
        var cand = keyed[key];
        if (cand && !used.has(cand) && sameKind(cand, w)) match = cand;
      } else if (cursor && !keyOf(cursor) && sameKind(cursor, w)) {
        match = cursor;
      }
      if (match) {
        used.add(match);
        if (match === cursor) cursor = nextFree(cursor.nextSibling);
        else parent.insertBefore(match, cursor);
        patchNode(match, w);
      } else {
        parent.insertBefore(document.importNode(w, true), cursor);
      }
    }
    for (var j = 0; j < old.length; j++) {
      if (!used.has(old[j]) && old[j].parentNode === parent) parent.removeChild(old[j]);
    }
  }

  function applyUpdate(msg) {
    try {
      var carry = { selection: null };
      try { if (window.__frmHooks) carry.selection = window.__frmHooks.getSelection(); } catch { /* ignore */ }
      var scrollX = window.scrollX;
      var scrollY = window.scrollY;

      // Drop the previous run's listeners and hooks; the page logic adds them again below
      tracked.splice(0).forEach(function(t) { t[0].removeEventListener(t[1], t[2], t[3]); });
      window.__frmHooks = null;

      var tpl = document.createElement('template');
      tpl.innerHTML = msg.body;
      patchChildren(document.body, tpl.content, function(n) { return n.nodeName === 'SCRIPT'; });

      window.__frmCarry = carry;
      window.__frmMain(msg.data);
      window.scrollTo(scrollX, scrollY);
    } catch (e) {
      // Ask for a full reload so the preview never stays broken or stale
      if (api) api.postMessage({ command: 'frmSoftUpdateFailed', error: String(e && e.stack || e) });
    }
  }

  origAdd.call(window, 'message', function(ev) {
    var msg = ev.data;
    if (msg && msg.command === 'frmUpdate' && typeof msg.body === 'string' && msg.data) {
      pending = msg;
      tryApply();
    }
  });

  if (api) api.postMessage({ command: 'frmReady' });
})();

// Page logic: runs on load and again after every in-place update, with that render's data (PreviewData)
window.__frmMain = function(D) {
  var vscodeApi;
  // Acquired once by the bootstrap above; this function runs again on every in-place update
  vscodeApi = window.__frmVscodeApi || undefined;
  var root = document.documentElement;
  var basePx = 11; // default matches CSS
  var winstyle = D.winstyle; // vxdbase_winstyle from FRM file
  var defaultIgnoreValue = winstyle.toLowerCase() === 'only' ? 4 : 7;
  try {
    var fs = getComputedStyle(root).getPropertyValue('--frm-font-size').trim();
    // Never matches a size like "11px" (it was written as [\d.] inside a template string, which dropped the
    // backslash), so basePx stays 11. Keep it that way: this runs again after every update, when
    // --frm-font-size already holds the zoomed size, so reading it would compound the zoom.
    var m = fs.match(/([d.]+)/);
    if (m) basePx = parseFloat(m[1]);
  } catch { /* ignore */ }
  var currentZoom = 1;
  var currentGridOn = true;
  var ZOOM_MIN = 0.5;
  var ZOOM_MAX = 10;
  var ZOOM_STEP = 0.05;
  var WHEEL_NOTCH = 80;
  var wheelAcc = 0;

  function setColWidth(){
    try {
      var size = getComputedStyle(root).getPropertyValue('--frm-font-size').trim() || '14px';
      var probe = document.createElement('span');
      probe.textContent = 'A';
      probe.style.position = 'absolute';
      probe.style.visibility = 'hidden';
      probe.style.whiteSpace = 'nowrap';
      probe.style.fontFamily = "Times New Roman, Times, serif";
      probe.style.fontSize = size;
      document.body.appendChild(probe);
      var w = probe.getBoundingClientRect().width || 8;
      w = w - 1;
      probe.remove();
      root.style.setProperty('--col-w', w + 'px');
    } catch { /* ignore */ }
    scheduleFitTextSpans();
  }

  var colWidthFrame = 0;
  function scheduleColWidth() {
    if (!colWidthFrame) colWidthFrame = requestAnimationFrame(onCurrentPage(function() { colWidthFrame = 0; setColWidth(); }));
  }

  // Each text's and push button's grid span = its rendered width in whole columns (min 1), so drop outlines
  // and the keep-inside-window checks use the size you see. Re-run when the font size changes.
  // Columns between an element's file column and where it is drawn (boxed text labels)
  function colOffset(el) {
    return (el && parseInt(el.getAttribute('data-col-offset'), 10)) || 0;
  }

  // Start the box's top line to the right of a boxed label at the measured end of the text,
  // leaving the same space as between the left line segment and the start of the text
  // Measure every box first, then write: alternating reads and writes would make the browser
  // recalculate the layout once per box instead of once in total
  function fitBoxGaps() {
    var updates = [];
    document.querySelectorAll('.grid > .text[data-box-rows]').forEach(function(el) {
      var box = document.querySelector('.grid > .box[data-row="' + el.getAttribute('data-row') + '"][data-col="' + el.getAttribute('data-col') + '"]');
      var right = box && box.querySelector('.hrow.top.gap-right');
      if (!right) return;
      var left = box.querySelector('.hrow.top.gap-left');
      var t = el.getBoundingClientRect();
      var b = box.getBoundingClientRect();
      var pad = t.left - (left ? left.getBoundingClientRect().right : b.left);
      var start = t.right - b.left + Math.max(0, pad);
      updates.push({ right: right, start: start, show: start < b.width - parseFloat(getComputedStyle(right).right || '0') });
    });
    updates.forEach(function(u) {
      u.right.style.left = u.start + 'px';
      u.right.style.display = u.show ? '' : 'none';
    });
  }

  // Zoom and window resizes ask for a fit per event; run it at most once per frame
  var fitFrame = 0;
  // A frame requested before an in-place update must not run this (replaced) script's code on the new page
  function onCurrentPage(fn) {
    var grid = document.querySelector('.grid');
    return function() { if (!grid || grid.isConnected) fn(); };
  }
  function scheduleFitTextSpans() {
    if (!fitFrame) fitFrame = requestAnimationFrame(onCurrentPage(function() { fitFrame = 0; fitTextSpans(); }));
  }

  function fitTextSpans() {
    // A direct call does the pending frame's work now
    if (fitFrame) { cancelAnimationFrame(fitFrame); fitFrame = 0; }
    try {
      var m = getGridMetrics();
      if (!m || !(m.colPitch > 0)) return;
      var colGap = m.colPitch - m.colWidth;
      // Measure all widths, then set all spans (width is max-content, so a span never changes a width)
      var spans = [];
      document.querySelectorAll('.grid > .text.draggable, .grid > .push.draggable').forEach(function(el) {
        var w = el.getBoundingClientRect().width;
        if (!(w > 0)) return; // hidden (other tab): keep the estimate until it is shown
        var col = parseInt(el.getAttribute('data-col'), 10);
        if (!isFinite(col)) return;
        spans.push({ el: el, value: (col + colOffset(el)) + ' / span ' + Math.max(1, Math.ceil((w + colGap) / m.colPitch - 0.01)) });
      });
      spans.forEach(function(s) { s.el.style.gridColumn = s.value; });
      fitBoxGaps();
      document.querySelectorAll('.grid > .listview').forEach(updateListviewScroll);
      // Spans changed: refresh which elements reach outside the window
      if (typeof gridRows === 'number' && typeof gridCols === 'number') updateOverflow(gridRows, gridCols);
    } catch { /* ignore */ }
  }

  function snapZoom(z) {
    var n = Math.round((Number(z) || 1) / ZOOM_STEP) * ZOOM_STEP;
    n = Math.round(n * 100) / 100;
    return Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, n));
  }

  function applyZoom(z, silent){
    var clamped = snapZoom(z);
    currentZoom = clamped;
    root.style.setProperty('--frm-font-size', (basePx * currentZoom) + 'px');
    var lbl = document.getElementById('zoomLabel');
    if (lbl) lbl.textContent = Math.round(currentZoom * 100) + '%';
    var zr = document.getElementById('zoomRange');
    if (zr && zr.tagName === 'INPUT') zr.value = String(currentZoom);
    setColWidth();
    if (!silent && vscodeApi && vscodeApi.postMessage) {
      vscodeApi.postMessage({ command: 'setZoom', zoom: currentZoom });
    }
  }

  function zoomGestureBlocked() {
    return !!(draggedElement || sizeDrag || elResize || boxResize || marquee);
  }

  function applyZoomAnchored(z, clientX, clientY) {
    var grid = document.querySelector('.grid');
    var r0 = grid ? grid.getBoundingClientRect() : null;
    var gx = r0 ? clientX - r0.left : 0;
    var gy = r0 ? clientY - r0.top : 0;
    var w0 = r0 && r0.width > 0 ? r0.width : 0;
    var h0 = r0 && r0.height > 0 ? r0.height : 0;
    applyZoom(z);
    if (!grid || !(w0 > 0) || !(h0 > 0)) return;
    var r1 = grid.getBoundingClientRect();
    window.scrollBy(r1.left - (clientX - gx * (r1.width / w0)), r1.top - (clientY - gy * (r1.height / h0)));
  }

  function zoomBy(steps, clientX, clientY) {
    if (zoomGestureBlocked()) return;
    var next = snapZoom(currentZoom + steps * ZOOM_STEP);
    if (next === currentZoom) return;
    if (typeof clientX === 'number' && typeof clientY === 'number') applyZoomAnchored(next, clientX, clientY);
    else applyZoom(next);
  }

  function fitZoomToWindow() {
    if (zoomGestureBlocked()) return;
    var win = document.querySelector('.window');
    var grid = document.querySelector('.grid-frame') || document.querySelector('.grid');
    if (!win || !grid) return;
    var bodyStyle = getComputedStyle(document.body);
    var wr = win.getBoundingClientRect();
    var gr = grid.getBoundingClientRect();
    var docTop = wr.top + window.scrollY;
    var docLeft = wr.left + window.scrollX;
    var availW = document.documentElement.clientWidth - docLeft - (parseFloat(bodyStyle.paddingRight) || 0);
    var availH = document.documentElement.clientHeight - docTop - (parseFloat(bodyStyle.paddingBottom) || 0);
    if (!(availW > 0) || !(availH > 0) || !(gr.width > 0) || !(gr.height > 0) || !(currentZoom > 0)) {
      applyZoom(1);
      window.scrollTo(0, 0);
      return;
    }
    var extraW = wr.width - gr.width;
    var extraH = wr.height - gr.height;
    var zW = (availW - extraW) / (gr.width / currentZoom);
    var zH = (availH - extraH) / (gr.height / currentZoom);
    var z = Math.min(zW, zH);
    applyZoom(isFinite(z) && z > 0 ? z : 1);
    window.scrollTo(0, 0);
  }

  var lastZoomAction = '';
  var lastZoomAt = 0;
  function handleZoomAction(action, clientX, clientY) {
    var now = 0;
    try { now = performance.now(); } catch (e) { now = Date.now(); }
    // Host keybindings and the page's keydown can both fire for one press
    if (action === lastZoomAction && now - lastZoomAt < 25) return;
    lastZoomAction = action;
    lastZoomAt = now;
    if (action === 'in') zoomBy(1, clientX, clientY);
    else if (action === 'out') zoomBy(-1, clientX, clientY);
    else if (action === 'reset') { if (!zoomGestureBlocked()) applyZoom(1); }
    else if (action === 'fit') fitZoomToWindow();
  }

  function zoomActionFromKey(e) {
    if (!(e.ctrlKey || e.metaKey) || e.altKey) return null;
    var key = e.key;
    var code = e.code;
    if (!e.shiftKey && (key === '0' || code === 'Digit0' || code === 'Numpad0')) return 'reset';
    if (!e.shiftKey && (key === '1' || code === 'Digit1' || code === 'Numpad1')) return 'fit';
    if (code === 'Equal' || code === 'NumpadAdd' || key === '=' || key === '+') return 'in';
    if (code === 'Minus' || code === 'NumpadSubtract' || key === '-' || key === '_') return 'out';
    return null;
  }

  function applyGrid(on, silent){
    currentGridOn = !!on;
    // Set alpha: on => 0.8, off => 0
    try { root.style.setProperty('--gridline-alpha', currentGridOn ? '0.8' : '0'); } catch { /* ignore */ }
    var gt = document.getElementById('gridToggle');
    if (gt && gt.tagName === 'INPUT') { (gt).checked = !!currentGridOn; }
    if (!silent && vscodeApi && vscodeApi.postMessage) {
      vscodeApi.postMessage({ command: 'setGridOn', on: !!currentGridOn });
    }
    try {
      if (vscodeApi && vscodeApi.setState) {
        var prev = (vscodeApi.getState && vscodeApi.getState()) || {};
        vscodeApi.setState(Object.assign({}, prev, { gridOn: !!currentGridOn }));
      }
    } catch { /* ignore */ }
  }


  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(setColWidth);
  } else {
    window.addEventListener('load', setColWidth);
  }
  window.addEventListener('resize', scheduleColWidth);

  // Wire up zoom UI
  try {
    document.querySelectorAll('[data-zoom]').forEach(function(el){
      el.addEventListener('click', function(){
        var val = parseFloat(el.getAttribute('data-zoom') || '1');
        applyZoom(val);
      });
    });
    var zr = document.getElementById('zoomRange');
    if (zr) {
      zr.addEventListener('input', function(){
        var v = parseFloat(this.value || '1');
        applyZoom(v);
      });
    }
    var fitBtn = document.getElementById('zoomFit');
    if (fitBtn) {
      fitBtn.addEventListener('click', function() { fitZoomToWindow(); });
    }
    window.addEventListener('wheel', function(e) {
      if (!(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      e.stopPropagation();
      if (zoomGestureBlocked()) return;
      var dy = e.deltaY;
      if (e.deltaMode === 1) dy *= 16;
      else if (e.deltaMode === 2) dy *= 80;
      wheelAcc += dy;
      while (wheelAcc <= -WHEEL_NOTCH) {
        wheelAcc += WHEEL_NOTCH;
        zoomBy(1, e.clientX, e.clientY);
      }
      while (wheelAcc >= WHEEL_NOTCH) {
        wheelAcc -= WHEEL_NOTCH;
        zoomBy(-1, e.clientX, e.clientY);
      }
    }, { passive: false, capture: true });
    var gt = document.getElementById('gridToggle');
    if (gt) {
      gt.addEventListener('change', function(){
        applyGrid(!!this.checked);
      });
    }


  } catch { /* ignore */ }

  // Initialize to provided initial zoom
  applyZoom(D.initialZoom, true);
  // Initialize gridlines from state or provided initial value
  (function(){
    var initial = (function(){
      try {
        var state = vscodeApi && vscodeApi.getState ? (vscodeApi.getState() || {}) : {};
        if (typeof state.gridOn === 'boolean') return state.gridOn;
      } catch { /* ignore */ }
      return D.initialGridOn;
    })();
    applyGrid(initial, true);
  })();

  // Tabs logic
  var tabs = D.tabs;
  var tabTexts = D.tabTexts;
  var tabFields = D.tabFields;
  var tabPushButtons = D.tabPushButtons;
  var tabImages = D.tabImages;
  var tabBackgrounds = D.tabBackgrounds;
  var tabPreviews = D.tabPreviews;
  // A preview on no tab's list is shown on all of them
  function previewOnTabs(idx) {
    return tabs.some(function(t) { return (tabPreviews[t.id] || []).map(Number).indexOf(idx) >= 0; });
  }
  // Tabs whose list names a background
  function backgroundTabs(idx) {
    return tabs.filter(function(t) { return (tabBackgrounds[t.id] || []).map(Number).indexOf(idx) >= 0; }).map(function(t) { return t.id; });
  }
  // List view tables: a table is on the tabs in data-listview-tabs ('all' without tabs) and shows the
  // columns data-listview-order lists for the tab, in that order
  function layoutListviews(tabId) {
    document.querySelectorAll('.grid > .listview').forEach(function(el) {
      var on = (el.getAttribute('data-listview-tabs') || 'all').split(' ');
      var key = on[0] === 'all' ? 'all' : String(tabId);
      el.classList.toggle('hidden', on[0] !== 'all' && on.indexOf(key) < 0);
      var order = {};
      try { order = JSON.parse(el.getAttribute('data-listview-order') || '{}'); } catch { /* ignore */ }
      var shown = (order[key] || []).map(String);
      el.querySelectorAll('.lv-col').forEach(function(col) {
        var at = shown.indexOf(col.getAttribute('data-col-pos'));
        col.classList.toggle('hidden', at < 0);
        col.style.order = at < 0 ? '' : String(at);
      });
      updateListviewScroll(el);
    });
  }

  // Columns cut off at the right edge: show a scrollbar thumb sized to the part in view
  function updateListviewScroll(el) {
    var cols = el.querySelector('.lv-cols');
    var bar = el.querySelector('.lv-hscroll');
    if (!cols || !bar) return;
    var over = cols.scrollWidth > cols.clientWidth + 1;
    bar.classList.toggle('hidden', !over);
    el.classList.toggle('lv-overflow', over);
    var thumb = bar.querySelector('.lv-thumb');
    if (over && thumb) thumb.style.width = Math.max(8, 100 * cols.clientWidth / cols.scrollWidth) + '%';
  }

  // Clicking a column heading selects the table and its column: the Properties panel shows the column's
  // field(n) and heading text(n), and the editor shows their lines
  function setupListviewColumns() {
    document.querySelectorAll('.grid > .listview .lv-col').forEach(function(col) {
      col.addEventListener('click', function(e) {
        if (tabOrderMode || e.ctrlKey || e.metaKey || e.shiftKey) return;
        if (!e.target.closest('.lv-head, .lv-filter')) return;
        e.stopPropagation();
        var table = col.closest('.listview');
        var field = parseInt(col.getAttribute('data-col-field'), 10);
        propsState.column = isFinite(field) ? { key: elementKey(table), field: field } : null;
        selectElement(table);
        col.classList.add('lv-col-active');
        if (isFinite(field) && vscodeApi && vscodeApi.postMessage) {
          vscodeApi.postMessage({ command: 'showColumnInSource', fieldIndex: field });
        }
      });
    });
  }

  function markColumn(table, field) {
    table.querySelectorAll('.lv-col').forEach(function(c) {
      c.classList.toggle('lv-col-active', c.getAttribute('data-col-field') === String(field));
    });
  }

  // The columns whose field(n) or heading text(n) the editor's selection touches
  function markCodeColumns(keys) {
    var indexes = (keys || []).map(function(k) {
      var m = /^(field|text):(\d+)$/.exec(k);
      return m ? m[2] : null;
    }).filter(Boolean);
    document.querySelectorAll('.grid > .listview .lv-col').forEach(function(col) {
      col.classList.toggle('lv-col-active', indexes.indexOf(col.getAttribute('data-col-field')) >= 0);
    });
  }

  var initialActiveTab = D.initialActiveTab;
  var currentActiveTab = null; // Track the currently active tab
  function applyTab(tabId){
    try {
      layoutListviews(tabId);
      // A background on no tab's list is shown on all of them
      document.querySelectorAll('.bg-image').forEach(function(el) {
        var idx = JSON.parse(el.getAttribute('data-bg')).index;
        var on = backgroundTabs(idx);
        el.classList.toggle('hidden', on.length > 0 && on.indexOf(Number(tabId)) < 0);
      });
      var textSet = new Set((tabTexts[tabId] || []).map(Number));
      var fieldSet = new Set((tabFields[tabId] || []).map(Number));
      var pushButtonSet = new Set((tabPushButtons[tabId] || []).map(Number));
      var imageSet = new Set((tabImages[tabId] || []).map(Number));
      // Toggle active class on tabs
      document.querySelectorAll('.tab').forEach(function(tb){
        tb.classList.toggle('active', String(tb.getAttribute('data-tab-id')) === String(tabId));
      });
      // Show/hide texts
      document.querySelectorAll('.grid .text').forEach(function(el){
        var idxAttr = el.getAttribute('data-text-idx');
        if (!tabs.length) { el.classList.remove('hidden'); return; }
        if (!idxAttr) { el.classList.remove('hidden'); return; }
        var idx = Number(idxAttr);
        if (textSet.has(idx)) el.classList.remove('hidden');
        else el.classList.add('hidden');
      });
      // Show/hide fields
      document.querySelectorAll('.grid .field').forEach(function(el){
        var idxAttr = el.getAttribute('data-field-idx');
        if (!tabs.length) { el.classList.remove('hidden'); return; }
        if (!idxAttr) { el.classList.remove('hidden'); return; }
        var idx = Number(idxAttr);
        if (fieldSet.has(idx)) el.classList.remove('hidden');
        else el.classList.add('hidden');
      });
      // Show/hide pushbuttons
      document.querySelectorAll('.grid .push').forEach(function(el){
        var idxAttr = el.getAttribute('data-push-idx');
        if (!tabs.length) { el.classList.remove('hidden'); return; }
        if (!idxAttr) { el.classList.remove('hidden'); return; }
        var idx = Number(idxAttr);
        if (pushButtonSet.has(idx)) el.classList.remove('hidden');
        else el.classList.add('hidden');
      });
      // Show/hide images
      document.querySelectorAll('.grid .image').forEach(function(el){
        var idxAttr = el.getAttribute('data-image-idx');
        if (!tabs.length) { el.classList.remove('hidden'); return; }
        if (!idxAttr) { el.classList.remove('hidden'); return; }
        var idx = Number(idxAttr);
        if (imageSet.has(idx)) el.classList.remove('hidden');
        else el.classList.add('hidden');
      });
      // Show/hide previews
      var previewSet = new Set((tabPreviews[tabId] || []).map(Number));
      document.querySelectorAll('.grid .preview').forEach(function(el){
        var idx = Number(el.getAttribute('data-preview-idx') || NaN);
        el.classList.toggle('hidden', previewOnTabs(idx) && !previewSet.has(idx));
      });
    } catch { /* ignore */ }
  }
  function switchTab(id) {
    currentActiveTab = id;
    applyTab(id);
    fitTextSpans();
    updateSelectionNotice();
    try {
      if (vscodeApi && vscodeApi.postMessage) {
        vscodeApi.postMessage({ command: 'setActiveTab', id: id });
      }
      if (vscodeApi && vscodeApi.setState) {
        var prev = (vscodeApi.getState && vscodeApi.getState()) || {};
        vscodeApi.setState(Object.assign({}, prev, { activeTabId: id }));
      }
    } catch { /* ignore */ }
  }
  // Tabs an element is shown on; null when it doesn't depend on the tab
  function tabsOfElement(el) {
    var type = el.getAttribute('data-type');
    var lists = { text: tabTexts, field: tabFields, pushbutton: tabPushButtons, image: tabImages }[type];
    var index = elementIndexOf(el);
    if (type === 'listview') {
      var on = (el.getAttribute('data-listview-tabs') || 'all').split(' ');
      return !tabs.length || on[0] === 'all' ? null : on.map(Number);
    }
    if (type === 'preview' && index !== null && previewOnTabs(index)) lists = tabPreviews;
    if (!tabs.length || !lists || index === null) return null;
    return tabs.filter(function(t) {
      return (lists[t.id] || []).map(Number).indexOf(index) >= 0;
    }).map(function(t) { return t.id; });
  }
  if (tabs.length) {
    var firstId = tabs[0].id;
    var restoreId;
    try {
      var state = vscodeApi && vscodeApi.getState ? (vscodeApi.getState() || {}) : {};
      if (state && typeof state.activeTabId === 'number') restoreId = state.activeTabId;
    } catch { /* ignore */ }
    if (typeof initialActiveTab === 'number') restoreId = initialActiveTab;
    var hasRestore = tabs.some(function(t){ return String(t.id) === String(restoreId); });
    currentActiveTab = hasRestore ? restoreId : firstId;
    applyTab(currentActiveTab);
    var tabsEl = document.getElementById('tabs');
    if (tabsEl) {
      tabsEl.querySelectorAll('.tab').forEach(function(tb){
        tb.addEventListener('click', function(){
          switchTab(Number(tb.getAttribute('data-tab-id')));
        });
      });
    }
  }

  // Context menu and element creation functionality
  var contextMenuState = {
    row: 0,
    col: 0,
    buttonType: 'select' // 'select', 'checkbox', 'radio'
  };

  var elementContextMenuState = {
    element: null,
    elementType: '',
    elementIndex: 0,
    elementData: {}
  };

  function showContextMenu(x, y, row, col) {
    var menu = document.getElementById('contextMenu');
    if (!menu) return;
    
    contextMenuState.row = row;
    contextMenuState.col = col;
    // Log the selected grid position for debugging
    try { console.log('Context menu opened at row:', row, 'col:', col); } catch { /* ignore */ }
    
    menu.classList.remove('hidden');
    menu.style.left = x + 'px';
    menu.style.top = y + 'px';
  }

  function hideContextMenu() {
    var menu = document.getElementById('contextMenu');
    if (menu) menu.classList.add('hidden');
    hideGridCellHighlight();
  }

  function showElementContextMenu(x, y, element, elementType, elementIndex, elementData) {
    var menu = document.getElementById('elementContextMenu');
    if (!menu) return;

    elementContextMenuState.element = element;
    elementContextMenuState.elementType = elementType;
    elementContextMenuState.elementIndex = elementIndex;
    elementContextMenuState.elementData = elementData;

    // Show/hide Move option based on whether tabs exist
    var hasTabs = D.tabs.length > 0;
    var moveItem = document.getElementById('moveElementMenuItem');
    if (moveItem) {
      // A background's tabs are set in its dialog
      if (hasTabs && elementType !== 'bgimage' && elementType !== 'listview') {
        moveItem.classList.remove('hidden');
      } else {
        moveItem.classList.add('hidden');
      }
    }

    // On a selected group: only what acts on all of it
    var group = actionTargets();
    if (group.length < 2 || group.indexOf(element) < 0) group = null;
    elementContextMenuState.group = group;
    menu.querySelectorAll('[data-action="edit-element"], [data-action="show-in-source"]').forEach(function(item) {
      item.classList.toggle('hidden', !!group);
    });
    if (group && moveItem) moveItem.classList.add('hidden');
    var duplicateItem = menu.querySelector('[data-action="duplicate-element"]');
    if (duplicateItem) duplicateItem.classList.toggle('hidden', !group && elementType === 'listview');
    ['Duplicate', 'Delete'].forEach(function(name) {
      var label = menu.querySelector('[data-action="' + name.toLowerCase() + '-element"] .label');
      if (label) label.textContent = group ? name + ' ' + group.length + ' elements' : name;
    });

    // Texts toggle their box from here
    var boxItem = document.getElementById('toggleBoxMenuItem');
    if (boxItem) {
      var isText = !group && elementType === 'text' && isFinite(elementIndex);
      boxItem.classList.toggle('hidden', !isText);
      if (isText) boxItem.textContent = element && element.hasAttribute('data-box-rows') ? 'Remove Box' : 'Add Box';
    }

    menu.classList.remove('hidden');
    menu.style.left = x + 'px';
    menu.style.top = y + 'px';
  }

  function hideElementContextMenu() {
    var menu = document.getElementById('elementContextMenu');
    if (menu) menu.classList.add('hidden');
  }

  function showOutsideContextMenu(x, y) {
    var menu = document.getElementById('outsideContextMenu');
    if (!menu) return;

    menu.classList.remove('hidden');
    menu.style.left = x + 'px';
    menu.style.top = y + 'px';
  }

  function hideOutsideContextMenu() {
    var menu = document.getElementById('outsideContextMenu');
    if (menu) menu.classList.add('hidden');
  }

  // Cell size measured from the rendered grid. The CSS variables can't be parsed for this:
  // --row-h is "calc(2ch + 16px)" and depends on the zoomed font size.
  function getGridMetrics() {
    var grid = document.querySelector('.grid');
    if (!grid) return null;
    var rect = grid.getBoundingClientRect();
    var cs = getComputedStyle(grid);
    var colGap = parseFloat(cs.columnGap) || 0;
    var rowGap = parseFloat(cs.rowGap) || 0;
    var rows = (typeof gridRows === 'number' && gridRows > 0) ? gridRows : D.rows;
    var cols = (typeof gridCols === 'number' && gridCols > 0) ? gridCols : D.cols;
    var rowPitch = (rect.height + rowGap) / rows;
    var colPitch = (rect.width + colGap) / cols;
    return {
      rect: rect, rows: rows, cols: cols,
      rowPitch: rowPitch, colPitch: colPitch,
      rowHeight: rowPitch - rowGap, colWidth: colPitch - colGap
    };
  }

  function placeOnGrid(el, m, row, col, rowSpan, colSpan) {
    el.style.left = ((col - 1) * m.colPitch) + 'px';
    el.style.top = ((row - 1) * m.rowPitch) + 'px';
    el.style.width = ((colSpan || 1) * m.colPitch - (m.colPitch - m.colWidth)) + 'px';
    el.style.height = ((rowSpan || 1) * m.rowPitch - (m.rowPitch - m.rowHeight)) + 'px';
  }

  function showGridCellHighlight(row, col) {
    var highlight = document.getElementById('gridCellHighlight');
    var m = getGridMetrics();
    if (!highlight || !m) return;
    placeOnGrid(highlight, m, row, col, 1, 1);
    highlight.classList.remove('hidden');
  }

  function hideGridCellHighlight() {
    var highlight = document.getElementById('gridCellHighlight');
    if (highlight) highlight.classList.add('hidden');
  }

  function showModal(modalId) {
    var modal = document.getElementById(modalId);
    if (!modal) return;
    hideAllContextMenus();
    modal.classList.remove('hidden');
    hideDiscardBar(modal, false);
    focusFirstModalInput(modal);
    // Snapshot after the caller has filled in the form (callers do that synchronously around this call)
    modal.__frmSnapshot = undefined;
    setTimeout(function() {
      if (!modal.classList.contains('hidden')) modal.__frmSnapshot = modalSnapshot(modal);
    }, 0);
  }

  function hideModal(modalId) {
    var modal = document.getElementById(modalId);
    if (!modal) return;
    modal.classList.add('hidden');
    hideDiscardBar(modal, false);
    if (!topModal()) restoreCanvasFocus();
  }

  // Type, index and the data the edit dialogs need, read from a rendered element
  function collectElementInfo(element) {
    var elementType = element.getAttribute('data-type');
    var elementIndex = 0;
    var elementData = {
      row: parseInt(element.getAttribute('data-row')),
      col: parseInt(element.getAttribute('data-col'))
    };

    // Get element index based on type
    if (elementType === 'text') {
      elementIndex = parseInt(element.getAttribute('data-text-idx'));
    } else if (elementType === 'field') {
      elementIndex = parseInt(element.getAttribute('data-field-idx'));
    } else if (elementType === 'pushbutton') {
      elementIndex = parseInt(element.getAttribute('data-pb-idx'));
    } else if (elementType === 'bgimage') {
      elementIndex = parseInt(element.getAttribute('data-bgimage-idx'));
    } else if (elementType === 'image') {
      elementIndex = parseInt(element.getAttribute('data-image-idx'));
    } else if (elementType === 'preview') {
      elementIndex = parseInt(element.getAttribute('data-preview-idx'));
    } else if (elementType === 'listview') {
      elementIndex = parseInt(element.getAttribute('data-listview-idx'));
    }

    // Get element-specific data from the element
    if (elementType === 'text') {
      // Get text content excluding drag-handle and delete-button
      var textContent = '';
      for (var i = 0; i < element.childNodes.length; i++) {
        var node = element.childNodes[i];
        // Include text nodes and skip delete-button elements
        if (node.nodeType === 3) { // Text node
          textContent += node.textContent;
        } else if (node.nodeType === 1 && !node.classList.contains('delete-button') && !node.classList.contains('insertion-point')) {
          textContent += node.textContent;
        }
      }
      elementData.content = textContent.trim();
      // Extract box dimensions if present
      var boxRows = element.getAttribute('data-box-rows');
      var boxCols = element.getAttribute('data-box-cols');
      if (boxRows && boxCols) {
        elementData.boxRows = parseInt(boxRows);
        elementData.boxCols = parseInt(boxCols);
      }
    } else if (elementType === 'field') {
      elementData.name = element.getAttribute('data-field-name') || '';
      const nameFormatAttr = element.getAttribute('data-field-nameformat');
      try {
        elementData.nameFormat = nameFormatAttr ? JSON.parse(nameFormatAttr) : {};
      } catch {
        elementData.nameFormat = {};
      }
      const rawFieldType = element.getAttribute('data-field-type');
      elementData.type = rawFieldType && rawFieldType.trim()
        ? rawFieldType.trim()
        : (element.classList.contains('locked') ? '4' : '1');
      // Use stored length attribute to avoid including dropdown padding
      const storedLen = element.getAttribute('data-field-len');
      if (storedLen) {
        elementData.len = parseInt(storedLen);
      } else {
        // Fallback: extract from grid span and subtract 2 if dropdown
        const span = element.style.gridColumnEnd ? 
          parseInt(element.style.gridColumnEnd.replace('span ', '')) : 10;
        const isDropdown = element.classList.contains('dropdown');
        elementData.len = isDropdown ? Math.max(1, span - 2) : span;
      }
      const rawValues = element.getAttribute('data-field-values');
      if (rawValues) {
        try {
          elementData.values = JSON.parse(rawValues);
        } catch {
          elementData.values = [];
        }
      } else {
        elementData.values = [];
      }
    } else if (elementType === 'pushbutton') {
      var labelEl = element.querySelector('.label, .btn');
      elementData.label = labelEl ? labelEl.textContent.trim() : '';
      var kindAttr = element.getAttribute('data-pb-kind');
      elementData.kind = kindAttr || (element.classList.contains('checkbox') ? 'checkbox' : element.classList.contains('radio') ? 'radio' : 'select');
      var dataName = element.getAttribute('data-pb-name');
      if (dataName) {
        elementData.name = dataName;
      }
      var dataValue = element.getAttribute('data-pb-value');
      if (dataValue !== null) {
        elementData.value = dataValue; // '' sets the variable to blank
      } else {
        if (elementData.kind === 'checkbox') {
          elementData.value = '1;0';
        } else if (elementData.kind === 'radio') {
          elementData.value = '1';
        }
      }
      var dataProgram = element.getAttribute('data-pb-program');
      if (dataProgram) {
        elementData.program = dataProgram;
      }
      var dataAction = element.getAttribute('data-pb-action');
      if (dataAction) {
        elementData.action = dataAction;
      } else if (elementData.kind === 'checkbox' || elementData.kind === 'radio' || elementData.name) {
        elementData.action = 'variable';
      } else if (elementData.program) {
        elementData.action = 'program';
      }
    } else if (elementType === 'preview') {
      elementData.mode = element.getAttribute('data-preview-mode') || '0';
      elementData.path = element.getAttribute('data-preview-path') || '$DIR_PICTS/file.vxp';
      elementData.field = element.getAttribute('data-preview-field') || '';
      elementData.portType = element.getAttribute('data-preview-porttype') || 'PORT_2D';
      elementData.portStyle = element.getAttribute('data-preview-portstyle') || 'SIMPLE';
      // Get rows and cols from data attributes
      const rowsAttr = element.getAttribute('data-preview-rows');
      const colsAttr = element.getAttribute('data-preview-cols');
      elementData.rows = rowsAttr ? parseInt(rowsAttr) : 25;
      elementData.cols = colsAttr ? parseInt(colsAttr) : 72;
    } else if (elementType === 'image') {
      elementData.file = (element.getAttribute('data-image-file') || '').replace(/^"|"$/g, '');
      elementData.mode = element.getAttribute('data-image-mode') || '0';
      elementData.rows = parseInt(element.getAttribute('data-image-rows'), 10);
      elementData.cols = parseInt(element.getAttribute('data-image-cols'), 10);
    }

    return { type: elementType, index: elementIndex, data: elementData };
  }

  function setupContextMenu() {
    var grid = document.querySelector('.grid');
    if (!grid) return;

    // Right-click on grid to show context menu
    grid.addEventListener('contextmenu', function(e) {
      // Check if right-click is on an element
      var element = e.target.closest('.draggable');
      if (element) {
        e.preventDefault();
        e.stopPropagation();
        
        var info = collectElementInfo(element);
        showElementContextMenu(e.clientX, e.clientY, element, info.type, info.index, info.data);
        return;
      }

      // Right-click on empty grid space
      e.preventDefault();
      
      var m = getGridMetrics();
      if (!m) return;
      var x = e.clientX - m.rect.left;
      var y = e.clientY - m.rect.top;

      // The cell under the pointer
      var col = Math.min(m.cols, Math.max(1, Math.floor(x / m.colPitch) + 1));
      var row = Math.min(m.rows, Math.max(1, Math.floor(y / m.rowPitch) + 1));
      
      showGridCellHighlight(row, col);
      showContextMenu(e.clientX, e.clientY, row, col);
    });

    // Click anywhere else to hide context menus and highlight
    document.addEventListener('click', function(e) {
      if (!e.target.closest('#contextMenu') && !e.target.closest('#elementContextMenu')) {
        hideContextMenu();
        hideElementContextMenu();
      }
    });

    function addHere(tool) {
      addElementAt(tool, contextMenuState.row, contextMenuState.col, null);
    }

    // Handle context menu item clicks
    document.querySelectorAll('#contextMenu .context-menu-item[data-action]').forEach(function(item) {
      item.addEventListener('click', function(e) {
        var action = this.getAttribute('data-action');
        if (!action) return;
        
        e.stopPropagation();
        e.preventDefault();
        hideContextMenu();
        
        switch(action) {
          case 'add-text': addHere('text'); break;
          case 'add-field': addHere('field'); break;
          case 'add-button-select': addHere('button'); break;
          case 'add-button-checkbox': addHere('checkbox'); break;
          case 'add-button-radio': addHere('radio'); break;
          case 'add-preview': addHere('preview'); break;
          case 'add-image': addHere('image'); break;
        }
      });
    });

    // Handle element context menu item clicks
    document.querySelectorAll('#elementContextMenu .context-menu-item[data-action]').forEach(function(item) {
      item.addEventListener('click', function(e) {
        var action = this.getAttribute('data-action');
        if (!action) return;
        
        e.stopPropagation();
        e.preventDefault();
        hideElementContextMenu();
        
        var elementType = elementContextMenuState.elementType;
        var elementIndex = elementContextMenuState.elementIndex;
        
        switch(action) {
          case 'edit-element':
            focusPropsPanel(elementContextMenuState.element);
            break;
          case 'move-element':
            focusPropsPanel(elementContextMenuState.element, 'tabs');
            break;
          case 'toggle-box':
            if (elementContextMenuState.element) toggleTextBox(elementContextMenuState.element);
            break;
          case 'duplicate-element':
            if (elementContextMenuState.group) {
              duplicateSelected();
            } else if (elementType === 'bgimage') {
              setSelection([], null, null, null, [elementContextMenuState.element]);
              duplicateSelected();
            } else if (elementContextMenuState.element) {
              selectElement(elementContextMenuState.element);
              duplicateSelected();
            }
            break;
          case 'delete-element':
            deleteElements(elementContextMenuState.group || [elementContextMenuState.element].filter(Boolean));
            break;
          case 'show-in-source':
            // Send message to VS Code to reveal the line in the editor
            if (vscodeApi && vscodeApi.postMessage) {
              vscodeApi.postMessage({
                command: 'showInSource',
                elementType: elementType,
                elementIndex: elementIndex
              });
            }
            break;
        }
      });
    });

    // Setup modal action handlers
    setupHeaderEdit();
    setupTextEdit();
    setupFieldModal();
    setupButtonModal();
    setupPreviewModal();
    setupImageModal();
    setupBackgroundModal();
    setupTriggerModal();

    // Setup document-level context menu for outside-grid clicks
    document.addEventListener('contextmenu', function(e) {
      var grid = document.querySelector('.grid');
      if (grid && !grid.contains(e.target)) {
        e.preventDefault();
        e.stopPropagation();
        hideContextMenu();
        hideElementContextMenu();
        showOutsideContextMenu(e.clientX, e.clientY);
      }
    });

    // Hide outside context menu when clicking elsewhere
    document.addEventListener('click', function(e) {
      if (!e.target.closest('#outsideContextMenu')) {
        hideOutsideContextMenu();
      }
    });

    // Handle outside context menu clicks
    document.querySelectorAll('#outsideContextMenu .context-menu-item[data-action]').forEach(function(item) {
      item.addEventListener('click', function(e) {
        var action = this.getAttribute('data-action');
        if (!action) return;
        
        e.stopPropagation();
        e.preventDefault();
        hideOutsideContextMenu();
        
        if (action === 'add-trigger') {
          document.getElementById('triggerModalTitle').textContent = 'Add Trigger';
          document.getElementById('triggerModal').removeAttribute('data-edit-mode');
          document.getElementById('triggerModal').removeAttribute('data-edit-index');
          showModal('triggerModal');
        }
      });
    });
  }

  // ---------------------------------------------------------------------
  // In-place editing: the window header and texts turn into an input where they are drawn.
  // Enter or clicking away saves, Esc cancels; an empty or unchanged value saves nothing.
  // ---------------------------------------------------------------------
  var inlineEdit = null; // { input, finish(commit) } while an input is open

  function openInlineInput(host, value, onDone, minChars) {
    if (inlineEdit) inlineEdit.finish(true);
    var input = document.createElement('input');
    input.type = 'text';
    input.className = 'inline-edit';
    input.spellcheck = false;
    input.value = value;
    function fit() { input.style.width = (Math.max(input.value.length, minChars || 4) + 1) + 'ch'; }
    fit();
    var done = false;
    function finish(commit) {
      if (done) return;
      done = true;
      inlineEdit = null;
      var v = input.value.trim();
      input.remove();
      onDone(commit && v ? v : null);
    }
    input.addEventListener('input', fit);
    input.addEventListener('keydown', function(e) {
      if (e.key === 'Enter') { e.preventDefault(); finish(true); }
      else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
      e.stopPropagation(); // keys belong to the input, not the canvas
    });
    input.addEventListener('blur', function() { finish(true); });
    ['pointerdown', 'mousedown', 'click', 'dblclick', 'contextmenu', 'dragstart'].forEach(function(t) {
      input.addEventListener(t, function(e) { e.stopPropagation(); });
    });
    host.appendChild(input);
    inlineEdit = { input: input, finish: finish };
    input.focus();
    input.select();
    return input;
  }

  function setupHeaderEdit() {
    var caption = document.querySelector('.titlebar .caption');
    var titleEl = document.querySelector('.titlebar .title');
    if (!caption || !titleEl) return;
    caption.addEventListener('dblclick', function(e) {
      if (inlineEdit && inlineEdit.input.parentNode === caption) return;
      e.preventDefault();
      e.stopPropagation();
      var old = titleEl.textContent || '';
      titleEl.classList.add('hidden');
      openInlineInput(caption, old, function(v) {
        titleEl.classList.remove('hidden');
        if (v == null || v === old) return;
        titleEl.textContent = v;
        if (vscodeApi && vscodeApi.postMessage) vscodeApi.postMessage({ command: 'updateHeader', title: v });
      }, 8);
    });
  }

  // Edit an existing text in place (double-click, F2/Enter, or Edit in its context menu)
  function startTextEdit(el) {
    if (!el || el.getAttribute('data-type') !== 'text' || tabOrderMode) return;
    var info = collectElementInfo(el);
    if (!isFinite(info.index)) return;
    var old = info.data.content || '';
    var label = Array.prototype.filter.call(el.childNodes, function(n) { return n.nodeType === 3; });
    selectElement(el);
    label.forEach(function(n) { n.remove(); });
    el.setAttribute('draggable', 'false');
    el.classList.add('inline-editing');
    openInlineInput(el, old, function(v) {
      el.classList.remove('inline-editing');
      el.setAttribute('draggable', 'true');
      var changed = v != null && v !== old;
      if (changed) el.appendChild(document.createTextNode(v)); // shown until the preview refreshes
      else label.forEach(function(n) { el.appendChild(n); });
      fitTextSpans();
      restoreCanvasFocus();
      if (!changed || !vscodeApi || !vscodeApi.postMessage) return;
      vscodeApi.postMessage({
        command: 'editElement',
        elementType: 'text',
        elementIndex: info.index,
        row: info.data.row,
        col: info.data.col,
        content: v,
        boxRows: info.data.boxRows || null,
        boxCols: info.data.boxCols || null
      });
    });
  }

  // Add Text: an empty input at the clicked cell; nothing is written unless it gets text
  function startNewTextEdit(row, col) {
    var grid = document.querySelector('.grid');
    if (!grid || !isFinite(row) || !isFinite(col) || tabOrderMode) return;
    var host = document.createElement('div');
    host.className = 'text inline-new';
    host.style.gridRow = String(row);
    host.style.gridColumn = col + ' / span 1';
    grid.appendChild(host);
    openInlineInput(host, '', function(v) {
      if (v == null) { host.remove(); restoreCanvasFocus(); disarm(); return; }
      host.textContent = v; // shown until the preview refreshes
      restoreCanvasFocus();
      if (!vscodeApi || !vscodeApi.postMessage) return;
      vscodeApi.postMessage({
        command: 'addElement',
        elementType: 'text',
        row: row,
        col: col,
        content: v,
        boxRows: null,
        boxCols: null,
        activeTabId: tabs.length > 0 ? currentActiveTab : undefined
      });
    });
  }

  // Double-click: a text is edited where it is drawn, other elements in the Properties panel
  function setupTextEdit() {
    document.addEventListener('dblclick', function(e) {
      if (tabOrderMode || e.target.closest('.inline-edit, .el-resize, .box-resize, .lv-col')) return;
      var el = e.target.closest('.grid > .draggable');
      if (!el) return;
      e.preventDefault();
      e.stopPropagation();
      if (el.classList.contains('text') && el.hasAttribute('data-text-idx')) startTextEdit(el);
      else focusPropsPanel(el);
    });
  }

  // Add Box / Remove Box from a text's context menu. The label keeps its place on screen:
  // a boxed label is drawn BOX_OFFSET columns in from the box corner, which is the text's file column.
  function toggleTextBox(el) {
    var info = collectElementInfo(el);
    if (!isFinite(info.index) || !vscodeApi || !vscodeApi.postMessage) return;
    var row = info.data.row, col = info.data.col;
    if (el.hasAttribute('data-box-rows')) {
      vscodeApi.postMessage({ command: 'setTextBox', index: info.index, col: col + BOX_OFFSET, boxRows: null });
      return;
    }
    var newCol = Math.max(1, col - BOX_OFFSET);
    var minCols = boxMinCols(el);
    var cols = Math.max(minCols, Math.min(Math.max(20, minCols), gridCols - newCol + 1));
    var rows = Math.max(1, Math.min(5, gridRows - row)); // drawn rows + 1 tall
    vscodeApi.postMessage({ command: 'setTextBox', index: info.index, col: newCol, boxRows: rows, boxCols: cols });
  }

  function setupFieldModal() {
    var modal = document.getElementById('fieldModal');
    if (!modal) return;

    // Update type field when checkboxes change
    function updateFieldTypeFromCheckboxes() {
      var checkboxes = [
        document.getElementById('fieldType1'),
        document.getElementById('fieldType4'),
        document.getElementById('fieldType8'),
        document.getElementById('fieldType16'),
        document.getElementById('fieldType32'),
        document.getElementById('fieldType64'),
        document.getElementById('fieldType128'),
        document.getElementById('fieldType256'),
        document.getElementById('fieldType512'),
        document.getElementById('fieldType1024'),
        document.getElementById('fieldType2048'),
        document.getElementById('fieldType4096'),
        document.getElementById('fieldType8192'),
        document.getElementById('fieldType16384'),
        document.getElementById('fieldType32768')
      ];
      var selectedValues = checkboxes
        .filter(function(cb) { return cb && cb.checked; })
        .map(function(cb) { return cb.value; });
      
      var typeExpr = selectedValues.length > 0 ? selectedValues.join('+') : '1';
      document.getElementById('fieldType').value = typeExpr;
    }

    // Update checkboxes when user types in the field
    function updateCheckboxesFromFieldType() {
      var typeInput = document.getElementById('fieldType');
      var typeExpr = typeInput.value.trim();
      var typeValues = typeExpr.split('+').map(function(v) { return v.trim(); });
      
      // Update checkboxes based on typed expression
      document.getElementById('fieldType1').checked = typeValues.includes('1');
      document.getElementById('fieldType4').checked = typeValues.includes('4');
      document.getElementById('fieldType8').checked = typeValues.includes('8');
      document.getElementById('fieldType16').checked = typeValues.includes('16');
      document.getElementById('fieldType32').checked = typeValues.includes('32');
      document.getElementById('fieldType64').checked = typeValues.includes('64');
      document.getElementById('fieldType128').checked = typeValues.includes('128');
      document.getElementById('fieldType256').checked = typeValues.includes('256');
      document.getElementById('fieldType512').checked = typeValues.includes('512');
      document.getElementById('fieldType1024').checked = typeValues.includes('1024');
      document.getElementById('fieldType2048').checked = typeValues.includes('2048');
      document.getElementById('fieldType4096').checked = typeValues.includes('4096');
      document.getElementById('fieldType8192').checked = typeValues.includes('8192');
      document.getElementById('fieldType16384').checked = typeValues.includes('16384');
      document.getElementById('fieldType32768').checked = typeValues.includes('32768');
    }

    // Attach change listeners to checkboxes
    ['fieldType1', 'fieldType4', 'fieldType8', 'fieldType16', 'fieldType32', 'fieldType64', 'fieldType128', 'fieldType256', 'fieldType512', 'fieldType1024', 'fieldType2048', 'fieldType4096', 'fieldType8192', 'fieldType16384', 'fieldType32768'].forEach(function(id) {
      var checkbox = document.getElementById(id);
      if (checkbox) {
        checkbox.addEventListener('change', updateFieldTypeFromCheckboxes);
      }
    });

    // Attach input listener to the text field
    var fieldTypeInput = document.getElementById('fieldType');
    if (fieldTypeInput) {
      fieldTypeInput.addEventListener('input', updateCheckboxesFromFieldType);
    }

    // Cancel button
    modal.querySelector('[data-action="cancel"]').addEventListener('click', function() {
      hideModal('fieldModal');
      clearFieldModal();
    });

    function submitField(forceHidden) {
      var name = document.getElementById('fieldName').value.trim().toUpperCase();
      var type = document.getElementById('fieldType').value.trim();
      var len = parseInt(document.getElementById('fieldLen').value);
      var ignore = parseInt(document.getElementById('fieldIgnore').value);
      var valuesText = document.getElementById('fieldValues').value.trim();

      if (!name || !/^[$A-Z0-9_]+$/.test(name)) {
        // Skip if invalid field name
        return;
      }

      if (!type) {
        // Skip if no field type
        return;
      }

      if (!len || len < 1) {
        // Skip if invalid field length
        return;
      }

      // Parse values (can be one per line or quoted values)
      var values = [];
      if (valuesText) {
        // Try to extract quoted values first
        var quotedMatches = valuesText.match(/"([^"]+)"/g);
        if (quotedMatches) {
          values = quotedMatches.map(function(v) { return v.slice(1, -1); });
        } else {
          // Split by newlines
          values = valuesText.split('\n').map(function(v) { return v.trim(); }).filter(Boolean);
        }
      }

      var isEditMode = modal.getAttribute('data-edit-mode') === 'true';
      var editIndex = parseInt(modal.getAttribute('data-edit-index'));
      var targetRow = forceHidden ? 1000 : contextMenuState.row;
      var targetCol = forceHidden ? 1000 : contextMenuState.col;

      // Send to VS Code
      if (vscodeApi && vscodeApi.postMessage) {
        if (isEditMode && editIndex) {
          // Edit existing element
          var elementData = elementContextMenuState.elementData;
          if (!forceHidden && elementData) {
            targetRow = elementData.row;
            targetCol = elementData.col;
          }
          var nameFormatAttr = modal.getAttribute('data-nameformat');
          var nameFormat = {};
          try {
            nameFormat = nameFormatAttr ? JSON.parse(nameFormatAttr) : {};
          } catch {
            nameFormat = {};
          }
          // Update with current checkbox values
          nameFormat.angle = document.getElementById('fieldNameAngle').checked;
          nameFormat.quoted = document.getElementById('fieldNameQuoted').checked;
          vscodeApi.postMessage({
            command: 'editElement',
            elementType: 'field',
            elementIndex: editIndex,
            row: targetRow,
            col: targetCol,
            name: name,
            nameFormat: nameFormat,
            type: type,
            len: len,
            ignore: ignore,
            values: values
          });
        } else {
          // Add new element
          var newNameFormat = {
            angle: document.getElementById('fieldNameAngle').checked,
            quoted: document.getElementById('fieldNameQuoted').checked
          };
          vscodeApi.postMessage({
            command: 'addElement',
            elementType: 'field',
            row: targetRow,
            col: targetCol,
            name: name,
            nameFormat: newNameFormat,
            type: type,
            len: len,
            ignore: ignore,
            values: values,
            activeTabId: tabs.length > 0 ? currentActiveTab : undefined
          });
        }
      }

      hideModal('fieldModal');
      clearFieldModal();
      modal.removeAttribute('data-edit-mode');
      modal.removeAttribute('data-edit-index');
      modal.removeAttribute('data-nameformat');
      document.getElementById('fieldModalTitle').textContent = 'Add Field';
    }

    // Confirm button
    modal.querySelector('[data-action="confirm-field"]').addEventListener('click', function() {
      submitField(false);
    });

    // Hide button
    modal.querySelector('[data-action="hide-field"]').addEventListener('click', function() {
      submitField(true);
    });
  }

  // Hint under the dropdown values: what each "path:<name>" resolves to (asked of the extension)
  function updateFieldValuesHint() {
    var ta = document.getElementById('fieldValues');
    var hint = document.getElementById('fieldValuesHint');
    if (!ta || !hint) return;
    var names = [];
    var re = /path:([^"\s]+)/gi;
    var m;
    while ((m = re.exec(ta.value)) !== null) {
      if (names.indexOf(m[1]) === -1) names.push(m[1]);
    }
    window.__frmFvHintRequest = (window.__frmFvHintRequest || 0) + 1;
    if (names.length === 0 || !vscodeApi) {
      hint.textContent = '';
      return;
    }
    vscodeApi.postMessage({ command: 'resolveFieldValues', names: names, requestId: window.__frmFvHintRequest });
  }
  if (!window.__frmFvHintListener) {
    // Installed once per page; this script re-runs on every in-place update
    window.__frmFvHintListener = true;
    window.addEventListener('message', function(ev) {
      var msg = ev.data;
      if (!msg || msg.command !== 'fieldValuesResolved' || msg.requestId !== window.__frmFvHintRequest) return;
      var hint = document.getElementById('fieldValuesHint');
      if (hint) hint.textContent = (msg.lines || []).join('\n');
    });
  }
  (function() {
    var ta = document.getElementById('fieldValues');
    if (!ta) return;
    var timer;
    ta.addEventListener('input', function() {
      clearTimeout(timer);
      timer = setTimeout(updateFieldValuesHint, 200);
    });
  })();

  function clearFieldModal() {
    document.getElementById('fieldName').value = '';
    document.getElementById('fieldType').value = '1';
    document.getElementById('fieldLen').value = '10';
    document.getElementById('fieldIgnore').value = defaultIgnoreValue;
    document.getElementById('fieldValues').value = '';
    updateFieldValuesHint();
    
    // Reset checkboxes to default (only fieldType1 checked)
    document.getElementById('fieldType1').checked = true;
    document.getElementById('fieldType4').checked = false;
    document.getElementById('fieldType8').checked = false;
    document.getElementById('fieldType16').checked = false;
    document.getElementById('fieldType32').checked = false;
    document.getElementById('fieldType64').checked = false;
    document.getElementById('fieldType128').checked = false;
    document.getElementById('fieldType256').checked = false;
    document.getElementById('fieldType512').checked = false;
    document.getElementById('fieldType1024').checked = false;
    document.getElementById('fieldType2048').checked = false;
    document.getElementById('fieldType4096').checked = false;
    document.getElementById('fieldType8192').checked = false;
    document.getElementById('fieldType16384').checked = false;
    document.getElementById('fieldType32768').checked = false;
    
    // Reset name format checkboxes
    document.getElementById('fieldNameAngle').checked = false;
    document.getElementById('fieldNameQuoted').checked = false;
  }

  function setupButtonModal(title) {
    var modal = document.getElementById('buttonModal');
    if (!modal) return;

    // Set title if provided
    if (title) {
      var titleEl = document.getElementById('buttonModalTitle');
      if (titleEl) titleEl.textContent = 'Add ' + title;
    }

    // Show/hide fields based on button type
    var actionType = document.getElementById('buttonActionType');
    var programField = document.getElementById('buttonProgramField');
    var variableField = document.getElementById('buttonVariableField');
    var valueField = document.getElementById('buttonValueField');
    var typeField = document.getElementById('buttonTypeField');

    // For checkbox and radio, show variable/value fields
    if (contextMenuState.buttonType === 'checkbox' || contextMenuState.buttonType === 'radio') {
      if (typeField) typeField.classList.add('hidden');
      if (programField) programField.classList.add('hidden');
      if (variableField) variableField.classList.remove('hidden');
      if (valueField) valueField.classList.remove('hidden');
    } else {
      // For general button, show action type selector
      if (typeField) typeField.classList.remove('hidden');
      updateButtonFieldVisibility();
    }

    // Handle action type change
    if (actionType) {
      actionType.removeEventListener('change', updateButtonFieldVisibility); // Remove old listener
      actionType.addEventListener('change', updateButtonFieldVisibility);
    }

    // Sync select dropdown with text input
    var variableSelect = document.getElementById('buttonVariableSelect');
    var variableInput = document.getElementById('buttonVariable');
    if (variableSelect && variableInput) {
      // When dropdown changes, update text input
      variableSelect.addEventListener('change', function() {
        if (this.value) {
          variableInput.value = this.value;
        }
      });
      // When text input changes, clear dropdown selection if it doesn't match
      variableInput.addEventListener('input', function() {
        var inputVal = this.value.toUpperCase();
        var matchFound = false;
        for (var i = 0; i < variableSelect.options.length; i++) {
          if (variableSelect.options[i].value === inputVal) {
            variableSelect.selectedIndex = i;
            matchFound = true;
            break;
          }
        }
        if (!matchFound) {
          variableSelect.selectedIndex = 0; // Reset to placeholder
        }
      });
    }

    // Cancel button
    var cancelBtn = modal.querySelector('[data-action="cancel"]');
    if (cancelBtn) {
      var newCancelBtn = cancelBtn.cloneNode(true);
      cancelBtn.parentNode.replaceChild(newCancelBtn, cancelBtn);
      newCancelBtn.addEventListener('click', function() {
        hideModal('buttonModal');
        clearButtonModal();
      });
    }

    // Confirm button
    var confirmBtn = modal.querySelector('[data-action="confirm-button"]');
    if (confirmBtn) {
      var newConfirmBtn = confirmBtn.cloneNode(true);
      confirmBtn.parentNode.replaceChild(newConfirmBtn, confirmBtn);
      newConfirmBtn.addEventListener('click', function() {
        var label = document.getElementById('buttonLabel').value.trim();

        var isEditMode = modal.getAttribute('data-edit-mode') === 'true';
        var editIndex = parseInt(modal.getAttribute('data-edit-index'));

        var data = {
          command: isEditMode && editIndex ? 'editElement' : 'addElement',
          elementType: 'pushbutton',
          row: isEditMode ? elementContextMenuState.elementData.row : contextMenuState.row,
          col: isEditMode ? elementContextMenuState.elementData.col : contextMenuState.col,
          label: label,
          kind: contextMenuState.buttonType
        };

        if (isEditMode && editIndex) {
          data.elementIndex = editIndex;
        }

        var variable, value;
        // For checkbox/radio, get variable and value
        if (contextMenuState.buttonType === 'checkbox' || contextMenuState.buttonType === 'radio') {
          variable = document.getElementById('buttonVariable').value.trim().toUpperCase();
          value = document.getElementById('buttonValue').value.trim();

          if (!variable) {
            // Skip if no variable name
            return;
          }

          data.name = variable;
          data.value = contextMenuState.buttonType === 'checkbox' ? value || '1;0' : value;
        } else {
          // For general button, get action
          var actionTypeVal = document.getElementById('buttonActionType').value;
          
          if (actionTypeVal === 'program') {
            var program = document.getElementById('buttonProgram').value.trim();
            if (!program) {
              // Skip if no program call
              return;
            }
            // Ensure @ prefix
            if (!program.startsWith('@')) {
              program = '@' + program;
            }
            data.program = program;
          } else {
            variable = document.getElementById('buttonVariable').value.trim().toUpperCase();
            value = document.getElementById('buttonValue').value.trim();
            
            if (!variable) {
              // Skip if no variable name
              return;
            }
            
            data.name = variable;
            data.value = value;
          }
        }

        // Send to VS Code
        if (vscodeApi && vscodeApi.postMessage) {
          if (!isEditMode) {
            data.activeTabId = tabs.length > 0 ? currentActiveTab : undefined;
          }
          vscodeApi.postMessage(data);
        }

        hideModal('buttonModal');
        clearButtonModal();
        modal.removeAttribute('data-edit-mode');
        modal.removeAttribute('data-edit-index');
        document.getElementById('buttonModalTitle').textContent = 'Add Button';
      });
    }
  }

  function setupPreviewModal() {
    var modal = document.getElementById('previewModal');
    if (!modal) return;

    // Cancel button
    var cancelBtn = modal.querySelector('[data-action="cancel"]');
    if (cancelBtn) {
      var newCancelBtn = cancelBtn.cloneNode(true);
      cancelBtn.parentNode.replaceChild(newCancelBtn, cancelBtn);
      newCancelBtn.addEventListener('click', function() {
        hideModal('previewModal');
        modal.removeAttribute('data-edit-mode');
        modal.removeAttribute('data-edit-index');
        document.getElementById('previewModalTitle').textContent = 'Add Preview';
      });
    }

    // Confirm button
    var confirmBtn = modal.querySelector('[data-action="confirm-preview"]');
    if (confirmBtn) {
      var newConfirmBtn = confirmBtn.cloneNode(true);
      confirmBtn.parentNode.replaceChild(newConfirmBtn, confirmBtn);
      newConfirmBtn.addEventListener('click', function() {
        var path = document.getElementById('previewPath').value.trim();
        var field = document.getElementById('previewField').value.trim();
        var rows = parseInt(document.getElementById('previewRows').value) || 25;
        var cols = parseInt(document.getElementById('previewCols').value) || 72;
        var mode = document.getElementById('previewMode').value.trim() || '0';
        var portType = document.getElementById('previewPortType').value || 'PORT_2D';
        var portStyle = document.getElementById('previewPortStyle').value;
        if (portStyle === undefined || portStyle === null) {
          portStyle = 'SIMPLE';
        }

        if (!path) {
          return;
        }

        var isEditMode = modal.getAttribute('data-edit-mode') === 'true';
        var editIndex = parseInt(modal.getAttribute('data-edit-index'));

        var data = {
          command: isEditMode && editIndex ? 'editElement' : 'addElement',
          elementType: 'preview',
          row: isEditMode ? elementContextMenuState.elementData.row : contextMenuState.row,
          col: isEditMode ? elementContextMenuState.elementData.col : contextMenuState.col,
          path: path,
          field: field,
          rows: rows,
          cols: cols,
          mode: mode,
          portType: portType,
          portStyle: portStyle
        };

        if (isEditMode && editIndex) {
          data.elementIndex = editIndex;
        }

        // Send to VS Code
        if (vscodeApi && vscodeApi.postMessage) {
          if (!isEditMode) {
            data.activeTabId = tabs.length > 0 ? currentActiveTab : undefined;
          }
          vscodeApi.postMessage(data);
        }

        hideModal('previewModal');
        modal.removeAttribute('data-edit-mode');
        modal.removeAttribute('data-edit-index');
        document.getElementById('previewModalTitle').textContent = 'Add Preview';
      });
    }
  }

  function updateButtonFieldVisibility() {
    var actionType = document.getElementById('buttonActionType');
    var programField = document.getElementById('buttonProgramField');
    var variableField = document.getElementById('buttonVariableField');
    var valueField = document.getElementById('buttonValueField');

    if (!actionType) return;

    if (actionType.value === 'program') {
      if (programField) programField.classList.remove('hidden');
      if (variableField) variableField.classList.add('hidden');
      if (valueField) valueField.classList.add('hidden');
    } else {
      if (programField) programField.classList.add('hidden');
      if (variableField) variableField.classList.remove('hidden');
      if (valueField) valueField.classList.remove('hidden');
    }
  }

  function clearButtonModal() {
    document.getElementById('buttonLabel').value = '';
    document.getElementById('buttonProgram').value = '';
    document.getElementById('buttonVariable').value = '';
    document.getElementById('buttonValue').value = '';
    document.getElementById('buttonActionType').value = 'program';
  }

  function setupTriggerModal() {
    var modal = document.getElementById('triggerModal');
    if (!modal) return;

    // Handle program dropdown change
    var programSelect = document.getElementById('triggerProgramSelect');
    var programInput = document.getElementById('triggerProgram');
    var createSection = document.getElementById('triggerCreateSection');
    var createCheckbox = document.getElementById('triggerCreateFile');
    var openSection = document.getElementById('triggerOpenSection');
    var openCheckbox = document.getElementById('triggerOpenFile');
    
    if (programSelect && programInput && createSection) {
      programSelect.addEventListener('change', function() {
        if (this.value === '__custom__') {
          programInput.style.display = 'block';
          createSection.style.display = 'block';
          programInput.focus();
        } else {
          programInput.style.display = 'none';
          createSection.style.display = 'none';
          programInput.value = '';
          if (createCheckbox) createCheckbox.checked = false;
          if (openSection) openSection.style.display = 'none';
          if (openCheckbox) openCheckbox.checked = false;
        }
      });
    }

    // Handle create file checkbox change
    if (createCheckbox && openSection) {
      createCheckbox.addEventListener('change', function() {
        if (this.checked) {
          openSection.style.display = 'block';
        } else {
          openSection.style.display = 'none';
          if (openCheckbox) openCheckbox.checked = false;
        }
      });
    }

    // Cancel button
    modal.querySelector('[data-action="cancel"]').addEventListener('click', function() {
      hideModal('triggerModal');
      document.getElementById('triggerFieldIndex').selectedIndex = 0;
      if (programSelect) programSelect.selectedIndex = 0;
      if (programInput) {
        programInput.value = '';
        programInput.style.display = 'none';
      }
      if (createSection) createSection.style.display = 'none';
      if (createCheckbox) createCheckbox.checked = false;
      if (openSection) openSection.style.display = 'none';
      if (openCheckbox) openCheckbox.checked = false;
    });

    // Confirm button
    modal.querySelector('[data-action="confirm-trigger"]').addEventListener('click', function() {
      var fieldIndex = document.getElementById('triggerFieldIndex').value.trim();
      var program = '';
      
      if (programSelect && programInput) {
        if (programSelect.value === '__custom__') {
          program = programInput.value.trim();
        } else {
          program = programSelect.value.trim();
        }
      }

      if (fieldIndex === null || fieldIndex === undefined || fieldIndex === '') {
        // Skip if no target selected
        return;
      }

      if (!program) {
        // Skip if no program
        return;
      }

      // Get create file flags
      var createFile = createCheckbox ? createCheckbox.checked : false;
      var openFile = openCheckbox ? openCheckbox.checked : false;

      // Send to VS Code
      if (vscodeApi && vscodeApi.postMessage) {
        vscodeApi.postMessage({
          command: 'addTrigger',
          fieldIndex: fieldIndex,
          program: program,
          createFile: createFile,
          openFile: openFile
        });
      }

      hideModal('triggerModal');
      document.getElementById('triggerFieldIndex').selectedIndex = 0;
      if (programSelect) programSelect.selectedIndex = 0;
      if (programInput) {
        programInput.value = '';
        programInput.style.display = 'none';
      }
      if (createSection) createSection.style.display = 'none';
      if (createCheckbox) createCheckbox.checked = false;
      if (openSection) openSection.style.display = 'none';
      if (openCheckbox) openCheckbox.checked = false;
    });

    // Enter key to confirm
    if (programInput) {
      programInput.addEventListener('keypress', function(e) {
        if (e.key === 'Enter') {
          modal.querySelector('[data-action="confirm-trigger"]').click();
        }
      });
    }
  }

  // Setup Edit Trigger Modal
  var editTriggerModal = document.getElementById('editTriggerModal');
  if (editTriggerModal) {
    // Handle program dropdown change
    var editProgramSelect = document.getElementById('editTriggerProgramSelect');
    var editProgramInput = document.getElementById('editTriggerProgram');
    var editCreateSection = document.getElementById('editTriggerCreateSection');
    var editCreateCheckbox = document.getElementById('editTriggerCreateFile');
    var editOpenSection = document.getElementById('editTriggerOpenSection');
    var editOpenCheckbox = document.getElementById('editTriggerOpenFile');
    
    if (editProgramSelect && editProgramInput && editCreateSection) {
      editProgramSelect.addEventListener('change', function() {
        if (this.value === '__custom__') {
          editProgramInput.style.display = 'block';
          editCreateSection.style.display = 'block';
          editProgramInput.focus();
        } else {
          editProgramInput.style.display = 'none';
          editCreateSection.style.display = 'none';
          editProgramInput.value = '';
          if (editCreateCheckbox) editCreateCheckbox.checked = false;
          if (editOpenSection) editOpenSection.style.display = 'none';
          if (editOpenCheckbox) editOpenCheckbox.checked = false;
        }
      });
    }

    // Handle create file checkbox change
    if (editCreateCheckbox && editOpenSection) {
      editCreateCheckbox.addEventListener('change', function() {
        if (this.checked) {
          editOpenSection.style.display = 'block';
        } else {
          editOpenSection.style.display = 'none';
          if (editOpenCheckbox) editOpenCheckbox.checked = false;
        }
      });
    }

    // Cancel button
    editTriggerModal.querySelectorAll('[data-action="cancel"]').forEach(function(btn) {
      btn.addEventListener('click', function() {
        hideModal('editTriggerModal');
        if (editProgramSelect) editProgramSelect.selectedIndex = 0;
        if (editProgramInput) {
          editProgramInput.value = '';
          editProgramInput.style.display = 'none';
        }
        if (editCreateSection) editCreateSection.style.display = 'none';
        if (editCreateCheckbox) editCreateCheckbox.checked = false;
        if (editOpenSection) editOpenSection.style.display = 'none';
        if (editOpenCheckbox) editOpenCheckbox.checked = false;
      });
    });

    // Confirm button
    editTriggerModal.querySelector('[data-action="confirm-edit-trigger"]').addEventListener('click', function() {
      var target = document.getElementById('editTriggerTarget').value.trim();
      var program = '';
      
      if (editProgramSelect && editProgramInput) {
        if (editProgramSelect.value === '__custom__') {
          program = editProgramInput.value.trim();
        } else {
          program = editProgramSelect.value.trim();
        }
      }
      
      var flag = document.getElementById('editTriggerFlag').value.trim();
      var line = parseInt(document.getElementById('editTriggerLine').value);
      
      if (!target || !program) {
        // Skip if target or program missing
        return;
      }

      // Get create file flags
      var createFile = editCreateCheckbox ? editCreateCheckbox.checked : false;
      var openFile = editOpenCheckbox ? editOpenCheckbox.checked : false;
      
      if (vscodeApi && vscodeApi.postMessage) {
        vscodeApi.postMessage({ 
          type: 'editTrigger', 
          line: line, 
          target: target, 
          program: program, 
          flag: flag,
          createFile: createFile,
          openFile: openFile
        });
      }
      
      hideModal('editTriggerModal');
      if (editProgramSelect) editProgramSelect.selectedIndex = 0;
      if (editProgramInput) {
        editProgramInput.value = '';
        editProgramInput.style.display = 'none';
      }
      if (editCreateSection) editCreateSection.style.display = 'none';
      if (editCreateCheckbox) editCreateCheckbox.checked = false;
      if (editOpenSection) editOpenSection.style.display = 'none';
      if (editOpenCheckbox) editOpenCheckbox.checked = false;
    });
  }

  // Global functions for trigger management
  function addNewTrigger() {
    showModal('triggerModal');
  }

  function editTrigger(idx, line, target, program, flag) {
    var selectElem = document.getElementById('editTriggerTarget');
    selectElem.value = target;
    
    // Handle program dropdown and input
    var editProgramSelect = document.getElementById('editTriggerProgramSelect');
    var editProgramInput = document.getElementById('editTriggerProgram');
    
    if (editProgramSelect && editProgramInput) {
      // Check if the program exists in the dropdown
      var optionExists = false;
      for (var i = 0; i < editProgramSelect.options.length; i++) {
        if (editProgramSelect.options[i].value === program) {
          optionExists = true;
          editProgramSelect.value = program;
          editProgramInput.style.display = 'none';
          editProgramInput.value = '';
          break;
        }
      }
      
      // If program not in dropdown, use custom input
      if (!optionExists) {
        editProgramSelect.value = '__custom__';
        editProgramInput.style.display = 'block';
        editProgramInput.value = program;
      }
    }
    
    document.getElementById('editTriggerFlag').value = flag;
    document.getElementById('editTriggerLine').value = line;
    showModal('editTriggerModal');
  }

  function deleteTrigger(idx, line, target, program, flag) {
    if (tabOrderMode) return;
    if (vscodeApi && vscodeApi.postMessage) {
      vscodeApi.postMessage({ type: 'deleteTrigger', target: target, program: program, flag: flag });
    }
  }

  function deleteHiddenField(event, fieldIndex) {
    if (tabOrderMode) {
      if (event) { event.stopPropagation(); event.preventDefault(); }
      return;
    }
    if (event) {
      event.stopPropagation();
      event.preventDefault();
    }
    if (vscodeApi && vscodeApi.postMessage) {
      vscodeApi.postMessage({
        command: 'deleteElements',
        elements: [{ type: 'field', index: fieldIndex }]
      });
    }
  }

  function showHiddenFieldInSource(fieldIndex) {
    if (tabOrderMode) return;
    if (vscodeApi && vscodeApi.postMessage) {
      vscodeApi.postMessage({
        command: 'showInSource',
        elementType: 'field',
        elementIndex: fieldIndex
      });
    }
  }

  // Add context menu handler for trigger items
  document.querySelectorAll('.trigger-item').forEach(function(triggerItem) {
    triggerItem.addEventListener('contextmenu', function(e) {
      e.preventDefault();
      e.stopPropagation();
      
      if (this.classList.contains('bg-item')) {
        if (tabOrderMode) return;
        var info = collectElementInfo(this);
        if (!isFinite(info.index)) { showNotice('A background without an index can\'t be edited here'); return; }
        showElementContextMenu(e.clientX, e.clientY, this, info.type, info.index, info.data);
        return;
      }
      var programName = this.getAttribute('data-trigger-program');
      if (programName && vscodeApi && vscodeApi.postMessage) {
        vscodeApi.postMessage({
          type: 'openTriggerProgram',
          program: programName
        });
      }
    });
  });

  // Make functions global
  window.addNewTrigger = addNewTrigger;
  window.editTrigger = editTrigger;
  window.deleteTrigger = deleteTrigger;
  window.deleteHiddenField = deleteHiddenField;
  window.showHiddenFieldInSource = showHiddenFieldInSource;

  // ---- Image dialog -------------------------------------------------------------------------------
  var IMAGE_LIST_MAX = 200;
  var imageFiles = null; // from the extension: { name, custom, src }; null until they arrive
  var imageEditing = null; // the edited image's { index, data }; null when adding
  var imageSizeTouched = false; // the size was drawn or typed, so choosing a file leaves it alone

  function splitImageMode(expr) {
    if (!/^\d+(\+\d+)*$/.test(expr)) return null;
    return expr.split('+').reduce(function(all, n) { return all | Number(n); }, 0);
  }

  function joinImageMode(bits) {
    var parts = [];
    for (var bit = 1; bit <= bits; bit *= 2) if (bits & bit) parts.push(bit);
    return parts.join('+') || '0';
  }

  // Rows and columns an image of this many pixels covers at 100% zoom, shrunk to fit below and right of its cell
  function imageCells(width, height, row, col) {
    var probe = document.createElement('div');
    probe.style.cssText = 'position:absolute;visibility:hidden;white-space:nowrap;line-height:1;font:' + basePx + 'px "Times New Roman",Times,serif';
    probe.innerHTML = '<span>A</span><div style="height:var(--row-h)"></div>';
    document.body.appendChild(probe);
    var colW = Math.max(1, probe.firstChild.getBoundingClientRect().width - 1);
    var rowH = Math.max(1, probe.lastChild.getBoundingClientRect().height);
    probe.remove();
    var maxRows = Math.max(1, gridRows - row + 1), maxCols = Math.max(1, gridCols - col + 1);
    var scale = Math.min(1, maxCols * colW / width, maxRows * rowH / height);
    return {
      rows: Math.max(1, Math.min(maxRows, Math.round(height * scale / rowH))),
      cols: Math.max(1, Math.min(maxCols, Math.round(width * scale / colW)))
    };
  }

  function openImageModal(editing, size) {
    var modal = document.getElementById('imageModal');
    if (!modal) return;
    picker = 'image';
    imageEditing = editing;
    imageSizeTouched = !!(editing || size);
    var data = editing ? editing.data : { file: '', rows: size ? size.rows : 10, cols: size ? size.cols : 20, mode: '1+2' };
    document.getElementById('imageModalTitle').textContent = editing ? 'Edit Image' : 'Add Image';
    document.getElementById('imageFile').value = data.file;
    document.getElementById('imageRows').value = data.rows;
    document.getElementById('imageCols').value = data.cols;
    var bits = splitImageMode(data.mode);
    document.getElementById('imageModes').classList.toggle('hidden', bits === null);
    list('#imageModes input').forEach(function(box) { box.checked = bits !== null && !!(bits & Number(box.value)); });
    document.getElementById('imageModeNote').textContent = bits === null ? 'Type ' + data.mode + ' is kept as written' : '';
    document.getElementById('imageHint').textContent = '';
    imageFiles = null;
    renderImageList();
    showModal('imageModal');
    requestImages();
  }

  function requestImages() {
    if (vscodeApi) {
      window.__frmImageListRequest = (window.__frmImageListRequest || 0) + 1;
      vscodeApi.postMessage({ command: 'listImages', requestId: window.__frmImageListRequest });
    }
    checkImageName();
  }

  // Both dialogs with a file list; the ids of their parts start with picker
  var picker = 'image';
  function renderImageList() {
    var box = document.getElementById(picker + 'List');
    if (!box) return;
    box.textContent = '';
    function note(text) {
      var n = document.createElement('div');
      n.className = 'image-list-note';
      n.textContent = text;
      box.appendChild(n);
    }
    if (!imageFiles) { note('Loading…'); return; }
    var typed = document.getElementById(picker + 'File').value.trim().toLowerCase();
    var exact = imageFiles.some(function(f) { return f.name.toLowerCase() === typed; });
    // A chosen file shows the whole list again, so another one can be picked
    var shown = imageFiles.filter(function(f) { return exact || f.name.toLowerCase().indexOf(typed) >= 0; });
    if (!shown.length) note(imageFiles.length ? 'No file name contains this' : 'No images in custom/forms/images or system/forms/images');
    var at = exact ? shown.findIndex(function(f) { return f.name.toLowerCase() === typed; }) : 0;
    var from = Math.max(0, Math.min(at - IMAGE_LIST_MAX / 2, shown.length - IMAGE_LIST_MAX));
    var current = null;
    shown.slice(from, from + IMAGE_LIST_MAX).forEach(function(f) {
      var item = document.createElement('div');
      item.className = 'image-list-item';
      item.setAttribute('role', 'option');
      item.setAttribute('data-name', f.name);
      var thumb;
      if (/\.tiff?$/i.test(f.name)) {
        thumb = document.createElement('span');
        thumb.textContent = 'TIF';
      } else {
        thumb = document.createElement('img');
        thumb.loading = 'lazy';
        thumb.alt = '';
        thumb.src = f.src;
      }
      thumb.className = 'image-list-thumb';
      var name = document.createElement('span');
      name.className = 'image-list-name';
      name.textContent = f.name;
      var origin = document.createElement('span');
      origin.className = 'image-list-origin';
      origin.textContent = f.custom ? 'custom' : 'system';
      item.append(thumb, name, origin);
      if (f.name.toLowerCase() === typed) {
        item.classList.add('active');
        item.setAttribute('aria-selected', 'true');
        current = item;
      }
      box.appendChild(item);
    });
    if (shown.length > IMAGE_LIST_MAX) note(shown.length + ' files; type to narrow the list');
    if (current) box.scrollTop = current.offsetTop - box.offsetTop - 60;
  }

  // Is the typed file there, and how large is it
  function checkImageName() {
    var name = document.getElementById(picker + 'File').value.trim();
    var hint = document.getElementById(picker + 'Hint');
    var id = window.__frmImageRequest = (window.__frmImageRequest || 0) + 1;
    hint.textContent = '';
    if (!name || !vscodeApi) return;
    vscodeApi.postMessage({ command: 'resolveImage', name: name, requestId: id });
  }

  function onImageMessage(msg) {
    var modal = document.getElementById(picker + 'Modal');
    if (!modal || modal.classList.contains('hidden')) return;
    if (msg.command === 'imagesListed' && msg.requestId === window.__frmImageListRequest) {
      imageFiles = msg.images || [];
      renderImageList();
    } else if (msg.command === 'imageResolved' && msg.requestId === window.__frmImageRequest) {
      if (!msg.src) {
        var missing = document.getElementById(picker + 'File').value.trim();
        document.getElementById(picker + 'Hint').textContent = /[\\/]/.test(missing) ? 'Not found' : 'Not found in custom/forms/images or system/forms/images';
        return;
      }
      if (picker !== 'image' || imageSizeTouched) return;
      var img = new Image();
      img.onload = onCurrentPage(function() {
        if (imageSizeTouched || msg.requestId !== window.__frmImageRequest || !img.naturalWidth || !img.naturalHeight) return;
        var cells = imageCells(img.naturalWidth, img.naturalHeight, contextMenuState.row, contextMenuState.col);
        document.getElementById('imageRows').value = cells.rows;
        document.getElementById('imageCols').value = cells.cols;
      });
      img.src = msg.src;
    }
  }

  function setupImagePicker(ids) {
    var file = document.getElementById(ids + 'File');
    var box = document.getElementById(ids + 'List');
    var timer;
    function changed() {
      renderImageList();
      clearTimeout(timer);
      window.__frmImageRequest = (window.__frmImageRequest || 0) + 1; // answers for the previous name no longer count
      document.getElementById(ids + 'Hint').textContent = '';
      timer = setTimeout(checkImageName, 200);
    }
    function pick(item) {
      file.value = item.getAttribute('data-name');
      changed();
      file.focus();
    }
    file.addEventListener('input', changed);
    file.addEventListener('keydown', function(e) {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      var items = list('#' + ids + 'List .image-list-item');
      var at = items.findIndex(function(i) { return i.classList.contains('kbd-active'); });
      if (e.key === 'Enter' && at >= 0) {
        e.preventDefault();
        pick(items[at]);
      } else if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && items.length) {
        e.preventDefault();
        if (at < 0) at = items.findIndex(function(i) { return i.classList.contains('active'); });
        var next = Math.max(0, Math.min(items.length - 1, at + (e.key === 'ArrowDown' ? 1 : -1)));
        items.forEach(function(i, n) { i.classList.toggle('kbd-active', n === next); });
        items[next].scrollIntoView({ block: 'nearest' });
      }
    });
    box.addEventListener('mousedown', function(e) { if (e.target.closest('.image-list-item')) e.preventDefault(); });
    box.addEventListener('click', function(e) {
      var item = e.target.closest('.image-list-item');
      if (item) pick(item);
    });
  }

  function setupImageModal() {
    var modal = document.getElementById('imageModal');
    if (!modal) return;
    var file = document.getElementById('imageFile');
    setupImagePicker('image');
    ['imageRows', 'imageCols'].forEach(function(id) {
      document.getElementById(id).addEventListener('input', function() { imageSizeTouched = true; });
    });
    window.addEventListener('message', function(ev) {
      if (ev.data && (ev.data.command === 'imagesListed' || ev.data.command === 'imageResolved')) onImageMessage(ev.data);
    });

    modal.querySelector('[data-action="cancel"]').addEventListener('click', function() { hideModal('imageModal'); });
    modal.querySelector('[data-action="confirm-image"]').addEventListener('click', function() {
      var name = file.value.replace(/["{}]/g, '').trim();
      var rows = parseInt(document.getElementById('imageRows').value, 10);
      var cols = parseInt(document.getElementById('imageCols').value, 10);
      if (!name) {
        document.getElementById('imageHint').textContent = 'Enter a file name';
        file.focus();
        return;
      }
      if (!(rows >= 1) || !(cols >= 1)) return;
      var old = imageEditing ? imageEditing.data : null;
      var oldBits = old ? splitImageMode(old.mode) : 0;
      var bits = oldBits;
      if (bits !== null) {
        list('#imageModes input').forEach(function(b) { bits = b.checked ? bits | Number(b.value) : bits & ~Number(b.value); });
      }
      var data;
      if (old) {
        // Only what changed, so the rest of the line stays as written
        data = { command: 'editElement', elementType: 'image', elementIndex: imageEditing.index };
        if (name !== old.file) data.file = name;
        if (rows !== old.rows) data.rows = rows;
        if (cols !== old.cols) data.cols = cols;
        if (bits !== oldBits) data.mode = joinImageMode(bits);
      } else {
        data = {
          command: 'addElement', elementType: 'image', row: contextMenuState.row, col: contextMenuState.col,
          file: name, rows: rows, cols: cols, mode: joinImageMode(bits), activeTabId: tabs.length > 0 ? currentActiveTab : undefined
        };
      }
      hideModal('imageModal');
      if (vscodeApi && Object.keys(data).length > 3) vscodeApi.postMessage(data);
    });
  }

  // ---- Background dialog --------------------------------------------------------------------------
  var bgEditing = null; // the edited background's values; null when adding
  var BG_NEW = { width: -1, height: -1, transparency: 0, mode: 64, placement: 'FRAME', alignment: 'TOPLEFT', file: '', color: null };

  function bgKind() {
    var on = document.querySelector('#bgKinds input:checked');
    return on ? on.value : null;
  }

  function hex(color) {
    return '#' + color.map(function(c) { return (c < 16 ? '0' : '') + c.toString(16); }).join('');
  }

  // What the chosen kind and the readable values need
  function showBgControls() {
    var kind = bgKind();
    var kept = [];
    document.getElementById('bgKinds').classList.toggle('hidden', kind === null);
    if (kind === null) kept.push('file');
    list('#bgModal .bg-picture').forEach(function(el) { el.classList.toggle('hidden', kind === 'color'); });
    list('#bgModal [data-bg-part]:not(.bg-picture)').forEach(function(el) { el.classList.remove('hidden'); });
    list('#bgModal .bg-color').forEach(function(el) { el.classList.toggle('hidden', kind !== 'color'); });
    if (kind === null) document.getElementById('bgFile').parentElement.classList.add('hidden');
    list('#bgModal [data-bg-part]').forEach(function(el) {
      var part = el.getAttribute('data-bg-part');
      if (!bgEditing || bgEditing[part] !== null) return;
      if (!el.classList.contains('hidden')) kept.push(part);
      el.classList.add('hidden');
    });
    document.getElementById('bgKept').textContent = kept.length ? 'Kept as written: ' + kept.join(', ') : '';
    ['Width', 'Height'].forEach(function(side) {
      document.getElementById('bg' + side + 'Px').classList.toggle('hidden', document.getElementById('bg' + side).value !== 'px');
    });
    var t = Number(document.getElementById('bgTransparency').value);
    document.getElementById('bgTransparencyLabel').textContent = t + ' (' + Math.round((255 - t) / 2.55) + '% visible)';
  }

  // row: the edited background's row; null when adding
  function openBackgroundModal(row) {
    var modal = document.getElementById('bgModal');
    if (!modal) return;
    picker = 'bg';
    bgEditing = row ? JSON.parse(row.getAttribute('data-bg')) : null;
    var v = bgEditing || BG_NEW;
    document.getElementById('bgModalTitle').textContent = bgEditing ? 'Edit Background' : 'Add Background';
    var kind = v.file === null ? null : v.color ? 'color' : 'picture';
    list('#bgKinds input').forEach(function(r) { r.checked = r.value === kind; });
    document.getElementById('bgFile').value = v.color ? '' : v.file || '';
    document.getElementById('bgHint').textContent = '';
    document.getElementById('bgColor').value = hex(v.color || [240, 240, 240]);
    ['width', 'height'].forEach(function(part) {
      var id = part === 'width' ? 'bgWidth' : 'bgHeight';
      var px = v[part] > 0;
      document.getElementById(id).value = px ? 'px' : v[part] === 0 ? '0' : '-1';
      document.getElementById(id + 'Px').value = px ? v[part] : 200;
    });
    document.getElementById('bgTransparency').value = v.transparency || 0;
    list('#bgModes input').forEach(function(b) { b.checked = !!(v.mode & Number(b.value)); });
    document.getElementById('bgPlacement').value = v.placement || 'FRAME';
    list('#bgAlignment input').forEach(function(r) { r.checked = r.value === (v.alignment || 'TOPLEFT'); });
    var on = bgEditing ? backgroundTabs(bgEditing.index) : [];
    list('#bgTabs .bg-tab').forEach(function(b) { b.checked = on.indexOf(Number(b.value)) >= 0; });
    var all = document.getElementById('bgAllTabs');
    if (all) all.checked = !on.length;
    imageFiles = null;
    renderImageList();
    showBgControls();
    showModal('bgModal');
    requestImages();
  }

  function setupBackgroundModal() {
    var modal = document.getElementById('bgModal');
    if (!modal) return;
    setupImagePicker('bg');
    document.getElementById('addBackgroundBtn').addEventListener('click', function(e) {
      e.stopPropagation();
      if (!tabOrderMode) openBackgroundModal(null);
    });
    list('#bgKinds input, #bgWidth, #bgHeight').forEach(function(el) { el.addEventListener('change', showBgControls); });
    document.getElementById('bgTransparency').addEventListener('input', showBgControls);
    var all = document.getElementById('bgAllTabs');
    var boxes = list('#bgTabs .bg-tab');
    if (all) {
      all.addEventListener('change', function() {
        if (all.checked) boxes.forEach(function(b) { b.checked = false; });
        else if (boxes.length) boxes.forEach(function(b) { b.checked = Number(b.value) === Number(currentActiveTab); });
      });
      boxes.forEach(function(b) {
        b.addEventListener('change', function() { all.checked = !boxes.some(function(x) { return x.checked; }); });
      });
    }

    modal.querySelector('[data-action="cancel"]').addEventListener('click', function() { hideModal('bgModal'); });
    modal.querySelector('[data-action="confirm-background"]').addEventListener('click', function() {
      var kind = bgKind();
      var old = bgEditing;
      var values = {};
      if (kind === 'color') {
        values.file = 'RGB(' + document.getElementById('bgColor').value.slice(1).match(/../g).map(function(h) { return parseInt(h, 16); }).join(',') + ')';
        if (old && old.color && hex(old.color) === document.getElementById('bgColor').value) values.file = old.file;
      } else if (kind === 'picture') {
        values.file = document.getElementById('bgFile').value.replace(/["{}]/g, '').trim();
        if (!values.file) {
          document.getElementById('bgHint').textContent = 'Choose or enter a file name';
          document.getElementById('bgFile').focus();
          return;
        }
      }
      var bad = false;
      ['width', 'height'].forEach(function(part) {
        var id = part === 'width' ? 'bgWidth' : 'bgHeight';
        var how = document.getElementById(id).value;
        values[part] = how === 'px' ? parseInt(document.getElementById(id + 'Px').value, 10) : Number(how);
        if (kind !== 'color' && !(old && old[part] === null) && !(values[part] >= -1 && (how !== 'px' || values[part] >= 1))) bad = true;
      });
      if (bad) return;
      values.transparency = Number(document.getElementById('bgTransparency').value);
      // A value outside the slider's range stays unless the slider is moved
      if (old && old.transparency !== null && values.transparency === Math.max(0, Math.min(255, old.transparency))) values.transparency = old.transparency;
      values.mode = old && old.mode !== null ? old.mode : 0;
      list('#bgModes input').forEach(function(b) { values.mode = b.checked ? values.mode | Number(b.value) : values.mode & ~Number(b.value); });
      values.placement = document.getElementById('bgPlacement').value;
      var align = document.querySelector('#bgAlignment input:checked');
      values.alignment = align ? align.value : 'TOPLEFT';
      if (kind === 'color') {
        // A colour shows transparency and placement only; its other values stay
        ['width', 'height', 'mode', 'alignment'].forEach(function(part) { values[part] = old ? old[part] : part === 'mode' ? 0 : BG_NEW[part]; });
      }
      var on = boxes.filter(function(b) { return b.checked; }).map(function(b) { return Number(b.value); });
      var msg = { command: old ? 'editElement' : 'addElement', elementType: 'bgimage' };
      if (old) {
        // Only what changed, so the rest of the line stays as written
        Object.keys(values).forEach(function(part) { if (old[part] === null || values[part] === old[part]) delete values[part]; });
        msg.elementIndex = old.index;
      }
      msg.background = values;
      var before = old ? backgroundTabs(old.index) : [];
      if (on.join() !== before.join()) msg.tabIds = on.length ? on : 'all';
      hideModal('bgModal');
      if (vscodeApi && (Object.keys(values).length || msg.tabIds)) vscodeApi.postMessage(msg);
    });
  }

  // ---- Drawing backgrounds ------------------------------------------------------------------------
  // Pictures by address: { w, h, keyed }, keyed = the picture with its top left pixel's colour removed
  var bgPictures = window.__frmBgPictures = window.__frmBgPictures || {};

  function bgPicture(src) {
    var known = bgPictures[src];
    if (known) return known;
    known = bgPictures[src] = { w: 0, h: 0, keyed: null };
    var img = new Image();
    if (!/^data:/.test(src)) img.crossOrigin = 'anonymous'; // so its pixels may be read
    img.onload = function() {
      known.w = img.naturalWidth;
      known.h = img.naturalHeight;
      known.img = img;
      if (window.__frmLayoutBackgrounds) window.__frmLayoutBackgrounds();
    };
    img.onerror = function() {
      if (!img.crossOrigin) return;
      img = new Image();
      img.onload = function() {
        known.w = img.naturalWidth;
        known.h = img.naturalHeight;
        if (window.__frmLayoutBackgrounds) window.__frmLayoutBackgrounds();
      };
      img.src = src;
    };
    img.src = src;
    return known;
  }

  function keyedSrc(pic, src) {
    if (pic.keyed) return pic.keyed;
    if (!pic.img) return src;
    try {
      var canvas = document.createElement('canvas');
      canvas.width = pic.w;
      canvas.height = pic.h;
      var ctx = canvas.getContext('2d');
      ctx.drawImage(pic.img, 0, 0);
      var pixels = ctx.getImageData(0, 0, pic.w, pic.h);
      var p = pixels.data;
      var r = p[0], g = p[1], b = p[2];
      for (var i = 0; i < p.length; i += 4) if (p[i] === r && p[i + 1] === g && p[i + 2] === b) p[i + 3] = 0;
      ctx.putImageData(pixels, 0, 0);
      pic.keyed = canvas.toDataURL();
    } catch { pic.keyed = src; }
    return pic.keyed;
  }

  function layoutBackgrounds() {
    var content = document.querySelector('.content');
    var frame = document.querySelector('#gridFrame > .grid');
    var area = document.querySelector('.form-area');
    if (!content || !frame || !area) return;
    var images = list('.bg-image');
    if (!images.length) return;
    var c = content.getBoundingClientRect(), g = frame.getBoundingClientRect();
    var pad = parseFloat(getComputedStyle(content).paddingLeft) || 0;
    var bar = document.querySelector('.bottom-bar');
    var f = { left: g.left - c.left, top: g.top - c.top, width: g.width, height: g.height };
    var bottom = bar ? bar.getBoundingClientRect().bottom - c.top : f.top + f.height;
    var d = { left: 0, top: 0, width: f.left + f.width + pad, height: bottom + pad };
    images.forEach(function(el) {
      var v = JSON.parse(el.getAttribute('data-bg'));
      var s = el.style;
      var pic = v.color || !v.resolvedSrc ? null : bgPicture(v.resolvedSrc);
      var ready = v.width !== null && v.height !== null && v.transparency !== null && v.placement && v.alignment && (v.color || (pic && pic.w));
      s.display = ready ? '' : 'none';
      if (!ready) return;
      var a = v.placement === 'FRAME' ? f : d;
      ['left', 'top', 'width', 'height'].forEach(function(k) { s[k] = a[k] + 'px'; });
      // The dialog with the frame cut out of it
      var r = f.left + f.width, b = f.top + f.height;
      s.clipPath = v.placement === 'NOTFRAME' ? 'path(evenodd, "M0 0H' + d.width + 'V' + d.height + 'H0ZM' + f.left + ' ' + f.top + 'H' + r + 'V' + b + 'H' + f.left + 'Z")' : '';
      s.opacity = String(1 - Math.max(0, Math.min(255, v.transparency)) / 255);
      var src = pic && v.mode & 128 ? keyedSrc(pic, v.resolvedSrc) : v.resolvedSrc;
      var color = v.color ? 'rgb(' + v.color.join(',') + ')' : '';
      var drawn = v.color ? 'linear-gradient(' + color + ',' + color + ')' : 'url("' + src + '")';
      if (s.backgroundImage !== drawn) s.backgroundImage = drawn;
      function length(value, full, own) {
        return (value < 0 || (value === 0 && v.color) ? full : (value || own) * currentZoom) + 'px';
      }
      s.backgroundSize = length(v.width, a.width, pic ? pic.w : 0) + ' ' + length(v.height, a.height, pic ? pic.h : 0);
      var tiled = v.alignment === 'TILED';
      s.backgroundRepeat = tiled ? 'repeat' : 'no-repeat';
      var m = /^(TOP|MID|BOTTOM)(LEFT|MID|RIGHT)$/.exec(v.alignment);
      s.backgroundPosition = tiled ? 'left top' : (m[2] === 'MID' ? 'center' : m[2].toLowerCase()) + ' ' + (m[1] === 'MID' ? 'center' : m[1].toLowerCase());
    });
  }

  function setupBackgrounds() {
    window.__frmLayoutBackgrounds = layoutBackgrounds;
    if (window.__frmBgObserver) window.__frmBgObserver.disconnect();
    window.__frmBgObserver = new ResizeObserver(layoutBackgrounds);
    list('.content, #gridFrame > .grid, .bottom-bar').forEach(function(el) { window.__frmBgObserver.observe(el); });
    layoutBackgrounds();
  }

  // ---- Adding elements ----------------------------------------------------------------------------
  // Opens the dialog for a new element, or the inline input for a text. size ({ rows, cols }) is what was drawn, if anything.
  function addElementAt(tool, row, col, size) {
    if (tabOrderMode) return;
    contextMenuState.row = row;
    contextMenuState.col = col;
    ['fieldModal', 'buttonModal', 'previewModal'].forEach(function(id) {
      var modal = document.getElementById(id);
      // Left behind when an edit was cancelled
      if (modal) ['data-edit-mode', 'data-edit-index', 'data-nameformat'].forEach(function(a) { modal.removeAttribute(a); });
    });
    switch (tool) {
      case 'text':
        startNewTextEdit(row, col);
        break;
      case 'field':
        clearFieldModal();
        document.getElementById('fieldModalTitle').textContent = 'Add Field';
        if (size) document.getElementById('fieldLen').value = size.cols;
        showModal('fieldModal');
        document.getElementById('fieldName').focus();
        break;
      case 'button':
      case 'checkbox':
      case 'radio':
        clearButtonModal();
        contextMenuState.buttonType = tool === 'button' ? 'select' : tool;
        document.getElementById('buttonValue').value = tool === 'checkbox' ? '1;0' : '1';
        setupButtonModal({ button: 'General Button', checkbox: 'Checkbox', radio: 'Radio Button' }[tool]);
        showModal('buttonModal');
        break;
      case 'preview':
        document.getElementById('previewModalTitle').textContent = 'Add Preview';
        document.getElementById('previewPath').value = '';
        document.getElementById('previewField').value = '';
        document.getElementById('previewRows').value = size ? size.rows : 25;
        document.getElementById('previewCols').value = size ? size.cols : 72;
        document.getElementById('previewMode').value = '0';
        document.getElementById('previewPortType').value = 'PORT_2D';
        document.getElementById('previewPortStyle').value = 'SIMPLE';
        showModal('previewModal');
        document.getElementById('previewPath').focus();
        break;
      case 'image':
        openImageModal(null, size);
        break;
    }
  }

  // ---- Toolbox ------------------------------------------------------------------------------------
  // Click a tool to arm it (double-click: for several), then click a cell or drag out a size; or drag the tool onto
  // the form. window.__frmArmed ({ tool, sticky }) and window.__frmToolbox (place and look) outlive a refresh.
  var TOOL_KEYS = { t: 'text', f: 'field', b: 'button', c: 'checkbox', r: 'radio', p: 'preview', i: 'image' };
  // Size of a tool dropped on the form, before its dialog says otherwise
  var DROP_SIZES = { field: { rows: 1, cols: 10 }, preview: { rows: 25, cols: 72 }, image: { rows: 10, cols: 20 } };
  var DRAG_THRESHOLD = 4;
  var placing = null; // drawing a new element's place: { tool, pointerId, from, to }
  var toolDrag = null; // a tool dragged from the toolbox: { tool, pointerId, startX, startY, active }
  var toolboxDrag = null; // the toolbox being moved: { el, pointerId, startX, startY, corner, moved }
  var swallowClick = false; // the click that ends a placement or drag must not do anything else
  var pointer = window.__frmPointer || null; // last mouse position: { x, y }; outlives a refresh

  function cellAt(x, y) {
    var m = getGridMetrics();
    if (!m) return null;
    var row = Math.floor((y - m.rect.top) / m.rowPitch) + 1;
    var col = Math.floor((x - m.rect.left) / m.colPitch) + 1;
    return row >= 1 && row <= m.rows && col >= 1 && col <= m.cols ? { row: row, col: col } : null;
  }

  function nearestCell(x, y) {
    var m = getGridMetrics();
    return {
      row: Math.max(1, Math.min(m.rows, Math.floor((y - m.rect.top) / m.rowPitch) + 1)),
      col: Math.max(1, Math.min(m.cols, Math.floor((x - m.rect.left) / m.colPitch) + 1))
    };
  }

  function showPlacement(cell, rows, cols, label) {
    var outline = document.getElementById('dropTargetOutline');
    var m = getGridMetrics();
    if (!outline || !m) return;
    outline.classList.toggle('hidden', !cell);
    if (label) outline.setAttribute('data-size', label); else outline.removeAttribute('data-size');
    if (cell) placeOnGrid(outline, m, cell.row, cell.col, Math.min(rows || 1, m.rows - cell.row + 1), Math.min(cols || 1, m.cols - cell.col + 1));
  }

  // What has been drawn so far; size is null for a plain click
  function drawnPlacement() {
    var from = placing.from, to = placing.to;
    var sized = DROP_SIZES[placing.tool];
    var moved = from.col !== to.col || (placing.tool !== 'field' && from.row !== to.row);
    if (!sized || !moved) return { row: from.row, col: from.col, size: null };
    var rows = placing.tool === 'field' ? 1 : Math.abs(to.row - from.row) + 1;
    return {
      row: placing.tool === 'field' ? from.row : Math.min(from.row, to.row), col: Math.min(from.col, to.col),
      size: { rows: rows, cols: Math.abs(to.col - from.col) + 1 }
    };
  }

  function arm(tool, sticky) {
    hideAllContextMenus();
    window.__frmArmed = { tool: tool, sticky: !!sticky };
    showArmed();
  }

  function disarm() {
    window.__frmArmed = null;
    showArmed();
  }

  function showArmed() {
    var armed = window.__frmArmed;
    document.body.classList.toggle('tool-armed', !!armed);
    list('.toolbox-tool').forEach(function(b) {
      var on = !!armed && armed.tool === b.getAttribute('data-tool');
      b.classList.toggle('armed', on);
      b.classList.toggle('sticky', on && armed.sticky);
      b.setAttribute('aria-pressed', String(on));
    });
    if (!armed && !placing && !toolDrag) showPlacement(null);
  }

  // Stop drawing, dragging a tool or moving the toolbox. Returns whether there was anything to stop.
  function cancelToolDrags() {
    var was = placing || toolDrag || toolboxDrag;
    if (!was) return false;
    if (placing || (toolDrag && toolDrag.active) || toolboxDrag) swallowClick = true;
    if (toolboxDrag) { window.__frmToolbox = toolboxDrag.before; layoutToolbox(); }
    placing = toolDrag = toolboxDrag = null;
    document.body.classList.remove('tool-dragging', 'tool-no-drop');
    showPlacement(null);
    return true;
  }

  function armedIgnores(e) {
    return !!topModal() || !e.target.closest || e.clientX >= document.documentElement.clientWidth || e.clientY >= document.documentElement.clientHeight ||
      !!e.target.closest('.toolbox, .toolbox-show, .titlebar, .tabs, .side-panels, .unindexed-strip, .context-menu, .inline-edit');
  }

  function pointerCell() {
    var over = pointer && document.elementFromPoint(pointer.x, pointer.y);
    return over && over.closest('.grid') ? cellAt(pointer.x, pointer.y) : null;
  }

  // Single-key shortcut: add at the cell under the pointer, or arm the tool when there is none
  function useToolKey(key) {
    var tool = TOOL_KEYS[key];
    if (!tool) return false;
    var cell = pointerCell();
    var armed = window.__frmArmed;
    disarm();
    if (cell) addElementAt(tool, cell.row, cell.col, null);
    else if (!armed || armed.tool !== tool) arm(tool, false);
    return true;
  }

  function layoutToolbox() {
    var box = document.getElementById('toolbox');
    var show = document.getElementById('toolboxShow');
    var s = window.__frmToolbox;
    if (!box || !show || !s) return;
    var vw = document.documentElement.clientWidth, vh = document.documentElement.clientHeight;
    box.classList.toggle('hidden', s.hidden);
    show.classList.toggle('hidden', !s.hidden);
    box.classList.toggle('horizontal', s.horizontal);
    box.classList.remove('two-lines');
    var el = s.hidden ? show : box;
    if (!s.hidden && (s.horizontal ? box.offsetWidth > vw : box.offsetHeight > vh)) box.classList.add('two-lines');
    var w = el.offsetWidth, h = el.offsetHeight;
    // x and y say where its top right corner is, where the hide button and the icon of the hidden toolbox are
    var right = s.fromRight ? vw - s.x : s.x;
    var top = s.fromBottom ? vh - s.y : s.y;
    el.style.left = Math.max(0, Math.min(vw - w, right - w)) + 'px';
    el.style.top = Math.max(0, Math.min(vh - h, top)) + 'px';
  }

  function toolboxCorner() {
    var r = document.getElementById(window.__frmToolbox.hidden ? 'toolboxShow' : 'toolbox').getBoundingClientRect();
    return { right: r.right, top: r.top };
  }

  function withCorner(state, corner) {
    var vw = document.documentElement.clientWidth, vh = document.documentElement.clientHeight;
    var fromRight = corner.right > vw / 2, fromBottom = corner.top > vh / 2;
    return Object.assign({}, state, {
      fromRight: fromRight, fromBottom: fromBottom,
      x: Math.round(fromRight ? vw - corner.right : corner.right), y: Math.round(fromBottom ? vh - corner.top : corner.top)
    });
  }

  function changeToolbox(change) {
    window.__frmToolbox = Object.assign(withCorner(window.__frmToolbox, toolboxCorner()), change);
    layoutToolbox();
    saveToolbox();
  }

  function saveToolbox() {
    // Where it ended up: the panel's edges may have pushed it
    window.__frmToolbox = Object.assign(withCorner(window.__frmToolbox, toolboxCorner()), { at: Date.now() });
    if (vscodeApi) vscodeApi.postMessage({ command: 'setToolbox', state: window.__frmToolbox });
  }

  function setupToolbox() {
    var box = document.getElementById('toolbox');
    var show = document.getElementById('toolboxShow');
    if (!box || !show) return;
    // The latest change wins: one made here may be newer than this render, one from another preview older
    if (!window.__frmToolbox || D.toolbox.at > window.__frmToolbox.at) window.__frmToolbox = D.toolbox;
    layoutToolbox();
    showArmed();
    window.addEventListener('resize', layoutToolbox);

    function capture(el, id) { try { el.setPointerCapture(id); } catch { /* ignore */ } }
    document.getElementById('toolboxFlip').addEventListener('click', function() { changeToolbox({ horizontal: !window.__frmToolbox.horizontal }); });
    document.getElementById('toolboxHide').addEventListener('click', function() {
      disarm();
      changeToolbox({ hidden: true });
      show.focus({ preventScroll: true });
    });
    show.addEventListener('click', function() {
      changeToolbox({ hidden: false });
      document.getElementById('toolboxHide').focus({ preventScroll: true });
    });
    [box, show].forEach(function(el) {
      el.addEventListener('contextmenu', function(e) { e.preventDefault(); e.stopPropagation(); });
    });

    // Move the toolbox by its header, or its icon when hidden
    [box.querySelector('.toolbox-header'), show].forEach(function(handle) {
      handle.addEventListener('pointerdown', function(e) {
        if (e.button !== 0 || !e.isPrimary || e.target.closest('.toolbox-ctrl')) return;
        toolboxDrag = { pointerId: e.pointerId, startX: e.clientX, startY: e.clientY, corner: toolboxCorner(), before: window.__frmToolbox, moved: false };
        capture(handle, e.pointerId);
      });
    });

    // Tools: click to arm, double-click to keep armed, drag to drop one
    list('.toolbox-tool').forEach(function(button) {
      var tool = button.getAttribute('data-tool');
      button.addEventListener('pointerdown', function(e) {
        if (e.button !== 0 || !e.isPrimary) return;
        toolDrag = { tool: tool, pointerId: e.pointerId, startX: e.clientX, startY: e.clientY, active: false };
        capture(button, e.pointerId);
      });
      button.addEventListener('click', function(e) {
        if (tabOrderMode) return;
        if (e.detail === 2) arm(tool, true);
        else if (window.__frmArmed && window.__frmArmed.tool === tool) disarm();
        else arm(tool, false);
      });
    });

    document.addEventListener('pointerdown', function(e) {
      swallowClick = false;
      if (!window.__frmArmed || armedIgnores(e)) return;
      // Nothing under an armed tool reacts: no selecting, dragging or box selection
      e.stopImmediatePropagation();
      if (placing || e.button !== 0 || !e.isPrimary) return;
      swallowClick = true;
      var cell = cellAt(e.clientX, e.clientY);
      if (!cell) return;
      window.focus();
      if (inlineEdit) {
        // Closing an empty text input would end repeat mode
        var armed = window.__frmArmed;
        inlineEdit.finish(true);
        window.__frmArmed = armed;
        showArmed();
      }
      placing = { tool: window.__frmArmed.tool, pointerId: e.pointerId, from: cell, to: cell };
      capture(document.documentElement, e.pointerId);
      document.body.classList.add('tool-dragging');
      showPlacement(cell);
    }, true);

    document.addEventListener('pointermove', function(e) {
      pointer = window.__frmPointer = { x: e.clientX, y: e.clientY };
      if (placing && e.pointerId === placing.pointerId) {
        placing.to = DROP_SIZES[placing.tool] ? nearestCell(e.clientX, e.clientY) : placing.from;
        var d = drawnPlacement();
        showPlacement(d, d.size ? d.size.rows : 1, d.size ? d.size.cols : 1,
          d.size ? (placing.tool === 'field' ? 'len ' + d.size.cols : d.size.rows + ' × ' + d.size.cols) : '');
        return;
      }
      if (toolboxDrag && e.pointerId === toolboxDrag.pointerId) {
        var dx = e.clientX - toolboxDrag.startX, dy = e.clientY - toolboxDrag.startY;
        if (!toolboxDrag.moved && Math.abs(dx) < DRAG_THRESHOLD && Math.abs(dy) < DRAG_THRESHOLD) return;
        toolboxDrag.moved = true;
        window.__frmToolbox = withCorner(window.__frmToolbox, { right: toolboxDrag.corner.right + dx, top: toolboxDrag.corner.top + dy });
        layoutToolbox();
        return;
      }
      if (toolDrag && e.pointerId === toolDrag.pointerId) {
        if (!toolDrag.active) {
          if (Math.abs(e.clientX - toolDrag.startX) < DRAG_THRESHOLD && Math.abs(e.clientY - toolDrag.startY) < DRAG_THRESHOLD) return;
          if (tabOrderMode) { toolDrag = null; return; }
          toolDrag.active = true;
          hideAllContextMenus();
          disarm();
          document.body.classList.add('tool-dragging');
        }
        var size = DROP_SIZES[toolDrag.tool] || { rows: 1, cols: 1 };
        var over = cellAt(e.clientX, e.clientY);
        showPlacement(over, size.rows, size.cols);
        document.body.classList.toggle('tool-no-drop', !over);
        return;
      }
      if (window.__frmArmed) showPlacement(armedIgnores(e) ? null : cellAt(e.clientX, e.clientY));
    }, true);
    document.documentElement.addEventListener('pointerleave', function() {
      pointer = window.__frmPointer = null;
      if (window.__frmArmed && !placing && !toolDrag) showPlacement(null);
    });

    document.addEventListener('pointerup', function(e) {
      if (swallowClick) e.stopImmediatePropagation();
      // The click comes before this
      setTimeout(function() { swallowClick = false; }, 0);
      if (placing && e.pointerId === placing.pointerId) {
        var tool = placing.tool, drawn = drawnPlacement();
        cancelToolDrags();
        if (!window.__frmArmed || !window.__frmArmed.sticky) disarm();
        addElementAt(tool, drawn.row, drawn.col, drawn.size);
      } else if (toolboxDrag && e.pointerId === toolboxDrag.pointerId) {
        var moved = toolboxDrag.moved;
        toolboxDrag = null;
        if (moved) { swallowClick = true; saveToolbox(); }
      } else if (toolDrag && e.pointerId === toolDrag.pointerId) {
        var drop = toolDrag.active ? cellAt(e.clientX, e.clientY) : null;
        var dropped = toolDrag.tool;
        if (!toolDrag.active) { toolDrag = null; return; }
        cancelToolDrags();
        if (drop) addElementAt(dropped, drop.row, drop.col, null);
      }
    }, true);
    document.addEventListener('pointercancel', function() { cancelToolDrags(); }, true);
    window.addEventListener('blur', function() { cancelToolDrags(); });

    ['mousedown', 'dblclick', 'dragstart'].forEach(function(type) {
      document.addEventListener(type, function(e) {
        if (!placing && (!window.__frmArmed || armedIgnores(e))) return;
        e.preventDefault();
        e.stopImmediatePropagation();
      }, true);
    });
    document.addEventListener('click', function(e) {
      if (!swallowClick) return;
      swallowClick = false;
      e.preventDefault();
      e.stopImmediatePropagation();
    }, true);
    // Right-click puts an armed tool away
    document.addEventListener('contextmenu', function(e) {
      if (!placing && (!window.__frmArmed || topModal() || (e.target.closest && e.target.closest('.inline-edit')))) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      cancelToolDrags();
      disarm();
    }, true);
    // Cancelling a new element's dialog ends repeat mode
    document.addEventListener('click', function(e) {
      var cancel = e.target.closest && e.target.closest('.modal-overlay [data-action="cancel"]');
      if (cancel && !cancel.closest('#shortcutsModal')) disarm();
    }, true);

    // Out of the way while form elements are dragged
    document.body.classList.remove('element-dragging');
    document.addEventListener('dragstart', function() { document.body.classList.add('element-dragging'); });
    document.addEventListener('dragend', function() { document.body.classList.remove('element-dragging'); }, true);
  }

  // Drag and Drop functionality
  var draggedElement = null;
  var dragGroup = []; // the elements moved by the drag, draggedElement included
  var dragOffset = { x: 0, y: 0 };
  var selectedElements = []; // every selected element
  var selectedElement = null; // the primary one: last clicked, or the one at the code cursor
  var selectedRows = []; // selected rows of the Triggers and Hidden Fields lists; copied, cut and deleted along with the elements
  var codeTriggers = []; // triggers at the code cursor: { target, idx }, idx = row in the trigger list
  var hoverTrigger = null; // the trigger list row under the mouse, shown instead of codeTriggers
  var visualElements = []; // hidden fields and bottom-bar buttons highlighted from the code; never acted on

  function setupDragAndDrop() {
    var grid = document.querySelector('.grid');
    if (!grid) return;
    var hiddenPanel = document.getElementById('hiddenFieldsPanel');

    // Only fields on the form can be hidden; one without an index can't be moved in the file
    function canHide(element) {
      return element.getAttribute('data-type') === 'field' &&
        !element.classList.contains('hidden-field-item') && !isLocked(element);
    }

    function canHideDragged() {
      return dragGroup.length > 0 && dragGroup.every(canHide);
    }

    function clearHiddenPanel() {
      if (hiddenPanel) hiddenPanel.classList.remove('hide-drop-ready', 'hide-drop-over');
    }

    // Add click selection and dragstart listeners to all draggable elements
    document.querySelectorAll('.draggable').forEach(function(element) {
      // Make elements focusable
      element.setAttribute('tabindex', '0');
      
      // Add click selection
      element.addEventListener('click', function(e) {
        // Don't stop propagation if clicking on delete button or drag handle
        var target = e.target;
        if (target.closest('.delete-button')) {
          return; // Let the event bubble up
        }
        e.stopPropagation();
        if ((e.ctrlKey || e.metaKey || e.shiftKey) && !tabOrderMode) toggleElement(this);
        else selectElement(this);
      });
      
      element.addEventListener('dragstart', function(e) {
        if (tabOrderMode) { e.preventDefault(); return; }
        // Dragging a selected element moves the whole selection, any other only itself
        if (selectedElements.indexOf(this) < 0) setSelection([this], this);
        dragGroup = actionTargets();
        if (dragGroup.indexOf(this) < 0) dragGroup = [this];
        draggedElement = element;
        this.classList.add('dragging');
        
        var rect = this.getBoundingClientRect();
        dragOffset.x = e.clientX - rect.left;
        dragOffset.y = e.clientY - rect.top;
        
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/html', this.outerHTML);
        if (hiddenPanel && canHideDragged()) hiddenPanel.classList.add('hide-drop-ready');
      });

      element.addEventListener('dragend', function() {
        this.classList.remove('dragging');
        draggedElement = null;
        dragGroup = [];
        grid.classList.remove('drag-over');
        hideDropTarget();
        clearHiddenPanel();
      });
    });

    document.querySelectorAll('.hidden-field-item[draggable="true"]').forEach(function(element) {
      element.addEventListener('dragstart', function(e) {
        if (tabOrderMode) { e.preventDefault(); return; }
        draggedElement = element;
        dragGroup = [];
        this.classList.add('dragging');
        dragOffset.x = 0;
        dragOffset.y = 0;

        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', this.getAttribute('data-field-idx') || '');
      });

      element.addEventListener('dragend', function() {
        this.classList.remove('dragging');
        draggedElement = null;
        grid.classList.remove('drag-over');
        hideDropTarget();
      });
    });

    // The cell the dragged element would land on for this pointer position
    function computeDropTarget(e) {
      var m = getGridMetrics();
      if (!m || !draggedElement) return null;
      var isHidden = draggedElement.classList.contains('hidden-field-item');
      var colSpan, rowSpan, col, row, dRow, dCol;
      if (isHidden) {
        colSpan = Math.max(1, parseInt(draggedElement.getAttribute('data-span'), 10) || 1);
        rowSpan = 1;
        // Field starts in the cell under the pointer
        col = Math.floor((e.clientX - m.rect.left) / m.colPitch) + 1;
        row = Math.floor((e.clientY - m.rect.top) / m.rowPitch) + 1;
      } else {
        colSpan = gridSpan(draggedElement, 'Column');
        rowSpan = gridSpan(draggedElement, 'Row');
        // Snap the element's top-left corner (where its drag image is) to the nearest cell
        col = Math.round((e.clientX - dragOffset.x - m.rect.left) / m.colPitch) + 1;
        row = Math.round((e.clientY - dragOffset.y - m.rect.top) / m.rowPitch) + 1;
      }
      if (dragGroup.length > 1) {
        // Everything moves by as much as the dragged element, as far as all of it stays inside the grid
        dRow = row - parseInt(draggedElement.getAttribute('data-row'), 10);
        dCol = col - parseInt(draggedElement.getAttribute('data-col'), 10) - colOffset(draggedElement);
        return { m: m, moves: groupMoves(dragGroup, dRow, dCol, m.rows, m.cols, true) };
      }
      // Keep the whole element inside the current grid
      col = Math.max(1, Math.min(col, m.cols - colSpan + 1));
      row = Math.max(1, Math.min(row, m.rows - rowSpan + 1));
      // col is where it will be drawn; fileCol is what gets saved (boxed labels are drawn shifted)
      var off = isHidden ? 0 : colOffset(draggedElement);
      col = Math.max(1 + off, col);
      return { m: m, row: row, col: col, fileCol: col - off, rowSpan: rowSpan, colSpan: colSpan };
    }

    function showDropTarget(t) {
      var outline = document.getElementById('dropTargetOutline');
      if (!outline || !t) return;
      var extra = list('.grid > .drop-target-outline.extra');
      (t.moves || [t]).forEach(function(cell, i) {
        var o = outline;
        if (i > 0) {
          o = extra[i - 1];
          if (!o) {
            o = document.createElement('div');
            o.className = 'drop-target-outline extra';
            grid.appendChild(o);
          }
        }
        if (cell.el) placeOnGrid(o, t.m, cell.row, cell.col + colOffset(cell.el), gridSpan(cell.el, 'Row'), gridSpan(cell.el, 'Column'));
        else placeOnGrid(o, t.m, cell.row, cell.col, cell.rowSpan, cell.colSpan);
      });
      outline.classList.remove('hidden');
    }

    function hideDropTarget() {
      list('.grid > .drop-target-outline.extra').forEach(function(o) { o.remove(); });
      var outline = document.getElementById('dropTargetOutline');
      if (outline) outline.classList.add('hidden');
    }

    // Grid drop handling
    grid.addEventListener('dragover', function(e) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      this.classList.add('drag-over');
      showDropTarget(computeDropTarget(e));
    });

    grid.addEventListener('dragleave', function(e) {
      if (!this.contains(e.relatedTarget)) {
        this.classList.remove('drag-over');
        hideDropTarget();
      }
    });

    grid.addEventListener('drop', function(e) {
      e.preventDefault();
      this.classList.remove('drag-over');
      hideDropTarget();

      if (!draggedElement) return;
      var target = computeDropTarget(e);
      if (!target) return;
      if (target.moves) {
        commitMoves(target.moves);
      } else if (draggedElement.classList.contains('hidden-field-item')) {
        sendMoves([{ el: draggedElement, row: target.row, col: target.fileCol }], false);
      } else {
        commitMoves([{ el: draggedElement, row: target.row, col: target.fileCol }]);
      }
    });

    // Dropping a field on the Hidden Fields panel hides it. Anything else is not accepted as a drop,
    // so the browser shows its "not allowed" cursor.
    if (hiddenPanel) {
      hiddenPanel.addEventListener('dragover', function(e) {
        if (tabOrderMode || !canHideDragged()) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        this.classList.add('hide-drop-over');
      });

      hiddenPanel.addEventListener('dragleave', function(e) {
        if (!this.contains(e.relatedTarget)) this.classList.remove('hide-drop-over');
      });

      hiddenPanel.addEventListener('drop', function(e) {
        if (!canHideDragged()) return;
        e.preventDefault();
        clearHiddenPanel();
        // Arrow keys and Delete must not act on an element that is no longer visible
        draggedElement.blur();
        dragGroup.forEach(removeFromSelection);
        sendMoves(dragGroup.map(function(el) { return { el: el, row: 1000, col: 1000 }; }), false);
      });
    }
  }

  // The drawn box of a boxed text label
  function boxOf(element) {
    if (element.getAttribute('data-type') !== 'text' || !element.hasAttribute('data-box-rows')) return null;
    return document.querySelector('.grid > .box[data-text-idx="' + element.getAttribute('data-text-idx') + '"]') ||
      document.querySelector('.grid > .box[data-row="' + element.getAttribute('data-row') + '"][data-col="' + element.getAttribute('data-col') + '"]');
  }

  // Cells an element covers; axis is 'Row' or 'Column'
  function gridSpan(el, axis) {
    var start = el.style['grid' + axis + 'Start'], end = el.style['grid' + axis + 'End'];
    return Math.max(1, placementEnd(start, end) - (parseInt(start, 10) || 1) + 1);
  }

  // Where a group lands when moved by dRow, dCol: it stops as a whole at the form's edges. whole = keep whole
  // elements inside (dragging) instead of only their first cell (arrow keys). An element already outside on that
  // side neither stops the others nor moves further out.
  function groupMoves(els, dRow, dCol, rows, cols, whole) {
    function steps(axis, attr, max, wanted) {
      var room = els.map(function(el) {
        var fileStart = parseInt(el.getAttribute(attr), 10);
        var start = axis === 'Column' && whole ? fileStart + colOffset(el) : fileStart;
        return { before: fileStart - 1, after: max - (whole ? gridSpan(el, axis) - 1 : 0) - start };
      });
      var d = wanted;
      room.forEach(function(r) {
        if (d > 0 && r.after >= 0) d = Math.min(d, r.after);
        if (d < 0) d = Math.max(d, -r.before);
      });
      if (d > 0 && room.every(function(r) { return r.after < 0; })) d = 0;
      return room.map(function(r) { return d > 0 && r.after < 0 ? 0 : d; });
    }
    var byRow = steps('Row', 'data-row', rows, dRow);
    var byCol = steps('Column', 'data-col', cols, dCol);
    return els.map(function(el, i) {
      return { el: el, row: parseInt(el.getAttribute('data-row'), 10) + byRow[i], col: parseInt(el.getAttribute('data-col'), 10) + byCol[i] };
    });
  }

  // Draw moves ({ el, row, col }, file positions) and write them to the file as one undo step
  function commitMoves(moves) {
    var changed = moves.filter(function(mv) {
      return !isLocked(mv.el) && (mv.row !== parseInt(mv.el.getAttribute('data-row'), 10) || mv.col !== parseInt(mv.el.getAttribute('data-col'), 10));
    });
    if (!changed.length) return;
    // Boxes are found by position, so look them up before anything moves
    var boxes = changed.map(function(mv) { return boxOf(mv.el); });
    changed.forEach(function(mv, i) { updateElementPosition(mv.el, mv.row, mv.col, boxes[i]); });
    updateOverflow(gridRows, gridCols);
    sendMoves(changed, true);
    noticeOtherTabs(changed.length + ' moved');
  }

  function updateElementPosition(element, newRow, newCol, box) {
    // A boxed text label carries its box along (the box sits at the label's file row/col)
    if (element.getAttribute('data-type') === 'text' && element.hasAttribute('data-box-rows')) {
      box = box || boxOf(element);
      if (box) {
        box.setAttribute('data-row', newRow);
        box.setAttribute('data-col', newCol);
        var bRows = String(box.style.gridRow || '').match(/span (\d+)/);
        var bCols = String(box.style.gridColumn || '').match(/span (\d+)/);
        box.style.gridRow = newRow + ' / span ' + (bRows ? bRows[1] : '1');
        box.style.gridColumn = newCol + ' / span ' + (bCols ? bCols[1] : '1');
      }
    }
    element.setAttribute('data-row', newRow);
    element.setAttribute('data-col', newCol);
    
    // Update grid positioning
    var currentStyle = element.style.gridColumn;
    var spanMatch = currentStyle.match(/span (\d+)/);
    var span = spanMatch ? spanMatch[1] : '1';
    
    // Keep a row span (images, previews) when moving
    var rowSpanMatch = String(element.style.gridRow || '').match(/span (\d+)/);
    element.style.gridRow = rowSpanMatch ? newRow + ' / span ' + rowSpanMatch[1] : String(newRow);
    element.style.gridColumn = (newCol + colOffset(element)) + ' / span ' + span;
    if (element.hasAttribute('data-box-rows')) fitBoxGaps();
  }

  // alreadyDrawn: false when the preview did not draw the move itself (e.g. dropped from the hidden list)
  function sendMoves(moves, alreadyDrawn) {
    moves = moves.filter(function(mv) { return !isLocked(mv.el); });
    if (!moves.length || !vscodeApi || !vscodeApi.postMessage) return;
    vscodeApi.postMessage({
      command: 'moveElements',
      moves: moves.map(function(mv) { return Object.assign(elementRef(mv.el), { row: mv.row, col: mv.col }); }),
      alreadyDrawn: alreadyDrawn
    });
  }

  function elementRef(el) {
    return { type: el.getAttribute('data-type'), index: elementIndexOf(el) };
  }

  // A list view table can be moved, stretched and deleted, but not copied, duplicated or edited here
  function isListview(el) {
    return !!el && el.getAttribute('data-type') === 'listview';
  }

  // Elements whose line has no index can't be found in the file
  function isLocked(el) {
    return elementIndexOf(el) === null || el.hasAttribute('data-no-index');
  }

  // What keys and drags act on: the selected elements in view on this tab
  function actionTargets() {
    return selectedElements.filter(function(el) { return !isOnOtherTab(el) && !isLocked(el); });
  }

  function isTriggerRow(row) {
    return row.hasAttribute('data-trigger-target');
  }

  // The elements and list rows of a message to the extension
  function statementRefs(els, rows) {
    return {
      elements: els.concat(rows.filter(function(row) { return !isTriggerRow(row); })).map(elementRef),
      triggers: rows.filter(isTriggerRow).map(function(row) {
        return {
          line: Number(row.getAttribute('data-trigger-line')),
          target: row.getAttribute('data-trigger-target'), program: row.getAttribute('data-trigger-program')
        };
      })
    };
  }

  // What Delete, copy and cut act on
  function actionRows() {
    return selectedRows.filter(function(row) { return isTriggerRow(row) || !isLocked(row); });
  }

  // Keys that only work on elements leave selected rows alone
  function noticeRows() {
    if (selectedRows.length) showNotice('Selected triggers, hidden fields and backgrounds not changed');
  }

  function deleteElements(els, rows, command) {
    rows = rows || [];
    els = els.filter(function(el) { return !isLocked(el); });
    if ((!els.length && !rows.length) || !vscodeApi || !vscodeApi.postMessage) return;
    vscodeApi.postMessage(Object.assign({ command: command || 'deleteElements' }, statementRefs(els, rows)));
    noticeOtherTabs((els.length + rows.length) + (command === 'cutElements' ? ' cut' : ' deleted'));
    var rest = selectedElements.filter(function(el) { return els.indexOf(el) < 0; });
    setSelection(rest, rest.indexOf(selectedElement) >= 0 ? selectedElement : rest[rest.length - 1] || null, null, null,
      selectedRows.filter(function(row) { return rows.indexOf(row) < 0; }));
  }

  // Ctrl+C and Ctrl+X. False when nothing is selected.
  function copySelected(cut) {
    if (!selectedElements.length && !selectedRows.length) return false;
    var els = actionTargets();
    var rows = actionRows();
    var total = els.length + rows.length;
    if (els.some(isListview)) {
      els = els.filter(function(el) { return !isListview(el); });
      total = els.length + rows.length;
      if (!total) { showNotice('The list view table can\'t be ' + (cut ? 'cut' : 'copied')); return true; }
    }
    if (!total) {
      if (!groupKeysBlocked()) showNotice('Elements without an index can\'t be copied');
    } else if (cut) {
      deleteElements(els, rows, 'cutElements');
    } else if (vscodeApi && vscodeApi.postMessage) {
      vscodeApi.postMessage(Object.assign({ command: 'copyElements' }, statementRefs(els, rows)));
      var away = selectedElements.filter(isOnOtherTab).length;
      showNotice(total + ' copied' + (away ? ', ' + away + ' on other tabs not copied' : ''));
    }
    return true;
  }

  function pasteElements() {
    if (!vscodeApi || !vscodeApi.postMessage) return;
    vscodeApi.postMessage({ command: 'pasteElements', cell: pointerCell(), rows: gridRows, cols: gridCols, tabId: tabs.length ? currentActiveTab : null });
  }

  // A row of the Triggers or Hidden Fields list, across refreshes. Equal triggers are told apart by their order.
  function rowKeys(rows) {
    var seen = {};
    var keys = new Map();
    list('.trigger-item').forEach(function(row) {
      var key;
      if (isTriggerRow(row)) {
        var what = [row.getAttribute('data-trigger-target'), row.getAttribute('data-trigger-program'), row.querySelector('.trigger-program').textContent].join(' ');
        seen[what] = (seen[what] || 0) + 1;
        key = 'trigger:' + seen[what] + ':' + what;
      } else {
        key = elementKey(row);
      }
      keys.set(row, key);
    });
    return rows ? rows.map(function(row) { return keys.get(row); }) : keys;
  }

  function findRows(carry) {
    var keys = carry.rows || [];
    var lines = carry.triggerLines || [];
    var rows = [];
    if (keys.length || lines.length) {
      rowKeys().forEach(function(key, row) {
        if (keys.indexOf(key) >= 0 || (isTriggerRow(row) && lines.indexOf(Number(row.getAttribute('data-trigger-line'))) >= 0)) rows.push(row);
      });
    }
    return rows;
  }

  function setupRowSelection() {
    list('.trigger-item').forEach(function(row) {
      row.addEventListener('click', function(e) {
        if (tabOrderMode || e.target.closest('.trigger-actions')) return;
        if (!(e.ctrlKey || e.metaKey || e.shiftKey)) {
          setSelection([], null, null, null, [row]);
          return;
        }
        setSelection(selectedElements, selectedElement, null, null, selectedRows.indexOf(row) >= 0
          ? selectedRows.filter(function(r) { return r !== row; }) : selectedRows.concat(row));
      });
      row.addEventListener('dblclick', function(e) {
        if (tabOrderMode || e.ctrlKey || e.metaKey || e.shiftKey || e.target.closest('.trigger-actions')) return;
        if (row.classList.contains('bg-item')) {
          if (!isLocked(row) && vscodeApi && vscodeApi.postMessage) {
            vscodeApi.postMessage({ command: 'showInSource', elementType: 'bgimage', elementIndex: elementIndexOf(row) });
          }
        } else if (!isTriggerRow(row)) showHiddenFieldInSource(elementIndexOf(row));
        else if (vscodeApi && vscodeApi.postMessage) {
          vscodeApi.postMessage({ command: 'showInSource', elementType: 'trigger', line: Number(row.getAttribute('data-trigger-line')) });
        }
      });
    });
  }

  function elementKey(el) {
    var type = el.getAttribute('data-type');
    var index = elementIndexOf(el);
    return type + ':' + (index === null ? 'no-idx' : index);
  }

  // The form element for a key; visual = its row in the Hidden Fields panel or its bottom-bar button instead
  function findByKey(key, visual) {
    var parts = key.split(':');
    var cls = { text: 'text', field: 'field', pushbutton: 'push', image: 'image', preview: 'preview', bgimage: 'bgimage', listview: 'listview' }[parts[0]];
    if (!cls) return null;
    var attr = 'data-' + cls + '-idx';
    var idx = parts[1] === 'no-idx' ? ':not([' + attr + '])' : '[' + attr + '="' + parts[1] + '"]';
    if (!visual) return document.querySelector('.grid > .' + cls + '.draggable' + idx);
    if (parts[0] === 'field') return document.querySelector('.hidden-field-item' + idx);
    if (parts[0] === 'bgimage') return document.querySelector('.bg-item' + idx);
    if (parts[0] === 'pushbutton') return document.querySelector('.bottom-bar-button' + idx);
    return null;
  }

  function setSelection(els, primary, visual, triggers, rows) {
    selectedRows.forEach(function(row) { row.classList.remove('selected'); });
    selectedRows = rows || [];
    selectedRows.forEach(function(row) { row.classList.add('selected'); });
    selectedElements.forEach(function(el) { el.classList.remove('selected', 'primary'); });
    visualElements.forEach(function(el) { el.classList.remove('code-highlight'); });
    selectedElements = els;
    selectedElement = primary;
    visualElements = visual || [];
    codeTriggers = triggers || [];
    selectedElements.forEach(function(el) {
      el.classList.add('selected');
      if (el === primary) el.classList.add('primary');
    });
    visualElements.forEach(function(el) { el.classList.add('code-highlight'); });
    document.querySelectorAll('.lv-col.lv-col-active').forEach(function(c) { c.classList.remove('lv-col-active'); });
    document.body.classList.toggle('multi-selected', els.length > 1);
    window.__frmCodeSelection = null; // a selection made here replaces one still waiting from the code
    showTriggers();
    // A table's column stays chosen while the table alone stays selected
    var column = propsState && propsState.column;
    if (column) {
      if (els.length === 1 && !selectedRows.length && elementKey(els[0]) === column.key) markColumn(els[0], column.field);
      else propsState.column = null;
    }
    updatePropsPanel();
  }

  function clearSelection() {
    setSelection([], null);
  }

  function selectElement(element) {
    setSelection([element], element);
    element.focus();
  }

  function toggleElement(element) {
    if (selectedElements.indexOf(element) >= 0) {
      removeFromSelection(element);
      return;
    }
    setSelection(selectedElements.concat(element), element, null, null, selectedRows);
    element.focus();
  }

  function removeFromSelection(element) {
    var rest = selectedElements.filter(function(el) { return el !== element; });
    if (rest.length === selectedElements.length) return;
    setSelection(rest, selectedElement === element ? rest[rest.length - 1] || null : selectedElement, null, null, selectedRows);
  }

  // Selected elements on other form tabs stay selected but can't be seen
  function isOnOtherTab(el) {
    return el.classList.contains('hidden');
  }

  // Show a message for a moment, also across a refresh
  function showNotice(text, ms) {
    window.__frmNotice = { text: text, until: Date.now() + (ms || 2500) };
    updateSelectionNotice();
  }

  // After a group action: tell when part of the selection was left alone
  function noticeOtherTabs(done) {
    var away = selectedElements.filter(isOnOtherTab).length;
    if (away) showNotice(done + ', ' + away + ' on other tabs not changed');
  }

  // Shows how many elements are selected, or the message of showNotice
  function updateSelectionNotice() {
    var notice = document.getElementById('selectionNotice');
    if (!notice) return;
    clearTimeout(window.__frmNoticeTimer);
    var count = selectedElements.length + selectedRows.length;
    var away = selectedElements.filter(isOnOtherTab).length;
    var text = '';
    var left = window.__frmNotice ? window.__frmNotice.until - Date.now() : 0;
    if (left > 0) {
      text = window.__frmNotice.text;
      window.__frmNoticeTimer = setTimeout(onCurrentPage(function() { updateSelectionNotice(); }), left);
    } else {
      window.__frmNotice = null;
      if (count > 1) text = count + ' selected' + (away ? ', ' + away + ' on other tabs' : '');
      text = [text].concat(triggerNotices()).filter(Boolean).join(' \u00b7 ');
    }
    notice.textContent = text;
    notice.classList.toggle('hidden', !text);
  }

  // Editing and stretching act on exactly one element, which must be in view on this tab
  function editKeysBlocked() {
    if (selectedElements.length <= 1 && !(selectedElement && isOnOtherTab(selectedElement))) return false;
    showNotice(selectedElements.length > 1 ? selectedElements.length + ' selected: select one to edit' : 'The selected element is on another tab');
    return true;
  }

  // Keys that act on all selected elements need at least one of them in view
  function groupKeysBlocked() {
    if (tabOrderMode && selectedElements.length > 1) return true;
    if (!selectedElements.length || !selectedElements.every(isOnOtherTab)) return false;
    showNotice(selectedElements.length > 1 ? 'The selected elements are on other tabs' : 'The selected element is on another tab');
    return true;
  }

  function getSelection() {
    return {
      keys: selectedElements.map(elementKey),
      primary: selectedElement ? elementKey(selectedElement) : null,
      visual: visualElements.map(elementKey),
      rows: rowKeys(selectedRows),
      triggers: codeTriggers
    };
  }

  function found(el, i, all) {
    return !!el && all.indexOf(el) === i;
  }

  function restoreSelection() {
    var carry = window.__frmCarry && window.__frmCarry.selection;
    var waiting = window.__frmCodeSelection;
    if (carry && carry.otherwise && !carry.keys.some(function(k) { return findByKey(k); }) &&
        !(carry.rows && !carry.keys.length && findRows(carry).length)) {
      // The new elements may come with the next refresh; until then the selection stays
      if (!carry.retried) pendingSelection = { keys: carry.keys, primary: carry.primary, visual: [], triggers: [], rows: carry.rows, triggerLines: carry.triggerLines, retried: true };
      carry = carry.otherwise;
    }
    if (carry) {
      var els = carry.keys.map(function(k) { return findByKey(k); }).filter(found);
      var primary = carry.primary ? findByKey(carry.primary) : null;
      if (els.indexOf(primary) < 0) primary = els[els.length - 1] || null;
      // Focus is left alone to avoid interrupting keyboard navigation
      setSelection(els, primary, carry.visual.map(function(k) { return findByKey(k, true); }).filter(found),
        // A trigger that was edited or deleted is no longer the one that was highlighted
        carry.triggers.filter(function(t) {
          var row = t.idx === null ? null : triggerRow(t.idx);
          return t.idx === null || (row && row.getAttribute('data-trigger-target') === t.target);
        }), findRows(carry));
    } else {
      showTriggers();
    }
    window.__frmCodeSelection = waiting;
  }

  // ---- Triggers: highlight what they fire from --------------------------------------------------
  function list(selector) {
    return Array.prototype.slice.call(document.querySelectorAll(selector));
  }

  function triggerRow(idx) {
    return document.querySelector('.trigger-item[data-trigger-idx="' + idx + '"]');
  }

  function varName(el, attr) {
    return (el.getAttribute(attr) || '').replace(/^\$/, '').toLowerCase();
  }

  // Fields a trigger fires from (0 = all), and the buttons that set those fields
  function triggerTargets(target) {
    var none = { fields: [], buttons: [] };
    if (!/^\d+$/.test(target)) return none;
    var index = Number(target);
    var fields = list('.grid > .field.draggable, .hidden-field-item').filter(function(el) {
      return index === 0 || (!el.hasAttribute('data-no-index') && elementIndexOf(el) === index);
    });
    var names = fields.map(function(el) { return varName(el, 'data-field-name'); });
    var buttons = list('.grid > .push[data-pb-action="variable"], .bottom-bar-button[data-pb-action="variable"]').filter(function(el) {
      var name = varName(el, 'data-pb-name');
      return name && names.indexOf(name) >= 0;
    });
    return { fields: fields, buttons: buttons };
  }

  function activeTriggers() {
    return hoverTrigger ? [hoverTrigger] : codeTriggers;
  }

  // Highlight only: never changes the selection, so keys can't act on these elements
  function showTriggers() {
    list('.trigger-highlight').forEach(function(el) { el.classList.remove('trigger-highlight'); });
    activeTriggers().forEach(function(t) {
      var on = triggerTargets(t.target);
      var els = on.fields.concat(on.buttons);
      if (t.target.charAt(0) === '$') els = els.concat(list('.window'));
      if (t.idx !== null) els = els.concat(triggerRow(t.idx) || []);
      els.forEach(function(el) { el.classList.add('trigger-highlight'); });
    });
    updateSelectionNotice();
  }

  function triggerNotices() {
    var notes = [];
    var fields = [];
    activeTriggers().forEach(function(t) {
      if (t.target.charAt(0) === '$') return;
      var on = triggerTargets(t.target).fields;
      var note = 'Field ' + t.target + ' not found';
      if (!on.length && t.target !== '0' && notes.indexOf(note) < 0) notes.push(note);
      on.forEach(function(el) { if (fields.indexOf(el) < 0) fields.push(el); });
    });
    var away = fields.filter(isOnOtherTab).length;
    if (away) notes.unshift(fields.length + (fields.length === 1 ? ' field, ' : ' fields, ') + away + ' not on this tab');
    return notes;
  }

  // From the code, a trigger on one field brings that field (or a button that sets it) into view
  function revealTrigger(target) {
    if (target === '0') return;
    var on = triggerTargets(target);
    var els = on.fields.concat(on.buttons);
    if (els.length && els.every(isOnOtherTab)) {
      var withTab = els.filter(function(el) { return (tabsOfElement(el) || []).length; })[0];
      if (withTab) switchTab(tabsOfElement(withTab)[0]);
    }
    revealFromCode(els.filter(function(el) { return !isOnOtherTab(el); })[0] || null);
  }

  function setupTriggerHover() {
    function hover(row) {
      hoverTrigger = row && !draggedElement && !sizeDrag && !elResize && !boxResize && !tabOrderMode
        ? { target: row.getAttribute('data-trigger-target'), idx: Number(row.getAttribute('data-trigger-idx')) } : null;
      showTriggers();
    }
    list('.trigger-item[data-trigger-target]').forEach(function(row) {
      row.addEventListener('mouseenter', function() { hover(row); });
      row.addEventListener('mouseleave', function() { hover(null); });
    });
    // After a refresh the mouse may still be on a row
    var under = document.querySelector('.trigger-item[data-trigger-target]:hover');
    if (under) hover(under);
  }

  // ---- Selection from the code: the elements at the text cursor --------------------------------
  function codeSelectionBlocked() {
    return window.__frmUpdatePending() || inlineEdit || boxResize || !window.__frmHooks || window.__frmHooks.isBusy();
  }

  function tryCodeSelection() {
    clearTimeout(window.__frmCodeSelectionTimer);
    if (!window.__frmCodeSelection) return;
    if (codeSelectionBlocked()) {
      window.__frmCodeSelectionTimer = setTimeout(onCurrentPage(tryCodeSelection), 200);
      return;
    }
    applyCodeSelection(window.__frmCodeSelection);
  }

  // Never takes focus: the user is in the text editor
  function applyCodeSelection(msg) {
    var triggers = (msg.triggers || []).map(function(t) {
      var row = document.querySelector('.trigger-item[data-trigger-line="' + t.line + '"]');
      return { target: t.target, line: t.line, idx: row ? Number(row.getAttribute('data-trigger-idx')) : null };
    });
    var real = []; // { el, at }
    var visual = [];
    msg.keys.forEach(function(key, at) {
      var el = findByKey(key);
      if (el && !el.hasAttribute('data-no-index')) {
        var on = tabsOfElement(el);
        if (!on || on.length) real.push({ el: el, at: at });
        return;
      }
      el = findByKey(key, true);
      if (el) visual.push({ el: el, at: at });
    });
    var at = msg.keys.indexOf(msg.primary);
    var primary = real.reduce(function(best, r) {
      return !best || Math.abs(r.at - at) < Math.abs(best.at - at) ? r : best;
    }, null);
    primary = primary ? primary.el : null;
    var visualPrimary = visual.filter(function(v) { return v.at === at; })[0];

    setSelection(real.map(function(r) { return r.el; }), primary, visual.map(function(v) { return v.el; }), triggers);
    markCodeColumns(msg.keys);
    var main = triggers.filter(function(t) { return t.line === msg.primaryTrigger; })[0];
    if (main) {
      revealTrigger(main.target);
      return;
    }
    if (primary && isOnOtherTab(primary)) {
      var on = tabsOfElement(primary);
      if (on && on.length) switchTab(on[0]);
    }
    revealFromCode(visualPrimary ? visualPrimary.el : primary);
  }

  var revealWhenShown = null;
  function revealFromCode(el) {
    // A covered preview has no layout to scroll; do it when it is shown
    var hiddenPage = document.hidden || !window.innerHeight;
    revealWhenShown = hiddenPage ? el : null;
    if (el && !hiddenPage) el.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
  }

  function setupCodeSelection() {
    window.addEventListener('message', function(ev) {
      var msg = ev.data;
      if (msg && msg.command === 'frmSelectFromCode' && Array.isArray(msg.keys)) {
        window.__frmCodeSelection = msg;
        tryCodeSelection();
      }
    });
    function revealNow() { if (revealWhenShown) revealFromCode(revealWhenShown); }
    document.addEventListener('visibilitychange', revealNow);
    window.addEventListener('resize', revealNow);
  }

  function moveSelected(deltaRow, deltaCol) {
    var els = actionTargets();
    if (els.length > 1) {
      commitMoves(groupMoves(els, deltaRow, deltaCol, gridRows, gridCols, false));
    } else if (els.length) {
      commitMoves([{
        el: els[0],
        row: Math.max(1, Math.min(gridRows, parseInt(els[0].getAttribute('data-row'), 10) + deltaRow)),
        col: Math.max(1, Math.min(gridCols, parseInt(els[0].getAttribute('data-col'), 10) + deltaCol))
      }]);
    }
  }

  function setupKeyboardNavigation() {
    // Delete button click handler
    document.addEventListener('click', function(e) {
      var target = e.target;
      var deleteBtn = target.closest('.delete-button');
      if (!deleteBtn && target.classList && target.classList.contains('delete-button')) {
        deleteBtn = target;
      }
      if (deleteBtn) {
        e.stopPropagation();
        e.preventDefault();
        if (tabOrderMode) return;
        var element = deleteBtn.closest('.draggable');
        if (element) deleteElements([element]);
      }
    });

    // Add global keyboard event listener
    document.addEventListener('keydown', function(e) {
      if ((!selectedElement && !selectedRows.length && !visualElements.length && !codeTriggers.length) || shortcutsBlocked(e)) return;
      if (/^(Arrow(Up|Down|Left|Right)|Delete|Backspace)$/.test(e.key)) {
        var deletesRows = !/^Arrow/.test(e.key) && actionRows().length > 0;
        if (!deletesRows) noticeRows();
        if (!selectedElement && !deletesRows) return;
        var stretches = e.shiftKey && /^Arrow/.test(e.key);
        if (deletesRows ? tabOrderMode : stretches ? editKeysBlocked() : groupKeysBlocked()) { e.preventDefault(); return; }
      }
      
      // Shift+Arrow stretches instead of moving
      if (e.shiftKey && /^Arrow(Up|Down|Left|Right)$/.test(e.key)) {
        e.preventDefault();
        stretchSelectedElement(e.key);
        return;
      }

      var handled = false;
      
      switch(e.key) {
        case 'ArrowUp':
          moveSelected(-1, 0);
          handled = true;
          break;
        case 'ArrowDown':
          moveSelected(1, 0);
          handled = true;
          break;
        case 'ArrowLeft':
          moveSelected(0, -1);
          handled = true;
          break;
        case 'ArrowRight':
          moveSelected(0, 1);
          handled = true;
          break;
        case 'Escape':
          clearSelection();
          handled = true;
          break;
        case 'Delete':
        case 'Backspace':
          if (selectedElement || selectedRows.length) {
            deleteElements(actionTargets(), actionRows());
            handled = true;
          }
          break;
      }
      
      if (handled) {
        e.preventDefault();
        e.stopPropagation();
      }
    });
    
    // Deselect when clicking on empty area (not when using a dialog or menu)
    document.addEventListener('click', function(e) {
      // Switching form tabs keeps the selection
      if (e.target.closest('.modal-overlay, .context-menu, .tabs, .toolbox, .toolbox-show, .props-panel')) return;
      if (!e.target.closest('.draggable, .trigger-item')) clearSelection();
    });
  }

  // Box selection: drag on empty space to select everything inside the box
  var marquee = null; // { x, y, startX, startY, pointerId, add, before, beforePrimary, active, cancelled }; x, y are relative to the grid
  var MARQUEE_THRESHOLD = 4;

  function canSelectInGroup(el) {
    return !isOnOtherTab(el) && !isLocked(el);
  }

  function selectAll() {
    var els = list('.grid > .draggable').filter(canSelectInGroup);
    setSelection(els, els.indexOf(selectedElement) >= 0 ? selectedElement : els[els.length - 1] || null);
    if (selectedElement) selectedElement.focus({ preventScroll: true });
  }

  // An element's place on screen; a boxed text includes its drawn box
  function selectionRect(el) {
    var r = el.getBoundingClientRect();
    var box = boxOf(el);
    var m = box && getGridMetrics();
    if (!m) return r;
    // The lines are drawn half a cell in from the box's edges
    var b = box.getBoundingClientRect();
    return {
      left: Math.min(r.left, b.left + m.colWidth / 2), right: Math.max(r.right, b.right - m.colWidth / 2),
      top: Math.min(r.top, b.top + m.rowHeight / 2), bottom: Math.max(r.bottom, b.bottom - m.rowHeight / 2)
    };
  }

  function endMarquee(commit) {
    if (!marquee) return;
    var d = marquee;
    document.body.classList.remove('marquee-selecting');
    var overlay = document.getElementById('marquee');
    if (overlay) overlay.classList.add('hidden');
    try { document.documentElement.releasePointerCapture(d.pointerId); } catch { /* ignore */ }
    marquee = null;
    if (!d.active) return;
    // The click that follows the release must not clear the selection
    window.__frmSwallowClick = true;
    if (!commit) {
      setSelection(d.before, d.beforePrimary, null, null, d.beforeRows);
      return;
    }
    if (selectedElement) selectedElement.focus({ preventScroll: true });
  }

  function updateMarquee(e) {
    var d = marquee;
    var grid = document.querySelector('.grid');
    var overlay = document.getElementById('marquee');
    if (!grid || !overlay) return;
    var g = grid.getBoundingClientRect();
    var x = d.x + g.left, y = d.y + g.top;
    var box = { left: Math.min(x, e.clientX), right: Math.max(x, e.clientX), top: Math.min(y, e.clientY), bottom: Math.max(y, e.clientY) };
    overlay.style.left = box.left + 'px';
    overlay.style.top = box.top + 'px';
    overlay.style.width = (box.right - box.left) + 'px';
    overlay.style.height = (box.bottom - box.top) + 'px';
    overlay.classList.remove('hidden');
    var inside = list('.grid > .draggable').filter(function(el) {
      if (!canSelectInGroup(el)) return false;
      var r = selectionRect(el);
      return r.left >= box.left - 0.5 && r.right <= box.right + 0.5 && r.top >= box.top - 0.5 && r.bottom <= box.bottom + 0.5;
    });
    var els = d.add ? d.before.concat(inside.filter(function(el) { return d.before.indexOf(el) < 0; })) : inside;
    var same = els.length === selectedElements.length && els.every(function(el, i) { return el === selectedElements[i]; });
    if (!d.add && selectedRows.length) same = false;
    if (!same) setSelection(els, d.add && d.beforePrimary ? d.beforePrimary : els[els.length - 1] || null, null, null, d.add ? d.beforeRows : []);
  }

  function setupMarquee() {
    document.addEventListener('pointerdown', function(e) {
      window.__frmSwallowClick = false;
      if (e.button !== 0 || !e.isPrimary || marquee || tabOrderMode || inlineEdit || topModal() || openContextMenu()) return;
      // The page's own scrollbars
      if (e.clientX >= document.documentElement.clientWidth || e.clientY >= document.documentElement.clientHeight) return;
      if (e.target.closest('.draggable, .resize-handle, .el-resize, .box-resize, .titlebar, .tabs, .bottom-bar, .side-panels, ' +
        '.context-menu, .unindexed-strip, .toolbox, input, select, textarea, button')) return;
      var grid = document.querySelector('.grid');
      if (!grid) return;
      var g = grid.getBoundingClientRect();
      marquee = {
        x: e.clientX - g.left, y: e.clientY - g.top, startX: e.clientX, startY: e.clientY, pointerId: e.pointerId,
        add: e.shiftKey || e.ctrlKey || e.metaKey, before: selectedElements, beforePrimary: selectedElement, beforeRows: selectedRows, active: false
      };
      document.body.classList.add('marquee-selecting');
    });
    document.addEventListener('pointermove', function(e) {
      if (!marquee || e.pointerId !== marquee.pointerId) return;
      if (!(e.buttons & 1)) { endMarquee(true); return; }
      if (!marquee.active) {
        if (Math.abs(e.clientX - marquee.startX) < MARQUEE_THRESHOLD && Math.abs(e.clientY - marquee.startY) < MARQUEE_THRESHOLD) return;
        marquee.active = true;
        // Only once it is a drag, so a plain click keeps its target
        try { document.documentElement.setPointerCapture(e.pointerId); } catch { /* ignore */ }
      }
      updateMarquee(e);
    });
    document.addEventListener('pointerup', function(e) {
      if (marquee && e.pointerId === marquee.pointerId) endMarquee(true);
      // The click comes before this; without one, later clicks must get through
      setTimeout(function() { window.__frmSwallowClick = false; }, 0);
    });
    document.addEventListener('pointercancel', function(e) {
      if (marquee && e.pointerId === marquee.pointerId) endMarquee(false);
    });
    window.addEventListener('blur', function() { endMarquee(false); });
    document.addEventListener('click', function(e) {
      if (!window.__frmSwallowClick) return;
      window.__frmSwallowClick = false;
      e.preventDefault();
      e.stopImmediatePropagation();
    }, true);
  }

  // Tab Order Mode
  var tabOrderMode = false;
  var tabOrderSequence = [];
  
  var TAB_ORDER_CONTROLS = '.field input, .field select, .push input, .push button, .bottom-bar-button input, .bottom-bar-button button';

  function enterTabOrderMode() {
    tabOrderMode = true;
    disarm();
    tabOrderSequence = [];
    document.body.classList.add('tab-order-active');
    
    // Remove existing badges
    document.querySelectorAll('.tab-order-badge').forEach(function(el) { el.remove(); });
    
    // Controls must not react while picking: inert ones get no focus or keys, and clicks go to the element around them
    list(TAB_ORDER_CONTROLS).forEach(function(el) { el.inert = true; });

    // Highlight pickable fields, field-setting buttons, and Hidden Fields rows
    list('.field, .hidden-field-item').forEach(function(el) {
      if (!el.hasAttribute('data-no-index')) el.classList.add('tab-order-mode');
    });
    list('.push[data-pb-action="variable"]:not([data-unindexed])').forEach(function(el) {
      var field = fieldElForName(el.getAttribute('data-pb-name'));
      if (field && !field.hasAttribute('data-no-index')) el.classList.add('tab-order-mode');
    });
  }
  
  function exitTabOrderMode() {
    tabOrderMode = false;
    document.body.classList.remove('tab-order-active');
    list(TAB_ORDER_CONTROLS).forEach(function(el) { el.inert = false; });
    document.querySelectorAll('.tab-order-mode').forEach(function(el) {
      el.classList.remove('tab-order-mode');
    });
    document.querySelectorAll('.tab-order-badge').forEach(function(el) { el.remove(); });
  }
  
  function addFieldToTabOrder(fieldElement) {
    if (!fieldElement) return;
    // The number of a field without an index is made up and may be another field's
    if (fieldElement.hasAttribute('data-no-index')) {
      showNotice('This field has no index');
      return;
    }
    var fieldIndex = parseInt(fieldElement.getAttribute('data-field-idx'), 10);
    if (isNaN(fieldIndex)) return;
    
    // Check if already in sequence
    var existingIndex = tabOrderSequence.indexOf(fieldIndex);
    if (existingIndex >= 0) {
      // Remove from sequence and update badges
      tabOrderSequence.splice(existingIndex, 1);
      updateTabOrderBadges();
    } else {
      // Add to sequence
      tabOrderSequence.push(fieldIndex);
      updateTabOrderBadges();
    }
  }
  
  function fieldElForName(fieldName) {
    if (!fieldName) return null;
    var attr = '[data-field-name="' + CSS.escape(fieldName) + '"]';
    var indexed = attr + ':not([data-no-index])';
    return document.querySelector('.field' + indexed) || document.querySelector('.hidden-field-item' + indexed) ||
      document.querySelector('.field' + attr) || document.querySelector('.hidden-field-item' + attr);
  }

  function addButtonToTabOrder(buttonElement) {
    var name = buttonElement.getAttribute('data-pb-name');
    var fieldEl = fieldElForName(name);
    if (fieldEl) addFieldToTabOrder(fieldEl);
    else if (name) showNotice('No field ' + name + ' on this form');
  }

  function placeTabOrderBadge(el, order) {
    if (!el) return;
    var badge = document.createElement('div');
    badge.className = 'tab-order-badge';
    badge.textContent = String(order + 1);
    el.style.position = 'relative';
    el.appendChild(badge);
  }

  function updateTabOrderBadges() {
    document.querySelectorAll('.tab-order-badge').forEach(function(el) { el.remove(); });

    tabOrderSequence.forEach(function(fieldIndex, order) {
      var idxAttr = '[data-field-idx="' + fieldIndex + '"]:not([data-no-index])';
      var fieldEl = document.querySelector('.field' + idxAttr);
      var hiddenEl = document.querySelector('.hidden-field-item' + idxAttr);
      var fieldName = (fieldEl && fieldEl.getAttribute('data-field-name')) ||
        (hiddenEl && hiddenEl.getAttribute('data-field-name'));
      placeTabOrderBadge(fieldEl, order);
      placeTabOrderBadge(hiddenEl, order);
      if (fieldName) {
        document.querySelectorAll('.push[data-pb-name="' + CSS.escape(fieldName) + '"]').forEach(function(btnEl) {
          placeTabOrderBadge(btnEl, order);
        });
      }
    });
  }
  
  function confirmTabOrder() {
    if (tabOrderSequence.length === 0) {
      // Skip if no fields selected
      return;
    }
    
    if (vscodeApi && vscodeApi.postMessage) {
      vscodeApi.postMessage({
        command: 'confirmTabOrder',
        fieldOrder: tabOrderSequence
      });
    }
    
    exitTabOrderMode();
  }
  
  function cancelTabOrder() {
    exitTabOrderMode();
    if (vscodeApi && vscodeApi.postMessage) {
      vscodeApi.postMessage({
        command: 'cancelTabOrder'
      });
    }
  }
  
  // Wire up tab order button
  var tabOrderBtn = document.getElementById('tabOrderBtn');
  if (tabOrderBtn) {
    tabOrderBtn.addEventListener('click', function() {
      if (!tabOrderMode) {
        enterTabOrderMode();
      } else {
        // If already in mode, show context menu to confirm/cancel
        showTabOrderContextMenu(event);
      }
    });
  }
  
  function showTabOrderContextMenu(e) {
    var menu = document.getElementById('tabOrderContextMenu');
    if (!menu) return;
    
    menu.classList.remove('hidden');
    menu.style.left = e.clientX + 'px';
    menu.style.top = e.clientY + 'px';
    
    // Close on outside click
    setTimeout(function() {
      document.addEventListener('click', function closeMenu(evt) {
        if (!menu.contains(evt.target)) {
          menu.classList.add('hidden');
          document.removeEventListener('click', closeMenu);
        }
      });
    }, 0);
  }
  
  // Override right-click in tab order mode (capture phase to prevent other handlers)
  document.addEventListener('contextmenu', function(e) {
    if (tabOrderMode) {
      e.preventDefault();
      e.stopPropagation();
      showTabOrderContextMenu(e);
      return false;
    }
  }, true); // Use capture phase

  // Pick a field, its Hidden Fields row, or a field-setting button (capture, before source/delete)
  document.addEventListener('click', function(e) {
    if (!tabOrderMode) return;

    var fieldEl = e.target.closest('.field, .hidden-field-item');
    if (fieldEl) {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      addFieldToTabOrder(fieldEl);
      return;
    }

    var buttonEl = e.target.closest('.push');
    if (buttonEl) {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      if (buttonEl.getAttribute('data-pb-action') === 'variable') addButtonToTabOrder(buttonEl);
    }
  }, true);
  
  // Handle tab order context menu actions (bubble phase, after capture)
  document.addEventListener('click', function(e) {
    var item = e.target.closest('.context-menu-item');
    if (!item) return;
    
    var action = item.getAttribute('data-action');
    var menu = document.getElementById('tabOrderContextMenu');
    if (action === 'confirm-tab-order') {
      e.preventDefault();
      e.stopPropagation();
      confirmTabOrder();
      if (menu) menu.classList.add('hidden');
      return false;
    } else if (action === 'cancel-tab-order') {
      e.preventDefault();
      e.stopPropagation();
      cancelTabOrder();
      if (menu) menu.classList.add('hidden');
      return false;
    }
  });

  // Window resize: drag the grid's right/bottom edge or corner to set port_size= rows cols
  var sizeDrag = null;
  var portRows = D.portRows; // as written in the file, 0 = auto
  var portCols = D.portCols;
  var gridRows = D.rows; // as displayed
  var gridCols = D.cols;

  function placementEnd(start, end) {
    var s = parseInt(start, 10);
    if (!isFinite(s)) return 0;
    var m = /^span\s+(\d+)/.exec(String(end || '').trim());
    if (m) return s + parseInt(m[1], 10) - 1;
    var n = parseInt(end, 10);
    return isFinite(n) && n > s ? n - 1 : s;
  }

  // Dim elements that reach outside the window and make room for them so they don't cover the side panels
  function updateOverflow(rows, cols) {
    var grid = document.querySelector('.grid');
    if (!grid) return;
    var maxRow = rows, maxCol = cols;
    Array.prototype.forEach.call(grid.children, function(el) {
      if (!el.style || !el.style.gridRowStart) return;
      var endRow = placementEnd(el.style.gridRowStart, el.style.gridRowEnd);
      var endCol = placementEnd(el.style.gridColumnStart, el.style.gridColumnEnd);
      el.classList.toggle('frm-overflow', endRow > rows || endCol > cols);
      if (endRow > maxRow) maxRow = endRow;
      if (endCol > maxCol) maxCol = endCol;
    });
    var area = document.querySelector('.form-area');
    if (area) {
      area.style.paddingRight = maxCol > cols ? 'calc(' + (maxCol - cols) + ' * (var(--col-w) + var(--col-gap)))' : '';
      area.style.paddingBottom = maxRow > rows ? 'calc(' + (maxRow - rows) + ' * (var(--row-h) + var(--row-gap)))' : '';
    }
  }

  function setGridSize(rows, cols) {
    var grid = document.querySelector('.grid');
    if (!grid) return;
    grid.style.gridTemplateRows = 'repeat(' + rows + ', var(--row-h))';
    grid.style.gridTemplateColumns = 'repeat(' + cols + ', var(--col-w))';
    grid.style.width = 'calc(' + cols + ' * var(--col-w) + ' + (cols - 1) + ' * var(--col-gap))';
    grid.style.height = 'calc(' + rows + ' * var(--row-h) + ' + (rows - 1) + ' * var(--row-gap))';
    updateOverflow(rows, cols);
  }

  function hideResizeContextMenu() {
    var menu = document.getElementById('resizeContextMenu');
    if (menu) menu.classList.add('hidden');
  }

  function setupWindowResize() {
    var frame = document.getElementById('gridFrame');
    var grid = document.querySelector('.grid');
    var label = document.getElementById('resizeSizeLabel');
    if (!frame || !grid) return;
    updateOverflow(gridRows, gridCols);

    function showLabel(rows, cols) {
      if (!label) return;
      label.textContent = rows + ' rows \u00d7 ' + cols + ' cols';
      label.classList.remove('hidden');
    }

    function endDrag(commit) {
      if (!sizeDrag) return;
      var d = sizeDrag;
      sizeDrag = null;
      try { d.handle.releasePointerCapture(d.pointerId); } catch { /* ignore */ }
      frame.classList.remove('resizing', 'resizing-e', 'resizing-s', 'resizing-se');
      if (label) label.classList.add('hidden');
      var changed = d.rows !== d.startRows || d.cols !== d.startCols;
      if (!commit) {
        if (changed) setGridSize(d.startRows, d.startCols);
        return;
      }
      if (!changed) return;
      gridRows = d.rows;
      gridCols = d.cols;
      var msg = { command: 'setPortSize' };
      if (d.dir !== 's') { msg.cols = d.cols; portCols = d.cols; }
      if (d.dir !== 'e') { msg.rows = d.rows; portRows = d.rows; }
      if (vscodeApi && vscodeApi.postMessage) vscodeApi.postMessage(msg);
    }

    frame.querySelectorAll('.resize-handle').forEach(function(handle) {
      var dir = handle.getAttribute('data-resize');

      handle.addEventListener('pointerdown', function(e) {
        if (e.button !== 0 || tabOrderMode || document.querySelector('.modal-overlay:not(.hidden)')) return;
        e.preventDefault();
        e.stopPropagation();
        hideResizeContextMenu();
        var cs = getComputedStyle(grid);
        var colGap = parseFloat(cs.columnGap) || 0;
        var rowGap = parseFloat(cs.rowGap) || 0;
        sizeDrag = {
          dir: dir, handle: handle, pointerId: e.pointerId,
          x: e.clientX, y: e.clientY,
          startRows: gridRows, startCols: gridCols, rows: gridRows, cols: gridCols,
          colPitch: (grid.clientWidth + colGap) / gridCols,
          rowPitch: (grid.clientHeight + rowGap) / gridRows
        };
        try { handle.setPointerCapture(e.pointerId); } catch { /* ignore */ }
        frame.classList.add('resizing', 'resizing-' + dir);
        showLabel(gridRows, gridCols);
      });

      handle.addEventListener('pointermove', function(e) {
        if (!sizeDrag || sizeDrag.handle !== handle) return;
        var d = sizeDrag;
        var cols = d.cols, rows = d.rows;
        if (dir !== 's' && d.colPitch > 0) cols = Math.max(1, d.startCols + Math.round((e.clientX - d.x) / d.colPitch));
        if (dir !== 'e' && d.rowPitch > 0) rows = Math.max(1, d.startRows + Math.round((e.clientY - d.y) / d.rowPitch));
        if (rows !== d.rows || cols !== d.cols) {
          d.rows = rows;
          d.cols = cols;
          setGridSize(rows, cols);
        }
        showLabel(d.rows, d.cols);
      });

      handle.addEventListener('pointerup', function() { endDrag(true); });
      handle.addEventListener('pointercancel', function() { endDrag(false); });
      handle.addEventListener('click', function(e) { e.stopPropagation(); });

      handle.addEventListener('contextmenu', function(e) {
        e.preventDefault();
        e.stopPropagation();
        if (sizeDrag) return;
        try { hideContextMenu(); hideElementContextMenu(); hideOutsideContextMenu(); } catch { /* ignore */ }
        var menu = document.getElementById('resizeContextMenu');
        if (!menu) return;
        menu.querySelectorAll('[data-resize-action]').forEach(function(item) {
          var action = item.getAttribute('data-resize-action');
          var show = dir === 'se' || (dir === 'e' && action === 'width') || (dir === 's' && action === 'height');
          var alreadyAuto = action === 'width' ? portCols === 0 : action === 'height' ? portRows === 0 : (portRows === 0 && portCols === 0);
          item.classList.toggle('hidden', !show);
          item.classList.toggle('disabled', alreadyAuto);
        });
        menu.classList.remove('hidden');
        menu.style.left = e.clientX + 'px';
        menu.style.top = e.clientY + 'px';
      });
    });

    document.querySelectorAll('#resizeContextMenu [data-resize-action]').forEach(function(item) {
      item.addEventListener('click', function(e) {
        e.preventDefault();
        e.stopPropagation();
        hideResizeContextMenu();
        var action = item.getAttribute('data-resize-action');
        var msg = { command: 'setPortSize' };
        if (action !== 'height') msg.cols = 0;
        if (action !== 'width') msg.rows = 0;
        if (vscodeApi && vscodeApi.postMessage) vscodeApi.postMessage(msg);
      });
    });

    document.addEventListener('click', function(e) {
      if (!e.target.closest('#resizeContextMenu')) hideResizeContextMenu();
    });
    document.addEventListener('contextmenu', function(e) {
      if (!e.target.closest('.resize-handle')) hideResizeContextMenu();
    }, true);
    document.addEventListener('keydown', function(e) {
      if (e.key === 'Escape') {
        if (sizeDrag) { e.preventDefault(); e.stopPropagation(); endDrag(false); }
        hideResizeContextMenu();
      }
    }, true);
  }

  // Stretching fields, images and previews: drag an edge/corner handle, or Shift+Arrow.
  // A box is { row, col, rows, cols } as drawn; a field's drawn width is len + 2 for dropdowns.
  var elResize = null;

  // Span from a grid-row / grid-column value such as "3 / span 16" or "3 / 19"
  function elSpan(value) {
    var parts = String(value || '').split('/');
    var end = (parts[1] || '').trim();
    var m = /^span\s+(\d+)/.exec(end);
    if (m) return Math.max(1, parseInt(m[1], 10));
    var s = parseInt(parts[0], 10), n = parseInt(end, 10);
    return (isFinite(s) && isFinite(n) && n > s) ? n - s : 1;
  }

  function elBox(el) {
    var st = el.style;
    return {
      row: parseInt(el.getAttribute('data-row'), 10),
      col: parseInt(el.getAttribute('data-col'), 10),
      rows: elSpan(st.gridRow),
      cols: elSpan(st.gridColumn)
    };
  }

  function fieldExtra(el) {
    return parseInt(el.getAttribute('data-field-extra'), 10) || 0;
  }

  function elMinCols(el) {
    return el.getAttribute('data-type') === 'field' ? 1 + fieldExtra(el) : 1;
  }

  function elIndex(el) {
    var type = el.getAttribute('data-type');
    if (el.getAttribute('data-no-index')) return NaN;
    var attr = type === 'field' ? 'data-field-idx' : type === 'image' ? 'data-image-idx' : type === 'preview' ? 'data-preview-idx' :
      type === 'listview' ? 'data-listview-idx' : null;
    return attr ? parseInt(el.getAttribute(attr), 10) : NaN;
  }

  function canStretch(el) {
    if (!el) return false;
    var type = el.getAttribute('data-type');
    return (type === 'field' || type === 'image' || type === 'preview' || type === 'listview') && isFinite(elIndex(el));
  }

  function sameBox(a, b) {
    return a.row === b.row && a.col === b.col && a.rows === b.rows && a.cols === b.cols;
  }

  // Move edges by whole cells. e/s change the size; w/n move the start and keep the opposite edge.
  function stretchedBox(start, dir, dRows, dCols, minCols, minRows) {
    minRows = minRows || 1;
    var b = { row: start.row, col: start.col, rows: start.rows, cols: start.cols };
    var right = start.col + start.cols - 1;
    var bottom = start.row + start.rows - 1;
    if (dir.indexOf('e') >= 0) b.cols = Math.max(minCols, start.cols + dCols);
    if (dir.indexOf('w') >= 0) {
      b.col = Math.max(1, Math.min(start.col + dCols, right - minCols + 1));
      b.cols = right - b.col + 1;
    }
    if (dir.indexOf('s') >= 0) b.rows = Math.max(minRows, start.rows + dRows);
    if (dir.indexOf('n') >= 0) {
      b.row = Math.max(1, Math.min(start.row + dRows, bottom - minRows + 1));
      b.rows = bottom - b.row + 1;
    }
    return b;
  }

  function applyElBox(el, b) {
    var type = el.getAttribute('data-type');
    el.setAttribute('data-row', b.row);
    el.setAttribute('data-col', b.col);
    el.style.gridRow = type === 'field' ? String(b.row) : b.row + ' / span ' + b.rows;
    el.style.gridColumn = b.col + ' / span ' + b.cols;
    if (type === 'field') el.setAttribute('data-field-len', String(b.cols - fieldExtra(el)));
    if (type === 'preview') {
      el.setAttribute('data-preview-rows', String(b.rows));
      el.setAttribute('data-preview-cols', String(b.cols));
    }
    if (type === 'listview') {
      el.setAttribute('data-listview-rows', String(b.rows));
      el.setAttribute('data-listview-cols', String(b.cols));
      updateListviewScroll(el);
    }
    updateOverflow(gridRows, gridCols);
  }

  function sendElResize(el, b) {
    if (!vscodeApi || !vscodeApi.postMessage) return;
    var type = el.getAttribute('data-type');
    var msg = { command: 'resizeElement', type: type, index: elIndex(el), row: b.row, col: b.col };
    if (type === 'field') {
      msg.len = b.cols - fieldExtra(el);
    } else {
      msg.rows = b.rows;
      msg.cols = b.cols;
    }
    vscodeApi.postMessage(msg);
  }

  function stretchSelectedElement(key) {
    var el = selectedElement;
    if (!canStretch(el) || tabOrderMode) return;
    var dCols = key === 'ArrowRight' ? 1 : key === 'ArrowLeft' ? -1 : 0;
    var dRows = key === 'ArrowDown' ? 1 : key === 'ArrowUp' ? -1 : 0;
    if (dRows && el.getAttribute('data-type') === 'field') return; // fields have no height
    var start = elBox(el);
    var b = stretchedBox(start, dRows ? 's' : 'e', dRows, dCols, elMinCols(el));
    if (sameBox(start, b)) return;
    applyElBox(el, b);
    sendElResize(el, b);
  }

  function setupElementResize() {
    var frame = document.getElementById('gridFrame');
    var label = document.getElementById('elResizeLabel');

    function showLabel(el, b) {
      if (!label || !frame) return;
      label.textContent = el.getAttribute('data-type') === 'field'
        ? 'len ' + (b.cols - fieldExtra(el))
        : b.rows + ' rows \u00d7 ' + b.cols + ' cols';
      var fr = frame.getBoundingClientRect();
      var r = el.getBoundingClientRect();
      label.style.left = (r.left - fr.left) + 'px';
      label.style.top = (r.bottom - fr.top + 4) + 'px';
      label.classList.remove('hidden');
    }

    function endStretch(commit) {
      if (!elResize) return;
      var d = elResize;
      elResize = null;
      try { d.handle.releasePointerCapture(d.pointerId); } catch { /* ignore */ }
      d.handle.classList.remove('active');
      d.el.classList.remove('el-resizing');
      d.el.setAttribute('draggable', 'true');
      if (label) label.classList.add('hidden');
      if (sameBox(d.start, d.box)) return;
      if (!commit) {
        applyElBox(d.el, d.start);
        return;
      }
      sendElResize(d.el, d.box);
    }

    document.querySelectorAll('.draggable > .el-resize').forEach(function(handle) {
      var el = handle.parentElement;
      var dir = handle.getAttribute('data-el-resize');

      handle.addEventListener('pointerdown', function(e) {
        if (e.button !== 0 || tabOrderMode || document.querySelector('.modal-overlay:not(.hidden)')) return;
        if (!canStretch(el) || e.ctrlKey || e.metaKey || e.shiftKey) return; // with a modifier it is a click to select
        var m = getGridMetrics();
        if (!m) return;
        e.preventDefault();
        e.stopPropagation();
        selectElement(el);
        el.setAttribute('draggable', 'false'); // keep the native move-drag from starting
        var start = elBox(el);
        elResize = {
          el: el, handle: handle, dir: dir, pointerId: e.pointerId,
          x: e.clientX, y: e.clientY, start: start, box: start,
          minCols: elMinCols(el), colPitch: m.colPitch, rowPitch: m.rowPitch
        };
        try { handle.setPointerCapture(e.pointerId); } catch { /* ignore */ }
        handle.classList.add('active');
        el.classList.add('el-resizing');
        showLabel(el, start);
      });

      handle.addEventListener('pointermove', function(e) {
        if (!elResize || elResize.handle !== handle) return;
        var d = elResize;
        var dCols = d.colPitch > 0 ? Math.round((e.clientX - d.x) / d.colPitch) : 0;
        var dRows = d.rowPitch > 0 ? Math.round((e.clientY - d.y) / d.rowPitch) : 0;
        var b = stretchedBox(d.start, d.dir, dRows, dCols, d.minCols);
        if (!sameBox(b, d.box)) {
          d.box = b;
          applyElBox(el, b);
        }
        showLabel(el, d.box);
      });

      handle.addEventListener('pointerup', function() { endStretch(true); });
      handle.addEventListener('pointercancel', function() { endStretch(false); });
      handle.addEventListener('click', function(e) { if (!e.ctrlKey && !e.metaKey && !e.shiftKey) e.stopPropagation(); });
      handle.addEventListener('dragstart', function(e) { e.preventDefault(); });
    });

    // On very narrow elements the edge strips would cover everything: show them only once selected
    document.querySelectorAll('.field.draggable, .image.draggable, .preview.draggable').forEach(function(el) {
      el.addEventListener('pointerenter', function() {
        var r = el.getBoundingClientRect();
        var isField = el.getAttribute('data-type') === 'field';
        el.classList.toggle('el-narrow', r.width < 24 || (!isField && r.height < 18));
      });
    });

    document.addEventListener('keydown', function(e) {
      if (e.key === 'Escape' && elResize) {
        e.preventDefault();
        e.stopPropagation();
        endStretch(false);
      }
    }, true);
  }

  // Stretching a text's box from any edge or corner. The box's top-left corner is the text's file row/col,
  // so the n and w edges move the text too. A box is { row, col, rows, cols } in #[rows,cols]* terms;
  // it is drawn rows + 1 tall. Stays inside the window (port_size) and wide enough for its label.
  var BOX_OFFSET = D.boxOffset;
  var boxResize = null;

  function textOfBox(box) {
    return document.querySelector('.grid > .text[data-text-idx="' + box.getAttribute('data-text-idx') + '"]');
  }

  function boxOfText(el) {
    return document.querySelector('.grid > .box.stretchable[data-text-idx="' + el.getAttribute('data-text-idx') + '"]');
  }

  // Room for the left line, the label (its measured span) and a column of line after it
  function boxMinCols(textEl) {
    return BOX_OFFSET + elSpan(textEl.style.gridColumn) + 2;
  }

  function readTextBox(textEl) {
    return {
      row: parseInt(textEl.getAttribute('data-row'), 10),
      col: parseInt(textEl.getAttribute('data-col'), 10),
      rows: parseInt(textEl.getAttribute('data-box-rows'), 10),
      cols: parseInt(textEl.getAttribute('data-box-cols'), 10)
    };
  }

  function applyTextBox(textEl, box, b) {
    updateElementPosition(textEl, b.row, b.col); // carries the box along to the new corner
    box.style.gridRow = b.row + ' / span ' + (b.rows + 1);
    box.style.gridColumn = b.col + ' / span ' + b.cols;
    textEl.setAttribute('data-box-rows', String(b.rows));
    textEl.setAttribute('data-box-cols', String(b.cols));
    fitBoxGaps();
    updateOverflow(gridRows, gridCols);
  }

  function stretchedTextBox(start, dir, dRows, dCols, minCols) {
    var drawn = { row: start.row, col: start.col, rows: start.rows + 1, cols: start.cols };
    var b = stretchedBox(drawn, dir, dRows, dCols, minCols, 2);
    // Only the e and s edges can grow past the window; never clamp below where the box already reached
    var maxRight = Math.max(gridCols, drawn.col + drawn.cols - 1);
    var maxBottom = Math.max(gridRows, drawn.row + drawn.rows - 1);
    if (b.col + b.cols - 1 > maxRight) b.cols = Math.max(minCols, maxRight - b.col + 1);
    if (b.row + b.rows - 1 > maxBottom) b.rows = Math.max(2, maxBottom - b.row + 1);
    return { row: b.row, col: b.col, rows: b.rows - 1, cols: b.cols };
  }

  function setupBoxResize() {
    var frame = document.getElementById('gridFrame');
    var label = document.getElementById('elResizeLabel');
    var grid = document.querySelector('.grid');

    function showLabel(box, b) {
      if (!label || !frame) return;
      label.textContent = b.rows + ' rows \u00d7 ' + b.cols + ' cols';
      var fr = frame.getBoundingClientRect();
      var r = box.getBoundingClientRect();
      label.style.left = (r.left - fr.left) + 'px';
      label.style.top = (r.bottom - fr.top + 4) + 'px';
      label.classList.remove('hidden');
    }

    function endBoxStretch(commit) {
      if (!boxResize) return;
      var d = boxResize;
      boxResize = null;
      try { d.handle.releasePointerCapture(d.pointerId); } catch { /* ignore */ }
      d.handle.classList.remove('active');
      d.box.classList.remove('box-resizing');
      if (label) label.classList.add('hidden');
      if (sameBox(d.start, d.cur)) return;
      if (!commit) {
        applyTextBox(d.text, d.box, d.start);
        return;
      }
      if (vscodeApi && vscodeApi.postMessage) {
        vscodeApi.postMessage({
          command: 'resizeElement', type: 'text', index: parseInt(d.text.getAttribute('data-text-idx'), 10),
          row: d.cur.row, col: d.cur.col, rows: d.cur.rows, cols: d.cur.cols
        });
      }
    }

    document.querySelectorAll('.grid > .box.stretchable > .box-resize').forEach(function(handle) {
      var box = handle.parentElement;
      var dir = handle.getAttribute('data-box-resize');

      handle.addEventListener('pointerdown', function(e) {
        if (e.button !== 0 || tabOrderMode || inlineEdit || document.querySelector('.modal-overlay:not(.hidden)')) return;
        var text = textOfBox(box);
        var m = getGridMetrics();
        if (!text || !m) return;
        var start = readTextBox(text);
        if (!isFinite(start.rows) || !isFinite(start.cols)) return;
        e.preventDefault();
        e.stopPropagation();
        selectElement(text);
        boxResize = {
          box: box, text: text, handle: handle, dir: dir, pointerId: e.pointerId,
          x: e.clientX, y: e.clientY, start: start, cur: start,
          minCols: boxMinCols(text), colPitch: m.colPitch, rowPitch: m.rowPitch
        };
        try { handle.setPointerCapture(e.pointerId); } catch { /* ignore */ }
        handle.classList.add('active');
        box.classList.add('box-resizing');
        showLabel(box, start);
      });

      handle.addEventListener('pointermove', function(e) {
        if (!boxResize || boxResize.handle !== handle) return;
        var d = boxResize;
        var dCols = d.colPitch > 0 ? Math.round((e.clientX - d.x) / d.colPitch) : 0;
        var dRows = d.rowPitch > 0 ? Math.round((e.clientY - d.y) / d.rowPitch) : 0;
        var b = stretchedTextBox(d.start, d.dir, dRows, dCols, d.minCols);
        if (!sameBox(b, d.cur)) {
          d.cur = b;
          applyTextBox(d.text, d.box, b);
        }
        showLabel(d.box, d.cur);
      });

      handle.addEventListener('pointerup', function() { endBoxStretch(true); });
      handle.addEventListener('pointercancel', function() { endBoxStretch(false); });
      handle.addEventListener('click', function(e) { e.stopPropagation(); });
      handle.addEventListener('contextmenu', function(e) { e.preventDefault(); e.stopPropagation(); });
    });

    // Handles also show while the box's label is hovered or selected (not while it is being edited)
    function syncBoxOwners() {
      document.querySelectorAll('.grid > .box.stretchable').forEach(function(box) {
        var t = textOfBox(box);
        var on = !!t && t.classList.contains('selected') && !t.classList.contains('inline-editing');
        if (box.classList.contains('owner-selected') !== on) box.classList.toggle('owner-selected', on);
      });
    }
    if (grid && typeof MutationObserver === 'function') {
      new MutationObserver(syncBoxOwners).observe(grid, { subtree: true, attributes: true, attributeFilter: ['class'] });
    }
    syncBoxOwners();
    document.querySelectorAll('.grid > .text[data-box-rows][data-text-idx]').forEach(function(t) {
      t.addEventListener('pointerenter', function() { var b = boxOfText(t); if (b) b.classList.add('owner-hover'); });
      t.addEventListener('pointerleave', function() { var b = boxOfText(t); if (b) b.classList.remove('owner-hover'); });
    });

    document.addEventListener('keydown', function(e) {
      if (e.key === 'Escape' && boxResize) {
        e.preventDefault();
        e.stopPropagation();
        endBoxStretch(false);
      }
    }, true);
  }

  // ---------------------------------------------------------------------
  // Keyboard shortcuts, modal keyboard/backdrop handling, context-menu navigation
  // ---------------------------------------------------------------------
  var pendingSelection = null; // { keys, primary }: new elements (duplicates) the extension wants selected after the next refresh
  var backdropPress = null;

  function isVisible(el) {
    return !!(el && el.getClientRects().length);
  }

  function topModal() {
    var open = document.querySelectorAll('.modal-overlay:not(.hidden)');
    return open.length ? open[open.length - 1] : null;
  }

  function isTypingTarget(t) {
    if (!t || !t.tagName) return false;
    if (t.classList && t.classList.contains('inline-edit')) return true; // in-place header/text editor
    if (t.closest && t.closest('.props-panel')) return true; // keys in the Properties panel are its own
    if (t.closest && t.closest('.draggable')) return false; // mock controls drawn inside form elements
    if (t.isContentEditable || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT') return true;
    return t.tagName === 'INPUT' && !/^(checkbox|radio|button|submit|reset|range)$/i.test(t.type);
  }

  // Canvas shortcuts are off while a dialog is open or the user is typing
  function shortcutsBlocked(e) {
    return !!topModal() || isTypingTarget(e.target);
  }

  function focusablesIn(container) {
    return Array.prototype.filter.call(
      container.querySelectorAll('input:not([type="hidden"]), select, textarea, button, [tabindex]:not([tabindex="-1"])'),
      function(el) { return !el.disabled && isVisible(el); }
    );
  }

  function focusFirstModalInput(modal) {
    var focusables = focusablesIn(modal);
    var target = focusables.filter(function(el) {
      return el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && isTypingTarget(el));
    })[0] || focusables[0];
    if (!target) return;
    target.focus({ preventScroll: true });
    // Cursor at the end, nothing selected, so typing never wipes an existing value
    try { var n = target.value.length; target.setSelectionRange(n, n); } catch { /* e.g. number inputs */ }
  }

  function restoreCanvasFocus() {
    var active = document.activeElement;
    if (active && active.closest && active.closest('.modal-overlay, .props-panel')) active.blur();
    if (selectedElement && document.contains(selectedElement)) {
      selectedElement.focus({ preventScroll: true });
    }
  }

  function modalSnapshot(modal) {
    return JSON.stringify(Array.prototype.map.call(modal.querySelectorAll('input, select, textarea'), function(el) {
      return (el.type === 'checkbox' || el.type === 'radio') ? el.checked : el.value;
    }));
  }

  function isModalDirty(modal) {
    return modal.__frmSnapshot !== undefined && modalSnapshot(modal) !== modal.__frmSnapshot;
  }

  function cancelModal(modal) {
    var btn = modal.querySelector('[data-action="cancel"]');
    if (btn) btn.click(); else hideModal(modal.id);
  }

  function confirmModal(modal) {
    var btn = modal.querySelector('.modal-buttons .modal-button.primary[data-action^="confirm"]');
    if (btn) btn.click();
  }

  // Inline "Discard changes?" bar, shown when clicking outside a dialog with changes
  function discardBarOf(modal) {
    var box = modal.querySelector('.modal');
    if (!box) return null;
    var bar = box.querySelector('.modal-discard-bar');
    if (!bar) {
      bar = document.createElement('div');
      bar.className = 'modal-discard-bar hidden';
      bar.innerHTML = '<span>Discard changes?</span>' +
        '<button type="button" class="modal-button" data-discard="keep">Keep editing</button>' +
        '<button type="button" class="modal-button danger" data-discard="discard">Discard</button>';
      bar.querySelector('[data-discard="keep"]').addEventListener('click', function() { hideDiscardBar(modal, true); });
      bar.querySelector('[data-discard="discard"]').addEventListener('click', function() { cancelModal(modal); });
      box.appendChild(bar);
    }
    return bar;
  }

  function isDiscardBarOpen(modal) {
    var bar = modal.querySelector('.modal-discard-bar');
    return !!bar && !bar.classList.contains('hidden');
  }

  function showDiscardBar(modal) {
    var bar = discardBarOf(modal);
    if (!bar) return;
    modal.__frmFocusBeforeBar = document.activeElement;
    bar.classList.remove('hidden');
    bar.querySelector('[data-discard="keep"]').focus({ preventScroll: true });
  }

  function hideDiscardBar(modal, refocus) {
    var bar = modal.querySelector('.modal-discard-bar');
    if (!bar || bar.classList.contains('hidden')) return;
    bar.classList.add('hidden');
    if (!refocus) return;
    var prev = modal.__frmFocusBeforeBar;
    if (prev && modal.contains(prev) && isVisible(prev)) prev.focus({ preventScroll: true });
    else focusFirstModalInput(modal);
  }

  // Keep Tab / Shift+Tab inside the container
  function trapTab(e, container) {
    var items = focusablesIn(container);
    if (!items.length) { e.preventDefault(); return; }
    var first = items[0];
    var last = items[items.length - 1];
    var active = document.activeElement;
    if (!container.contains(active)) {
      (e.shiftKey ? last : first).focus();
      e.preventDefault();
    } else if (e.shiftKey && active === first) {
      last.focus();
      e.preventDefault();
    } else if (!e.shiftKey && active === last) {
      first.focus();
      e.preventDefault();
    }
  }

  function openContextMenu() {
    return Array.prototype.filter.call(document.querySelectorAll('.context-menu:not(.hidden)'), isVisible)[0] || null;
  }

  function clearMenuHighlight() {
    document.querySelectorAll('.context-menu-item.kbd-active').forEach(function(i) { i.classList.remove('kbd-active'); });
  }

  function hideAllContextMenus() {
    hideContextMenu();
    hideElementContextMenu();
    hideOutsideContextMenu();
    hideResizeContextMenu();
    var tabMenu = document.getElementById('tabOrderContextMenu');
    if (tabMenu) tabMenu.classList.add('hidden');
    clearMenuHighlight();
  }

  function moveMenuHighlight(menu, delta) {
    var items = Array.prototype.filter.call(menu.querySelectorAll('.context-menu-item'), function(i) {
      return isVisible(i) && !i.classList.contains('disabled');
    });
    if (!items.length) return;
    var cur = items.indexOf(menu.querySelector('.context-menu-item.kbd-active'));
    var next = cur < 0 ? (delta > 0 ? 0 : items.length - 1) : (cur + delta + items.length) % items.length;
    clearMenuHighlight();
    items[next].classList.add('kbd-active');
  }

  function elementIndexOf(el) {
    var attr = {
      text: 'data-text-idx', field: 'data-field-idx', pushbutton: 'data-push-idx',
      image: 'data-image-idx', preview: 'data-preview-idx', bgimage: 'data-bgimage-idx', listview: 'data-listview-idx'
    }[el.getAttribute('data-type')];
    var n = attr ? parseInt(el.getAttribute(attr), 10) : NaN;
    return isFinite(n) ? n : null;
  }

  // Rows the element covers (a boxed text label covers its box)
  function rowSpanOfElement(el) {
    var boxRows = parseInt(el.getAttribute('data-box-rows'), 10);
    if (boxRows > 0) return boxRows;
    var m = /span (\d+)/.exec(String(el.style.gridRow || ''));
    return m ? parseInt(m[1], 10) : 1;
  }

  // Rows an element's copy must clear; a drawn box reaches into one more row than its size
  function coveredRows(el) {
    return rowSpanOfElement(el) + (el.hasAttribute('data-box-rows') ? 1 : 0);
  }

  // Same column. One element: one row down; stays put when that would leave the form.
  // A group: below itself, or as far down as fits.
  function duplicateSelected() {
    if (tabOrderMode || !vscodeApi || !vscodeApi.postMessage || groupKeysBlocked()) return;
    var backgrounds = actionRows().filter(function(row) { return row.classList.contains('bg-item'); });
    if (backgrounds.length < selectedRows.length) showNotice('Selected triggers and hidden fields not changed');
    var els = actionTargets();
    if (els.some(isListview)) {
      els = els.filter(function(el) { return !isListview(el); });
      showNotice('The list view table can\'t be duplicated');
    }
    if (!els.length && !backgrounds.length) return;
    var rowOf = function(el) { return parseInt(el.getAttribute('data-row'), 10); };
    var down;
    if (!els.length) {
      down = 0;
    } else if (els.length === 1) {
      down = rowOf(els[0]) + rowSpanOfElement(els[0]) <= gridRows ? 1 : 0;
    } else {
      var top = Math.min.apply(null, els.map(rowOf));
      var bottom = Math.max.apply(null, els.map(function(el) { return rowOf(el) + coveredRows(el) - 1; }));
      down = Math.max(0, Math.min(bottom - top + 1, gridRows - bottom));
    }
    noticeOtherTabs(els.length + ' duplicated');
    vscodeApi.postMessage({
      command: 'duplicateElements',
      elements: els.map(function(el) { return Object.assign(elementRef(el), { row: rowOf(el) + down }); })
        .concat(backgrounds.map(function(row) { return Object.assign(elementRef(row), { row: 1 }); })),
      primary: els.length ? elementRef(els.indexOf(selectedElement) >= 0 ? selectedElement : els[els.length - 1]) : undefined
    });
  }

  // Same as choosing Edit in the element's context menu
  function openElementEditor(element) {
    focusPropsPanel(element);
  }

  function consumeKey(e) {
    e.preventDefault();
    e.stopImmediatePropagation();
  }

  // Capture phase: runs before the canvas handler, which moves/deletes/deselects the selected element
  function onShortcutKeydown(e) {
    var mod = e.ctrlKey || e.metaKey;
    var zoomAction = zoomActionFromKey(e);
    if (zoomAction) {
      consumeKey(e);
      handleZoomAction(zoomAction);
      return;
    }
    var modal = topModal();
    var menu = openContextMenu();

    // Esc closes one layer per press. An open native <select> list swallows Esc itself.
    if (e.key === 'Escape') {
      if (marquee) { endMarquee(false); consumeKey(e); return; }
      if (cancelToolDrags()) { consumeKey(e); return; }
      if (sizeDrag || elResize || boxResize) return; // the resize handlers cancel the drag
      if (menu) { hideAllContextMenus(); consumeKey(e); return; }
      if (modal) {
        if (isDiscardBarOpen(modal)) hideDiscardBar(modal, true); else cancelModal(modal);
        consumeKey(e);
        return;
      }
      if (tabOrderMode) { cancelTabOrder(); consumeKey(e); return; }
      if (window.__frmArmed && !inlineEdit) { disarm(); consumeKey(e); return; }
      return; // the canvas handler deselects
    }

    if (modal) {
      if (isDiscardBarOpen(modal)) {
        if (e.key === 'Enter') { hideDiscardBar(modal, true); consumeKey(e); }
        else if (e.key === 'Tab') trapTab(e, modal.querySelector('.modal-discard-bar'));
        return;
      }
      if (e.key === 'Enter' && mod) { confirmModal(modal); consumeKey(e); return; }
      if (e.key === 'Tab') { trapTab(e, modal.querySelector('.modal') || modal); return; }
      if (e.key === '?' && modal.id === 'shortcutsModal') { hideModal('shortcutsModal'); consumeKey(e); }
      return;
    }

    if (menu) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        moveMenuHighlight(menu, e.key === 'ArrowDown' ? 1 : -1);
        consumeKey(e);
        return;
      }
      if (e.key === 'Enter') {
        var active = menu.querySelector('.context-menu-item.kbd-active');
        if (active) active.click();
        consumeKey(e);
        return;
      }
    }

    if (isTypingTarget(e.target)) return;

    if (tabOrderMode) {
      if (e.key === 'Enter') { confirmTabOrder(); consumeKey(e); }
      return;
    }

    var key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    if (mod && !e.altKey && (key === 'z' || key === 'y')) {
      if (vscodeApi && vscodeApi.postMessage) {
        vscodeApi.postMessage({ command: (key === 'y' || e.shiftKey) ? 'redo' : 'undo' });
      }
      consumeKey(e);
      return;
    }
    if (mod && !e.altKey && !e.shiftKey && key === 'd') {
      duplicateSelected();
      consumeKey(e);
      return;
    }
    if (mod && !e.altKey && !e.shiftKey && (key === 'c' || key === 'x' || key === 'v')) {
      // Not in the middle of a drag
      var dragging = draggedElement || sizeDrag || elResize || boxResize || marquee || placing || toolDrag || toolboxDrag;
      if (!dragging && !e.repeat) {
        if (key !== 'c') { hideAllContextMenus(); disarm(); }
        if (key === 'v') pasteElements();
        else if (!copySelected(key === 'x')) return; // text selected on the page can still be copied
      }
      consumeKey(e);
      return;
    }
    if (mod && !e.altKey && !e.shiftKey && key === 'a') {
      selectAll();
      consumeKey(e);
      return;
    }
    if (!mod && !e.altKey && !e.shiftKey && !e.repeat && !menu && TOOL_KEYS[key]) {
      // Not in the middle of a drag
      if (!draggedElement && !sizeDrag && !elResize && !boxResize && !marquee && !placing && !toolDrag && !toolboxDrag) useToolKey(key);
      consumeKey(e);
      return;
    }
    if (!mod && !e.altKey && e.key === '?') {
      showModal('shortcutsModal');
      consumeKey(e);
      return;
    }
    if (!mod && !e.altKey && !e.shiftKey && (e.key === 'F2' || e.key === 'Enter') && selectedRows.length === 1 && !selectedElements.length &&
        !isTriggerRow(selectedRows[0]) && !(e.key === 'Enter' && e.target && e.target.tagName === 'BUTTON')) {
      // A background or hidden field
      focusPropsPanel(selectedRows[0]);
      consumeKey(e);
      return;
    }
    var editKey = !mod && !e.altKey && !e.shiftKey && (e.key === 'F2' || e.key === 'Enter') &&
      !(e.key === 'Enter' && e.target && e.target.tagName === 'BUTTON' && !e.target.closest('.draggable'));
    // Several selected: the panel edits what they share
    if (editKey && selectedElements.length + selectedRows.length > 1 && focusPanelInput()) {
      consumeKey(e);
      return;
    }
    if (editKey && selectedRows.length) {
      showNotice(selectedElements.length + selectedRows.length > 1 ? 'Triggers can\'t be edited together with other elements' : 'Triggers are edited from their row');
      consumeKey(e);
      return;
    }
    if (editKey && selectedElement) {
      if (!editKeysBlocked()) openElementEditor(selectedElement);
      consumeKey(e);
    }
  }

  function setupShortcuts() {
    document.addEventListener('keydown', onShortcutKeydown, true);

    // A backdrop click counts only when the press also started on the backdrop
    // (so drag-selecting text in an input and releasing outside does nothing)
    document.addEventListener('mousedown', function(e) {
      backdropPress = (e.target.classList && e.target.classList.contains('modal-overlay')) ? e.target : null;
    }, true);
    document.addEventListener('click', function(e) {
      var overlay = backdropPress;
      backdropPress = null;
      if (!overlay || e.target !== overlay || overlay.classList.contains('hidden')) return;
      if (isModalDirty(overlay)) showDiscardBar(overlay); else cancelModal(overlay);
    });

    // A menu opened by mouse starts without a keyboard highlight
    document.addEventListener('contextmenu', clearMenuHighlight, true);
    document.addEventListener('click', function(e) {
      if (!e.target.closest('.context-menu')) clearMenuHighlight();
    }, true);

    window.addEventListener('message', function(ev) {
      var msg = ev.data;
      if (msg && msg.command === 'frmSelectAfterRefresh' && Array.isArray(msg.keys)) {
        var isRow = function(key) { return /^bgimage:/.test(key); };
        pendingSelection = {
          keys: msg.keys.filter(function(key) { return !isRow(key); }), primary: isRow(msg.primary || '') ? null : msg.primary, visual: [], triggers: [],
          rows: (msg.hiddenFields || []).map(function(index) { return 'field:' + index; }).concat(msg.keys.filter(isRow)), triggerLines: msg.triggerLines || []
        };
      }
      if (msg && msg.command === 'frmNotice' && typeof msg.text === 'string') showNotice(msg.text, 5000);
      if (msg && msg.command === 'frmZoom' && typeof msg.action === 'string') {
        handleZoomAction(msg.action);
      }
    });

    var shortcutsModal = document.getElementById('shortcutsModal');
    if (shortcutsModal) {
      shortcutsModal.querySelector('[data-action="cancel"]').addEventListener('click', function() {
        hideModal('shortcutsModal');
      });
    }
    var shortcutsBtn = document.getElementById('shortcutsBtn');
    if (shortcutsBtn) {
      shortcutsBtn.addEventListener('click', function() { showModal('shortcutsModal'); });
    }

    if (/Mac|iPhone|iPad/.test(navigator.platform || '')) {
      document.querySelectorAll('[data-kbd-mod]').forEach(function(el) {
        el.textContent = el.textContent.replace(/Ctrl/g, '⌘');
        if (el.title) el.title = el.title.replace(/Ctrl/g, '⌘');
      });
    }
  }

  // ---- Properties panel -------------------------------------------------------------------------------
  // The selected elements' properties, written to the file while they are typed. The panel's children
  // outlive page updates (data-keep-children), so an input keeps its focus and unsent text. Its listeners
  // sit on the panel itself and are added again on every run of this script, like all the others.
  var propsState = window.__frmPropsState = window.__frmPropsState ||
    { sig: '', session: '', seq: 0, timer: null, flush: null, column: null, bgKind: {}, images: null, imagesAsked: false };
  var propValues = D.props || {};
  var propDefs = D.propDefs || {};
  var PROPS_DELAY_MS = 250;
  var SHOWN_TYPE = { pushbutton: 'button', listview: 'page_listview' };
  var NOUNS = { text: 'text', field: 'field', pushbutton: 'button', image: 'image', preview: 'preview', listview: 'table', bgimage: 'background' };
  var TEXT_KINDS = ['int', 'text', 'lines', 'image', 'range'];
  // What sets one element apart: shown only while one element is selected
  var SINGLE_ONLY = ['name', 'nameAngle', 'nameQuoted', 'label', 'content'];

  function propsPanel() { return document.getElementById('propsPanel'); }

  function refOfKey(key) {
    var parts = key.split(':');
    return { type: parts[0], index: Number(parts[1]) };
  }

  function uniq(list) {
    return list.filter(function(v, i) { return list.indexOf(v) === i; });
  }

  // What the panel changes: the selected form elements and Hidden Fields / Backgrounds rows, by key
  function propsTargets() {
    var keys = [];
    selectedElements.concat(selectedRows.filter(function(row) { return !isTriggerRow(row); })).forEach(function(el) {
      if (isLocked(el)) return;
      var key = elementKey(el);
      if (propValues[key] && keys.indexOf(key) < 0) keys.push(key);
    });
    return keys;
  }

  // Everything about a property but its label, to tell whether two types share it
  function defShape(def) {
    return JSON.stringify([def.kind, def.min, def.max, def.optional, def.pattern, def.options, def.bits]);
  }

  // The properties every element has in the same form, in the first one's order, whose conditions hold for all
  function sharedDefs(keys) {
    var types = uniq(keys.map(function(k) { return refOfKey(k).type; }));
    return (propDefs[types[0]] || []).filter(function(def) {
      var shared = types.every(function(t) {
        return (propDefs[t] || []).some(function(d) { return d.key === def.key && defShape(d) === defShape(def); });
      });
      return shared && keys.every(function(k) {
        var values = propValues[k].values;
        if (values[def.key] === undefined) return false; // a bottom-bar button's row, tabs on a form without tabs
        return !def.when || def.when.values.indexOf(values[def.when.key]) >= 0;
      });
    });
  }

  function countText(keys) {
    var byType = {};
    keys.forEach(function(k) { var t = refOfKey(k).type; byType[t] = (byType[t] || 0) + 1; });
    return Object.keys(byType).map(function(t) { return byType[t] + ' ' + NOUNS[t] + (byType[t] > 1 ? 's' : ''); }).join(', ');
  }

  // What the panel shows: a title and rows, each a property and the elements it changes
  function propsLayout(keys) {
    if (!keys.length) return null;
    var column = propsState.column;
    if (column && keys.length === 1 && keys[0] === column.key && propValues['field:' + column.field]) {
      var fieldKey = 'field:' + column.field;
      var textKey = 'text:' + column.field;
      var heading = { key: 'content', label: 'Heading', kind: 'text' };
      if (!propValues[textKey]) heading.hint = 'No text(' + column.field + ') to show as the heading';
      return {
        title: 'Column: field(' + column.field + ')', sub: propValues[fieldKey].values.name, fields: [fieldKey],
        rows: [{ def: heading, keys: propValues[textKey] ? [textKey] : [] }].concat(sharedDefs([fieldKey]).map(function(def) {
          return { def: def, keys: [fieldKey] };
        }))
      };
    }
    var ref = refOfKey(keys[0]);
    var single = keys.length === 1;
    return {
      title: single ? (SHOWN_TYPE[ref.type] || ref.type) + '(' + ref.index + ')' : keys.length + ' elements',
      sub: single ? (ref.type === 'field' ? propValues[keys[0]].values.name : '') : countText(keys),
      fields: keys.filter(function(k) { return /^field:/.test(k); }),
      rows: sharedDefs(keys).filter(function(def) { return single || SINGLE_ONLY.indexOf(def.key) < 0; }).map(function(def) {
        return { def: def, keys: keys };
      })
    };
  }

  // A row's value: the same in all its elements, or mixed
  function rowValue(row) {
    var all = row.keys.map(function(k) { return propValues[k].values[row.def.key]; });
    var same = all.every(function(v) { return v === all[0]; });
    return { value: same && all.length ? all[0] : '', mixed: !same, all: all };
  }

  function flagBits(expr) {
    return String(expr || '').split('+').reduce(function(all, n) { return all | (Number(n) || 0); }, 0);
  }

  function tabList(value) {
    if (value === 'all') return tabs.map(function(t) { return t.id; });
    return value ? value.split(' ').map(Number) : [];
  }

  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function(name) {
      var v = attrs[name];
      if (v === null || v === undefined || v === false) return;
      if (name === 'text') node.textContent = v;
      else node.setAttribute(name, v === true ? '' : v);
    });
    (children || []).forEach(function(c) { if (c) node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
    return node;
  }

  function hexOf(file) {
    var m = /^RGB\s*\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)$/i.exec(file || '');
    if (!m) return '#ffffff';
    return '#' + [m[1], m[2], m[3]].map(function(n) { return ('0' + Math.min(255, Number(n)).toString(16)).slice(-2); }).join('');
  }

  function rgbOf(hex) {
    return 'RGB(' + [1, 3, 5].map(function(i) { return parseInt(hex.slice(i, i + 2), 16); }).join(',') + ')';
  }

  function isColour(file) { return /^RGB\s*\(/i.test(file || ''); }

  // A background shows its picture controls, or its colour; Picture can be chosen before a file is typed
  function bgKindOf(key, file) {
    return propsState.bgKind[key] || (isColour(file) ? 'color' : 'picture');
  }

  // The control of one row; data-prop and data-keys say what it changes
  function buildControl(row, n) {
    var def = row.def;
    var id = 'prop-' + n;
    var common = { 'data-prop': def.key, 'data-keys': row.keys.join(' '), 'data-kind': def.kind, id: id };
    if (!row.keys.length) common.disabled = true;
    switch (def.kind) {
      case 'check':
        return el('label', { class: 'props-check' }, [el('input', Object.assign({ type: 'checkbox' }, common)), ' ' + def.label]);
      case 'select':
        return el('select', common, def.options.map(function(o) { return el('option', { value: o.value, text: o.label }); }));
      case 'lines':
        return el('textarea', Object.assign({ rows: 3, spellcheck: 'false' }, common));
      case 'flags':
        return el('div', { class: 'props-flags', 'data-group': def.key }, def.bits.map(function(b) {
          return el('label', { class: 'props-check' }, [
            el('input', Object.assign({}, common, { type: 'checkbox', id: null, 'data-bit': b.bit })), ' ' + b.label + ' (' + b.bit + ')'
          ]);
        }).concat([el('div', { class: 'props-flags-sum', 'data-flags-sum': def.key })]));
      case 'tabs':
        return el('div', { class: 'props-flags' }, [
          el('label', { class: 'props-check' }, [el('input', Object.assign({}, common, { type: 'checkbox', id: null, 'data-tab': 'all' })), ' All tabs'])
        ].concat(tabs.map(function(t) {
          return el('label', { class: 'props-check' }, [
            el('input', Object.assign({}, common, { type: 'checkbox', id: null, 'data-tab': t.id })), ' ' + t.label.replace(/_/g, ' ')
          ]);
        })));
      case 'range':
        return el('div', { class: 'props-range' }, [
          el('input', Object.assign({ type: 'range', min: def.min, max: def.max, step: 1 }, common)),
          el('span', { class: 'props-range-value', 'data-range-value': def.key })
        ]);
      case 'bgsize':
        return el('div', { class: 'props-pair' }, [
          el('select', Object.assign({}, common, { 'data-part': 'mode' }), [
            el('option', { value: '-1', text: 'Stretch' }), el('option', { value: '0', text: 'Original size' }), el('option', { value: 'px', text: 'Pixels' })
          ]),
          el('input', Object.assign({ type: 'text', inputmode: 'numeric', 'aria-label': def.label + ' in pixels' }, common, { id: null, 'data-part': 'px' }))
        ]);
      case 'bgfile': {
        var key = row.keys[0];
        var colour = bgKindOf(key, rowValue(row).value) === 'color';
        return el('div', { class: 'props-bgfile' }, [
          el('div', { class: 'props-pair' }, ['picture', 'color'].map(function(kind) {
            return el('label', { class: 'props-check' }, [
              el('input', Object.assign({}, common, { type: 'radio', id: null, name: id + '-kind', 'data-part': 'kind', value: kind, checked: (kind === 'color') === colour })),
              kind === 'color' ? ' Colour' : ' Picture'
            ]);
          })),
          colour
            ? el('input', Object.assign({ type: 'color' }, common, { 'data-part': 'color' }))
            : el('input', Object.assign({ type: 'text', list: 'propsImages', spellcheck: 'false', placeholder: 'File name, such as logo.png' }, common, { 'data-part': 'file' }))
        ]);
      }
      default: {
        var attrs = Object.assign({ type: 'text', spellcheck: 'false', autocomplete: 'off' }, common);
        if (def.kind === 'int') attrs.inputmode = 'numeric';
        if (def.kind === 'image') attrs.list = 'propsImages';
        if (def.suggest === 'fields') attrs.list = 'propsFields';
        return el('input', attrs);
      }
    }
  }

  // The panel's markup for a layout; values are filled in by fillProps
  function buildProps(panel, layout) {
    panel.textContent = '';
    panel.appendChild(el('div', { class: 'props-header' }, [
      el('div', { class: 'props-title', text: layout.title }),
      layout.sub ? el('div', { class: 'props-sub', text: layout.sub }) : null
    ]));
    var body = el('div', { class: 'props-body' });
    var line = null;
    layout.rows.forEach(function(row, n) {
      var def = row.def;
      var label = def.kind === 'check' ? null : el('label', { class: 'props-label', for: ['flags', 'tabs'].indexOf(def.kind) < 0 ? 'prop-' + n : null, text: def.label });
      var field = el('div', { class: 'props-field', 'data-field': def.key }, [
        label, buildControl(row, n), def.hint ? el('small', { class: 'props-hint', text: def.hint }) : null
      ]);
      if (def.key === 'group') field.appendChild(el('small', { class: 'props-warning hidden', 'data-group-warning': '', text: 'Not in any group' }));
      if (def.pair && line) {
        line.appendChild(field);
      } else {
        line = el('div', { class: 'props-line' }, [field]);
        body.appendChild(line);
      }
    });
    if (layout.fields.length) {
      body.appendChild(el('div', { class: 'props-actions' }, [
        el('button', { type: 'button', class: 'props-button', 'data-action': 'hide-fields', 'data-keys': layout.fields.join(' '),
          text: layout.fields.length > 1 ? 'Hide ' + layout.fields.length + ' fields' : 'Hide field' })
      ]));
    }
    body.appendChild(el('datalist', { id: 'propsFields' }, (D.fieldNames || []).map(function(name) { return el('option', { value: name }); })));
    body.appendChild(el('datalist', { id: 'propsImages' }, (propsState.images || []).map(function(name) { return el('option', { value: name }); })));
    panel.appendChild(body);
  }

  function rowsByProp(layout) {
    var map = {};
    layout.rows.forEach(function(row) { map[row.def.key + '|' + row.keys.join(' ')] = row; });
    return map;
  }

  // Put the file's values in the controls. The input being typed in keeps what it has.
  function fillProps(panel, layout) {
    var rows = rowsByProp(layout);
    var active = document.activeElement;
    panel.querySelectorAll('[data-prop]').forEach(function(control) {
      var row = rows[control.getAttribute('data-prop') + '|' + control.getAttribute('data-keys')];
      if (!row) return;
      var v = rowValue(row);
      var kind = row.def.kind;
      var typing = control === active && control.type !== 'checkbox' && control.type !== 'radio' && control.tagName !== 'SELECT';
      if (typing) return;
      control.classList.remove('invalid');
      if (kind === 'flags') {
        var bit = Number(control.getAttribute('data-bit'));
        var on = v.all.filter(function(x) { return (flagBits(x) & bit) !== 0; }).length;
        control.checked = on === v.all.length && on > 0;
        control.indeterminate = on > 0 && on < v.all.length;
      } else if (kind === 'tabs') {
        var tab = control.getAttribute('data-tab');
        var count = v.all.filter(function(x) { return tab === 'all' ? x === 'all' : tabList(x).indexOf(Number(tab)) >= 0; }).length;
        control.checked = count === v.all.length && count > 0;
        control.indeterminate = count > 0 && count < v.all.length;
      } else if (kind === 'check') {
        control.checked = !v.mixed && v.value === '1';
        control.indeterminate = v.mixed;
      } else if (kind === 'bgsize') {
        var px = v.value !== '-1' && v.value !== '0';
        if (control.getAttribute('data-part') === 'mode') control.value = v.mixed ? '' : px ? 'px' : v.value;
        else { control.value = px && !v.mixed ? v.value : ''; control.disabled = !px || v.mixed; }
      } else if (kind === 'bgfile') {
        var part = control.getAttribute('data-part');
        if (part === 'color') control.value = hexOf(v.value);
        else if (part === 'file') control.value = isColour(v.value) ? '' : v.value;
      } else if (kind === 'select') {
        control.value = v.mixed ? '' : v.value;
        if (v.mixed) control.selectedIndex = -1;
      } else {
        control.value = v.mixed ? '' : v.value;
        control.placeholder = v.mixed ? 'mixed' : '';
        if (kind === 'range') {
          var label = panel.querySelector('[data-range-value="' + row.def.key + '"]');
          if (label) label.textContent = v.mixed ? 'mixed' : v.value;
        }
      }
    });
    layout.rows.forEach(function(row) {
      if (row.def.kind === 'flags') {
        var sum = panel.querySelector('[data-flags-sum="' + row.def.key + '"]');
        var v = rowValue(row);
        if (sum) sum.textContent = v.mixed ? 'mixed' : '= ' + v.value + (/\+/.test(v.value) ? ' (' + flagBits(v.value) + ')' : '');
      }
      if (row.def.key === 'group') {
        var warning = panel.querySelector('[data-group-warning]');
        if (warning) warning.classList.toggle('hidden', !rowValue(row).all.some(function(g) { return g === ''; }));
      }
    });
  }

  // Which control has the focus, to find it again after the panel is rebuilt
  function controlId(control) {
    if (!control || !control.getAttribute || !control.hasAttribute('data-prop')) return null;
    return ['data-prop', 'data-keys', 'data-bit', 'data-tab', 'data-part'].map(function(a) { return control.getAttribute(a); }).join('|');
  }

  function findControl(panel, id) {
    var found = null;
    panel.querySelectorAll('[data-prop]').forEach(function(c) { if (!found && controlId(c) === id) found = c; });
    return found;
  }

  // Show the panel for the selection, or hide it. Runs after every selection change and page update.
  function updatePropsPanel() {
    var panel = propsPanel();
    if (!panel || !propsState) return;
    var keys = propsTargets();
    var layout = propsLayout(keys);
    var side = panel.closest('.side-panels');
    panel.classList.toggle('hidden', !layout);
    if (side) side.classList.toggle('props-open', !!layout);
    if (!layout) {
      flushProps();
      propsState.sig = '';
      panel.textContent = '';
      return;
    }
    var sig = JSON.stringify([layout.title, layout.rows.map(function(r) { return [r.def.key, r.keys]; }), keys.map(function(k) {
      return propValues[k].values.file !== undefined && refOfKey(k).type === 'bgimage' ? bgKindOf(k, propValues[k].values.file) : '';
    })]);
    if (sig !== propsState.sig) {
      flushProps();
      var focused = panel.contains(document.activeElement) ? controlId(document.activeElement) : null;
      buildProps(panel, layout);
      propsState.sig = sig;
      fillProps(panel, layout);
      var again = focused && findControl(panel, focused);
      if (again) again.focus({ preventScroll: true });
    } else {
      fillProps(panel, layout);
    }
    if (layout.rows.some(function(r) { return r.def.kind === 'image' || r.def.kind === 'bgfile'; })) askImages();
  }

  function askImages() {
    if (propsState.images || propsState.imagesAsked || !vscodeApi || !vscodeApi.postMessage) return;
    propsState.imagesAsked = true;
    vscodeApi.postMessage({ command: 'listImages', requestId: 'props-images' });
  }

  function onPropsMessage(ev) {
    var msg = ev.data;
    if (!msg || msg.command !== 'imagesListed' || msg.requestId !== 'props-images') return;
    propsState.images = (msg.images || []).map(function(img) { return img.name; });
    var list = document.getElementById('propsImages');
    if (list) {
      list.textContent = '';
      propsState.images.forEach(function(name) { list.appendChild(el('option', { value: name })); });
    }
  }

  function sendPropEdits(edits, session) {
    if (!edits.length || !vscodeApi || !vscodeApi.postMessage) return;
    vscodeApi.postMessage({ command: 'setProps', session: session || '', edits: edits });
  }

  function valueEdits(keys, prop, value) {
    return keys.map(function(k) { return Object.assign(refOfKey(k), { key: prop, value: value }); });
  }

  function flushProps() {
    clearTimeout(propsState.timer);
    var flush = propsState.flush;
    propsState.flush = null;
    if (flush) flush();
  }

  // Typing: written once it pauses, or when the input loses focus
  function queueProp(keys, prop, value) {
    clearTimeout(propsState.timer);
    var session = propsState.session;
    propsState.flush = function() { sendPropEdits(valueEdits(keys, prop, value), session); };
    propsState.timer = setTimeout(flushProps, PROPS_DELAY_MS);
  }

  function newSession() {
    propsState.session = 'p' + (++propsState.seq) + '-' + Date.now();
    return propsState.session;
  }

  function defFor(control) {
    var type = refOfKey(control.getAttribute('data-keys').split(' ')[0]).type;
    var prop = control.getAttribute('data-prop');
    if (propsState.column && prop === 'content' && type === 'text') return { key: 'content', kind: 'text' };
    return (propDefs[type] || []).filter(function(d) { return d.key === prop; })[0] || { key: prop, kind: 'text' };
  }

  function propValid(def, v) {
    var int = function(min, max) {
      return /^-?\d+$/.test(v) && Number(v) >= (min === undefined ? -Infinity : min) && Number(v) <= (max === undefined ? Infinity : max);
    };
    switch (def.kind) {
      case 'int': return (def.optional && v === '') || int(def.min, def.max);
      case 'range': return int(def.min, def.max);
      case 'bgsize': return int(1);
      case 'image': case 'bgfile': return v.trim() !== '' && !/[\r\n"]/.test(v);
      case 'text': return !/[\r\n]/.test(v) && (!def.pattern || new RegExp(def.pattern).test(v));
      default: return true;
    }
  }

  // The file's value of a control's property, for Esc
  function fileValueOf(control) {
    var keys = control.getAttribute('data-keys').split(' ');
    var prop = control.getAttribute('data-prop');
    var all = keys.map(function(k) { return propValues[k] ? propValues[k].values[prop] : ''; });
    return all.every(function(v) { return v === all[0]; }) ? all[0] : '';
  }

  function onPropsInput(e) {
    var control = e.target;
    if (!control.hasAttribute || !control.hasAttribute('data-prop')) return;
    var kind = control.getAttribute('data-kind');
    var part = control.getAttribute('data-part');
    var keys = control.getAttribute('data-keys').split(' ').filter(Boolean);
    if (!keys.length) return;
    if (control.type === 'checkbox' || control.type === 'radio' || control.tagName === 'SELECT') return; // their change event writes
    if (kind === 'bgfile' && part === 'color') {
      queueProp(keys, 'file', rgbOf(control.value));
      return;
    }
    if (TEXT_KINDS.indexOf(kind) < 0 && kind !== 'bgsize' && kind !== 'bgfile') return;
    var def = defFor(control);
    var value = kind === 'lines' ? control.value : control.value.trim();
    var ok = propValid(def, value);
    control.classList.toggle('invalid', !ok);
    if (kind === 'range') {
      var label = control.parentNode.querySelector('.props-range-value');
      if (label) label.textContent = control.value;
    }
    if (ok) queueProp(keys, control.getAttribute('data-prop'), value);
    else { clearTimeout(propsState.timer); propsState.flush = null; }
  }

  function onPropsChange(e) {
    var control = e.target;
    if (!control.hasAttribute || !control.hasAttribute('data-prop')) return;
    var kind = control.getAttribute('data-kind');
    var prop = control.getAttribute('data-prop');
    var keys = control.getAttribute('data-keys').split(' ').filter(Boolean);
    if (!keys.length) return;
    var part = control.getAttribute('data-part');
    // Typed values are written by their input event; leaving the input writes what is still waiting
    if (control.tagName === 'TEXTAREA' || (control.tagName === 'INPUT' && control.type !== 'checkbox' && control.type !== 'radio')) {
      flushProps();
      return;
    }
    var session = newSession();
    if (kind === 'flags') {
      var bit = Number(control.getAttribute('data-bit'));
      sendPropEdits(keys.map(function(k) { return Object.assign(refOfKey(k), { key: prop, bit: bit, on: control.checked }); }), session);
    } else if (kind === 'tabs') {
      var tab = control.getAttribute('data-tab');
      var ids = tabs.map(function(t) { return t.id; });
      var edits = [];
      var emptied = 0;
      keys.forEach(function(k) {
        var now = tabList(propValues[k].values.tabs);
        var next;
        if (tab === 'all') next = control.checked ? ids : [currentActiveTab];
        else if (control.checked) next = uniq(now.concat(Number(tab)));
        else next = now.filter(function(id) { return id !== Number(tab); });
        if (!next.length) { emptied++; return; }
        var value = ids.every(function(id) { return next.indexOf(id) >= 0; }) ? 'all' : next.sort(function(a, b) { return a - b; }).join(' ');
        edits.push(Object.assign(refOfKey(k), { key: 'tabs', value: value }));
        // The next click, before the file has caught up, starts from this
        propValues[k].values.tabs = value;
      });
      if (emptied) showNotice('An element must be on at least one tab');
      sendPropEdits(edits, session);
      updatePropsPanel();
    } else if (kind === 'check') {
      sendPropEdits(valueEdits(keys, prop, control.checked ? '1' : ''), session);
    } else if (kind === 'select') {
      sendPropEdits(valueEdits(keys, prop, control.value), session);
    } else if (kind === 'bgsize' && part === 'mode') {
      var px = control.parentNode.querySelector('[data-part="px"]');
      if (control.value === 'px') {
        px.disabled = false;
        if (!propValid({ kind: 'bgsize' }, px.value.trim())) px.value = '200';
        sendPropEdits(valueEdits(keys, prop, px.value.trim()), session);
        px.focus();
        px.select();
      } else {
        sendPropEdits(valueEdits(keys, prop, control.value), session);
      }
    } else if (kind === 'bgfile' && part === 'kind') {
      keys.forEach(function(k) { propsState.bgKind[k] = control.value; });
      if (control.value === 'color' && !isColour(fileValueOf(control))) sendPropEdits(valueEdits(keys, 'file', 'RGB(255,255,255)'), session);
      updatePropsPanel();
      var next = propsPanel().querySelector(control.value === 'color' ? '[data-part="color"]' : '[data-part="file"]');
      if (next) next.focus();
    }
  }

  function onPropsKeydown(e) {
    var control = e.target;
    if (!control.hasAttribute || !control.hasAttribute('data-prop')) return;
    if (e.key === 'Enter' && (control.tagName !== 'TEXTAREA' || e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      flushProps();
      restoreCanvasFocus();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      clearTimeout(propsState.timer);
      propsState.flush = null;
      var kind = control.getAttribute('data-kind');
      var typed = control.type !== 'checkbox' && control.type !== 'radio' && control.tagName !== 'SELECT' && kind !== 'bgsize' && kind !== 'bgfile';
      var file = fileValueOf(control);
      if (typed && control.value !== file) {
        control.value = file;
        control.classList.remove('invalid');
      } else {
        restoreCanvasFocus();
      }
    }
  }

  function onPropsFocus(e) {
    if (e.target.hasAttribute && e.target.hasAttribute('data-prop')) newSession();
  }

  function onPropsClick(e) {
    var hide = e.target.closest && e.target.closest('[data-action="hide-fields"]');
    if (!hide) return;
    var keys = hide.getAttribute('data-keys').split(' ').filter(Boolean);
    var session = newSession();
    sendPropEdits(valueEdits(keys, 'row', '1000').concat(valueEdits(keys, 'col', '1000')), session);
  }

  function setupPropsPanel() {
    var panel = propsPanel();
    if (!panel) return;
    panel.addEventListener('input', onPropsInput);
    panel.addEventListener('change', onPropsChange);
    panel.addEventListener('keydown', onPropsKeydown);
    panel.addEventListener('focusin', onPropsFocus);
    panel.addEventListener('focusout', function() { flushProps(); });
    panel.addEventListener('click', onPropsClick);
    window.addEventListener('message', onPropsMessage);
  }

  // F2, Enter, double-click and Edit: select the element and put the cursor in the panel
  function focusPropsPanel(element, prop) {
    if (!element) return;
    if (element.classList.contains('trigger-item')) {
      if (selectedRows.length !== 1 || selectedRows[0] !== element || selectedElements.length) setSelection([], null, null, null, [element]);
    } else if (selectedElements.length !== 1 || selectedElement !== element) {
      selectElement(element);
    }
    if (!focusPanelInput(prop) && isLocked(element)) showNotice('An element without an index can\'t be edited here');
  }

  // Put the cursor in the panel: in the given property, or the first input. False when the panel is hidden.
  function focusPanelInput(prop) {
    var panel = propsPanel();
    if (!panel || panel.classList.contains('hidden')) return false;
    var target = prop ? panel.querySelector('[data-prop="' + prop + '"]') : null;
    if (target) target.focus({ preventScroll: false });
    else focusFirstModalInput(panel);
    if (panel.contains(document.activeElement)) document.activeElement.scrollIntoView({ block: 'nearest' });
    return true;
  }

  // Initialize drag and drop and keyboard navigation after DOM is ready
  setupShortcuts(); // first, so its capture-phase Escape runs before the resize handlers end a drag
  setupPropsPanel();
  setupToolbox(); // before anything else that listens to the mouse, so nothing under an armed tool reacts
  setupWindowResize();
  setupElementResize();
  setupBoxResize();
  setupContextMenu();
  setupBackgrounds();
  setupDragAndDrop();
  setupMarquee(); // first, so its click handler can stop the one that deselects
  setupKeyboardNavigation();
  setupCodeSelection();
  setupListviewColumns();
  if (!tabs.length) layoutListviews(null);
  fitTextSpans();
  
  // Restore selection if it existed before this update
  restoreSelection();
  setupRowSelection();
  setupTriggerHover();
  window.__frmCarry = null;

  // Hooks for the bootstrap's in-place updates
  window.__frmHooks = {
    isBusy: function() {
      return !!draggedElement || !!sizeDrag || !!elResize || !!marquee || !!placing || !!toolDrag || !!toolboxDrag || !!inlineEdit || tabOrderMode || !!document.querySelector('.modal-overlay:not(.hidden)');
    },
    getSelection: function() {
      return pendingSelection ? Object.assign({}, pendingSelection, { otherwise: getSelection() }) : getSelection();
    }
  };
  tryCodeSelection(); // one that waited for this update
};

window.__frmMain(JSON.parse(document.getElementById('frmData').textContent));

// Report this page load's timing to the extension's output channel once the first frame is drawn
// (full loads only: in-place updates don't run this file again)
(function() {
  var api = window.__frmVscodeApi;
  if (!api) return;
  var mainDone = performance.now();
  requestAnimationFrame(function() {
    setTimeout(function() {
      // VS Code first loads an empty placeholder page into the frame and writes this page into it once that has loaded
      var nav = performance.getEntriesByType('navigation')[0];
      api.postMessage({ command: 'frmTiming', timeOrigin: performance.timeOrigin, placeholderLoaded: nav ? nav.domContentLoadedEventStart : null,
        htmlStart: window.__frmHtmlStart, scriptStart: window.__frmScriptStart, mainDone: mainDone, drawn: performance.now() });
    }, 0);
  });
})();
