# MarkinJS

A lightweight, zero-dependency SVG annotation editor for computer vision and image labeling projects.

[![npm version](https://img.shields.io/npm/v/markinjs.svg)](https://www.npmjs.com/package/markinjs)
[![npm downloads](https://img.shields.io/npm/dm/markinjs.svg)](https://www.npmjs.com/package/markinjs)
[![GitHub stars](https://img.shields.io/github/stars/datamarkin/markinjs.svg)](https://github.com/datamarkin/markinjs)
[![License](https://img.shields.io/npm/l/markinjs.svg)](https://github.com/datamarkin/markinjs/blob/main/LICENSE)
[![Bundle Size](https://img.shields.io/badge/bundle%20size-53KB%20min%20%2F%2018KB%20gzip-brightgreen.svg)](https://www.npmjs.com/package/markinjs)
[![No Dependencies](https://img.shields.io/badge/dependencies-none-brightgreen.svg)](https://www.npmjs.com/package/markinjs)

---

## Overview

MarkinJS edits bounding boxes, polygons and keypoints on top of an image. You give it annotations as JSON,
it draws them, people move and reshape them, and it hands the same JSON back after every edit.

It is an editor, not an application: drawing tools, label pickers and model-assisted labeling belong to your app.

- **One data format, the same in and out**, in image pixels. Fields MarkinJS does not know are kept as they are.
- **One `change` event** after every completed edit, carrying the full list. Save it with one request.
- **Mouse, touch and pen** through Pointer Events.
- **Zoom and pan built in**: trackpad pinch, wheel, drags and keys. The visible part of the image is reported in
  image pixels, ready to be used as a crop.
- **Constant on-screen size** for handles, keypoints and outlines at any image size or zoom, with no wiring.
- **Undo / redo**, keyboard nudging, containment in the box and in the image, cascading deletion.
- **Safe on a real page**: keys typed in text fields are never taken, a listener that throws cannot break the
  editor, and several editors can share a page.

> **Upgrading?** From 0.2, see [Upgrading from 0.2](#upgrading-from-02). From 0.1 the API changed: see
> [Migrating from 0.1](#migrating-from-01).

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
<script src="https://unpkg.com/markinjs@0.3.0/dist/markin.min.js"></script>

<!-- Or a copy in your app. Keep the version in the file name, so an update is always a visible change. -->
<script src="/static/js/markin-0.3.0.min.js"></script>
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

The box the image has on your page is also the window it is zoomed in: see [Zoom and pan](#zoom-and-pan).

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
| `enable()` / `disable()` | A disabled editor edits nothing: pointer events pass through the annotations to whatever is underneath. Its view can still be zoomed and moved. |
| `setOptions(options)` / `getOptions()` | Change options at run time. |
| `refresh()` | Re-measure the canvas now. Only needed right after your own code scaled or moved it with a CSS transform; otherwise the editor re-measures by itself. |
| `getSVGElement()` / `getImageElement()` / `getContainerElement()` | The SVG, the image under it (or `null`), and the viewport that clips the zoomed picture (or `null`). |
| `destroy()` | Remove everything the editor added and put the page back. |

### View

| Method | Description |
|---|---|
| `getView()` | `{ x, y, width, height, scale }`: the visible part of the image in whole image pixels, and the screen pixels per image pixel. `null` while the page is not laid out. |
| `setView({ x, y, width, height })` | Show at least this part of the image, as large as it fits. |
| `zoomBy(factor, at?)` | Zoom in (`factor` above 1) or out, around `at = { x, y }` in image pixels, or else the middle of the view. |
| `fit()` | Show the whole image. |
| `zoomTo(id, { padding = 40 })` | Frame one annotation, with `padding` screen pixels around it. |
| `step(1)` / `step(-1)` | Select the next / the previous annotation, in the order of the list, and frame it. `false` at the ends. |
| `toImage(clientX, clientY)` | A point on screen as a point of the image. |
| `toClient(x, y)` | A point of the image as a point on screen. |

See [Zoom and pan](#zoom-and-pan) for what the user can do and for the limits.

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
| `canvasclick` | `{ position }` | A click that hit no annotation and was not a drag of the view. |
| `viewchange` | `{ x, y, width, height, scale }` | The view moved or the canvas changed size (at most once per frame). Also once for the first view. |
| `viewsettle` | `{ x, y, width, height, scale }` | The view has been still for `settleDelay` and shows another part of the image than when this last fired. Also for the first view, and for a new picture. |

`position` is in image pixels. A listener that throws is reported and skipped; it cannot interrupt the editor.

A listener may call back into the editor. `createAnnotation()` reports its `change` first and selects the new
annotation after that, so a `select` listener can already edit or delete it.

A press on an annotation does not bubble as `pointerdown` or `mousedown`; listen for `click`, or for the editor's own
`select`, if the rest of your page needs to know about it. A press on empty canvas bubbles as usual. The `click`
that the browser sends when a drag of the view is released is swallowed, so it is never taken for a click.

A disabled editor still emits `hover` (with `id: null`) and `canvasclick` (for every click, wherever it lands).

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
| `zoomControls` | `true` | Let the user zoom and pan. With `false` the view only moves through the methods. |
| `wheel` | `'pan'` | What a plain wheel or two-finger scroll does: `'pan'` or `'zoom'`. |
| `panOnEmpty` | `true` | A drag that starts on empty canvas moves the view, once it is zoomed in. |
| `maxScale` | `32` | How far the view zooms in, in screen pixels per image pixel. |
| `stepKeys` | `false` | `n` and `p` select the next and the previous annotation and frame it. |
| `settleDelay` | `250` | Milliseconds the view has to stay still before `viewsettle`. |
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
| `+`, `-` | Zoom in, zoom out. |
| Shift + 1, Shift + 0 | The whole image; the image at its real pixels. |
| Space (held) | A drag moves the view, from anywhere. |
| `n`, `p` | Next, previous annotation. Only with `stepKeys: true`. |

Keys are ignored while the user types in an `<input>`, `<textarea>`, `<select>` or editable element, also inside
web components. With several editors on a page, only the one the user last pressed on reacts; Space belongs to the
editor the pointer is over. Holding an arrow key is a single undo step. A key is only taken when it does
something: Ctrl / Cmd + Z when there is something to undo, `-` when the view can zoom out.

The zoom keys also work in a disabled editor. `keyboardControls: false` switches every key off.

## Zoom and pan

The editor zooms and pans by itself. There is nothing to wire up.

| Input | Action |
|---|---|
| Trackpad pinch, Ctrl / Cmd + wheel | Zoom towards the pointer. |
| Wheel, two-finger scroll | Move the view. With `wheel: 'zoom'`: zoom towards the pointer. |
| Drag on empty canvas | Move the view, once it is zoomed in (`panOnEmpty`). |
| Space + drag, middle-button drag | Move the view from anywhere, also from on top of an annotation. |
| `+` / `-`, Shift + 1, Shift + 0 | Zoom in / out, the whole image, real pixels. |

The view goes from the whole image, as your page lays it out, up to `maxScale` screen pixels per image pixel. It
stops a handle's width past the edges of the image, so a handle that sits on the edge can always be reached. A
click still selects, and a drag of the view never selects or edits anything.

While the whole image is in view, a plain wheel is left to the page, which scrolls as usual. A scroll that starts
by moving the view stays with the view until it ends, also at the edge.

`zoomControls: false` switches all of this input off. The [view methods](#view) keep working, so you can drive the
view from your own buttons.

### Working on the visible part

`getView()` is rounded outward and stays inside the image, so it can be used as a crop as it is. `viewsettle` is
the moment for work that is too expensive to do on every movement, such as running a model on what is visible:

```javascript
let latest = 0;
editor.on('viewsettle', async (view) => {
    const request = ++latest;
    const result = await analyse(imageId, view); // your code: view.x, view.y, view.width, view.height
    if (request !== latest) return;              // the view has moved on since: drop this answer
    show(result);
});
```

For a tool of your own that works on the picture, disable the editor. It then edits nothing, but its view still
moves, and it still tells you where the pointer is, in image pixels, at any zoom:

```javascript
editor.disable();
editor.on('canvasclick', ({ position }) => addPoint(position.x, position.y)); // never a drag of the view
editor.on('hover', ({ position }) => preview(position.x, position.y));
```

For anything else on screen, `toImage(event.clientX, event.clientY)` and `toClient(x, y)` convert both ways.
Reposition what you placed with `toClient()` on `viewchange`.

### Reviewing small objects

`step(1)` and `step(-1)` select the next and the previous annotation and frame it, which is what going through a
list of small objects needs. `stepKeys: true` puts them on `n` and `p`. They are off by default, because single
letters are often shortcuts of the app around the editor.

### What happens on your page

- Given an `<img>` or an `<svg>`, MarkinJS wraps it in a viewport (`<div class="markin-container">`) and, inside
  that, a stage (`<div class="markin-stage">`). Zooming is one CSS transform on the stage. `destroy()` unwraps.
- The box the image has on your page is the window. Zoomed in, the picture is clipped to it. At rest nothing is
  clipped and nothing is transformed: the page is exactly as you laid it out.
- An image that its own box crops (`object-fit: cover`) stays cropped: the view never shows more than your page
  shows at rest. `object-fit: contain` in a larger box works well: the picture grows into the empty room first.
- On a touch screen, one finger moves annotations and the view. Pinch is not handled yet: give touch users
  buttons that call `zoomBy()`.

## Styling

Everything MarkinJS draws lives in one `<g class="markin-layer">` and is output only: change the data, not the DOM.
For CSS there are stable hooks:

`.markin-annotation[data-class-id][data-selected]`, `.markin-bbox`, `.markin-polygon`,
`.markin-keypoint[data-name][data-v]`, `.markin-skeleton`, `.markin-handle`.

## Frameworks (React, Vue, …)

MarkinJS wraps the `<img>` or `<svg>` it is given in two `<div>`s, and `destroy()` unwraps it. If your framework
owns the markup, render that structure yourself, mark the stage, and pass the SVG:

```html
<div class="window">                                    <!-- the viewport: the size you want to see -->
    <div data-markin-stage style="position: relative; display: inline-block; line-height: 0">
        <img src="photo.jpg" alt="">
        <svg viewBox="0 0 1280 853" style="position: absolute; inset: 0; width: 100%; height: 100%"></svg>
    </div>
</div>
```

```javascript
const editor = MarkinJS.create(svgElement, { annotations });
// ...and in your cleanup:
editor.destroy();
```

The element marked `data-markin-stage` is what gets zoomed, and its parent is the viewport. MarkinJS changes
nothing else in your markup: it sets a transform on the stage and `overflow: hidden` on the viewport while the
view is zoomed in, and puts both back. The picture may be smaller than the viewport; it then stays where your
layout put it and grows from there.

An `<svg>` that is positioned over other content and has no marked stage is left exactly where it is. It edits as
usual but cannot zoom, and a warning says so (not with `zoomControls: false`).

The `viewBox` is the image's natural size; it defines the coordinate system and the area annotations stay inside.
Calling `create()` again on the same element replaces the earlier editor.

## Upgrading from 0.2

The data format, the methods and the events of 0.2 are unchanged. What 0.3 adds can still change how a page behaves:

- **Zoom and pan are on.** `zoomControls: false` leaves the wheel, the pinch and the keys alone, as before.
- **An `<svg>` passed to `create()` is wrapped** in a viewport and a stage, like an `<img>` always was, unless it
  is positioned over other content or you marked a stage (see above). `getContainerElement()` returns the
  viewport for it, where it returned `null`.
- **`disable()` stops editing, not everything.** The view can still be zoomed and moved, and `hover` and
  `canvasclick` are still emitted. Combine it with `zoomControls: false` for an editor that only shows.
- **`canvasclick` is not emitted for a drag of the view**, and the browser's `click` after such a drag is swallowed.
- **Another zoom library around the editor is no longer followed on the wheel.** Handles take their new size on
  the next pointer movement, or at once if you call `refresh()`. Better: drop that library.
- **`+`, `-`, Shift + 1, Shift + 0 and Space** are taken by the editor when they do something.

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
| `setZoom()`, `zoom`, `updateDimensions()` | not needed: zoom is built in (`zoomBy()`, `setView()`, …) |
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

Current Chrome, Edge, Firefox and Safari (Pointer Events are required). A trackpad pinch zooms in all of them,
and in web views built on WebKit.

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
