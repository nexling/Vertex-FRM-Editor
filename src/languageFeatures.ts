// Completion, hover, diagnostics and renumbering for FRM files in the text editor.
import * as vscode from 'vscode';
import { findProblems, MIXED_BUTTONS } from './diagnostics';
import { buttonSpellings, parseStatements } from './frmStatements';
import { completionsAt, keywordAt, keywordHelp } from './keywordContext';
import { convertPushbuttons, LineRange, renumberItems } from './renumber';

const LANGUAGE = 'vertexfrm';
const SELECTOR: vscode.DocumentSelector = [{ scheme: 'file', language: LANGUAGE }, { scheme: 'untitled', language: LANGUAGE }];
const CONVERT_COMMAND = 'vertexFrmPreview.convertPushbuttons';
const CONVERT_TITLE = 'Convert all pushbuttons to buttons';
const DIAGNOSTICS_DELAY_MS = 250;

export function registerLanguageFeatures(context: vscode.ExtensionContext, imageExists: (file: string) => boolean | undefined): void {
  registerDiagnostics(context, imageExists);
  context.subscriptions.push(
    vscode.languages.registerCompletionItemProvider(SELECTOR, {
      provideCompletionItems(doc, position) {
        return completionsAt(doc.lineAt(position.line).text, position.character, previousLine(doc, position.line)).map(k => {
          const item = new vscode.CompletionItem(k.label, vscode.CompletionItemKind.Keyword);
          item.documentation = new vscode.MarkdownString(keywordHelp(k));
          return item;
        });
      },
    }),
    vscode.languages.registerHoverProvider(SELECTOR, {
      provideHover(doc, position) {
        const range = doc.getWordRangeAtPosition(position, /\w+/);
        if (!range) return undefined;
        const k = keywordAt(doc.lineAt(position.line).text, range.start.character, doc.getText(range), previousLine(doc, position.line));
        return k && new vscode.Hover(new vscode.MarkdownString(keywordHelp(k)), range);
      },
    }),
    vscode.languages.registerCodeActionsProvider(SELECTOR, {
      provideCodeActions(_doc, _range, actionContext) {
        const diagnostics = actionContext.diagnostics.filter(d => d.code === MIXED_BUTTONS);
        if (!diagnostics.length) return [];
        const action = new vscode.CodeAction(CONVERT_TITLE, vscode.CodeActionKind.QuickFix);
        action.diagnostics = diagnostics;
        action.command = { command: CONVERT_COMMAND, title: CONVERT_TITLE, arguments: [_doc.uri] };
        return [action];
      },
    }, { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] }),
    vscode.commands.registerCommand(CONVERT_COMMAND, async (uri?: vscode.Uri) => {
      const doc = uri ? await vscode.workspace.openTextDocument(uri) : vscode.window.activeTextEditor?.document;
      if (doc) await convertButtons(doc);
    }),
    vscode.commands.registerCommand('vertexFrmPreview.renumberFields', () => renumberCommand('field')),
    vscode.commands.registerCommand('vertexFrmPreview.renumberTexts', () => renumberCommand('text')),
    vscode.commands.registerCommand('vertexFrmPreview.renumberButtons', () => renumberCommand('button')),
  );
  warnAboutOldExtension();
}

export function usesMixedButtons(text: string): boolean {
  return buttonSpellings(parseStatements(splitLines(text))).mixed;
}

/** Turn every pushbutton into a button, as one undo step. */
export async function convertButtons(doc: vscode.TextDocument): Promise<void> {
  const lines = splitLines(doc.getText());
  await replaceLines(doc, lines, convertPushbuttons(lines).lines);
}

async function renumberCommand(kind: 'field' | 'text' | 'button'): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.languageId !== LANGUAGE) {
    vscode.window.showWarningMessage('Open a FRM file to renumber it.');
    return;
  }
  const doc = editor.document;
  const original = splitLines(doc.getText());
  const version = doc.version;
  let lines = original;
  let ranges: LineRange[] = editor.selections.filter(s => !s.isEmpty).map(s => ({
    start: s.start.line,
    // A range ending at column 0 does not include that last line
    end: s.end.character === 0 ? s.end.line - 1 : s.end.line,
  }));

  if (kind === 'button' && usesMixedButtons(doc.getText())) {
    const choice = await vscode.window.showWarningMessage(
      'A form can not use both button and pushbutton. Do you want to convert all pushbuttons to buttons?',
      { modal: true },
      'Convert'
    );
    if (choice !== 'Convert') return;
    if (doc.version !== version) {
      vscode.window.showWarningMessage('The file changed while the dialog was open. Run the command again.');
      return;
    }
    const converted = convertPushbuttons(lines);
    lines = converted.lines;
    ranges = ranges.map(r => ({ start: converted.newLine(r.start), end: converted.newLine(r.end) }));
  }

  const result = renumberItems(lines, kind, ranges);
  if ('error' in result) {
    vscode.window.showErrorMessage(result.error);
    return;
  }
  const changed = await replaceLines(doc, original, result.lines);
  if (!changed) {
    vscode.window.showInformationMessage(`The ${kind} indexes are already in order.`);
    return;
  }
  // These look like they carry a field number, but how Vertex uses them is not known, so they are left alone
  const unknown = parseStatements(result.lines).filter(s => s.keyword.endsWith('_of_field'));
  if (kind === 'field' && unknown.length) {
    vscode.window.showWarningMessage(
      `Fields renumbered, but these lines were not changed and may need a new field number: ${unknown.map(s => `${s.keyword} (line ${s.startLine + 1})`).join(', ')}`
    );
  }
}

/** Replace the lines that differ, as one undo step. Returns whether anything changed. */
async function replaceLines(doc: vscode.TextDocument, before: string[], after: string[]): Promise<boolean> {
  const edit = new vscode.WorkspaceEdit();
  const eol = doc.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
  let count = 0;
  if (before.length === after.length) {
    before.forEach((line, i) => {
      if (line === after[i]) return;
      edit.replace(doc.uri, new vscode.Range(i, 0, i, line.length), after[i]);
      count++;
    });
  } else {
    edit.replace(doc.uri, new vscode.Range(0, 0, doc.lineCount, 0), after.join(eol));
    count++;
  }
  if (!count) return false;
  if (!await vscode.workspace.applyEdit(edit)) vscode.window.showErrorMessage('Failed to change the FRM file');
  return true;
}

function registerDiagnostics(context: vscode.ExtensionContext, imageExists: (file: string) => boolean | undefined): void {
  const collection = vscode.languages.createDiagnosticCollection(LANGUAGE);
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const severities = {
    error: vscode.DiagnosticSeverity.Error,
    warning: vscode.DiagnosticSeverity.Warning,
    info: vscode.DiagnosticSeverity.Information,
  };

  const cancel = (doc: vscode.TextDocument) => {
    const key = doc.uri.toString();
    clearTimeout(timers.get(key));
    timers.delete(key);
  };
  const check = (doc: vscode.TextDocument) => {
    cancel(doc);
    const enabled = vscode.workspace.getConfiguration('vertexFrmPreview', doc).get<boolean>('diagnostics', true);
    if (!enabled || doc.isClosed || vscode.languages.match(SELECTOR, doc) === 0) {
      collection.delete(doc.uri);
      return;
    }
    collection.set(doc.uri, findProblems(splitLines(doc.getText()), imageExists).map(p => {
      const first = doc.lineAt(p.startLine);
      const range = new vscode.Range(
        p.startLine, first.firstNonWhitespaceCharacterIndex, p.endLine, doc.lineAt(p.endLine).text.trimEnd().length);
      const d = new vscode.Diagnostic(range, p.message, severities[p.severity]);
      d.source = 'FRM';
      d.code = p.code;
      return d;
    }));
  };

  context.subscriptions.push(
    collection,
    vscode.workspace.onDidOpenTextDocument(check),
    vscode.workspace.onDidCloseTextDocument(doc => {
      cancel(doc);
      collection.delete(doc.uri);
    }),
    vscode.workspace.onDidChangeTextDocument(e => {
      cancel(e.document);
      timers.set(e.document.uri.toString(), setTimeout(() => check(e.document), DIAGNOSTICS_DELAY_MS));
    }),
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('vertexFrmPreview.diagnostics')) vscode.workspace.textDocuments.forEach(check);
    }),
    { dispose: () => timers.forEach(t => clearTimeout(t)) },
  );
  vscode.workspace.textDocuments.forEach(check);
}

/** The old extension registers the same language, so running both doubles up completion and hover. */
async function warnAboutOldExtension(): Promise<void> {
  if (!vscode.extensions.getExtension('Emil-TTM.vertex-frm')) return;
  const choice = await vscode.window.showWarningMessage(
    'The Vertex-FRM extension is now part of this one. Uninstall Vertex-FRM so they do not run together.',
    'Show Extension'
  );
  if (choice) vscode.commands.executeCommand('workbench.extensions.search', '@installed Vertex-FRM');
}

function splitLines(text: string): string[] {
  return text.split(/\r?\n/);
}

function previousLine(doc: vscode.TextDocument, line: number): string | undefined {
  return line > 0 ? doc.lineAt(line - 1).text : undefined;
}
