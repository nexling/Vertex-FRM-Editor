import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

export function activate(context: vscode.ExtensionContext) {
  const openCmd = vscode.commands.registerCommand('vertexFrmPreview.open', () => openPreview(context));
  context.subscriptions.push(openCmd);
  context.subscriptions.push(vscode.commands.registerCommand('vertexFrmPreview.sortSections', sortSectionsCommand));

  // Auto-open / auto-reveal when a vertex-frm file is focused (each controlled by a setting)
  context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor((ed: vscode.TextEditor | undefined) => {
    if (!ed || !isFrmFile(ed.document)) {
      return;
    }
    const config = vscode.workspace.getConfiguration('vertexFrmPreview');
    const hasPanel = panelByDoc.has(ed.document.uri.toString());
    if (hasPanel ? config.get<boolean>('autoReveal', true) : config.get<boolean>('autoOpen', true)) {
      // A newly auto-opened panel takes focus; revealing an existing one leaves focus in the editor.
      ensurePreview(context, ed.document, { preserveFocus: hasPanel });
    }
  }));

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
    const roots: vscode.Uri[] = [];
    const repoRoot = getRepoRootFolder();
    if (repoRoot) {
      //check through root folders for any that start with custom, use that one for customImg path
      customRoot = vscode.workspace.workspaceFolders?.find(wf => wf.name.toLowerCase().startsWith('custom'));
      customImg = customRoot ? vscode.Uri.file(path.join(customRoot.uri.fsPath, 'forms', 'images')) : vscode.Uri.file(path.join(repoRoot.uri.fsPath, 'custom', 'forms', 'images'));
      systemImg = vscode.Uri.file(path.join(repoRoot.uri.fsPath, 'system', 'forms', 'images'));
      roots.push(customImg, systemImg);
    }
    panel = vscode.window.createWebviewPanel(
      'vertexFrmPreview',
      `FRM Preview — ${vscode.workspace.asRelativePath(doc.uri)}`,
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus },
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: roots }
    );
    const createdPanel = panel;
    panelByDoc.set(key, panel);

    // Update on document changes (registered once per panel)
    const sub = vscode.workspace.onDidChangeTextDocument((e: vscode.TextDocumentChangeEvent) => {
      if (e.document.uri.toString() === key) {
        scheduleRefresh(createdPanel, e.document);
      }
    });
    panel.onDidDispose(() => sub.dispose());

    // Re-render when a fieldvalues (or other forms) file changes, since dropdowns expand "path:<name>"
    const formsDirs = getFormsDirs();
    if (formsDirs) {
      let formsTimer: ReturnType<typeof setTimeout> | undefined;
      const onFormsChange = () => {
        if (formsTimer) clearTimeout(formsTimer);
        formsTimer = setTimeout(() => {
          formsTimer = undefined;
          const current = vscode.workspace.textDocuments.find(d => d.uri.toString() === key);
          if (current && panelByDoc.get(key) === createdPanel) updateWebview(createdPanel, current);
        }, REFRESH_DELAY_MS);
      };
      for (const dir of [formsDirs.custom, formsDirs.system]) {
        const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(dir), '**/*'));
        watcher.onDidChange(onFormsChange);
        watcher.onDidCreate(onFormsChange);
        watcher.onDidDelete(onFormsChange);
        panel.onDidDispose(() => {
          if (formsTimer) clearTimeout(formsTimer);
          watcher.dispose();
        });
      }
    }

  panel.onDidDispose(() => {
    panelByDoc.delete(key);
    zoomByDoc.delete(key);
    activeTabByDoc.delete(key);
    gridOnByDoc.delete(key);
    gatedDocs.delete(key);
    shownTextByDoc.delete(key);
    pendingPreviewEdits.delete(key);
    const timer = refreshTimerByDoc.get(key);
    if (timer) {
      clearTimeout(timer);
      refreshTimerByDoc.delete(key);
    }
  });

    // Receive messages (future: editing from preview)
  panel.webview.onDidReceiveMessage((msg: any) => {
      if (msg?.command === 'gateCancel') {
        createdPanel.dispose();
      } else if (msg?.command === 'autoIndex') {
        autoAddIndexes(doc);
      } else if (msg?.command === 'frmReady') {
        readyPanels.add(createdPanel);
      } else if (msg?.command === 'frmSoftUpdateFailed') {
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
        handleShowInSource(doc, msg);
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

    // Find and remove the element line
    let elementLineIndex = -1;
    const elementPattern = new RegExp(`^\\s*${elementType}\\s*\\(\\s*${elementIndex}\\s*\\)\\s*=`, 'i');
    
    for (let i = 0; i < lines.length; i++) {
      if (elementPattern.test(lines[i])) {
        elementLineIndex = i;
        break;
      }
    }

    if (elementLineIndex === -1) {
      vscode.window.showErrorMessage(`Could not find ${elementType}(${elementIndex})`);
      return;
    }

    // Remove the element line
    lines.splice(elementLineIndex, 1);

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
    let elementLineIndex = -1;
    const regex = new RegExp(`^\\s*${elementType}\\s*\\(\\s*${elementIndex}\\s*\\)\\s*=`, 'i');
    for (let i = 0; i < lines.length; i++) {
      if (regex.test(lines[i])) {
        elementLineIndex = i;
        break;
      }
    }

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
  try {
    const visible = vscode.window.visibleTextEditors.find(e => e.document.uri.toString() === doc.uri.toString());
    await vscode.window.showTextDocument(doc, { viewColumn: visible?.viewColumn ?? vscode.ViewColumn.One, preserveFocus: false });
    await vscode.commands.executeCommand(command);
  } catch (error) {
    vscode.window.showErrorMessage(`Failed to ${command}: ${error}`);
  } finally {
    panel.reveal(panel.viewColumn, false);
  }
}

function handleShowInSource(doc: vscode.TextDocument, msg: any) {
  try {
    const text = doc.getText();
    const lines = text.split(/\r?\n/);
    const elementType = msg.elementType;
    const elementIndex = msg.elementIndex;

    // Find the line that contains this element
    let elementLineIndex = -1;
    const regex = new RegExp(`^\\s*${elementType}\\s*\\(\\s*${elementIndex}\\s*\\)\\s*=`, 'i');
    for (let i = 0; i < lines.length; i++) {
      if (regex.test(lines[i])) {
        elementLineIndex = i;
        break;
      }
    }

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
    } else {
      // If editor is not visible, open it
      vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.One }).then(editor => {
        const line = elementLineIndex;
        const range = new vscode.Range(line, 0, line, lines[line].length);
        editor.selection = new vscode.Selection(range.start, range.end);
        editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
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
  const text = doc.getText();
  const key = doc.uri.toString();
  const unindexed = unindexedCounts(findUnindexed(text));
  if (gatedDocs.has(key)) {
    if (unindexed.texts + unindexed.buttons > 0) {
      // The gate is its own page; leaving it later needs a full load of the form
      readyPanels.delete(panel);
      panel.webview.html = renderGateHtml(panel.webview, unindexed);
      shownTextByDoc.set(key, text);
      return;
    }
    // Every line has an index now (auto-added or typed): show the form
    gatedDocs.delete(key);
  }
  const model = parseFrm(text);
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
  const html = renderHtml(panel.webview, model, initialZoom, initialTab, initialGridOn, availableTriggerPrograms, showZoomControls, unindexed);
  shownTextByDoc.set(doc.uri.toString(), text);
  if (readyPanels.has(panel)) {
    // Swap the page contents in place: no document reload, so no flash
    panel.webview.postMessage({ command: 'frmSoftUpdate', html });
  } else {
    // Full load; the new page reports 'frmReady' once it can take in-place updates
    readyPanels.delete(panel);
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
    if (doc.getText() === shownTextByDoc.get(key)) {
      return;
    }
    updateWebview(panel, doc);
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

/** True if a logical FRM statement continues onto the next line. */
function lineContinues(line: string): boolean {
  return line.trimEnd().endsWith('\\');
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
  const triggerRegex = /^\s*trigger\s*=\s*(\$?[\w]+)\s+([^\s]+)\s+([^\s\n]*)/gim;
  let trm: RegExpExecArray | null;
  const textLines = text.split('\n');
  while ((trm = triggerRegex.exec(text))) {
    const target = trm[1].trim();
    const program = trm[2].trim();
    const flag = trm[3].trim();
    // Find line number for editing
    const lineIndex = textLines.findIndex(line => line.includes(trm![0]));
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
    const candidates = [
      path.join(customImg.fsPath, fileName),
      path.join(systemImg.fsPath, fileName)
    ];
    const found = candidates.find(p => fs.existsSync(p));
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

/** Look up and read the values file for name: custom before system, fieldvalues/ before forms/. */
function resolveFieldValues(name: string): FieldValuesResolution {
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

// Get list of available trigger programs from custom*/macros/triggers/ and system/macros/triggers/
function getAvailableTriggerPrograms(): string[] {
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
    if (!fs.existsSync(triggersPath)) {
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

function renderHtml(webview: vscode.Webview, model: FrmModel, initialZoom: number = 1, initialActiveTab?: number, initialGridOn?: boolean, availableTriggerPrograms: string[] = [], showZoomControls: boolean = true, unindexed: { texts: number; buttons: number } = { texts: 0, buttons: 0 }) {
  const unindexedMsg = unindexed.texts + unindexed.buttons > 0 ? unindexedMessage(unindexed) : null;
  const styles = `
    /* Unindexed text/button lines: shown but locked until they get an index */
    [data-unindexed] { pointer-events: none; opacity: .45; outline: 1px dashed var(--vscode-editorWarning-foreground, #cca700); }
    .unindexed-strip { display: flex; align-items: center; gap: 10px; padding: 6px 10px; margin-bottom: 8px; border-radius: 3px;
      background: var(--vscode-inputValidation-warningBackground, rgba(204,167,0,.15)); border: 1px solid var(--vscode-inputValidation-warningBorder, #cca700); }
    .unindexed-strip .msg { flex: 1; }
    .unindexed-strip .detail { opacity: .8; margin-left: 4px; }
    .unindexed-strip button { padding: 3px 10px; border: 0; border-radius: 2px; cursor: pointer; font: inherit;
      background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
    .unindexed-strip button:hover { background: var(--vscode-button-hoverBackground); }
    :root { --col-w: 1ch; --row-h: calc(2ch + 16px); --frm-font-size: 11px; --row-gap: 0px; --col-gap: 0px; --gridline-alpha: 0; }
    body { font-family: 'Times New Roman', Times, serif; padding: 12px; color: rgba(0, 0, 0, 1); }
    /* Window chrome */
    .window {
      background: rgba(240, 240, 240, 1);
      border: 2px solid rgba(104, 104, 104, 1);
      border-radius: 6px;
      overflow: hidden;
      box-shadow: 0 2px 6px rgba(0,0,0,.15);
      /* Allow preview to grow with panel size */
      max-width: none;
      width: auto;
    }
    .titlebar {
      height: 30px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 0 8px;
      background: rgba(255, 140, 0, 1);
      color: rgba(0, 0, 0, 1);
      user-select: none;
    }
    .titlebar .caption {
      display: flex;
      align-items: center;
      gap: 8px;
      font-weight: 600;
      font-size: 13px;
      letter-spacing: .2px;
      cursor: pointer;
    }
    .titlebar .title {
      cursor: pointer;
    }
    .titlebar .controls {
      display: flex;
      align-items: center;
      gap: 2px;
    }
    .titlebar .zoom {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      margin-right: 4px;
      opacity: .95;
    }
    .titlebar .ctrl {
      width: 36px;
      height: 24px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      border: 0;
      background: transparent;
      color: inherit;
      border-radius: 3px;
      font-size: 12px;
      line-height: 1;
      cursor: default; /* purely decorative */
    }
    .titlebar .ctrl:hover { background: rgba(255,255,255,.08); }
    .titlebar .ctrl.close:hover { background: #c42b1c; color: #fff; }
    .titlebar input[type="range"] {
      width: 140px;
      height: 4px;
      accent-color: var(--vscode-focusBorder, #0078d4);
      cursor: pointer;
    }
    .titlebar .zoomLabel { font-variant-numeric: tabular-nums; min-width: 44px; text-align: right; display: inline-block; }

    .content { padding: 12px; }

  /* Tabs */
  .tabs { display: flex; gap: 2px; padding: 0 0 8px 0; border-bottom: 1px solid var(--vscode-editorWidget-border); margin-bottom: 8px; }
  .tab { padding: 4px 8px; border: 1px solid var(--vscode-editorWidget-border); border-bottom: 0; background: rgba(240,240,240,1); cursor: pointer; font-size: 12px; }
  .tab.active { background: rgba(243,243,243,1); box-shadow: inset 0 -2px 0 rgba(240,240,240,1); font-weight: 600; }
  .hidden { display: none !important; }

    .grid {
      display: grid;
      grid-template-columns: repeat(${model.cols}, var(--col-w));
      grid-template-rows: repeat(${model.rows}, var(--row-h));
      /* Elements outside a port_size smaller than the content keep the same cell size */
      grid-auto-columns: var(--col-w);
      grid-auto-rows: var(--row-h);
      row-gap: var(--row-gap);
      column-gap: var(--col-gap);
      position: relative;
      font-family: 'Times New Roman', Times, serif;
      font-size: var(--frm-font-size);
      line-height: 1;
    }
    /* Gridlines */
    .gridlines {
      background:
        repeating-linear-gradient(
          to right,
          transparent 0,
          transparent calc(var(--col-w) - 1px),
          rgba(127, 127, 127, var(--gridline-alpha)) calc(var(--col-w) - 1px),
          rgba(127, 127, 127, var(--gridline-alpha)) var(--col-w),
          transparent var(--col-w),
          transparent calc(var(--col-w) + var(--col-gap))
        ),
        repeating-linear-gradient(
          to bottom,
          transparent 0,
          transparent calc(var(--row-h) - 1px),
          rgba(127, 127, 127, var(--gridline-alpha)) calc(var(--row-h) - 1px),
          rgba(127, 127, 127, var(--gridline-alpha)) var(--row-h),
          transparent var(--row-h),
          transparent calc(var(--row-h) + var(--row-gap))
        );
      border: 1px solid var(--vscode-editorWidget-border);
    }
    /* Window resize (port_size) */
    .grid-frame { position: relative; width: fit-content; }
    .resize-handle { position: absolute; z-index: 50; touch-action: none; }
    .resize-handle.e { top: 0; bottom: 6px; right: -6px; width: 10px; cursor: ew-resize; }
    .resize-handle.s { left: 0; right: 6px; bottom: -6px; height: 10px; cursor: ns-resize; }
    .resize-handle.se { right: -7px; bottom: -7px; width: 14px; height: 14px; cursor: nwse-resize; }
    .resize-handle.se::after {
      content: ""; position: absolute; right: 4px; bottom: 4px; width: 7px; height: 7px;
      border-right: 2px solid rgba(104,104,104,.8); border-bottom: 2px solid rgba(104,104,104,.8);
    }
    .resize-handle.e:hover, .resize-handle.s:hover, .grid-frame.resizing-e .resize-handle.e, .grid-frame.resizing-s .resize-handle.s {
      background: rgba(0, 120, 212, .25); border-radius: 3px;
    }
    .grid-frame.resizing .grid { outline: 2px dashed var(--vscode-focusBorder, #0078d4); outline-offset: 1px; }
    body.tab-order-active .resize-handle { display: none; }
    .resize-size-label {
      position: absolute; right: 0; bottom: -26px; z-index: 60; padding: 2px 6px; border-radius: 3px;
      background: rgba(0,0,0,.75); color: #fff; font: 11px/1.4 sans-serif; font-variant-numeric: tabular-nums;
      white-space: nowrap; pointer-events: none;
    }
    .grid > .frm-overflow.frm-overflow { opacity: .35; z-index: 3; }
    .grid > .frm-overflow.frm-overflow:hover, .grid > .frm-overflow.frm-overflow.selected { opacity: .8; }
    .context-menu-item.disabled { opacity: .45; pointer-events: none; }
    /* Stretch handles on fields, images and previews: thin strips centred on each edge */
    .el-resize { position: absolute; z-index: 12; touch-action: none; display: none; }
    .draggable:hover > .el-resize, .draggable.selected > .el-resize, .draggable.el-resizing > .el-resize { display: block; }
    .draggable.el-narrow:not(.selected):not(.el-resizing) > .el-resize { display: none; }
    body.tab-order-active .el-resize { display: none !important; }
    .el-resize.e, .el-resize.w { top: 0; bottom: 0; width: 6px; cursor: ew-resize; }
    .el-resize.e { right: -3px; }
    .el-resize.w { left: -3px; }
    .el-resize.n, .el-resize.s { left: 0; right: 0; height: 6px; cursor: ns-resize; }
    .el-resize.n { top: -3px; }
    .el-resize.s { bottom: -3px; }
    .el-resize.ne, .el-resize.nw, .el-resize.se, .el-resize.sw { width: 9px; height: 9px; z-index: 13; }
    .el-resize.ne { top: -4px; right: -4px; cursor: nesw-resize; }
    .el-resize.sw { bottom: -4px; left: -4px; cursor: nesw-resize; }
    .el-resize.nw { top: -4px; left: -4px; cursor: nwse-resize; }
    .el-resize.se { bottom: -4px; right: -4px; cursor: nwse-resize; }
    .el-resize:hover, .el-resize.active { background: rgba(0, 120, 212, .35); border-radius: 2px; }
    .draggable.el-resizing { outline: 2px dashed var(--vscode-focusBorder, #0078d4); outline-offset: 1px; z-index: 20; }
    .el-resize-label { right: auto; bottom: auto; }
    /* Stretch handles on a text's box, placed on its drawn lines (inset half a cell from the box element) */
    .box-resize { position: absolute; z-index: 12; touch-action: none; display: none; }
    .box.stretchable:hover > .box-resize, .box.owner-hover > .box-resize, .box.owner-selected > .box-resize, .box.box-resizing > .box-resize { display: block; }
    body.tab-order-active .box-resize { display: none !important; }
    .box-resize.n, .box-resize.s { left: calc(var(--col-w) / 2); right: calc(var(--col-w) / 2); height: 6px; cursor: ns-resize; }
    .box-resize.n { top: calc(var(--row-h) / 2 - 3px); }
    .box-resize.s { top: calc(100% - var(--row-h) / 2 - 3px); }
    .box-resize.e, .box-resize.w { top: calc(var(--row-h) / 2); bottom: calc(var(--row-h) / 2); width: 6px; cursor: ew-resize; }
    .box-resize.w { left: calc(var(--col-w) / 2 - 3px); }
    .box-resize.e { right: calc(var(--col-w) / 2 - 3px); }
    .box-resize.ne, .box-resize.nw, .box-resize.se, .box-resize.sw { width: 9px; height: 9px; z-index: 13; }
    .box-resize.nw, .box-resize.ne { top: calc(var(--row-h) / 2 - 4px); }
    .box-resize.sw, .box-resize.se { top: calc(100% - var(--row-h) / 2 - 4px); }
    .box-resize.nw, .box-resize.sw { left: calc(var(--col-w) / 2 - 4px); }
    .box-resize.ne, .box-resize.se { right: calc(var(--col-w) / 2 - 4px); }
    .box-resize.nw, .box-resize.se { cursor: nwse-resize; }
    .box-resize.ne, .box-resize.sw { cursor: nesw-resize; }
    .box-resize:hover, .box-resize.active { background: rgba(0, 120, 212, .35); border-radius: 2px; }
    /* In-place editing of the window header and texts */
    .inline-edit {
      font: inherit; letter-spacing: inherit; user-select: text;
      color: var(--vscode-input-foreground, inherit);
      background: var(--vscode-input-background, #fff);
      border: 1px solid var(--vscode-focusBorder, #0078d4); border-radius: 2px;
      outline: none; margin: 0; padding: 0 3px; box-sizing: content-box; min-width: 4ch;
    }
    .titlebar .inline-edit { height: 18px; line-height: 18px; background: rgba(255, 255, 255, .9); color: #000; border-color: rgba(0, 0, 0, .55); }
    .grid .inline-edit { position: relative; z-index: 20; height: 1.3em; line-height: 1.3em; margin: -0.15em 0 0 -4px; }
    .text.inline-editing > .delete-button, .text.inline-editing > .insertion-point { display: none; }
    /* Lift the delete button above the top edge so it doesn't cover the e/ne stretch handles */
    .field > .delete-button, .image > .delete-button, .preview > .delete-button { top: -17px; right: -6px; z-index: 14; }
  /* Boxes */
  .box { position: relative; border: 0; background: transparent; box-sizing: border-box; z-index: 0; }
  .box .hrow { position: absolute; height: 0; border-top: 1px solid var(--vscode-editorWidget-border); }
  .box .hrow.top { top: calc(var(--row-h) / 2); }
  .box .hrow.bottom { top: calc(100% - var(--row-h) / 2); }
  .box .vline { position: absolute; width: 0; border-left: 1px solid var(--vscode-editorWidget-border); top: calc(1em + 3px); bottom: calc(1em + 2px); }
  .box .vline.left { left: calc(var(--col-w) / 2); }
  .box .vline.right { right: calc(var(--col-w) / 2); }
    /* Ensure content layers above boxes */
    .grid > .text, .grid > .field, .grid > .push, .grid > .image, .grid > .preview { position: relative; z-index: 1; }
    
    /* Draggable elements */
    .draggable { cursor: grab; transition: box-shadow 0.2s ease; outline: none; }
    .draggable:hover { box-shadow: 0 0 0 2px var(--vscode-focusBorder, #0078d4); }
    .draggable.selected { box-shadow: 0 0 0 3px var(--vscode-focusBorder, #0078d4); background-color: rgba(0, 120, 212, 0.1); }
    .draggable.dragging { cursor: grabbing; opacity: 0.8; z-index: 100; box-shadow: 0 4px 12px rgba(0,0,0,0.3); }
    .delete-button { position: absolute; top: -8px; right: -8px; width: 16px; height: 16px; background: #c42b1c; color: #fff; border-radius: 50%; opacity: 0; transition: opacity 0.2s ease; cursor: pointer; z-index: 10; display: flex; align-items: center; justify-content: center; font-size: 10px; font-weight: bold; line-height: 1; }
    .draggable:hover .delete-button, .draggable.selected .delete-button { opacity: 1; }
    .delete-button:hover { background: #a52a1c; }
    .insertion-point { position: absolute; left: 0; top: 50%; transform: translate(-50%, -50%); width: 6px; height: 6px; background: var(--vscode-focusBorder, #0078d4); border-radius: 50%; opacity: 0; transition: opacity 0.2s ease; z-index: 10; }
    .draggable:hover .insertion-point, .draggable.selected .insertion-point { opacity: 1; }
    .grid.drag-over { background-color: rgba(0, 120, 212, 0.1); }
    
    .text { align-self: center; white-space: nowrap; padding: 0; font-family: inherit; font-size: inherit; line-height: 1em; height: 1em; }
    /* Text hugs its rendered width; fitTextSpans() sizes the grid span to match */
    .grid > .text { justify-self: start; width: max-content; min-width: var(--col-w); }
    .field { display: flex; align-items: center; padding: 0; }
    .field select, .field input {
      width: 100%; padding: 0; margin: 0; border: 0; outline: 1px solid var(--vscode-input-border);
      background: rgba(255, 255, 255, 1); color: rgba(0,0,0,1);
      box-sizing: content-box; font-family: inherit; font-size: inherit; line-height: 1em; height: calc(1em + 2px);
      appearance: none; -webkit-appearance: none;
    }
    /* Dropdown affordance */
    .field select { padding-right: 14px; }
    .field.dropdown { position: relative; }
    .field select option.fv-missing, .field select option.fv-database { font-style: italic; color: rgba(0,0,0,0.5); }
    .field.dropdown::after {
      content: "▾"; /* down arrow */
      position: absolute; right: 2px; top: 50%; transform: translateY(-50%);
      line-height: 1; font-size: 15px; color: rgba(0,0,0,0.9);
      pointer-events: none; /* do not block clicks on select */
      opacity: 0.9;
    }
    /* Normal vs locked styles */
    .field input:disabled, .field select:disabled { 
      background: rgba(189, 189, 189, 1); 
      color: rgba(0,0,0,0.8);
    }
    .field.locked { opacity: 1; }
    /* Right-aligned fields */
    .field.right-align input, .field.right-align select { text-align: right; }
    /* Center-aligned fields */
    .field.center-align input, .field.center-align select { text-align: center; }
    /* Transparent fields */
    .field.transparent input, .field.transparent select { outline: none; background: transparent; }

    /* Push buttons */
    /* Push buttons hug their content like text; fitTextSpans() sizes the grid span to match */
    .push { display: inline-flex; align-items: center; gap: 0.4em; align-self: center; height: 1em; font-family: inherit; font-size: inherit; }
    .grid > .push { justify-self: start; width: max-content; min-width: var(--col-w); }
    .push .label { white-space: nowrap; line-height: 1em; }
    .push.select { height: auto; }
    .push .btn { padding: 1px 6px; background: rgba(255,255,255,1); color: rgba(0,0,0,1); border: 1px solid var(--vscode-input-border); border-radius: 4px; font-family: inherit; font-size: inherit; line-height: calc(1em); cursor: default; }
    .push input[type="radio"], .push input[type="checkbox"] { width: 1em; height: 1em; margin: 0; }

    /* Bottom Bar */
    .bottom-bar {
      margin-top: 8px;
      padding: 8px 12px;
      background: rgba(240, 240, 240, 1);
      border: 1px solid var(--vscode-editorWidget-border);
      border-radius: 4px;
      display: flex;
      gap: 12px;
      align-items: center;
      flex-wrap: wrap;
    }
    .bottom-bar-button {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      font-family: inherit;
      font-size: inherit;
    }
    .bottom-bar-button .label {
      white-space: nowrap;
      line-height: 1em;
    }
    .bottom-bar-button .btn {
      padding: 3px 12px;
      background: rgba(255,255,255,1);
      color: rgba(0,0,0,1);
      border: 1px solid var(--vscode-input-border);
      border-radius: 4px;
      font-family: inherit;
      font-size: inherit;
      line-height: calc(1em + 4px);
      cursor: default;
    }
    .bottom-bar-button input[type="radio"],
    .bottom-bar-button input[type="checkbox"] {
      width: 1em;
      height: 1em;
      margin: 0;
    }

    /* Images */
    .image { position: relative; overflow: hidden; }
    .image img { width: 100%; height: 100%; object-fit: fill; display: block; }

    /* Previews */
    .preview { position: relative; overflow: hidden; background: rgba(245, 245, 250, 1); border: 1px solid rgba(180, 180, 200, 0.5); border-radius: 4px; }
    .preview-content { width: 100%; height: 100%; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 6px; padding: 8px; }
    .preview-icon { font-size: 24px; opacity: 0.6; }
    .preview-label { font-size: 11px; font-weight: 600; color: rgba(0,0,0,0.7); text-align: center; }
    .preview-path { font-size: 9px; color: rgba(0,0,0,0.5); text-align: center; word-break: break-all; }

    /* Context Menu */
    .context-menu {
      position: fixed;
      background: rgba(255, 255, 255, 1);
      border: 1px solid var(--vscode-editorWidget-border);
      box-shadow: 0 2px 8px rgba(0,0,0,.15);
      z-index: 1000;
      min-width: 180px;
      border-radius: 4px;
      overflow: hidden;
    }
    .context-menu-item {
      padding: 6px 12px;
      cursor: pointer;
      font-size: 12px;
      color: rgba(0,0,0,1);
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .context-menu-item:hover {
      background: rgba(0, 120, 212, 0.1);
    }

    /* Modal Dialog */
    .modal-overlay {
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      background: rgba(0,0,0,0.4);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 2000;
    }
    .modal {
      background: rgba(255, 255, 255, 1);
      border: 1px solid var(--vscode-editorWidget-border);
      border-radius: 6px;
      padding: 20px;
      min-width: 400px;
      max-width: 600px;
      box-shadow: 0 4px 16px rgba(0,0,0,.2);
    }
    .modal h3 {
      margin: 0 0 16px 0;
      font-size: 16px;
      color: rgba(0,0,0,1);
    }
    .modal-form {
      display: flex;
      flex-direction: column;
      gap: 12px;
    }
    .modal-field {
      display: flex;
      flex-direction: column;
      gap: 4px;
    }
    .modal-field label {
      font-size: 12px;
      font-weight: 600;
      color: rgba(0,0,0,1);
    }
    .modal-field input,
    .modal-field textarea,
    .modal-field select {
      padding: 6px 8px;
      border: 1px solid var(--vscode-input-border);
      border-radius: 3px;
      font-family: inherit;
      font-size: 13px;
      background: rgba(255, 255, 255, 1);
      color: rgba(0,0,0,1);
    }
    .modal-field textarea {
      min-height: 60px;
      resize: vertical;
    }
    .modal-field small {
      font-size: 11px;
      color: rgba(0,0,0,0.6);
    }
    .modal-field small.fv-hint { display: block; white-space: pre-line; font-style: italic; }
    .modal-field small.fv-hint:empty { display: none; }
    .modal-buttons {
      display: flex;
      gap: 8px;
      justify-content: flex-end;
      margin-top: 16px;
    }
    .modal-button {
      padding: 6px 16px;
      border: 1px solid var(--vscode-input-border);
      border-radius: 3px;
      font-size: 13px;
      cursor: pointer;
      background: rgba(255, 255, 255, 1);
      color: rgba(0,0,0,1);
    }
    .modal-button.primary {
      background: var(--vscode-button-background, #0078d4);
      color: var(--vscode-button-foreground, #fff);
      border-color: var(--vscode-button-background, #0078d4);
    }
    .modal-button:hover {
      opacity: 0.9;
    }
    .modal-button.danger {
      background: #c42b1c;
      border-color: #c42b1c;
      color: #fff;
    }
    .modal-discard-bar {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-top: 12px;
      padding: 8px 10px;
      border: 1px solid rgba(196, 43, 28, 0.35);
      border-radius: 4px;
      background: rgba(196, 43, 28, 0.08);
      font-size: 12px;
      color: rgba(0,0,0,1);
    }
    .modal-discard-bar span { margin-right: auto; font-weight: 600; }
    .context-menu-item.kbd-active { background: rgba(0, 120, 212, 0.1); }
    .context-menu-shortcut {
      margin-left: auto;
      padding-left: 24px;
      font-size: 11px;
      color: rgba(0,0,0,0.5);
    }
    .shortcuts-modal { max-width: 640px; }
    .shortcuts-grid {
      display: grid;
      grid-template-columns: auto 1fr;
      gap: 6px 16px;
      align-items: center;
      max-height: 60vh;
      overflow: auto;
      font-size: 12px;
      color: rgba(0,0,0,1);
    }
    .shortcuts-grid h4 {
      grid-column: 1 / -1;
      margin: 10px 0 0;
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: .04em;
      color: rgba(0,0,0,0.6);
    }
    .shortcuts-grid h4:first-child { margin-top: 0; }
    .shortcuts-grid kbd {
      display: inline-block;
      margin-right: 2px;
      padding: 1px 6px;
      border: 1px solid rgba(0,0,0,0.25);
      border-bottom-width: 2px;
      border-radius: 3px;
      background: #f6f6f6;
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 11px;
      white-space: nowrap;
    }
    .hidden { display: none !important; }

    /* Triggers Panel */
    .main-container {
      display: flex;
      gap: 16px;
      align-items: flex-start;
    }
    .side-panels {
      display: flex;
      flex-direction: column;
      gap: 12px;
      flex-shrink: 0;
    }
    .triggers-panel {
      background: rgba(250, 250, 250, 1);
      border: 1px solid var(--vscode-editorWidget-border);
      border-radius: 4px;
      padding: 12px;
      width: 280px;
      max-width: 32vw;
      box-sizing: border-box;
    }
    .triggers-panel h4 {
      margin: 0 0 12px 0;
      font-size: 13px;
      font-weight: 600;
      color: rgba(0,0,0,1);
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    .trigger-item {
      background: rgba(255, 255, 255, 1);
      border: 1px solid var(--vscode-editorWidget-border);
      border-radius: 3px;
      padding: 8px;
      margin-bottom: 8px;
      font-size: 11px;
      position: relative;
      cursor: pointer;
      transition: all 0.2s ease;
    }
    .trigger-item:hover {
      border-color: var(--vscode-focusBorder, #0078d4);
      box-shadow: 0 1px 4px rgba(0,0,0,0.1);
    }
    .hidden-field-item {
      cursor: grab;
    }
    .hidden-field-item.dragging {
      opacity: 0.65;
      cursor: grabbing;
    }
    .trigger-target {
      font-weight: 600;
      color: var(--vscode-focusBorder, #0078d4);
      margin-bottom: 4px;
    }
    .trigger-program {
      color: rgba(0,0,0,0.8);
      font-family: 'Consolas', 'Courier New', monospace;
    }
    .trigger-actions {
      position: absolute;
      top: 4px;
      right: 4px;
      display: flex;
      gap: 4px;
      opacity: 0;
      transition: opacity 0.2s ease;
    }
    .trigger-item:hover .trigger-actions {
      opacity: 1;
    }
    .trigger-action-btn {
      width: 18px;
      height: 18px;
      border-radius: 3px;
      border: none;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 10px;
      background: rgba(240, 240, 240, 1);
      color: rgba(0,0,0,0.7);
    }
    .trigger-action-btn:hover {
      background: rgba(220, 220, 220, 1);
    }
    .trigger-action-btn.delete:hover {
      background: #c42b1c;
      color: #fff;
    }
    .add-trigger-btn {
      padding: 4px 8px;
      border: 1px solid var(--vscode-input-border);
      border-radius: 3px;
      font-size: 11px;
      cursor: pointer;
      background: rgba(255, 255, 255, 1);
      color: rgba(0,0,0,1);
    }
    .add-trigger-btn:hover {
      background: rgba(240, 240, 240, 1);
    }
    .sidebar-empty {
      font-size: 11px;
      color: rgba(0,0,0,0.6);
      line-height: 1.5;
    }
    .sidebar-note {
      font-size: 11px;
      color: rgba(0,0,0,0.65);
      line-height: 1.5;
      margin-bottom: 8px;
    }

    /* Tab Order Mode */
    .tab-order-mode {
      box-shadow: 0 0 0 3px var(--vscode-focusBorder, #0078d4) !important;
      background: rgba(255, 215, 0, 0.15) !important;
    }
    .tab-order-active #tabOrderBtn {
      background: var(--vscode-button-background, #0078d4);
      color: var(--vscode-button-foreground, #fff);
      font-weight: 600;
    }
    .field .tab-order-badge,
    .push .tab-order-badge {
      position: absolute;
      top: -10px;
      left: -10px;
      width: 20px;
      height: 20px;
      background: var(--vscode-button-background, #0078d4);
      color: #fff;
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 11px;
      font-weight: 600;
      z-index: 20;
      box-shadow: 0 2px 4px rgba(0,0,0,0.3);
    }

    /* Grid cell highlight */
    .grid-cell-highlight {
      position: absolute;
      border: 2px solid var(--vscode-focusBorder, #0078d4);
      background: rgba(0, 120, 212, 0.15);
      pointer-events: none;
      z-index: 5;
      box-sizing: border-box;
    }
    /* Where a dragged element will land */
    .drop-target-outline {
      position: absolute;
      border: 2px dashed var(--vscode-focusBorder, #0078d4);
      pointer-events: none;
      z-index: 101;
      box-sizing: border-box;
    }
  `;

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
    <div class="trigger-item" data-trigger-idx="${idx}" data-trigger-line="${t.line}" data-trigger-program="${escapeAttr(t.program)}">
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
    <div class="trigger-item hidden-field-item" draggable="true" data-type="field" data-field-idx="${fieldIdx}" data-row="${f.row}" data-col="${f.col}" data-span="${Math.max(1, f.len + (f.values.length > 0 ? 2 : 0))}" onclick="showHiddenFieldInSource(${fieldIdx})" title="Drag onto the preview to unhide, or click to show in source">
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

  return `<!DOCTYPE html>
  <html>
  <head>
    <meta charset="UTF-8" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline' ${webview.cspSource}; img-src ${webview.cspSource} https:; script-src 'unsafe-inline' ${webview.cspSource};" />
    <style>${styles}</style>
    <script>
    // Bootstrap: runs once per page load. Later renders arrive as 'frmSoftUpdate' messages
    // and are swapped into this page in place instead of reloading it (which flashes).
    (function(){
      if (window.__frmBoot) return;
      window.__frmBoot = true;
      var api = null;
      try { if (typeof acquireVsCodeApi === 'function') { api = acquireVsCodeApi(); } } catch (e) { /* ignore */ }
      window.__frmVscodeApi = api;

      // Track window/document listeners added by the page script so a swap can remove them.
      // Listeners on body elements go away with the replaced elements.
      var tracked = [];
      var origAdd = EventTarget.prototype.addEventListener;
      [window, document].forEach(function(target) {
        target.addEventListener = function(type, fn, opts) {
          tracked.push([target, type, fn, opts]);
          return origAdd.call(target, type, fn, opts);
        };
      });

      var pendingHtml = null;
      var retryTimer = null;

      function isBusy() {
        try { return !!(window.__frmHooks && window.__frmHooks.isBusy()); } catch (e) { return false; }
      }

      function tryApply() {
        if (pendingHtml === null) return;
        if (isBusy()) {
          // Hold the update until the drag, dialog or tab-order mode ends
          if (!retryTimer) retryTimer = setInterval(tryApply, 200);
          return;
        }
        if (retryTimer) { clearInterval(retryTimer); retryTimer = null; }
        var html = pendingHtml;
        pendingHtml = null;
        applyHtml(html);
      }

      function applyHtml(html) {
        var failed = false;
        function onError() { failed = true; }
        origAdd.call(window, 'error', onError);
        try {
          var carry = { selectionKey: null };
          try { if (window.__frmHooks) carry.selectionKey = window.__frmHooks.getSelectionKey(); } catch (e) { /* ignore */ }
          var scrollX = window.scrollX;
          var scrollY = window.scrollY;
          var next = new DOMParser().parseFromString(html, 'text/html');

          tracked.splice(0).forEach(function(t) { t[0].removeEventListener(t[1], t[2], t[3]); });
          window.__frmHooks = null;

          var oldStyles = Array.prototype.slice.call(document.head.querySelectorAll('style'));
          var newStyles = Array.prototype.slice.call(next.head.querySelectorAll('style'));
          var sameStyles = oldStyles.length === newStyles.length && oldStyles.every(function(s, i) { return s.textContent === newStyles[i].textContent; });
          if (!sameStyles) {
            oldStyles.forEach(function(s) { s.remove(); });
            newStyles.forEach(function(s) { document.head.appendChild(document.importNode(s, true)); });
          }

          document.body.className = next.body.className;
          document.body.innerHTML = next.body.innerHTML;
          window.__frmCarry = carry;
          // Scripts inserted via innerHTML are inert; recreate them so they run
          Array.prototype.slice.call(document.body.querySelectorAll('script')).forEach(function(old) {
            var s = document.createElement('script');
            s.textContent = old.textContent;
            old.parentNode.replaceChild(s, old);
          });
          window.scrollTo(scrollX, scrollY);
        } catch (e) {
          failed = true;
        }
        window.removeEventListener('error', onError);
        if (failed && api) {
          api.postMessage({ command: 'frmSoftUpdateFailed' });
        }
      }

      origAdd.call(window, 'message', function(ev) {
        var msg = ev.data;
        if (msg && msg.command === 'frmSoftUpdate' && typeof msg.html === 'string') {
          pendingHtml = msg.html;
          tryApply();
        }
      });

      if (api) api.postMessage({ command: 'frmReady' });
    })();
    </script>
  </head>
  <body>
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
            <div class="grid gridlines" style="width: calc(${model.cols} * var(--col-w) + ${(model.cols - 1)} * var(--col-gap)); height: calc(${model.rows} * var(--row-h) + ${(model.rows - 1)} * var(--row-gap));">
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
            <div class="triggers-panel">
              <h4>Hidden Fields (${hiddenFields.length})</h4>
              ${hiddenFields.length > 0 ? '<div class="sidebar-note">Drag a hidden field onto the preview to place it back on the form.</div>' : ''}
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

    <!-- Keyboard Shortcuts -->
    <div id="shortcutsModal" class="modal-overlay hidden">
      <div class="modal shortcuts-modal">
        <h3>Keyboard Shortcuts</h3>
        <div class="shortcuts-grid">
          <h4>Selected element</h4>
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

    <script>
    (function(){
      var vscodeApi;
      // Acquired once by the head bootstrap; this script re-runs on every in-place update
      vscodeApi = window.__frmVscodeApi || undefined;
      var root = document.documentElement;
      var basePx = 11; // default matches CSS
      var winstyle = ${JSON.stringify(model.winstyle || 'VXUI')}; // vxdbase_winstyle from FRM file
      var existingTabOrder = ${JSON.stringify(model.tabOrder || [])}; // existing tab_order from FRM file
      var defaultIgnoreValue = winstyle.toLowerCase() === 'only' ? 4 : 7;
      try {
        var fs = getComputedStyle(root).getPropertyValue('--frm-font-size').trim();
        var m = fs.match(/([\d.]+)/);
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
        fitTextSpans();
      }

      // Each text's and push button's grid span = its rendered width in whole columns (min 1), so drop outlines
      // and the keep-inside-window checks use the size you see. Re-run when the font size changes.
      // Columns between an element's file column and where it is drawn (boxed text labels)
      function colOffset(el) {
        return (el && parseInt(el.getAttribute('data-col-offset'), 10)) || 0;
      }

      // Start the box's top line to the right of a boxed label at the measured end of the text,
      // leaving the same space as between the left line segment and the start of the text
      function fitBoxGaps() {
        document.querySelectorAll('.grid > .text[data-box-rows]').forEach(function(el) {
          var box = document.querySelector('.grid > .box[data-row="' + el.getAttribute('data-row') + '"][data-col="' + el.getAttribute('data-col') + '"]');
          var right = box && box.querySelector('.hrow.top.gap-right');
          if (!right) return;
          var left = box.querySelector('.hrow.top.gap-left');
          var t = el.getBoundingClientRect();
          var b = box.getBoundingClientRect();
          var pad = t.left - (left ? left.getBoundingClientRect().right : b.left);
          var start = t.right - b.left + Math.max(0, pad);
          right.style.left = start + 'px';
          right.style.display = start < b.width - parseFloat(getComputedStyle(right).right || '0') ? '' : 'none';
        });
      }

      function fitTextSpans() {
        try {
          var m = getGridMetrics();
          if (!m || !(m.colPitch > 0)) return;
          var colGap = m.colPitch - m.colWidth;
          document.querySelectorAll('.grid > .text.draggable, .grid > .push.draggable').forEach(function(el) {
            var w = el.getBoundingClientRect().width;
            if (!(w > 0)) return; // hidden (other tab): keep the estimate until it is shown
            var span =Math.max(1, Math.ceil((w + colGap) / m.colPitch - 0.01));
            var col = parseInt(el.getAttribute('data-col'), 10);
            if (!isFinite(col)) return;
            el.style.gridColumn = (col + colOffset(el)) + ' / span ' + span;
          });
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
      window.addEventListener('resize', setColWidth);

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
      applyZoom(${initialZoom}, true);
      // Initialize gridlines from state or provided initial value
      (function(){
        var initial = (function(){
          try {
            var state = vscodeApi && vscodeApi.getState ? (vscodeApi.getState() || {}) : {};
            if (typeof state.gridOn === 'boolean') return state.gridOn;
          } catch (e) {}
          return ${typeof initialGridOn === 'boolean' ? JSON.stringify(initialGridOn) : 'false'};
        })();
        applyGrid(initial, true);
      })();

      // Tabs logic
      var tabs = ${JSON.stringify(model.tabs ?? [])};
      var tabTexts = ${JSON.stringify(model.tabTexts ?? {})};
      var tabFields = ${JSON.stringify(model.tabFields ?? {})};
      var tabPushButtons = ${JSON.stringify(model.tabPushButtons ?? {})};
      var tabImages = ${JSON.stringify(model.tabImages ?? {})};
      var initialActiveTab = ${JSON.stringify(initialActiveTab ?? null)};
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
              var id = Number(tb.getAttribute('data-tab-id'));
              currentActiveTab = id;
              applyTab(id);
              fitTextSpans();
              try {
                if (vscodeApi && vscodeApi.postMessage) {
                  vscodeApi.postMessage({ command: 'setActiveTab', id: id });
                }
                if (vscodeApi && vscodeApi.setState) {
                  var prev = (vscodeApi.getState && vscodeApi.getState()) || {};
                  vscodeApi.setState(Object.assign({}, prev, { activeTabId: id }));
                }
              } catch (e) { /* ignore */ }
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
        var hasTabs = ${model.tabs && model.tabs.length ? 'true' : 'false'};
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
        var rows = (typeof gridRows === 'number' && gridRows > 0) ? gridRows : ${model.rows};
        var cols = (typeof gridCols === 'number' && gridCols > 0) ? gridCols : ${model.cols};
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
                  if (selectedElement === elementContextMenuState.element) {
                    selectedElement = null;
                    selectedElementKey = null;
                  }
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
        ${model.tabs && model.tabs.length ? model.tabs.map(t => `
          if (${JSON.stringify(model.tabTexts?.[t.id] || [])}${model.tabFields ? ` || ${JSON.stringify(model.tabFields[t.id] || [])}` : ''}${model.tabPushButtons ? ` || ${JSON.stringify(model.tabPushButtons[t.id] || [])}` : ''}${model.tabImages ? ` || ${JSON.stringify(model.tabImages[t.id] || [])}` : ''}${model.tabPreviews ? ` || ${JSON.stringify(model.tabPreviews[t.id] || [])}` : ''}) {
            var list = (elementType === 'text' ? ${JSON.stringify(model.tabTexts?.[t.id] || [])} :
                        elementType === 'field' ? ${JSON.stringify(model.tabFields?.[t.id] || [])} :
                        elementType === 'pushbutton' ? ${JSON.stringify(model.tabPushButtons?.[t.id] || [])} :
                        elementType === 'image' ? ${JSON.stringify(model.tabImages?.[t.id] || [])} :
                        elementType === 'preview' ? ${JSON.stringify(model.tabPreviews?.[t.id] || [])} : []);
            if (list.indexOf(elementIndex) !== -1) {
              currentTabs.push(${t.id});
            }
          }
        `).join('') : ''}
        
        // Check if element is visible on all tabs
        var allTabs = [${model.tabs ? model.tabs.map(t => t.id).join(', ') : ''}];
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
              values = valuesText.split('\\n').map(function(v) { return v.trim(); }).filter(Boolean);
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
        var re = /path:([^"\\s]+)/gi;
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
          if (hint) hint.textContent = (msg.lines || []).join('\\n');
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
      var selectedElement = null;
      var selectedElementKey = (window.__frmCarry && window.__frmCarry.selectionKey) || null; // Store selection key for persistence

      function setupDragAndDrop() {
        var grid = document.querySelector('.grid');
        if (!grid) return;

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
            selectElement(this);
          });
          
          element.addEventListener('dragstart', function(e) {
            draggedElement = this;
            this.classList.add('dragging');
            
            var rect = this.getBoundingClientRect();
            var gridRect = grid.getBoundingClientRect();
            dragOffset.x = e.clientX - rect.left;
            dragOffset.y = e.clientY - rect.top;
            
            e.dataTransfer.effectAllowed = 'move';
            e.dataTransfer.setData('text/html', this.outerHTML);
          });

          element.addEventListener('dragend', function(e) {
            this.classList.remove('dragging');
            draggedElement = null;
            grid.classList.remove('drag-over');
            hideDropTarget();
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
          var m = /span\\s+(\\d+)/.exec(String(end || ''));
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
      }

      function updateElementPosition(element, newRow, newCol) {
        // A boxed text label carries its box along (the box sits at the label's file row/col)
        if (element.getAttribute('data-type') === 'text' && element.hasAttribute('data-box-rows')) {
          var box = document.querySelector('.grid > .box[data-row="' + element.getAttribute('data-row') + '"][data-col="' + element.getAttribute('data-col') + '"]');
          if (box) {
            box.setAttribute('data-row', newRow);
            box.setAttribute('data-col', newCol);
            var bRows = String(box.style.gridRow || '').match(/span (\\d+)/);
            var bCols = String(box.style.gridColumn || '').match(/span (\\d+)/);
            box.style.gridRow = newRow + ' / span ' + (bRows ? bRows[1] : '1');
            box.style.gridColumn = newCol + ' / span ' + (bCols ? bCols[1] : '1');
          }
        }
        element.setAttribute('data-row', newRow);
        element.setAttribute('data-col', newCol);
        
        // Update grid positioning
        var currentStyle = element.style.gridColumn;
        var spanMatch = currentStyle.match(/span (\\d+)/);
        var span = spanMatch ? spanMatch[1] : '1';
        
        // Keep a row span (images, previews) when moving
        var rowSpanMatch = String(element.style.gridRow || '').match(/span (\\d+)/);
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

      function selectElement(element) {
        // Remove selection from previously selected element
        if (selectedElement) {
          selectedElement.classList.remove('selected');
        }
        
        // Select new element and store its key for persistence
        selectedElement = element;
        element.classList.add('selected');
        element.focus();
        
        // Store selection key for persistence across updates
        var type = element.getAttribute('data-type');
        var key = null;
        if (type === 'text') {
          key = element.getAttribute('data-text-idx') || 'text-no-idx';
        } else if (type === 'field') {
          key = element.getAttribute('data-field-idx') || 'field-no-idx';
        } else if (type === 'pushbutton') {
          key = element.getAttribute('data-push-idx') || 'push-no-idx';
        } else if (type === 'image') {
          key = element.getAttribute('data-image-idx') || 'image-no-idx';
        } else if (type === 'preview') {
          key = element.getAttribute('data-preview-idx') || 'preview-no-idx';
        }
        selectedElementKey = type + ':' + key;
      }

      function restoreSelection() {
        if (!selectedElementKey) return;
        
        var parts = selectedElementKey.split(':');
        var type = parts[0];
        var key = parts[1];
        
        var selector;
        if (type === 'text') {
          if (key === 'text-no-idx') {
            selector = '.text:not([data-text-idx])';
          } else {
            selector = '.text[data-text-idx="' + key + '"]';
          }
        } else if (type === 'field') {
          if (key === 'field-no-idx') {
            selector = '.field:not([data-field-idx])';
          } else {
            selector = '.field[data-field-idx="' + key + '"]';
          }
        } else if (type === 'pushbutton') {
          if (key === 'push-no-idx') {
            selector = '.push:not([data-push-idx])';
          } else {
            selector = '.push[data-push-idx="' + key + '"]';
          }
        } else if (type === 'image') {
          if (key === 'image-no-idx') {
            selector = '.image:not([data-image-idx])';
          } else {
            selector = '.image[data-image-idx="' + key + '"]';
          }
        } else if (type === 'preview') {
          if (key === 'preview-no-idx') {
            selector = '.preview:not([data-preview-idx])';
          } else {
            selector = '.preview[data-preview-idx="' + key + '"]';
          }
        }
        
        if (selector) {
          var element = document.querySelector(selector);
          if (element) {
            selectedElement = element;
            element.classList.add('selected');
            // Don't call focus() here to avoid interrupting keyboard navigation
          }
        }
      }

      function moveSelectedElement(deltaRow, deltaCol) {
        if (!selectedElement) return;
        
        var currentRow = parseInt(selectedElement.getAttribute('data-row'));
        var currentCol = parseInt(selectedElement.getAttribute('data-col'));
        
        var newRow = Math.max(1, Math.min(${model.rows}, currentRow + deltaRow));
        var newCol = Math.max(1, Math.min(${model.cols}, currentCol + deltaCol));
        
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
          if (!selectedElement || shortcutsBlocked(e)) return;
          
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
              if (selectedElement) {
                selectedElement.classList.remove('selected');
                selectedElement = null;
                selectedElementKey = null;
                handled = true;
              }
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
                    selectedElement = null;
                    selectedElementKey = null;
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
          if (e.target.closest('.modal-overlay, .context-menu')) return;
          if (!e.target.closest('.draggable') && selectedElement) {
            selectedElement.classList.remove('selected');
            selectedElement = null;
            selectedElementKey = null;
          }
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
      var portRows = ${Number(model.portRows ?? 0)}; // as written in the file, 0 = auto
      var portCols = ${Number(model.portCols ?? 0)};
      var gridRows = ${model.rows}; // as displayed
      var gridCols = ${model.cols};

      function placementEnd(start, end) {
        var s = parseInt(start, 10);
        if (!isFinite(s)) return 0;
        var m = /^span\\s+(\\d+)/.exec(String(end || '').trim());
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
          label.textContent = rows + ' rows \\u00d7 ' + cols + ' cols';
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
        var m = /^span\\s+(\\d+)/.exec(end);
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
            : b.rows + ' rows \\u00d7 ' + b.cols + ' cols';
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
      var BOX_OFFSET = ${BOX_LABEL_OFFSET};
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
          label.textContent = b.rows + ' rows \\u00d7 ' + b.cols + ' cols';
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
        var m = /span (\\d+)/.exec(String(el.style.gridRow || ''));
        return m ? parseInt(m[1], 10) : 1;
      }

      // Same column, one row down; stays put when that would leave the form
      function duplicateSelectedElement() {
        var el = selectedElement;
        if (!el || tabOrderMode || !vscodeApi || !vscodeApi.postMessage) return;
        var type = el.getAttribute('data-type');
        var index = elementIndexOf(el);
        var row = parseInt(el.getAttribute('data-row'), 10);
        if (!type || !index || !isFinite(row)) return;
        var newRow = row + rowSpanOfElement(el) <= ${model.rows} ? row + 1 : row;
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
          openElementEditor(selectedElement);
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
      fitTextSpans();
      
      // Restore selection if it existed before this update
      restoreSelection();
      window.__frmCarry = null;

      // Hooks for the head bootstrap's in-place updates
      window.__frmHooks = {
        isBusy: function() {
          return !!draggedElement || !!sizeDrag || !!elResize || tabOrderMode ||!!document.querySelector('.modal-overlay:not(.hidden)');
        },
        getSelectionKey: function() {
          return pendingSelectionKey || (selectedElement ? selectedElementKey : null);
        }
      };
    })();
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
