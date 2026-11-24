# Changelog

## 2026-11-24

### Added

- Copy, cut and paste with Ctrl+C, Ctrl+X and Ctrl+V, within a form and between forms. The clipboard holds plain FRM lines, so it also works to and from the text editor. Pasting puts the top-left corner at the cell under the pointer, each line in its section, under new indexes, on the active tab; fields join `group(1)`. Cutting and pasting in the same form keeps the indexes. One Ctrl+Z undoes it.
- Triggers and hidden fields can be selected in their lists, together with elements on the form, to copy, cut or delete them. Double-click shows them in the source (one click used to, for hidden fields). A pasted trigger follows its field when that is pasted with it.
- A floating toolbox with Text, Field, Button, Checkbox, Radio, Preview and Image. Click a tool and then a cell, or drag the tool onto the form; with a field, preview or image, drag to set its size. Double-click a tool to add several; Esc or right-click stops. The toolbox can be moved, flipped between vertical and horizontal, and hidden to a toolbox icon; this is remembered for all forms.
- T, F, B, C, R, P and I add an element at the cell under the pointer, also when the toolbox is hidden. Away from the form they select the tool.
- Images can be added, and edited with F2, Enter or the right-click menu. The dialog lists the files in `custom/forms/images` and `system/forms/images` with thumbnails and fills in the size from the chosen file. Editing rewrites only what changed.
- A new element is selected, and the "Added ..." message is gone.
- In tab-order mode, a field-setting button (RADIO, CHECKBOX or NAME=value) or a row in Hidden Fields adds that field, including when the field is hidden. Clicking any stand-in for the same field toggles the same slot. Delete × are hidden and dragging is off until you confirm or cancel.
- Several elements can be moved, duplicated, deleted or hidden at once, as one undo step. Shift+click works like Ctrl+click, dragging on empty space selects everything completely inside the box, and Ctrl+A selects all on the current tab. Arrow keys, dragging, Ctrl+D, Delete and the right-click menu then act on all selected elements of the current tab. A group keeps its layout and stops at the form's edge as a whole; its copies go below the group.
- Preview zoom shortcuts: Ctrl+scroll, Ctrl+= and Ctrl+- change zoom in 5% steps (scroll keeps the point under the cursor); Ctrl+0 resets to 100%; Ctrl+1 or the titlebar Fit button scales the form to the panel. ⌘ on Mac. The keys work while a dialog is open and when the zoom slider is hidden. Zoom is remembered up to 1000% (it used to forget anything above 300%).

### Fixed

- Adding or duplicating a field on a form without `revision= 2` no longer treats the second value of `group(1)` as a field number.
- A preview added on a form with tabs is put in the tab's `opt_preview` list, and previews in such lists are only shown on their tabs.
- Adding an element after cancelling an edit no longer overwrites the element whose edit was cancelled.
- A refresh no longer closes a text or header that is being typed.
- Tab-order mode: locked fields can be picked, and clicking a field or button only numbers it (dropdowns don't open, radios don't toggle). Fields without an index, and buttons whose field isn't on the form, can't be picked; a notice says why. Button and field names match exactly, including case and `$`.
- Buttons that set a variable to blank (`RADIO MOUNT=`) are read as such, and editing them keeps the value blank. An empty value for a radio or plain variable button now means blank. A `$` before a button's variable is kept.
- A button line with nothing after its position or label no longer takes in the line below it.
- Moves made in quick succession (holding an arrow key) are written one after the other, so none are lost.
- A field without an index can no longer be moved or deleted from the preview; that could change another field.

## 2026-11-23

### Added

- The Vertex-FRM extension is merged into this one: syntax colours, completion, hover help, problems and renumber commands, without a language server. The display name is now "Vertex FRM". A notice asks to uninstall the old extension if it is still installed.
- Problems for duplicate indexes and for `opt_*`, `tab_order` and `trigger` lines that refer to missing items. Setting `vertexFrmPreview.diagnostics` turns all problems off.
- Forms that mix `button` and `pushbutton` get a warning with a quick fix, a banner in the preview and a "Convert all pushbuttons to buttons" command.
- FRM colours apply under any theme. The `FRM-Theme-Dark` and `FRM-Theme-Dark-Vector` themes are gone.

### Changed

- The renumber commands are now `vertexFrmPreview.renumberFields`, `renumberTexts` and `renumberButtons`.
- Buttons added in the preview are written as `button`, unless the form only uses `pushbutton`. Editing a button keeps its spelling.
- Completion and hover only apply where a keyword can stand, not in labels or comments.

### Fixed

- The check for items on no tab stopped after the first statement.
- The group check needed every group to list every field, and read numbers in comments as fields.
- Renumbering fields now updates triggers, keeps the group's browse order and leaves the third fixed group value of `revision= 2` alone.
- Renumbering buttons includes `button` and `opt_button`. Renumbering a selection no longer creates duplicate indexes.
- The preview opens automatically for `.vxf`, `.form` and `.vf` files too.

## 2026-11-21

### Added

- Dropdown values written as `"path:<name>"` now show the choices from that values file instead of the raw text. The file is looked up by name (case-insensitive) in `custom*/forms/fieldvalues/`, `custom*/forms/`, `system/forms/fieldvalues/` and then `system/forms/`. `!` comment lines, `charset=` lines and blank lines are skipped; every other line, including `-----` separators, is a choice. `Text [value]*` shows `Text` with the real value as a tooltip (also for values written directly in the field). Database format files (`#SETUP#`/`#FORMAT#`) show a dimmed `‹database list: name›`, and a missing file shows the raw `path:name` dimmed with a "not found" tooltip. The `.frm` text is never changed. The field dialog shows what each `path:` entry resolves to, and the preview refreshes when a file under `forms/` changes.
- Fields can be stretched in the preview. Drag a field's right edge to change its length, or its left edge to move its start column and change the length together (the right edge stays put). The size snaps to whole columns, a label shows `len n` while dragging, and releasing writes the new `col`/`len` to the `field(n)=` line. For dropdowns the handle sits on the visible edge (length + 2). Length stops at 1 and the start column at 1. One Ctrl+Z undoes it.
- Images and previews can be stretched from all four edges and corners. Right/bottom change `cols`/`rows`; left/top also move the start so the opposite edge stays put. Minimum size is 1 × 1.
- A text's box can be stretched from all four edges and corners. The handles sit on the drawn box lines and show when you hover the box or its label, or select the text. Right/bottom change the size in `#[rows,cols]*`; left/top also move the text's `row`/`col` (the box corner) so the opposite edge stays put. The box stays at least 1 row tall, wide enough for its label, and inside the window. A label shows `rows × cols` while dragging, Escape cancels, and one Ctrl+Z undoes it.
- A text's right-click menu has Add Box / Remove Box. A new box is 5 × 20 (wider if the label needs it, smaller if the window is), and the text's column shifts by 2 so the label stays where it is on screen. Only the column and the `#[rows,cols]*` directive change; the rest of the line is left as written.
- Shift+Arrow stretches the selected field, image or preview: Shift+Right/Left makes it one column wider/narrower, Shift+Down/Up one row taller/shorter (images and previews only). Each press is one undo step.
- Stretching may go past the window or over other elements; anything outside the window is shown dimmed. Escape cancels a drag. Only the changed numbers are rewritten, the rest of the line keeps its formatting.
- Escape closes any dialog in the preview, the same as Cancel (changes are discarded, no prompt). Escape closes one thing per press: a resize drag, then a context menu, then the dialog, then tab-order mode, then the selection.
- Clicking outside a dialog closes it. If anything in it was changed, an inline "Discard changes?" bar asks first (Enter or Escape keeps editing). A text selection dragged out of the dialog doesn't count as a click outside.
- Ctrl+Enter (⌘+Enter on Mac) confirms the open dialog from any input, text areas included. Dialogs open with the cursor at the end of the first input, Tab stays inside the dialog, and closing it returns focus to the selected element so the arrow keys keep working.
- F2 or Enter edits the selected element (not images): texts in place, other elements in their dialog.
- Ctrl+D duplicates the selected element one row below (same row if that would leave the window). The copy keeps everything from the original line, including a field's name, gets the next free index, joins `group(1)` (fields) and the same tabs, and becomes selected. One Ctrl+Z undoes it.
- Ctrl+Z, Ctrl+Y and Ctrl+Shift+Z in the preview undo and redo in the FRM file, using the same history as the text editor.
- In tab-order mode, Enter confirms the order and Escape cancels it.
- Context menus work with the keyboard: ↑/↓ move a highlight (wrapping around), Enter chooses, Escape closes.
- `?` or the ⌨ button in the titlebar shows a list of all keyboard shortcuts.
- The element right-click menu has Duplicate and Delete, and menu items show their shortcut.

### Changed

- The preview opens faster. Its styles and script are built into the page instead of loaded as two separate files, and the extension starts once VS Code is up (`onStartupFinished`) and reads the translations file and page files in the background, so the first preview no longer waits for them.
- The "Vertex FRM Preview" output channel logs how long each preview took to appear, split into building the page, the webview starting, the script starting, the page logic, and the first frame.
- The delete button on fields, images and previews sits slightly higher so it doesn't cover the stretch handles. On very narrow elements the stretch handles only appear once the element is selected.
- Arrow keys, Delete and Backspace no longer act on the selected element while a dialog is open. Before, Backspace in a dialog could delete the element behind it.
- Clicking inside a dialog or menu no longer deselects the element.
- The window header and texts are edited in place instead of in a dialog. Double-click the title in the titlebar, or double-click a text (or F2/Enter, or Edit in its right-click menu), and it turns into an input with the text selected. Enter or clicking away saves, Escape cancels, and an empty or unchanged value writes nothing. Add Text puts an empty input at the clicked cell; nothing is added unless you type something. The header and text dialogs are gone.
- The selection and hover box around a text is as wide as the text itself, at any zoom. Only the text is clickable and draggable, and the dashed drop outline is the same width. Empty text keeps a box one column wide.
- Checkboxes, radio buttons and buttons are sized to their content the same way: the selection and hover box is as wide as the control plus its label, and as tall as the text (buttons as tall as their border). The gap between a checkbox/radio and its label scales with zoom. Bottom-bar buttons are unchanged.
- Refreshing the preview no longer reads the disk each time. `path:` values files, image locations and the list of trigger programs are read once and remembered; a change to one of those files refreshes only the previews that show it. A newly created trigger program is listed right away.
- The preview now only watches `forms/`, `forms/fieldvalues/` and `forms/images/` (custom and system, without their subfolders) and the trigger program folders. Saving an `.frm` file or changing other files under `forms/` no longer re-renders open previews. All previews share one set of watchers, which stop when the last preview closes.
- Zooming and resizing the panel measure texts and buttons in one pass instead of once per element, and at most once per frame, so the zoom slider stays smooth on large forms.
- The preview page's styles and script are now separate files (`media/preview.css`, `media/preview.js`) that load once per page. A refresh sends only the form's markup and data, about a fifth of what it sent before for a typical form. The page then updates in place: elements that are still there are kept and only what changed is rewritten, so images don't reload. A refresh is about 30% faster in the page.
- The extension starts when an FRM file is opened instead of in every VS Code window at startup. It now registers the `vertexfrm` language for `.frm` files itself, so it no longer depends on the Vertex FRM language extension for this. If an FRM file already has focus when the extension starts (for example when VS Code reopens one), its preview opens like it does when you switch to the file.
- The packaged extension no longer contains the TypeScript source, source maps, the sample form or old `.vsix` files.

### Fixed

- Moving an image or preview with the arrow keys or by dragging no longer drops its height in the preview until the next refresh.
- Text longer than 32 characters no longer spills outside its selection box, and it can't be dropped partly outside the window anymore.

## 2026-11-20

### Added

- The form window in the preview can be resized by dragging its right edge (columns), bottom edge (rows) or bottom-right corner (both). The size snaps to whole grid cells, a label shows `rows × cols` while dragging, and releasing writes `port_size= rows cols` to the file (added next to the header settings if missing). Dragging one edge keeps the other number as it is, including 0 (auto). One Ctrl+Z undoes it.
- Right-click a resize handle to set the width, height or both back to auto (0). Items that are already auto are greyed out.
- The window can be made smaller than its contents. Elements outside it are shown dimmed and can still be selected and dragged back in. Bottom-bar buttons stay at the bottom of the window.
- While dragging an element (or a hidden field) over the preview, a dashed outline shows the cells it will land on.
- Command "FRM: Sort sections" (command palette and editor right-click menu) puts an FRM file in section order: `charset`, header block, `text`, `field`, `group`, `button`, `image`, `preview`, `opt_*`, `tab_order`, `trigger`. Indexed lines are sorted by index, comments directly above a line move with it, and sections are separated by one empty line. One Ctrl+Z undoes it.

### Changed

- Elements, `opt_*` lists, `tab_order` and triggers added from the preview go into their section of the file. The first element of a type no longer lands right below the header, and a new section is separated by an empty line.

### Fixed

- Dropping an element in the preview puts it in the row it was dropped on. It used to land further down the lower you dropped it, and more so when zoomed, because the drop used a fixed 28 px row height instead of the real one. The right-click "insert here" cell had the same problem. Drops now also stay inside the current window size, keeping the whole element inside it.
- When `port_size` is auto (0), hidden fields (row or column 1000) no longer count toward the window size. Forms with hidden fields used to open about 1000 columns wide.
- The preview no longer flashes when the FRM file is saved (including auto-save) or when edits are made. Saves and moves made in the preview no longer re-render it, and other changes are applied in place, keeping zoom, grid, active tab, scroll position and the selected element.
- Typing in the FRM file now updates the preview once typing pauses (150 ms) instead of on every keystroke.
- An update that arrives while you are dragging, have a dialog open, or are in tab-order mode waits until you are done.

## 2026-11-19

### Added

- Setting `vertexFrmPreview.autoOpen` (default on) controls whether a preview opens automatically when an FRM file gets focus and has no preview yet.
- Setting `vertexFrmPreview.autoReveal` (default on) controls whether an existing preview is brought to the front when switching back to its FRM file.

### Changed

- Automatically opened previews no longer take keyboard focus from the editor. The "Open FRM Preview" command still focuses the preview.

### Fixed

- Switching back to an FRM file no longer registers an extra document-change listener each time, which caused the preview to re-render multiple times per edit.

## 2026-09-04

### Added

- Window header in the FRM preview can be edited by double-clicking the titlebar caption. The form is updated as `header = "..."`.
- Setting `vertexFrmPreview.showZoomControls` (default on) shows or hides the preview zoom buttons and slider. Grid and Tab Order stay in the titlebar.

### Fixed


## 2026-08-24

### Added



### Fixed


