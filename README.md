# Vertex FRM Preview (Workspace-local)

This lightweight VS Code extension adds a live preview for Vertex FRM form files.

- Syntax highlighting for .frm and files named `closet`
- Command: "Open FRM Preview" (appears in editor title bar for FRM files)
- Command: "FRM: Sort sections" (command palette / editor right-click) reorders the file into section order: `charset`, header block, `text`, `field`, `group`, `button`, `image`, `preview`, `opt_*`, `tab_order`, `trigger`. Lines added from the preview are always inserted in their section.
- Indexes required: the preview only works with `text(n)=`, `button(n)=` and `pushbutton(n)=` lines. If a form has any of these without an index, opening the preview shows a prompt instead of the form: **Auto-add indexes** numbers them (next free index in file order; `button`/`pushbutton` share one sequence; existing indexes are never changed; one Ctrl+Z undoes it), **Cancel** closes the preview. An unindexed line typed while the preview is open is shown locked, with a banner offering the same auto-add.
- Webview shows a simple form UI reflecting `field()` entries with list choices
- Drag the form's right edge, bottom edge or bottom-right corner to set `port_size= rows cols` (snaps to whole cells). Right-click a handle to set width, height or both back to auto (0).
- Stretch elements instead of typing sizes: drag a field's right edge to change `len`, or its left edge to move `col` and change `len` together. Images and previews stretch from all edges and corners (`rows`/`cols`, left/top also move the start). Shift+Arrow stretches the selected element by one cell. Snaps to whole cells; one Ctrl+Z undoes it.
- Updates as you type
- Keyboard shortcuts (press `?` or the ⌨ button in the preview for the full list; ⌘ instead of Ctrl on Mac):
  - Selected element: arrows move, Shift+Arrow stretches, F2/Enter edits, Ctrl+D duplicates one row below, Del/Backspace deletes, Esc deselects
  - Ctrl+Z / Ctrl+Y / Ctrl+Shift+Z: undo/redo in the FRM file (same history as the text editor)
  - Dialogs: Esc cancels, Ctrl+Enter confirms, Tab stays inside the dialog; clicking outside closes it (asks first if anything changed)
  - Context menus: ↑/↓ and Enter, Esc closes
  - Tab-order mode: Enter confirms, Esc cancels

Settings:
- `vertexFrmPreview.autoOpen` (default `true`): automatically open a preview when an FRM file gets focus and has no preview yet. The new preview takes focus.
- `vertexFrmPreview.autoReveal` (default `true`): bring an FRM file's existing preview to the front when you switch back to that file. Focus stays in the editor. When off, the preview stays where it is (it still updates live).
- `vertexFrmPreview.showZoomControls` (default `true`): show zoom buttons and slider in the preview titlebar.

The "Open FRM Preview" command always opens/reveals and focuses the preview, regardless of these settings.

Notes:
- Parser is minimal and based on sample; it looks for lines like `field(1)= CODE ... "opt1" "opt2"` and `header={TITLE}`.
- Extend `parseFrm` in `src/extension.ts` to cover more constructs.

## Develop / Run

1. Run `npm install` to fetch dev dependencies.
2. Build: `npm run compile` (or `npm run watch`).
3. Press F5 to launch an Extension Development Host. Open a FRM file and click "Open FRM Preview" in the editor title.

#### TODO:
- adding numbers to grid so user knowns which field is where.
- adding field names to buttons so user knows which button belongs to which field.