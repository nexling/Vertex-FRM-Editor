# Vertex FRM Preview (Workspace-local)

This lightweight VS Code extension adds a live preview for Vertex FRM form files.

- Syntax highlighting for .frm and files named `closet`
- Command: "Open FRM Preview" (appears in editor title bar for FRM files)
- Command: "FRM: Sort sections" (command palette / editor right-click) reorders the file into section order: `charset`, header block, `text`, `field`, `group`, `button`, `image`, `preview`, `opt_*`, `tab_order`, `trigger`. Lines added from the preview are always inserted in their section.
- Indexes required: the preview only works with `text(n)=`, `button(n)=` and `pushbutton(n)=` lines. If a form has any of these without an index, opening the preview shows a prompt instead of the form: **Auto-add indexes** numbers them (next free index in file order; `button`/`pushbutton` share one sequence; existing indexes are never changed; one Ctrl+Z undoes it), **Cancel** closes the preview. An unindexed line typed while the preview is open is shown locked, with a banner offering the same auto-add.
- Webview shows a simple form UI reflecting `field()` entries with list choices
- Drag the form's right edge, bottom edge or bottom-right corner to set `port_size= rows cols` (snaps to whole cells). Right-click a handle to set width, height or both back to auto (0).
- Stretch elements instead of typing sizes: drag a field's right edge to change `len`, or its left edge to move `col` and change `len` together. Images and previews stretch from all edges and corners (`rows`/`cols`, left/top also move the start). Shift+Arrow stretches the selected element by one cell. Snaps to whole cells; one Ctrl+Z undoes it.
- Drag a field onto the Hidden Fields panel to hide it (sets its position to `1000 1000`); drag it from the panel onto the form to show it again. One Ctrl+Z undoes it.
- Updates as you type
- Click in the code to select in the preview: the element defined at the cursor is selected, and a text selection or several cursors select several. Hidden fields and bottom-bar buttons are only highlighted. The form tab switches and the preview scrolls when needed; focus stays in the editor.
- Put the text cursor on a `trigger=` line, or hover a trigger in the preview's list, to highlight the field it fires from and the buttons that set that field (`0` highlights all fields and their buttons, `$...` outlines the form). Only a highlight: the selection is not changed by hovering.
- Ctrl+click elements in the preview to select several. Editing keys work on one selected element at a time.
- Keyboard shortcuts (press `?` or the ⌨ button in the preview for the full list; ⌘ instead of Ctrl on Mac):
  - Selected element: arrows move, Shift+Arrow stretches, F2/Enter edits, Ctrl+D duplicates one row below, Del/Backspace deletes, Esc deselects
  - Ctrl+Z / Ctrl+Y / Ctrl+Shift+Z: undo/redo in the FRM file (same history as the text editor)
  - Dialogs: Esc cancels, Ctrl+Enter confirms, Tab stays inside the dialog; clicking outside closes it (asks first if anything changed)
  - Context menus: ↑/↓ and Enter, Esc closes
  - Tab-order mode: Enter confirms, Esc cancels

Settings:
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

Where things are:
- `src/extension.ts`: the extension. Parses the FRM file (`parseFrm`), renders the form's markup and data (`renderPreview`), and applies edits from the preview to the file.
- `media/preview.css` and `media/preview.js`: the preview page's styles and script, plain files that need no build step. The page loads them once; each refresh sends a `frmUpdate` message with the new markup and data. `preview.js` patches the page to match the new markup, keeping elements that are still there, and runs the page logic (`window.__frmMain(data)`) again. The logic may add listeners freely: all of them are removed before it runs again.

#### TODO:
- adding numbers to grid so user knowns which field is where.
- adding field names to buttons so user knows which button belongs to which field.