# Vertex FRM Preview (Workspace-local)

This lightweight VS Code extension adds a live preview for Vertex FRM form files.

- Syntax highlighting for .frm and files named `closet`
- Command: "Open FRM Preview" (appears in editor title bar for FRM files)
- Command: "FRM: Sort sections" (command palette / editor right-click) reorders the file into section order: `charset`, header block, `text`, `field`, `group`, `button`, `image`, `preview`, `opt_*`, `tab_order`, `trigger`. Lines added from the preview are always inserted in their section.
- Webview shows a simple form UI reflecting `field()` entries with list choices
- Updates as you type

Settings:
- `vertexFrmPreview.autoOpen` (default `true`): automatically open a preview when an FRM file gets focus and has no preview yet. Focus stays in the editor.
- `vertexFrmPreview.autoReveal` (default `true`): bring an FRM file's existing preview to the front when you switch back to that file. When off, the preview stays where it is (it still updates live).
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