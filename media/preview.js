// FRM preview page script. Loaded once per page; the extension sends later renders as
// { command: 'frmUpdate', body, data } messages. The page then patches its body to match the new
// markup, keeping every element that is still there, and runs the page logic again with the new data.

// Bootstrap: runs once per page load
(function() {
  if (window.__frmBoot) return;
  window.__frmBoot = true;
  window.__frmScriptStart = performance.now();
  var api = null;
  try { if (typeof acquireVsCodeApi === 'function') { api = acquireVsCodeApi(); } } catch (e) { /* ignore */ }
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
    try { return !!(window.__frmHooks && window.__frmHooks.isBusy()); } catch (e) { return false; }
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
      n.getAttribute('data-image-idx') || n.getAttribute('data-preview-idx');
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
      try { if (window.__frmHooks) carry.selection = window.__frmHooks.getSelection(); } catch (e) { /* ignore */ }
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
  var existingTabOrder = D.tabOrder; // existing tab_order from FRM file
  var defaultIgnoreValue = winstyle.toLowerCase() === 'only' ? 4 : 7;
  try {
    var fs = getComputedStyle(root).getPropertyValue('--frm-font-size').trim();
    // Never matches a size like "11px" (it was written as [\d.] inside a template string, which dropped the
    // backslash), so basePx stays 11. Keep it that way: this runs again after every update, when
    // --frm-font-size already holds the zoomed size, so reading it would compound the zoom.
    var m = fs.match(/([d.]+)/);
    if (m) basePx = parseFloat(m[1]);
  } catch (e) { /* ignore */ }
  var currentZoom = 1;
  var currentGridOn = true;

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
      var w = w - 1;
      probe.remove();
      root.style.setProperty('--col-w', w + 'px');
    } catch (e) { /* ignore */ }
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
      // Spans changed: refresh which elements reach outside the window
      if (typeof gridRows === 'number' && typeof gridCols === 'number') updateOverflow(gridRows, gridCols);
    } catch (e) { /* ignore */ }
  }

  function applyZoom(z, silent){
    var clamped = Math.max(0.5, Math.min(10, Number(z) || 1));
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

  function applyGrid(on, silent){
    currentGridOn = !!on;
    // Set alpha: on => 0.8, off => 0
    try { root.style.setProperty('--gridline-alpha', currentGridOn ? '0.8' : '0'); } catch(e){}
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
    } catch (e) { /* ignore */ }
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
    var gt = document.getElementById('gridToggle');
    if (gt) {
      gt.addEventListener('change', function(){
        applyGrid(!!this.checked);
      });
    }


  } catch (e) { /* ignore */ }

  // Initialize to provided initial zoom
  applyZoom(D.initialZoom, true);
  // Initialize gridlines from state or provided initial value
  (function(){
    var initial = (function(){
      try {
        var state = vscodeApi && vscodeApi.getState ? (vscodeApi.getState() || {}) : {};
        if (typeof state.gridOn === 'boolean') return state.gridOn;
      } catch (e) {}
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
  var initialActiveTab = D.initialActiveTab;
  var currentActiveTab = null; // Track the currently active tab
  function applyTab(tabId){
    try {
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
    } catch (e) { /* ignore */ }
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
    } catch (e) { /* ignore */ }
  }
  // Tabs an element is shown on; null when it doesn't depend on the tab
  function tabsOfElement(el) {
    var type = el.getAttribute('data-type');
    var lists = { text: tabTexts, field: tabFields, pushbutton: tabPushButtons, image: tabImages }[type];
    var index = elementIndexOf(el);
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
    } catch (e) { /* ignore */ }
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
    try { console.log('Context menu opened at row:', row, 'col:', col); } catch (e) { /* ignore */ }
    
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
      if (hasTabs) {
        moveItem.classList.remove('hidden');
      } else {
        moveItem.classList.add('hidden');
      }
    }

    // Texts toggle their box from here
    var boxItem = document.getElementById('toggleBoxMenuItem');
    if (boxItem) {
      var isText = elementType === 'text' && isFinite(elementIndex);
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
    } else if (elementType === 'image') {
      elementIndex = parseInt(element.getAttribute('data-image-idx'));
    } else if (elementType === 'preview') {
      elementIndex = parseInt(element.getAttribute('data-preview-idx'));
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
      } catch (e) {
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
        } catch (e) {
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
      if (dataValue) {
        elementData.value = dataValue;
      }
      if (!dataValue) {
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

    // Handle context menu item clicks
    document.querySelectorAll('#contextMenu .context-menu-item[data-action]').forEach(function(item) {
      item.addEventListener('click', function(e) {
        var action = this.getAttribute('data-action');
        if (!action) return;
        
        e.stopPropagation();
        e.preventDefault();
        hideContextMenu();
        
        switch(action) {
          case 'add-text':
            startNewTextEdit(contextMenuState.row, contextMenuState.col);
            break;
          case 'add-field':
            showModal('fieldModal');
            document.getElementById('fieldName').focus();
            break;
          case 'add-button-select':
            contextMenuState.buttonType = 'select';
            setupButtonModal('General Button');
            showModal('buttonModal');
            break;
          case 'add-button-checkbox':
            contextMenuState.buttonType = 'checkbox';
            setupButtonModal('Checkbox');
            showModal('buttonModal');
            break;
          case 'add-button-radio':
            contextMenuState.buttonType = 'radio';
            setupButtonModal('Radio Button');
            showModal('buttonModal');
            break;
          case 'add-preview':
            showModal('previewModal');
            document.getElementById('previewPath').focus();
            break;
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
        var elementData = elementContextMenuState.elementData;
        
        switch(action) {
          case 'edit-element':
            // Open appropriate modal with existing data
            if (elementType === 'text') {
              startTextEdit(elementContextMenuState.element);
            } else if (elementType === 'field') {
              document.getElementById('fieldModalTitle').textContent = 'Edit Field';
              document.getElementById('fieldName').value = elementData.name || '';
              
              // Set name format checkboxes
              document.getElementById('fieldNameAngle').checked = elementData.nameFormat?.angle || false;
              document.getElementById('fieldNameQuoted').checked = elementData.nameFormat?.quoted || false;
              
              // Parse type expression and set checkboxes
              var typeExpr = (elementData.type || '1').toString();
              var typeValues = typeExpr.split('+').map(function(v) { return v.trim(); });
              
              // Reset all checkboxes
              document.getElementById('fieldType1').checked = false;
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
              
              // Set checkboxes based on type expression
              typeValues.forEach(function(val) {
                if (val === '1') document.getElementById('fieldType1').checked = true;
                else if (val === '4') document.getElementById('fieldType4').checked = true;
                else if (val === '8') document.getElementById('fieldType8').checked = true;
                else if (val === '16') document.getElementById('fieldType16').checked = true;
                else if (val === '32') document.getElementById('fieldType32').checked = true;
                else if (val === '64') document.getElementById('fieldType64').checked = true;
                else if (val === '128') document.getElementById('fieldType128').checked = true;
                else if (val === '256') document.getElementById('fieldType256').checked = true;
                else if (val === '512') document.getElementById('fieldType512').checked = true;
                else if (val === '1024') document.getElementById('fieldType1024').checked = true;
                else if (val === '2048') document.getElementById('fieldType2048').checked = true;
                else if (val === '4096') document.getElementById('fieldType4096').checked = true;
                else if (val === '8192') document.getElementById('fieldType8192').checked = true;
                else if (val === '16384') document.getElementById('fieldType16384').checked = true;
                else if (val === '32768') document.getElementById('fieldType32768').checked = true;
              });
              
              document.getElementById('fieldType').value = typeExpr;
              document.getElementById('fieldLen').value = elementData.len || 10;
              
              // Populate dropdown values if any
              var valuesTextarea = document.getElementById('fieldValues');
              if (valuesTextarea && elementData.values && elementData.values.length > 0) {
                valuesTextarea.value = elementData.values.map(function(v) { return '"' + v + '"'; }).join(' ');
              } else if (valuesTextarea) {
                valuesTextarea.value = '';
              }
              updateFieldValuesHint();

              document.getElementById('fieldModal').setAttribute('data-edit-mode', 'true');
              document.getElementById('fieldModal').setAttribute('data-edit-index', elementIndex);
              document.getElementById('fieldModal').setAttribute('data-nameformat', JSON.stringify(elementData.nameFormat || {}));
              showModal('fieldModal');
              document.getElementById('fieldName').focus();
            } else if (elementType === 'pushbutton') {
              clearButtonModal();
              document.getElementById('buttonModalTitle').textContent = 'Edit Button';
              document.getElementById('buttonLabel').value = elementData.label || '';
              contextMenuState.buttonType = elementData.kind || 'select';
              document.getElementById('buttonModal').setAttribute('data-edit-mode', 'true');
              document.getElementById('buttonModal').setAttribute('data-edit-index', elementIndex);
              var actionSelect = document.getElementById('buttonActionType');
              if (actionSelect) {
                actionSelect.value = elementData.action === 'variable' ? 'variable' : 'program';
              }
              if (elementData.program) {
                document.getElementById('buttonProgram').value = elementData.program;
              }
              if (elementData.name) {
                document.getElementById('buttonVariable').value = elementData.name;
              }
              if (elementData.value) {
                document.getElementById('buttonValue').value = elementData.value;
              } else if (elementData.kind === 'checkbox') {
                document.getElementById('buttonValue').value = '1;0';
              } else if (elementData.kind === 'radio') {
                document.getElementById('buttonValue').value = '1';
              }
              setupButtonModal('Edit ' + (elementData.kind === 'checkbox' ? 'Checkbox' : elementData.kind === 'radio' ? 'Radio Button' : 'Button'));
              if (contextMenuState.buttonType === 'select') {
                updateButtonFieldVisibility();
              }
              showModal('buttonModal');
              document.getElementById('buttonLabel').focus();
            } else if (elementType === 'preview') {
              document.getElementById('previewModalTitle').textContent = 'Edit Preview';
              document.getElementById('previewPath').value = elementData.path || '$DIR_PICTS/file.vxp';
              document.getElementById('previewField').value = elementData.field || '';
              document.getElementById('previewRows').value = elementData.rows || 25;
              document.getElementById('previewCols').value = elementData.cols || 72;
              document.getElementById('previewMode').value = elementData.mode || '0';
              document.getElementById('previewPortType').value = elementData.portType || 'PORT_2D';
              document.getElementById('previewPortStyle').value = elementData.portStyle ?? 'SIMPLE';
              document.getElementById('previewModal').setAttribute('data-edit-mode', 'true');
              document.getElementById('previewModal').setAttribute('data-edit-index', elementIndex);
              showModal('previewModal');
              document.getElementById('previewPath').focus();
            }
            break;
          case 'move-element':
            // Open move modal
            document.getElementById('moveModalTitle').textContent = 'Set Tab Visibility for ' + elementType + '(' + elementIndex + ')';
            document.getElementById('moveModal').setAttribute('data-element-type', elementType);
            document.getElementById('moveModal').setAttribute('data-element-index', elementIndex);
            // Populate current visibility state
            populateTabVisibility(elementType, elementIndex);
            showModal('moveModal');
            break;
          case 'toggle-box':
            if (elementContextMenuState.element) toggleTextBox(elementContextMenuState.element);
            break;
          case 'duplicate-element':
            if (elementContextMenuState.element) {
              selectElement(elementContextMenuState.element);
              duplicateSelectedElement();
            }
            break;
          case 'delete-element':
            if (vscodeApi && vscodeApi.postMessage && elementIndex) {
              vscodeApi.postMessage({ command: 'deleteElement', elementType: elementType, elementIndex: elementIndex });
              removeFromSelection(elementContextMenuState.element);
            }
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
    setupMoveModal();
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

  function setupMoveModal() {
    var modal = document.getElementById('moveModal');
    if (!modal) return;

    // Handle ALL checkbox toggle
    var allCheckbox = document.getElementById('moveTabAll');
    if (allCheckbox) {
      allCheckbox.addEventListener('change', function() {
        var checkboxes = document.querySelectorAll('.move-tab-checkbox');
        checkboxes.forEach(function(cb) {
          cb.disabled = this.checked;
          if (this.checked) {
            cb.checked = false;
          }
        }.bind(this));
      });
    }

    // When individual checkboxes are clicked, uncheck ALL
    document.querySelectorAll('.move-tab-checkbox').forEach(function(cb) {
      cb.addEventListener('change', function() {
        if (this.checked && allCheckbox) {
          allCheckbox.checked = false;
        }
      });
    });

    // Cancel button
    modal.querySelector('[data-action="cancel"]').addEventListener('click', function() {
      hideModal('moveModal');
    });

    // Confirm button
    modal.querySelector('[data-action="confirm-move"]').addEventListener('click', function() {
      var elementType = modal.getAttribute('data-element-type');
      var elementIndex = parseInt(modal.getAttribute('data-element-index'));

      if (!elementType || !elementIndex) {
        return;
      }

      // Get selected tabs
      var targetTabIds = [];
      var allChecked = document.getElementById('moveTabAll').checked;
      
      if (allChecked) {
        targetTabIds = 'all';
      } else {
        document.querySelectorAll('.move-tab-checkbox:checked').forEach(function(cb) {
          targetTabIds.push(parseInt(cb.value));
        });
        
        if (targetTabIds.length === 0) {
          // Skip if no tabs selected
          return;
        }
      }

      // Send to VS Code
      if (vscodeApi && vscodeApi.postMessage) {
        vscodeApi.postMessage({
          command: 'moveElement',
          elementType: elementType,
          elementIndex: elementIndex,
          targetTabIds: targetTabIds
        });
      }

      hideModal('moveModal');
    });
  }

  function populateTabVisibility(elementType, elementIndex) {
    // Determine which tabs currently show this element
    var currentTabs = [];
    var optKey = 'opt_' + (elementType === 'pushbutton' ? 'pushbutton' : elementType);
    
    // Check each tab's opt_ list
    var tabLists = elementType === 'text' ? D.tabTexts :
                   elementType === 'field' ? D.tabFields :
                   elementType === 'pushbutton' ? D.tabPushButtons :
                   elementType === 'image' ? D.tabImages :
                   elementType === 'preview' ? D.tabPreviews : {};
    D.tabs.forEach(function(t) {
      if ((tabLists[t.id] || []).indexOf(elementIndex) !== -1) currentTabs.push(t.id);
    });
    
    // Check if element is visible on all tabs
    var allTabs = D.tabs.map(function(t) { return t.id; });
    var isOnAllTabs = allTabs.length > 0 && currentTabs.length === allTabs.length;
    
    // Update checkboxes
    document.getElementById('moveTabAll').checked = isOnAllTabs;
    document.querySelectorAll('.move-tab-checkbox').forEach(function(cb) {
      var tabId = parseInt(cb.value);
      cb.checked = !isOnAllTabs && currentTabs.indexOf(tabId) !== -1;
      cb.disabled = isOnAllTabs;
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
      if (v == null) { host.remove(); restoreCanvasFocus(); return; }
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

  function setupTextEdit() {
    document.addEventListener('dblclick', function(e) {
      if (e.target.closest('.inline-edit, .el-resize, .box-resize')) return;
      var el = e.target.closest('.grid > .text.draggable');
      if (!el || !el.hasAttribute('data-text-idx')) return;
      e.preventDefault();
      e.stopPropagation();
      startTextEdit(el);
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
          } catch (e) {
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
          var nameFormat = {
            angle: document.getElementById('fieldNameAngle').checked,
            quoted: document.getElementById('fieldNameQuoted').checked
          };
          vscodeApi.postMessage({
            command: 'addElement',
            elementType: 'field',
            row: targetRow,
            col: targetCol,
            name: name,
            nameFormat: nameFormat,
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

        // For checkbox/radio, get variable and value
        if (contextMenuState.buttonType === 'checkbox' || contextMenuState.buttonType === 'radio') {
          var variable = document.getElementById('buttonVariable').value.trim().toUpperCase();
          var value = document.getElementById('buttonValue').value.trim();

          if (!variable) {
            // Skip if no variable name
            return;
          }

          data.name = variable;
          data.value = value || '1;0';
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
            var variable = document.getElementById('buttonVariable').value.trim().toUpperCase();
            var value = document.getElementById('buttonValue').value.trim();
            
            if (!variable) {
              // Skip if no variable name
              return;
            }
            
            data.name = variable;
            data.value = value || '1';
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
    if (vscodeApi && vscodeApi.postMessage) {
      vscodeApi.postMessage({ type: 'deleteTrigger', target: target, program: program, flag: flag });
    }
  }

  function deleteHiddenField(event, fieldIndex) {
    if (event) {
      event.stopPropagation();
      event.preventDefault();
    }
    if (vscodeApi && vscodeApi.postMessage) {
      vscodeApi.postMessage({
        command: 'deleteElement',
        elementType: 'field',
        elementIndex: fieldIndex
      });
    }
  }

  function showHiddenFieldInSource(fieldIndex) {
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

  // Drag and Drop functionality
  var draggedElement = null;
  var dragOffset = { x: 0, y: 0 };
  var selectedElements = []; // every selected element
  var selectedElement = null; // the primary one: last clicked, or the one at the code cursor
  var codeTriggers = []; // triggers at the code cursor: { target, idx }, idx = row in the trigger list
  var hoverTrigger = null; // the trigger list row under the mouse, shown instead of codeTriggers
  var visualElements = []; // hidden fields and bottom-bar buttons highlighted from the code; never acted on

  function setupDragAndDrop() {
    var grid = document.querySelector('.grid');
    if (!grid) return;
    var hiddenPanel = document.getElementById('hiddenFieldsPanel');

    // Only fields on the form can be hidden; one without an index can't be moved in the file
    function canHide(element) {
      return !!element && element.getAttribute('data-type') === 'field' &&
        !element.classList.contains('hidden-field-item') && !element.hasAttribute('data-no-index');
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
        if ((e.ctrlKey || e.metaKey) && !tabOrderMode) toggleElement(this);
        else selectElement(this);
      });
      
      element.addEventListener('dragstart', function(e) {
        // Dragging moves this element only
        if (selectedElements.length !== 1 || selectedElement !== this) setSelection([this], this);
        draggedElement = this;
        this.classList.add('dragging');
        
        var rect = this.getBoundingClientRect();
        var gridRect = grid.getBoundingClientRect();
        dragOffset.x = e.clientX - rect.left;
        dragOffset.y = e.clientY - rect.top;
        
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/html', this.outerHTML);
        if (hiddenPanel && canHide(this)) hiddenPanel.classList.add('hide-drop-ready');
      });

      element.addEventListener('dragend', function(e) {
        this.classList.remove('dragging');
        draggedElement = null;
        grid.classList.remove('drag-over');
        hideDropTarget();
        clearHiddenPanel();
      });
    });

    document.querySelectorAll('.hidden-field-item[draggable="true"]').forEach(function(element) {
      element.addEventListener('dragstart', function(e) {
        draggedElement = this;
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

    function spanOf(start, end) {
      var m = /span\s+(\d+)/.exec(String(end || ''));
      if (m) return Math.max(1, parseInt(m[1], 10));
      var s = parseInt(start, 10), n = parseInt(end, 10);
      return (isFinite(s) && isFinite(n) && n > s) ? n - s : 1;
    }

    // The cell the dragged element would land on for this pointer position
    function computeDropTarget(e) {
      var m = getGridMetrics();
      if (!m || !draggedElement) return null;
      var isHidden = draggedElement.classList.contains('hidden-field-item');
      var colSpan, rowSpan, col, row;
      if (isHidden) {
        colSpan = Math.max(1, parseInt(draggedElement.getAttribute('data-span'), 10) || 1);
        rowSpan = 1;
        // Field starts in the cell under the pointer
        col = Math.floor((e.clientX - m.rect.left) / m.colPitch) + 1;
        row = Math.floor((e.clientY - m.rect.top) / m.rowPitch) + 1;
      } else {
        var st = draggedElement.style;
        colSpan = spanOf(st.gridColumnStart, st.gridColumnEnd);
        rowSpan = spanOf(st.gridRowStart, st.gridRowEnd);
        // Snap the element's top-left corner (where its drag image is) to the nearest cell
        col = Math.round((e.clientX - dragOffset.x - m.rect.left) / m.colPitch) + 1;
        row = Math.round((e.clientY - dragOffset.y - m.rect.top) / m.rowPitch) + 1;
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
      placeOnGrid(outline, t.m, t.row, t.col, t.rowSpan, t.colSpan);
      outline.classList.remove('hidden');
    }

    function hideDropTarget() {
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
      var isHiddenFieldSource = draggedElement.classList.contains('hidden-field-item');
      var newRow = target.row;
      var newCol = target.fileCol;

      // Update element position
      var type = draggedElement.getAttribute('data-type');
      var oldRow = parseInt(draggedElement.getAttribute('data-row'));
      var oldCol = parseInt(draggedElement.getAttribute('data-col'));
      
      if (newRow !== oldRow || newCol !== oldCol) {
        if (!isHiddenFieldSource) {
          updateElementPosition(draggedElement, newRow, newCol);
        }
        sendPositionUpdate(type, draggedElement, newRow, newCol, !isHiddenFieldSource);
      }
    });

    // Dropping a field on the Hidden Fields panel hides it. Anything else is not accepted as a drop,
    // so the browser shows its "not allowed" cursor.
    if (hiddenPanel) {
      hiddenPanel.addEventListener('dragover', function(e) {
        if (!canHide(draggedElement)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        this.classList.add('hide-drop-over');
      });

      hiddenPanel.addEventListener('dragleave', function(e) {
        if (!this.contains(e.relatedTarget)) this.classList.remove('hide-drop-over');
      });

      hiddenPanel.addEventListener('drop', function(e) {
        if (!canHide(draggedElement)) return;
        e.preventDefault();
        clearHiddenPanel();
        // Arrow keys and Delete must not act on an element that is no longer visible
        draggedElement.blur();
        removeFromSelection(draggedElement);
        sendPositionUpdate('field', draggedElement, 1000, 1000, false);
      });
    }
  }

  function updateElementPosition(element, newRow, newCol) {
    // A boxed text label carries its box along (the box sits at the label's file row/col)
    if (element.getAttribute('data-type') === 'text' && element.hasAttribute('data-box-rows')) {
      var box = document.querySelector('.grid > .box[data-row="' + element.getAttribute('data-row') + '"][data-col="' + element.getAttribute('data-col') + '"]');
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

  function sendPositionUpdate(type, element, newRow, newCol, alreadyDrawn) {
    if (!vscodeApi || !vscodeApi.postMessage) return;
    
    var data = {
      command: 'updatePosition',
      type: type,
      newRow: newRow,
      newCol: newCol,
      // false when the preview did not draw the move itself (e.g. dropped from the hidden list)
      alreadyDrawn: alreadyDrawn !== false
    };
    
    // Add type-specific identifiers
    if (type === 'text') {
      var idx = element.getAttribute('data-text-idx');
      if (idx) data.index = parseInt(idx);
    } else if (type === 'field') {
      var idx = element.getAttribute('data-field-idx');
      if (idx) data.index = parseInt(idx);
    } else if (type === 'pushbutton') {
      var idx = element.getAttribute('data-push-idx');
      if (idx) data.index = parseInt(idx);
    } else if (type === 'image') {
      var idx = element.getAttribute('data-image-idx');
      if (idx) data.index = parseInt(idx);
    } else if (type === 'preview') {
      var idx = element.getAttribute('data-preview-idx');
      if (idx) data.index = parseInt(idx);
    }
    
    vscodeApi.postMessage(data);
  }

  function elementKey(el) {
    var type = el.getAttribute('data-type');
    var index = elementIndexOf(el);
    return type + ':' + (index === null ? 'no-idx' : index);
  }

  // The form element for a key; visual = its row in the Hidden Fields panel or its bottom-bar button instead
  function findByKey(key, visual) {
    var parts = key.split(':');
    var cls = { text: 'text', field: 'field', pushbutton: 'push', image: 'image', preview: 'preview' }[parts[0]];
    if (!cls) return null;
    var attr = 'data-' + cls + '-idx';
    var idx = parts[1] === 'no-idx' ? ':not([' + attr + '])' : '[' + attr + '="' + parts[1] + '"]';
    if (!visual) return document.querySelector('.grid > .' + cls + '.draggable' + idx);
    if (parts[0] === 'field') return document.querySelector('.hidden-field-item' + idx);
    if (parts[0] === 'pushbutton') return document.querySelector('.bottom-bar-button' + idx);
    return null;
  }

  function setSelection(els, primary, visual, triggers) {
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
    document.body.classList.toggle('multi-selected', els.length > 1);
    window.__frmCodeSelection = null; // a selection made here replaces one still waiting from the code
    showTriggers();
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
    setSelection(selectedElements.concat(element), element);
    element.focus();
  }

  function removeFromSelection(element) {
    var rest = selectedElements.filter(function(el) { return el !== element; });
    if (rest.length === selectedElements.length) return;
    setSelection(rest, selectedElement === element ? rest[rest.length - 1] || null : selectedElement);
  }

  // Selected elements on other form tabs stay selected but can't be seen
  function isOnOtherTab(el) {
    return el.classList.contains('hidden');
  }

  // Shows how many elements are selected; with a hint for a moment when a key could not act on them
  function updateSelectionNotice(hint) {
    var notice = document.getElementById('selectionNotice');
    if (!notice) return;
    clearTimeout(window.__frmNoticeTimer);
    var count = selectedElements.length;
    var away = selectedElements.filter(isOnOtherTab).length;
    var text = '';
    if (count > 1) text = count + ' selected' + (away ? ', ' + away + ' on other tabs' : '');
    if (hint) {
      text = count > 1 ? count + ' selected: select one to edit' : 'The selected element is on another tab';
      window.__frmNoticeTimer = setTimeout(onCurrentPage(function() { updateSelectionNotice(); }), 2000);
    }
    if (!hint) text = [text].concat(triggerNotices()).filter(Boolean).join(' \u00b7 ');
    notice.textContent = text;
    notice.classList.toggle('hidden', !text);
  }

  // Editing keys act on exactly one element, which must be in view on this tab
  function editKeysBlocked() {
    if (selectedElements.length <= 1 && !(selectedElement && isOnOtherTab(selectedElement))) return false;
    updateSelectionNotice(true);
    return true;
  }

  function getSelection() {
    return {
      keys: selectedElements.map(elementKey),
      primary: selectedElement ? elementKey(selectedElement) : null,
      visual: visualElements.map(elementKey),
      triggers: codeTriggers
    };
  }

  function found(el, i, all) {
    return !!el && all.indexOf(el) === i;
  }

  function restoreSelection() {
    var carry = window.__frmCarry && window.__frmCarry.selection;
    var waiting = window.__frmCodeSelection;
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
        }));
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

  function moveSelectedElement(deltaRow, deltaCol) {
    if (!selectedElement) return;
    
    var currentRow = parseInt(selectedElement.getAttribute('data-row'));
    var currentCol = parseInt(selectedElement.getAttribute('data-col'));
    
    var newRow = Math.max(1, Math.min(D.rows, currentRow + deltaRow));
    var newCol = Math.max(1, Math.min(D.cols, currentCol + deltaCol));
    
    if (newRow !== currentRow || newCol !== currentCol) {
      var type = selectedElement.getAttribute('data-type');
      updateElementPosition(selectedElement, newRow, newCol);
      sendPositionUpdate(type, selectedElement, newRow, newCol);
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
        var element = deleteBtn.closest('.draggable');
        if (element) {
          var type = element.getAttribute('data-type');
          var index = null;
          if (type === 'text') {
            index = element.getAttribute('data-text-idx');
          } else if (type === 'field') {
            index = element.getAttribute('data-field-idx');
          } else if (type === 'pushbutton') {
            index = element.getAttribute('data-push-idx');
          } else if (type === 'image') {
            index = element.getAttribute('data-image-idx');
          } else if (type === 'preview') {
            index = element.getAttribute('data-preview-idx');
          }
          if (index) {
            if (vscodeApi && vscodeApi.postMessage) {
              vscodeApi.postMessage({ command: 'deleteElement', elementType: type, elementIndex: parseInt(index) });
            }
          }
        }
      }
    });

    // Add global keyboard event listener
    document.addEventListener('keydown', function(e) {
      if ((!selectedElement && !visualElements.length && !codeTriggers.length) || shortcutsBlocked(e)) return;
      if (/^(Arrow(Up|Down|Left|Right)|Delete|Backspace)$/.test(e.key)) {
        if (!selectedElement) return;
        if (editKeysBlocked()) { e.preventDefault(); return; }
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
          moveSelectedElement(-1, 0);
          handled = true;
          break;
        case 'ArrowDown':
          moveSelectedElement(1, 0);
          handled = true;
          break;
        case 'ArrowLeft':
          moveSelectedElement(0, -1);
          handled = true;
          break;
        case 'ArrowRight':
          moveSelectedElement(0, 1);
          handled = true;
          break;
        case 'Escape':
          clearSelection();
          handled = true;
          break;
        case 'Delete':
        case 'Backspace':
          if (selectedElement) {
            e.preventDefault();
            var type = selectedElement.getAttribute('data-type');
            var index = null;
            if (type === 'text') {
              index = selectedElement.getAttribute('data-text-idx');
            } else if (type === 'field') {
              index = selectedElement.getAttribute('data-field-idx');
            } else if (type === 'pushbutton') {
              index = selectedElement.getAttribute('data-push-idx');
            } else if (type === 'image') {
              index = selectedElement.getAttribute('data-image-idx');
            } else if (type === 'preview') {
              index = selectedElement.getAttribute('data-preview-idx');
            }
            if (index) {
              if (vscodeApi && vscodeApi.postMessage) {
                vscodeApi.postMessage({ command: 'deleteElement', elementType: type, elementIndex: parseInt(index) });
                clearSelection();
              }
            }
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
      if (e.target.closest('.modal-overlay, .context-menu, .tabs')) return;
      if (!e.target.closest('.draggable')) clearSelection();
    });
  }

  // Tab Order Mode
  var tabOrderMode = false;
  var tabOrderSequence = [];
  
  function enterTabOrderMode() {
    tabOrderMode = true;
    tabOrderSequence = [];
    document.body.classList.add('tab-order-active');
    
    // Remove existing badges
    document.querySelectorAll('.tab-order-badge').forEach(function(el) { el.remove(); });
    
    // Show message if cleansing existing tab order
    if (existingTabOrder && existingTabOrder.length > 0) {
      var msg = 'Existing tab order will be replaced. Click fields in the desired order, then right-click to confirm or cancel.';
      if (vscodeApi && vscodeApi.postMessage) {
        // Could send a message to show a VS Code notification, but for now just continue
      }
    }
    
    // Highlight all fields and buttons that affect fields
    document.querySelectorAll('.field').forEach(function(el) {
      el.classList.add('tab-order-mode');
    });
    document.querySelectorAll('.push[data-pb-action="variable"]').forEach(function(el) {
      el.classList.add('tab-order-mode');
    });
  }
  
  function exitTabOrderMode() {
    tabOrderMode = false;
    document.body.classList.remove('tab-order-active');
    document.querySelectorAll('.field').forEach(function(el) {
      el.classList.remove('tab-order-mode');
    });
    document.querySelectorAll('.push').forEach(function(el) {
      el.classList.remove('tab-order-mode');
    });
    document.querySelectorAll('.tab-order-badge').forEach(function(el) { el.remove(); });
  }
  
  function addFieldToTabOrder(fieldElement) {
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
  
  function addButtonToTabOrder(buttonElement) {
    // Get the field name that this button affects
    var fieldName = buttonElement.getAttribute('data-pb-name');
    if (!fieldName) return;
    
    // Find the corresponding field by name
    var fieldEl = document.querySelector('.field[data-field-name="' + fieldName + '"]');
    if (!fieldEl) return;
    
    // Add that field to the tab order
    addFieldToTabOrder(fieldEl);
  }
  
  function updateTabOrderBadges() {
    // Remove all existing badges
    document.querySelectorAll('.tab-order-badge').forEach(function(el) { el.remove(); });
    
    // Add badges for fields in sequence
    tabOrderSequence.forEach(function(fieldIndex, order) {
      var fieldEl = document.querySelector('.field[data-field-idx="' + fieldIndex + '"]');
      if (fieldEl) {
        var fieldName = fieldEl.getAttribute('data-field-name');
        
        // Add badge to the field
        var badge = document.createElement('div');
        badge.className = 'tab-order-badge';
        badge.textContent = String(order + 1);
        fieldEl.style.position = 'relative';
        fieldEl.appendChild(badge);
        
        // Add badges to all buttons that affect this field
        if (fieldName) {
          document.querySelectorAll('.push[data-pb-name="' + fieldName + '"]').forEach(function(btnEl) {
            var btnBadge = document.createElement('div');
            btnBadge.className = 'tab-order-badge';
            btnBadge.textContent = String(order + 1);
            btnEl.style.position = 'relative';
            btnEl.appendChild(btnBadge);
          });
        }
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

  // Modify field click handler to support tab order mode (capture phase)
  document.addEventListener('click', function(e) {
    if (!tabOrderMode) return;
    
    var fieldEl = e.target.closest('.field');
    if (fieldEl) {
      e.preventDefault();
      e.stopPropagation();
      addFieldToTabOrder(fieldEl);
      return false;
    }
    
    var buttonEl = e.target.closest('.push');
    if (buttonEl) {
      e.preventDefault();
      e.stopPropagation();
      addButtonToTabOrder(buttonEl);
      return false;
    }
  }, true); // Use capture phase
  
  // Handle tab order context menu actions (bubble phase, after capture)
  document.addEventListener('click', function(e) {
    var item = e.target.closest('.context-menu-item');
    if (!item) return;
    
    var action = item.getAttribute('data-action');
    if (action === 'confirm-tab-order') {
      e.preventDefault();
      e.stopPropagation();
      confirmTabOrder();
      var menu = document.getElementById('tabOrderContextMenu');
      if (menu) menu.classList.add('hidden');
      return false;
    } else if (action === 'cancel-tab-order') {
      e.preventDefault();
      e.stopPropagation();
      cancelTabOrder();
      var menu = document.getElementById('tabOrderContextMenu');
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
      try { d.handle.releasePointerCapture(d.pointerId); } catch (e) { /* ignore */ }
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
        try { handle.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
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
        try { hideContextMenu(); hideElementContextMenu(); hideOutsideContextMenu(); } catch (err) { /* ignore */ }
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
    var attr = type === 'field' ? 'data-field-idx' : type === 'image' ? 'data-image-idx' : type === 'preview' ? 'data-preview-idx' : null;
    return attr ? parseInt(el.getAttribute(attr), 10) : NaN;
  }

  function canStretch(el) {
    if (!el) return false;
    var type = el.getAttribute('data-type');
    return (type === 'field' || type === 'image' || type === 'preview') && isFinite(elIndex(el));
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
      try { d.handle.releasePointerCapture(d.pointerId); } catch (e) { /* ignore */ }
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
        if (!canStretch(el)) return;
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
        try { handle.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
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
      handle.addEventListener('click', function(e) { e.stopPropagation(); });
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
      try { d.handle.releasePointerCapture(d.pointerId); } catch (e) { /* ignore */ }
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
        try { handle.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
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
  var pendingSelectionKey = null; // the extension names a new element (e.g. a duplicate) to select after the next refresh
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
    try { var n = target.value.length; target.setSelectionRange(n, n); } catch (err) { /* e.g. number inputs */ }
  }

  function restoreCanvasFocus() {
    var active = document.activeElement;
    if (active && active.closest && active.closest('.modal-overlay')) active.blur();
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
      image: 'data-image-idx', preview: 'data-preview-idx'
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

  // Same column, one row down; stays put when that would leave the form
  function duplicateSelectedElement() {
    var el = selectedElement;
    if (!el || tabOrderMode || !vscodeApi || !vscodeApi.postMessage || editKeysBlocked()) return;
    var type = el.getAttribute('data-type');
    var index = elementIndexOf(el);
    var row = parseInt(el.getAttribute('data-row'), 10);
    if (!type || !index || !isFinite(row)) return;
    var newRow = row + rowSpanOfElement(el) <= D.rows ? row + 1 : row;
    vscodeApi.postMessage({ command: 'duplicateElement', elementType: type, elementIndex: index, row: newRow });
  }

  // Same as choosing Edit in the element's context menu (images have no edit dialog)
  function openElementEditor(element) {
    var info = collectElementInfo(element);
    if (!info.type || info.type === 'image') return;
    elementContextMenuState.element = element;
    elementContextMenuState.elementType = info.type;
    elementContextMenuState.elementIndex = info.index;
    elementContextMenuState.elementData = info.data;
    var item = document.querySelector('#elementContextMenu .context-menu-item[data-action="edit-element"]');
    if (item) item.click();
  }

  function consumeKey(e) {
    e.preventDefault();
    e.stopImmediatePropagation();
  }

  // Capture phase: runs before the canvas handler, which moves/deletes/deselects the selected element
  function onShortcutKeydown(e) {
    var mod = e.ctrlKey || e.metaKey;
    var modal = topModal();
    var menu = openContextMenu();

    // Esc closes one layer per press. An open native <select> list swallows Esc itself.
    if (e.key === 'Escape') {
      if (sizeDrag || elResize || boxResize) return; // the resize handlers cancel the drag
      if (menu) { hideAllContextMenus(); consumeKey(e); return; }
      if (modal) {
        if (isDiscardBarOpen(modal)) hideDiscardBar(modal, true); else cancelModal(modal);
        consumeKey(e);
        return;
      }
      if (tabOrderMode) { cancelTabOrder(); consumeKey(e); return; }
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
      duplicateSelectedElement();
      consumeKey(e);
      return;
    }
    if (!mod && !e.altKey && e.key === '?') {
      showModal('shortcutsModal');
      consumeKey(e);
      return;
    }
    if (!mod && !e.altKey && !e.shiftKey && (e.key === 'F2' || e.key === 'Enter') && selectedElement &&
        !(e.key === 'Enter' && e.target && e.target.tagName === 'BUTTON' && !e.target.closest('.draggable'))) {
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
      if (msg && msg.command === 'frmSelectAfterRefresh' && typeof msg.key === 'string') {
        pendingSelectionKey = msg.key;
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
        el.textContent = el.textContent.replace('Ctrl', '⌘');
      });
    }
  }

  // Initialize drag and drop and keyboard navigation after DOM is ready
  setupShortcuts(); // first, so its capture-phase Escape runs before the resize handlers end a drag
  setupWindowResize();
  setupElementResize();
  setupBoxResize();
  setupContextMenu();
  setupDragAndDrop();
  setupKeyboardNavigation();
  setupCodeSelection();
  fitTextSpans();
  
  // Restore selection if it existed before this update
  restoreSelection();
  setupTriggerHover();
  window.__frmCarry = null;

  // Hooks for the bootstrap's in-place updates
  window.__frmHooks = {
    isBusy: function() {
      return !!draggedElement || !!sizeDrag || !!elResize || tabOrderMode ||!!document.querySelector('.modal-overlay:not(.hidden)');
    },
    getSelection: function() {
      return pendingSelectionKey ? { keys: [pendingSelectionKey], primary: pendingSelectionKey, visual: [], triggers: [] } : getSelection();
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
