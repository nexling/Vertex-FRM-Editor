# Changelog

## 2026-11-20

### Added

- Command "FRM: Sort sections" (command palette and editor right-click menu) puts an FRM file in section order: `charset`, header block, `text`, `field`, `group`, `button`, `image`, `preview`, `opt_*`, `tab_order`, `trigger`. Indexed lines are sorted by index, comments directly above a line move with it, and sections are separated by one empty line. One Ctrl+Z undoes it.

### Changed

- Elements, `opt_*` lists, `tab_order` and triggers added from the preview go into their section of the file. The first element of a type no longer lands right below the header, and a new section is separated by an empty line.

### Fixed

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


