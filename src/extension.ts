import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { elementsInSelections, findElement, lineContinues } from './elementLookup';

// The extension's install folder; the preview page's styles and script are in its media/ folder
let extensionUri: vscode.Uri | undefined;
function mediaRoot(): vscode.Uri {
  return vscode.Uri.joinPath(extensionUri!, 'media');
}

// "Vertex FRM Preview" output channel; shows how long each preview took to appear
let log: vscode.LogOutputChannel | undefined;

export function activate(context: vscode.ExtensionContext) {
  extensionUri = context.extensionUri;
  log = vscode.window.createOutputChannel('Vertex FRM Preview', { log: true });
  context.subscriptions.push(log);
  // The extension starts once VS Code is up (onStartupFinished), so read the files every first
  // preview needs now instead of while it opens. Deferred so activation itself stays quick.
  setTimeout(() => {
    const t0 = Date.now();
    loadTranslations();
    if (extensionUri) getPageAssets(mediaRoot());
    log?.info(`Warm-up: translations and page assets loaded in ${Date.now() - t0} ms`);
  }, 0);
  const openCmd = vscode.commands.registerCommand('vertexFrmPreview.open', () => openPreview(context));
  context.subscriptions.push(openCmd);
  context.subscriptions.push(vscode.commands.registerCommand('vertexFrmPreview.sortSections', sortSectionsCommand));

  // Auto-open / auto-reveal when a vertex-frm file is focused (each controlled by a setting)
  const onFocusEditor = (ed: vscode.TextEditor | undefined) => {
    if (!ed || !isFrmFile(ed.document)) {
      return;
    }
    const config = vscode.workspace.getConfiguration('vertexFrmPreview');
    const hasPanel = panelByDoc.has(ed.document.uri.toString());
    if (hasPanel ? config.get<boolean>('autoReveal', true) : config.get<boolean>('autoOpen', true)) {
      // A newly auto-opened panel takes focus; revealing an existing one leaves focus in the editor.
      ensurePreview(context, ed.document, { preserveFocus: hasPanel });
    }
  };
  context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(onFocusEditor));
  // The extension activates when an FRM file opens, which can be after its editor got focus
  onFocusEditor(vscode.window.activeTextEditor);

  // Cursor and selection in the FRM text select the matching elements in its preview
  context.subscriptions.push(vscode.window.onDidChangeTextEditorSelection(onEditorSelection));

  // Cached lookups and watched folders depend on which folders are open
  context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(() => {
    clearAssetCaches();
    if (assetWatchers.length) restartAssetWatchers();
  }));
  context.subscriptions.push({ dispose: stopAssetWatchers });

  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((e) => {
    if (!e.affectsConfiguration('vertexFrmPreview.showZoomControls')) {
      return;
    }
    for (const [key, panel] of panelByDoc) {
      const doc = vscode.workspace.textDocuments.find(d => d.uri.toString() === key);
      if (doc) {
        updateWebview(panel, doc);
      }
    }
  }));
}

export function deactivate() {}

function isFrmFile(doc: vscode.TextDocument) {
  const ext = doc.uri.fsPath.split('.').pop()?.toLowerCase();
  return doc.languageId === 'vertex-frm' || ext === 'frm';
}

function openPreview(context: vscode.ExtensionContext) {
  const doc = vscode.window.activeTextEditor?.document;
  if (!doc) {
    vscode.window.showWarningMessage('Open a FRM file to preview.');
    return;
  }
  ensurePreview(context, doc);
}

function isHiddenFieldPosition(row: number, col: number) {
  return Number(row) === 1000 || Number(col) === 1000;
}

const panelByDoc = new Map<string, vscode.WebviewPanel>();
// Persist zoom per document so it survives re-rendering
const zoomByDoc = new Map<string, number>();
// Persist active tab per document so it survives re-rendering
const activeTabByDoc = new Map<string, number>();
// Persist gridlines visibility per document
const gridOnByDoc = new Map<string, boolean>();
// Document text the preview currently displays; changes that leave the text equal to this
// (saves, preview-drawn moves) never trigger a re-render
const shownTextByDoc = new Map<string, string>();
// Pending debounced refresh per document
const refreshTimerByDoc = new Map<string, ReturnType<typeof setTimeout>>();
// Preview-drawn edits still being applied; refreshes wait until these settle
const pendingPreviewEdits = new Map<string, number>();
// Panels whose page has loaded and accepts in-place updates
const readyPanels = new WeakSet<vscode.WebviewPanel>();
// Documents whose preview shows the "introduce indexes" gate instead of the form
const gatedDocs = new Set<string>();
const REFRESH_DELAY_MS = 150;

// ---- Code to preview selection ------------------------------------------------------------------
const CURSOR_DELAY_MS = 50;
// How long after an edit from the preview the editor's cursor may still move because of it
const PREVIEW_EDIT_SETTLE_MS = 250;
// Documents whose cursor moved and whose preview hasn't been told yet
const cursorSyncPending = new Set<string>();
const cursorTimerByDoc = new Map<string, ReturnType<typeof setTimeout>>();
// Until this time, cursor moves the user did not make with mouse or keyboard are the preview's own doing
const ignoreCursorUntil = new Map<string, number>();
// Undo/redo started from the preview and still running
const previewHistoryRuns = new Map<string, number>();
// Messages from the preview that don't edit the file
const NON_EDITING_COMMANDS = new Set([
  'gateCancel', 'frmReady', 'frmTiming', 'frmSoftUpdateFailed', 'setZoom', 'setActiveTab', 'setGridOn',
  'resolveFieldValues', 'showInSource', 'undo', 'redo', 'cancelTabOrder'
]);

function followsCursor(): boolean {
  return vscode.workspace.getConfiguration('vertexFrmPreview').get<boolean>('followCursor', true);
}

function ignoreCursorMoves(key: string) {
  ignoreCursorUntil.set(key, Date.now() + PREVIEW_EDIT_SETTLE_MS);
}

function onEditorSelection(e: vscode.TextEditorSelectionChangeEvent) {
  const doc = e.textEditor.document;
  const key = doc.uri.toString();
  const panel = panelByDoc.get(key);
  if (!panel || !isFrmFile(doc) || e.textEditor !== vscode.window.activeTextEditor) return;
  const byUser = e.kind === vscode.TextEditorSelectionChangeKind.Mouse || e.kind === vscode.TextEditorSelectionChangeKind.Keyboard;
  if (previewHistoryRuns.has(key)) return;
  if (!byUser && (panel.active || Date.now() < (ignoreCursorUntil.get(key) ?? 0))) return;
  queueCursorSync(panel, doc);
}

/** Tell the preview about the cursor shortly, once it has stopped moving. */
function queueCursorSync(panel: vscode.WebviewPanel, doc: vscode.TextDocument) {
  if (!followsCursor()) return;
  const key = doc.uri.toString();
  cursorSyncPending.add(key);
  const existing = cursorTimerByDoc.get(key);
  if (existing) clearTimeout(existing);
  cursorTimerByDoc.set(key, setTimeout(() => {
    cursorTimerByDoc.delete(key);
    flushCursorSync(panel, doc);
  }, CURSOR_DELAY_MS));
}

/** Send a pending cursor position, if the preview shows the current text; otherwise the next refresh sends it. */
function flushCursorSync(panel: vscode.WebviewPanel, doc: vscode.TextDocument) {
  const key = doc.uri.toString();
  if (!cursorSyncPending.has(key) || cursorTimerByDoc.has(key)) return;
  if (!readyPanels.has(panel) || gatedDocs.has(key) || doc.getText() !== shownTextByDoc.get(key)) return;
  cursorSyncPending.delete(key);
  if (!followsCursor()) return;
  const isOurs = (ed: vscode.TextEditor | undefined) => ed?.document.uri.toString() === key;
  const active = vscode.window.activeTextEditor;
  const editor = isOurs(active) ? active : vscode.window.visibleTextEditors.find(isOurs);
  if (!editor) return;
  const selected = elementsInSelections(doc.getText().split(/\r?\n/), editor.selections.map(s => ({
    startLine: s.start.line, endLine: s.end.line, endCharacter: s.end.character, activeLine: s.active.line
  })));
  panel.webview.postMessage({ command: 'frmSelectFromCode', ...selected });
}
// Full page loads not yet reported by the page: when the load began (Date.now()), whether it
// created the panel, and how long the extension spent building the page
const pageLoadByPanel = new WeakMap<vscode.WebviewPanel, { start: number; created: boolean; renderMs: number; file: string }>();

/** Log how long a full page load took, from the page's 'frmTiming' report. */
function logPageTiming(panel: vscode.WebviewPanel, msg: any) {
  const load = pageLoadByPanel.get(panel);
  if (!load || typeof msg?.timeOrigin !== 'number') return;
  pageLoadByPanel.delete(panel);
  // timeOrigin is when the page started loading, on the same clock as Date.now()
  const pageStart = Math.round(msg.timeOrigin - load.start);
  const at = (ms: unknown) => Math.round(pageStart + Number(ms));
  log?.info(`${load.file}: ${load.created ? 'opened' : 'reloaded'} → drawn in ${at(msg.drawn)} ms ` +
    `(build page ${load.renderMs} ms, page starts +${pageStart} ms, ` +
    (typeof msg.placeholderLoaded === 'number' && msg.placeholderLoaded > 0 ? `VS Code placeholder loaded +${at(msg.placeholderLoaded)} ms, ` : '') +
    (typeof msg.htmlStart === 'number' ? `our HTML starts +${at(msg.htmlStart)} ms, ` : '') +
    `script starts +${at(msg.scriptStart)} ms, ` +
    `page logic done +${at(msg.mainDone)} ms, first frame +${at(msg.drawn)} ms)`);
}

// Statement lines the preview can only work with when they carry an index: text= / button= / pushbutton=
const UNINDEXED_LINE = /^(\s*)(text|button|pushbutton)(?=\s*=)/i;
const INDEXED_TEXT_LINE = /^\s*text\s*\(\s*(\d+)\s*\)\s*=/i;
const INDEXED_BUTTON_LINE = /^\s*(?:button|pushbutton)\s*\(\s*(\d+)\s*\)\s*=/i;

interface UnindexedLine { line: number; insertAt: number; kind: 'text' | 'button'; }

function findUnindexed(text: string): UnindexedLine[] {
  const found: UnindexedLine[] = [];
  text.split(/\r?\n/).forEach((l, i) => {
    const m = l.match(UNINDEXED_LINE);
    if (m) {
      found.push({ line: i, insertAt: m[1].length + m[2].length, kind: m[2].toLowerCase() === 'text' ? 'text' : 'button' });
    }
  });
  return found;
}

function unindexedCounts(found: UnindexedLine[]) {
  const texts = found.filter(u => u.kind === 'text').length;
  return { texts, buttons: found.length - texts };
}

/** Gives every text= / button= / pushbutton= line the next free index, as one undoable edit. */
function autoAddIndexes(doc: vscode.TextDocument) {
  const lines = doc.getText().split(/\r?\n/);
  let nextText = 1;
  let nextButton = 1;
  for (const l of lines) {
    const t = l.match(INDEXED_TEXT_LINE);
    if (t) nextText = Math.max(nextText, Number(t[1]) + 1);
    const b = l.match(INDEXED_BUTTON_LINE);
    if (b) nextButton = Math.max(nextButton, Number(b[1]) + 1);
  }
  const found = findUnindexed(lines.join('\n'));
  if (!found.length) return;
  const edit = new vscode.WorkspaceEdit();
  for (const u of found) {
    const n = u.kind === 'text' ? nextText++ : nextButton++;
    edit.insert(doc.uri, new vscode.Position(u.line, u.insertAt), `(${n})`);
  }
  vscode.workspace.applyEdit(edit).then(ok => {
    if (!ok) vscode.window.showErrorMessage('Failed to add indexes');
  });
}

function unindexedMessage(c: { texts: number; buttons: number }) {
  const parts: string[] = [];
  if (c.texts) parts.push(`${c.texts} text`);
  if (c.buttons) parts.push(`${c.buttons} button`);
  return { title: 'Introduce indexes for text and button commands to use preview', detail: `(${parts.join(', ')} without index)` };
}

function renderGateHtml(webview: vscode.Webview, c: { texts: number; buttons: number }) {
  const msg = unindexedMessage(c);
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline' ${webview.cspSource}; script-src 'unsafe-inline';" />
  <style>
    body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center; font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); }
    .gate { max-width: 420px; padding: 20px 24px; border: 1px solid var(--vscode-editorWidget-border); border-radius: 6px; background: var(--vscode-editorWidget-background); }
    .gate h3 { margin: 0 0 6px; font-size: 14px; }
    .gate p { margin: 0 0 16px; opacity: .8; }
    .actions { display: flex; gap: 8px; justify-content: flex-end; }
    button { padding: 4px 12px; border: 1px solid transparent; border-radius: 2px; cursor: pointer; font: inherit; }
    .primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
    .primary:hover { background: var(--vscode-button-hoverBackground); }
    .secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
    .secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
  </style>
</head>
<body>
  <div class="gate">
    <h3>${escapeHtml(msg.title)}</h3>
    <p>${escapeHtml(msg.detail)}</p>
    <div class="actions">
      <button class="secondary" id="cancel">Cancel</button>
      <button class="primary" id="add">Auto-add indexes</button>
    </div>
  </div>
  <script>
    const api = acquireVsCodeApi();
    document.getElementById('cancel').addEventListener('click', () => api.postMessage({ command: 'gateCancel' }));
    document.getElementById('add').addEventListener('click', () => api.postMessage({ command: 'autoIndex' }));
  </script>
</body>
</html>`;
}


let customRoot: any;
let customImg: any;
let systemImg: any;

function ensurePreview(context: vscode.ExtensionContext, doc: vscode.TextDocument, options: { preserveFocus?: boolean } = {}) {
  const preserveFocus = options.preserveFocus ?? false;
  const key = doc.uri.toString();
  // Opening or revealing the preview always asks for indexes first when any are missing
  const mustGate = findUnindexed(doc.getText()).length > 0;
  if (mustGate) gatedDocs.add(key);
  let panel = panelByDoc.get(key);
  if (panel) {
    panel.reveal(panel.viewColumn ?? vscode.ViewColumn.Beside, preserveFocus);
  }
  if (!panel) {
    // Allow webview to load local images from specific folders at the repo root
    const roots: vscode.Uri[] = [mediaRoot()];
    const repoRoot = getRepoRootFolder();
    if (repoRoot) {
      //check through root folders for any that start with custom, use that one for customImg path
      customRoot = vscode.workspace.workspaceFolders?.find(wf => wf.name.toLowerCase().startsWith('custom'));
      customImg = customRoot ? vscode.Uri.file(path.join(customRoot.uri.fsPath, 'forms', 'images')) : vscode.Uri.file(path.join(repoRoot.uri.fsPath, 'custom', 'forms', 'images'));
      systemImg = vscode.Uri.file(path.join(repoRoot.uri.fsPath, 'system', 'forms', 'images'));
      roots.push(customImg, systemImg);
    }
    const openStart = Date.now();
    panel = vscode.window.createWebviewPanel(
      'vertexFrmPreview',
      `FRM Preview — ${vscode.workspace.asRelativePath(doc.uri)}`,
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus },
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: roots }
    );
    const createdPanel = panel;
    panelByDoc.set(key, panel);
    // Start on the element at the cursor, unless the cursor is still where a freshly opened file puts it
    const openEditor = vscode.window.visibleTextEditors.find(ed => ed.document.uri.toString() === key);
    if (openEditor && followsCursor() && !openEditor.selection.isEqual(new vscode.Selection(0, 0, 0, 0))) {
      cursorSyncPending.add(key);
    }
    pageLoadByPanel.set(panel, { start: openStart, created: true, renderMs: 0, file: vscode.workspace.asRelativePath(doc.uri) });

    // Update on document changes (registered once per panel)
    const sub = vscode.workspace.onDidChangeTextDocument((e: vscode.TextDocumentChangeEvent) => {
      if (e.document.uri.toString() === key) {
        scheduleRefresh(createdPanel, e.document);
      }
    });
    panel.onDidDispose(() => sub.dispose());

    // Values files, images and trigger programs are watched once for all previews (see startAssetWatchers)
    startAssetWatchers();

  panel.onDidDispose(() => {
    panelByDoc.delete(key);
    usedAssetsByDoc.delete(key);
    if (panelByDoc.size === 0) {
      stopAssetWatchers();
      // Nothing watches the folders any more, so cached lookups could go stale
      clearAssetCaches();
    }
    zoomByDoc.delete(key);
    activeTabByDoc.delete(key);
    gridOnByDoc.delete(key);
    gatedDocs.delete(key);
    shownTextByDoc.delete(key);
    pendingPreviewEdits.delete(key);
    cursorSyncPending.delete(key);
    ignoreCursorUntil.delete(key);
    const cursorTimer = cursorTimerByDoc.get(key);
    if (cursorTimer) {
      clearTimeout(cursorTimer);
      cursorTimerByDoc.delete(key);
    }
    const timer = refreshTimerByDoc.get(key);
    if (timer) {
      clearTimeout(timer);
      refreshTimerByDoc.delete(key);
    }
  });

    // Receive messages (future: editing from preview)
  panel.webview.onDidReceiveMessage((msg: any) => {
      if (!NON_EDITING_COMMANDS.has(msg?.command) && msg?.type !== 'openTriggerProgram') ignoreCursorMoves(key);
      if (msg?.command === 'gateCancel') {
        createdPanel.dispose();
      } else if (msg?.command === 'autoIndex') {
        autoAddIndexes(doc);
      } else if (msg?.command === 'frmReady') {
        readyPanels.add(createdPanel);
        flushCursorSync(createdPanel, doc);
      } else if (msg?.command === 'frmTiming') {
        logPageTiming(createdPanel, msg);
      } else if (msg?.command === 'frmSoftUpdateFailed') {
        console.warn('FRM preview: in-place update failed, reloading the page.', msg.error ?? '');
        // Fall back to a full reload so the preview never stays stale
        readyPanels.delete(createdPanel);
        updateWebview(createdPanel, doc);
      } else if (msg?.command === 'applyChange' && typeof msg?.text === 'string') {
        const edit = new vscode.WorkspaceEdit();
        const full = new vscode.Range(0, 0, doc.lineCount, 0);
        edit.replace(doc.uri, full, msg.text);
        vscode.workspace.applyEdit(edit);
      } else if (msg?.command === 'setZoom' && typeof msg?.zoom === 'number') {
        const clamped = Math.max(0.5, Math.min(3, Number(msg.zoom)));
        zoomByDoc.set(key, clamped);
      } else if (msg?.command === 'setActiveTab' && typeof msg?.id === 'number') {
        activeTabByDoc.set(key, Number(msg.id));
      } else if (msg?.command === 'setGridOn') {
        const on = Boolean(msg?.on);
        gridOnByDoc.set(key, on);
      } else if (msg?.command === 'updatePosition') {
        handlePositionUpdate(doc, msg);
      } else if (msg?.command === 'addElement') {
        handleAddElement(doc, msg);
      } else if (msg?.command === 'deleteElement') {
        handleDeleteElement(doc, msg);
      } else if (msg?.command === 'editElement') {
        handleEditElement(doc, msg);
      } else if (msg?.command === 'updateHeader') {
        handleUpdateHeader(doc, msg);
      } else if (msg?.command === 'resolveFieldValues' && Array.isArray(msg?.names)) {
        const names = msg.names.filter((n: unknown): n is string => typeof n === 'string');
        createdPanel.webview.postMessage({ command: 'fieldValuesResolved', requestId: msg.requestId, lines: describeFieldValues(names) });
      } else if (msg?.command === 'setPortSize') {
        handleSetPortSize(doc, msg);
      } else if (msg?.command === 'resizeElement') {
        handleResizeElement(doc, msg);
      } else if (msg?.command === 'setTextBox') {
        handleSetTextBox(doc, msg);
      } else if (msg?.command === 'moveElement') {
        handleMoveElement(doc, msg);
      } else if (msg?.command === 'duplicateElement') {
        handleDuplicateElement(doc, createdPanel, msg);
      } else if (msg?.command === 'undo' || msg?.command === 'redo') {
        runDocumentHistory(doc, createdPanel, msg.command);
      } else if (msg?.command === 'showInSource') {
        handleShowInSource(doc, createdPanel, msg);
      } else if (msg?.command === 'addTrigger') {
        handleAddTrigger(doc, msg);
      } else if (msg?.type === 'editTrigger') {
        handleEditTrigger(doc, msg);
      } else if (msg?.type === 'deleteTrigger') {
        handleDeleteTrigger(doc, msg);
      } else if (msg?.type === 'openTriggerProgram') {
        handleOpenTriggerProgram(msg);
      } else if (msg?.command === 'confirmTabOrder') {
        handleConfirmTabOrder(doc, msg);
      } else if (msg?.command === 'cancelTabOrder') {
        handleCancelTabOrder(doc, msg);
      }
    });
    updateWebview(panel, doc);
  } else if (mustGate || doc.getText() !== shownTextByDoc.get(key)) {
    updateWebview(panel, doc);
  }
}

function handlePositionUpdate(doc: vscode.TextDocument, msg: any) {
  try {
    const key = doc.uri.toString();
    const text = doc.getText();
    const model = parseFrm(text);
    
    // Update the model based on the message
    let updated = false;
    if (msg.type === 'text' && typeof msg.index === 'number') {
      const textItem = model.texts.find(t => t.index === msg.index);
      if (textItem) {
        textItem.row = msg.newRow;
        textItem.col = msg.newCol;
        updated = true;
      }
    } else if (msg.type === 'field' && typeof msg.index === 'number') {
      const fieldItem = model.fields.find(f => f.index === msg.index);
      if (fieldItem) {
        fieldItem.row = msg.newRow;
        fieldItem.col = msg.newCol;
        updated = true;
      }
    } else if (msg.type === 'pushbutton' && typeof msg.index === 'number') {
      const pushItem = model.pushbuttons.find(p => p.index === msg.index);
      if (pushItem) {
        pushItem.row = msg.newRow;
        pushItem.col = msg.newCol;
        updated = true;
      }
    } else if (msg.type === 'image' && typeof msg.index === 'number') {
      const imageItem = model.images.find(i => i.index === msg.index);
      if (imageItem) {
        imageItem.row = msg.newRow;
        imageItem.col = msg.newCol;
        updated = true;
      }
    } else if (msg.type === 'preview' && typeof msg.index === 'number') {
      const previewItem = model.previews.find(p => p.index === msg.index);
      if (previewItem) {
        previewItem.row = msg.newRow;
        previewItem.col = msg.newCol;
        updated = true;
      }
    }
    
    if (updated) {
      // Regenerate FRM text and apply edit - only update the specific element that was moved
      const newFrmText = serializeFrmModel(model, text, msg);
      const edit = new vscode.WorkspaceEdit();
      const full = new vscode.Range(0, 0, doc.lineCount, 0);
      edit.replace(doc.uri, full, newFrmText);
      // The preview already drew the move itself (unless it came from the hidden-field list),
      // so mark the resulting text as shown and let the debounced refresh skip it.
      const alreadyDrawn = msg.alreadyDrawn !== false;
      const shownBefore = shownTextByDoc.get(key) === text;
      pendingPreviewEdits.set(key, (pendingPreviewEdits.get(key) ?? 0) + 1);
      const done = () => pendingPreviewEdits.set(key, Math.max(0, (pendingPreviewEdits.get(key) ?? 1) - 1));
      vscode.workspace.applyEdit(edit).then(success => {
        if (success && alreadyDrawn && shownBefore) {
          shownTextByDoc.set(key, doc.getText());
        }
        done();
      }, done);
    }
  } catch (error) {
    console.error('Error handling position update:', error);
  }
}

function handleAddElement(doc: vscode.TextDocument, msg: any) {
  try {
    const text = doc.getText();
    const lines = text.split(/\r?\n/);
    
    // Parse the model to find the next available index for this element type
    const model = parseFrm(text);
    const elementType = msg.elementType;
    
    let nextIndex = 1;
    if (elementType === 'text') {
      // Find the highest existing text index
      const maxIndex = model.texts.reduce((max, t) => {
        return t.index !== undefined && t.index > max ? t.index : max;
      }, 0);
      nextIndex = maxIndex + 1;
    } else if (elementType === 'field') {
      // Find the highest existing field index
      const maxIndex = model.fields.reduce((max, f) => {
        return f.index !== undefined && f.index > max ? f.index : max;
      }, 0);
      nextIndex = maxIndex + 1;
    } else if (elementType === 'pushbutton') {
      // Find the highest existing pushbutton index
      const maxIndex = model.pushbuttons.reduce((max, p) => {
        return p.index !== undefined && p.index > max ? p.index : max;
      }, 0);
      nextIndex = maxIndex + 1;
    } else if (elementType === 'preview') {
      // Find the highest existing preview index
      const maxIndex = model.previews.reduce((max, p) => {
        return p.index !== undefined && p.index > max ? p.index : max;
      }, 0);
      nextIndex = maxIndex + 1;
    }
    
    let newLine = '';
    
    if (elementType === 'text') {
      // Format: text(n)= row col "content" or text(n)= row col {content}
      // Use quotes for simple text, braces for box text or VXID references
      const content = msg.content || '';
      // Add box directive if box dimensions are provided
      const boxDirective = (msg.boxRows && msg.boxCols) ? `+" #[${msg.boxRows},${msg.boxCols}]*"` : '';
      // Use curly braces when there's a box directive, quotes otherwise
      if (boxDirective) {
        newLine = `text(${nextIndex})= ${msg.row} ${msg.col} {"${content}"${boxDirective}}`;
      } else {
        newLine = `text(${nextIndex})= ${msg.row} ${msg.col} "${content}"`;
      }
    } else if (elementType === 'field') {
      // Format: field(n)= NAME type row col len ignore ["value1" "value2" ...]
      const name = msg.name || 'FIELD';
      const type = msg.type || '1';
      const len = msg.len || 10;
      // Default ignore value: 7 for VXUI, 4 for only
      const defaultIgnore = model.winstyle?.toLowerCase() === 'only' ? 4 : 7;
      const ignore = msg.ignore !== undefined && msg.ignore !== null && msg.ignore !== '' ? msg.ignore : defaultIgnore;
      const values = msg.values || [];
      
      let valuesStr = '';
      if (values.length > 0) {
        valuesStr = ' ' + values.map((v: string) => `"${v}"`).join(' ');
      }
      
      // Format field name according to nameFormat (default to plain if not specified)
      const nameFormat = msg.nameFormat || {};
      let formattedName = name;
      if (nameFormat.angle && nameFormat.quoted) {
        formattedName = `"<${name}>"`;
      } else if (nameFormat.angle) {
        formattedName = `<${name}>`;
      } else if (nameFormat.quoted) {
        formattedName = `"${name}"`;
      }
      newLine = `field(${nextIndex})= ${formattedName} ${type} ${msg.row} ${msg.col} ${len} ${ignore}${valuesStr}`;
    } else if (elementType === 'pushbutton') {
      // Format depends on button kind:
      // General: pushbutton(n)= row col "label" @program.prg(args) P
      // Checkbox: pushbutton(n)= row col "label" CHECKBOX name=value
      // Radio: pushbutton(n)= row col "label" RADIO name=value
      const label = msg.label || '';
      const kind = msg.kind || 'select';
      
      if (kind === 'checkbox') {
        const name = msg.name || 'VAR';
        const value = msg.value || '1;0';
        newLine = `pushbutton(${nextIndex})= ${msg.row} ${msg.col} "${label}" CHECKBOX ${name}=${value}`;
      } else if (kind === 'radio') {
        const name = msg.name || 'VAR';
        const value = msg.value || '1;0';
        newLine = `pushbutton(${nextIndex})= ${msg.row} ${msg.col} "${label}" RADIO ${name}=${value}`;
      } else {
        // General button
        if (msg.program) {
          // Program call
          let program = msg.program;
          if (!program.startsWith('@')) {
            program = '@' + program;
          }
          newLine = `pushbutton(${nextIndex})= ${msg.row} ${msg.col} "${label}" ${program} P`;
        } else if (msg.name) {
          // Variable assignment (less common for general buttons, but supported)
          const value = msg.value || '1';
          newLine = `pushbutton(${nextIndex})= ${msg.row} ${msg.col} "${label}" ${msg.name}=${value}`;
        } else {
          // Basic button with no action
          newLine = `pushbutton(${nextIndex})= ${msg.row} ${msg.col} "${label}"`;
        }
      }
    } else if (elementType === 'preview') {
      // Format: preview(n)= row col rows cols mode "path" "field" port_type port_style
      const rows = msg.rows || 10;
      const cols = msg.cols || 30;
      const mode = msg.mode || '0';
      const path = msg.path || '$DIR_PICTS/file.vxp';
      const field = msg.field || '';
      const portType = msg.portType || 'PORT_2D';
      const portStyleRaw = msg.portStyle ?? 'SIMPLE';
      const portStyle = portStyleRaw === '' ? '""' : portStyleRaw;
      newLine = `preview(${nextIndex})= ${msg.row} ${msg.col} ${rows} ${cols} ${mode} "${path}" "${field}" ${portType} ${portStyle}`;
    }
    
    if (!newLine) {
      return;
    }
    
    // Insert the new line into its section (after the last element of the same type,
    // or between the neighbouring sections if it is the first of its type)
    const sectionByType: Record<string, Section> = {
      text: Section.Text,
      field: Section.Field,
      pushbutton: Section.Button,
      preview: Section.Preview,
    };
    insertIntoSection(lines, sectionByType[elementType], [newLine]);
    
    // Apply the edit
    const newText = lines.join('\n');
    
    // Now update group and tab opt_* lists
    const updatedLines = newText.split(/\r?\n/);
    
    // Add to group(1) if it exists (only for fields, handle multi-line groups ending with \)
    if (elementType === 'field') {
      addFieldToGroup1(updatedLines, nextIndex, model.revision);
    }
    
    // If tabs exist and we have an active tab, add to appropriate opt_* list
    if (msg.activeTabId !== undefined && msg.activeTabId !== null) {
      const tabId = msg.activeTabId;
      let optKey = '';
      
      if (elementType === 'text') {
        optKey = 'opt_text';
      } else if (elementType === 'field') {
        optKey = 'opt_field';
      } else if (elementType === 'pushbutton') {
        optKey = 'opt_pushbutton';
      }
      
      if (optKey) {
        const optRegex = new RegExp(`^\\s*${optKey}\\s*\\(\\s*${tabId}\\s*\\)\\s*=`, 'i');
        let foundOpt = false;
        
        for (let i = 0; i < updatedLines.length; i++) {
          if (optRegex.test(updatedLines[i])) {
            const collected = collectContinuedStatement(updatedLines, i);
            const items = parseIndexList(statementValue(collected.text)).map(String);
            items.push(String(nextIndex));
            const sortedItems = items.sort((a, b) => {
              const numA = parseInt(a) || 0;
              const numB = parseInt(b) || 0;
              return numA - numB;
            });
            const wrapAt = collected.endIndex > i ? wrapWidthFromFirstLine(updatedLines[i]) : undefined;
            replaceContinuedStatement(updatedLines, i, formatIndexStatement(`${optKey}(${tabId})`, sortedItems, wrapAt));
            foundOpt = true;
            break;
          }
        }
        
        // If opt_* line doesn't exist for this tab, create it
        if (!foundOpt) {
          insertIntoSection(updatedLines, Section.Opt, [`${optKey}(${tabId})= ${nextIndex}`]);
        }
      }
    }
    
    const finalText = updatedLines.join('\n');
    const edit = new vscode.WorkspaceEdit();
    const full = new vscode.Range(0, 0, doc.lineCount, 0);
    edit.replace(doc.uri, full, finalText);
    vscode.workspace.applyEdit(edit);
    
    // Show info message
    vscode.window.showInformationMessage(`Added ${elementType}(${nextIndex}) at (${msg.row}, ${msg.col})`);
  } catch (error) {
    console.error('Error adding element:', error);
    vscode.window.showErrorMessage(`Failed to add element: ${error}`);
  }
}

function handleDeleteElement(doc: vscode.TextDocument, msg: any) {
  try {
    const elementType = msg.elementType; // 'text', 'field', 'pushbutton'
    const elementIndex = msg.elementIndex;

    const text = doc.getText();
    const lines = text.split(/\r?\n/);

    // Find the element's statement
    const statement = findElement(lines, elementType, elementIndex);

    if (!statement) {
      vscode.window.showErrorMessage(`Could not find ${elementType}(${elementIndex})`);
      return;
    }

    // Remove the whole statement, including `\` continuation lines
    lines.splice(statement.startLine, statement.endLine - statement.startLine + 1);

    // Remove from group(1) if it's a field
    if (elementType === 'field') {
      const groupRegex = /^\s*group\s*\(\s*1\s*\)\s*=\s*/i;
      let groupStartIndex = -1;
      for (let i = 0; i < lines.length; i++) {
        if (groupRegex.test(lines[i])) {
          groupStartIndex = i;
          break;
        }
      }

      if (groupStartIndex !== -1) {
        const collected = collectContinuedStatement(lines, groupStartIndex);
        // Format: group(1)= <type_expr> [<val1> <val2>] <field_indexes...>
        // revision=2: first 3 values are preserved (type_expr, val1, val2)
        // no revision or revision=1: first 2 values are preserved (type_expr, val1)
        const allItems = statementValue(collected.text).replace(/\\/g, ' ').split(/[,;\s]+/).filter(Boolean);
        const model = parseFrm(doc.getText());
        const preserveCount = model.revision === 2 ? 3 : 2;
        const preserved = allItems.slice(0, preserveCount);
        const members = allItems.slice(preserveCount).map(Number).filter(n => !isNaN(n));
        const newMembers = members.filter(m => m !== elementIndex);
        const allValues = newMembers.length === 0 ? [...preserved] : [...preserved, ...newMembers.map(String)];
        const wrapAt = collected.endIndex > groupStartIndex ? wrapWidthFromFirstLine(lines[groupStartIndex]) : undefined;
        replaceContinuedStatement(lines, groupStartIndex, formatIndexStatement('group(1)', allValues, wrapAt));
      }
    }

    // Remove from tab opt_* lists
    // Handle opt_button as synonym for opt_pushbutton
    const optTypeName = elementType === 'pushbutton' ? '(?:pushbutton|button)' : elementType;
    const optPattern = new RegExp(`^\\s*opt_${optTypeName}\\s*\\(\\s*(\\d+)\\s*\\)\\s*=`, 'i');
    for (let i = 0; i < lines.length; i++) {
      if (!optPattern.test(lines[i])) continue;
      const collected = collectContinuedStatement(lines, i);
      const list = parseIndexList(statementValue(collected.text));
      const newList = list.filter(idx => idx !== elementIndex);
      if (newList.length === list.length) continue;
      if (newList.length === 0) {
        lines.splice(i, collected.endIndex - i + 1);
        i--;
      } else {
        const wrapAt = collected.endIndex > i ? wrapWidthFromFirstLine(lines[i]) : undefined;
        const newLines = formatIndexStatement(statementKeyword(lines[i]), newList.map(String), wrapAt);
        lines.splice(i, collected.endIndex - i + 1, ...newLines);
        i += newLines.length - 1;
      }
    }

    const newText = lines.join('\n');

    // Apply the edit
    const edit = new vscode.WorkspaceEdit();
    edit.replace(doc.uri, new vscode.Range(0, 0, doc.lineCount, 0), newText);

    vscode.workspace.applyEdit(edit).then(success => {
      if (success) {
        vscode.window.showInformationMessage(`Deleted ${elementType}(${elementIndex})`);
      } else {
        vscode.window.showErrorMessage(`Failed to delete ${elementType}(${elementIndex})`);
      }
    });
  } catch (error) {
    vscode.window.showErrorMessage(`Error deleting element: ${error}`);
  }
}

function handleUpdateHeader(doc: vscode.TextDocument, msg: any) {
  try {
    const title = typeof msg?.title === 'string' ? msg.title : '';
    const escaped = title.replace(/"/g, '\\"');
    const newHeaderLine = `header = "${escaped}"`;

    const text = doc.getText();
    const lines = text.split(/\r?\n/);
    const headerRegex = /^\s*header\s*=/i;

    let headerLineIndex = -1;
    for (let i = 0; i < lines.length; i++) {
      if (headerRegex.test(lines[i])) {
        headerLineIndex = i;
        break;
      }
    }

    if (headerLineIndex !== -1) {
      const commentMatch = lines[headerLineIndex].match(/(?:\s+)(!.*)$/);
      const comment = commentMatch ? ' ' + commentMatch[1] : '';
      lines[headerLineIndex] = newHeaderLine + comment;
    } else {
      let insertIndex = -1;
      for (let i = 0; i < lines.length; i++) {
        if (/^\s*(?:header|port_size|charset|vxdbase_winstyle|has_pulldowns|text_font|field_font|revision|status_bar)\s*=/i.test(lines[i])) {
          insertIndex = i + 1;
        } else if (/^\s*$/.test(lines[i]) && insertIndex > 0) {
          break;
        }
      }

      if (insertIndex === -1) {
        for (let i = 0; i < lines.length; i++) {
          if (!/^\s*!/.test(lines[i]) && !/^\s*$/.test(lines[i])) {
            insertIndex = i;
            break;
          }
        }
      }

      if (insertIndex === -1) {
        insertIndex = lines.length;
      }

      lines.splice(insertIndex, 0, newHeaderLine);
    }

    const newText = lines.join('\n');
    const edit = new vscode.WorkspaceEdit();
    edit.replace(doc.uri, new vscode.Range(0, 0, doc.lineCount, 0), newText);

    vscode.workspace.applyEdit(edit).then(success => {
      if (success) {
        vscode.window.showInformationMessage('Updated window header');
      } else {
        vscode.window.showErrorMessage('Failed to update window header');
      }
    });
  } catch (error) {
    vscode.window.showErrorMessage(`Error updating header: ${error}`);
  }
}

// Writes port_size= rows cols. A missing rows/cols in the message keeps the file's current value.
function handleSetPortSize(doc: vscode.TextDocument, msg: any) {
  try {
    const valid = (v: any) => typeof v === 'number' && Number.isInteger(v) && v >= 0;
    const text = doc.getText();
    const lines = text.split(/\r?\n/);
    const portRegex = /^(\s*port_size\s*=\s*)(\d+)(\s+)(\d+)/i;
    let lineIndex = -1;
    for (let i = 0; i < lines.length; i++) {
      if (/^\s*port_size\s*=/i.test(lines[i])) { lineIndex = i; break; }
    }
    const current = lineIndex !== -1 ? lines[lineIndex].match(portRegex) : null;
    const curRows = current ? Number(current[2]) : 0;
    const curCols = current ? Number(current[4]) : 0;
    const rows = valid(msg?.rows) ? msg.rows : curRows;
    const cols = valid(msg?.cols) ? msg.cols : curCols;
    if (current && rows === curRows && cols === curCols) return;

    const edit = new vscode.WorkspaceEdit();
    if (lineIndex !== -1) {
      const line = lines[lineIndex];
      let newLine: string;
      if (current) {
        newLine = current[1] + rows + current[3] + cols + line.slice(current[0].length);
      } else {
        const commentMatch = line.match(/\s+(!.*)$/);
        newLine = `port_size= ${rows} ${cols}` + (commentMatch ? ' ' + commentMatch[1] : '');
      }
      edit.replace(doc.uri, new vscode.Range(lineIndex, 0, lineIndex, line.length), newLine);
    } else {
      // Insert next to the other header settings
      let insertIndex = -1;
      for (let i = 0; i < lines.length; i++) {
        if (/^\s*(?:header|charset|vxdbase_winstyle|has_pulldowns|text_font|field_font|revision|status_bar)\s*=/i.test(lines[i])) {
          insertIndex = i + 1;
        } else if (/^\s*$/.test(lines[i]) && insertIndex > 0) {
          break;
        }
      }
      if (insertIndex === -1) {
        insertIndex = lines.findIndex(l => !/^\s*!/.test(l) && !/^\s*$/.test(l));
      }
      const eol = doc.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
      const newLine = `port_size= ${rows} ${cols}`;
      if (insertIndex === -1 || insertIndex >= doc.lineCount) {
        const last = doc.lineAt(doc.lineCount - 1);
        edit.insert(doc.uri, last.range.end, (last.text.length ? eol : '') + newLine + eol);
      } else {
        edit.insert(doc.uri, new vscode.Position(insertIndex, 0), newLine + eol);
      }
    }
    vscode.workspace.applyEdit(edit).then(success => {
      if (!success) vscode.window.showErrorMessage('Failed to update port_size');
    });
  } catch (error) {
    vscode.window.showErrorMessage(`Error updating port_size: ${error}`);
  }
}

// Stretching from the preview. Fields: msg.col + msg.len. Images/previews: msg.row, msg.col, msg.rows, msg.cols.
// Only those numbers are rewritten; the rest of the line keeps its formatting.
function handleResizeElement(doc: vscode.TextDocument, msg: any) {
  try {
    const int = (v: any, min: number) => typeof v === 'number' && Number.isInteger(v) && v >= min;
    const type = msg?.type;
    if (!int(msg?.index, 0) || !int(msg?.col, 1)) return;
    let lineRegex: RegExp;
    let rewrite: (m: RegExpMatchArray) => string;
    if (type === 'field') {
      if (!int(msg.len, 1)) return;
      // prefix (keyword, name, type) | col | ws | len
      lineRegex = /^(\s*field\s*\(\s*(\d+)\s*\)\s*=\s*"?\s*<?[$\w]+>?\s*"?\s+[\d+]+\s+\d+\s+)(\d+)(\s+)(\d+)/i;
      rewrite = m => m[1] + msg.col + m[4] + msg.len;
    } else if (type === 'image' || type === 'preview') {
      if (!int(msg.row, 1) || !int(msg.rows, 1) || !int(msg.cols, 1)) return;
      // prefix | row | ws | col | ws | rows | ws | cols
      lineRegex = new RegExp(`^(\\s*${type}\\s*\\(\\s*(\\d+)\\s*\\)\\s*=\\s*)(\\d+)(\\s+)(\\d+)(\\s+)(\\d+)(\\s+)(\\d+)`, 'i');
      rewrite = m => m[1] + msg.row + m[4] + msg.col + m[6] + msg.rows + m[8] + msg.cols;
    } else if (type === 'text') {
      // A boxed text: row/col is the box's top-left corner, #[rows,cols]* in the content is its size
      if (!int(msg.row, 1) || !int(msg.rows, 1) || !int(msg.cols, 1)) return;
      lineRegex = /^(\s*text\s*\(\s*(\d+)\s*\)\s*=\s*)(\d+)(\s+)(\d+)/i;
      rewrite = m => m[1] + msg.row + m[4] + msg.col;
    } else {
      return;
    }
    for (let i = 0; i < doc.lineCount; i++) {
      const line = doc.lineAt(i).text;
      const m = line.match(lineRegex);
      if (!m || Number(m[2]) !== msg.index) continue;
      let rest = line.slice(m[0].length);
      if (type === 'text') {
        const boxRe = /#\s*\[\s*\d+\s*,\s*\d+\s*\]\s*\*/;
        if (!boxRe.test(rest)) return;
        rest = rest.replace(boxRe, `#[${msg.rows},${msg.cols}]*`);
      }
      const newLine = rewrite(m) + rest;
      if (newLine === line) return;
      const edit = new vscode.WorkspaceEdit();
      edit.replace(doc.uri, new vscode.Range(i, 0, i, line.length), newLine);
      vscode.workspace.applyEdit(edit).then(success => {
        if (!success) vscode.window.showErrorMessage(`Failed to resize ${type}(${msg.index})`);
      });
      return;
    }
  } catch (error) {
    vscode.window.showErrorMessage(`Error resizing element: ${error}`);
  }
}

// Add or remove the #[rows,cols]* box directive on a text line, and set its column so the label stays put.
// Only the column and the directive change; the rest of the content is left as written.
function handleSetTextBox(doc: vscode.TextDocument, msg: any) {
  try {
    const int = (v: any, min: number) => typeof v === 'number' && Number.isInteger(v) && v >= min;
    if (!int(msg?.index, 0) || !int(msg?.col, 1)) return;
    const adding = msg.boxRows != null;
    if (adding && (!int(msg.boxRows, 1) || !int(msg.boxCols, 1))) return;
    const lineRegex = /^(\s*text\s*\(\s*(\d+)\s*\)\s*=\s*\d+\s+)(\d+)(\s+)(.*)$/i;
    for (let i = 0; i < doc.lineCount; i++) {
      const line = doc.lineAt(i).text;
      const m = line.match(lineRegex);
      if (!m || Number(m[2]) !== msg.index) continue;
      let value = m[5];
      if (adding) {
        if (/#\s*\[\s*\d+\s*,\s*\d+\s*\]\s*\*/.test(value)) return; // already boxed
        const directive = `+" #[${msg.boxRows},${msg.boxCols}]*"`;
        if (value.startsWith('{')) {
          // The } that closes the opening brace (skipping quoted text), not one in a trailing comment
          let close = -1, depth = 0, quoted = false;
          for (let k = 0; k < value.length && close < 0; k++) {
            const c = value[k];
            if (c === '"') quoted = !quoted;
            else if (!quoted && c === '{') depth++;
            else if (!quoted && c === '}' && --depth === 0) close = k;
          }
          if (close < 0) break;
          value = value.slice(0, close) + directive + value.slice(close);
        } else if (value.startsWith('"')) {
          const close = value.indexOf('"', 1);
          if (close < 0) break;
          value = '{' + value.slice(0, close + 1) + directive + '}' + value.slice(close + 1);
        } else {
          break;
        }
      } else {
        // `+" #[r,c]*"` as its own piece, or the directive inside a string
        const before = value;
        value = value.replace(/\s*\+\s*"\s*#\s*\[\s*\d+\s*,\s*\d+\s*\]\s*\*\s*"/, '');
        if (value === before) value = value.replace(/\s*#\s*\[\s*\d+\s*,\s*\d+\s*\]\s*\*/, '');
        if (value === before) return;
      }
      const newLine = m[1] + msg.col + m[4] + value;
      if (newLine === line) return;
      const edit = new vscode.WorkspaceEdit();
      edit.replace(doc.uri, new vscode.Range(i, 0, i, line.length), newLine);
      vscode.workspace.applyEdit(edit).then(success => {
        if (!success) vscode.window.showErrorMessage(`Failed to update the box on text(${msg.index})`);
      });
      return;
    }
    vscode.window.showErrorMessage(`Could not ${adding ? 'add a box to' : 'remove the box from'} text(${msg.index})`);
  } catch (error) {
    vscode.window.showErrorMessage(`Error updating text box: ${error}`);
  }
}

function handleEditElement(doc: vscode.TextDocument, msg: any) {
  try {
    const text = doc.getText();
    const lines = text.split(/\r?\n/);
    const elementType = msg.elementType;
    const elementIndex = msg.elementIndex;

    // Find the element line
    const elementLineIndex = findElement(lines, elementType, elementIndex)?.startLine ?? -1;

    if (elementLineIndex === -1) {
      vscode.window.showErrorMessage(`Could not find ${elementType}(${elementIndex})`);
      return;
    }

    // Build the new line based on element type
    let newLine = '';
    if (elementType === 'text') {
      const content = msg.content || '';
      // Add box directive if box dimensions are provided
      const boxDirective = (msg.boxRows && msg.boxCols) ? `+" #[${msg.boxRows},${msg.boxCols}]*"` : '';
      // Use curly braces when there's a box directive, quotes otherwise
      if (boxDirective) {
        newLine = `text(${elementIndex})= ${msg.row} ${msg.col} {"${content}"${boxDirective}}`;
      } else {
        newLine = `text(${elementIndex})= ${msg.row} ${msg.col} "${content}"`;
      }
    } else if (elementType === 'field') {
      const name = msg.name || 'FIELD';
      const type = msg.type || '1';
      const len = msg.len || 10;
      const ignore = msg.ignore !== undefined && msg.ignore !== null && msg.ignore !== '' ? msg.ignore : 7;
      const values = msg.values || [];
      let valuesStr = '';
      if (values.length > 0) {
        valuesStr = ' ' + values.map((v: string) => `"${v}"`).join(' ');
      }
      // Format field name according to nameFormat (default to plain if not specified)
      const nameFormat = msg.nameFormat || {};
      let formattedName = name;
      if (nameFormat.angle && nameFormat.quoted) {
        formattedName = `"<${name}>"`;
      } else if (nameFormat.angle) {
        formattedName = `<${name}>`;
      } else if (nameFormat.quoted) {
        formattedName = `"${name}"`;
      }
      newLine = `field(${elementIndex})= ${formattedName} ${type} ${msg.row} ${msg.col} ${len} ${ignore}${valuesStr}`;
    } else if (elementType === 'pushbutton') {
      const label = msg.label || '';
      const kind = msg.kind || 'select';
      if (kind === 'checkbox') {
        const name = msg.name || 'VAR';
        const value = msg.value || '1;0';
        newLine = `pushbutton(${elementIndex})= ${msg.row} ${msg.col} "${label}" CHECKBOX ${name}=${value}`;
      } else if (kind === 'radio') {
        const name = msg.name || 'VAR';
        const value = msg.value || '1';
        newLine = `pushbutton(${elementIndex})= ${msg.row} ${msg.col} "${label}" RADIO ${name}=${value}`;
      } else {
        // General button
        if (msg.program) {
          // Program call
          let program = msg.program;
          if (!program.startsWith('@')) {
            program = '@' + program;
          }
          newLine = `pushbutton(${elementIndex})= ${msg.row} ${msg.col} "${label}" ${program} P`;
        } else if (msg.name) {
          // Variable assignment (less common for general buttons, but supported)
          const value = msg.value || '1';
          newLine = `pushbutton(${elementIndex})= ${msg.row} ${msg.col} "${label}" ${msg.name}=${value}`;
        } else {
          // Basic button with no action
          newLine = `pushbutton(${elementIndex})= ${msg.row} ${msg.col} "${label}"`;
        }
      }
    } else if (elementType === 'preview') {
      const rows = msg.rows || 10;
      const cols = msg.cols || 30;
      const mode = msg.mode || '0';
      const path = msg.path || '$DIR_PICTS/file.vxp';
      const field = msg.field || '';
      const portType = msg.portType || 'PORT_2D';
      const portStyleRaw = msg.portStyle ?? 'SIMPLE';
      const portStyle = portStyleRaw === '' ? '""' : portStyleRaw;
      newLine = `preview(${elementIndex})= ${msg.row} ${msg.col} ${rows} ${cols} ${mode} "${path}" "${field}" ${portType} ${portStyle}`;
    }

    // Replace the line
    lines[elementLineIndex] = newLine;
    const newText = lines.join('\n');

    // Apply the edit
    const edit = new vscode.WorkspaceEdit();
    edit.replace(doc.uri, new vscode.Range(0, 0, doc.lineCount, 0), newText);

    vscode.workspace.applyEdit(edit).then(success => {
      if (success) {
        vscode.window.showInformationMessage(`Updated ${elementType}(${elementIndex})`);
      } else {
        vscode.window.showErrorMessage(`Failed to update ${elementType}(${elementIndex})`);
      }
    });
  } catch (error) {
    vscode.window.showErrorMessage(`Error editing element: ${error}`);
  }
}

function handleMoveElement(doc: vscode.TextDocument, msg: any) {
  try {
    const text = doc.getText();
    const model = parseFrm(text);
    const lines = text.split(/\r?\n/);
    const elementType = msg.elementType;
    const elementIndex = msg.elementIndex;
    const targetTabIds = msg.targetTabIds; // Can be 'all' or array of tab IDs

    if (!model.tabs || model.tabs.length === 0) {
      vscode.window.showErrorMessage('No tabs defined in this form');
      return;
    }

    // Determine the opt_ list name
    const optTypeName = elementType === 'pushbutton' ? '(?:pushbutton|button)' : elementType;
    
    // Remove from all existing opt_ lists
    const optPattern = new RegExp(`^\\s*opt_${optTypeName}\\s*\\(\\s*(\\d+)\\s*\\)\\s*=`, 'i');
    for (let i = 0; i < lines.length; i++) {
      if (!optPattern.test(lines[i])) continue;
      const collected = collectContinuedStatement(lines, i);
      const list = parseIndexList(statementValue(collected.text));
      const newList = list.filter(idx => idx !== elementIndex);
      if (newList.length === list.length) continue;
      if (newList.length === 0) {
        lines.splice(i, collected.endIndex - i + 1);
        i--;
      } else {
        const wrapAt = collected.endIndex > i ? wrapWidthFromFirstLine(lines[i]) : undefined;
        const newLines = formatIndexStatement(statementKeyword(lines[i]), newList.map(String), wrapAt);
        lines.splice(i, collected.endIndex - i + 1, ...newLines);
        i += newLines.length - 1;
      }
    }

    // Determine which tabs to add element to
    const tabsToAdd = targetTabIds === 'all' ? model.tabs.map(t => t.id) : targetTabIds;

    // Add to each target tab's opt_ list
    const optKeyword = elementType === 'pushbutton' ? 'opt_pushbutton' : `opt_${elementType}`;
    
    for (const targetTabId of tabsToAdd) {
      const targetOptPattern = new RegExp(`^\\s*opt_${optTypeName}\\s*\\(\\s*${targetTabId}\\s*\\)\\s*=`, 'i');
      let targetLineIndex = -1;
      for (let i = 0; i < lines.length; i++) {
        if (targetOptPattern.test(lines[i])) {
          targetLineIndex = i;
          break;
        }
      }

      if (targetLineIndex !== -1) {
        const collected = collectContinuedStatement(lines, targetLineIndex);
        const currentList = parseIndexList(statementValue(collected.text));
        if (!currentList.includes(elementIndex)) {
          currentList.push(elementIndex);
          const wrapAt = collected.endIndex > targetLineIndex ? wrapWidthFromFirstLine(lines[targetLineIndex]) : undefined;
          const newLines = formatIndexStatement(statementKeyword(lines[targetLineIndex]), currentList.map(String), wrapAt);
          lines.splice(targetLineIndex, collected.endIndex - targetLineIndex + 1, ...newLines);
        }
      } else {
        // Create new opt_ list in the opt section
        insertIntoSection(lines, Section.Opt, [`${optKeyword}(${targetTabId})= ${elementIndex}`]);
      }
    }

    const newText = lines.join('\n');

    // Apply the edit
    const edit = new vscode.WorkspaceEdit();
    edit.replace(doc.uri, new vscode.Range(0, 0, doc.lineCount, 0), newText);

    vscode.workspace.applyEdit(edit).then(success => {
      if (success) {
        const message = targetTabIds === 'all' 
          ? `Set ${elementType}(${elementIndex}) visible on ALL tabs`
          : `Set ${elementType}(${elementIndex}) visible on ${tabsToAdd.length} tab(s)`;
        vscode.window.showInformationMessage(message);
      } else {
        vscode.window.showErrorMessage(`Failed to update tab visibility for ${elementType}(${elementIndex})`);
      }
    });
  } catch (error) {
    vscode.window.showErrorMessage(`Error updating tab visibility: ${error}`);
  }
}

/** Add a field index to group(1), keeping the leading non-index values (type_expr, and val1 val2 for revision 2). */
function addFieldToGroup1(lines: string[], fieldIndex: number, revision: number | undefined): void {
  const groupRegex = /^\s*group\s*\(\s*1\s*\)\s*=\s*/i;
  const i = lines.findIndex(l => groupRegex.test(l));
  if (i < 0) return;
  const collected = collectContinuedStatement(lines, i);
  const items = statementValue(collected.text).replace(/\\/g, ' ').trim().split(/\s+/).filter(Boolean);
  const preserveCount = revision === 2 ? 3 : 1;
  const preserved = items.slice(0, preserveCount);
  const fieldIndexes = items.slice(preserveCount).map(s => parseInt(s)).filter(n => !isNaN(n));
  if (fieldIndexes.includes(fieldIndex)) return;
  fieldIndexes.push(fieldIndex);
  fieldIndexes.sort((a, b) => a - b);
  const wrapAt = collected.endIndex > i ? wrapWidthFromFirstLine(lines[i]) : undefined;
  replaceContinuedStatement(lines, i, formatIndexStatement('group(1)', [...preserved, ...fieldIndexes.map(String)], wrapAt));
}

const DUPLICATE_KEYWORD: Record<string, string> = {
  text: 'text',
  field: 'field',
  pushbutton: '(?:push)?button',
  image: 'image',
  preview: 'preview',
};

const DUPLICATE_SECTION: Record<string, Section> = {
  text: Section.Text,
  field: Section.Field,
  pushbutton: Section.Button,
  image: Section.Image,
  preview: Section.Preview,
};

/**
 * Copy an element's statement verbatim under the next free index, placed at `msg.row`
 * (same column), and make it visible on the same tabs. The preview is told up front to
 * select the copy once it re-renders.
 */
function handleDuplicateElement(doc: vscode.TextDocument, panel: vscode.WebviewPanel, msg: any): void {
  const elementType = String(msg?.elementType ?? '');
  const sourceIndex = Number(msg?.elementIndex);
  const row = Number(msg?.row);
  const keyword = DUPLICATE_KEYWORD[elementType];
  if (!keyword || !Number.isInteger(sourceIndex) || !Number.isInteger(row) || row < 1) {
    return;
  }
  try {
    const text = doc.getText();
    const lines = text.split(/\r?\n/);
    const model = parseFrm(text);

    const head = `^(\\s*${keyword}\\s*\\(\\s*)${sourceIndex}(\\s*\\)\\s*=\\s*)`;
    const start = lines.findIndex(l => new RegExp(head, 'i').test(l));
    if (start < 0) {
      vscode.window.showWarningMessage(`Could not find ${elementType}(${sourceIndex}) in source`);
      return;
    }
    const statement = lines.slice(start, collectContinuedStatement(lines, start).endIndex + 1);

    const existing: Array<{ index?: number }> = ({
      text: model.texts,
      field: model.fields,
      pushbutton: model.pushbuttons,
      image: model.images,
      preview: model.previews,
    } as Record<string, Array<{ index?: number }>>)[elementType] ?? [];
    const newIndex = existing.reduce((max, e) => (e.index ?? 0) > max ? (e.index ?? 0) : max, 0) + 1;

    // The row is the first number after '=', except for fields: field(n)= NAME type row col ...
    const rowPattern = new RegExp(head + (elementType === 'field' ? '(\\S+\\s+\\S+\\s+)' : '()') + '\\d+', 'i');
    if (!rowPattern.test(statement[0])) {
      vscode.window.showWarningMessage(`Could not read the position of ${elementType}(${sourceIndex})`);
      return;
    }
    statement[0] = statement[0].replace(rowPattern, (_m, pre, eq, between) => `${pre}${newIndex}${eq}${between}${row}`);
    insertIntoSection(lines, DUPLICATE_SECTION[elementType], statement);

    if (elementType === 'field') {
      addFieldToGroup1(lines, newIndex, model.revision);
    }

    // Visible on the same tabs as the original
    const optTypeName = elementType === 'pushbutton' ? '(?:pushbutton|button)' : elementType;
    const optPattern = new RegExp(`^\\s*opt_${optTypeName}\\s*\\(\\s*\\d+\\s*\\)\\s*=`, 'i');
    for (let i = 0; i < lines.length; i++) {
      if (!optPattern.test(lines[i])) continue;
      const collected = collectContinuedStatement(lines, i);
      const list = parseIndexList(statementValue(collected.text));
      if (!list.includes(sourceIndex) || list.includes(newIndex)) continue;
      list.push(newIndex);
      list.sort((a, b) => a - b);
      const wrapAt = collected.endIndex > i ? wrapWidthFromFirstLine(lines[i]) : undefined;
      const newLines = formatIndexStatement(statementKeyword(lines[i]), list.map(String), wrapAt);
      lines.splice(i, collected.endIndex - i + 1, ...newLines);
      i += newLines.length - 1;
    }

    const edit = new vscode.WorkspaceEdit();
    edit.replace(doc.uri, new vscode.Range(0, 0, doc.lineCount, 0), lines.join('\n'));
    // Sent before the edit so it arrives ahead of the refresh the edit triggers
    panel.webview.postMessage({ command: 'frmSelectAfterRefresh', key: `${elementType}:${newIndex}` });
    vscode.workspace.applyEdit(edit);
  } catch (error) {
    vscode.window.showErrorMessage(`Failed to duplicate element: ${error}`);
    return;
  }
}

/**
 * Undo/redo from the preview: run VS Code's own undo/redo on the .frm document, so the preview
 * and the text editor share one history, then hand focus back to the preview.
 */
async function runDocumentHistory(doc: vscode.TextDocument, panel: vscode.WebviewPanel, command: 'undo' | 'redo') {
  const key = doc.uri.toString();
  previewHistoryRuns.set(key, (previewHistoryRuns.get(key) ?? 0) + 1);
  try {
    const visible = vscode.window.visibleTextEditors.find(e => e.document.uri.toString() === doc.uri.toString());
    await vscode.window.showTextDocument(doc, { viewColumn: visible?.viewColumn ?? vscode.ViewColumn.One, preserveFocus: false });
    await vscode.commands.executeCommand(command);
  } catch (error) {
    vscode.window.showErrorMessage(`Failed to ${command}: ${error}`);
  } finally {
    panel.reveal(panel.viewColumn, false);
    ignoreCursorMoves(key);
    const left = (previewHistoryRuns.get(key) ?? 1) - 1;
    if (left > 0) previewHistoryRuns.set(key, left); else previewHistoryRuns.delete(key);
  }
}

function handleShowInSource(doc: vscode.TextDocument, panel: vscode.WebviewPanel, msg: any) {
  try {
    const text = doc.getText();
    const lines = text.split(/\r?\n/);
    const elementType = msg.elementType;
    const elementIndex = msg.elementIndex;

    // Find the line that contains this element
    const elementLineIndex = findElement(lines, elementType, elementIndex)?.startLine ?? -1;

    if (elementLineIndex === -1) {
      vscode.window.showWarningMessage(`Could not find ${elementType}(${elementIndex}) in source`);
      return;
    }

    // Reveal and select the line in the editor
    const editor = vscode.window.visibleTextEditors.find(e => e.document.uri.toString() === doc.uri.toString());
    if (editor) {
      const line = elementLineIndex;
      const range = new vscode.Range(line, 0, line, lines[line].length);
      editor.selection = new vscode.Selection(range.start, range.end);
      editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
      // Focus the text editor
      vscode.window.showTextDocument(doc, { viewColumn: editor.viewColumn, preserveFocus: false });
      queueCursorSync(panel, doc);
    } else {
      // If editor is not visible, open it
      vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.One }).then(editor => {
        const line = elementLineIndex;
        const range = new vscode.Range(line, 0, line, lines[line].length);
        editor.selection = new vscode.Selection(range.start, range.end);
        editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
        queueCursorSync(panel, doc);
      });
    }
  } catch (error) {
    vscode.window.showErrorMessage(`Error showing element in source: ${error}`);
  }
}

function handleEditTrigger(doc: vscode.TextDocument, msg: any) {
  try {
    const { line, target, program, flag, createFile, openFile } = msg;
    const text = doc.getText();
    const lines = text.split(/\r?\n/);
    
    if (line < 0 || line >= lines.length) {
      vscode.window.showErrorMessage('Invalid trigger line');
      return;
    }

    // Create the trigger program file if requested
    if (createFile) {
      createTriggerProgramFile(program, openFile || false).then((success) => {
        if (!success) {
          return;
        }
      });
    }
    
    // Replace the trigger line
    const newTriggerLine = `trigger= ${target} ${program} ${flag}`;
    lines[line] = newTriggerLine;
    
    const edit = new vscode.WorkspaceEdit();
    edit.replace(doc.uri, new vscode.Range(0, 0, doc.lineCount, 0), lines.join('\n'));
    vscode.workspace.applyEdit(edit);
  } catch (error) {
    console.error('Error editing trigger:', error);
    vscode.window.showErrorMessage('Failed to edit trigger');
  }
}

function handleDeleteTrigger(doc: vscode.TextDocument, msg: any) {
  try {
    const { target, program, flag } = msg;
    const text = doc.getText();
    const lines = text.split(/\r?\n/);
    
    // Build the expected trigger line pattern (handle variations in whitespace)
    const expectedPattern = new RegExp(
      `^\\s*trigger\\s*=\\s*${target.replace(/\$/g, '\\$')}\\s+${program.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s+${flag}\\s*$`,
      'i'
    );
    
    // Find the line that matches this trigger
    let triggerLineIndex = -1;
    for (let i = 0; i < lines.length; i++) {
      if (expectedPattern.test(lines[i])) {
        triggerLineIndex = i;
        break;
      }
    }
    
    if (triggerLineIndex === -1) {
      vscode.window.showErrorMessage('Could not find trigger line to delete');
      return;
    }
    
    // Remove only the trigger line
    lines.splice(triggerLineIndex, 1);
    
    const edit = new vscode.WorkspaceEdit();
    edit.replace(doc.uri, new vscode.Range(0, 0, doc.lineCount, 0), lines.join('\n'));
    vscode.workspace.applyEdit(edit);
  } catch (error) {
    console.error('Error deleting trigger:', error);
    vscode.window.showErrorMessage('Failed to delete trigger');
  }
}

function handleAddTrigger(doc: vscode.TextDocument, msg: any) {
  try {
    const text = doc.getText();
    const fieldIndex = msg.fieldIndex;
    const program = msg.program;
    const createFile = msg.createFile || false;
    const openFile = msg.openFile || false;

    // Create the trigger program file if requested
    if (createFile) {
      createTriggerProgramFile(program, openFile).then((success) => {
        if (!success) {
          return;
        }
      });
    }

    // Format: trigger= <field_index> <program.prg> p
    const triggerLine = `trigger= ${fieldIndex} ${program} p`;

    // Insert after the last trigger, or as a new trigger section at the end
    const newLines = text.split(/\r?\n/);
    insertIntoSection(newLines, Section.Trigger, [triggerLine]);
    const newText = newLines.join('\n');

    // Apply the edit
    const edit = new vscode.WorkspaceEdit();
    const full = new vscode.Range(0, 0, doc.lineCount, 0);
    edit.replace(doc.uri, full, newText);
    vscode.workspace.applyEdit(edit).then(() => {
      vscode.window.showInformationMessage(`Trigger added for field ${fieldIndex}`);
    });
  } catch (error) {
    vscode.window.showErrorMessage(`Error adding trigger: ${error}`);
  }
}

function handleConfirmTabOrder(doc: vscode.TextDocument, msg: any) {
  try {
    const key = doc.uri.toString();
    
    const text = doc.getText();
    const fieldOrder: number[] = msg.fieldOrder || [];
    
    if (fieldOrder.length === 0) {
      vscode.window.showWarningMessage('No fields selected for tab order');
      return;
    }
    
    // Find or create tab_order line
    const lines = text.split(/\r?\n/);
    let tabOrderLineIndex = -1;
    for (let i = 0; i < lines.length; i++) {
      if (/^\s*tab_order\s*=/i.test(lines[i])) {
        tabOrderLineIndex = i;
      }
    }
    
    const tabOrderLine = `tab_order= ${fieldOrder.join(' ')}`;
    
    if (tabOrderLineIndex >= 0) {
      // Update existing tab_order line
      lines[tabOrderLineIndex] = tabOrderLine;
    } else {
      insertIntoSection(lines, Section.TabOrder, [tabOrderLine]);
    }
    
    const newText = lines.join('\n');
    const edit = new vscode.WorkspaceEdit();
    const full = new vscode.Range(0, 0, doc.lineCount, 0);
    edit.replace(doc.uri, full, newText);
    vscode.workspace.applyEdit(edit).then(() => {
      vscode.window.showInformationMessage(`Tab order set for ${fieldOrder.length} fields`);
    });
  } catch (error) {
    vscode.window.showErrorMessage(`Error setting tab order: ${error}`);
  }
}

function handleCancelTabOrder(doc: vscode.TextDocument, msg: any) {
  try {
    const key = doc.uri.toString();
    // Just exit tab order mode without changes
  } catch (error) {
    vscode.window.showErrorMessage(`Error canceling tab order: ${error}`);
  }
}

function handleOpenTriggerProgram(msg: any) {
  try {
    const programName = msg.program;
    if (!programName) {
      vscode.window.showErrorMessage('No program name provided');
      return;
    }

    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders) {
      vscode.window.showErrorMessage('No workspace folder found');
      return;
    }

    // Search for the program file in custom*/macros/triggers/ and system/macros/triggers/
    let foundPath: string | undefined;

    for (const folder of workspaceFolders) {
      const folderName = folder.name.toLowerCase();

      // Check custom folders first (starts with "custom")
      if (folderName.startsWith('custom')) {
        const triggersPath = path.join(folder.uri.fsPath, 'macros', 'triggers', programName);
        if (fs.existsSync(triggersPath)) {
          foundPath = triggersPath;
          break;
        }
      }
    }

    // If not found in custom, check system
    if (!foundPath) {
      for (const folder of workspaceFolders) {
        const folderName = folder.name.toLowerCase();
        if (folderName === 'system') {
          const triggersPath = path.join(folder.uri.fsPath, 'macros', 'triggers', programName);
          if (fs.existsSync(triggersPath)) {
            foundPath = triggersPath;
            break;
          }
        }
      }
    }

    if (foundPath) {
      // Open the file in a new editor tab
      vscode.workspace.openTextDocument(foundPath).then(document => {
        vscode.window.showTextDocument(document);
      });
    } else {
      vscode.window.showWarningMessage(`Trigger program not found: ${programName}`);
    }
  } catch (error) {
    vscode.window.showErrorMessage(`Error opening trigger program: ${error}`);
  }
}

function serializeFrmModel(model: FrmModel, originalText: string, changedElement?: { type: string; index: number }): string {
  // Split original text into lines for processing
  const lines = originalText.split(/\r?\n/);
  const newLines: string[] = [...lines]; // Copy original lines
  
  // Only update lines that contain elements that were moved
  // Helper function to update just the position numbers in a line
  const updatePositionInLine = (line: string, newRow: number, newCol: number): string => {
    // Match the pattern: element_type(optional_index)= old_row old_col rest_of_line
    // and replace just the row and col numbers
    return line.replace(/^(\s*(?:text|field|pushbutton|button|image|preview)\s*(?:\(\s*\d+\s*\))?\s*=\s*)(\d+)\s+(\d+)(.*)$/i, 
      (match, prefix, oldRow, oldCol, suffix) => {
        return `${prefix}${newRow} ${newCol}${suffix}`;
      });
  };
  
  // Process each line to find and update only moved elements
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const line = lines[lineIndex];
    
    // Check if this line defines a text element
    const textMatch = line.match(/^\s*(text\s*(?:\(\s*(\d+)\s*\))?)\s*=/i);
    if (textMatch) {
      const indexStr = textMatch[2];
      const index = indexStr ? Number(indexStr) : undefined;
      // Only update if this is the element that was changed (or if no changedElement specified, update all that differ)
      if (!changedElement || (changedElement.type === 'text' && changedElement.index === index)) {
        const textItem = model.texts.find(t => t.index === index);
        if (textItem) {
          // Extract current position from line to see if it changed
          const posMatch = line.match(/^\s*text\s*(?:\(\s*\d+\s*\))?\s*=\s*(\d+)\s+(\d+)/i);
          if (posMatch) {
            const currentRow = Number(posMatch[1]);
            const currentCol = Number(posMatch[2]);
            if (textItem.row !== currentRow || textItem.col !== currentCol) {
              newLines[lineIndex] = updatePositionInLine(line, textItem.row, textItem.col);
            }
          }
        }
      }
    }
    
    // Check if this line defines a field element
    const fieldMatch = line.match(/^\s*(field\s*(?:\(\s*(\d+)\s*\))?)\s*=/i);
    if (fieldMatch) {
      const indexStr = fieldMatch[2];
      const index = indexStr ? Number(indexStr) : undefined;
      // Only update if this is the element that was changed (or if no changedElement specified, update all that differ)
      if (!changedElement || (changedElement.type === 'field' && changedElement.index === index)) {
        const fieldItem = model.fields.find(f => f.index === index);
        if (fieldItem) {
          // Extract current position from line to see if it changed
          // Match field name in any format: plain, quoted, or angle-bracketed
          const posMatch = line.match(/^\s*field\s*(?:\(\s*\d+\s*\))?\s*=\s*(?:"[^"]+"|<[^>]+>|[\w$]+)\s+[\d+]+\s+(\d+)\s+(\d+)/i);
          if (posMatch) {
            const currentRow = Number(posMatch[1]);
            const currentCol = Number(posMatch[2]);
            if (fieldItem.row !== currentRow || fieldItem.col !== currentCol) {
              // For fields, we need to update the 4th and 5th numbers (row and col)
              newLines[lineIndex] = line.replace(/^(\s*field\s*(?:\(\s*\d+\s*\))?\s*=\s*(?:"[^"]+"|<[^>]+>|[\w$]+)\s+[\d+]+\s+)(\d+)\s+(\d+)(.*)$/i, 
                (match, prefix, oldRow, oldCol, suffix) => {
                  return `${prefix}${fieldItem.row} ${fieldItem.col}${suffix}`;
                });
            }
          }
        }
      }
    }
    
    // Check if this line defines a pushbutton element
    const pushMatch = line.match(/^\s*((?:pushbutton|button)\s*(?:\(\s*(\d+)\s*\))?)\s*=/i);
    if (pushMatch) {
      const indexStr = pushMatch[2];
      const index = indexStr ? Number(indexStr) : undefined;
      // Only update if this is the element that was changed (or if no changedElement specified, update all that differ)
      if (!changedElement || (changedElement.type === 'pushbutton' && changedElement.index === index)) {
        const pushItem = model.pushbuttons.find(p => p.index === index);
        if (pushItem) {
          // Extract current position from line to see if it changed
          const posMatch = line.match(/^\s*(?:pushbutton|button)\s*(?:\(\s*\d+\s*\))?\s*=\s*(\d+)\s+(\d+)/i);
          if (posMatch) {
            const currentRow = Number(posMatch[1]);
            const currentCol = Number(posMatch[2]);
            if (pushItem.row !== currentRow || pushItem.col !== currentCol) {
              newLines[lineIndex] = updatePositionInLine(line, pushItem.row, pushItem.col);
            }
          }
        }
      }
    }
    
    // Check if this line defines an image element
    const imageMatch = line.match(/^\s*(image\s*(?:\(\s*(\d+)\s*\))?)\s*=/i);
    if (imageMatch) {
      const indexStr = imageMatch[2];
      const index = indexStr ? Number(indexStr) : undefined;
      // Only update if this is the element that was changed (or if no changedElement specified, update all that differ)
      if (!changedElement || (changedElement.type === 'image' && changedElement.index === index)) {
        const imageItem = model.images.find(i => i.index === index);
        if (imageItem) {
          // Extract current position from line to see if it changed
          const posMatch = line.match(/^\s*image\s*(?:\(\s*\d+\s*\))?\s*=\s*(\d+)\s+(\d+)/i);
          if (posMatch) {
            const currentRow = Number(posMatch[1]);
            const currentCol = Number(posMatch[2]);
            if (imageItem.row !== currentRow || imageItem.col !== currentCol) {
              newLines[lineIndex] = updatePositionInLine(line, imageItem.row, imageItem.col);
            }
          }
        }
      }
    }
    
    // Check if this line defines a preview element
    const previewMatch = line.match(/^\s*(preview\s*(?:\(\s*(\d+)\s*\))?)\s*=/i);
    if (previewMatch) {
      const indexStr = previewMatch[2];
      const index = indexStr ? Number(indexStr) : undefined;
      // Only update if this is the element that was changed (or if no changedElement specified, update all that differ)
      if (!changedElement || (changedElement.type === 'preview' && changedElement.index === index)) {
        const previewItem = model.previews.find(p => p.index === index);
        if (previewItem) {
          // Extract current position from line to see if it changed
          const posMatch = line.match(/^\s*preview\s*(?:\(\s*\d+\s*\))?\s*=\s*(\d+)\s+(\d+)/i);
          if (posMatch) {
            const currentRow = Number(posMatch[1]);
            const currentCol = Number(posMatch[2]);
            if (previewItem.row !== currentRow || previewItem.col !== currentCol) {
              newLines[lineIndex] = updatePositionInLine(line, previewItem.row, previewItem.col);
            }
          }
        }
      }
    }
  }
  
  return newLines.join('\n');
}

function updateWebview(panel: vscode.WebviewPanel, doc: vscode.TextDocument) {
  const renderStart = Date.now();
  const text = doc.getText();
  const key = doc.uri.toString();
  const unindexed = unindexedCounts(findUnindexed(text));
  if (gatedDocs.has(key)) {
    if (unindexed.texts + unindexed.buttons > 0) {
      // The gate is its own page; leaving it later needs a full load of the form
      readyPanels.delete(panel);
      // The gate page reports no timing; the form's load is timed when it comes
      pageLoadByPanel.delete(panel);
      panel.webview.html = renderGateHtml(panel.webview, unindexed);
      shownTextByDoc.set(key, text);
      return;
    }
    // Every line has an index now (auto-added or typed): show the form
    gatedDocs.delete(key);
  }
  const model = parseFrm(text);
  recordUsedAssets(key, model);
  // Resolve image URIs against allowed folders
  if (model.images && model.images.length) {
    for (const img of model.images) {
      img.resolvedSrc = resolveImageSrc(panel.webview, img.file);
    }
  }
  const initialZoom = zoomByDoc.get(doc.uri.toString()) ?? 1;
  const initialTab = activeTabByDoc.get(doc.uri.toString());
  const initialGridOn = gridOnByDoc.get(doc.uri.toString());
  const availableTriggerPrograms = getAvailableTriggerPrograms();
  const showZoomControls = vscode.workspace.getConfiguration('vertexFrmPreview').get<boolean>('showZoomControls', true);
  const parts = renderPreview(model, { initialZoom, initialActiveTab: initialTab, initialGridOn, availableTriggerPrograms, showZoomControls, unindexed });
  shownTextByDoc.set(doc.uri.toString(), text);
  if (readyPanels.has(panel)) {
    // Patch the loaded page in place: no reload (which flashes), and the styles and script aren't sent again
    panel.webview.postMessage({ command: 'frmUpdate', body: parts.body, data: parts.data });
  } else {
    // Full load; the new page reports 'frmReady' once it can take in-place updates
    readyPanels.delete(panel);
    const html = renderPreviewPage(panel.webview, mediaRoot(), parts);
    // A panel created just now keeps its creation time as the start; other loads start here
    const pending = pageLoadByPanel.get(panel);
    pageLoadByPanel.set(panel, {
      start: pending?.start ?? renderStart,
      created: pending?.created ?? false,
      renderMs: Date.now() - renderStart,
      file: vscode.workspace.asRelativePath(doc.uri)
    });
    panel.webview.html = html;
  }
}

/** Re-render after typing pauses, skipping changes that leave the displayed text unchanged. */
function scheduleRefresh(panel: vscode.WebviewPanel, doc: vscode.TextDocument) {
  const key = doc.uri.toString();
  const existing = refreshTimerByDoc.get(key);
  if (existing) {
    clearTimeout(existing);
  }
  refreshTimerByDoc.set(key, setTimeout(() => {
    refreshTimerByDoc.delete(key);
    if ((pendingPreviewEdits.get(key) ?? 0) > 0) {
      scheduleRefresh(panel, doc);
      return;
    }
    if (doc.getText() !== shownTextByDoc.get(key)) {
      updateWebview(panel, doc);
    }
    flushCursorSync(panel, doc);
  }, REFRESH_DELAY_MS));
}

// Parser and view-model structures
interface FrmText {
  index?: number; // optional index from text(n)=
  row: number;
  col: number;
  content: string; // optional label in { }
}

interface FrmBox {
  row: number; // start row (top-left)
  col: number; // start col (top-left)
  rows: number; // height in grid rows
  cols: number; // width in grid columns
  // Optional gap on the top horizontal line where the label (text) sits
  // Values are relative to the left edge of the box, measured in grid columns
  gapStart?: number; // starting column offset for the gap (e.g., 2 when text is shifted by 2)
  gapSpan?: number;  // number of columns to skip (approx. label length)
}

interface FrmField {
  index?: number; // optional index from field(n)=
  name: string;
  nameFormat?: { angle?: boolean; quoted?: boolean }; // how the name was formatted: <NAME>, "NAME", <"NAME">, or plain
  type: number; // 1 normal, 4 locked
  typeExpr: string; // raw type expression (e.g., "2048+4+1")
  locked: boolean; // derived from type
  rightAlign: boolean; // 16384 flag
  centerAlign: boolean; // 32768 flag
  transparent: boolean; // 8192 flag
  row: number;
  col: number;
  len: number; // column length
  values: string[]; // dropdown choices if any
}

type PushKind = 'radio' | 'select' | 'checkbox';
interface FrmPushButton {
  index?: number; // optional index from pushbutton(n)= (also doubles as tab id association)
  row: number;
  col: number;
  label: string;
  kind: PushKind;
  name?: string; // variable name for radio/checkbox
  value?: string; // value spec (e.g., 1 or 1;0)
  action?: 'program' | 'variable';
  program?: string;
  isBottomBar?: boolean; // true if this is a bottom bar button (row = 100)
  bottomBarRow?: number; // position in bottom bar (extracted from second number after 100)
}

interface FrmImage {
  index?: number; // optional index from image(n)=
  row: number; // top-left row
  col: number; // top-left col
  rows: number; // height in grid rows
  cols: number; // width in grid columns
  mode: number; // parsed numeric mode (bitwise OR of flags)
  modeExpr?: string; // raw expression (e.g., "1+2") for future use
  file: string; // file name
  resolvedSrc?: string; // webview-safe URI string if resolved
}

interface FrmPreview {
  index?: number; // optional index from preview(n)=
  row: number; // top-left row
  col: number; // top-left col
  rows: number; // height in grid rows
  cols: number; // width in grid columns
  mode: number; // parsed numeric mode (bitwise OR of flags)
  modeExpr?: string; // raw expression (e.g., "1+2") for future use
  path: string; // file path (e.g., "$DIR_PICTS/wind_zones.vxp")
  field: string; // field name (can be empty)
  portType: string; // PORT_2D, PORT_3D, or PORT_BMP
  portStyle?: string; // optional style (e.g., SIMPLE, WIREFRAME, HIDDEN_LINE, etc.)
}

interface FrmTrigger {
  target: string; // field index number or special like $ONSTART2, $ONEXIT1
  program: string; // program name (e.g., sylomer_edit.prg)
  flag: string; // typically 'p' for program
  line: number; // line number in source for editing
}

interface FrmModel {
  title: string;
  rows: number;
  cols: number;
  portRows?: number; // port_size rows as written in the file (0 = auto)
  portCols?: number; // port_size cols as written in the file (0 = auto)
  winstyle?: string; // vxdbase_winstyle value (e.g., 'VXUI' or 'only')
  revision?: number; // revision value (1 or 2) affects group format
  texts: FrmText[];
  fields: FrmField[];
  pushbuttons: FrmPushButton[];
  boxes: FrmBox[];
  images: FrmImage[];
  previews: FrmPreview[];
  triggers: FrmTrigger[];
  tabOrder?: number[]; // field indexes in tab order sequence
  // Optional tab model
  tabs?: { id: number; label: string }[];
  tabTexts?: Record<number, number[]>; // tab id -> text indexes
  tabFields?: Record<number, number[]>; // tab id -> field indexes
  tabPushButtons?: Record<number, number[]>; // tab id -> pushbutton indexes
  tabImages?: Record<number, number[]>; // tab id -> image indexes
  tabPreviews?: Record<number, number[]>; // tab id -> preview indexes
}

function extractProgramFromTail(tail: string): string | undefined {
  const trimmed = tail.trim();
  if (!trimmed) {
    return undefined;
  }
  const match = trimmed.match(/(@[^\s(]+)(\s*\([^)]*\))?/i);
  if (!match) {
    return undefined;
  }
  const head = match[1];
  const args = match[2] ? match[2].replace(/\s+\(/, '(') : '';
  return `${head}${args}`.trim();
}

/** Flatten `\`-continued lines in source for regex-based parsing. */
function joinContinuedLines(src: string): string {
  return src.replace(/\\\s*\r?\n[ \t]*/g, ' ');
}

/** Join a statement starting at startIndex across `\` continuations. */
function collectContinuedStatement(lines: string[], startIndex: number): { text: string; endIndex: number } {
  let i = startIndex;
  const parts: string[] = [];
  while (i < lines.length) {
    let content = lines[i];
    const cont = lineContinues(content);
    if (cont) {
      content = content.trimEnd().slice(0, -1);
    }
    parts.push(i === startIndex ? content : content.trim());
    if (!cont) break;
    i++;
  }
  return { text: parts.join(' '), endIndex: i };
}

/** Text after the first `=` in a joined statement. */
function statementValue(joinedText: string): string {
  const eq = joinedText.indexOf('=');
  return eq >= 0 ? joinedText.slice(eq + 1) : joinedText;
}

/** Keyword part of a statement line, e.g. `opt_text(1)` or `group(1)`. */
function statementKeyword(line: string): string {
  const m = line.match(/^\s*([^=]+?)\s*=/);
  return m ? m[1].trim() : line.trim();
}

/** Parse a list of numeric indexes, ignoring leftover `\` tokens. */
function parseIndexList(raw: string): number[] {
  return raw
    .replace(/\\/g, ' ')
    .replace(/[,;]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map(Number)
    .filter(n => Number.isFinite(n));
}

/** Items-per-line from the first line of a wrapped statement. */
function wrapWidthFromFirstLine(firstLine: string): number {
  const afterEq = firstLine.includes('=') ? firstLine.slice(firstLine.indexOf('=') + 1) : firstLine;
  const content = afterEq.replace(/\\\s*$/, '').trim();
  const count = content ? content.split(/\s+/).filter(Boolean).length : 0;
  return count > 0 ? count : 10;
}

/**
 * Rebuild a `keyword= items` statement. If wrapAt is set, wrap with trailing `\`
 * and 16-space indent on continuation lines (same style as existing group rewriter).
 */
function formatIndexStatement(keywordWithArgs: string, items: Array<string | number>, wrapAt?: number): string[] {
  const toks = items.map(String);
  if (toks.length === 0) {
    return [`${keywordWithArgs}=`];
  }
  const shouldWrap = wrapAt != null && wrapAt > 0;
  if (!shouldWrap) {
    return [`${keywordWithArgs}= ${toks.join(' ')}`];
  }
  const out: string[] = [];
  let current: string[] = [];
  for (let idx = 0; idx < toks.length; idx++) {
    current.push(toks[idx]);
    if (current.length >= wrapAt && idx < toks.length - 1) {
      const body = current.join(' ');
      out.push(out.length === 0 ? `${keywordWithArgs}= ${body}\\` : `                ${body}\\`);
      current = [];
    }
  }
  if (current.length > 0) {
    const body = current.join(' ');
    out.push(out.length === 0 ? `${keywordWithArgs}= ${body}` : `                ${body}`);
  }
  return out;
}

function replaceContinuedStatement(lines: string[], startIndex: number, newLines: string[]): void {
  const { endIndex } = collectContinuedStatement(lines, startIndex);
  lines.splice(startIndex, endIndex - startIndex + 1, ...newLines);
}

// ---------------------------------------------------------------------------
// File section order
// ---------------------------------------------------------------------------

/** Sections of an FRM file, in the order they should appear. */
const enum Section {
  Charset = 0,
  Header = 1,
  Text = 2,
  Field = 3,
  Group = 4,
  Button = 5,
  Image = 6,
  Preview = 7,
  Opt = 8,
  TabOrder = 9,
  Trigger = 10,
}

const HEADER_KEYWORDS = new Set(['vxdbase_winstyle', 'port_size', 'revision', 'status_bar', 'header', 'page_header']);
const OPT_KIND_ORDER = ['text', 'field', 'pushbutton', 'image', 'preview'];

interface StatementClass {
  section: Section;
  /** `(n)` index of the statement, if any. */
  index?: number;
  /** Secondary sort key inside the section (used for opt_* kinds). */
  kind?: number;
}

function isBlankLine(line: string): boolean {
  return /^\s*$/.test(line);
}

function isCommentLine(line: string): boolean {
  return /^\s*!/.test(line);
}

/** A lone `!` used to separate sections. */
function isSeparatorLine(line: string): boolean {
  return isBlankLine(line) || /^\s*!\s*$/.test(line);
}

/** Which section a statement line belongs to, or undefined for unrecognised statements. */
function classifyStatement(line: string): StatementClass | undefined {
  const m = line.match(/^\s*([A-Za-z_$][\w$]*)\s*(?:\(\s*(\d+)\s*\))?\s*=/);
  if (!m) {
    return undefined;
  }
  const keyword = m[1].toLowerCase();
  const index = m[2] !== undefined ? parseInt(m[2], 10) : undefined;
  if (keyword === 'charset') return { section: Section.Charset };
  if (HEADER_KEYWORDS.has(keyword)) return { section: Section.Header };
  switch (keyword) {
    case 'text': return { section: Section.Text, index };
    case 'field': return { section: Section.Field, index };
    case 'group': return { section: Section.Group, index };
    case 'button':
    case 'pushbutton': return { section: Section.Button, index };
    case 'image': return { section: Section.Image, index };
    case 'preview': return { section: Section.Preview, index };
    case 'tab_order': return { section: Section.TabOrder };
    case 'trigger': return { section: Section.Trigger };
  }
  if (keyword.startsWith('opt_')) {
    const kindName = keyword.slice(4) === 'button' ? 'pushbutton' : keyword.slice(4);
    const kind = OPT_KIND_ORDER.indexOf(kindName);
    return { section: Section.Opt, index, kind: kind >= 0 ? kind : OPT_KIND_ORDER.length };
  }
  return undefined;
}

/** Number of leading lines forming the top-of-file comment banner (comments and blanks before the first statement). */
function bannerLength(lines: string[]): number {
  let i = 0;
  while (i < lines.length && (isBlankLine(lines[i]) || isCommentLine(lines[i]))) {
    i++;
  }
  return i;
}

/**
 * Insert new statement lines where their section belongs:
 * after the last statement of the same section, otherwise between the
 * neighbouring sections, separated from them by an empty line.
 * Unrecognised statements count as part of the section of the statement above them.
 */
function insertIntoSection(lines: string[], section: Section, newLines: string[]): void {
  let lastSameEnd = -1;
  let lastLowerEnd = -1;
  let firstHigherStart = -1;
  let current: Section = Section.Header;

  for (let i = bannerLength(lines); i < lines.length; i++) {
    if (isBlankLine(lines[i]) || isCommentLine(lines[i])) {
      continue;
    }
    const end = collectContinuedStatement(lines, i).endIndex;
    const cls = classifyStatement(lines[i]);
    if (cls) {
      current = cls.section;
    }
    if (current === section) {
      lastSameEnd = end;
    } else if (current < section) {
      lastLowerEnd = end;
    } else if (firstHigherStart < 0) {
      firstHigherStart = i;
    }
    i = end;
  }

  if (lastSameEnd >= 0) {
    lines.splice(lastSameEnd + 1, 0, ...newLines);
    return;
  }

  if (lastLowerEnd >= 0) {
    const at = lastLowerEnd + 1;
    const block = ['', ...newLines];
    if (at < lines.length && !isSeparatorLine(lines[at])) {
      block.push('');
    }
    lines.splice(at, 0, ...block);
    return;
  }

  if (firstHigherStart >= 0) {
    // Go above comments attached to the next statement, unless they are the top banner.
    let at = firstHigherStart;
    while (at > 0 && isCommentLine(lines[at - 1]) && !isSeparatorLine(lines[at - 1])) {
      at--;
    }
    if (at <= bannerLength(lines) && lines.slice(0, at).every(l => isBlankLine(l) || isCommentLine(l))) {
      at = firstHigherStart;
    }
    lines.splice(at, 0, ...newLines, '');
    return;
  }

  // No statements at all: append at the end of the file (before a final newline).
  let at = lines.length;
  if (at > 0 && lines[at - 1] === '') {
    at--;
  }
  const block = at > 0 && !isBlankLine(lines[at - 1]) ? ['', ...newLines] : [...newLines];
  lines.splice(at, 0, ...block);
}

interface SectionUnit {
  section: Section;
  index?: number;
  kind?: number;
  /** Blank lines, separators and floating comments between the previous unit and this one. */
  gap: string[];
  /** Comment lines directly above the statement, the statement itself, and any unrecognised statements attached below. */
  body: string[];
}

/** Reorder a whole FRM file into section order. Returns the new lines. */
function sortFrmSections(lines: string[]): string[] {
  const src = [...lines];
  const endsWithNewline = src.length > 0 && src[src.length - 1] === '';
  if (endsWithNewline) {
    src.pop();
  }

  const banner = src.slice(0, bannerLength(src));
  const units: SectionUnit[] = [];
  let pending: string[] = []; // blanks/comments since the previous statement

  for (let i = banner.length; i < src.length; i++) {
    const line = src[i];
    if (isBlankLine(line) || isCommentLine(line)) {
      pending.push(line);
      continue;
    }

    // Split pending into gap + comments directly above (no blank or lone `!` in between).
    let split = pending.length;
    while (split > 0 && isCommentLine(pending[split - 1]) && !isSeparatorLine(pending[split - 1])) {
      split--;
    }
    const gap = pending.slice(0, split);
    const leading = pending.slice(split);
    pending = [];

    const end = collectContinuedStatement(src, i).endIndex;
    const statement = src.slice(i, end + 1);
    i = end;

    const cls = classifyStatement(line);
    if (!cls && units.length > 0) {
      // Unrecognised statement: stays attached to the statement above it.
      units[units.length - 1].body.push(...gap, ...leading, ...statement);
      continue;
    }
    units.push({
      section: cls ? cls.section : Section.Header,
      index: cls?.index,
      kind: cls?.kind,
      gap,
      body: [...leading, ...statement],
    });
  }
  const trailing = pending;

  const out: string[] = [...banner];
  const trimSeparators = (block: string[]) => {
    let s = 0;
    while (s < block.length && isSeparatorLine(block[s])) s++;
    let e = block.length;
    while (e > s && isSeparatorLine(block[e - 1])) e--;
    return block.slice(s, e);
  };

  let firstSection = true;
  for (let section = Section.Charset; section <= Section.Trigger; section++) {
    const inSection = units.filter(u => u.section === section);
    if (inSection.length === 0) {
      continue;
    }
    sortSectionUnits(section, inSection);
    if (!firstSection) {
      out.push('');
    }
    firstSection = false;
    inSection.forEach((unit, n) => {
      if (n === 0) {
        // Section boundary: drop separators, keep floating comments.
        const kept = trimSeparators(unit.gap);
        out.push(...kept);
        if (kept.length > 0) out.push('');
      } else {
        out.push(...unit.gap);
      }
      out.push(...unit.body);
    });
  }

  const trailingKept = trimSeparators(trailing);
  if (trailingKept.length > 0) {
    out.push('', ...trailingKept);
  }
  if (endsWithNewline) {
    out.push('');
  }
  return out;
}

/** Sort units inside one section: indexed units by (kind, index); unindexed units keep their slots. */
function sortSectionUnits(section: Section, units: SectionUnit[]): void {
  if (section === Section.Charset || section === Section.Header || section === Section.TabOrder || section === Section.Trigger) {
    return;
  }
  const slots: number[] = [];
  const indexed: SectionUnit[] = [];
  units.forEach((u, n) => {
    if (u.index !== undefined) {
      slots.push(n);
      indexed.push(u);
    }
  });
  const sorted = indexed
    .map((u, order) => ({ u, order }))
    .sort((a, b) => ((a.u.kind ?? 0) - (b.u.kind ?? 0)) || (a.u.index! - b.u.index!) || (a.order - b.order))
    .map(x => x.u);
  slots.forEach((slot, n) => {
    units[slot] = sorted[n];
  });
}

function sortSectionsCommand() {
  const editor = vscode.window.activeTextEditor;
  if (!editor || !isFrmFile(editor.document)) {
    vscode.window.showWarningMessage('Open a FRM file to sort its sections.');
    return;
  }
  const doc = editor.document;
  const text = doc.getText();
  const eol = doc.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
  const newText = sortFrmSections(text.split(/\r?\n/)).join(eol);
  if (newText === text) {
    vscode.window.showInformationMessage('FRM sections are already in order.');
    return;
  }
  const edit = new vscode.WorkspaceEdit();
  edit.replace(doc.uri, new vscode.Range(0, 0, doc.lineCount, 0), newText);
  vscode.workspace.applyEdit(edit);
}

function parseFrm(src: string): FrmModel {
  const text = src.replace(/\r\n?/g, '\n');
  const continued = joinContinuedLines(text);
  // header="literal" or header={TITLE or expression}; resolve brace form through translation-aware normalizer
  const headerMatch = text.match(/header\s*=\s*(?:"([^"]*)"|\{([^}]*)\})/i);
  const title = headerMatch
    ? (headerMatch[1] != null ? headerMatch[1] : normalizeBraceText(headerMatch[2].trim()))
    : 'FRM Preview';
  // port_size= rows cols (0 means auto in that direction)
  const portMatch = text.match(/^\s*port_size\s*=\s*(\d+)\s+(\d+)/im);
  const requestedRows = portMatch ? Number(portMatch[1]) : 0;
  const requestedCols = portMatch ? Number(portMatch[2]) : 0;
  // vxdbase_winstyle= VXUI or only
  const winstyleMatch = text.match(/^\s*vxdbase_winstyle\s*=\s*(\S+)/im);
  const winstyle = winstyleMatch ? winstyleMatch[1].trim() : undefined;
  // revision= 1 or 2 (affects group format and other features)
  const revisionMatch = text.match(/^\s*revision\s*=\s*(\d+)/im);
  const revision = revisionMatch ? Number(revisionMatch[1]) : undefined;

  const texts: FrmText[] = [];
  const fields: FrmField[] = [];
  const pushbuttons: FrmPushButton[] = [];
  const boxes: FrmBox[] = [];
  const images: FrmImage[] = [];
  const previews: FrmPreview[] = [];
  const triggers: FrmTrigger[] = [];
  const tabs: { id: number; label: string }[] = [];
  const tabTexts: Record<number, number[]> = {};
  const tabFields: Record<number, number[]> = {};
  const tabPushButtons: Record<number, number[]> = {};
  const tabImages: Record<number, number[]> = {};
  const tabPreviews: Record<number, number[]> = {};

  // text= row col {label} OR text= row col "label" OR text(n)= row col ...
  const textRegex = /^\s*text\s*(?:\(\s*(\d+)\s*\))?\s*=\s*(\d+)\s+(\d+)(?:\s*(?:"([^"]*)"|\{([^}]*)\}))?/gim;
  let tm: RegExpExecArray | null;
  while ((tm = textRegex.exec(text))) {
    const idx = tm[1] != null ? Number(tm[1]) : undefined;
    const row = Number(tm[2]);
    let col = Number(tm[3]);
    const raw = ((tm[4] ?? tm[5] ?? '') as string).trim();
    // If came from braces (tm[4]), support concatenation like {LABEL2+":"} by resolving tokens and concatenating
    let content = (tm[5] != null)
      ? normalizeBraceText(raw)
      : raw; // tm[3] is already the unquoted content
    // Extract any box directives from content and collect boxes
    const ex = extractBoxesFromContent(content, row, col);
    if (ex) {
      content = ex.cleaned;
      if (ex.boxes.length) boxes.push(...ex.boxes);
      // Note: Column adjustment for box text is handled in the box positioning logic,
      // not here to avoid repeated shifts during serialization
    }
    texts.push({ index: idx, row, col, content });
  }

  // pushbutton(n)= ... OR button(n)= ... (treat 'button' as synonym for 'pushbutton')
  // Now handles both regular buttons (row col {label}) and bottom bar buttons (100 rowpos 0 {label})
  const pbRegex = /^\s*(?:pushbutton|button)\s*(?:\(\s*(\d+)\s*\))?\s*=\s*(\d+)\s+(\d+)\s+(\d+)?\s*(?:(?:"([^"]*)"|\{([^}]*)\}))?\s*([^\n]*)/gim;
  let pbm: RegExpExecArray | null;
  while ((pbm = pbRegex.exec(text))) {
    const idx = pbm[1] != null ? Number(pbm[1]) : undefined;
    const firstNum = Number(pbm[2]);
    const secondNum = Number(pbm[3]);
    const thirdNum = pbm[4] != null ? Number(pbm[4]) : undefined;
    
    // Detect bottom bar button: if first number is 100 and we have 3 numbers
    let isBottomBar = false;
    let bottomBarRow: number | undefined;
    let row: number;
    let col: number;
    
    if (firstNum === 100 && thirdNum !== undefined) {
      // Bottom bar button: 100 rowpos 0 {label}
      isBottomBar = true;
      bottomBarRow = secondNum;
      row = firstNum; // Store 100 as row for compatibility
      col = thirdNum;
    } else {
      // Regular button: row col {label}
      row = firstNum;
      col = secondNum;
    }
    
  const raw = ((pbm[5] ?? pbm[6] ?? '') as string).trim();
  const label = (pbm[6] != null) ? normalizeBraceText(raw) : raw;
    const tail = (pbm[7] || '').trim();

    let kind: PushKind = 'select';
    let name: string | undefined;
    let value: string | undefined;
    let action: 'program' | 'variable' | undefined;
    let program: string | undefined;
    const cleanedTail = tail.trim();
    if (/\bRADIO\b/i.test(tail)) {
      kind = 'radio';
      const m = tail.match(/\bRADIO\b\s*([A-Z0-9_]+)\s*=\s*([^\s]+)/i);
      if (m) { name = m[1]; value = m[2].replace(/,/g, ';'); }
      action = 'variable';
    } else if (/\bCHECKBOX\b/i.test(tail)) {
      kind = 'checkbox';
      const m = tail.match(/\bCHECKBOX\b\s*([A-Z0-9_]+)\s*=\s*([^\s]+)/i);
      if (m) { name = m[1]; value = m[2].replace(/,/g, ';'); }
      action = 'variable';
    } else {
      if (cleanedTail) {
        const assignMatch = cleanedTail.match(/([A-Z0-9_]+)\s*=\s*([^\s]+)/i);
        if (assignMatch) {
          name = assignMatch[1];
          value = assignMatch[2].replace(/,/g, ';');
          action = 'variable';
        }
        if (!action) {
          const programMatch = extractProgramFromTail(cleanedTail);
          if (programMatch) {
            program = programMatch;
            action = 'program';
          }
        }
      }
    }
    pushbuttons.push({ index: idx, row, col, label, kind, name, value, action, program, isBottomBar, bottomBarRow });
  }

  // field= NAME type row col len ignore ["choices"...] OR field(n)= ...
  // NAME can be: plain (A-Z0-9_$), quoted ("$NAME"), angle-bracketed (<NAME>), or both ("<NAME>")
  const fieldRegex = /^\s*field\s*(?:\(\s*(\d+)\s*\))?\s*=\s*"?\s*<?([$\w]+)>?\s*"?\s+([\d+]+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)?([^\n]*)/gim;
  let fm: RegExpExecArray | null;
  while ((fm = fieldRegex.exec(text))) {
    const idx = fm[1] != null ? Number(fm[1]) : undefined;
    const name = (fm[2] || '').trim();
    // Check the original matched text to determine format
    const matchedText = fm[0];
    const afterEquals = matchedText.substring(matchedText.indexOf('=') + 1).trim();
    const hasQuoted = afterEquals.startsWith('"');
    const hasAngle = /<[$\w]+>/.test(afterEquals);
    const nameFormat = (hasAngle || hasQuoted) ? { angle: hasAngle, quoted: hasQuoted } : undefined;
    const typeExprRaw = (fm[3] || '').toString();
    const typeExpr = typeExprRaw.trim();
    const normalizedTypeExpr = typeExpr || '1';
    const typeFlags = normalizedTypeExpr
      .split('+')
      .map(s => Number((s || '').trim()))
      .filter(n => Number.isFinite(n));
    const type = typeFlags.reduce((a, b) => (a | b), 0);
    const locked = typeFlags.includes(4);
    const rightAlign = typeFlags.includes(16384);
    const centerAlign = typeFlags.includes(32768);
    const transparent = typeFlags.includes(8192);
    const row = Number(fm[4]);
    const col = Number(fm[5]);
    const len = Number(fm[6]);
    // fm[7] is optional ignore value; fm[8] is trailing text containing optional choices
    const tail = (fm[8] ?? '').toString();
    const values = Array.from(tail.matchAll(/\"([^\"]+)\"/g)).map(x => x[1]);
    fields.push({ index: idx, name, nameFormat, type, typeExpr: normalizedTypeExpr, locked, rightAlign, centerAlign, transparent, row, col, len, values });
  }

  // image(n)= row col rows cols mode "filename"
  const imageRegex = /^\s*image\s*(?:\(\s*(\d+)\s*\))?\s*=\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+([^\s\n]+)\s*(?:"([^"]+)"|\{([^}]+)\})?/gim;
  let im: RegExpExecArray | null;
  while ((im = imageRegex.exec(text))) {
    const idx = im[1] != null ? Number(im[1]) : undefined;
    const row = Number(im[2]);
    const col = Number(im[3]);
    const rows = Number(im[4]);
    const cols = Number(im[5]);
    const modeExpr = (im[6] || '').toString().trim();
    const mode = modeExpr
      .split('+')
      .map(s => Number((s || '').trim()))
      .filter(n => Number.isFinite(n))
      .reduce((a, b) => (a | b), 0);
    const raw = ((im[7] ?? im[8] ?? '') as string).trim();
    const file = raw;
    images.push({ index: idx, row, col, rows, cols, mode, modeExpr, file });
  }

  // preview(n)= row col rows cols mode "path" "field" port_type port_style
  // port_type and port_style can be either quoted or unquoted
  const previewRegex = /^\s*preview\s*(?:\(\s*(\d+)\s*\))?\s*=\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+([^\s\n]+)\s*"([^"]*)"\s*"([^"]*)"\s+(?:"([^"]*)"|(\S+))(?:[ \t]+(?:"([^"]*)"|(\S+)))?(?:\s|$)/gim;
  let pm: RegExpExecArray | null;
  while ((pm = previewRegex.exec(text))) {
    const idx = pm[1] != null ? Number(pm[1]) : undefined;
    const row = Number(pm[2]);
    const col = Number(pm[3]);
    const rows = Number(pm[4]);
    const cols = Number(pm[5]);
    const modeExpr = (pm[6] || '').toString().trim();
    const mode = modeExpr
      .split('+')
      .map(s => Number((s || '').trim()))
      .filter(n => Number.isFinite(n))
      .reduce((a, b) => (a | b), 0);
    const path = pm[7].trim();
    const field = pm[8].trim();
    // portType can be quoted (group 9) or unquoted (group 10)
    const portType = (pm[9] ?? pm[10] ?? '').trim();
    // portStyle can be quoted (group 11) or unquoted (group 12)
    const portStyleRaw = (pm[11] ?? pm[12])?.trim();
    const portStyle = portStyleRaw === '""' ? '' : portStyleRaw;
    previews.push({ index: idx, row, col, rows, cols, mode, modeExpr, path, field, portType, portStyle });
  }

  // trigger= target program flag (e.g., trigger= 1 sylomer_edit.prg p)
  // Stays on one line, so a missing flag doesn't take the next line's first word
  const triggerRegex = /^[ \t]*trigger[ \t]*=[ \t]*(\$?[\w]+)[ \t]+([^\s]+)(?:[ \t]+([^\s]*))?/gim;
  let trm: RegExpExecArray | null;
  while ((trm = triggerRegex.exec(text))) {
    const target = trm[1].trim();
    const program = trm[2].trim();
    const flag = (trm[3] ?? '').trim();
    const lineIndex = text.slice(0, trm.index).split('\n').length - 1;
    triggers.push({ target, program, flag, line: lineIndex });
  }

  // tab_order= field1 field2 field3...
  const tabOrderMatch = text.match(/^\s*tab_order\s*=\s*([^\n]*)/im);
  let tabOrder: number[] | undefined;
  if (tabOrderMatch) {
    const fieldIndexes = (tabOrderMatch[1] || '').replace(/[,;]+/g, ' ').trim().split(/\s+/).filter(Boolean).map(Number);
    if (fieldIndexes.length > 0) {
      tabOrder = fieldIndexes;
    }
  }

  // Tabs: page_header(n)= {LABEL} or "LABEL"
  const pageHeaderRegex = /^\s*page_header\s*\(\s*(\d+)\s*\)\s*=\s*(?:"([^"]*)"|\{([^}]*)\})/gim;
  let ph: RegExpExecArray | null;
  while ((ph = pageHeaderRegex.exec(text))) {
    const id = Number(ph[1]);
  const raw = ((ph[2] ?? ph[3] ?? '') as string).trim();
  const label = (ph[3] != null) ? normalizeBraceText(raw) : raw;
    tabs.push({ id, label });
  }

  // opt_text(n)= list of text indexes
  const optTextRegex = /^\s*opt_text\s*\(\s*(\d+)\s*\)\s*=\s*([^\n]*)/gim;
  let ot: RegExpExecArray | null;
  while ((ot = optTextRegex.exec(continued))) {
    const id = Number(ot[1]);
    const list = parseIndexList(ot[2] || '');
    if (!tabTexts[id]) tabTexts[id] = [];
    tabTexts[id].push(...list);
  }

  // opt_field(n)= list of field indexes
  const optFieldRegex = /^\s*opt_field\s*\(\s*(\d+)\s*\)\s*=\s*([^\n]*)/gim;
  let of: RegExpExecArray | null;
  while ((of = optFieldRegex.exec(continued))) {
    const id = Number(of[1]);
    const list = parseIndexList(of[2] || '');
    if (!tabFields[id]) tabFields[id] = [];
    tabFields[id].push(...list);
  }
  // opt_pushbutton(n)= ... OR opt_button(n)= ... (treat 'opt_button' as synonym for 'opt_pushbutton')
  const optPushRegex = /^\s*opt_(?:pushbutton|button)\s*\(\s*(\d+)\s*\)\s*=\s*([^\n]*)/gim;
  let op: RegExpExecArray | null;
  while ((op = optPushRegex.exec(continued))) {
    const id = Number(op[1]);
    const list = parseIndexList(op[2] || '');
    if (!tabPushButtons[id]) tabPushButtons[id] = [];
    tabPushButtons[id].push(...list);
  }

  // opt_image(n)= list of image indexes
  const optImageRegex = /^\s*opt_image\s*\(\s*(\d+)\s*\)\s*=\s*([^\n]*)/gim;
  let oi: RegExpExecArray | null;
  while ((oi = optImageRegex.exec(continued))) {
    const id = Number(oi[1]);
    const list = parseIndexList(oi[2] || '');
    if (!tabImages[id]) tabImages[id] = [];
    tabImages[id].push(...list);
  }

  // opt_preview(n)= list of preview indexes
  const optPreviewRegex = /^\s*opt_preview\s*\(\s*(\d+)\s*\)\s*=\s*([^\n]*)/gim;
  let opr: RegExpExecArray | null;
  while ((opr = optPreviewRegex.exec(continued))) {
    const id = Number(opr[1]);
    const list = parseIndexList(opr[2] || '');
    if (!tabPreviews[id]) tabPreviews[id] = [];
    tabPreviews[id].push(...list);
  }

  // Determine grid extents (no padding; exact fit). Use 1 as absolute minimum only if empty.
  // Exclude bottom bar buttons (isBottomBar=true) and hidden fields (row or col 1000, shown in the side panel)
  const gridFields = fields.filter(f => !isHiddenFieldPosition(f.row, f.col));
  const contentMaxRow = Math.max(
    texts.reduce((a, t) => Math.max(a, t.row), 0),
    gridFields.reduce((a, f) => Math.max(a, f.row), 0),
    pushbuttons.filter(p => !p.isBottomBar).reduce((a, p) => Math.max(a, p.row), 0),
    boxes.reduce((a, b) => Math.max(a, b.row + Math.max(1, b.rows) - 1), 0),
    images.reduce((a, i) => Math.max(a, i.row + Math.max(1, i.rows) - 1), 0),
    previews.reduce((a, p) => Math.max(a, p.row + Math.max(1, p.rows) - 1), 0)
  );
  const contentMaxCol = Math.max(
    texts.reduce((a, t) => Math.max(a, t.col + Math.max(0, (t.content?.length ?? 0) - 1)), 0),
    gridFields.reduce((a, f) => {
      const extra = (f.values && f.values.length > 0) ? 2 : 0; // dropdowns take +2 columns
      return Math.max(a, f.col + Math.max(1, f.len + extra) - 1);
    }, 0),
    pushbuttons.filter(p => !p.isBottomBar).reduce((a, p) => {
      const labelLen = (p.label?.length ?? 0);
      const extra = p.kind === 'select' ? 4 : 3; // button padding vs radio/checkbox control + gap
      const span = Math.max(1, (p.kind === 'select' ? labelLen + extra : labelLen + extra));
      return Math.max(a, p.col + span - 1);
    }, 0),
    boxes.reduce((a, b) => Math.max(a, b.col + Math.max(1, b.cols) - 1), 0),
    images.reduce((a, i) => Math.max(a, i.col + Math.max(1, i.cols) - 1), 0),
    previews.reduce((a, p) => Math.max(a, p.col + Math.max(1, p.cols) - 1), 0)
  );
  const maxRow = contentMaxRow > 0 ? contentMaxRow : 1;
  const maxCol = contentMaxCol > 0 ? contentMaxCol : 1;

  const rows = requestedRows && requestedRows > 0 ? requestedRows : maxRow;
  const cols = requestedCols && requestedCols > 0 ? requestedCols : maxCol;

  // Normalize: sort tabs by id and de-dup lists
  const uniqueNums = (arr: number[]) => Array.from(new Set(arr.filter(n => Number.isFinite(n))));
  const sortedTabs = tabs.length ? tabs.sort((a, b) => a.id - b.id) : undefined;
  if (sortedTabs) {
    Object.keys(tabTexts).forEach(k => { tabTexts[Number(k)] = uniqueNums(tabTexts[Number(k)]); });
    Object.keys(tabFields).forEach(k => { tabFields[Number(k)] = uniqueNums(tabFields[Number(k)]); });
    Object.keys(tabPushButtons).forEach(k => { tabPushButtons[Number(k)] = uniqueNums(tabPushButtons[Number(k)]); });
    Object.keys(tabImages).forEach(k => { tabImages[Number(k)] = uniqueNums(tabImages[Number(k)]); });
    Object.keys(tabPreviews).forEach(k => { tabPreviews[Number(k)] = uniqueNums(tabPreviews[Number(k)]); });
  }

  return { title, rows, cols, portRows: requestedRows, portCols: requestedCols, winstyle, revision, texts, fields, pushbuttons, boxes, images, previews, triggers, tabOrder, tabs: sortedTabs, tabTexts: sortedTabs ? tabTexts : undefined, tabFields: sortedTabs ? tabFields : undefined, tabPushButtons: sortedTabs ? tabPushButtons : undefined, tabImages: sortedTabs ? tabImages : undefined, tabPreviews: sortedTabs ? tabPreviews : undefined };
}

// Translation support: load system/programs64/userprompt1.xml and resolve VXID keys
let vxidCache: Record<string, string> | null = null;
function loadTranslations(): Record<string, string> {
  if (vxidCache) return vxidCache;
  try {
    const wf = getRepoRootFolder();
    if (!wf) { vxidCache = {}; return vxidCache; }
    const filePath = path.join(wf.uri.fsPath, 'system', 'programs64', 'userprompt1.xml');
    if (!fs.existsSync(filePath)) { vxidCache = {}; return vxidCache; }
    const xml = fs.readFileSync(filePath, 'utf8');
    vxidCache = parseUserpromptXml(xml);
    return vxidCache;
  } catch {
    vxidCache = {};
    return vxidCache;
  }
}

// Determine the repo root (parent folder of this extension workspace folder),
// matching the logic used by translations and image lookup.
function getRepoRootFolder(): vscode.WorkspaceFolder | undefined {
  const wf0 = vscode.workspace.workspaceFolders?.[0];
  if (!wf0) return undefined;
  const parts = wf0.uri.fsPath.split(path.sep);
  if (parts.length > 1) parts.pop();
  return { uri: vscode.Uri.file(parts.join(path.sep)), name: wf0.name, index: wf0.index } as vscode.WorkspaceFolder;
}

// Resolve an image file name to a webview-safe URI string, searching
// <root>/custom/forms/images and then <root>/system/forms/images
function resolveImageSrc(webview: vscode.Webview, fileName: string): string | undefined {
  try {
    if (!customImg || !systemImg) return undefined;
    const cacheKey = fileName.toLowerCase();
    let found: string | undefined;
    if (imagePathCache.has(cacheKey)) {
      found = imagePathCache.get(cacheKey);
    } else {
      const candidates = [
        path.join(customImg.fsPath, fileName),
        path.join(systemImg.fsPath, fileName)
      ];
      found = candidates.find(p => fs.existsSync(p));
      imagePathCache.set(cacheKey, found);
    }
    if (!found) return undefined;
    const uri = webview.asWebviewUri(vscode.Uri.file(found));
    return uri.toString();
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Field values: dropdown entries written as "path:<name>" refer to a values
// file. The preview expands them; the .frm text is never changed.
// ---------------------------------------------------------------------------

const FIELD_VALUES_PREFIX = 'path:';

/** One dropdown option as shown in the preview. */
interface DropdownOption {
  label: string; // text shown in the dropdown
  title?: string; // tooltip (real value, or why the option is a placeholder)
  kind?: 'missing' | 'database'; // set for placeholder options
}

type FieldValuesResolution =
  | { kind: 'values'; name: string; file: string; options: DropdownOption[] }
  | { kind: 'database'; name: string; file: string }
  | { kind: 'missing'; name: string };

/** The custom and system forms folders: <custom>/forms, then <root>/system/forms. */
function getFormsDirs(): { custom: string; system: string } | undefined {
  const repoRoot = getRepoRootFolder();
  if (!repoRoot) return undefined;
  const custom = vscode.workspace.workspaceFolders?.find(wf => wf.name.toLowerCase().startsWith('custom'));
  return {
    custom: custom ? path.join(custom.uri.fsPath, 'forms') : path.join(repoRoot.uri.fsPath, 'custom', 'forms'),
    system: path.join(repoRoot.uri.fsPath, 'system', 'forms')
  };
}

/** Find a file in dir whose name matches name ignoring case. */
function findFileIgnoreCase(dir: string, name: string): string | undefined {
  try {
    const wanted = name.toLowerCase();
    const hit = fs.readdirSync(dir, { withFileTypes: true }).find(e => e.isFile() && e.name.toLowerCase() === wanted);
    return hit ? path.join(dir, hit.name) : undefined;
  } catch {
    return undefined;
  }
}

/** Split "Description [realvalue]*" into its shown text and real value. */
function parseDropdownValue(raw: string): DropdownOption {
  const m = raw.match(/^(.*?)\s*\[([^\]]*)\]\*\s*$/);
  return m ? { label: m[1], title: m[2] } : { label: raw };
}

/** The values file for name, read from disk only the first time (until a watcher clears it). */
function resolveFieldValues(name: string): FieldValuesResolution {
  const cacheKey = name.toLowerCase();
  let r = fieldValuesCache.get(cacheKey);
  if (!r) {
    r = readFieldValues(name);
    fieldValuesCache.set(cacheKey, r);
  }
  return r;
}

/** Look up and read the values file for name: custom before system, fieldvalues/ before forms/. */
function readFieldValues(name: string): FieldValuesResolution {
  const dirs = getFormsDirs();
  if (!dirs) return { kind: 'missing', name };
  const searchDirs = [
    path.join(dirs.custom, 'fieldvalues'),
    dirs.custom,
    path.join(dirs.system, 'fieldvalues'),
    dirs.system
  ];
  for (const dir of searchDirs) {
    const file = findFileIgnoreCase(dir, name);
    if (!file) continue;
    let text: string;
    try {
      text = fs.readFileSync(file, 'utf8').replace(/^﻿/, '');
    } catch {
      continue;
    }
    const lines = text.split(/\r?\n/);
    // Format files (#SETUP# / #FORMAT#) describe a list Vertex builds from a database at runtime
    if (lines.some(l => /^#(SETUP|FORMAT|HEADERFORMAT)#/i.test(l.trim()))) {
      return { kind: 'database', name, file };
    }
    const options = lines
      .map(l => l.trimEnd())
      .filter(l => l.trim() !== '' && !l.trimStart().startsWith('!') && !/^\s*charset\s*=/i.test(l))
      .map(parseDropdownValue);
    return { kind: 'values', name, file, options };
  }
  return { kind: 'missing', name };
}

/** The name in a "path:<name>" value, or undefined for a literal value. */
function fieldValuesName(value: string): string | undefined {
  const v = value.trim();
  return v.toLowerCase().startsWith(FIELD_VALUES_PREFIX) ? v.slice(FIELD_VALUES_PREFIX.length).trim() : undefined;
}

/** A path relative to the repo root, with forward slashes, for display. */
function displayPath(file: string): string {
  const repoRoot = getRepoRootFolder();
  const rel = repoRoot ? path.relative(repoRoot.uri.fsPath, file) : file;
  return rel.split(path.sep).join('/');
}

/** Turn a field's raw values into dropdown options, expanding each "path:<name>" where it sits. */
function expandDropdownValues(values: string[]): DropdownOption[] {
  const out: DropdownOption[] = [];
  for (const v of values) {
    const name = fieldValuesName(v);
    if (name === undefined) {
      out.push(parseDropdownValue(v));
      continue;
    }
    const r = resolveFieldValues(name);
    if (r.kind === 'values') {
      out.push(...r.options);
    } else if (r.kind === 'database') {
      out.push({ label: `‹database list: ${name}›`, title: `Values are built from the database at runtime (${displayPath(r.file)})`, kind: 'database' });
    } else {
      out.push({ label: v, title: 'fieldvalues file not found', kind: 'missing' });
    }
  }
  return out;
}

/** Short description of each "path:<name>" for the field dialog's hint. */
function describeFieldValues(names: string[]): string[] {
  return names.map(name => {
    const r = resolveFieldValues(name);
    const ref = `${FIELD_VALUES_PREFIX}${name}`;
    if (r.kind === 'values') return `${ref} → ${r.options.length} value${r.options.length === 1 ? '' : 's'} from ${displayPath(r.file)}`;
    if (r.kind === 'database') return `${ref} → database list (${displayPath(r.file)})`;
    return `${ref} → fieldvalues file not found`;
  });
}

/** Trigger program names, scanned from disk only the first time (until a watcher clears it). */
function getAvailableTriggerPrograms(): string[] {
  if (!triggerProgramsCache) triggerProgramsCache = scanTriggerPrograms();
  return triggerProgramsCache;
}

/** The custom*\/macros/triggers and system/macros/triggers folders of the open workspace folders. */
function getTriggerDirs(): string[] {
  return (vscode.workspace.workspaceFolders ?? [])
    .filter(f => f.name.toLowerCase().startsWith('custom') || f.name.toLowerCase() === 'system')
    .map(f => path.join(f.uri.fsPath, 'macros', 'triggers'));
}

// ---------------------------------------------------------------------------
// Disk lookup caches. Rendering reads values files, image paths and the trigger
// list from these instead of the disk. Shared, non-recursive watchers on the
// folders they come from clear the affected entries and refresh only the
// previews that use them, so saving an .frm file or other changes under
// forms/ no longer re-render every preview.
// ---------------------------------------------------------------------------

/** "path:<name>" resolutions by lower-case name. */
const fieldValuesCache = new Map<string, FieldValuesResolution>();
/** Found image path (undefined when missing) by lower-case file name. */
const imagePathCache = new Map<string, string | undefined>();
/** Trigger program names; undefined until scanned. */
let triggerProgramsCache: string[] | undefined;
/** Lower-case values file names and image names each preview's last render used, by document. */
const usedAssetsByDoc = new Map<string, { fieldValues: Set<string>; images: Set<string> }>();
let assetWatchers: vscode.Disposable[] = [];
const assetRefreshKeys = new Set<string>();
let assetRefreshTimer: ReturnType<typeof setTimeout> | undefined;

function clearAssetCaches(): void {
  fieldValuesCache.clear();
  imagePathCache.clear();
  triggerProgramsCache = undefined;
}

/** Remember which values files and images a preview shows, so only changes to those refresh it. */
function recordUsedAssets(key: string, model: FrmModel): void {
  const fieldValues = new Set<string>();
  for (const f of model.fields) {
    for (const v of f.values) {
      const name = fieldValuesName(v);
      if (name !== undefined) fieldValues.add(name.toLowerCase());
    }
  }
  const images = new Set((model.images || []).map(img => img.file.toLowerCase()));
  usedAssetsByDoc.set(key, { fieldValues, images });
}

/** Re-render the previews matching pick once file events settle. */
function queueAssetRefresh(pick: (used: { fieldValues: Set<string>; images: Set<string> }) => boolean): void {
  for (const [key, used] of usedAssetsByDoc) {
    if (pick(used)) assetRefreshKeys.add(key);
  }
  if (!assetRefreshKeys.size) return;
  if (assetRefreshTimer) clearTimeout(assetRefreshTimer);
  assetRefreshTimer = setTimeout(() => {
    assetRefreshTimer = undefined;
    const keys = [...assetRefreshKeys];
    assetRefreshKeys.clear();
    for (const key of keys) {
      const panel = panelByDoc.get(key);
      const doc = vscode.workspace.textDocuments.find(d => d.uri.toString() === key);
      if (panel && doc) updateWebview(panel, doc);
    }
  }, REFRESH_DELAY_MS);
}

/** Watch the files previews read, once for all previews. Each watcher covers one folder, not its subfolders. */
function startAssetWatchers(): void {
  if (assetWatchers.length) return;
  const watch = (dir: string, onEvent: (uri: vscode.Uri) => void, contentChanges: boolean) => {
    const w = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(vscode.Uri.file(dir), '*'), false, !contentChanges, false);
    w.onDidCreate(onEvent);
    w.onDidDelete(onEvent);
    if (contentChanges) w.onDidChange(onEvent);
    assetWatchers.push(w);
  };
  const baseName = (uri: vscode.Uri) => path.basename(uri.fsPath).toLowerCase();

  const formsDirs = getFormsDirs();
  if (formsDirs) {
    for (const forms of [formsDirs.custom, formsDirs.system]) {
      // Values files sit in forms/fieldvalues/ or forms/ itself
      const onValuesFile = (uri: vscode.Uri) => {
        const name = baseName(uri);
        if (name === 'fieldvalues' || name === 'images') {
          // A whole folder appeared or went away: forget everything it could hold and watch it anew
          clearAssetCaches();
          queueAssetRefresh(() => true);
          setTimeout(restartAssetWatchers, 0);
          return;
        }
        if (!fieldValuesCache.delete(name)) return;
        queueAssetRefresh(used => used.fieldValues.has(name));
      };
      watch(forms, onValuesFile, true);
      watch(path.join(forms, 'fieldvalues'), onValuesFile, true);
      // Only whether an image exists is cached; its URL stays the same when its content changes
      watch(path.join(forms, 'images'), uri => {
        const name = baseName(uri);
        imagePathCache.delete(name);
        queueAssetRefresh(used => used.images.has(name));
      }, false);
    }
  }

  for (const dir of getTriggerDirs()) {
    watch(dir, uri => {
      if (!baseName(uri).endsWith('.prg')) return;
      triggerProgramsCache = undefined;
      queueAssetRefresh(() => true); // every page lists the trigger programs
    }, false);
  }
}

/** Stop watching (no previews left, or the extension is shutting down) and drop queued refreshes. */
function stopAssetWatchers(): void {
  assetWatchers.forEach(w => w.dispose());
  assetWatchers = [];
  if (assetRefreshTimer) clearTimeout(assetRefreshTimer);
  assetRefreshTimer = undefined;
  assetRefreshKeys.clear();
}

/** Watch the folders anew (one was created or removed, or the workspace folders changed); queued refreshes still run. */
function restartAssetWatchers(): void {
  assetWatchers.forEach(w => w.dispose());
  assetWatchers = [];
  if (panelByDoc.size > 0) startAssetWatchers();
}

// Get list of available trigger programs from custom*/macros/triggers/ and system/macros/triggers/
function scanTriggerPrograms(): string[] {
  try {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders) return [];
    
    const programs = new Set<string>();
    
    // Search all workspace folders
    for (const folder of workspaceFolders) {
      const folderName = folder.name.toLowerCase();
      
      // Check if this is a "custom" folder (starts with "custom")
      if (folderName.startsWith('custom')) {
        const triggersPath = path.join(folder.uri.fsPath, 'macros', 'triggers');
        if (fs.existsSync(triggersPath)) {
          const files = fs.readdirSync(triggersPath);
          files.filter(f => f.endsWith('.prg')).forEach(f => programs.add(f));
        }
      }
      
      // Check if this is the "system" folder
      if (folderName === 'system') {
        const triggersPath = path.join(folder.uri.fsPath, 'macros', 'triggers');
        if (fs.existsSync(triggersPath)) {
          const files = fs.readdirSync(triggersPath);
          files.filter(f => f.endsWith('.prg')).forEach(f => programs.add(f));
        }
      }
    }
    
    // Convert set to sorted array
    return Array.from(programs).sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
  } catch (error) {
    console.error('Error scanning trigger programs:', error);
    return [];
  }
}

// Create a new trigger program file with stub content
async function createTriggerProgramFile(programName: string, openAfterCreate: boolean = false): Promise<boolean> {
  try {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders) {
      vscode.window.showErrorMessage('No workspace folder found');
      return false;
    }
    
    // Find the first "custom" folder (starts with "custom")
    let customFolder = workspaceFolders.find(f => f.name.toLowerCase().startsWith('custom'));
    if (!customFolder) {
      vscode.window.showErrorMessage('No custom workspace folder found');
      return false;
    }
    
    // Ensure program name ends with .prg
    if (!programName.toLowerCase().endsWith('.prg')) {
      programName += '.prg';
    }
    
    const triggersPath = path.join(customFolder.uri.fsPath, 'macros', 'triggers');
    const filePath = path.join(triggersPath, programName);
    
    // Check if file already exists
    if (fs.existsSync(filePath)) {
      const choice = await vscode.window.showWarningMessage(
        `File ${programName} already exists. Do you want to open it?`,
        'Open', 'Cancel'
      );
      if (choice === 'Open' && openAfterCreate) {
        const doc = await vscode.workspace.openTextDocument(filePath);
        await vscode.window.showTextDocument(doc);
      }
      return true;
    }
    
    // Ensure the triggers directory exists
    const madeTriggersDir = !fs.existsSync(triggersPath);
    if (madeTriggersDir) {
      fs.mkdirSync(triggersPath, { recursive: true });
    }
    
    // Generate stub content with current date
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    
    const stubContent = `!***********************************************************************
! Stub autocreated by VxFormEditor - Emil TTM ${year}-${month}-${day}
!
!***********************************************************************
`;
    
    // Write the file
    fs.writeFileSync(filePath, stubContent, 'utf8');
    // List the new program right away instead of waiting for the folder watcher (which can't see a folder made just now)
    triggerProgramsCache = undefined;
    if (madeTriggersDir && assetWatchers.length) restartAssetWatchers();

    vscode.window.showInformationMessage(`Created trigger program: ${programName}`);
    
    // Open the file if requested
    if (openAfterCreate) {
      const doc = await vscode.workspace.openTextDocument(filePath);
      await vscode.window.showTextDocument(doc);
    }
    
    return true;
  } catch (error) {
    vscode.window.showErrorMessage(`Error creating trigger program: ${error}`);
    return false;
  }
}

function parseUserpromptXml(xml: string): Record<string, string> {
  const map: Record<string, string> = {};
  const re = /<VXID\b([^>]*)\/>/gim;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    const attrs = m[1] || '';
    const k = /\bkey\s*=\s*"([^"]*)"/i.exec(attrs)?.[1];
    const v = /\bvalue\s*=\s*"([^"]*)"/i.exec(attrs)?.[1];
    if (k && typeof v === 'string') {
      map[k.trim()] = v;
    }
  }
  return map;
}

function translateVXID(key: string): string {
  const dict = loadTranslations();
  return dict[key] ?? key;
}

function normalizeBraceText(expr: string): string {
  // Split on '+'; quoted segments are literals, unquoted are VXID keys to translate
  return expr
    .split('+')
    .map(part => {
      const t = part.trim();
      const qm = t.match(/^"(.*)"$/);
      if (qm) return qm[1]; // literal
      // treat as translation key (e.g., {SOME_KEY})
      return translateVXID(t);
    })
    .join('');
}

// Boxed text is drawn this many columns right of the box's corner. Preview only: the file keeps the
// original column, and the page subtracts it again when turning a drop position into a column.
const BOX_LABEL_OFFSET = 2;

// Parse and remove any box directives from concatenated text content.
// Format: #[rows,columns]* where rows and columns are positive integers.
function extractBoxesFromContent(content: string, startRow: number, startCol: number): { cleaned: string; boxes: FrmBox[] } | null {
  const re = /#\s*\[\s*(\d+)\s*,\s*(\d+)\s*\]\s*\*/g;
  let m: RegExpExecArray | null;
  let any = false;
  const found: FrmBox[] = [];
  // Compute a cleaned version to measure visible label length
  const cleanedPreview = content.replace(re, '').replace(/\s+$/, '');
  const labelLen = (cleanedPreview.trim()).length; // approx. character span of label
  // Box positioning: text will be positioned normally, box draws around it
  while ((m = re.exec(content))) {
    const rows = Number(m[1]);
    const cols = Number(m[2]);
    if (Number.isFinite(rows) && Number.isFinite(cols) && rows > 0 && cols > 0) {
      // Create box at the same position as the text, with gap for the label
      // Label is drawn BOX_LABEL_OFFSET columns in from the corner; the gap gets 1 column of padding each side
      found.push({ row: startRow, col: startCol, rows, cols, gapStart: BOX_LABEL_OFFSET, gapSpan: Math.max(0, labelLen) + 2 });
      any = true;
    }
  }
  if (!any) return null;
  // Remove the directives from the visible text
  const cleaned = cleanedPreview;
  return { cleaned, boxes: found };
}

/** Values the page script reads (media/preview.js); everything else it needs is in the markup. */
interface PreviewData {
  winstyle: string;
  tabOrder: number[];
  initialZoom: number;
  initialGridOn: boolean;
  initialActiveTab: number | null;
  tabs: { id: number; label: string }[];
  tabTexts: Record<number, number[]>;
  tabFields: Record<number, number[]>;
  tabPushButtons: Record<number, number[]>;
  tabImages: Record<number, number[]>;
  tabPreviews: Record<number, number[]>;
  rows: number;
  cols: number;
  portRows: number;
  portCols: number;
  boxOffset: number;
}

interface PreviewOptions {
  initialZoom: number;
  initialActiveTab?: number;
  initialGridOn?: boolean;
  availableTriggerPrograms: string[];
  showZoomControls: boolean;
  unindexed: { texts: number; buttons: number };
}

/** One render of the form: the page body's markup and the data its script runs with. */
interface PreviewParts {
  body: string;
  data: PreviewData;
}

/**
 * Render the form. The styles and script are static files (media/preview.css, media/preview.js),
 * so a refresh only sends this body and data; the page patches its body to match.
 */
function renderPreview(model: FrmModel, opts: PreviewOptions): PreviewParts {
  const { initialZoom, initialActiveTab, initialGridOn, availableTriggerPrograms, showZoomControls, unindexed } = opts;
  const unindexedMsg = unindexed.texts + unindexed.buttons > 0 ? unindexedMessage(unindexed) : null;

  const texts = model.texts.map(t => {
    // Initial guess; the page measures the rendered text and tightens it (fitTextSpans)
    const span = Math.max(1, t.content?.length ?? 1);
    const dataIdx = t.index != null ? ` data-text-idx="${t.index}"` : ' data-unindexed="1"';
    // Find associated box for this text element to store box dimensions
    const associatedBox = model.boxes.find(b => b.row === t.row && b.col === t.col);
    const boxData = associatedBox ? ` data-box-rows="${associatedBox.rows}" data-box-cols="${associatedBox.cols}" data-col-offset="${BOX_LABEL_OFFSET}"` : '';
    const drawCol = t.col + (associatedBox ? BOX_LABEL_OFFSET : 0);
    return `<div class="text draggable"${dataIdx}${boxData} draggable="true" data-type="text" data-row="${t.row}" data-col="${t.col}" style="grid-row:${t.row}; grid-column:${drawCol} / span ${span};">
      <div class="insertion-point" title="Insertion Point"></div>
      <div class="delete-button" title="Delete">×</div>
      ${escapeHtml(t.content || '')}
    </div>`;
  }).join('\n');

  const boxesHtml = (model.boxes || []).map(b => {
    const rspan = Math.max(1, b.rows + 1);
    const cspan = Math.max(1, b.cols);
    //check if b.gapstart exists and if so, make new variable that is b.gapstart - 1
    const gapStart = b.gapStart != null ? b.gapStart - 1 : undefined;
    const gs = Math.max(0, Math.min(cspan, (gapStart ?? 0)));
    const gw = Math.max(0, Math.min(cspan - gs, (b.gapSpan ?? 0)));
    const leftSegW = Math.max(0, gs);
    const rightSegL = Math.max(0, Math.min(cspan, gs + gw));
    const inset = 'calc(var(--col-w) / 2)';
    const parts: string[] = [];

    // Left segment on top line: allow width to apply (unset right)
    if (leftSegW > 0) {
      parts.push(`<div class="hrow top gap-left" style="left:${inset}; right:auto; width: calc(${leftSegW} * var(--col-w));"></div>`);
    }
    // Right segment on top line: pin right inset, no width needed. Emitted even when the character
    // estimate fills the box, since the page re-places it from the measured label width (fitBoxGaps)
    if (rightSegL < cspan || gw > 0) {
      parts.push(`<div class="hrow top gap-right" style="left: calc(${rightSegL} * var(--col-w)); right: ${inset};"></div>`);
    }
    // Bottom full-width line, inset to column centers on both sides
    parts.push(`<div class="hrow bottom" style="left:${inset}; right:${inset};"></div>`);

    // Vertical sides
    parts.push(`<div class="vline left"></div>`);
    parts.push(`<div class="vline right"></div>`);

    // A box belonging to an indexed text gets stretch handles (its size lives in that text's #[rows,cols]*)
    const owner = model.texts.find(t => t.row === b.row && t.col === b.col && t.index != null);
    const stretch = owner ? ` data-text-idx="${owner.index}"` : '';
    const handles = owner ? boxResizeHandles() : '';

    return `<div class="box${owner ? ' stretchable' : ''}"${stretch} data-row="${b.row}" data-col="${b.col}" style="grid-row:${b.row} / span ${rspan}; grid-column:${b.col} / span ${cspan};">${parts.join('')}${handles}</div>`;
  }).join('\n');

  const hiddenFields = model.fields.filter(f => isHiddenFieldPosition(f.row, f.col));

  const fields = model.fields.filter(f => !isHiddenFieldPosition(f.row, f.col)).map(f => {
    const isDropdown = f.values.length > 0;
    const control = isDropdown
      ? `<select ${f.locked ? 'disabled' : ''}>
          <option value="" disabled selected>${escapeHtml(prettyName(f.name))}</option>
          ${expandDropdownValues(f.values).map(o => `<option${o.kind ? ` class="fv-${o.kind}"` : ''}${o.title ? ` title="${escapeAttr(o.title)}"` : ''}>${escapeHtml(o.label)}</option>`).join('')}
        </select>`
      : `<input type="text" ${f.locked ? 'disabled' : ''} placeholder="${escapeHtml(prettyName(f.name))}">`;
    const cls = `field draggable${f.locked ? ' locked' : ''}${isDropdown ? ' dropdown' : ''}${f.rightAlign ? ' right-align' : ''}${f.centerAlign ? ' center-align' : ''}${f.transparent ? ' transparent' : ''}`;
    const span = Math.max(1, f.len + (f.values.length > 0 ? 2 : 0));
    // Use field index if available, otherwise use position-based index (0-based)
    const fieldIdx = f.index != null ? f.index : model.fields.indexOf(f);
    const dataIdx = ` data-field-idx="${fieldIdx}"${f.index == null ? ' data-no-index="1"' : ''}`;
    const typeExpr = (f.typeExpr ?? '').trim() || String(f.type);
    const dataValues = f.values.length > 0 ? ` data-field-values="${escapeAttr(JSON.stringify(f.values))}"` : '';
    const dataNameFormat = f.nameFormat ? ` data-field-nameformat="${escapeAttr(JSON.stringify(f.nameFormat))}"` : '';
    return `<div class="${cls}"${dataIdx} draggable="true" data-type="field" data-row="${f.row}" data-col="${f.col}" data-field-name="${escapeAttr(f.name)}" data-field-type="${escapeAttr(typeExpr)}" data-field-len="${f.len}" data-field-extra="${isDropdown ? 2 : 0}"${dataValues}${dataNameFormat} style="grid-row:${f.row}; grid-column:${f.col} / span ${span};">
      <div class="insertion-point" title="Insertion Point"></div>
      <div class="delete-button" title="Delete">×</div>
      ${control}
      ${f.index != null ? elementResizeHandles(['w', 'e']) : ''}
    </div>`;
  }).join('\n');

  // Split pushbuttons into regular (in-grid) and bottom bar buttons
  const regularButtons = (model.pushbuttons || []).filter(pb => !pb.isBottomBar);
  const bottomBarButtons = (model.pushbuttons || []).filter(pb => pb.isBottomBar);
  
  const push = regularButtons.map(pb => {
    const dataIdx = pb.index != null ? ` data-push-idx="${pb.index}" data-pb-idx="${pb.index}"` : ' data-unindexed="1"';
    const dataKind = ` data-pb-kind="${pb.kind}"`;
    const dataName = pb.name ? ` data-pb-name="${escapeAttr(pb.name)}"` : '';
    const dataValue = pb.value ? ` data-pb-value="${escapeAttr(pb.value)}"` : '';
    const dataProgram = pb.program ? ` data-pb-program="${escapeAttr(pb.program)}"` : '';
    const dataAction = pb.action ? ` data-pb-action="${pb.action}"` : '';
    const attrs = `${dataIdx}${dataKind}${dataName}${dataValue}${dataProgram}${dataAction}`;
    const span = (() => {
      const len = (pb.label?.length ?? 0);
      if (pb.kind === 'select') return Math.max(4, len + 4);
      return Math.max(3, len + 3);
    })();
    if (pb.kind === 'radio') {
      const nm = pb.name ? ` name="${escapeAttr(pb.name)}"` : '';
      const valueAttr = pb.value ? ` value="${escapeAttr(pb.value)}"` : '';
      return `<div class="push radio draggable"${attrs} draggable="true" data-type="pushbutton" data-row="${pb.row}" data-col="${pb.col}" style="grid-row:${pb.row}; grid-column:${pb.col} / span ${span};">\n        <div class="insertion-point" title="Insertion Point"></div>\n        <div class="delete-button" title="Delete">×</div>\n        <input type="radio"${nm}${valueAttr} />\n        <span class="label">${escapeHtml(pb.label)}</span>\n      </div>`;
    } else if (pb.kind === 'checkbox') {
      const nm = pb.name ? ` name="${escapeAttr(pb.name)}"` : '';
      const valueAttr = pb.value ? ` value="${escapeAttr(pb.value)}"` : '';
      return `<div class="push checkbox draggable"${attrs} draggable="true" data-type="pushbutton" data-row="${pb.row}" data-col="${pb.col}" style="grid-row:${pb.row}; grid-column:${pb.col} / span ${span};">\n        <div class="insertion-point" title="Insertion Point"></div>\n        <div class="delete-button" title="Delete">×</div>\n        <input type="checkbox"${nm}${valueAttr} />\n        <span class="label">${escapeHtml(pb.label)}</span>\n      </div>`;
    }
    // select button
    return `<div class="push select draggable"${attrs} draggable="true" data-type="pushbutton" data-row="${pb.row}" data-col="${pb.col}" style="grid-row:${pb.row}; grid-column:${pb.col} / span ${span};">\n      <div class="insertion-point" title="Insertion Point"></div>\n      <div class="delete-button" title="Delete">×</div>\n      <button class="btn">${escapeHtml(pb.label)}</button>\n    </div>`;
  }).join('\n');
  
  // Render bottom bar buttons
  const bottomBarHtml = bottomBarButtons.length > 0 ? bottomBarButtons.map(pb => {
    const dataIdx = pb.index != null ? ` data-push-idx="${pb.index}" data-pb-idx="${pb.index}"` : ' data-unindexed="1"';
    const dataKind = ` data-pb-kind="${pb.kind}"`;
    const dataName = pb.name ? ` data-pb-name="${escapeAttr(pb.name)}"` : '';
    const dataValue = pb.value ? ` data-pb-value="${escapeAttr(pb.value)}"` : '';
    const dataProgram = pb.program ? ` data-pb-program="${escapeAttr(pb.program)}"` : '';
    const dataAction = pb.action ? ` data-pb-action="${pb.action}"` : '';
    const attrs = `${dataIdx}${dataKind}${dataName}${dataValue}${dataProgram}${dataAction}`;
    const dataBottomBarRow = pb.bottomBarRow != null ? ` data-bottombar-row="${pb.bottomBarRow}"` : '';
    
    if (pb.kind === 'radio') {
      const nm = pb.name ? ` name="${escapeAttr(pb.name)}"` : '';
      const valueAttr = pb.value ? ` value="${escapeAttr(pb.value)}"` : '';
      return `<div class="bottom-bar-button radio"${attrs}${dataBottomBarRow} data-type="pushbutton" data-row="${pb.row}" data-col="${pb.col}">
        <input type="radio"${nm}${valueAttr} />
        <span class="label">${escapeHtml(pb.label)}</span>
      </div>`;
    } else if (pb.kind === 'checkbox') {
      const nm = pb.name ? ` name="${escapeAttr(pb.name)}"` : '';
      const valueAttr = pb.value ? ` value="${escapeAttr(pb.value)}"` : '';
      return `<div class="bottom-bar-button checkbox"${attrs}${dataBottomBarRow} data-type="pushbutton" data-row="${pb.row}" data-col="${pb.col}">
        <input type="checkbox"${nm}${valueAttr} />
        <span class="label">${escapeHtml(pb.label)}</span>
      </div>`;
    }
    // select button
    return `<div class="bottom-bar-button select"${attrs}${dataBottomBarRow} data-type="pushbutton" data-row="${pb.row}" data-col="${pb.col}">
      <button class="btn">${escapeHtml(pb.label)}</button>
    </div>`;
  }).join('\n') : '';

  const triggersHtml = (model.triggers || []).map((t, idx) => {
    // Show field name if target is a numeric field index
    let targetDisplay = escapeHtml(t.target);
    const targetNum = Number(t.target);
    if (Number.isFinite(targetNum) && !isNaN(targetNum)) {
      const field = model.fields.find(f => f.index === targetNum);
      if (field) {
        targetDisplay = `${escapeHtml(t.target)} - ${escapeHtml(field.name)}`;
      }
    }
    return `
    <div class="trigger-item" data-trigger-idx="${idx}" data-trigger-line="${t.line}" data-trigger-target="${escapeAttr(t.target)}" data-trigger-program="${escapeAttr(t.program)}">
      <div class="trigger-target">→ ${targetDisplay}</div>
      <div class="trigger-program">${escapeHtml(t.program)} ${escapeHtml(t.flag)}</div>
      <div class="trigger-actions">
        <button class="trigger-action-btn edit" onclick="editTrigger(${idx}, ${t.line}, '${escapeAttr(t.target)}', '${escapeAttr(t.program)}', '${escapeAttr(t.flag)}')" title="Edit">✏️</button>
        <button class="trigger-action-btn delete" onclick="deleteTrigger(${idx}, ${t.line}, '${escapeAttr(t.target)}', '${escapeAttr(t.program)}', '${escapeAttr(t.flag)}')" title="Delete">×</button>
      </div>
    </div>
  `;
  }).join('');

  const hiddenFieldsHtml = hiddenFields.map(f => {
    const fieldIdx = f.index != null ? f.index : model.fields.indexOf(f);
    // const typeExpr = (f.typeExpr ?? '').trim() || String(f.type);
    let hiddenReason = 'hidden';
    if (Number(f.row) === 1000 && Number(f.col) === 1000) {
      hiddenReason = 'row 1000 | col 1000';
    } else if (Number(f.row) === 1000) {
      hiddenReason = 'row 1000';
    } else if (Number(f.col) === 1000) {
      hiddenReason = 'col 1000';
    }
    // const valueSummary = f.values.length > 0 ? ` | values ${f.values.length}` : '';
    return `
    <div class="trigger-item hidden-field-item" draggable="true" data-type="field" data-field-idx="${fieldIdx}"${f.index == null ? ' data-no-index="1"' : ''} data-field-name="${escapeAttr(f.name)}" data-row="${f.row}" data-col="${f.col}" data-span="${Math.max(1, f.len + (f.values.length > 0 ? 2 : 0))}" onclick="showHiddenFieldInSource(${fieldIdx})" title="Drag onto the preview to unhide, or click to show in source">
      <div class="trigger-target">Field ${fieldIdx} - ${escapeHtml(f.name)}</div>
      <div class="trigger-actions">
        <button class="trigger-action-btn delete" onclick="deleteHiddenField(event, ${fieldIdx})" title="Delete">×</button>
      </div>
    </div>
  `;
  }).join('');

  const images = (model.images || []).map(img => {
    const spanR = Math.max(1, img.rows);
    const spanC = Math.max(1, img.cols);
    const dataIdx = img.index != null ? ` data-image-idx="${img.index}"` : '';
    const srcAttr = img.resolvedSrc ? ` src="${img.resolvedSrc}"` : '';
    const alt = escapeHtml(img.file || 'image');
    return `<div class="image draggable"${dataIdx} draggable="true" data-type="image" data-row="${img.row}" data-col="${img.col}" style="grid-row:${img.row} / span ${spanR}; grid-column:${img.col} / span ${spanC};">
      <div class="insertion-point" title="Insertion Point"></div>
      <div class="delete-button" title="Delete">×</div>
      <img${srcAttr} alt="${alt}" />
      ${img.index != null ? elementResizeHandles(['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw']) : ''}
    </div>`;
  }).join('\n');

  const previews = (model.previews || []).map(prev => {
    const spanR = Math.max(1, prev.rows);
    const spanC = Math.max(1, prev.cols);
    const dataIdx = prev.index != null ? ` data-preview-idx="${prev.index}"` : '';
    const modeExpr = (prev.modeExpr ?? '').trim() || String(prev.mode);
    return `<div class="preview draggable"${dataIdx} draggable="true" data-type="preview" data-row="${prev.row}" data-col="${prev.col}" data-preview-rows="${prev.rows}" data-preview-cols="${prev.cols}" data-preview-mode="${escapeAttr(modeExpr)}" data-preview-path="${escapeAttr(prev.path)}" data-preview-field="${escapeAttr(prev.field)}" data-preview-porttype="${escapeAttr(prev.portType)}" data-preview-portstyle="${escapeAttr(prev.portStyle || '')}" style="grid-row:${prev.row} / span ${spanR}; grid-column:${prev.col} / span ${spanC};">
      <div class="insertion-point" title="Insertion Point"></div>
      <div class="delete-button" title="Delete">×</div>
      <div class="preview-content">
        <div class="preview-icon">🖼</div>
        <div class="preview-label">${escapeHtml(prev.portType)}</div>
        <div class="preview-path">${escapeHtml(prev.path)}</div>
      </div>
      ${prev.index != null ? elementResizeHandles(['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw']) : ''}
    </div>`;
  }).join('\n');

  const body = `
    ${unindexedMsg ? `<div class="unindexed-strip">
      <span class="msg">${escapeHtml(unindexedMsg.title)}<span class="detail">${escapeHtml(unindexedMsg.detail)}</span></span>
      <button onclick="window.__frmVscodeApi && window.__frmVscodeApi.postMessage({ command: 'autoIndex' })">Auto-add indexes</button>
    </div>` : ''}
    <div class="window">
      <div class="titlebar">
        <div class="caption">
          <span class="title" title="Double-click to edit header">${escapeHtml(model.title)}</span>
        </div>
          <div class="zoom"${showZoomControls ? ' title="Scale preview"' : ''}>
            ${showZoomControls ? `
            <button class="ctrl" data-zoom="0.5">0.5x</button>
            <button class="ctrl" data-zoom="1">1x</button>
            <button class="ctrl" data-zoom="1.5">1.5x</button>
            <button class="ctrl" data-zoom="2">2x</button>
            <input id="zoomRange" type="range" min="0.5" max="10" step="0.1" value="1" />
            <span class="zoomLabel" id="zoomLabel">100%</span>
            ` : ''}
            <label class="ctrl" style="gap:6px; width:auto;">
              <input id="gridToggle" type="checkbox" /> Grid
            </label>
            <button id="tabOrderBtn" class="ctrl" style="gap:6px; width:auto;" title="Set tab order for fields">
              Tab Order
            </button>
            <button id="shortcutsBtn" class="ctrl" title="Keyboard shortcuts (?)">⌨</button>
          </div>
        <div class="controls">
          <button class="ctrl close" title="Close">✕</button>
        </div>
      </div>
      <div class="content">
        ${model.tabs && model.tabs.length ? `
        <div class="tabs" id="tabs">
          ${model.tabs.map((t,i) => `<div class="tab${i===0?' active':''}" data-tab-id="${t.id}" title="${escapeHtml(t.label)}">${escapeHtml(t.label.replace(/_/g, ' '))}</div>`).join('')}
        </div>` : ''}
        <div class="main-container">
          <div class="form-area">
            <div class="grid-frame" id="gridFrame">
            <div class="grid gridlines" style="grid-template-columns: repeat(${model.cols}, var(--col-w)); grid-template-rows: repeat(${model.rows}, var(--row-h)); width: calc(${model.cols} * var(--col-w) + ${(model.cols - 1)} * var(--col-gap)); height: calc(${model.rows} * var(--row-h) + ${(model.rows - 1)} * var(--row-gap));">
              <div id="gridCellHighlight" class="grid-cell-highlight hidden"></div>
              <div id="dropTargetOutline" class="drop-target-outline hidden"></div>
              ${boxesHtml}
              ${texts}
              ${fields}
              ${push}
              ${images}
              ${previews}
            </div>
              <div class="resize-handle e" data-resize="e" title="Drag to change width (port_size cols). Right-click to set to auto."></div>
              <div class="resize-handle s" data-resize="s" title="Drag to change height (port_size rows). Right-click to set to auto."></div>
              <div class="resize-handle se" data-resize="se" title="Drag to change port_size. Right-click to set to auto."></div>
              <div id="resizeSizeLabel" class="resize-size-label hidden"></div>
              <div id="elResizeLabel" class="resize-size-label el-resize-label hidden"></div>
            </div>
            ${bottomBarHtml ? `
            <div class="bottom-bar">
              ${bottomBarHtml}
            </div>
            ` : ''}
          </div>
          <div class="side-panels">
            <div class="triggers-panel">
              <h4>
                Triggers
                <button class="add-trigger-btn" onclick="addNewTrigger()">+ Add</button>
              </h4>
              ${triggersHtml || '<div class="sidebar-empty">No triggers.</div>'}
            </div>
            <div class="triggers-panel" id="hiddenFieldsPanel">
              <h4>Hidden Fields (${hiddenFields.length})</h4>
              <div class="sidebar-note">Drag a field here to hide it; drag it onto the form to show it.</div>
              ${hiddenFieldsHtml || '<div class="sidebar-empty">No hidden fields.</div>'}
            </div>
            ${model.tabOrder && model.tabOrder.length > 0 ? `
            <div class="triggers-panel">
              <h4>Tab Order</h4>
              <div style="font-size: 11px; color: rgba(0,0,0,0.8); line-height: 1.6;">
                ${model.tabOrder.map((fieldIdx, order) => {
                  const field = model.fields.find(f => (f.index ?? 0) === fieldIdx);
                  return `<div style="padding: 4px 0;"><strong>${order + 1}.</strong> Field ${fieldIdx}${field ? ` (<span style="font-family: monospace;">${escapeHtml(field.name)}</span>)` : ''}</div>`;
                }).join('')}
              </div>
            </div>
            ` : ''}
          </div>
        </div>
      </div>
    </div>

    <!-- Context Menu -->
    <div id="contextMenu" class="context-menu hidden">
      <div class="context-menu-item" data-action="add-text">Add Text</div>
      <div class="context-menu-item" data-action="add-field">Add Field</div>
      <div class="context-menu-item" data-action="add-button-select">Add Button</div>
      <div class="context-menu-item" data-action="add-button-checkbox">Add Checkbox</div>
      <div class="context-menu-item" data-action="add-button-radio">Add Radio Button</div>
      <div class="context-menu-item" data-action="add-preview">Add Preview</div>
    </div>

    <!-- Element Context Menu -->
    <div id="elementContextMenu" class="context-menu hidden">
      <div class="context-menu-item" data-action="edit-element">Edit<span class="context-menu-shortcut">F2</span></div>
      <div class="context-menu-item hidden" data-action="toggle-box" id="toggleBoxMenuItem">Add Box</div>
      <div class="context-menu-item" data-action="duplicate-element">Duplicate<span class="context-menu-shortcut" data-kbd-mod>Ctrl+D</span></div>
      <div class="context-menu-item" data-action="move-element" id="moveElementMenuItem">Set Tab Visibility</div>
      <div class="context-menu-item" data-action="show-in-source">Show in Source</div>
      <div class="context-menu-item" data-action="delete-element">Delete<span class="context-menu-shortcut">Del</span></div>
    </div>

    <!-- Window Resize Handle Context Menu -->
    <div id="resizeContextMenu" class="context-menu hidden">
      <div class="context-menu-item" data-resize-action="size">Set size to auto</div>
      <div class="context-menu-item" data-resize-action="width">Set width to auto</div>
      <div class="context-menu-item" data-resize-action="height">Set height to auto</div>
    </div>

    <!-- Outside Grid Context Menu -->
    <div id="outsideContextMenu" class="context-menu hidden">
      <div class="context-menu-item" data-action="add-trigger">Add Trigger</div>
    </div>

    <!-- Tab Order Mode Context Menu -->
    <div id="tabOrderContextMenu" class="context-menu hidden">
      <div class="context-menu-item" data-action="confirm-tab-order" style="color: var(--vscode-button-background, #0078d4); font-weight: 600;">✓ Confirm Tab Order<span class="context-menu-shortcut">Enter</span></div>
      <div class="context-menu-item" data-action="cancel-tab-order" style="color: #c42b1c;">✕ Cancel<span class="context-menu-shortcut">Esc</span></div>
    </div>

    <!-- Modal for Moving Element to Tab -->
    <div id="moveModal" class="modal-overlay hidden">
      <div class="modal">
        <h3 id="moveModalTitle">Set Tab Visibility</h3>
        <div class="modal-form">
          <div class="modal-field">
            <label>Visible on Tabs</label>
            <div style="display: flex; flex-direction: column; gap: 8px; margin-top: 8px;">
              <label style="display: flex; align-items: center; gap: 8px; font-weight: normal;">
                <input type="checkbox" id="moveTabAll" />
                <strong>ALL TABS</strong>
              </label>
              <div id="moveTabsList" style="display: flex; flex-direction: column; gap: 6px; margin-left: 8px;">
                ${model.tabs && model.tabs.length ? model.tabs.map(t => `
                  <label style="display: flex; align-items: center; gap: 8px; font-weight: normal;">
                    <input type="checkbox" class="move-tab-checkbox" value="${t.id}" />
                    ${escapeHtml(t.label)}
                  </label>
                `).join('') : ''}
              </div>
            </div>
            <small>Select one or more tabs where this element should be visible</small>
          </div>
          <div class="modal-buttons">
            <button class="modal-button" data-action="cancel">Cancel</button>
            <button class="modal-button primary" data-action="confirm-move">Confirm</button>
          </div>
        </div>
      </div>
    </div>

    <!-- Modal for Trigger Input -->
    <div id="triggerModal" class="modal-overlay hidden">
      <div class="modal">
        <h3 id="triggerModalTitle">Add Trigger</h3>
        <div class="modal-form">
          <div class="modal-field">
            <label>Target</label>
            <select id="triggerFieldIndex">
              <option value="">-- Select Target --</option>
              <option value="0">0 - All Fields</option>
              ${model.fields.map(f => `<option value="${f.index}">${f.index} - ${escapeHtml(f.name)}</option>`).join('')}
              <option value="$ONSTART2">$ONSTART2 - Form initialization</option>
              <option value="$ONEXIT1">$ONEXIT1 - Form exit</option>
            </select>
            <small>Field index, 0 for all fields, or special triggers ($ONSTART2, $ONEXIT1)</small>
          </div>
          <div class="modal-field">
            <label>Program Name</label>
            <select id="triggerProgramSelect">
              <option value="">-- Select Program --</option>
              ${availableTriggerPrograms.map(p => `<option value="${escapeHtml(p)}">${escapeHtml(p)}</option>`).join('')}
              <option value="__custom__">Other (enter manually)...</option>
            </select>
            <input type="text" id="triggerProgram" placeholder="e.g., sylomer_edit.prg" style="display: none; margin-top: 8px;" />
            <small>Select a trigger program from the workspace</small>
          </div>
          <div class="modal-field" id="triggerCreateSection" style="display: none;">
            <label style="display: flex; align-items: center; gap: 8px; font-weight: normal;">
              <input type="checkbox" id="triggerCreateFile" />
              <span>Create new program file if it doesn't exist</span>
            </label>
            <div id="triggerOpenSection" style="display: none; margin-left: 24px; margin-top: 6px;">
              <label style="display: flex; align-items: center; gap: 8px; font-weight: normal;">
                <input type="checkbox" id="triggerOpenFile" />
                <span>Open file in editor after creation</span>
              </label>
            </div>
          </div>
          <div class="modal-buttons">
            <button class="modal-button" data-action="cancel">Cancel</button>
            <button class="modal-button primary" data-action="confirm-trigger">Confirm</button>
          </div>
        </div>
      </div>
    </div>

    <!-- Modal for Edit Trigger -->
    <div id="editTriggerModal" class="modal-overlay hidden">
      <div class="modal">
        <h3>Edit Trigger</h3>
        <div class="modal-form">
          <input type="hidden" id="editTriggerLine" />
          <div class="modal-field">
            <label>Target</label>
            <select id="editTriggerTarget">
              <option value="">-- Select Target --</option>
              <option value="0">0 - All Fields</option>
              ${model.fields.map(f => `<option value="${f.index}">${f.index} - ${escapeHtml(f.name)}</option>`).join('')}
              <option value="$ONSTART2">$ONSTART2 - Form initialization</option>
              <option value="$ONEXIT1">$ONEXIT1 - Form exit</option>
            </select>
            <small>Field index (1, 2, ...) or special trigger ($ONSTART2, $ONEXIT1, etc.)</small>
          </div>
          <div class="modal-field">
            <label>Program</label>
            <select id="editTriggerProgramSelect">
              <option value="">-- Select Program --</option>
              ${availableTriggerPrograms.map(p => `<option value="${escapeHtml(p)}">${escapeHtml(p)}</option>`).join('')}
              <option value="__custom__">Other (enter manually)...</option>
            </select>
            <input type="text" id="editTriggerProgram" placeholder="program_name.prg" style="display: none; margin-top: 8px;" />
            <small>Select a trigger program from the workspace</small>
          </div>
          <div class="modal-field" id="editTriggerCreateSection" style="display: none;">
            <label style="display: flex; align-items: center; gap: 8px; font-weight: normal;">
              <input type="checkbox" id="editTriggerCreateFile" />
              <span>Create new program file if it doesn't exist</span>
            </label>
            <div id="editTriggerOpenSection" style="display: none; margin-left: 24px; margin-top: 6px;">
              <label style="display: flex; align-items: center; gap: 8px; font-weight: normal;">
                <input type="checkbox" id="editTriggerOpenFile" />
                <span>Open file in editor after creation</span>
              </label>
            </div>
          </div>
          <div class="modal-field">
            <label>Flag</label>
            <input type="text" id="editTriggerFlag" placeholder="p" value="p" />
            <small>Typically 'p' for ADT program. can do p/onstart, p/onlyonstart for more special cases</small>
          </div>
          <div class="modal-buttons">
            <button class="modal-button" data-action="cancel">Cancel</button>
            <button class="modal-button primary" data-action="confirm-edit-trigger">Save</button>
          </div>
        </div>
      </div>
    </div>

    <!-- Modal for Field Input -->
    <div id="fieldModal" class="modal-overlay hidden">
      <div class="modal">
        <h3 id="fieldModalTitle">Add Field</h3>
        <div class="modal-form">
          <div class="modal-field">
            <label>Field Name</label>
            <input type="text" id="fieldName" placeholder="e.g., DX, DY, CS" style="text-transform: uppercase;" />
            <div style="display: flex; gap: 16px; margin-top: 6px;">
              <label style="display: flex; align-items: center; gap: 6px; font-weight: normal; font-size: 12px;">
                <input type="checkbox" id="fieldNameAngle" />
                <span>Angle brackets &lt;&gt;</span>
              </label>
              <label style="display: flex; align-items: center; gap: 6px; font-weight: normal; font-size: 12px;">
                <input type="checkbox" id="fieldNameQuoted" />
                <span>Quoted ""</span>
              </label>
            </div>
            <small>Variable name (uppercase, alphanumeric, underscore, or $ prefix)</small>
          </div>
          <div class="modal-field">
            <label>Type</label>
            <div style="display: flex; flex-direction: column; gap: 6px; margin-top: 4px;">
              <label style="display: flex; align-items: center; gap: 8px; font-weight: normal;">
                <input type="checkbox" id="fieldType1" value="1" checked />
                <span>Active field (1)</span>
              </label>
              <label style="display: flex; align-items: center; gap: 8px; font-weight: normal;">
                <input type="checkbox" id="fieldType2" value="2" />
                <span>No free-text field (2)</span>
              </label>
              <label style="display: flex; align-items: center; gap: 8px; font-weight: normal;">
                <input type="checkbox" id="fieldType4" value="4" />
                <span>Locked field (4)</span>
              </label>
              <label style="display: flex; align-items: center; gap: 8px; font-weight: normal;">
                <input type="checkbox" id="fieldType8" value="8" />
                <span>Must assign field (8), does not allow closing without assigning value to this field</span>
              </label>
              <label style="display: flex; align-items: center; gap: 8px; font-weight: normal;">
                <input type="checkbox" id="fieldType16" value="16" />
                <span>unknown value (16)</span>
              </label>
              <label style="display: flex; align-items: center; gap: 8px; font-weight: normal;">
                <input type="checkbox" id="fieldType32" value="32" />
                <span>unknown value (32)</span>
              </label>
              <label style="display: flex; align-items: center; gap: 8px; font-weight: normal;">
                <input type="checkbox" id="fieldType64" value="64" />
                <span>unknown value (64)</span>
              </label>
              <label style="display: flex; align-items: center; gap: 8px; font-weight: normal;">
                <input type="checkbox" id="fieldType128" value="128" />
                <span>unknown value (128)</span>
              </label>
              <label style="display: flex; align-items: center; gap: 8px; font-weight: normal;">
                <input type="checkbox" id="fieldType256" value="256" />
                <span>unknown value (256)</span>
              </label>
              <label style="display: flex; align-items: center; gap: 8px; font-weight: normal;">
                <input type="checkbox" id="fieldType512" value="512" />
                <span>unknown value (512)</span>
              </label>
              <label style="display: flex; align-items: center; gap: 8px; font-weight: normal;">
                <input type="checkbox" id="fieldType1024" value="1024" />
                <span>unknown value (1024)</span>
              </label>
              <label style="display: flex; align-items: center; gap: 8px; font-weight: normal;">
                <input type="checkbox" id="fieldType2048" value="2048" />
                <span>Unknown value (2048)</span>
              </label>
              <label style="display: flex; align-items: center; gap: 8px; font-weight: normal;">
                <input type="checkbox" id="fieldType4096" value="4096" />
                <span>EXO field (4096)</span>
              </label>
              <label style="display: flex; align-items: center; gap: 8px; font-weight: normal;">
                <input type="checkbox" id="fieldType8192" value="8192" />
                <span>Transparent field (8192)</span>
              </label>
              <label style="display: flex; align-items: center; gap: 8px; font-weight: normal;">
                <input type="checkbox" id="fieldType16384" value="16384" />
                <span>Right align (16384)</span>
              </label>
              <label style="display: flex; align-items: center; gap: 8px; font-weight: normal;">
                <input type="checkbox" id="fieldType32768" value="32768" />
                <span>Center align (32768)</span>
              </label>
            </div>
            <input type="text" id="fieldType" value="1" placeholder="e.g., 1, 4, 2048+4+1" style="margin-top: 8px;" />
            <small>Select checkboxes above or type manually (e.g., 1+4, 2048+4+1)</small>
          </div>
          <div class="modal-field">
            <label>Length (columns)</label>
            <input type="number" id="fieldLen" value="10" min="1" />
            <small>Width of the field in grid columns</small>
          </div>
          <div class="modal-field">
            <label>Ignore Value (optional)</label>
            <input type="number" id="fieldIgnore" value="${model.winstyle?.toLowerCase() === 'only' ? 4 : 7}" />
            <small>Usually 7, leave as is if unsure</small>
          </div>
          <div class="modal-field">
            <label>Dropdown Values (optional)</label>
            <textarea id="fieldValues" placeholder='One per line, or "value1" "value2". Can also use description syntax like "Description [realvalue]*" "Description2 [realvalue2]*"'></textarea>
            <small>For dropdown fields, enter choices (one per line or quoted). "path:name" reads choices from forms/fieldvalues</small>
            <small id="fieldValuesHint" class="fv-hint"></small>
          </div>
          <div class="modal-buttons">
            <button class="modal-button" data-action="cancel">Cancel</button>
            <button class="modal-button primary" data-action="hide-field">Add as/Make Hidden!</button>
            <button class="modal-button primary" data-action="confirm-field">Confirm</button>
          </div>
        </div>
      </div>
    </div>

    <!-- Modal for Button Input -->
    <div id="buttonModal" class="modal-overlay hidden">
      <div class="modal">
        <h3 id="buttonModalTitle">Add Button</h3>
        <div class="modal-form">
          <div class="modal-field">
            <label>Button Label</label>
            <input type="text" id="buttonLabel" placeholder="Enter button text" />
            <small>Optional. Leave empty to create a button with an empty label ("").</small>
          </div>
          <div class="modal-field" id="buttonTypeField">
            <label>Action Type</label>
            <select id="buttonActionType">
              <option value="program">Run Program (@...)</option>
              <option value="variable">Set Variable</option>
            </select>
          </div>
          <div class="modal-field" id="buttonProgramField">
            <label>Program Call</label>
            <input type="text" id="buttonProgram" placeholder="e.g., help_adapt.prg(DOC,topic)" />
            <small>Format: @program.prg(ARGS) - the @ is optional</small>
          </div>
          <div class="modal-field hidden" id="buttonVariableField">
            <label>Variable Name</label>
            <div style="display: flex; gap: 8px;">
              <select id="buttonVariableSelect" style="flex: 1;">
                <option value="">-- Select existing field or type custom --</option>
                ${model.fields.map(f => `<option value="${escapeAttr(f.name)}">${escapeHtml(f.name)}</option>`).join('')}
              </select>
              <input type="text" id="buttonVariable" placeholder="or type custom" style="flex: 1; text-transform: uppercase;" />
            </div>
            <small>Select an existing field from dropdown or type a custom variable name</small>
          </div>
          <div class="modal-field hidden" id="buttonValueField">
            <label>Value</label>
            <input type="text" id="buttonValue" placeholder="e.g., 1;0 for toggle" />
            <small>For checkbox/radio: value when checked;unchecked (e.g., 1;0)</small>
          </div>
          <div class="modal-buttons">
            <button class="modal-button" data-action="cancel">Cancel</button>
            <button class="modal-button primary" data-action="confirm-button">Confirm</button>
          </div>
        </div>
      </div>
    </div>

    <!-- Modal for Preview Input -->
    <div id="previewModal" class="modal-overlay hidden">
      <div class="modal">
        <h3 id="previewModalTitle">Add Preview</h3>
        <div class="modal-form">
          <div class="modal-field">
            <label>File Path</label>
            <input type="text" id="previewPath" placeholder="e.g., $DIR_PICTS/wind_zones.vxp" />
            <small>Path to the preview file (use $DIR_PICTS for pictures directory)</small>
          </div>
          <div class="modal-field">
            <label>Field Name (Optional)</label>
            <input type="text" id="previewField" placeholder="Leave empty or specify field" />
            <small>Database field containing the file name to preview</small>
            <small>Or file path from the specified path, for example:</small>
            <small>if Path is "$DIR_SYSPROGS/" and field can then be "filename.vxp"</small>
          </div>
          <div style="display: flex; gap: 12px;">
            <div class="modal-field" style="flex: 1;">
              <label>Rows (Height)</label>
              <input type="number" id="previewRows" value="25" min="1" />
            </div>
            <div class="modal-field" style="flex: 1;">
              <label>Columns (Width)</label>
              <input type="number" id="previewCols" value="72" min="1" />
            </div>
          </div>
          <div class="modal-field">
            <label>Mode</label>
            <input type="text" id="previewMode" value="0" placeholder="e.g., 0 or 1+2" />
            <small>Bitwise flags: 1=no H stretch, 2=no V stretch, 4=auto search subfolders</small>
            <small>8= auto search from custom branches, 16=auto search from shared branch</small>
            <small>32=update list view also with multiple selection</small>
          </div>
          <div class="modal-field">
            <label>Port Type</label>
            <select id="previewPortType">
              <option value="PORT_2D">PORT_2D</option>
              <option value="PORT_3D">PORT_3D</option>
              <option value="PORT_BMP">PORT_BMP</option>
            </select>
            <small>Type of preview window</small>
          </div>
          <div class="modal-field">
            <label>Port Style</label>
            <select id="previewPortStyle">
              <option value="SIMPLE">SIMPLE</option>
              <option value='""'>empty (full frame)</option>
              <option value="WIREFRAME">WIREFRAME</option>
              <option value="HIDDEN_LINE">HIDDEN_LINE</option>
              <option value="OPENGL">OPENGL</option>
              <option value="LW">LW</option>
              <option value="SIMPLE_T">SIMPLE_T</option>
            </select>
            <small>Style for PORT_2D/PORT_3D/PORT_BMP (SIMPLE = no frame/toolbar)</small>
            <small>Leave empty for full frame with toolbar</small>
            <small>WIREFRAME, HIDDEN_LINE, OPENGL, LW are for 3D only</small>
            <small>For PORT_BMP, SIMPLE_T can be used for transparent background</small>
          </div>
          <div class="modal-buttons">
            <button class="modal-button" data-action="cancel">Cancel</button>
            <button class="modal-button primary" data-action="confirm-preview">Confirm</button>
          </div>
        </div>
      </div>
    </div>

    <div id="selectionNotice" class="selection-notice hidden" role="status"></div>

    <!-- Keyboard Shortcuts -->
    <div id="shortcutsModal" class="modal-overlay hidden">
      <div class="modal shortcuts-modal">
        <h3>Keyboard Shortcuts</h3>
        <div class="shortcuts-grid">
          <h4>Selected element</h4>
          <span><kbd data-kbd-mod>Ctrl</kbd>+click</span><span>Add to or remove from the selection</span>
          <span><kbd>↑</kbd><kbd>↓</kbd><kbd>←</kbd><kbd>→</kbd></span><span>Move one cell</span>
          <span><kbd>Shift</kbd>+<kbd>Arrow</kbd></span><span>Stretch (fields, images, previews)</span>
          <span><kbd>F2</kbd> / <kbd>Enter</kbd></span><span>Edit</span>
          <span><kbd data-kbd-mod>Ctrl</kbd>+<kbd>D</kbd></span><span>Duplicate one row below</span>
          <span><kbd>Del</kbd> / <kbd>Backspace</kbd></span><span>Delete</span>
          <span><kbd>Esc</kbd></span><span>Deselect</span>
          <h4>Form</h4>
          <span><kbd data-kbd-mod>Ctrl</kbd>+<kbd>Z</kbd></span><span>Undo (shared with the .frm source)</span>
          <span><kbd data-kbd-mod>Ctrl</kbd>+<kbd>Y</kbd> / <kbd data-kbd-mod>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>Z</kbd></span><span>Redo</span>
          <span><kbd>Enter</kbd> / <kbd>Esc</kbd></span><span>Confirm / cancel tab order (in tab-order mode)</span>
          <span><kbd>?</kbd></span><span>Show this list</span>
          <h4>Dialogs</h4>
          <span><kbd>Esc</kbd></span><span>Cancel, discarding changes</span>
          <span><kbd data-kbd-mod>Ctrl</kbd>+<kbd>Enter</kbd></span><span>Confirm</span>
          <span><kbd>Tab</kbd> / <kbd>Shift</kbd>+<kbd>Tab</kbd></span><span>Next / previous input</span>
          <span>Click outside</span><span>Close (asks first if anything changed)</span>
          <h4>Context menus</h4>
          <span><kbd>↑</kbd><kbd>↓</kbd></span><span>Move highlight</span>
          <span><kbd>Enter</kbd></span><span>Choose highlighted item</span>
          <span><kbd>Esc</kbd></span><span>Close menu</span>
        </div>
        <div class="modal-buttons">
          <button class="modal-button primary" data-action="cancel">Close</button>
        </div>
      </div>
    </div>
`;
  const data: PreviewData = {
    winstyle: model.winstyle || 'VXUI',
    tabOrder: model.tabOrder || [],
    initialZoom,
    initialGridOn: typeof initialGridOn === 'boolean' ? initialGridOn : false,
    initialActiveTab: initialActiveTab ?? null,
    tabs: model.tabs ?? [],
    tabTexts: model.tabTexts ?? {},
    tabFields: model.tabFields ?? {},
    tabPushButtons: model.tabPushButtons ?? {},
    tabImages: model.tabImages ?? {},
    tabPreviews: model.tabPreviews ?? {},
    rows: model.rows,
    cols: model.cols,
    portRows: Number(model.portRows ?? 0),
    portCols: Number(model.portCols ?? 0),
    boxOffset: BOX_LABEL_OFFSET
  };
  return { body, data };
}

/** media/preview.css and media/preview.js, read from disk once per session. */
let pageAssets: { css: string; js: string } | undefined;
function getPageAssets(media: vscode.Uri): { css: string; js: string } {
  if (!pageAssets) {
    const read = (name: string) => fs.readFileSync(vscode.Uri.joinPath(media, name).fsPath, 'utf8');
    // A closing tag inside the text would end the inline element early
    pageAssets = {
      css: read('preview.css').replace(/<\/style/gi, '<\\/style'),
      js: read('preview.js').replace(/<\/script/gi, '<\\/script')
    };
  }
  return pageAssets;
}

/** The full page for a first load: static styles and script from media/ (inlined), this render's body and data. */
function renderPreviewPage(webview: vscode.Webview, media: vscode.Uri, parts: PreviewParts): string {
  // Inlined rather than linked: the webview would otherwise fetch both files before it can draw
  const assets = getPageAssets(media);
  // Inside a script element only "<" could end it early; \u003c keeps the JSON valid
  const json = JSON.stringify(parts.data).replace(/</g, '\\u003c');
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline' ${webview.cspSource}; img-src ${webview.cspSource} https:; script-src 'unsafe-inline' ${webview.cspSource};" />
  <script>window.__frmHtmlStart = performance.now();</script>
  <style>
${assets.css}
  </style>
</head>
<body>
${parts.body}
<script type="application/json" id="frmData">${json}</script>
<script>
${assets.js}
</script>
</body>
</html>`;
}

// Stretch handles on a field, image or preview; dir is the edge or corner it moves (n, s, e, w, ne, ...)
function elementResizeHandles(dirs: string[]): string {
  return dirs.map(d => `<div class="el-resize ${d}" data-el-resize="${d}"></div>`).join('');
}

// Stretch handles on a text's box, sitting on its drawn lines (which are inset half a cell from the box element)
function boxResizeHandles(): string {
  return ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw']
    .map(d => `<div class="box-resize ${d}" data-box-resize="${d}"></div>`).join('');
}

function escapeHtml(s: string) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeAttr(s: string) {
  return escapeHtml(s).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function prettyName(s: string) {
  return s.replace(/_/g, ' ').replace(/\b([a-z])/g, (m) => m.toUpperCase());
}
