# Changelog

All notable changes to MarkinJS will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.0] - 2026-11-11

Zoom and pan are built in. The data format, the methods and the events of 0.2 are unchanged; "Upgrading from 0.2"
in the README lists what can still change on a page.

### Added
- Zoom and pan by hand. A trackpad pinch and Ctrl / Cmd + wheel zoom towards the pointer. The wheel, a drag on
  empty canvas, Space + drag and the middle button move the view. `+`, `-`, Shift + 1 (whole image) and
  Shift + 0 (real pixels) work from the keyboard. A click still selects; a drag of the view never edits.
- `getView()`, `setView()`, `zoomBy()`, `fit()`, `zoomTo()`, `toImage()` and `toClient()`. `getView()` reports the
  visible part of the image in whole image pixels, rounded outward and inside the image, so it can be used as a crop.
- `viewchange` (at most once per frame while the view moves) and `viewsettle` (once the view has been still for
  `settleDelay`, and only for another part of the image than last time).
- `step(1)` / `step(-1)` select the next / previous annotation and frame it. `stepKeys` puts them on `n` and `p`.
- Options `zoomControls`, `wheel` (`'pan'` or `'zoom'`), `panOnEmpty`, `maxScale`, `stepKeys` and `settleDelay`.
- `data-markin-stage` marks the element to zoom when the page owns the markup around the SVG.
- Tests that drive real wheel, pinch, pointer and keyboard input for all of the above (409 tests in total).

### Changed
- The canvas sits in a viewport and a stage, and zooming is one CSS transform on the stage. An `<svg>` passed to
  `create()` is now wrapped like an `<img>`, unless it is positioned over other content or a stage is marked.
  `getContainerElement()` returns the viewport for it. At rest nothing is transformed or clipped.
- `disable()` stops editing only: the view still zooms and moves, and `hover` and `canvasclick` are still emitted,
  so a tool of the app can work on the picture while the editor is disabled.
- `canvasclick` is not emitted for a drag of the view, and the browser's `click` after such a drag is swallowed.
- The size of the canvas on screen is measured from its box, not from `getScreenCTM()`, which leaves the scale of
  a CSS-transformed ancestor out in WebKit.
- The wheel is no longer watched to follow a zoom applied by another library. `refresh()` does that on request.
- A `load` event for the picture that is already shown no longer counts as a new picture.

## [0.2.0] - 2026-11-10

A rewrite of the library. The API is smaller and **not compatible with 0.1**; see
"Migrating from 0.1" in the README.

### Changed
- Annotations are plain data owned by the editor. The SVG is drawn from that data and never read back,
  so selection handles, undo snapshots and export can no longer corrupt each other.
- One data format, the same in and out: `id`, `class_id`, `bbox: [x, y, width, height]`,
  `segments: [[x, y], ...]`, `keypoints: [{ name, point, v }]`. Unknown fields are kept.
- One entry point, `MarkinJS.create(svgOrImg, options)`, with `options.annotations` for the initial data.
  Server-rendered annotation markup is no longer adopted.
- One `change` event after every completed edit (including undo and redo), carrying the full list.
- Pointer Events instead of mouse events: touch and pen work, a drag is captured, and it always ends.
- Drags are computed from the position at press time, so limits never make a shape drift from the pointer.
- Handles, keypoints and outlines are sized from the measured on-screen scale. `setZoom()` and the `zoom`
  option are gone.
- Keyboard shortcuts are ignored while typing in a field, limited to the editor used last, and a held
  arrow key is one undo step.
- Colours come from `options.colors` by `class_id`. Binding, containment, deletion rules and the skeleton
  are editor options rather than per-annotation settings.
- Tests run real pointer and keyboard interaction (270 tests).

### Added
- `load()`, `clear()`, `select()`, `getSelection()`, `getAnnotation()`, `canUndo()`, `canRedo()`,
  `setOptions()`, `refresh()`, `MarkinJS.normalize()`, `MarkinJS.denormalize()`.
- `constrainToImage` (default on): annotations cannot be dragged out of the image.
- Keypoint visibility `v` (0 not labelled, 1 occluded, 2 visible).
- Escape cancels a drag; Ctrl + Y redoes.
- `dist/markin-<version>.min.js`, a build with the version in its file name.

### Fixed
- The build (`npm run build` failed after the module export was removed from `markin.js`).
- The package entry points: bundlers were handed the script-tag build, which has no exports.
- Type definitions are now tracked in the repository and published.
- Everything listed under "Changed" replaces behaviour that lost or corrupted data in 0.1: Backspace in
  a text field deleting the selection, `updateAnnotation` wiping geometry, keypoints collapsing in small
  boxes, undo restoring stale handles, a drag stuck after a listener threw, and others.

### Removed
- `createAnnotator`, `createImageAnnotator`, the `export*` methods, `setZoom`, `saveState`, the
  per-feature setters, most events, and the options `zoom` and `autoResizeBbox`.

## [0.0.1] - 2025-01-19

### Added
- Initial release of MarkinJS
- Core annotation functionality
  - Bounding box annotations with resize handles
  - Polygon annotations with draggable vertices
  - Keypoint annotations with precise positioning
  - Hierarchical grouping of annotation elements
- Image overlay system
  - `MarkinJS.createImageAnnotator()` for automatic SVG overlay creation
  - `MarkinJS.createAnnotator()` for existing SVG elements
- Interactive features
  - Drag and drop for all annotation types
  - Selection system with visual feedback
  - Keyboard controls for precise movement (1px, 10px, 0.2px)
  - Delete key support for removing selected elements
- Advanced annotation features
  - Element binding (child elements move with parents)
  - Containment rules (keep elements within boundaries)
  - Customizable deletion rules (cascade deletion behavior)
  - UUID-based element identification
- Comprehensive event system
  - Selection events (`select`, `deselect`, `deselection`)
  - Interaction events (`dragstart`, `drag`, `dragend`, `elementmoved`)
  - Lifecycle events (`annotationcreated`, `delete`, `deletegroup`)
  - State change events (`enabled`, `disabled`, `zoomchange`)
- Configuration options
  - Zoom level support
  - Keyboard controls toggle
  - Element binding configuration
  - Containment rule settings
  - Custom deletion rule definitions
- Zero-dependency architecture
  - Pure JavaScript implementation
  - No external libraries required
  - Modern browser compatibility

### Technical Details
- **File Size**: ~25KB uncompressed
- **Browser Support**: Chrome 60+, Firefox 55+, Safari 12+, Edge 79+
- **Dependencies**: None
- **License**: MIT

### Known Issues
- API is unstable and subject to breaking changes
- No automated tests yet
- Documentation may be incomplete
- No TypeScript definitions

### Breaking Changes
- This is the initial release, so no breaking changes yet
- Future versions before 1.0.0 may include breaking changes

---

## Release Notes

### Version 0.0.1 Notes

This is the initial public release of MarkinJS. The library is functional but should be considered **unstable**. We recommend using it for:

- Prototyping and experimentation
- Non-production annotation tools  
- Research projects
- Personal projects

**Not recommended for:**
- Production applications
- Critical data annotation workflows
- Large-scale deployments

### Migration Guide

Since this is the first release, there are no migrations required.

### Roadmap to 1.0.0

Before reaching stable 1.0.0, we plan to:

1. **API Stabilization** - Lock down the public API
2. **Comprehensive Testing** - Unit tests, integration tests, browser testing
3. **Documentation** - Complete API docs, tutorials, examples
4. **Performance** - Optimize for large datasets and complex annotations
5. **TypeScript** - Add full TypeScript definitions
6. **Framework Integration** - React, Vue, Angular components

### Contributing

MarkinJS is currently in active development. We welcome:

- Bug reports and issues
- Feature requests  
- Documentation improvements
- Code contributions (after discussing in issues)

Contact: markinjs@datamarkin.com

---

## Semantic Versioning

MarkinJS follows [Semantic Versioning](https://semver.org/):

- **MAJOR** version for incompatible API changes
- **MINOR** version for backwards-compatible functionality additions  
- **PATCH** version for backwards-compatible bug fixes

Since we're in 0.x.x territory, **minor versions may include breaking changes** until we reach 1.0.0.