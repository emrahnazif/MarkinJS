# MarkinJS

A lightweight, zero-dependency SVG annotation editor for computer vision and image labeling projects.

[![npm version](https://img.shields.io/npm/v/markinjs.svg)](https://www.npmjs.com/package/markinjs)
[![npm downloads](https://img.shields.io/npm/dm/markinjs.svg)](https://www.npmjs.com/package/markinjs)
[![GitHub stars](https://img.shields.io/github/stars/datamarkin/markinjs.svg)](https://github.com/datamarkin/markinjs)
[![License](https://img.shields.io/npm/l/markinjs.svg)](https://github.com/datamarkin/markinjs/blob/main/LICENSE)
[![Bundle Size](https://img.shields.io/badge/bundle%20size-39KB%20min%20%2F%2013KB%20gzip-brightgreen.svg)](https://www.npmjs.com/package/markinjs)
[![No Dependencies](https://img.shields.io/badge/dependencies-none-brightgreen.svg)](https://www.npmjs.com/package/markinjs)

---

## Overview

MarkinJS edits bounding boxes, polygons and keypoints on top of an image. You give it annotations as JSON,
it draws them, people move and reshape them, and it hands the same JSON back after every edit.

It is an editor, not an application: drawing tools, label pickers and model-assisted labeling belong to your app.

- **One data format, the same in and out**, in image pixels. Fields MarkinJS does not know are kept as they are.
- **One `change` event** after every completed edit, carrying the full list. Save it with one request.
- **Mouse, touch and pen** through Pointer Events.
- **Constant on-screen size** for handles, keypoints and outlines at any image size or zoom, with no wiring.
- **Undo / redo**, keyboard nudging, containment in the box and in the image, cascading deletion.
- **Safe on a real page**: keys typed in text fields are never taken, a listener that throws cannot break the
  editor, and several editors can share a page.

> **Upgrading from 0.1?** The API changed. See [Migrating from 0.1](#migrating-from-01).

## Installation

### npm

```bash
npm install markinjs
```

```javascript
import MarkinJS from 'markinjs'; // ES module
const MarkinJS = require('markinjs'); // CommonJS
```

### Script tag

```html
<!-- From a CDN, pinned to a version -->
<script src="https://unpkg.com/markinjs@0.2.0/dist/markin.min.js"></script>

<!-- Or a copy in your app. Keep the version in the file name, so an update is always a visible change. -->
<script src="/static/js/markin-0.2.0.min.js"></script>
```

The build writes `dist/markin-<version>.min.js` for exactly this purpose. The source file `markin.js` also
works as a plain script, with no build step.

## Quick start

```html
<img id="photo" src="photo.jpg" alt="">
```

```javascript
const editor = MarkinJS.create('photo', {
    annotations: [
        { id: 1, class_id: 0, bbox: [120, 80, 300, 220] }
    ],
    colors: { 0: '#2563eb', 1: '#16a34a' }
});

editor.on('change', (annotations) => {
    fetch('/api/images/42/annotations', { method: 'PUT', body: JSON.stringify(annotations) });
});
```

`create()` takes an `<img>` (it lays an SVG over it) or an `<svg>` you already have, as an element, an id or a
CSS selector. It throws a `TypeError` if the target cannot be found.

Over an image, the overlay follows the picture as the browser draws it: borders, padding, `object-fit` and
`object-position` are accounted for, and it updates when the image is resized or its `src` changes. With `srcset`
or `<picture>` the natural size depends on the source the browser picks, so MarkinJS logs a warning.

## The annotation format

One object per thing in the image, in **image pixels**:

```json
{
    "id": "a1",
    "class_id": 0,
    "bbox": [120, 80, 300, 220],
    "segments": [[130, 90], [400, 95], [410, 280], [140, 290]],
    "keypoints": [
        { "name": "head", "point": [260, 110], "v": 2 },
        { "name": "tail", "point": [300, 270], "v": 1 }
    ]
}
```

| Field | Meaning |
|---|---|
| `id` | String or number. Generated when missing. Always present in what MarkinJS returns. |
| `class_id` | String or number. Picks the colour from `options.colors`. Class names stay in your app. |
| `bbox` | `[x, y, width, height]`. |
| `segments` | One polygon as `[x, y]` points, at least three. |
| `keypoints` | `point` is `[x, y]`. `name` is optional. `v` is COCO visibility: `0` not labelled (not drawn), `1` occluded (drawn dashed), `2` visible. |

`bbox`, `segments` and `keypoints` are all optional, but at least one must be present.

**Whatever MarkinJS returns, it accepts unchanged**, and any other field (`score`, `track_id`, your own metadata,
extra fields on keypoints) is carried through untouched. Saving the list from `change` never drops your data.

Coordinates normalised to 0–1 are a helper, not the default:

```javascript
editor.getAnnotations({ normalize: true });           // fractions of the image size
MarkinJS.normalize(annotations, width, height);       // pixels -> fractions
MarkinJS.denormalize(annotations, width, height);     // fractions -> pixels
```

## API

### Data

| Method | Description |
|---|---|
| `createAnnotation(annotation, { select = true })` | Add one. Returns its id, or `null` if the data is invalid. |
| `updateAnnotation(id, patch)` | Merge `patch` into an annotation. A field set to `null` is removed. Returns `true` on success. |
| `deleteAnnotation(id)` | Remove one. |
| `addKeypoint(id, { name, point })` | Append a keypoint. |
| `getAnnotation(id)` | A copy of one annotation, or `null`. |
| `getAnnotations({ normalize = false })` | Copies of all annotations. |
| `load(annotations)` | Replace everything. Starts a fresh undo history and does not emit `change`. Nothing is replaced unless every item is valid. |
| `clear()` | Remove everything, as one undoable step. |

Invalid input never throws and never changes anything: the method returns `null` / `false` and the reason is
logged. Pass `strict: true` to get a `TypeError` instead.

### Selection

| Method | Description |
|---|---|
| `select(id, part?, index?)` | Select an annotation, or one part: `'bbox'`, `'polygon'`, or `'keypoint'` with its index. |
| `deselect()` | Clear the selection. |
| `getSelection()` | `{ id, part, index, annotation }` or `null`. |
| `deleteSelected()` | Delete the selected part, following `deletionRules`. |

### History and state

| Method | Description |
|---|---|
| `undo()` / `redo()` | Return `true` if a step was taken. |
| `canUndo()` / `canRedo()` | For enabling buttons. |
| `clearHistory()` | Forget the steps, keep the data. |
| `enable()` / `disable()` | When disabled, pointer events pass through to whatever is underneath. |
| `setOptions(options)` / `getOptions()` | Change options at run time. |
| `refresh()` | Re-measure the on-screen scale now. Only needed right after you scale the canvas from code with a CSS transform; otherwise the editor re-measures by itself. |
| `getSVGElement()` / `getImageElement()` / `getContainerElement()` | The elements involved. |
| `destroy()` | Remove everything the editor added and put the page back. |

### Events

`on(type, listener)` returns a function that removes the listener. `off(type, listener)` works too.

| Event | Listener receives | When |
|---|---|---|
| `change` | `(annotations, { reason, ids })` | After every completed edit: `create`, `update`, `delete`, `clear`, `undo`, `redo`. Not after `load()`. |
| `select` | `{ id, part, index, annotation }` | A part was selected. |
| `deselect` | `{ id, part, index }` | The selection was cleared or moved. |
| `dragstart`, `drag` | `{ id, part, index, handle, position, annotation }` | While dragging. Use `drag` for live read-outs. |
| `dragend` | the same plus `changed`, `cancelled` | A drag ended. A `change` follows if something changed. |
| `hover` | `{ position, id, part, index }` | The pointer moved over the canvas (at most once per frame). |
| `canvasclick` | `{ position }` | A click that hit no annotation. |

`position` is in image pixels. A listener that throws is reported and skipped; it cannot interrupt the editor.

A listener may call back into the editor. `createAnnotation()` reports its `change` first and selects the new
annotation after that, so a `select` listener can already edit or delete it.

A press on an annotation does not bubble as `pointerdown` or `mousedown`; listen for `click`, or for the editor's own
`select`, if the rest of your page needs to know about it. A press on empty canvas bubbles as usual.

## Options

| Option | Default | Description |
|---|---|---|
| `annotations` | `null` | Initial data. Same as calling `load()`. |
| `colors` | `null` | Colour per `class_id`, e.g. `{ 0: '#2563eb' }`. |
| `color` | `'#0000FF'` | Colour for everything else. |
| `skeleton` | `null` | Lines between keypoints: `[[from, to], ...]` by keypoint name or index. Display only. Prefer names: deleting a keypoint shifts the indices after it. |
| `skeletonStyle` | `null` | `{ stroke, strokeWidth, strokeOpacity, strokeDasharray }`. |
| `bindElements` | `true` | The polygon and keypoints follow their box when it moves and scale with it when it is resized. |
| `bboxContainPolygon` | `true` | Keep the polygon inside its box (needs `bindElements`). |
| `bboxContainKeypoints` | `true` | Keep keypoints inside their box (needs `bindElements`). |
| `constrainToImage` | `true` | Keep everything inside the image. |
| `requireBbox` | `false` | Give an annotation without a box one that encloses its other geometry. |
| `requireSelectionToDrag` | `true` | The first press selects, the next one drags. |
| `keyboardControls` | `true` | See [Keyboard](#keyboard). |
| `deletionRules` | see below | What else is deleted along with a part. |
| `historyEnabled` | `true` | Undo / redo. |
| `historyMaxStates` | `50` | States kept, including the current one. |
| `strokeWidth`, `keypointRadius`, `handleRadius` | `2`, `5`, `5` | Sizes in **screen** pixels. |
| `strict` | `false` | Throw on invalid input instead of logging. |
| `silent` / `logger` | `false` / `null` | Silence the log, or receive it as `logger(level, message)`. |

Unknown options are reported, so a typo does not fail silently.

### Deletion rules

```javascript
MarkinJS.create(img, {
    deletionRules: {
        bbox: ['polygon', 'keypoint'], // deleting the box deletes everything -> the annotation goes
        polygon: ['bbox'],             // deleting the polygon also deletes the box
        keypoint: []                   // deleting a keypoint deletes just that keypoint
    }
});
```

Those are the defaults. Exactly the listed parts are removed, `'annotation'` removes the whole annotation, and an
annotation left with no geometry is always removed.

## Keyboard

| Key | Action |
|---|---|
| Arrow keys | Move the selection by 1 pixel. **Shift**: 10. **Ctrl / Cmd**: 0.2. |
| Delete, Backspace | Delete the selection. |
| Ctrl / Cmd + Z | Undo. |
| Ctrl / Cmd + Shift + Z, Ctrl + Y | Redo. |
| Escape | Cancel a drag, or deselect. |

Keys are ignored while the user types in an `<input>`, `<textarea>`, `<select>` or editable element, also inside
web components. With several editors on a page, only the one the user last pressed on reacts. Holding an arrow key
is a single undo step. Ctrl / Cmd + Z is only taken when there is something to undo.

## Styling

Everything MarkinJS draws lives in one `<g class="markin-layer">` and is output only: change the data, not the DOM.
For CSS there are stable hooks:

`.markin-annotation[data-class-id][data-selected]`, `.markin-bbox`, `.markin-polygon`,
`.markin-keypoint[data-name][data-v]`, `.markin-skeleton`, `.markin-handle`.

## Frameworks (React, Vue, …)

Given an `<img>`, MarkinJS wraps it in a `<div>` to position the overlay, and `destroy()` unwraps it. If your
framework owns that `<img>`, render the structure yourself and pass the SVG instead:

```html
<div style="position: relative; display: inline-block">
    <img src="photo.jpg" alt="">
    <svg viewBox="0 0 1280 853" style="position: absolute; inset: 0; width: 100%; height: 100%"></svg>
</div>
```

```javascript
const editor = MarkinJS.create(svgElement, { annotations });
// ...and in your cleanup:
editor.destroy();
```

The `viewBox` is the image's natural size; it defines the coordinate system and the area annotations stay inside.
Calling `create()` again on the same element replaces the earlier editor.

## Migrating from 0.1

0.2 is a rewrite with a smaller API. Old event and option names are reported by name when used.

| 0.1 | 0.2 |
|---|---|
| `createImageAnnotator(id, opts)`, `createAnnotator(id, opts)` | `MarkinJS.create(imgOrSvg, opts)`. Throws instead of returning `null`. |
| `uuid`, `class` | `id`, `class_id` |
| `bbox: [x1, y1, x2, y2]` in, `{x, y, width, height}` out | `bbox: [x, y, width, height]` both ways |
| `segmentation: [x1, y1, x2, y2, …]` | `segments: [[x, y], …]` |
| `createAnnotation()` returned the `<g>` | returns the id |
| `fill`, `stroke` per annotation | `colors` by `class_id` |
| `bindElements`, `containRules`, `deletionRules`, `skeleton` per annotation | editor options |
| `containRules: ['polygon', 'keypoint']` | `bboxContainPolygon`, `bboxContainKeypoints` |
| `keypointSkeleton`, `keypointSkeletonStyle` | `skeleton`, `skeletonStyle` |
| `updateAnnotation({ uuid, … })` replaced the annotation | `updateAnnotation(id, patch)` merges |
| `addKeypoint(group, name, x, y)` | `addKeypoint(id, { name, point })` |
| `deleteElement()`, `deleteGroup()` | `deleteAnnotation(id)` |
| `deleteSelectedElement()`, `getSelectedElement()` | `deleteSelected()`, `getSelection()` |
| `exportAllAnnotations()`, `exportAnnotation()`, `getAnnotationsAsJSON()`, … | `getAnnotations()`, `getAnnotation(id)` |
| removing `<g>` elements to clear | `clear()`, `load([])` |
| `setZoom()`, `zoom`, `updateDimensions()` | not needed; `refresh()` |
| `enableKeyboardControls()`, `setDeletionRules()`, `setRequireSelectionToDrag()` | `setOptions({ … })` |
| `saveState()`, `history.hasUndo()` | every edit is recorded; `canUndo()`, `canRedo()` |
| `annotationcreated`, `annotationupdated`, `annotationmodificationcomplete`, `elementmoved`, `delete`, `deletegroup`, `keypointadded` | `change` |
| `annotationmodified` | `drag` |
| `hoverelement`, `hovercanvas` | `hover` |
| `deletionRules` role `'group'` | `'annotation'` |
| Server-rendered `<g data-annotation-group>` markup adopted by the library | Pass the JSON in `options.annotations`; MarkinJS does all the drawing |

Behaviour that changed on purpose:

- Annotations cannot be dragged out of the image (`constrainToImage`).
- A press must travel 3 pixels before it becomes a drag, so a click never nudges anything.
- `load()` and `options.annotations` start a fresh undo history; undo cannot unload your data.
- Annotations are stacked by size, smallest on top, with all keypoints above all shapes.
- `requireBbox` derives the box from the other geometry instead of inventing a 200 × 150 box.

A 0.1 box passed unchanged is read as `[x, y, width, height]`. MarkinJS warns when a box reaches outside the
image, which is the usual sign of that.

## Browser support

Current Chrome, Edge, Firefox and Safari (Pointer Events are required).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup and contribution guidelines.

## Support

- **Website**: [markinjs.com](https://markinjs.com)
- **Issues**: [GitHub Issues](https://github.com/datamarkin/markinjs/issues)
- **Contact**: markinjs@datamarkin.com

## License

MIT License - see [LICENSE](LICENSE) file for details.

---

**Maintained by [Datamarkin](https://datamarkin.com)**
