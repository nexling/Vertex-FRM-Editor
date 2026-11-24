# Vertex FRM

This VS Code extension supports Vertex FRM form files (`.frm`, `.vxf`, `.form`, `.vf`): a live, editable preview plus language features in the text editor. It replaces the separate Vertex-FRM extension; uninstall that one.

## Text editor

- Syntax colours, including tagged comments (`TODO`, `PROBLEM`, `TEMP`, `DEBUG`, `OLD`, `NEW`, `QUEST`, `INFO`). The FRM-specific colours work under any theme.
- Completion and hover help for keywords, at the start of a line, and `RADIO`/`CHECKBOX` on button lines.
- Problems, updated as you type:
  - Errors: malformed `port_size`, `text_font`, `field_font`, `vxdbase_winstyle` or `header`; duplicate indexes; a field in no group; a group with an undeclared field.
  - Warnings: `opt_*`, `tab_order` or `trigger` referring to an item that doesn't exist; `button` and `pushbutton` in the same form.
  - Information: an item on no tab (only once the form has an `opt_*` list of that kind; hidden items and bottom-bar buttons are skipped); fields but no group.
- Commands "FRM: Renumber fields", "FRM: Renumber texts" and "FRM: Renumber buttons" number the items in file order and update `group`, `opt_*`, `tab_order` and `trigger` references. List order is kept. With a selection, only the selected lines are numbered, from their lowest index, skipping indexes in use. `connection_of_field` and other `*_of_field` lines are not changed; a warning lists them.
- "FRM: Convert all pushbuttons to buttons" (also a quick fix and a preview banner) for forms that mix both. A pushbutton whose index a button also uses gets the next free one; tab lists follow.

## Preview

- Command: "Open FRM Preview" (appears in editor title bar for FRM files)
- Command: "FRM: Sort sections" (command palette / editor right-click) reorders the file into section order: `charset`, header block, `text`, `field`, `group`, `button`, `image`, `preview`, `opt_*`, `tab_order`, `trigger`. Lines added from the preview are always inserted in their section.
- Indexes required: the preview only works with `text(n)=`, `button(n)=` and `pushbutton(n)=` lines. If a form has any of these without an index, opening the preview shows a prompt instead of the form: **Auto-add indexes** numbers them (next free index in file order; `button`/`pushbutton` share one sequence; existing indexes are never changed; one Ctrl+Z undoes it), **Cancel** closes the preview. An unindexed line typed while the preview is open is shown locked, with a banner offering the same auto-add.
- Webview shows a simple form UI reflecting `field()` entries with list choices
- Drag the form's right edge, bottom edge or bottom-right corner to set `port_size= rows cols` (snaps to whole cells). Right-click a handle to set width, height or both back to auto (0).
- Toolbox: click a tool and then a cell, or drag the tool onto the form, to add a text, field, button, checkbox, radio button, preview or image. Drag on the form instead of clicking to set the size of a field, preview or image. Double-click a tool to add several; Esc or right-click stops. Move the toolbox by its header, flip it, or hide it to an icon; its place is remembered for all forms. Right-click > Add and the keys T, F, B, C, R, P and I do the same without the toolbox.
- The image dialog lists the files in `custom/forms/images` and `system/forms/images`; other names and `$DIR` paths can be typed.
- Stretch elements instead of typing sizes: drag a field's right edge to change `len`, or its left edge to move `col` and change `len` together. Images and previews stretch from all edges and corners (`rows`/`cols`, left/top also move the start). Shift+Arrow stretches the selected element by one cell. Snaps to whole cells; one Ctrl+Z undoes it.
- Drag a field onto the Hidden Fields panel to hide it (sets its position to `1000 1000`); drag it from the panel onto the form to show it again. One Ctrl+Z undoes it.
- Updates as you type
- Click in the code to select in the preview: the element defined at the cursor is selected, and a text selection or several cursors select several. Hidden fields and bottom-bar buttons are only highlighted. The form tab switches and the preview scrolls when needed; focus stays in the editor.
- Put the text cursor on a `trigger=` line, or hover a trigger in the preview's list, to highlight the field it fires from and the buttons that set that field (`0` highlights all fields and their buttons, `$...` outlines the form). Only a highlight: the selection is not changed by hovering.
- Select several elements: Ctrl+click or Shift+click adds or removes one, dragging on empty space selects everything completely inside the box (with Ctrl or Shift: adds), Ctrl+A selects all on the current tab. Arrows, dragging, Ctrl+D, Delete and the right-click menu act on the whole selection, each as one undo step. A group stops at the form's edge as a whole. Selected elements on other form tabs are left alone. Drag selected fields onto the Hidden Fields panel to hide them all.
- Copy, cut and paste within a form and between forms with Ctrl+C, Ctrl+X and Ctrl+V. The clipboard holds plain FRM lines, so it also works to and from the text editor.
  - Click a row in the Triggers or Hidden Fields list to select it, Ctrl+click or Shift+click to add it to the selection; double-click shows it in the source. Delete works on these too. Bottom-bar buttons can't be copied.
  - The top-left corner goes to the cell under the pointer; with the pointer away from the form, the original place is used, or the first free row below. What is pasted moves as a whole to stay inside the form, and goes on the active tab.
  - Pasted lines get the next free index. The first paste of a cut in the same form keeps the indexes. Tab order is not copied.
  - A pasted trigger follows its field when that is pasted with it. Otherwise it keeps its field number; in a form without that field it is skipped, as is a trigger the form already has.
- Keyboard shortcuts (press `?` or the ⌨ button in the preview for the full list; ⌘ instead of Ctrl on Mac):
  - Selected elements: arrows move, Ctrl+D duplicates one row below (a group: below itself), Ctrl+C/Ctrl+X/Ctrl+V copy, cut and paste, Del/Backspace deletes, Esc deselects. One element: Shift+Arrow stretches, F2/Enter edits
  - Zoom: Ctrl+scroll / Ctrl+= / Ctrl+- (5%; scroll keeps the point under the cursor), Ctrl+0 reset to 100%, Ctrl+1 fit the form to the panel. The Fit button in the titlebar does the same as Ctrl+1. Keys work even if the zoom slider is hidden.
  - Ctrl+Z / Ctrl+Y / Ctrl+Shift+Z: undo/redo in the FRM file (same history as the text editor)
  - Dialogs: Esc cancels, Ctrl+Enter confirms, Tab stays inside the dialog; clicking outside closes it (asks first if anything changed)
  - Context menus: ↑/↓ and Enter, Esc closes
  - Tab-order mode: click fields, field-setting buttons (RADIO/CHECKBOX/NAME=value) or Hidden Fields rows; Enter confirms, Esc cancels

Settings:
- `vertexFrmPreview.diagnostics` (default `true`): show problems found in FRM files.
- `vertexFrmPreview.autoOpen` (default `true`): automatically open a preview when an FRM file gets focus and has no preview yet. The new preview takes focus.
- `vertexFrmPreview.autoReveal` (default `true`): bring an FRM file's existing preview to the front when you switch back to that file. Focus stays in the editor. When off, the preview stays where it is (it still updates live).
- `vertexFrmPreview.followCursor` (default `true`): select the elements at the text cursor in the preview. Never opens or reveals a preview.
- `vertexFrmPreview.showZoomControls` (default `true`): show zoom buttons and slider in the preview titlebar.

The "Open FRM Preview" command always opens/reveals and focuses the preview, regardless of these settings.

Notes:
- Parser is minimal and based on sample; it looks for lines like `field(1)= CODE ... "opt1" "opt2"` and `header={TITLE}`.
- Extend `parseFrm` in `src/extension.ts` to cover more constructs.

## Develop / Run

1. Run `npm install` to fetch dev dependencies.
2. Build: `npm run compile` (or `npm run watch`).
3. Press F5 to launch an Extension Development Host. Open a FRM file and click "Open FRM Preview" in the editor title.

Run the tests with `npm test`.

Where things are:
- `src/extension.ts`: the extension. Parses the FRM file (`parseFrm`), renders the form's markup and data (`renderPreview`), and applies edits from the preview to the file.
- `src/languageFeatures.ts`: completion, hover, problems and renumber commands. The logic is in `keywords.ts` (help text), `keywordContext.ts`, `diagnostics.ts`, `renumber.ts` and `frmStatements.ts`, which don't depend on VS Code and are tested in `test/`.
- `media/preview.css` and `media/preview.js`: the preview page's styles and script, plain files that need no build step. The page loads them once; each refresh sends a `frmUpdate` message with the new markup and data. `preview.js` patches the page to match the new markup, keeping elements that are still there, and runs the page logic (`window.__frmMain(data)`) again. The logic may add listeners freely: all of them are removed before it runs again.

#### TODO:
- adding numbers to grid so user knowns which field is where.
- adding field names to buttons so user knows which button belongs to which field.