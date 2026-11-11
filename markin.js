// MarkinJS - SVG annotation editor for computer vision and image labeling.
//
// One file, no dependencies. Load it with a classic <script> tag (global `MarkinJS`);
// the build wraps the same file for ESM and CommonJS.
//
// The annotations are plain data owned by the editor. The SVG is drawn from that data and
// is never read back, so selection chrome, undo snapshots and export cannot corrupt each other.
const MarkinJS = (function () {
    'use strict';

    const VERSION = '0.2.0';
    const SVG_NS = 'http://www.w3.org/2000/svg';

    const EVENTS = [
        'change',
        'select',
        'deselect',
        'dragstart',
        'drag',
        'dragend',
        'hover',
        'canvasclick',
        'viewchange',
        'viewsettle'
    ];
    const PARTS = ['bbox', 'polygon', 'keypoint'];
    const ARROWS = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };

    const DRAG_THRESHOLD = 3; // screen px a press must travel before it becomes a drag
    const HANDLE_SLOP = 6; // extra screen px of grab area around a handle
    const NUDGE_COMMIT_MS = 800; // idle time after which a run of arrow-key nudges becomes one undo step
    const WHEEL_RUN_MS = 200; // wheel events closer together than this are one movement of the wheel or the fingers
    const KEY_ZOOM = 1.25; // how much + and - zoom
    const WHEEL_LINE = 33; // pixels in one "line" of a wheel that reports lines: three lines are one notch

    // Every option: [default, kind]. A kind ending in "?" also accepts null.
    const OPTIONS = {
        annotations: [null, 'array?'],
        colors: [null, 'object?'],
        color: ['#0000FF', 'string'],
        skeleton: [null, 'skeleton?'],
        skeletonStyle: [null, 'object?'],
        bindElements: [true, 'boolean'],
        bboxContainPolygon: [true, 'boolean'],
        bboxContainKeypoints: [true, 'boolean'],
        constrainToImage: [true, 'boolean'],
        requireBbox: [false, 'boolean'],
        requireSelectionToDrag: [true, 'boolean'],
        keyboardControls: [true, 'boolean'],
        deletionRules: [{ bbox: ['polygon', 'keypoint'], polygon: ['bbox'], keypoint: [] }, 'rules'],
        historyEnabled: [true, 'boolean'],
        historyMaxStates: [50, 'positive'],
        strokeWidth: [2, 'positive'],
        keypointRadius: [5, 'positive'],
        handleRadius: [5, 'positive'],
        maxScale: [32, 'positive'],
        settleDelay: [250, 'delay'],
        zoomControls: [true, 'boolean'],
        panOnEmpty: [true, 'boolean'],
        stepKeys: [false, 'boolean'],
        wheel: ['pan', 'wheel'],
        strict: [false, 'boolean'],
        silent: [false, 'boolean'],
        logger: [null, 'function?']
    };
    const DEFAULTS = {};
    for (const key of Object.keys(OPTIONS)) DEFAULTS[key] = OPTIONS[key][0];
    // Options that hold data rather than a single value. They are copied on the way in and out.
    const DATA_OPTIONS = Object.keys(OPTIONS).filter((key) => /^(object|skeleton|rules)/.test(OPTIONS[key][1]));

    // Names from the 0.1 API. They are only used to turn a silent mistake into a clear message.
    const OLD_EVENTS = {
        annotationcreated: 'change',
        annotationupdated: 'change',
        annotationmodified: 'drag',
        annotationmodificationcomplete: 'change',
        elementmoved: 'change',
        keypointadded: 'change',
        delete: 'change',
        deletegroup: 'change',
        hoverelement: 'hover',
        hovercanvas: 'hover'
    };
    const OLD_OPTIONS = {
        zoom: 'removed: zoom is built in (see zoomBy and setView), and sizes follow the on-screen scale',
        autoResizeBbox: 'removed: it never had an effect',
        keypointSkeleton: 'renamed to "skeleton"',
        keypointSkeletonStyle: 'renamed to "skeletonStyle"'
    };

    const weakRefTo = (object) => (typeof WeakRef === 'function' ? new WeakRef(object) : { deref: () => object });

    // The editor that last saw pointer or selection activity. It alone reacts to the keyboard.
    // Held weakly: an editor the host dropped without destroy() must not be kept alive by it.
    let keyboardRef = null;
    function keyboardOwner() {
        const editor = keyboardRef && keyboardRef.deref();
        return editor && !editor.dead && editor.svg.isConnected ? editor : null;
    }
    // A press by the user always takes the keyboard (`force`). Code only takes it when no live
    // editor has it, so selecting from code in one editor cannot take it from another.
    function claimKeyboard(editor, force) {
        const owner = keyboardOwner();
        if (owner !== editor && (force || !owner)) keyboardRef = weakRefTo(editor);
    }
    // target element (svg or img) -> its editor, so a second create() replaces the first.
    const registry = new WeakMap();

    // ------------------------------------------------------------------ helpers

    const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
    const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
    const isPoint = (p) => Array.isArray(p) && p.length === 2 && isNum(p[0]) && isNum(p[1]);
    const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
    const copy = (v) => JSON.parse(JSON.stringify(v));
    const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
    // Ids are strings or numbers. Anything else can never name an annotation.
    const keyOf = (id) => (typeof id === 'string' || isNum(id) ? String(id) : null);
    // An id as it appears in a message. Building the message must never throw.
    const idText = (id) => (keyOf(id) === null ? `(${typeof id})` : `"${id}"`);

    const hasBox = (a) => Array.isArray(a.bbox);
    const hasPolygon = (a) => Array.isArray(a.segments) && a.segments.length >= 3;
    const keypointsOf = (a) => (Array.isArray(a.keypoints) ? a.keypoints : []);
    const hasGeometry = (a) => hasBox(a) || hasPolygon(a) || keypointsOf(a).length > 0;
    // A keypoint with v = 0 is "not labelled": it is not drawn and never moves with its annotation.
    const isLabelled = (kp) => kp.v !== 0;
    const corners = (bbox) => ({ x1: bbox[0], y1: bbox[1], x2: bbox[0] + bbox[2], y2: bbox[1] + bbox[3] });
    const toBbox = (box) => [box.x1, box.y1, box.x2 - box.x1, box.y2 - box.y1];
    const deselected = (sel) => ({ id: sel.id, part: sel.part, index: sel.index });
    const NO_LIMIT = Object.freeze({ x1: -Infinity, y1: -Infinity, x2: Infinity, y2: Infinity });

    // Client pixels -> SVG user space, through the inverse of matrix `m`.
    function unmap(m, clientX, clientY) {
        const det = m.a * m.d - m.b * m.c;
        const x = clientX - m.e;
        const y = clientY - m.f;
        return { x: (m.d * x - m.c * y) / det, y: (m.a * y - m.b * x) / det };
    }

    // Keep a view within its limits. `g` is the geometry it is measured in (see Editor._geometry).
    //
    // The scale runs from 1, the picture as the page lays it out, up to `g.maxScale`. Along each
    // axis the picture then either still fits in the viewport, and stays where the layout had it
    // (centred, if it was centred), or it is larger, and can be moved until an edge of it comes
    // `slack` pixels into view: enough to reach a handle that sits on the edge.
    function clampView(scale, x, y, g, slack) {
        const s = clamp(scale, 1, g.maxScale);
        const along = (t, size, o, from, to) => {
            // Nothing outside what the viewport shows at rest can ever be seen: an image cropped
            // by its own box stays cropped.
            const a = Math.max(from, -o);
            const b = Math.min(to, size - o);
            if (!(b > a)) return 0;
            const length = (b - a) * s;
            if (length <= size) {
                const spare = size - (b - a);
                const share = spare > 1e-6 ? (o + a) / spare : 0.5;
                return share * (size - length) - o - s * a;
            }
            const give = Math.min(slack, (length - size) / 2);
            return clamp(t, size - give - o - s * b, give - o - s * a);
        };
        // Whole thousandths: what is written to the page and what is remembered are the same number.
        const round = (v, digits) => {
            const n = Number(v.toFixed(digits));
            return Math.abs(n) < 1e-6 ? 0 : n;
        };
        return {
            scale: round(s, 6),
            x: round(along(x, g.width, g.ox, g.x1, g.x2), 3),
            y: round(along(y, g.height, g.oy, g.y1, g.y2), 3)
        };
    }

    // Limit a translation `d` of the interval [a, b] so it stays inside [A, B].
    // An interval too large to fit is kept covering [A, B] instead.
    function clampDelta(d, a, b, A, B) {
        const lo = A - a;
        const hi = B - b;
        return lo <= hi ? clamp(d, lo, hi) : clamp(d, hi, lo);
    }

    // Where a point at `from` ends up when it is moved to (x, y): inside `box`, then inside `image`
    // (pass NO_LIMIT for either). An axis the move does not go `along` keeps its exact old value,
    // even where that lies outside a limit: editing one coordinate must not silently rewrite the other.
    function placed(from, x, y, alongX, alongY, box, image) {
        return [
            alongX ? clamp(clamp(x, box.x1, box.x2), image.x1, image.x2) : from[0],
            alongY ? clamp(clamp(y, box.y1, box.y2), image.y1, image.y2) : from[1]
        ];
    }

    function extent(points) {
        if (!points.length) return null;
        let x1 = Infinity;
        let y1 = Infinity;
        let x2 = -Infinity;
        let y2 = -Infinity;
        for (const p of points) {
            if (p[0] < x1) x1 = p[0];
            if (p[0] > x2) x2 = p[0];
            if (p[1] < y1) y1 = p[1];
            if (p[1] > y2) y2 = p[1];
        }
        return { x1, y1, x2, y2 };
    }

    // Every point of the given parts of an annotation.
    function pointsOf(ann, parts) {
        const points = [];
        if (parts.includes('bbox') && hasBox(ann)) {
            const b = corners(ann.bbox);
            points.push([b.x1, b.y1], [b.x2, b.y2]);
        }
        if (parts.includes('polygon') && hasPolygon(ann)) {
            for (const p of ann.segments) points.push(p);
        }
        if (parts.includes('keypoint')) {
            for (const kp of keypointsOf(ann)) if (isLabelled(kp)) points.push(kp.point);
        }
        return points;
    }

    // Annotations never change once stored, so what is derived from one can be remembered with it.
    const areas = new WeakMap();
    function areaOf(ann) {
        let area = areas.get(ann);
        if (area === undefined) {
            const box = extent(pointsOf(ann, [hasBox(ann) ? 'bbox' : hasPolygon(ann) ? 'polygon' : 'keypoint']));
            area = box ? (box.x2 - box.x1) * (box.y2 - box.y1) : 0;
            areas.set(ann, area);
        }
        return area;
    }

    // Parts that are already frozen are shared with an earlier version and are skipped.
    function deepFreeze(value) {
        if (Object.isFrozen(value)) return value; // also true for anything that is not an object
        Object.freeze(value);
        for (const child of Array.isArray(value) ? value : Object.values(value)) deepFreeze(child);
        return value;
    }

    // True when two pieces of stored data are equal. Parts they share are equal at a glance.
    function sameData(a, b) {
        if (a === b) return true;
        if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
        if (Array.isArray(a) !== Array.isArray(b)) return false;
        const keys = Object.keys(a);
        const other = Object.keys(b);
        return keys.length === other.length && keys.every((key, i) => key === other[i] && sameData(a[key], b[key]));
    }

    function newId() {
        const c = typeof crypto !== 'undefined' ? crypto : null;
        if (c && typeof c.randomUUID === 'function') return c.randomUUID();
        const bytes = new Uint8Array(16);
        if (c && typeof c.getRandomValues === 'function') c.getRandomValues(bytes);
        else for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
        bytes[6] = (bytes[6] & 0x0f) | 0x40;
        bytes[8] = (bytes[8] & 0x3f) | 0x80;
        const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
        return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    }

    // Write attributes, touching the DOM only where a value differs. `was` is what the previous
    // call wrote to this node, if the caller kept it: comparing with it saves reading the DOM back.
    function setAttrs(node, attrs, was) {
        for (const name of Object.keys(attrs)) {
            const value = attrs[name];
            if (was && was[name] === value) continue;
            if (value === null || value === undefined) {
                if (node.hasAttribute(name)) node.removeAttribute(name);
            } else {
                const text = String(value);
                if (node.getAttribute(name) !== text) node.setAttribute(name, text);
            }
        }
        return node;
    }

    function svgEl(doc, tag, attrs) {
        const node = doc.createElementNS(SVG_NS, tag);
        return attrs ? setAttrs(node, attrs) : node;
    }

    // Add an event listener and get back the function that removes it.
    function listen(target, type, listener, options) {
        target.addEventListener(type, listener, options);
        return () => target.removeEventListener(type, listener, options);
    }

    // Listen on a long-lived target (document, window) without keeping `owner` alive. If the host
    // drops an editor without calling destroy(), the listener removes itself once it is collected.
    // Nothing in here may close over `owner`, or the listener would hold it after all.
    function weakListen(target, type, owner, method, options) {
        const ref = weakRefTo(owner);
        const stop = listen(
            target,
            type,
            (event) => {
                const live = ref.deref();
                if (live) live[method](event);
                else stop();
            },
            options
        );
        return stop;
    }

    // How an <svg> fits its viewBox into its box: where the spare room goes (0, 0.5 or 1 on each
    // axis) and whether it fills the box instead (`slice`). Null for "none", which stretches.
    function aspectOf(svg) {
        const text = (svg.getAttribute('preserveAspectRatio') || '').trim();
        if (/^none(\s|$)/.test(text)) return null;
        const match = /^x(Min|Mid|Max)Y(Min|Mid|Max)(?:\s+(meet|slice))?$/.exec(text);
        const at = { Min: 0, Mid: 0.5, Max: 1 };
        return match
            ? { x: at[match[1]], y: at[match[2]], slice: match[3] === 'slice' }
            : { x: 0.5, y: 0.5, slice: false };
    }

    // True for an element the user types into.
    function isTypingElement(target) {
        if (!target || typeof target.closest !== 'function') return false;
        if (target.isContentEditable) return true;
        // A custom element may keep a field in a closed shadow root, which cannot be inspected.
        if (typeof target.localName === 'string' && target.localName.includes('-') && !target.shadowRoot) return true;
        return !!target.closest(
            'input, textarea, select, [contenteditable=""], [contenteditable="true"], ' +
                '[contenteditable="plaintext-only"], [role="textbox"]'
        );
    }

    // True when a key event comes from something the user types into, also inside open shadow roots.
    function isTypingTarget(event) {
        const path = typeof event.composedPath === 'function' ? event.composedPath() : [];
        return isTypingElement(path[0] || event.target);
    }

    // ------------------------------------------------------------------ data

    // Validate one annotation. Returns { value } (a deep copy) or { error }.
    // MarkinJS owns id, class_id, bbox, segments and keypoints[].point / name / v.
    // Every other field is carried through untouched, so saving the exported data loses nothing.
    function parseAnnotation(input) {
        if (!isObject(input)) return { error: 'an annotation must be an object' };
        // Check the copy that will be stored, not the caller's object: the two can differ
        // (sparse arrays, toJSON, values JSON cannot hold).
        let value;
        try {
            value = copy(input);
        } catch (err) {
            return { error: `an annotation must be plain JSON data (${err.message})` };
        }
        if (!isObject(value)) return { error: 'an annotation must be plain JSON data' };
        const { id, class_id: classId, bbox, segments, keypoints } = value;

        if (id != null && !isNum(id) && !(typeof id === 'string' && id !== '')) {
            return { error: 'id must be a number or a non-empty string' };
        }
        if (classId != null && !isNum(classId) && typeof classId !== 'string') {
            return { error: 'class_id must be a number or a string' };
        }
        if (bbox != null && !(Array.isArray(bbox) && bbox.length === 4 && bbox.every(isNum))) {
            return { error: 'bbox must be [x, y, width, height] with finite numbers' };
        }
        if (segments != null) {
            if (!Array.isArray(segments) || !segments.every(isPoint)) {
                return { error: 'segments must be an array of [x, y] points with finite numbers' };
            }
            if (segments.length > 0 && segments.length < 3) return { error: 'segments needs at least 3 points' };
        }
        if (keypoints != null) {
            if (!Array.isArray(keypoints)) return { error: 'keypoints must be an array' };
            for (let i = 0; i < keypoints.length; i++) {
                const kp = keypoints[i];
                if (!isObject(kp) || !isPoint(kp.point)) {
                    return { error: `keypoints[${i}] must be an object with point: [x, y]` };
                }
                if (kp.name != null && typeof kp.name !== 'string') {
                    return { error: `keypoints[${i}].name must be a string` };
                }
                if (kp.v != null && kp.v !== 0 && kp.v !== 1 && kp.v !== 2) {
                    return { error: `keypoints[${i}].v must be 0, 1 or 2` };
                }
            }
        }

        if (hasBox(value)) {
            // A negative size is the same box described from the other corner.
            let [x, y, w, h] = value.bbox;
            if (w < 0) {
                x += w;
                w = -w;
            }
            if (h < 0) {
                y += h;
                h = -h;
            }
            value.bbox = [x, y, w, h];
        }
        if (!hasGeometry(value)) return { error: 'an annotation needs a bbox, segments or keypoints' };
        return { value };
    }

    // Pass every coordinate of `annotations` through fx (horizontal) or fy (vertical), in place:
    // the caller hands over copies it owns. Positions are first moved by (-ox, -oy); sizes are not.
    function mapped(annotations, fx, fy, ox = 0, oy = 0) {
        const map = (p) => [fx(p[0] - ox), fy(p[1] - oy)];
        for (const ann of annotations) {
            if (hasBox(ann)) ann.bbox = [...map(ann.bbox), fx(ann.bbox[2]), fy(ann.bbox[3])];
            if (Array.isArray(ann.segments)) ann.segments = ann.segments.map(map);
            for (const kp of keypointsOf(ann)) kp.point = map(kp.point);
        }
        return annotations;
    }

    // Validated copies for the static helpers, which have no editor to report problems to.
    function checked(name, annotations, width, height) {
        if (!Array.isArray(annotations)) throw new TypeError(`MarkinJS.${name}: annotations must be an array`);
        if (!(isNum(width) && width > 0 && isNum(height) && height > 0)) {
            throw new TypeError(`MarkinJS.${name}: width and height must be positive numbers`);
        }
        return annotations.map((annotation, i) => {
            const result = parseAnnotation(annotation);
            if (result.error) throw new TypeError(`MarkinJS.${name}: annotations[${i}]: ${result.error}`);
            return result.value;
        });
    }

    // Pixel coordinates -> 0..1 fractions of the image size.
    function normalize(annotations, width, height) {
        return mapped(
            checked('normalize', annotations, width, height),
            (x) => x / width,
            (y) => y / height
        );
    }

    // 0..1 fractions of the image size -> pixel coordinates.
    function denormalize(annotations, width, height) {
        return mapped(
            checked('denormalize', annotations, width, height),
            (x) => x * width,
            (y) => y * height
        );
    }

    // ------------------------------------------------------------------ options

    function optionProblem(key, value) {
        const kind = OPTIONS[key][1];
        const optional = kind.endsWith('?');
        if (optional && value === null) return null;
        switch (optional ? kind.slice(0, -1) : kind) {
            case 'boolean':
                return typeof value === 'boolean' ? null : 'must be true or false';
            case 'string':
                return typeof value === 'string' && value ? null : 'must be a non-empty string';
            case 'positive':
                return isNum(value) && value > 0 ? null : 'must be a positive number';
            case 'delay':
                return isNum(value) && value >= 0 ? null : 'must be a number of milliseconds, 0 or more';
            case 'wheel':
                return value === 'pan' || value === 'zoom' ? null : 'must be "pan" or "zoom"';
            case 'function':
                return typeof value === 'function' ? null : 'must be a function';
            case 'array':
                return Array.isArray(value) ? null : 'must be an array';
            case 'object':
                return isObject(value) ? null : 'must be an object';
            case 'skeleton': {
                const isRef = (r) => typeof r === 'string' || (Number.isInteger(r) && r >= 0);
                const ok =
                    Array.isArray(value) && value.every((e) => Array.isArray(e) && e.length === 2 && e.every(isRef));
                return ok ? null : 'must be an array of [from, to] pairs of keypoint names or indices';
            }
            case 'rules': {
                const roles = [...PARTS, 'annotation'];
                const ok =
                    isObject(value) &&
                    Object.keys(value).every(
                        (role) =>
                            PARTS.includes(role) &&
                            Array.isArray(value[role]) &&
                            value[role].every((r) => roles.includes(r))
                    );
                return ok ? null : 'must map bbox / polygon / keypoint to arrays of those names (or "annotation")';
            }
            default:
                return null;
        }
    }

    // Merge user options over `base`. Problems are passed to `report` and the option is skipped.
    function resolveOptions(input, base, report) {
        const options = { ...base };
        if (input === null || input === undefined) return options;
        if (!isObject(input)) {
            report('options must be an object');
            return options;
        }
        for (const key of Object.keys(input)) {
            const value = input[key];
            if (!own(DEFAULTS, key)) {
                report(own(OLD_OPTIONS, key) ? `option "${key}" was ${OLD_OPTIONS[key]}` : `unknown option "${key}"`);
            } else if (value !== undefined) {
                let mine = value;
                if (DATA_OPTIONS.includes(key) && value !== null) {
                    // Keep a private copy, so the host changing its object later cannot break drawing.
                    try {
                        mine = copy(value);
                    } catch {
                        mine = undefined;
                    }
                }
                const problem = mine === undefined ? 'must be plain JSON data' : optionProblem(key, mine);
                if (problem) report(`option "${key}" ${problem}`);
                else options[key] = key === 'deletionRules' ? { ...base.deletionRules, ...mine } : mine;
            }
        }
        return options;
    }

    // ------------------------------------------------------------------ image overlay

    // Where the browser draws an image of natural size (nw, nh) inside a content box of (cw, ch),
    // following object-fit and object-position.
    function drawnRect(nw, nh, cw, ch, fit, position) {
        let w = cw;
        let h = ch;
        const contain = Math.min(cw / nw, ch / nh);
        if (fit === 'contain' || (fit === 'scale-down' && contain < 1)) {
            w = nw * contain;
            h = nh * contain;
        } else if (fit === 'cover') {
            const cover = Math.max(cw / nw, ch / nh);
            w = nw * cover;
            h = nh * cover;
        } else if (fit === 'none' || fit === 'scale-down') {
            w = nw;
            h = nh;
        }
        // The computed object-position is two values, each a percentage or a length.
        const parts = String(position || '')
            .trim()
            .split(/\s+/);
        const at = (value, free) =>
            /%$/.test(value) ? (free * parseFloat(value)) / 100 : /px$/.test(value) ? parseFloat(value) : free / 2;
        return { x: at(parts[0] || '', cw - w), y: at(parts[1] || '', ch - h), width: w, height: h };
    }

    // Zoom and pan are one CSS transform on a "stage" that holds the picture and the SVG, inside a
    // "viewport" that clips it. Build the two around `subject`, in its place.
    function wrapInStage(subject, blockLevel) {
        const doc = subject.ownerDocument;
        const viewport = doc.createElement('div');
        viewport.className = 'markin-container';
        viewport.style.cssText = `position:relative;display:${blockLevel ? 'block' : 'inline-block'};line-height:0`;
        const stage = doc.createElement('div');
        stage.className = 'markin-stage';
        // Nothing in the stage is text: a drag across it moves the view, it does not select.
        stage.style.cssText = 'position:relative;user-select:none;-webkit-user-select:none';
        subject.parentNode.insertBefore(viewport, subject);
        viewport.appendChild(stage);
        stage.appendChild(subject);
        return { viewport, stage };
    }

    const BLOCK_LEVEL = /^(block|flex|grid|table|list-item|flow-root)$/;

    // Wrap an <img> in a viewport and a stage, and lay an <svg> exactly over the drawn image.
    // The SVG's viewBox is the image's natural size, so annotations are in image pixels.
    function mountOverImage(image, onChange, note) {
        const doc = image.ownerDocument;
        const win = doc.defaultView;
        // An <img> inside <picture> has to stay there, or the browser stops choosing among its sources.
        const inPicture = !!image.parentNode && image.parentNode.localName === 'picture';
        const subject = inPicture ? image.parentNode : image;
        const parent = subject.parentNode;
        if (!parent) throw new TypeError('MarkinJS.create: the image must be in the document');

        const styleOf = () => (win && typeof win.getComputedStyle === 'function' ? win.getComputedStyle(image) : null);
        const px = (value) => parseFloat(value) || 0;
        const before = [image.offsetWidth, image.offsetHeight];
        const resized = () => image.offsetWidth !== before[0] || image.offsetHeight !== before[1];
        const { viewport: container, stage } = wrapInStage(subject, BLOCK_LEVEL.test((styleOf() || {}).display || ''));
        // Wrapping must not change how the image is laid out; a percentage width is the usual casualty.
        if (resized()) {
            container.style.width = '100%';
            if (resized()) {
                container.style.width = '';
                note('wrapping the image changed its size on the page. Create the editor on your own <svg> instead.');
            }
        }
        if (inPicture || image.hasAttribute('srcset')) {
            note(
                'the image uses srcset or <picture>: coordinates follow the size the browser reports for the chosen source.'
            );
        }

        const svg = svgEl(doc, 'svg', { class: 'markin-overlay', preserveAspectRatio: 'none' });
        svg.style.cssText = 'position:absolute;left:0;top:0;width:100%;height:100%;overflow:visible';
        stage.appendChild(svg);

        let shown = null; // the picture last seen: its address and size
        const sync = () => {
            const nw = image.naturalWidth;
            const nh = image.naturalHeight;
            const loaded = nw > 0 && nh > 0;
            // A `load` event alone does not mean another picture: the browser also sends one,
            // late, for an image it already had.
            const picture = loaded ? `${image.currentSrc || image.src} ${nw} ${nh}` : shown;
            const fresh = shown !== null && picture !== shown;
            shown = picture;
            if (loaded) svg.setAttribute('viewBox', `0 0 ${nw} ${nh}`);
            svg.style.visibility = loaded ? '' : 'hidden';

            const style = styleOf();
            // Until the drawn image can be measured, the overlay simply covers the container.
            let place = { left: '0', top: '0', width: '100%', height: '100%', clipPath: '' };
            if (loaded && style && image.clientWidth > 0 && image.clientHeight > 0) {
                // The image's content box, in layout pixels: borders and padding are not part of the picture.
                const left = px(style.borderLeftWidth) + px(style.paddingLeft);
                const top = px(style.borderTopWidth) + px(style.paddingTop);
                const right = px(style.borderRightWidth) + px(style.paddingRight);
                const bottom = px(style.borderBottomWidth) + px(style.paddingBottom);
                const border = style.boxSizing === 'border-box';
                let cw = px(style.width) - (border ? left + right : 0);
                let ch = px(style.height) - (border ? top + bottom : 0);
                if (!(cw > 0 && ch > 0)) {
                    cw = image.clientWidth - px(style.paddingLeft) - px(style.paddingRight);
                    ch = image.clientHeight - px(style.paddingTop) - px(style.paddingBottom);
                }
                if (cw > 0 && ch > 0) {
                    const drawn = drawnRect(nw, nh, cw, ch, style.objectFit, style.objectPosition);
                    // Where the image is cropped by its box, crop the overlay the same way.
                    const cut = [-drawn.y, drawn.x + drawn.width - cw, drawn.y + drawn.height - ch, -drawn.x];
                    place = {
                        left: `${image.offsetLeft + left + drawn.x}px`,
                        top: `${image.offsetTop + top + drawn.y}px`,
                        width: `${drawn.width}px`,
                        height: `${drawn.height}px`,
                        clipPath: cut.some((n) => n > 0.5)
                            ? `inset(${cut.map((n) => `${Math.max(0, n)}px`).join(' ')})`
                            : ''
                    };
                }
            }
            Object.assign(svg.style, place);
            onChange(fresh);
        };

        const stopLoad = listen(image, 'load', sync);
        const Observer = win && win.ResizeObserver;
        const observer = typeof Observer === 'function' ? new Observer(sync) : null;
        if (observer) observer.observe(image);

        const teardown = () => {
            stopLoad();
            if (observer) observer.disconnect();
            if (container.parentNode) container.replaceWith(subject);
        };
        return { image, container, stage, svg, sync, teardown };
    }

    // The viewport and stage for an editor on the host's own <svg>, or null when there are none:
    // the editor then works as before, without zoom.
    //
    // A host that owns its markup (a framework, or an <svg> laid over a picture) marks the element
    // to be zoomed with `data-markin-stage`; that element's parent is the viewport. Any other
    // <svg> is wrapped, unless that would move or resize it.
    function mountAroundSvg(svg, note) {
        const marked = svg.parentElement ? svg.parentElement.closest('[data-markin-stage]') : null;
        if (marked) {
            const viewport = marked.parentElement;
            if (!viewport) return null;
            const saved = [marked.style.transform, marked.style.transformOrigin, viewport.style.overflow];
            const cursor = viewport.style.cursor;
            const select = marked.style.userSelect;
            // A drag across the stage moves the view; it must not select the page around it.
            marked.style.userSelect = 'none';
            const teardown = () => {
                [marked.style.transform, marked.style.transformOrigin, viewport.style.overflow] = saved;
                viewport.style.cursor = cursor;
                marked.style.userSelect = select;
            };
            return { container: viewport, stage: marked, saved, cursor, teardown };
        }
        if (!svg.parentNode) return null;

        const win = svg.ownerDocument.defaultView;
        let style = null;
        try {
            style = win.getComputedStyle(svg);
        } catch {
            // Not rendered.
        }
        const refuse = () => {
            note(
                'zoom and pan are off: wrapping the <svg> would change its layout. Mark the element that holds it with data-markin-stage instead (see the README).'
            );
            return null;
        };
        // An <svg> laid over something else is positioned against an element the host chose.
        if (style && /^(absolute|fixed|sticky)$/.test(style.position || '')) return refuse();

        const box = () => svg.getBoundingClientRect();
        const before = box();
        const moved = () => {
            const now = box();
            return ['left', 'top', 'width', 'height'].some((side) => Math.abs(now[side] - before[side]) > 0.5);
        };
        const { viewport, stage } = wrapInStage(svg, BLOCK_LEVEL.test((style && style.display) || ''));
        // A percentage size has to find the same box to refer to.
        if (moved()) viewport.style.width = '100%';
        if (moved()) {
            viewport.style.height = '100%';
            stage.style.height = '100%';
        }
        const teardown = () => {
            if (viewport.parentNode) viewport.replaceWith(svg);
        };
        if (moved()) {
            teardown();
            return refuse();
        }
        return { container: viewport, stage, teardown };
    }

    // ------------------------------------------------------------------ editor

    class Editor {
        // `target` is the <svg> to draw into, or the <img> to lay an overlay on.
        constructor(target, userOptions) {
            this.dead = false;
            this.enabled = true; // false while disabled, and for good once destroyed
            this.listeners = Object.create(null);

            // Logging options are needed before the rest can be validated.
            const early = isObject(userOptions) ? userOptions : {};
            this.opts = {
                ...DEFAULTS,
                strict: early.strict === true,
                silent: early.silent === true,
                logger: typeof early.logger === 'function' ? early.logger : null
            };
            this.opts = resolveOptions(userOptions, this.opts, (message) => this._problem(message));
            const initial = this.opts.annotations;
            this.opts.annotations = null;

            // The options are settled before the page is touched, so a strict-mode error leaves no trace.
            this.target = target;
            const warn = (message) => this._log('warn', message);
            this.host =
                target.localName === 'img' ? mountOverImage(target, (fresh) => this._layoutChanged(fresh), warn) : null;
            this.svg = this.host ? this.host.svg : target;
            // What zoom and pan work on. An <svg> that could not be given a viewport has no view.
            // An <svg> that cannot be given them works as before; only a host that wants zoom is told.
            this.frame = this.host || mountAroundSvg(target, (message) => this.opts.zoomControls && warn(message));
            this.viewport = this.frame ? this.frame.container : null;
            this.stage = this.frame ? this.frame.stage : null;
            // The SVG may live in another document than this script (an iframe, a popup).
            this.doc = this.svg.ownerDocument;
            this.win = this.doc.defaultView || window;

            this.list = []; // annotations in insertion order; each one is deeply frozen
            this.byId = new Map(); // String(id) -> annotation
            this.dom = new Map(); // String(id) -> the nodes drawn for it
            this.chrome = []; // the selection chrome as last drawn: [tag, attributes, cursor] per node
            this.sel = null; // { key, id, part, index }
            this.gesture = null;
            this.unit = 1; // SVG user units per screen pixel
            this.view = { scale: 1, x: 0, y: 0 }; // the stage's transform: its scale, and where it is moved to
            this.stageSize = null; // the size of the stage the view was last limited for
            this.viewFrame = 0;
            this.viewKey = null; // what `viewchange` last reported
            this.settleTimer = 0;
            this.settledKey = null; // what `viewsettle` last reported
            this.history = { states: [[]], index: 0 };
            this.nudged = null; // id with arrow-key moves that are not committed yet
            this.nudgeTimer = 0;
            this.hoverFrame = 0;
            this.hoverEvent = null;
            this.wheelRun = null; // the wheel movement in progress: when it was last heard, and whether it is ours
            this.pinch = null; // a WebKit pinch in progress: the scale it began at, and where
            this.space = false; // Space is held with the pointer over the editor: a drag moves the view
            this.inside = false; // the pointer is over the editor
            this.pressed = null; // the press last heard, which arrives once on the <svg> and once on the viewport
            this.warnedBounds = false;

            this._build();
            try {
                if (this.host) this.host.sync();
                this._measure();
                this._renderAll();
                if (initial) this.load(initial);
            } catch (err) {
                this.destroy();
                throw err;
            }
            claimKeyboard(this, false);
            this._viewChanged(); // the first view is news too
        }

        // ---- setup / teardown

        _build() {
            const svg = this.svg;
            this.layer = this._el('g', { class: 'markin-layer', 'data-markin-layer': '' });
            this.shapesLayer = this._el('g', { class: 'markin-shapes' });
            this.pointsLayer = this._el('g', { class: 'markin-points' });
            this.uiLayer = this._el('g', { class: 'markin-ui' });
            this.layer.append(this.shapesLayer, this.pointsLayer, this.uiLayer);
            svg.appendChild(this.layer);

            this.savedTouchAction = svg.style.touchAction || '';
            svg.style.touchAction = 'none';

            const on = (target, type, method, options) => listen(target, type, (event) => this[method](event), options);
            this.cleanup = [
                on(svg, 'pointerdown', '_onPointerDown'),
                // On the viewport where there is one: it also hears the pointer over a disabled overlay.
                on(this.viewport || svg, 'pointermove', '_onHover'),
                on(svg, 'touchstart', '_onTouchStart', { passive: true }),
                weakListen(this.doc, 'keydown', this, '_onKeyDown'),
                weakListen(this.doc, 'keyup', this, '_onKeyUp'),
                weakListen(this.win, 'resize', this, '_onResize')
            ];
            // Zoom and pan are listened for on the viewport, which is there whatever the picture is
            // moved to, and also hears what happens over the image while the editor is disabled.
            if (this.viewport) {
                const vp = this.viewport;
                this.cleanup.push(
                    // A press the <svg> did not take: on the image under a disabled overlay, or
                    // beside the picture.
                    on(vp, 'pointerdown', '_onPointerDown'),
                    on(vp, 'pointermove', '_onInside'),
                    on(vp, 'pointerleave', '_onOutside'),
                    on(vp, 'mousedown', '_onMiddle'),
                    on(vp, 'auxclick', '_onMiddle'),
                    on(vp, 'dragstart', '_onNativeDrag'),
                    weakListen(this.win, 'blur', this, '_onBlur'),
                    on(vp, 'wheel', '_onWheel', { passive: false }),
                    // WebKit's own events for a trackpad pinch. Other browsers never send them.
                    on(vp, 'gesturestart', '_onPinch', { passive: false }),
                    on(vp, 'gesturechange', '_onPinch', { passive: false }),
                    on(vp, 'gestureend', '_onPinch', { passive: false })
                );
            }
            // Over an image, the overlay is resized by the image's own observer, which also refreshes
            // the editor. A second observer here would only chase the first one.
            const Observer = this.win.ResizeObserver;
            if (!this.host && typeof Observer === 'function') {
                const observer = new Observer(() => this._layoutChanged());
                observer.observe(svg);
                // A viewport the page sizes can change while the <svg> stays as it is.
                if (this.viewport) observer.observe(this.viewport);
                this.cleanup.push(() => observer.disconnect());
            }
        }

        _el(tag, attrs) {
            return svgEl(this.doc, tag, attrs);
        }

        // Deferred work, on the next frame or after `ms`. It never runs on a destroyed editor.
        _frame(fn) {
            const run = () => !this.dead && fn();
            const raf = this.win.requestAnimationFrame;
            return typeof raf === 'function' ? raf.call(this.win, run) : setTimeout(run, 16);
        }

        _later(fn, ms) {
            return setTimeout(() => !this.dead && fn(), ms);
        }

        destroy() {
            if (this.dead) return;
            if (this.gesture) this._finishGesture(true);
            this._settle();
            this.dead = true;
            this.enabled = false;
            for (const stop of this.cleanup) stop();
            clearTimeout(this.settleTimer);
            this.listeners = Object.create(null);
            // Let go of everything that was drawn, and of the page's route back to this editor.
            this.layer.remove();
            for (const layer of [this.shapesLayer, this.pointsLayer, this.uiLayer]) layer.textContent = '';
            if (registry.get(this.target) === this) registry.delete(this.target);
            this.svg.style.touchAction = this.savedTouchAction;
            if (this.frame) this.frame.teardown();
            this.list = [];
            this.byId.clear();
            this.dom.clear();
            this.chrome = [];
            this.sel = null;
            this.hoverEvent = null;
            this.pressed = null;
            this.history = { states: [[]], index: 0 };
        }

        // ---- diagnostics

        _log(level, message) {
            const o = this.opts;
            if (o.silent) return;
            if (o.logger) {
                try {
                    o.logger(level, message);
                } catch {
                    // A broken logger must not break the editor.
                }
                return;
            }
            if (typeof console !== 'undefined') {
                // eslint-disable-next-line no-console
                (console[level] || console.log).call(console, `MarkinJS: ${message}`);
            }
        }

        // Bad input from the host: throw in strict mode, otherwise log it and carry on.
        _problem(message) {
            if (this.opts.strict) throw new TypeError(`MarkinJS: ${message}`);
            this._log('error', message);
        }

        // ---- events

        on(type, listener) {
            if (this.dead) return () => {};
            if (!EVENTS.includes(type)) {
                const hint = own(OLD_EVENTS, type) ? ` It was replaced by "${OLD_EVENTS[type]}".` : '';
                this._problem(`unknown event "${type}".${hint} Events: ${EVENTS.join(', ')}`);
                return () => {};
            }
            if (typeof listener !== 'function') {
                this._problem(`on("${type}") needs a function`);
                return () => {};
            }
            if (!this.listeners[type]) this.listeners[type] = [];
            this.listeners[type].push(listener);
            return () => this.off(type, listener);
        }

        off(type, listener) {
            const current = this.listeners[type];
            if (!current) return;
            if (listener === undefined) delete this.listeners[type];
            else this.listeners[type] = current.filter((l) => l !== listener);
        }

        _has(type) {
            return !!this.listeners[type] && this.listeners[type].length > 0;
        }

        // A listener that throws is reported and skipped; it can never leave the editor half-updated.
        _emit(type, ...args) {
            if (!this._has(type)) return;
            for (const listener of this.listeners[type].slice()) {
                try {
                    listener(...args);
                } catch (err) {
                    this._log('error', `a "${type}" listener threw: ${err && err.message ? err.message : err}`);
                }
            }
        }

        _emitChange(reason, ids) {
            if (this.dead || !this._has('change')) return;
            this._emit('change', this.getAnnotations(), { reason, ids });
        }

        // ---- coordinates and scale

        // The viewBox as the browser parsed it, or null when there is none.
        _viewBox() {
            const box = this.svg.viewBox && this.svg.viewBox.baseVal;
            return box && box.width > 0 && box.height > 0 ? { x: box.x, y: box.y, w: box.width, h: box.height } : null;
        }

        // The area annotations must stay inside.
        _bounds() {
            const vb = this.opts.constrainToImage ? this._viewBox() : null;
            return vb ? { x1: vb.x, y1: vb.y, x2: vb.x + vb.w, y2: vb.y + vb.h } : NO_LIMIT;
        }

        // Matrix from SVG user space to client pixels, or null while the SVG is not laid out.
        //
        // It is worked out from the box the SVG occupies on screen. getScreenCTM() cannot be relied
        // on for that: WebKit leaves the scale of a CSS-transformed ancestor out of it, and a scaled
        // ancestor is how this editor zooms. Only a rotated or skewed canvas is more than a box can
        // tell, and there the browser's own matrix is used as it is.
        _matrix() {
            let m = null;
            try {
                m = this.svg.getScreenCTM();
            } catch {
                // Not rendered.
            }
            if (m && !(isNum(m.a) && m.a * m.d - m.b * m.c !== 0)) m = null;
            const turned = !!m && (Math.abs(m.b) > 1e-6 || Math.abs(m.c) > 1e-6);
            if (turned || this.svg.ownerSVGElement) return m;
            return this._boxMatrix() || m;
        }

        // The same matrix for an upright canvas, from getBoundingClientRect(), which every browser
        // reports with all transforms applied.
        _boxMatrix() {
            const svg = this.svg;
            const rect = svg.getBoundingClientRect();
            if (!(rect.width > 0 && rect.height > 0)) return null;
            // Border and padding of the <svg> itself are not part of its drawing area. They are
            // layout pixels, and so is its size as CSS sees it; a scaled ancestor makes each of
            // those `kx` by `ky` pixels on screen.
            let style = null;
            try {
                style = this.win.getComputedStyle(svg);
            } catch {
                // An element that is not rendered has no style to read.
            }
            // A computed length is in pixels; anything else means the element is not laid out.
            const px = (name) => (style && /px$/.test(style[name]) && parseFloat(style[name])) || 0;
            const left = px('borderLeftWidth') + px('paddingLeft');
            const top = px('borderTopWidth') + px('paddingTop');
            const right = px('borderRightWidth') + px('paddingRight');
            const bottom = px('borderBottomWidth') + px('paddingBottom');
            const borderBox = !!style && style.boxSizing === 'border-box';
            const layoutW = px('width') + (borderBox ? 0 : left + right);
            const layoutH = px('height') + (borderBox ? 0 : top + bottom);
            const kx = layoutW > 0 ? rect.width / layoutW : 1;
            const ky = layoutH > 0 ? rect.height / layoutH : 1;
            // The drawing area in layout pixels.
            const w = rect.width / kx - left - right;
            const h = rect.height / ky - top - bottom;
            if (!(w > 0 && h > 0)) return null;

            // How the viewBox is fitted into that area, as preserveAspectRatio asks.
            const vb = this._viewBox();
            let sx = 1;
            let sy = 1;
            let ox = 0;
            let oy = 0;
            if (vb) {
                sx = w / vb.w;
                sy = h / vb.h;
                const fit = aspectOf(svg);
                if (fit) {
                    const s = fit.slice ? Math.max(sx, sy) : Math.min(sx, sy);
                    ox = (w - vb.w * s) * fit.x;
                    oy = (h - vb.h * s) * fit.y;
                    sx = s;
                    sy = s;
                }
                ox -= vb.x * sx;
                oy -= vb.y * sy;
            }
            return {
                a: sx * kx,
                b: 0,
                c: 0,
                d: sy * ky,
                e: rect.left + (left + ox) * kx,
                f: rect.top + (top + oy) * ky,
                // Screen pixels per layout pixel, when the size CSS gives the <svg> could be read.
                kx,
                ky,
                sized: layoutW > 0 && layoutH > 0
            };
        }

        _toLocal(clientX, clientY) {
            const m = this._matrix();
            return m ? unmap(m, clientX, clientY) : { x: clientX, y: clientY };
        }

        // Re-read how many SVG units one screen pixel covers. True when it changed noticeably.
        _measure() {
            const m = this._matrix();
            if (!m) return false;
            const scale = Math.sqrt(Math.abs(m.a * m.d - m.b * m.c));
            if (!(scale > 0) || !Number.isFinite(scale)) return false;
            const unit = 1 / scale;
            if (Math.abs(unit - this.unit) <= this.unit * 0.005) return false;
            this.unit = unit;
            return true;
        }

        // Handles and outlines take the size the canvas now has on screen.
        _remeasure() {
            if (!this.dead && this._measure()) this._rescale();
        }

        refresh() {
            this._layoutChanged();
        }

        _onResize() {
            if (this.host) this.host.sync();
            else this._layoutChanged();
        }

        // The canvas changed size or place on the page, or (`fresh`) shows another picture.
        _layoutChanged(fresh) {
            if (this.dead) return;
            if (fresh) this._resetView();
            this._remeasure();
            const g = this._geometry();
            if (!g) return;
            const v = this.view;
            if (v.scale > g.maxScale) {
                // The limit came down: zoom out around the middle of what is shown.
                this._zoomAt(g.maxScale, g.left + (g.width * g.kx) / 2, g.top + (g.height * g.ky) / 2, g);
                this._viewChanged();
                return;
            }
            // A view that is zoomed in keeps showing the same part of the picture.
            const was = this.stageSize;
            const x = was && was[0] > 0 ? (v.x * g.stageWidth) / was[0] : v.x;
            const y = was && was[1] > 0 ? (v.y * g.stageHeight) / was[1] : v.y;
            this._setView(v.scale, x, y, g);
            // The same view shows another part of the image once the viewport has another size.
            this._viewChanged();
        }

        // ---- view: zoom and pan

        // What the view is worked out from, measured now. Null while there is no viewport or the
        // page is not laid out. Lengths are layout pixels of the viewport unless they say otherwise.
        _geometry() {
            const vp = this.viewport;
            if (this.dead || !vp) return null;
            const m = this._matrix();
            const box = vp.getBoundingClientRect();
            if (!m || !(box.width > 0 && box.height > 0)) return null;
            const vb = this._viewBox();
            // An image that has not arrived yet has no size to speak of.
            if (this.host && !vb) return null;
            // Scaled by the page around the editor, a layout pixel is `kx` by `ky` pixels on screen.
            // The <svg> knows exactly; it is inside the stage, so its own figure includes the view.
            // The viewport's size is the fallback, and that is rounded to whole pixels.
            const v = this.view;
            const kx = m.sized ? m.kx / v.scale : vp.offsetWidth > 0 ? box.width / vp.offsetWidth : 1;
            const ky = m.sized ? m.ky / v.scale : vp.offsetHeight > 0 ? box.height / vp.offsetHeight : 1;
            // What is shown is the inside of the viewport's border.
            const left = box.left + (vp.clientLeft || 0) * kx;
            const top = box.top + (vp.clientTop || 0) * ky;
            const width = box.width / kx - (vp.offsetWidth > 0 ? vp.offsetWidth - vp.clientWidth : 0);
            const height = box.height / ky - (vp.offsetHeight > 0 ? vp.offsetHeight - vp.clientHeight : 0);
            // Where the stage starts when the view is at rest ...
            const stage = this.stage.getBoundingClientRect();
            const ox = (stage.left - left) / kx - v.x;
            const oy = (stage.top - top) / ky - v.y;
            // ... and the picture, in the stage's own pixels, which no view changes.
            const own = this.svg.getBoundingClientRect();
            const image = vb || { x: 0, y: 0, w: own.width / Math.abs(m.a), h: own.height / Math.abs(m.d) };
            const xs = [];
            const ys = [];
            for (const [px, py] of [
                [image.x, image.y],
                [image.x + image.w, image.y],
                [image.x, image.y + image.h],
                [image.x + image.w, image.y + image.h]
            ]) {
                xs.push(((m.a * px + m.c * py + m.e - left) / kx - ox - v.x) / v.scale);
                ys.push(((m.b * px + m.d * py + m.f - top) / ky - oy - v.y) / v.scale);
            }
            // Screen pixels per image pixel, now and with the view at rest.
            const scale = Math.sqrt(Math.abs(m.a * m.d - m.b * m.c));
            return {
                m,
                kx,
                ky,
                left,
                top,
                width,
                height,
                ox,
                oy,
                x1: Math.min(...xs),
                x2: Math.max(...xs),
                y1: Math.min(...ys),
                y2: Math.max(...ys),
                image,
                scale,
                // Zoomed out, the limit is the picture as the page lays it out, however large that is.
                maxScale: Math.max(1, (this.opts.maxScale * v.scale) / scale),
                stageWidth: stage.width / (kx * v.scale),
                stageHeight: stage.height / (ky * v.scale)
            };
        }

        // An image point in the stage's own pixels.
        _onStage(g, x, y) {
            const v = this.view;
            const m = g.m;
            return {
                x: ((m.a * x + m.c * y + m.e - g.left) / g.kx - g.ox - v.x) / v.scale,
                y: ((m.b * x + m.d * y + m.f - g.top) / g.ky - g.oy - v.y) / v.scale
            };
        }

        // Move the view, within its limits. True when that changed it.
        _setView(scale, x, y, g = this._geometry()) {
            if (!g) return false;
            this.stageSize = [g.stageWidth, g.stageHeight];
            // The slack is the width of a handle, which is a size on screen.
            const slack = (2 * this.opts.handleRadius + this.opts.strokeWidth) / g.kx;
            const next = clampView(scale, x, y, g, slack);
            const v = this.view;
            if (next.scale === v.scale && next.x === v.x && next.y === v.y) return false;
            this.view = next;
            this._writeView();
            // Handles and outlines follow in the same frame.
            this._remeasure();
            this._viewChanged();
            return true;
        }

        _writeView() {
            const { scale, x, y } = this.view;
            const rest = scale === 1 && x === 0 && y === 0;
            const saved = this.frame.saved || ['', '', ''];
            this.stage.style.transformOrigin = rest ? saved[1] : '0 0';
            this.stage.style.transform = rest ? saved[0] : `translate(${x}px, ${y}px) scale(${scale})`;
            // At rest nothing is clipped, so a handle on the edge of the picture is drawn whole.
            // Zoomed in, the viewport is a window onto the stage.
            this.viewport.style.overflow = rest ? saved[2] : 'hidden';
        }

        _resetView() {
            if (!this.viewport) return;
            this.view = { scale: 1, x: 0, y: 0 };
            this.stageSize = null;
            this.settledKey = null; // another picture is news, even at the same size
            this._writeView();
        }

        // The view may have changed. Tell the host, at most once per frame while it moves, and
        // once more when it has come to rest.
        _viewChanged() {
            if (this.dead || !this.viewport) return;
            if (!this.viewFrame) {
                this.viewFrame = this._frame(() => {
                    this.viewFrame = 0;
                    this._announceView();
                });
            }
            this._armSettle();
        }

        _announceView() {
            const g = this._geometry();
            if (!g) return;
            // Every movement counts, also one too small to change the whole pixels getView() reports,
            // and so does a canvas that changed size: something the host placed with toClient()
            // has to follow.
            const p = unmap(g.m, g.left, g.top);
            const q = unmap(g.m, g.left + g.width * g.kx, g.top + g.height * g.ky);
            const key = [p.x, p.y, q.x, q.y, g.scale].map((n) => Math.round(n * 1000)).join(' ');
            if (key === this.viewKey) return;
            this.viewKey = key;
            if (this._has('viewchange')) this._emit('viewchange', this._viewOf(g));
        }

        _armSettle() {
            clearTimeout(this.settleTimer);
            // Not while the view is held: a pause in a drag is not the end of it.
            if (this.gesture && this.gesture.kind === 'pan') return;
            this.settleTimer = this._later(() => this._settleView(), this.opts.settleDelay);
        }

        _settleView() {
            this.settleTimer = 0;
            const view = this.getView();
            if (!view) return;
            // Only a view that would give another crop is worth the host's work.
            const key = [view.x, view.y, view.width, view.height].join(' ');
            if (key === this.settledKey) return;
            this.settledKey = key;
            this._emit('viewsettle', view);
        }

        // Zoom to `scale`, keeping what is under the client point (clientX, clientY) where it is.
        _zoomAt(scale, clientX, clientY, g = this._geometry()) {
            if (!g) return false;
            const v = this.view;
            const s = clamp(scale, 1, g.maxScale);
            // The point in viewport pixels, counted from where the stage starts at rest.
            const ax = (clientX - g.left) / g.kx - g.ox;
            const ay = (clientY - g.top) / g.ky - g.oy;
            const ratio = s / v.scale;
            return this._setView(s, ax - (ax - v.x) * ratio, ay - (ay - v.y) * ratio, g);
        }

        // Show the image rectangle (x1, y1)-(x2, y2) as large as it fits, `pad` screen pixels
        // away from the edges of the viewport.
        _show(x1, y1, x2, y2, pad) {
            const g = this._geometry();
            if (!g) return false;
            const a = this._onStage(g, x1, y1);
            const b = this._onStage(g, x2, y2);
            const roomX = Math.max(g.width - (2 * pad) / g.kx, 1);
            const roomY = Math.max(g.height - (2 * pad) / g.ky, 1);
            const wanted = Math.min(roomX / Math.abs(b.x - a.x), roomY / Math.abs(b.y - a.y));
            const s = clamp(Number.isNaN(wanted) ? Infinity : wanted, 1, g.maxScale);
            const x = g.width / 2 - g.ox - (s * (a.x + b.x)) / 2;
            const y = g.height / 2 - g.oy - (s * (a.y + b.y)) / 2;
            this._setView(s, x, y, g);
            return true;
        }

        // The part of the image the viewport shows, as the whole pixels that cover it.
        _viewOf(g) {
            const p = unmap(g.m, g.left, g.top);
            const q = unmap(g.m, g.left + g.width * g.kx, g.top + g.height * g.ky);
            const im = g.image;
            const within = (v, from, length) => clamp(v, from, from + length);
            // A crop must hold everything that is visible, so it is rounded outward.
            const x = within(Math.floor(Math.min(p.x, q.x) + 1e-6), im.x, im.w);
            const y = within(Math.floor(Math.min(p.y, q.y) + 1e-6), im.y, im.h);
            const right = within(Math.ceil(Math.max(p.x, q.x) - 1e-6), im.x, im.w);
            const bottom = within(Math.ceil(Math.max(p.y, q.y) - 1e-6), im.y, im.h);
            return { x, y, width: right - x, height: bottom - y, scale: g.scale };
        }

        getView() {
            const g = this._geometry();
            return g ? this._viewOf(g) : null;
        }

        setView(rect) {
            if (this.dead) return false;
            const ok =
                isObject(rect) &&
                [rect.x, rect.y, rect.width, rect.height].every(isNum) &&
                rect.width > 0 &&
                rect.height > 0;
            if (!ok) {
                this._problem('setView: needs { x, y, width, height } in image pixels, with a positive size');
                return false;
            }
            return this._show(rect.x, rect.y, rect.x + rect.width, rect.y + rect.height, 0);
        }

        zoomBy(factor, at) {
            if (this.dead) return false;
            if (!(isNum(factor) && factor > 0)) {
                this._problem('zoomBy: the factor must be a positive number');
                return false;
            }
            if (at !== undefined && at !== null && !(isObject(at) && isNum(at.x) && isNum(at.y))) {
                this._problem('zoomBy: the point to zoom at must be { x, y } in image pixels');
                return false;
            }
            const g = this._geometry();
            if (!g) return false;
            // Around the given point of the image, or else the middle of the viewport.
            const c = at
                ? { x: g.m.a * at.x + g.m.c * at.y + g.m.e, y: g.m.b * at.x + g.m.d * at.y + g.m.f }
                : { x: g.left + (g.width * g.kx) / 2, y: g.top + (g.height * g.ky) / 2 };
            this._zoomAt(this.view.scale * factor, c.x, c.y, g);
            return true;
        }

        fit() {
            const g = this._geometry();
            if (!g) return false;
            this._setView(1, 0, 0, g);
            return true;
        }

        // Frame one annotation: its bbox, or else whatever it is made of.
        zoomTo(id, settings) {
            if (this.dead) return false;
            const ann = this._find('zoomTo', id);
            if (!ann) return false;
            const padding = isObject(settings) && settings.padding !== undefined ? settings.padding : 40;
            if (!(isNum(padding) && padding >= 0)) {
                this._problem('zoomTo: padding must be a number of screen pixels, 0 or more');
                return false;
            }
            const box = extent(pointsOf(ann, hasBox(ann) ? ['bbox'] : ['polygon', 'keypoint']));
            return !!box && this._show(box.x1, box.y1, box.x2, box.y2, padding);
        }

        // Select the next (1) or the previous (-1) annotation, in the order of the list, and frame
        // it. False at either end, where there is none to go to.
        step(direction) {
            if (this.dead) return false;
            if (direction !== 1 && direction !== -1) {
                this._problem('step: the direction must be 1 (next) or -1 (previous)');
                return false;
            }
            this._settle();
            const at = this.sel ? this.list.indexOf(this.byId.get(this.sel.key)) : -1;
            const ann = this.list[at === -1 ? (direction === 1 ? 0 : this.list.length - 1) : at + direction];
            if (!ann) return false;
            this._select(String(ann.id), this._mainPart(ann), null);
            // A select listener may have removed it again.
            if (this.byId.has(String(ann.id)) && this.viewport) this.zoomTo(ann.id);
            return true;
        }

        toImage(clientX, clientY) {
            if (this.dead) return null;
            if (!(isNum(clientX) && isNum(clientY))) {
                this._problem('toImage: needs clientX and clientY as numbers');
                return null;
            }
            return this._toLocal(clientX, clientY);
        }

        toClient(x, y) {
            if (this.dead) return null;
            if (!(isNum(x) && isNum(y))) {
                this._problem('toClient: needs x and y as numbers');
                return null;
            }
            const m = this._matrix();
            return m ? { x: m.a * x + m.c * y + m.e, y: m.b * x + m.d * y + m.f } : { x, y };
        }

        // ---- zoom and pan by hand

        // True when the user may move the view.
        _pans() {
            return !this.dead && !!this.viewport && this.opts.zoomControls;
        }

        // True for an event on the picture or on the bare viewport around it. Anything else the
        // page put inside its own viewport, a toolbar for one, keeps its events to itself.
        _onCanvas(event) {
            const target = event.target;
            return target === this.viewport || (this.stage || this.svg).contains(target);
        }

        // A wheel or a trackpad. Pinching a trackpad also arrives here, as a wheel with Ctrl held
        // (Chrome, Firefox, Edge); WebKit sends gesture events instead.
        _onWheel(event) {
            if (!this._pans() || !this._onCanvas(event)) return;
            const pinch = event.ctrlKey || event.metaKey;
            const zooms = pinch || this.opts.wheel === 'zoom';
            // One movement of the wheel or the fingers is many events, and whose it is gets decided
            // by the first. A scroll that cannot move the view belongs to the page, all of it; one
            // that can stays ours when it reaches the edge, and never spills over into the page.
            // A pinch is always ours: left alone, the browser would zoom the whole page.
            const now = Date.now();
            let run = this.wheelRun;
            const first = !run || now - run.at > WHEEL_RUN_MS || run.zooms !== zooms;
            if (first) run = this.wheelRun = { zooms, ours: pinch };
            run.at = now;
            if (!first && !run.ours) return;
            const g = this._geometry();
            if (!g) return;

            const lines = event.deltaMode === 1 ? WHEEL_LINE : event.deltaMode === 2 ? g.height * g.ky : 1;
            let dx = (event.deltaX || 0) * lines;
            let dy = (event.deltaY || 0) * lines;
            const v = this.view;
            let moved;
            if (zooms) {
                // A notch of a mouse wheel is about 100 and zooms by 15%. A pinch reports small
                // numbers, which Ctrl marks; a real Ctrl + wheel is kept from leaping.
                const power = clamp(-dy * 0.002 * (event.ctrlKey ? 10 : 1), -0.35, 0.35);
                moved = this._zoomAt(v.scale * Math.pow(2, power), event.clientX, event.clientY, g);
            } else {
                // Shift turns a wheel that only goes up and down sideways.
                if (event.shiftKey && dx === 0) [dx, dy] = [dy, 0];
                moved = this._setView(v.scale, v.x - dx / g.kx, v.y - dy / g.ky, g);
            }
            if (first && moved) run.ours = true;
            if (run.ours) event.preventDefault();
        }

        // A trackpad pinch in WebKit (Safari, and the web views built on it). `event.scale` is how
        // far the fingers have moved apart since the pinch began. Prevented, or the whole page zooms.
        _onPinch(event) {
            if (!this._pans() || !this._onCanvas(event)) return;
            event.preventDefault();
            if (event.type === 'gestureend') {
                this.pinch = null;
                return;
            }
            const at = (n, fallback) => (isNum(n) ? n : fallback);
            if (event.type === 'gesturestart' || !this.pinch) {
                this.pinch = { scale: this.view.scale, x: at(event.clientX, 0), y: at(event.clientY, 0) };
                if (event.type === 'gesturestart') return;
            }
            if (!(isNum(event.scale) && event.scale > 0)) return;
            // The pointer does not move during a pinch, but the event that says where it is may not either.
            const p = this.pinch;
            this._zoomAt(p.scale * event.scale, at(event.clientX, p.x), at(event.clientY, p.y));
        }

        // ---- model

        // Validate host input and apply the editor's own defaults: an id, and a bbox when one is required.
        _parse(input) {
            const result = parseAnnotation(input);
            if (!result.error) {
                if (result.value.id == null) result.value.id = newId();
                this._ensureBox(result.value);
            }
            return result;
        }

        // options.requireBbox: an annotation without a bbox gets the one that encloses its other parts.
        _ensureBox(ann) {
            if (!this.opts.requireBbox || hasBox(ann)) return;
            const box = extent(pointsOf(ann, ['polygon', 'keypoint']));
            if (box) ann.bbox = toBbox(box);
        }

        // The annotation with this id, or null after reporting that `method` was given a wrong one.
        _find(method, id) {
            const ann = this.byId.get(keyOf(id));
            if (!ann) this._problem(`${method}: no annotation with id ${idText(id)}`);
            return ann || null;
        }

        // Store a new version of an annotation (same id) and return the frozen object.
        _set(ann) {
            const key = String(ann.id);
            const frozen = deepFreeze(ann);
            const index = this.list.indexOf(this.byId.get(key));
            if (index === -1) this.list.push(frozen);
            else this.list[index] = frozen;
            this.byId.set(key, frozen);
            return frozen;
        }

        // Replace an annotation during a drag or nudge and redraw it.
        _put(ann) {
            if (this.byId.get(String(ann.id)) === ann) return;
            this._render(this._set(ann));
            this._renderUI();
        }

        // Make `list` the current data and redraw what differs. Returns the ids that changed.
        _replace(list) {
            const before = this.byId;
            this.list = list.slice();
            this.byId = new Map(this.list.map((ann) => [String(ann.id), ann]));
            const gone = Array.from(before.values()).filter((ann) => !this.byId.has(String(ann.id)));
            const differs = (ann) => before.get(String(ann.id)) !== ann;
            // Drawn from the bottom of the stack up: groups drawn for the first time are appended,
            // and so already lie in stacking order.
            this._redraw([...gone, ...this._stack().filter(differs)].map((ann) => ann.id));
            return [...gone, ...this.list.filter(differs)].map((ann) => ann.id);
        }

        _rules(ann) {
            const o = this.opts;
            const bound = o.bindElements && hasBox(ann);
            return { bound, polygon: bound && o.bboxContainPolygon, keypoint: bound && o.bboxContainKeypoints };
        }

        // The three ways a drag or nudge changes an annotation. Each takes the annotation as it was
        // when the edit began plus the total travel (dx, dy), applies every limit, and returns
        // `ann` itself when nothing changes.

        // One keypoint (role 'keypoint') or polygon vertex (role 'polygon') moved.
        _pointMoved(ann, role, index, dx, dy) {
            const from = role === 'keypoint' ? ann.keypoints[index].point : ann.segments[index];
            const x = from[0] + dx;
            const y = from[1] + dy;
            const box = this._rules(ann)[role] ? corners(ann.bbox) : NO_LIMIT;
            const p = placed(from, x, y, x !== from[0], y !== from[1], box, this._bounds());
            if (p[0] === from[0] && p[1] === from[1]) return ann;
            return role === 'keypoint'
                ? { ...ann, keypoints: ann.keypoints.map((k, i) => (i === index ? { ...k, point: p } : k)) }
                : { ...ann, segments: ann.segments.map((q, i) => (i === index ? p : q)) };
        }

        // A whole part moved: the bbox (with what is bound to it), the polygon, or one keypoint.
        _translated(ann, part, index, dx, dy) {
            if (part === 'keypoint') return this._pointMoved(ann, 'keypoint', index, dx, dy);
            const rules = this._rules(ann);
            // A bound bbox carries its polygon and keypoints; a polygon moves alone.
            const moving = part === 'polygon' ? ['polygon'] : part === 'bbox' && !rules.bound ? ['bbox'] : PARTS;
            const box = extent(pointsOf(ann, moving));
            if (!box) return ann;
            // As for a single point, an axis the user did not move along is left exactly as it was.
            const limits = [part === 'polygon' && rules.polygon ? corners(ann.bbox) : NO_LIMIT, this._bounds()];
            const alongX = dx !== 0;
            const alongY = dy !== 0;
            for (const limit of limits) {
                if (alongX) dx = clampDelta(dx, box.x1, box.x2, limit.x1, limit.x2);
                if (alongY) dy = clampDelta(dy, box.y1, box.y2, limit.y1, limit.y2);
            }
            if (dx === 0 && dy === 0) return ann;
            const shift = (p) => [p[0] + dx, p[1] + dy];
            const next = { ...ann };
            if (moving.includes('bbox') && hasBox(ann)) {
                next.bbox = [ann.bbox[0] + dx, ann.bbox[1] + dy, ann.bbox[2], ann.bbox[3]];
            }
            if (moving.includes('polygon') && hasPolygon(ann)) next.segments = ann.segments.map(shift);
            if (moving.includes('keypoint') && keypointsOf(ann).length) {
                next.keypoints = ann.keypoints.map((k) => (isLabelled(k) ? { ...k, point: shift(k.point) } : k));
            }
            return next;
        }

        // The bbox corner `handle` (nw, ne, sw, se) moved.
        // The opposite corner stays put and the box cannot be turned inside out.
        _resized(ann, handle, dx, dy) {
            const b = corners(ann.bbox);
            const B = this._bounds();
            const min = this.unit; // one screen pixel
            // An edge follows the pointer, stops at the image edge, and stays `min` away from the
            // opposite edge `far` (without leaving the image for it).
            const low = (p, far, lo, hi) => Math.min(clamp(p, lo, hi), Math.max(far - min, lo), far);
            const high = (p, far, lo, hi) => Math.max(clamp(p, lo, hi), Math.min(far + min, hi), far);
            let { x1, y1, x2, y2 } = b;
            // An edge the pointer has not moved keeps its exact value.
            const west = handle[1] === 'w';
            const north = handle[0] === 'n';
            const px = (west ? x1 : x2) + dx;
            const py = (north ? y1 : y2) + dy;
            if (west && px !== x1) x1 = low(px, x2, B.x1, B.x2);
            else if (!west && px !== x2) x2 = high(px, x1, B.x1, B.x2);
            if (north && py !== y1) y1 = low(py, y2, B.y1, B.y2);
            else if (!north && py !== y2) y2 = high(py, y1, B.y1, B.y2);
            const changedX = x1 !== b.x1 || x2 !== b.x2;
            const changedY = y1 !== b.y1 || y2 !== b.y2;
            if (!changedX && !changedY) return ann;

            const next = { ...ann, bbox: [x1, y1, x2 - x1, y2 - y1] };
            const rules = this._rules(ann);
            if (rules.bound) {
                // Bound children keep their relative position inside the box, and the same limits
                // apply to them as when they are dragged: inside the box (if contained), inside the image.
                const sx = b.x2 > b.x1 ? (x2 - x1) / (b.x2 - b.x1) : 1;
                const sy = b.y2 > b.y1 ? (y2 - y1) / (b.y2 - b.y1) : 1;
                const place = (role) => {
                    const box = rules[role] ? { x1, y1, x2, y2 } : NO_LIMIT;
                    return (p) =>
                        placed(p, x1 + (p[0] - b.x1) * sx, y1 + (p[1] - b.y1) * sy, changedX, changedY, box, B);
                };
                if (hasPolygon(ann)) next.segments = ann.segments.map(place('polygon'));
                if (keypointsOf(ann).length) {
                    const map = place('keypoint');
                    next.keypoints = ann.keypoints.map((k) => (isLabelled(k) ? { ...k, point: map(k.point) } : k));
                }
            }
            return next;
        }

        // ---- history

        // Record the current state as one undo step and tell the host.
        _commit(reason, ids) {
            const h = this.history;
            // An edit that ends where it began (a nudge there and back) is not a step: put the earlier
            // objects back and say nothing. Nor is one that an earlier commit already covers, as
            // when a listener edited while this edit was still being announced.
            const top = h.states[h.index];
            for (const id of ids) {
                const key = String(id);
                const now = this.byId.get(key);
                const was = now && top.find((ann) => String(ann.id) === key);
                if (was && now !== was && sameData(now, was)) this._set(was);
            }
            if (top.length === this.list.length && top.every((ann, i) => ann === this.list[i])) return;
            if (this.opts.historyEnabled) {
                h.states.length = h.index + 1;
                h.states.push(this.list.slice());
                h.index += 1;
                this._trimHistory();
            } else {
                // Keep the one base state current, so switching history on later starts from here.
                this._resetHistory();
            }
            this._reorder();
            this._emitChange(reason, ids);
        }

        _resetHistory() {
            this.history = { states: [this.list.slice()], index: 0 };
        }

        // Forget the oldest steps beyond options.historyMaxStates.
        _trimHistory() {
            const h = this.history;
            const excess = h.index + 1 - Math.max(1, Math.floor(this.opts.historyMaxStates));
            if (excess > 0) {
                h.states.splice(0, excess);
                h.index -= excess;
            }
        }

        // Go one step back (-1) or forward (1) in the history. False when there is nowhere to go.
        _step(by) {
            if (this.dead) return false;
            this._settle();
            const h = this.history;
            const state = h.states[h.index + by]; // a disabled history holds the current state only
            if (!state) return false;
            h.index += by;
            const changed = this._replace(state);
            this._reorder();
            this._emitChange(by < 0 ? 'undo' : 'redo', changed);
            return true;
        }

        undo() {
            return this._step(-1);
        }

        redo() {
            return this._step(1);
        }

        canUndo() {
            return !this.dead && this.opts.historyEnabled && (this.history.index > 0 || this.nudged !== null);
        }

        canRedo() {
            return !this.dead && this.nudged === null && this.history.index < this.history.states.length - 1;
        }

        clearHistory() {
            if (this.dead) return;
            this._settle();
            this._resetHistory();
        }

        // Finish anything in flight (a drag, uncommitted nudges) before another change is made.
        _settle() {
            // A drag of the view holds nothing that another change could upset, and goes on.
            if (this.gesture && this.gesture.key !== undefined) this._finishGesture(true);
            this._flushNudge();
        }

        _flushNudge() {
            clearTimeout(this.nudgeTimer);
            if (this.nudged === null) return;
            const id = this.nudged;
            this.nudged = null;
            this._commit('update', [id]);
        }

        // ---- public data API

        createAnnotation(data, settings) {
            if (this.dead) return null;
            this._settle();
            const result = this._parse(data);
            if (result.error) {
                this._problem(`createAnnotation: ${result.error}`);
                return null;
            }
            if (this.byId.has(String(result.value.id))) {
                this._problem(`createAnnotation: id ${idText(result.value.id)} already exists`);
                return null;
            }
            const ann = this._set(result.value);
            this._warnOutOfBounds([ann]);
            this._render(ann);
            // Recorded and announced before it is selected: whatever a select listener does to the
            // new annotation is then an edit of its own, made after this one.
            this._commit('create', [ann.id]);
            // A change listener may have altered it by now, or removed it again.
            const key = String(ann.id);
            const current = this.byId.get(key);
            if (current && (!isObject(settings) || settings.select !== false)) {
                this._select(key, this._mainPart(current), null);
            }
            return ann.id;
        }

        updateAnnotation(id, patch) {
            if (this.dead) return false;
            this._settle();
            const current = this._find('updateAnnotation', id);
            if (!current) return false;
            if (!isObject(patch)) {
                this._problem('updateAnnotation: the patch must be an object');
                return false;
            }
            if (patch.id != null && keyOf(patch.id) !== String(current.id)) {
                this._problem('updateAnnotation: the id of an annotation cannot change');
                return false;
            }
            // `undefined` means "not given". Only an explicit null removes a field.
            const merged = { ...current };
            for (const name of Object.keys(patch)) {
                if (patch[name] !== undefined) merged[name] = patch[name];
            }
            merged.id = current.id;
            const result = this._parse(merged);
            if (result.error) {
                this._problem(`updateAnnotation: ${result.error}`);
                return false;
            }
            // What the patch did not touch stays the very same frozen object, so the versions kept
            // for undo share it instead of each holding a copy.
            const next = result.value;
            for (const name of Object.keys(current)) {
                const kept = current[name];
                if (patch[name] === undefined && own(next, name) && kept !== null && typeof kept === 'object') {
                    next[name] = kept;
                }
            }
            // A patch that changes nothing is recognised by _commit, which keeps the earlier object.
            const ann = this._set(next);
            this._redraw([ann.id]);
            this._commit('update', [ann.id]);
            return true;
        }

        addKeypoint(id, keypoint) {
            if (this.dead) return false;
            this._settle(); // read the keypoints only after a drag in progress has been put back
            const current = this._find('addKeypoint', id);
            return !!current && this.updateAnnotation(id, { keypoints: [...keypointsOf(current), keypoint] });
        }

        deleteAnnotation(id) {
            if (this.dead) return false;
            this._settle();
            const ann = this.byId.get(keyOf(id));
            if (!ann) return false;
            this.list.splice(this.list.indexOf(ann), 1);
            this.byId.delete(String(ann.id));
            this._redraw([ann.id]);
            this._commit('delete', [ann.id]);
            return true;
        }

        clear() {
            if (this.dead) return;
            this._settle();
            if (this.list.length) this._commit('clear', this._replace([]));
        }

        // Replace everything with `annotations`. This is "open a document": it starts a fresh
        // undo history and does not emit `change`. Nothing is replaced unless every item is valid.
        load(annotations) {
            if (this.dead) return false;
            this._settle();
            if (!Array.isArray(annotations)) {
                this._problem('load: annotations must be an array');
                return false;
            }
            const next = [];
            const seen = new Set();
            for (let i = 0; i < annotations.length; i++) {
                const result = this._parse(annotations[i]);
                if (result.error) {
                    this._problem(`load: annotations[${i}]: ${result.error}`);
                    return false;
                }
                const ann = result.value;
                if (seen.has(String(ann.id))) {
                    this._problem(`load: annotations[${i}]: duplicate id ${idText(ann.id)}`);
                    return false;
                }
                seen.add(String(ann.id));
                next.push(deepFreeze(ann));
            }
            // A new document never inherits the selection, even when it reuses an id.
            const previous = this.sel;
            this.sel = null;
            this._replace(next);
            this._reorder();
            this._resetHistory();
            this._warnOutOfBounds(next);
            if (previous) this._emit('deselect', deselected(previous));
            return true;
        }

        getAnnotation(id) {
            const ann = this.dead ? null : this.byId.get(keyOf(id));
            return ann ? copy(ann) : null;
        }

        // Deep copies in the same shape createAnnotation() and load() accept.
        getAnnotations(settings) {
            if (this.dead) return [];
            if (isObject(settings) && settings.normalize) {
                const vb = this._viewBox();
                if (!vb) {
                    this._problem('getAnnotations: cannot normalize, the image size is not known yet');
                    return null;
                }
                return mapped(
                    this.list.map(copy),
                    (x) => x / vb.w,
                    (y) => y / vb.h,
                    vb.x,
                    vb.y
                );
            }
            return this.list.map(copy);
        }

        // A bbox reaching outside the image usually means [x1, y1, x2, y2] was passed by mistake.
        _warnOutOfBounds(annotations) {
            if (this.warnedBounds) return;
            const B = this._bounds();
            // While the next image is still loading, the size on record belongs to the previous one.
            if (this.host && this.host.image.complete === false) return;
            const outside = annotations.find((ann) => {
                if (!hasBox(ann)) return false;
                const b = corners(ann.bbox);
                return b.x1 < B.x1 || b.y1 < B.y1 || b.x2 > B.x2 || b.y2 > B.y2;
            });
            if (!outside) return;
            this.warnedBounds = true;
            this._log(
                'warn',
                `annotation ${idText(outside.id)} has a bbox outside the image. bbox is [x, y, width, height], not [x1, y1, x2, y2].`
            );
        }

        // ---- selection

        _mainPart(ann) {
            return hasBox(ann) ? 'bbox' : hasPolygon(ann) ? 'polygon' : null;
        }

        _isSelected(key, part, index) {
            const s = this.sel;
            return !!s && s.key === key && s.part === part && s.index === index;
        }

        _partExists(ann, part, index) {
            if (part === null) return true;
            if (part === 'bbox') return hasBox(ann);
            if (part === 'polygon') return hasPolygon(ann);
            return part === 'keypoint' && Number.isInteger(index) && index >= 0 && index < keypointsOf(ann).length;
        }

        _selectionInfo(sel) {
            const ann = this.byId.get(sel.key);
            return { ...deselected(sel), annotation: ann ? copy(ann) : null };
        }

        // Bring the drawing in line with the data: redraw these annotations (or remove what was drawn
        // for the ones that are gone), then the selection chrome. A selection whose annotation or
        // part no longer exists is dropped, and the host is told.
        _redraw(ids) {
            const s = this.sel;
            const target = s ? this.byId.get(s.key) : null;
            const stale = !!s && !(target && this._partExists(target, s.part, s.index));
            if (stale) this.sel = null;
            for (const id of ids) {
                const ann = this.byId.get(String(id));
                if (ann) this._render(ann);
                else this._unrender(String(id));
            }
            this._renderUI();
            if (stale) this._emit('deselect', deselected(s));
        }

        // `index` is the keypoint index, and null for every other part.
        _select(key, part, index) {
            if (this._isSelected(key, part, index)) return;
            const previous = this.sel;
            const ann = this.byId.get(key);
            this.sel = { key, id: ann.id, part, index };
            claimKeyboard(this, false);
            this._redraw(previous && previous.key !== key ? [previous.id, ann.id] : [ann.id]);
            if (previous) this._emit('deselect', deselected(previous));
            if (this.sel && this._has('select')) this._emit('select', this._selectionInfo(this.sel));
        }

        select(id, part, index) {
            if (this.dead) return false;
            this._settle();
            const ann = this._find('select', id);
            if (!ann) return false;
            const wanted = part === undefined || part === null ? this._mainPart(ann) : part;
            const idx = wanted === 'keypoint' ? index : null;
            if (wanted !== null && !PARTS.includes(wanted)) {
                this._problem(`select: part must be one of ${PARTS.join(', ')}`);
                return false;
            }
            if (!this._partExists(ann, wanted, idx)) {
                this._problem(`select: annotation ${idText(id)} has no such ${wanted}`);
                return false;
            }
            this._select(String(ann.id), wanted, idx);
            return true;
        }

        deselect() {
            if (this.dead || !this.sel) return false;
            this._settle();
            const previous = this.sel;
            if (!previous) return false;
            this.sel = null;
            this._redraw([previous.id]);
            this._emit('deselect', deselected(previous));
            return true;
        }

        getSelection() {
            return this.dead || !this.sel ? null : this._selectionInfo(this.sel);
        }

        // Delete the selected part, plus whatever options.deletionRules lists for it.
        // An annotation left without any geometry is removed.
        deleteSelected() {
            if (this.dead) return false;
            this._settle();
            const s = this.sel;
            if (!s) return false;
            const ann = this.byId.get(s.key);
            if (s.part === null) return this.deleteAnnotation(ann.id);
            const also = this.opts.deletionRules[s.part];
            const next = { ...ann };
            if (s.part === 'bbox' || also.includes('bbox')) delete next.bbox;
            if (s.part === 'polygon' || also.includes('polygon')) delete next.segments;
            if (also.includes('keypoint')) delete next.keypoints;
            else if (s.part === 'keypoint') next.keypoints = ann.keypoints.filter((_, i) => i !== s.index);
            if (also.includes('annotation') || !hasGeometry(next)) return this.deleteAnnotation(ann.id);

            this._ensureBox(next);
            this._set(next);
            this.sel = null;
            this._redraw([ann.id]);
            this._emit('deselect', deselected(s));
            this._commit('update', [ann.id]);
            return true;
        }

        // ---- state

        enable() {
            if (this.dead || this.enabled) return;
            this.enabled = true;
            this.layer.style.pointerEvents = '';
            this._showGrab();
            if (this.host) this.svg.style.pointerEvents = '';
            this.svg.style.touchAction = 'none';
            this._remeasure();
        }

        // Stop editing: nothing can be selected, moved or deleted, and pointer events pass through
        // the annotations to whatever is below. The view can still be moved, and `hover` and
        // `canvasclick` still say where the pointer is, so a host's own tool can work on the picture.
        disable() {
            if (this.dead || !this.enabled) return;
            this._settle();
            this.deselect();
            this.enabled = false;
            this.layer.style.pointerEvents = 'none';
            // Over an image the overlay is ours, and it would still cover the image.
            if (this.host) this.svg.style.pointerEvents = 'none';
            this.svg.style.touchAction = this.savedTouchAction;
        }

        isEnabled() {
            return this.enabled;
        }

        setOptions(patch) {
            if (this.dead) return;
            this._settle();
            if (isObject(patch) && 'annotations' in patch) {
                this._problem('setOptions: use load() to replace the annotations');
                patch = { ...patch };
                delete patch.annotations;
            }
            this.opts = resolveOptions(patch, this.opts, (message) => this._problem(message));
            if (this.opts.historyEnabled) this._trimHistory();
            else this._resetHistory();
            this._renderAll();
            this._layoutChanged(); // the limits of the view may be other ones now
        }

        getOptions() {
            const options = { ...this.opts };
            for (const key of DATA_OPTIONS) options[key] = options[key] === null ? null : copy(options[key]);
            delete options.annotations;
            return options;
        }

        getSVGElement() {
            return this.svg;
        }

        getImageElement() {
            return this.host ? this.host.image : null;
        }

        getContainerElement() {
            return this.viewport;
        }

        // ---- drawing

        _color(ann) {
            const colors = this.opts.colors;
            const color = colors && ann.class_id != null ? colors[ann.class_id] : null;
            return typeof color === 'string' && color ? color : this.opts.color;
        }

        // Skeleton edges as [fromIndex, toIndex], skipping any that cannot be drawn.
        _edges(keypoints) {
            const skeleton = this.opts.skeleton;
            if (!skeleton || keypoints.length < 2) return [];
            const find = (ref) => (typeof ref === 'number' ? ref : keypoints.findIndex((kp) => kp.name === ref));
            const edges = [];
            for (const [from, to] of skeleton) {
                const i = find(from);
                const j = find(to);
                const a = keypoints[i];
                const b = keypoints[j];
                if (a && b && i !== j && isLabelled(a) && isLabelled(b)) edges.push([i, j]);
            }
            return edges;
        }

        _render(ann) {
            const key = String(ann.id);
            let d = this.dom.get(key);
            if (!d) {
                d = {
                    shapes: this._el('g', { class: 'markin-annotation', 'data-markin-id': key }),
                    points: this._el('g', { class: 'markin-annotation', 'data-markin-id': key }),
                    bbox: null,
                    polygon: null,
                    segments: null, // the points the polygon was last drawn from
                    skeleton: null,
                    circles: []
                };
                this.shapesLayer.appendChild(d.shapes);
                this.pointsLayer.appendChild(d.points);
                this.dom.set(key, d);
            }
            const o = this.opts;
            const u = this.unit;
            const color = this._color(ann);
            const sel = this.sel && this.sel.key === key ? this.sel : null;
            const dash = `${5 * u} ${5 * u}`;
            const cursor = (selected) => (selected || !o.requireSelectionToDrag ? 'move' : 'pointer');
            const mark = (selected) => (selected ? 'true' : null);
            const group = { 'data-class-id': ann.class_id, 'data-selected': mark(sel) };
            setAttrs(d.shapes, group);
            setAttrs(d.points, group);

            // The bbox and the polygon are drawn alike; only their geometry differs. Returns the node.
            const shape = (part, tag, exists, fillOpacity) => {
                if (!exists) {
                    if (d[part]) d[part].remove();
                    d[part] = null;
                    return null;
                }
                if (!d[part]) {
                    d[part] = this._el(tag, { class: `markin-${part}`, 'data-markin-part': part });
                    // The bbox goes below the polygon.
                    d.shapes.insertBefore(d[part], part === 'bbox' ? d.shapes.firstChild : null);
                }
                const on = !!sel && sel.part === part;
                setAttrs(d[part], {
                    fill: color,
                    'fill-opacity': fillOpacity,
                    stroke: color,
                    'stroke-opacity': 0.9,
                    'stroke-dasharray': on ? dash : null,
                    'data-selected': mark(on)
                });
                d[part].style.cursor = cursor(on);
                return d[part];
            };
            const rect = shape('bbox', 'rect', hasBox(ann), 0.15);
            if (rect) setAttrs(rect, { x: ann.bbox[0], y: ann.bbox[1], width: ann.bbox[2], height: ann.bbox[3] });
            const polygon = shape('polygon', 'polygon', hasPolygon(ann), 0.25);
            // The points of a large polygon make a long string. It is only rebuilt when they changed,
            // which the frozen array tells by identity.
            if (polygon && d.segments !== ann.segments) {
                polygon.setAttribute('points', ann.segments.map((p) => `${p[0]},${p[1]}`).join(' '));
            }
            d.segments = polygon ? ann.segments : null;

            const keypoints = keypointsOf(ann);
            const edges = this._edges(keypoints);
            if (edges.length) {
                if (!d.skeleton) {
                    d.skeleton = this._el('g', { class: 'markin-skeleton', 'pointer-events': 'none' });
                    d.points.insertBefore(d.skeleton, d.points.firstChild);
                }
                const style = o.skeletonStyle || {};
                const dashes = style.strokeDasharray
                    ? String(style.strokeDasharray)
                          .split(/[\s,]+/)
                          .filter(Boolean)
                          .map((n) => parseFloat(n) * u)
                          .join(' ')
                    : null;
                while (d.skeleton.childNodes.length > edges.length) d.skeleton.lastChild.remove();
                while (d.skeleton.childNodes.length < edges.length) d.skeleton.appendChild(this._el('line'));
                edges.forEach(([i, j], n) => {
                    setAttrs(d.skeleton.childNodes[n], {
                        x1: keypoints[i].point[0],
                        y1: keypoints[i].point[1],
                        x2: keypoints[j].point[0],
                        y2: keypoints[j].point[1],
                        stroke: style.stroke || color,
                        'stroke-width': (isNum(style.strokeWidth) ? style.strokeWidth : o.strokeWidth) * u,
                        'stroke-opacity': isNum(style.strokeOpacity) ? style.strokeOpacity : 0.8,
                        'stroke-dasharray': dashes
                    });
                });
            } else if (d.skeleton) {
                d.skeleton.remove();
                d.skeleton = null;
            }

            while (d.circles.length > keypoints.length) d.circles.pop().remove();
            keypoints.forEach((kp, i) => {
                let circle = d.circles[i];
                if (!circle) {
                    circle = this._el('circle', { class: 'markin-keypoint', 'data-markin-part': 'keypoint' });
                    d.points.appendChild(circle);
                    d.circles.push(circle);
                }
                const on = !!sel && sel.part === 'keypoint' && sel.index === i;
                const occluded = kp.v === 1;
                setAttrs(circle, {
                    cx: kp.point[0],
                    cy: kp.point[1],
                    // A selected keypoint opens up into a ring so the pixel underneath stays visible.
                    r: o.keypointRadius * u * (on ? 3 : 1),
                    fill: '#FFFFFF',
                    'fill-opacity': on ? 0.05 : occluded ? 0.15 : 0.7,
                    stroke: color,
                    'stroke-opacity': 0.9,
                    'stroke-dasharray': occluded ? `${2 * u} ${2 * u}` : null,
                    display: isLabelled(kp) ? null : 'none',
                    'data-index': i,
                    'data-name': kp.name,
                    'data-v': kp.v,
                    'data-selected': mark(on)
                });
                circle.style.cursor = cursor(on);
            });
        }

        _unrender(key) {
            const d = this.dom.get(key);
            if (!d) return;
            d.shapes.remove();
            d.points.remove();
            this.dom.delete(key);
        }

        _renderAll() {
            this.layer.setAttribute('stroke-width', this.opts.strokeWidth * this.unit);
            for (const ann of this.list) this._render(ann);
            this._reorder();
            this._renderUI();
        }

        // The on-screen scale changed. Outlines follow through the layer's stroke width; only
        // keypoints, skeletons and the selection are sized one by one, so nothing else is redrawn.
        _rescale() {
            this.layer.setAttribute('stroke-width', this.opts.strokeWidth * this.unit);
            const selected = this.sel ? this.byId.get(this.sel.key) : null;
            for (const ann of this.list) {
                if (ann === selected || keypointsOf(ann).length) this._render(ann);
            }
            this._renderUI();
        }

        // The annotations from the bottom of the stack to the top: largest first, so a small
        // annotation inside a big one can always be reached.
        _stack() {
            return this.list
                .map((ann, i) => ({ ann, area: areaOf(ann), i }))
                .sort((p, q) => q.area - p.area || p.i - q.i)
                .map((entry) => entry.ann);
        }

        // Put what is drawn in stacking order. Keypoints sit in their own layer above every shape.
        _reorder() {
            // Walk both layers once and move only the groups that are out of place.
            let shapes = this.shapesLayer.firstChild;
            let points = this.pointsLayer.firstChild;
            for (const ann of this._stack()) {
                const d = this.dom.get(String(ann.id));
                if (!d) continue;
                if (d.shapes === shapes) shapes = shapes.nextSibling;
                else this.shapesLayer.insertBefore(d.shapes, shapes);
                if (d.points === points) points = points.nextSibling;
                else this.pointsLayer.insertBefore(d.points, points);
            }
        }

        // Selection chrome: resize handles, vertex handles, the keypoint crosshair. Drawn from the
        // selection alone and kept in its own layer, so it is never part of the data or the history.
        _renderUI() {
            const s = this.sel;
            const ann = s ? this.byId.get(s.key) : null;
            const o = this.opts;
            const u = this.unit;
            const items = []; // [tag, attributes, cursor]

            // The grab area reaches past the visible handle, but never so far that the handles of a
            // small shape cover the shape itself.
            const slopFor = (box) =>
                clamp(Math.min(box.x2 - box.x1, box.y2 - box.y1) / u / 4 - o.handleRadius, 0, HANDLE_SLOP);
            const handle = (x, y, name, index, cursor, slop) => {
                items.push([
                    'circle',
                    {
                        class: 'markin-handle',
                        cx: x,
                        cy: y,
                        r: o.handleRadius * u,
                        fill: '#000000',
                        'fill-opacity': 0.5,
                        stroke: '#FFFFFF',
                        'stroke-width': u,
                        'pointer-events': 'none',
                        'data-markin-handle': null,
                        'data-index': null
                    },
                    ''
                ]);
                items.push([
                    'circle',
                    {
                        class: null,
                        cx: x,
                        cy: y,
                        r: (o.handleRadius + slop) * u,
                        fill: 'transparent',
                        'fill-opacity': null,
                        stroke: 'none',
                        'stroke-width': null,
                        'pointer-events': 'all',
                        'data-markin-handle': name,
                        'data-index': index
                    },
                    cursor
                ]);
            };
            const line = (x1, y1, x2, y2, dash) =>
                items.push([
                    'line',
                    {
                        x1,
                        y1,
                        x2,
                        y2,
                        stroke: '#000000',
                        'stroke-opacity': dash ? 0.6 : 0.35,
                        'stroke-width': u,
                        'stroke-dasharray': dash ? `${4 * u} ${4 * u}` : null,
                        'pointer-events': 'none'
                    },
                    ''
                ]);

            if (!ann) {
                // Nothing selected: no chrome.
            } else if (s.part === 'bbox') {
                const b = corners(ann.bbox);
                const slop = slopFor(b);
                handle(b.x1, b.y1, 'nw', 0, 'nwse-resize', slop);
                handle(b.x2, b.y1, 'ne', 1, 'nesw-resize', slop);
                handle(b.x1, b.y2, 'sw', 2, 'nesw-resize', slop);
                handle(b.x2, b.y2, 'se', 3, 'nwse-resize', slop);
            } else if (s.part === 'polygon') {
                const slop = slopFor(extent(ann.segments));
                ann.segments.forEach((p, i) => handle(p[0], p[1], 'vertex', i, 'move', slop));
            } else if (s.part === 'keypoint') {
                const [x, y] = ann.keypoints[s.index].point;
                const r = o.keypointRadius * u * 3;
                line(x, y - r, x, y + r, false);
                line(x - r, y, x + r, y, false);
            } else {
                // The whole annotation is selected: outline everything it contains.
                const box = extent(pointsOf(ann, PARTS));
                if (box) {
                    const pad = 6 * u;
                    line(box.x1 - pad, box.y1 - pad, box.x2 + pad, box.y1 - pad, true);
                    line(box.x2 + pad, box.y1 - pad, box.x2 + pad, box.y2 + pad, true);
                    line(box.x2 + pad, box.y2 + pad, box.x1 - pad, box.y2 + pad, true);
                    line(box.x1 - pad, box.y2 + pad, box.x1 - pad, box.y1 - pad, true);
                }
            }

            // While the chrome keeps its shape (the usual case during a drag) the nodes stay, and only
            // what differs from the last drawing is written. Nothing is read back from the DOM, so a
            // polygon with thousands of vertices stays responsive.
            const ui = this.uiLayer;
            const was = this.chrome;
            const keep =
                was.length === items.length &&
                ui.childNodes.length === items.length &&
                items.every((item, i) => item[0] === was[i][0]);
            if (!keep) ui.textContent = '';
            let node = ui.firstChild;
            items.forEach(([tag, attrs, cursor], i) => {
                const old = keep ? was[i] : null;
                if (!old) node = ui.appendChild(this._el(tag));
                setAttrs(node, attrs, old && old[1]);
                if (!old || old[2] !== cursor) node.style.cursor = cursor;
                node = node.nextSibling;
            });
            this.chrome = items;
        }

        // ---- pointer

        // What a pointer event landed on: one of our handles, one of our annotation parts, or nothing.
        _hit(target) {
            if (!target || typeof target.closest !== 'function') return null;
            const grab = target.closest('[data-markin-handle]');
            if (grab && this.uiLayer.contains(grab)) {
                return { kind: 'handle', handle: grab.getAttribute('data-markin-handle') };
            }
            const node = target.closest('[data-markin-part]');
            if (!node || !this.layer.contains(node)) return null;
            const group = node.closest('[data-markin-id]');
            const key = group ? group.getAttribute('data-markin-id') : null;
            if (key === null || !this.byId.has(key)) return null;
            const part = node.getAttribute('data-markin-part');
            return {
                kind: 'part',
                key,
                part,
                index: part === 'keypoint' ? Number(node.getAttribute('data-index')) : null
            };
        }

        _onPointerDown(event) {
            // One press is heard on the <svg> and, unless that took it, again on the viewport.
            if (this.pressed === event) return;
            this.pressed = event;
            if (!this._onCanvas(event)) return;
            this.inside = true;
            // A disabled editor edits nothing, but its view still moves and a click is still reported.
            const editing = this.enabled;
            if (!editing && !this.viewport) return;
            claimKeyboard(this, true);
            if (event.isPrimary === false) return;
            // Space or the middle button: this drag moves the view, whatever it starts on.
            const grab = this._pans() && (event.button === 1 || (event.button === 0 && this.space));
            if (!grab && event.button !== 0) return;
            if (this.gesture) {
                if (this.gesture.pointerId !== event.pointerId) return; // a second finger
                // The same pointer cannot go down twice, so the earlier release was missed.
                this._finishGesture(!this.gesture.live);
            }
            // Resolve the target first: the calls below may redraw the handles.
            const hit = grab || !editing ? null : this._hit(event.target);
            this._flushNudge();
            this._remeasure();
            if (editing && !this.enabled) return; // a change listener may have run

            const gesture = {
                kind: grab ? 'pan' : 'canvas',
                pointerId: event.pointerId,
                button: event.button,
                clientX: event.clientX,
                clientY: event.clientY,
                // Where the pointer was when the view last followed it.
                lastX: event.clientX,
                lastY: event.clientY,
                moved: false,
                live: false
            };
            if (grab) {
                // Ours alone: nothing is selected, nothing scrolls, and the page does not hear of it.
                event.preventDefault();
                event.stopPropagation();
                this._capture(gesture, this.viewport);
            } else if (hit) {
                // The press is ours: keep the page, and any pan/zoom library around us, out of it.
                event.preventDefault();
                event.stopPropagation();
                this._takeFocus();
                const target = this._pressTarget(hit, this._toLocal(event.clientX, event.clientY));
                if (!target) return;
                Object.assign(gesture, target);
                this._capture(gesture, this.svg);
            }
            this.gesture = gesture;
            // The rest of the press is followed on window, wherever the pointer goes.
            gesture.stops = [
                listen(this.win, 'pointermove', (e) => this._onGestureMove(e), true),
                listen(this.win, 'pointerup', (e) => this._onGestureEnd(e, false), true),
                listen(this.win, 'pointercancel', (e) => this._onGestureEnd(e, true), true)
            ];
            this._showGrab();
        }

        _capture(gesture, element) {
            try {
                element.setPointerCapture(gesture.pointerId);
                gesture.captured = element;
            } catch {
                // Without capture the window listeners still follow the pointer.
            }
        }

        // ---- moving the view by dragging

        // A hand over the whole editor while a drag would move the view, or does. The annotations
        // stop taking the pointer for that time, so the hand shows over them as well.
        _showGrab() {
            if (!this.viewport) return;
            const dragging = !!this.gesture && this.gesture.kind === 'pan';
            this.viewport.style.cursor = dragging ? 'grabbing' : this.space ? 'grab' : this.frame.cursor || '';
            this.layer.style.pointerEvents = dragging || this.space || !this.enabled ? 'none' : '';
        }

        _onInside() {
            this.inside = true;
        }

        _onOutside() {
            this.inside = false;
        }

        // The middle button must not start the browser's own scrolling, paste or open anything.
        _onMiddle(event) {
            if (event.button === 1 && this._pans() && this._onCanvas(event)) event.preventDefault();
        }

        // A press that is being followed must not turn into the browser dragging the image away.
        _onNativeDrag(event) {
            if (this.gesture) event.preventDefault();
        }

        _onBlur() {
            if (!this.space) return;
            this.space = false;
            this._showGrab();
        }

        // Space, held with the pointer over the editor, makes the next drag move the view.
        // It follows the pointer, not the editor that was used last. True when the key was taken.
        _onSpace(event, down) {
            if (event.code !== 'Space' && event.key !== ' ') return false;
            if (down && !this.space) {
                if (!this.inside || !this._pans() || event.ctrlKey || event.metaKey || event.altKey) return false;
            } else if (!this.space) {
                return false;
            }
            // Also on the way up, and while it repeats: the page must not scroll or press a button.
            event.preventDefault();
            if (this.space !== down) {
                this.space = down;
                this._showGrab();
            }
            return true;
        }

        // + and - zoom around the middle of the view, Shift+1 shows the whole image and Shift+0 its
        // real pixels. True when the view changed: a key that changes nothing is left to the page.
        _viewKey(event) {
            if (!this._pans() || event.ctrlKey || event.metaKey || event.altKey) return false;
            const zoom = (scale) => {
                const g = this._geometry();
                if (!g) return false;
                // Scale 1 here means the real pixels: one pixel of the image on one of the screen.
                const s = scale === 1 ? this.view.scale / g.scale : this.view.scale * scale;
                return this._zoomAt(s, g.left + (g.width * g.kx) / 2, g.top + (g.height * g.ky) / 2, g);
            };
            // The digits are read by where the keys are. With Shift they type other characters, and
            // which ones depends on the keyboard: Shift+0 is "=" on a German or a Turkish one.
            if (event.shiftKey && event.code === 'Digit1') return this.view.scale !== 1 && this.fit();
            if (event.shiftKey && event.code === 'Digit0') return zoom(1);
            if (event.key === '+' || event.key === '=' || event.code === 'NumpadAdd') return zoom(KEY_ZOOM);
            if (event.key === '-' || event.code === 'NumpadSubtract') return zoom(1 / KEY_ZOOM);
            return false;
        }

        // The click the browser sends when a drag of the view is released is not a click.
        _swallowClick() {
            const stop = listen(
                this.win,
                'click',
                (event) => {
                    event.stopPropagation();
                    event.preventDefault();
                    stop();
                },
                true
            );
            setTimeout(stop, 0);
        }

        // What a press on `hit` starts, or null if nothing. Host code (blur handlers, select
        // listeners) may have run since `hit` was read, so everything is checked again here.
        _pressTarget(hit, origin) {
            if (!this.enabled) return null;
            if (hit.kind === 'handle') {
                const s = this.sel;
                const ann = s ? this.byId.get(s.key) : null;
                if (!ann) return null;
                if (hit.handle !== 'vertex') {
                    if (s.part !== 'bbox' || !hasBox(ann)) return null;
                    return {
                        kind: 'resize',
                        handle: hit.handle,
                        key: s.key,
                        part: 'bbox',
                        index: null,
                        start: ann,
                        origin
                    };
                }
                if (s.part !== 'polygon' || !hasPolygon(ann)) return null;
                // The grab areas of close vertices overlap: take the vertex nearest to the press.
                let index = 0;
                let nearest = Infinity;
                ann.segments.forEach((p, i) => {
                    const distance = Math.hypot(p[0] - origin.x, p[1] - origin.y);
                    if (distance < nearest) {
                        nearest = distance;
                        index = i;
                    }
                });
                return { kind: 'vertex', handle: 'vertex', key: s.key, part: 'polygon', index, start: ann, origin };
            }
            const found = this.byId.get(hit.key);
            if (!found || !this._partExists(found, hit.part, hit.index)) return null;
            const wasSelected = this._isSelected(hit.key, hit.part, hit.index);
            if (!wasSelected) this._select(hit.key, hit.part, hit.index);
            if (!this.enabled) return null;
            const ann = this.byId.get(hit.key);
            if (!ann) return null;
            // Only a part that is (still) selected is dragged.
            const drags =
                this._isSelected(hit.key, hit.part, hit.index) && (wasSelected || !this.opts.requireSelectionToDrag);
            return {
                kind: drags ? 'move' : 'press',
                handle: null,
                key: hit.key,
                part: hit.part,
                index: hit.index,
                start: ann,
                origin
            };
        }

        // A prevented press does not move keyboard focus, so do what the browser would have done:
        // take typing focus out of a text field or another frame, and focus this window.
        // Otherwise Delete and the arrow keys would keep going to whatever had focus.
        _takeFocus() {
            try {
                let focused = this.doc.activeElement;
                while (focused && focused.shadowRoot && focused.shadowRoot.activeElement) {
                    focused = focused.shadowRoot.activeElement;
                }
                const frame = !!focused && /^(iframe|frame|object|embed)$/.test(focused.localName || '');
                if (focused && focused !== this.doc.body && typeof focused.blur === 'function') {
                    if (frame || isTypingElement(focused)) focused.blur();
                }
                if (typeof this.doc.hasFocus === 'function' && !this.doc.hasFocus()) this.win.focus();
            } catch {
                // Focus is a convenience; a browser that refuses must not stop the press.
            }
        }

        _onTouchStart(event) {
            if (this.enabled && this._hit(event.target)) event.stopPropagation();
        }

        // dragstart, drag and dragend. The payload carries a copy of the annotation, so it is only
        // built when somebody listens.
        _emitDrag(type, gesture, position, extra) {
            if (!this._has(type)) return;
            const ann = this.byId.get(gesture.key);
            this._emit(type, {
                id: ann.id,
                part: gesture.part,
                index: gesture.index,
                handle: gesture.handle,
                position,
                annotation: copy(ann),
                ...extra
            });
        }

        _onGestureMove(event) {
            const g = this.gesture;
            if (!g || event.pointerId !== g.pointerId) return;
            // A mouse move without its button means the release happened where we could not see it.
            if (event.pointerType === 'mouse' && (event.buttons & (g.button === 1 ? 4 : 1)) === 0) {
                this._finishGesture(false);
                return;
            }
            if (!g.moved) {
                if (Math.hypot(event.clientX - g.clientX, event.clientY - g.clientY) < DRAG_THRESHOLD) return;
                g.moved = true;
                // A drag that began on empty canvas moves the view, when there is somewhere to go.
                if (g.kind === 'canvas' && this.opts.panOnEmpty && this._pans() && this.view.scale > 1) {
                    g.kind = 'pan';
                }
                if (g.kind === 'pan') {
                    g.live = true;
                    this._showGrab();
                }
            }
            if (g.kind === 'pan') {
                event.preventDefault();
                const geo = this._geometry();
                if (geo) {
                    const v = this.view;
                    const dx = (event.clientX - g.lastX) / geo.kx;
                    const dy = (event.clientY - g.lastY) / geo.ky;
                    this._setView(v.scale, v.x + dx, v.y + dy, geo);
                }
                g.lastX = event.clientX;
                g.lastY = event.clientY;
                return;
            }
            if (g.kind === 'canvas' || g.kind === 'press') return;
            event.preventDefault();

            const position = this._toLocal(event.clientX, event.clientY);
            if (!g.live) {
                g.live = true;
                this._emitDrag('dragstart', g, g.origin);
                if (this.gesture !== g) return;
            }
            // Always work from the state at press time plus the total travel, so limits that
            // clamp the shape can never make it drift away from the pointer.
            const dx = position.x - g.origin.x;
            const dy = position.y - g.origin.y;
            if (g.kind === 'move') this._put(this._translated(g.start, g.part, g.index, dx, dy));
            else if (g.kind === 'resize') this._put(this._resized(g.start, g.handle, dx, dy));
            else this._put(this._pointMoved(g.start, 'polygon', g.index, dx, dy));
            this._emitDrag('drag', g, position);
        }

        _onGestureEnd(event, cancelled) {
            const g = this.gesture;
            if (!g || event.pointerId !== g.pointerId) return;
            this._finishGesture(cancelled, event);
        }

        // End the current press. A cancelled drag puts the annotation back where it started.
        _finishGesture(cancelled, event) {
            const g = this.gesture;
            if (!g) return;
            this.gesture = null;
            for (const stop of g.stops) stop();
            if (g.captured) {
                try {
                    g.captured.releasePointerCapture(g.pointerId);
                } catch {
                    // Already released.
                }
            }
            if (g.kind === 'pan') {
                this._showGrab();
                if (g.moved && event && !cancelled && g.button === 0) this._swallowClick();
                // The view was not allowed to settle while it was held.
                if (g.moved) this._viewChanged();
                return;
            }
            if (g.kind === 'canvas') {
                if (!g.moved && !cancelled) {
                    if (this.enabled) this.deselect();
                    this._emit('canvasclick', { position: this._toLocal(g.clientX, g.clientY) });
                }
                return;
            }
            if (!g.live) return; // a plain click on an annotation; selection already happened
            const current = this.byId.get(g.key);
            if (!current) return;
            if (cancelled) this._put(g.start);
            const changed = !cancelled && current !== g.start;
            const position = event ? this._toLocal(event.clientX, event.clientY) : g.origin;
            this._emitDrag('dragend', g, position, { changed, cancelled });
            if (changed && !this.dead && this.byId.get(g.key) === current) this._commit('update', [current.id]);
        }

        _onHover(event) {
            if (this.gesture || (!this.enabled && !this.viewport) || !this._onCanvas(event)) return;
            this.hoverEvent = { clientX: event.clientX, clientY: event.clientY, target: event.target };
            if (this.hoverFrame) return;
            this.hoverFrame = this._frame(() => {
                this.hoverFrame = 0;
                const last = this.hoverEvent;
                this.hoverEvent = null;
                if (!last) return;
                // Nothing can be pointed at in a disabled editor; where the pointer is still counts.
                const hit = this.enabled ? this._hit(last.target) : null;
                const part = hit && hit.kind === 'part' ? hit : null;
                this._remeasure();
                if (!this._has('hover')) return;
                this._emit('hover', {
                    position: this._toLocal(last.clientX, last.clientY),
                    id: part ? this.byId.get(part.key).id : null,
                    part: part ? part.part : null,
                    index: part ? part.index : null
                });
            });
        }

        // ---- keyboard

        _onKeyDown(event) {
            if (this.dead || !this.opts.keyboardControls) return;
            if (event.defaultPrevented || event.isComposing) return;
            if (typeof event.key !== 'string' || isTypingTarget(event)) return;
            if (this._onSpace(event, true)) return;
            if (keyboardOwner() !== this) return;
            if (this._viewKey(event)) {
                event.preventDefault();
                return;
            }
            // The keys above move the view. The ones below edit, which a disabled editor does not.
            if (!this.enabled) return;

            const mod = event.ctrlKey || event.metaKey;
            let key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
            // On a keyboard layout without Latin letters, fall back to the physical Z and Y keys.
            if (mod && key.length === 1 && !/[a-z]/.test(key)) {
                key = event.code === 'KeyZ' ? 'z' : event.code === 'KeyY' ? 'y' : key;
            }

            if (mod && !event.altKey && (key === 'z' || key === 'y')) {
                if (!this.opts.historyEnabled) return;
                // Only take the key when there was something to undo or redo.
                if (key === 'y' || event.shiftKey ? this.redo() : this.undo()) event.preventDefault();
                return;
            }
            if (key === 'Escape') {
                if (this.gesture && this.gesture.live) {
                    event.preventDefault();
                    this._finishGesture(true);
                } else if (this.sel) {
                    // Not prevented: an open dialog or menu should still see this Escape.
                    this.deselect();
                }
                return;
            }
            if (this.opts.stepKeys && (key === 'n' || key === 'p') && !mod && !event.altKey && !event.shiftKey) {
                // Not during a drag, which stepping would have to cancel.
                if (!this.gesture && this.step(key === 'n' ? 1 : -1)) event.preventDefault();
                return;
            }
            if (!this.sel || this.gesture) return;
            if (key === 'Delete' || key === 'Backspace') {
                event.preventDefault();
                this.deleteSelected();
                return;
            }
            if (!own(ARROWS, key)) return;
            const direction = ARROWS[key];
            event.preventDefault();
            const step = event.shiftKey ? 10 : mod || event.altKey ? 0.2 : 1;
            const ann = this.byId.get(this.sel.key);
            const next = this._translated(ann, this.sel.part, this.sel.index, direction[0] * step, direction[1] * step);
            if (next === ann) return;
            this._put(next);
            // A held key repeats many times a second; the whole run becomes one undo step.
            this.nudged = ann.id;
            clearTimeout(this.nudgeTimer);
            this.nudgeTimer = this._later(() => this._flushNudge(), NUDGE_COMMIT_MS);
        }

        _onKeyUp(event) {
            if (typeof event.key !== 'string') return;
            if (this._onSpace(event, false)) return;
            if (own(ARROWS, event.key)) this._flushNudge();
        }
    }

    // ------------------------------------------------------------------ entry point

    const PUBLIC = [
        'on',
        'off',
        'createAnnotation',
        'updateAnnotation',
        'deleteAnnotation',
        'addKeypoint',
        'getAnnotation',
        'getAnnotations',
        'load',
        'clear',
        'select',
        'deselect',
        'getSelection',
        'deleteSelected',
        'undo',
        'redo',
        'canUndo',
        'canRedo',
        'clearHistory',
        'enable',
        'disable',
        'isEnabled',
        'setOptions',
        'getOptions',
        'refresh',
        'getView',
        'setView',
        'zoomBy',
        'fit',
        'zoomTo',
        'step',
        'toImage',
        'toClient',
        'getSVGElement',
        'getImageElement',
        'getContainerElement',
        'destroy'
    ];

    function resolveTarget(target) {
        if (typeof target !== 'string') return target;
        const byId = document.getElementById(target);
        if (byId) return byId;
        try {
            return document.querySelector(target);
        } catch {
            return null;
        }
    }

    /**
     * Create an editor.
     * @param {SVGSVGElement|HTMLImageElement|string} target An <svg> to draw into, an <img> to lay an
     *   overlay on, or the id / CSS selector of either.
     * @param {object} [options] See the README for the full list. `options.annotations` is the initial data.
     * @returns {object} The editor.
     * @throws {TypeError} If the target cannot be found or is not an <svg> or <img>.
     */
    function create(target, options) {
        if (typeof document === 'undefined') throw new TypeError('MarkinJS.create needs a browser document');
        const node = resolveTarget(target);
        const tag = node && node.nodeType === 1 ? node.localName : null;
        const isSvg = tag === 'svg' && node.namespaceURI === SVG_NS;
        if (!isSvg && tag !== 'img') {
            throw new TypeError(
                typeof target === 'string'
                    ? `MarkinJS.create: no <svg> or <img> found for "${target}"`
                    : 'MarkinJS.create: the target must be an <svg> or <img> element'
            );
        }

        const previous = registry.get(node);
        if (previous && !previous.dead) {
            previous._log('warn', 'create() was called again on the same element; the earlier editor was destroyed');
            previous.destroy();
        }

        const editor = new Editor(node, options);
        registry.set(node, editor);

        const api = {};
        for (const name of PUBLIC) api[name] = (...args) => editor[name](...args);
        return Object.freeze(api);
    }

    return { version: VERSION, create, normalize, denormalize };
})();
