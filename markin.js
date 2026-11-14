// MarkinJS - SVG annotation editor for computer vision and image labeling.
//
// One file, no dependencies. Load it with a classic <script> tag (global `MarkinJS`);
// the build wraps the same file for ESM and CommonJS.
//
// The annotations are plain data owned by the editor. The SVG is drawn from that data and
// is never read back, so selection chrome, undo snapshots and export cannot corrupt each other.
const MarkinJS = (function () {
    'use strict';

    const VERSION = '0.5.0';
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
        'canvasdrag',
        'canvasdragend',
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
    // The points of a polygon as its `points` attribute takes them.
    const pointsText = (segments) => segments.map((p) => `${p[0]},${p[1]}`).join(' ');
    const hasGeometry = (a) => hasBox(a) || hasPolygon(a) || keypointsOf(a).length > 0;
    // A keypoint with v = 0 is "not labelled": it is not drawn and never moves with its annotation.
    const isLabelled = (kp) => kp.v !== 0;
    const corners = (bbox) => ({ x1: bbox[0], y1: bbox[1], x2: bbox[0] + bbox[2], y2: bbox[1] + bbox[3] });
    const toBbox = (box) => [box.x1, box.y1, box.x2 - box.x1, box.y2 - box.y1];
    const deselected = (sel) => ({ id: sel.id, part: sel.part, index: sel.index });
    const NO_LIMIT = Object.freeze({ x1: -Infinity, y1: -Infinity, x2: Infinity, y2: Infinity });

    // SVG user space -> client pixels through matrix `m`, and back through its inverse.
    function map(m, x, y) {
        return { x: m.a * x + m.c * y + m.e, y: m.b * x + m.d * y + m.f };
    }
    function unmap(m, clientX, clientY) {
        const det = m.a * m.d - m.b * m.c;
        const x = clientX - m.e;
        const y = clientY - m.f;
        return { x: (m.d * x - m.c * y) / det, y: (m.a * y - m.b * x) / det };
    }
    // Screen pixels per SVG unit under matrix `m`.
    const scaleOf = (m) => Math.sqrt(Math.abs(m.a * m.d - m.b * m.c));

    // Where a view of scale `s` may be moved to. `g` is the geometry it is measured in (see
    // Editor._geometry); the scale itself is limited by whoever asks (see Editor._place).
    //
    // A view shows the point that lies at X in the viewport at rest at x + s * X. Along each axis
    // the picture either still fits in the viewport, and stays where the layout had it (centred,
    // if it was centred), or it is larger, and can be moved until an edge of it comes `slack`
    // pixels into view: enough to reach a handle that sits on the edge.
    function limitView(s, x, y, g, slack) {
        const along = (t, size, from, to) => {
            // Nothing outside what the viewport shows at rest can ever be seen: an image cropped
            // by its own box stays cropped.
            const a = Math.max(from, 0);
            const b = Math.min(to, size);
            if (!(b > a)) return 0;
            const length = (b - a) * s;
            if (length <= size) {
                const spare = size - (b - a);
                const share = spare > 1e-6 ? a / spare : 0.5;
                return share * (size - length) - s * a;
            }
            const give = Math.min(slack, (length - size) / 2);
            return clampDelta(t, s * a, s * b, give, size - give);
        };
        return {
            scale: rounded(s, 6),
            x: rounded(along(x, g.width, g.x1, g.x2), 3),
            y: rounded(along(y, g.height, g.y1, g.y2), 3)
        };
    }

    // A number with so many decimals and no more: what is written to the page and what is
    // remembered are then the same number.
    function rounded(v, digits) {
        const n = Number(v.toFixed(digits));
        return Math.abs(n) < 1e-6 ? 0 : n;
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

    // The computed style of an element, or null where there is none to read.
    function styleOf(el) {
        try {
            return el.ownerDocument.defaultView.getComputedStyle(el);
        } catch {
            return null;
        }
    }

    // A length from a computed style, in layout pixels. Computed lengths are in pixels; anything
    // else means the element is not laid out, and counts as 0.
    function cssPx(style, name) {
        const text = style ? style[name] : '';
        return (/px$/.test(text) && parseFloat(text)) || 0;
    }

    // The CSS box of an element from its computed style: border plus padding on each side, and
    // the size of what is inside them. All 0 where it cannot be read.
    function cssBox(style) {
        const left = cssPx(style, 'borderLeftWidth') + cssPx(style, 'paddingLeft');
        const top = cssPx(style, 'borderTopWidth') + cssPx(style, 'paddingTop');
        const right = cssPx(style, 'borderRightWidth') + cssPx(style, 'paddingRight');
        const bottom = cssPx(style, 'borderBottomWidth') + cssPx(style, 'paddingBottom');
        const outer = !!style && style.boxSizing === 'border-box';
        return {
            left,
            top,
            right,
            bottom,
            width: cssPx(style, 'width') - (outer ? left + right : 0),
            height: cssPx(style, 'height') - (outer ? top + bottom : 0)
        };
    }

    // A viewBox `vb` fitted into an area of w by h, the way `fit` says (see aspectOf): the scale
    // from its units to pixels of the area, and where its origin lands.
    function fitted(vb, fit, w, h) {
        let sx = w / vb.w;
        let sy = h / vb.h;
        let ox = 0;
        let oy = 0;
        if (fit) {
            const s = fit.slice ? Math.max(sx, sy) : Math.min(sx, sy);
            ox = (w - vb.w * s) * fit.x;
            oy = (h - vb.h * s) * fit.y;
            sx = s;
            sy = s;
        }
        return { sx, sy, ox: ox - vb.x * sx, oy: oy - vb.y * sy };
    }

    // Some inline styles of an element as they are now, to be put back later with Object.assign.
    const inlineOf = (el, names) => Object.fromEntries(names.map((name) => [name, el.style[name]]));

    // A box as the part it is of the box `whole` around it, and such a part as a box again.
    const partOf = (b, whole) => ({
        x: (b.x - whole.x) / whole.w,
        y: (b.y - whole.y) / whole.h,
        w: b.w / whole.w,
        h: b.h / whole.h
    });
    const partIn = (part, whole) => ({
        x: whole.x + part.x * whole.w,
        y: whole.y + part.y * whole.h,
        w: part.w * whole.w,
        h: part.h * whole.h
    });

    // How an <svg> fits its viewBox into its box, from its preserveAspectRatio: where the spare room
    // goes (0, 0.5 or 1 on each axis) and whether it fills the box instead (`slice`). Null for
    // "none", which stretches.
    function aspectOf(value) {
        const text = (value || '').trim();
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

    // The picture and the SVG laid over it sit in a "stage", inside a "viewport" that clips what
    // is shown of them when the view is zoomed in. Build the two around `subject`, in its place;
    // `style` is the computed style of what the viewport stands in for on the page.
    function wrapInStage(subject, style) {
        const doc = subject.ownerDocument;
        const block = /^(block|flex|grid|table|list-item|flow-root)$/.test((style && style.display) || '');
        const viewport = doc.createElement('div');
        viewport.className = 'markin-container';
        viewport.style.cssText = `position:relative;display:${block ? 'block' : 'inline-block'};line-height:0`;
        const stage = doc.createElement('div');
        stage.className = 'markin-stage';
        stage.style.cssText = 'position:relative';
        subject.parentNode.insertBefore(viewport, subject);
        viewport.appendChild(stage);
        stage.appendChild(subject);
        return { viewport, stage };
    }

    // An image that has not arrived yet: there is nothing to draw on.
    const NO_PICTURE = { viewBox: null, aspect: 'none', box: null };

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

        const before = [image.offsetWidth, image.offsetHeight];
        const resized = () => image.offsetWidth !== before[0] || image.offsetHeight !== before[1];
        const { viewport: container, stage } = wrapInStage(subject, styleOf(image));
        // Wrapping must not change how the image is laid out. A size given as a percentage is the
        // usual casualty: it has to find the same box to refer to, through the viewport and the
        // stage. The width does by a viewport of the full width; the height needs both to pass it on.
        if (resized()) container.style.width = '100%';
        if (resized()) {
            container.style.height = '100%';
            stage.style.height = '100%';
        }
        if (resized()) {
            container.style.width = '';
            container.style.height = '';
            stage.style.height = '';
            note('wrapping the image changed its size on the page. Create the editor on your own <svg> instead.');
        }
        if (inPicture || image.hasAttribute('srcset')) {
            note(
                'the image uses srcset or <picture>: coordinates follow the size the browser reports for the chosen source.'
            );
        }

        const svg = svgEl(doc, 'svg', { class: 'markin-overlay', preserveAspectRatio: 'none' });
        svg.style.cssText = 'position:absolute;left:0;top:0;width:100%;height:100%;overflow:visible';
        stage.appendChild(svg);

        // What the editor draws from: the picture as an <svg> of the page's own would state it
        // (`home`: a viewBox of the image's own size, stretched over where the image is drawn),
        // where the overlay goes with the view at rest (as styles, and as numbers where the image
        // could be measured), and the picture element itself, which is what a zoomed view moves
        // and scales.
        const host = { image, viewport: container, stage, svg, pictures: [image], home: NO_PICTURE, drawn: null };
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
            host.home = loaded
                ? { viewBox: `0 0 ${nw} ${nh}`, aspect: 'none', box: { x: 0, y: 0, w: nw, h: nh } }
                : NO_PICTURE;
            svg.style.visibility = loaded ? '' : 'hidden';

            const style = styleOf(image);
            // Until the drawn image can be measured, the overlay simply covers the container.
            let place = { left: '0', top: '0', width: '100%', height: '100%', clipPath: '' };
            host.drawn = null;
            if (loaded && style && image.clientWidth > 0 && image.clientHeight > 0) {
                // The image's content box, in layout pixels: borders and padding are not part of the picture.
                const { left, top, width, height } = cssBox(style);
                let cw = width;
                let ch = height;
                if (!(cw > 0 && ch > 0)) {
                    cw = image.clientWidth - cssPx(style, 'paddingLeft') - cssPx(style, 'paddingRight');
                    ch = image.clientHeight - cssPx(style, 'paddingTop') - cssPx(style, 'paddingBottom');
                }
                if (cw > 0 && ch > 0) {
                    const drawn = drawnRect(nw, nh, cw, ch, style.objectFit, style.objectPosition);
                    // Where the image is cropped by its box, crop the overlay the same way.
                    const cut = [-drawn.y, drawn.x + drawn.width - cw, drawn.y + drawn.height - ch, -drawn.x];
                    host.drawn = {
                        x: image.offsetLeft + left + drawn.x,
                        y: image.offsetTop + top + drawn.y,
                        w: drawn.width,
                        h: drawn.height
                    };
                    place = {
                        left: `${host.drawn.x}px`,
                        top: `${host.drawn.y}px`,
                        width: `${drawn.width}px`,
                        height: `${drawn.height}px`,
                        clipPath: cut.some((n) => n > 0.5)
                            ? `inset(${cut.map((n) => `${Math.max(0, n)}px`).join(' ')})`
                            : ''
                    };
                }
            }
            host.place = place;
            onChange(fresh);
        };

        const stopLoad = listen(image, 'load', sync);
        const Observer = win && win.ResizeObserver;
        const observer = typeof Observer === 'function' ? new Observer(sync) : null;
        if (observer) observer.observe(image);

        host.sync = sync;
        host.teardown = () => {
            stopLoad();
            if (observer) observer.disconnect();
            if (container.parentNode) container.replaceWith(subject);
        };
        return host;
    }

    // What an editor on the page's own <svg> zooms in. Without a viewport it cannot zoom.
    //
    // An <svg> that holds the whole picture is its own viewport: only its viewBox changes. An <svg>
    // laid over a picture the page owns says so by an ancestor marked `data-markin-stage`: that
    // element holds the picture and the <svg>, and its parent is the viewport. An <svg> that is
    // laid over something else without saying so cannot zoom, because what is under it would
    // not follow.
    function frameOfSvg(svg, note) {
        const marked = svg.parentElement ? svg.parentElement.closest('[data-markin-stage]') : null;
        if (marked && marked.parentElement) {
            // Everything in the stage but the <svg> is the picture.
            const pictures = Array.from(marked.children).filter((el) => !el.contains(svg));
            return { viewport: marked.parentElement, stage: marked, pictures };
        }
        const style = styleOf(svg);
        if (style && /^(absolute|fixed|sticky)$/.test(style.position || '')) {
            note(
                'zoom and pan are off: the <svg> is laid over other content, which would not follow it. Mark the element that holds both with data-markin-stage (see the README).'
            );
            return { viewport: null, stage: null, pictures: [] };
        }
        return { viewport: svg, stage: null, pictures: [] };
    }

    // What is listened for on the viewport, and what hears it. The wheel and the pinch are kept
    // apart: to be prevented they must be heard in a way that makes the browser wait for the page
    // before it scrolls, which is only worth it while they are used.
    const VIEWPORT_EVENTS = {
        pointerdown: '_onPointerDown',
        mousedown: '_onMiddle',
        auxclick: '_onMiddle',
        dragstart: '_onNativeDrag'
    };
    // gesture*: WebKit's own events for a trackpad pinch. Other browsers never send them.
    const ZOOM_EVENTS = {
        wheel: '_onWheel',
        gesturestart: '_onPinch',
        gesturechange: '_onPinch',
        gestureend: '_onPinch'
    };
    // The kinds of press that hold an annotation. The others, 'canvas' and 'pan', hold none.
    const EDITING_GESTURES = ['press', 'move', 'resize', 'vertex'];

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
                target.localName === 'img'
                    ? mountOverImage(target, (fresh) => (fresh ? this._newPicture() : this.refresh()), warn)
                    : null;
            this.svg = this.host ? this.host.svg : target;
            // What zoom and pan work on: the viewport that clips, the stage that holds the picture
            // and the <svg> (when they are two things), and the picture elements themselves. An
            // <svg> that cannot zoom works as before; only a host that wants zoom is told.
            const frame = this.host || frameOfSvg(target, (message) => this.opts.zoomControls && warn(message));
            this.viewport = frame.viewport;
            this.stage = frame.stage;
            this.pictures = frame.pictures;
            // What the editor borrows from the page for as long as it lives, and gives back when
            // it is destroyed.
            this.rest = this.viewport
                ? {
                      cursor: this.viewport.style.cursor,
                      stage: this.stage ? inlineOf(this.stage, ['userSelect', 'webkitUserSelect']) : null
                  }
                : null;
            // The page's own elements that had no style attribute, to leave them without one again.
            this.bare = [this.svg, this.viewport, this.stage, ...this.pictures].filter(
                (el) => el && !el.hasAttribute('style')
            );
            // Nothing in the stage is text: a drag across it moves the view, it does not select.
            if (this.stage) Object.assign(this.stage.style, { userSelect: 'none', webkitUserSelect: 'none' });
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
            // The view: what lies at X in the viewport at rest is shown at x + scale * X.
            this.view = { scale: 1, x: 0, y: 0 };
            this.middle = null; // the image point in the middle of a zoomed view, to keep it there
            // What the page had where a zoomed view is written, and what was written there. Null
            // while the view is at rest: the page is then as the page has it.
            this.away = null;
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
            this.preview = null; // the shape shown as a suggestion, which is not an annotation, and its nodes

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

            const on = (target, type, method, options) => listen(target, type, (event) => this[method](event), options);
            this.cleanup = [
                on(svg, 'pointerdown', '_onPointerDown'),
                on(svg, 'touchstart', '_onTouchStart', { passive: true }),
                weakListen(this.doc, 'keydown', this, '_onKeyDown'),
                weakListen(this.doc, 'keyup', this, '_onKeyUp'),
                weakListen(this.win, 'resize', this, '_onResize'),
                weakListen(this.win, 'blur', this, '_onBlur'),
                // On the viewport where there is one: it also hears the pointer over a disabled overlay.
                weakListen(this.viewport || svg, 'pointermove', this, '_onHover')
            ];
            // The viewport is there whatever the picture is moved to, and hears what happens over the
            // image of a disabled editor. It stays in the page if the host drops the editor without
            // destroy(), so nothing that listens on it may keep the editor alive.
            const vp = this.viewport;
            if (vp) {
                this.cleanup.push(weakListen(vp, 'pointerleave', this, '_onOutside'));
                for (const type of Object.keys(VIEWPORT_EVENTS)) {
                    this.cleanup.push(weakListen(vp, type, this, '_onViewport'));
                }
            }
            this.zoomStops = null;
            this._hearZoom();
            this._syncPointer();
            // Over an image, the overlay is resized by the image's own observer, which also refreshes
            // the editor. A second observer here would only chase the first one.
            const Observer = this.win.ResizeObserver;
            if (!this.host && typeof Observer === 'function') {
                const ref = weakRefTo(this);
                const observer = new Observer(() => {
                    const live = ref.deref();
                    if (live) live.refresh();
                    else observer.disconnect();
                });
                observer.observe(svg);
                // A viewport or a stage the page sizes can change while the <svg> stays as it is.
                if (this.stage) {
                    observer.observe(vp);
                    observer.observe(this.stage);
                }
                this.cleanup.push(() => observer.disconnect());
            }
        }

        // Everything heard on the viewport comes through here. Only what happens on the picture, or
        // on the bare viewport around it, is the editor's: anything else the page put inside its own
        // viewport, a toolbar for one, keeps its events to itself.
        _onViewport(event) {
            if (this._onCanvas(event)) this[VIEWPORT_EVENTS[event.type] || ZOOM_EVENTS[event.type]](event);
        }

        _onCanvas(event) {
            const target = event.target;
            return target === this.viewport || (this.stage || this.svg).contains(target);
        }

        // Listen for the wheel and the pinch exactly while the user may move the view with them.
        _hearZoom() {
            const want = this._pans();
            if (want === !!this.zoomStops) return;
            if (want) {
                const hear = (type) => weakListen(this.viewport, type, this, '_onViewport', { passive: false });
                this.zoomStops = Object.keys(ZOOM_EVENTS).map(hear);
            } else {
                for (const stop of this.zoomStops) stop();
                this.zoomStops = null;
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
            this._finishGesture(true);
            this._settle();
            this.dead = true;
            this.enabled = false;
            for (const stop of this.cleanup) stop();
            this._hearZoom();
            clearTimeout(this.settleTimer);
            this.listeners = Object.create(null);
            // Let go of everything that was drawn, and of the page's route back to this editor.
            this.layer.remove();
            for (const layer of [this.shapesLayer, this.pointsLayer, this.uiLayer]) layer.textContent = '';
            if (registry.get(this.target) === this) registry.delete(this.target);
            this.svg.style.touchAction = this.savedTouchAction;
            if (this.viewport) {
                // The page gets back what it had: the <svg> and the picture as at rest, and its styles.
                this._resetView();
                this.viewport.style.cursor = this.rest.cursor;
                if (this.stage) Object.assign(this.stage.style, this.rest.stage);
            }
            if (this.host) this.host.teardown();
            for (const el of this.bare) if (el.getAttribute('style') === '') el.removeAttribute('style');
            this.list = [];
            this.byId.clear();
            this.dom.clear();
            this.chrome = [];
            this.sel = null;
            this.preview = null;
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

        // The picture with the view at rest: the viewBox of the <svg>, which is the image, and how
        // that is fitted into its box. `box` is the viewBox in numbers, or null when there is none.
        // Zoomed in, the attributes hold what is visible instead, and what they were is kept.
        _home() {
            if (this.host) return this.host.home;
            if (this.away) return this.away.home;
            const svg = this.svg;
            return {
                viewBox: svg.getAttribute('viewBox'),
                aspect: svg.getAttribute('preserveAspectRatio'),
                box: this._viewBox()
            };
        }

        // The page may put another viewBox on its own <svg> while the view is zoomed in. That is
        // another picture, as another file in an <img> is. Whatever asks about the picture looks
        // for one first.
        _follow() {
            const away = this.away;
            if (away && !this.host && this.svg.getAttribute('viewBox') !== away.viewBox) this._newPicture();
        }

        // Another picture in the same place starts at rest, and a preview was of the earlier one.
        _newPicture() {
            this.setPreview(null);
            this._resetView();
            this.refresh();
        }

        _atRest() {
            const v = this.view;
            return v.scale === 1 && v.x === 0 && v.y === 0;
        }

        // The area annotations must stay inside.
        _bounds() {
            this._follow();
            const vb = this.opts.constrainToImage ? this._home().box : null;
            return vb ? { x1: vb.x, y1: vb.y, x2: vb.x + vb.w, y2: vb.y + vb.h } : NO_LIMIT;
        }

        // Matrix from SVG user space to client pixels, or null while the SVG is not laid out.
        //
        // It is worked out from the box the SVG occupies on screen. getScreenCTM() cannot be relied
        // on for that: WebKit leaves the scale of a CSS-transformed ancestor out of it, and a page
        // may well scale what the editor is in. Only a rotated or skewed canvas is more than a box
        // can tell, and there the browser's own matrix is used as it is.
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

        // The <svg> as it is laid out: where its drawing area starts on screen, the size of that area
        // in layout pixels, and how many screen pixels a layout pixel is. Null while it is not laid out.
        _svgBox() {
            const svg = this.svg;
            // getBoundingClientRect() is reported by every browser with all transforms applied.
            const rect = svg.getBoundingClientRect();
            if (!(rect.width > 0 && rect.height > 0)) return null;
            // Border and padding of the <svg> itself are not part of its drawing area. They are
            // layout pixels, and so is its size as CSS sees it; a scaled ancestor makes each of
            // those `kx` by `ky` pixels on screen.
            const box = cssBox(styleOf(svg));
            const sized = box.width > 0 && box.height > 0;
            const kx = sized ? rect.width / (box.width + box.left + box.right) : 1;
            const ky = sized ? rect.height / (box.height + box.top + box.bottom) : 1;
            const w = rect.width / kx - box.left - box.right;
            const h = rect.height / ky - box.top - box.bottom;
            if (!(w > 0 && h > 0)) return null;
            return { x: rect.left + box.left * kx, y: rect.top + box.top * ky, w, h, kx, ky, sized };
        }

        // The matrix for an upright canvas: the viewBox fitted into the drawing area, as
        // preserveAspectRatio asks.
        _boxMatrix() {
            const box = this._svgBox();
            if (!box) return null;
            const vb = this._viewBox();
            const fit = vb
                ? fitted(vb, aspectOf(this.svg.getAttribute('preserveAspectRatio')), box.w, box.h)
                : { sx: 1, sy: 1, ox: 0, oy: 0 };
            return {
                a: fit.sx * box.kx,
                b: 0,
                c: 0,
                d: fit.sy * box.ky,
                e: box.x + fit.ox * box.kx,
                f: box.y + fit.oy * box.ky
            };
        }

        // A point on screen as a point of the image. `m` is the matrix, when the caller has it already.
        _toLocal(clientX, clientY, m = this._matrix()) {
            return m ? unmap(m, clientX, clientY) : { x: clientX, y: clientY };
        }

        // Re-read how many SVG units one screen pixel covers. True when it changed noticeably.
        // `m` is the matrix, when the caller has it already, and `zoom` how many times larger than
        // under that matrix the picture is about to be shown.
        _measure(m = this._matrix(), zoom = 1) {
            if (!m) return false;
            const scale = scaleOf(m) * zoom;
            if (!(scale > 0) || !Number.isFinite(scale)) return false;
            const unit = 1 / scale;
            if (Math.abs(unit - this.unit) <= this.unit * 0.005) return false;
            this.unit = unit;
            return true;
        }

        // Handles and outlines take the size the canvas now has on screen.
        _remeasure(m, zoom) {
            if (!this.dead && this._measure(m, zoom)) this._rescale();
        }

        _onResize() {
            if (this.host) this.host.sync();
            else this.refresh();
        }

        // The canvas changed size or place on the page: measure it again.
        refresh() {
            if (this.dead) return;
            // Over an image the <svg> follows the image, which the page may lay out differently
            // now. At rest that is all there is to follow; an <svg> of the page's own is the page's.
            if (this.host && this._atRest()) this._writeView(null);
            const g = this._geometry();
            if (g && !this._atRest()) {
                // A view that is zoomed in keeps the same point of the image in its middle, as far as
                // the limits allow, which may be other ones now.
                const p = map(g.rest, this.middle.x, this.middle.y);
                if (!this._place(this.view.scale, p.x, p.y, g.width / 2, g.height / 2, g)) this._writeView(g);
            }
            this._remeasure();
            // The same view shows another part of the image once the viewport has another size.
            if (g) this._viewChanged();
        }

        // ---- view: zoom and pan
        //
        // The <svg> is never scaled. Zoomed in, its viewBox is the part of the image that is shown,
        // so what it draws is drawn at the size it has on screen and stays sharp in every browser;
        // a layer that is scaled with a CSS transform is one that WebKit may enlarge as a bitmap.
        // Only the picture under the <svg>, which is a bitmap anyway, is moved and scaled with CSS.

        // What the view is worked out from, measured now. Null while there is nothing to zoom or the
        // page is not laid out. Lengths are layout pixels of the viewport unless they say otherwise.
        _geometry() {
            if (this.dead || !this.viewport) return null;
            this._follow();
            const home = this._home();
            // An image that has not arrived yet has no size to speak of.
            if (this.host && !home.box) return null;
            const own = this._svgBox();
            if (!own) return null;
            // An <svg> that holds the whole picture is its own viewport.
            let { kx, ky } = own;
            let left = own.x;
            let top = own.y;
            let width = own.w;
            let height = own.h;
            // Where the <svg> lies with the view at rest, in viewport pixels, and which part of
            // the stage that is.
            let lie = { x: 0, y: 0, w: width, h: height };
            let whole = null; // the stage
            let within = null;
            if (this.stage) {
                const vp = this.viewport;
                const box = vp.getBoundingClientRect();
                if (!(box.width > 0 && box.height > 0)) return null;
                // Scaled by the page around the editor, a layout pixel is `kx` by `ky` pixels on
                // screen. The <svg> knows exactly; the viewport's size is rounded to whole pixels.
                if (!own.sized) {
                    kx = vp.offsetWidth > 0 ? box.width / vp.offsetWidth : 1;
                    ky = vp.offsetHeight > 0 ? box.height / vp.offsetHeight : 1;
                }
                // What is shown is the inside of the viewport's border.
                left = box.left + (vp.clientLeft || 0) * kx;
                top = box.top + (vp.clientTop || 0) * ky;
                width = box.width / kx - (vp.offsetWidth > 0 ? vp.offsetWidth - vp.clientWidth : 0);
                height = box.height / ky - (vp.offsetHeight > 0 ? vp.offsetHeight - vp.clientHeight : 0);
                // The stage is never moved: it is where the page laid the picture out.
                const stage = this.stage.getBoundingClientRect();
                if (!(stage.width > 0 && stage.height > 0)) return null;
                whole = {
                    x: (stage.left - left) / kx,
                    y: (stage.top - top) / ky,
                    w: stage.width / kx,
                    h: stage.height / ky
                };
                // At rest the <svg> lies where it is. Zoomed in it covers the viewport instead,
                // and its place at rest is the image as drawn, which the mount keeps measured,
                // or else the part of the stage it had when the view left rest.
                const drawn = this.host && this.host.drawn;
                if (!this.away) {
                    lie = {
                        x: (own.x - left) / kx,
                        y: (own.y - top) / ky,
                        w: (own.w * own.kx) / kx,
                        h: (own.h * own.ky) / ky
                    };
                } else if (drawn) {
                    lie = { x: whole.x + drawn.x, y: whole.y + drawn.y, w: drawn.w, h: drawn.h };
                } else {
                    lie = partIn(this.away.within, whole);
                }
                within = this.away ? this.away.within : partOf(lie, whole);
            }
            // An <svg> without a viewBox is its own picture, one unit to the layout pixel.
            const image = home.box || { x: 0, y: 0, w: lie.w, h: lie.h };
            const fit = fitted(image, home.box ? aspectOf(home.aspect) : null, lie.w, lie.h);
            // With the view at rest, the image point q lies at rest(q) in the viewport ...
            const rest = { a: fit.sx, b: 0, c: 0, d: fit.sy, e: lie.x + fit.ox, f: lie.y + fit.oy };
            // ... and the view shows it at x + scale * rest(q). The same as a matrix to the screen:
            const v = this.view;
            const m = {
                a: kx * v.scale * rest.a,
                b: 0,
                c: 0,
                d: ky * v.scale * rest.d,
                e: left + kx * (v.x + v.scale * rest.e),
                f: top + ky * (v.y + v.scale * rest.f)
            };
            // Screen pixels per image pixel now, and with the view at rest.
            const scale = scaleOf(m);
            const base = scale / v.scale;
            const from = map(rest, image.x, image.y);
            const to = map(rest, image.x + image.w, image.y + image.h);
            return {
                m,
                kx,
                ky,
                left,
                top,
                width,
                height,
                rest,
                // The picture at rest, in viewport pixels.
                x1: from.x,
                x2: to.x,
                y1: from.y,
                y2: to.y,
                image,
                home,
                scale,
                // Zoomed out, the limit is the picture as the page lays it out, however large that is.
                maxScale: Math.max(1, this.opts.maxScale / base),
                stage: whole,
                within
            };
        }

        // The image points at the top left and the bottom right of the viewport.
        _shown(g) {
            return [unmap(g.m, g.left, g.top), unmap(g.m, g.left + g.width * g.kx, g.top + g.height * g.ky)];
        }

        // Move the view, as far as the picture allows. True when that changed it.
        _setView(scale, x, y, g) {
            // The slack is the width of a handle, which is a size on screen.
            const slack = (2 * this.opts.handleRadius + this.opts.strokeWidth) / g.kx;
            const next = limitView(scale, x, y, g, slack);
            const v = this.view;
            if (next.scale === v.scale && next.x === v.x && next.y === v.y) return false;
            // Handles and outlines follow a zoom in the same frame: they are measured by the matrix,
            // which is larger by as much as the view is. It is read before the page is written;
            // asked for afterwards, the browser would lay the page out a second time for it.
            // Moving the view changes no size.
            const before = next.scale !== v.scale ? this._matrix() : null;
            this.view = next;
            // The image point in the middle: where a resized canvas picks the view up again.
            this.middle = unmap(g.rest, (g.width / 2 - next.x) / next.scale, (g.height / 2 - next.y) / next.scale);
            this._writeView(g);
            if (before) this._remeasure(before, next.scale / v.scale);
            this._viewChanged();
            return true;
        }

        // Show what lies at (sx, sy) at rest at (ax, ay), at `scale` or as near to it as the limits
        // allow. All four are viewport pixels. Everything that zooms comes through here.
        _place(scale, sx, sy, ax, ay, g) {
            const s = clamp(scale, 1, g.maxScale);
            return this._setView(s, ax - s * sx, ay - s * sy, g);
        }

        // Move the view by a distance on screen.
        _panBy(dx, dy, g) {
            const v = this.view;
            return this._setView(v.scale, v.x + dx / g.kx, v.y + dy / g.ky, g);
        }

        // Put the view on the page. At rest everything is as the page, or the image, has it, and
        // the geometry `g` is not needed.
        _writeView(g) {
            const svg = this.svg;
            const { scale: s, x, y } = this.view;
            if (this._atRest()) {
                const away = this.away;
                if (away) {
                    // The page gets back what it had when the view left rest. A viewBox it has put
                    // there since is its own.
                    this.away = null;
                    if (svg.getAttribute('viewBox') === away.viewBox) setAttrs(svg, { viewBox: away.home.viewBox });
                    setAttrs(svg, { preserveAspectRatio: away.home.aspect });
                    if (away.svg) Object.assign(svg.style, away.svg);
                    this.viewport.style.overflow = away.overflow;
                    this.pictures.forEach((el, i) => Object.assign(el.style, away.pictures[i]));
                }
                if (this.host) {
                    // Over an image the <svg> goes where the image is drawn now.
                    const home = this.host.home;
                    setAttrs(svg, { viewBox: home.viewBox, preserveAspectRatio: home.aspect });
                    Object.assign(svg.style, this.host.place);
                }
                return;
            }
            if (!this.away) {
                // Leaving rest: what the page has where the view is about to be written.
                this.away = {
                    home: g.home,
                    within: g.within,
                    // Which part of the stage each picture takes. That is how its place at rest is
                    // known from here on: the stage is never moved, while a picture that has been
                    // moved far and scaled up cannot be measured closely enough.
                    parts: this.pictures.map((el) => {
                        const r = el.getBoundingClientRect();
                        const at = { x: (r.left - g.left) / g.kx, y: (r.top - g.top) / g.ky };
                        return partOf({ ...at, w: r.width / g.kx, h: r.height / g.ky }, g.stage);
                    }),
                    svg: this.stage ? inlineOf(svg, ['left', 'top', 'width', 'height', 'overflow', 'clipPath']) : null,
                    overflow: this.viewport.style.overflow,
                    pictures: this.pictures.map((el) => inlineOf(el, ['transform', 'transformOrigin'])),
                    viewBox: null // the one written for the view
                };
            }
            const away = this.away;
            // What the viewport shows of the image, stretched over all of the <svg>.
            const corner = unmap(g.rest, -x / s, -y / s);
            const box = [corner.x, corner.y, g.width / (s * g.rest.a), g.height / (s * g.rest.d)];
            away.viewBox = box.map((n) => rounded(n, 9)).join(' ');
            setAttrs(svg, { viewBox: away.viewBox, preserveAspectRatio: 'none' });
            const px = (n) => `${rounded(n, 3)}px`;
            if (this.stage) {
                // Over a picture the <svg> covers the viewport, which clips the picture under it.
                Object.assign(svg.style, {
                    left: px(-g.stage.x),
                    top: px(-g.stage.y),
                    width: px(g.width),
                    height: px(g.height),
                    overflow: 'hidden',
                    clipPath: ''
                });
            }
            // On its own the <svg> is the viewport, and clips like one.
            this.viewport.style.overflow = 'hidden';
            // Each picture is moved and scaled about its own corner to where the view shows it.
            this.pictures.forEach((el, i) => {
                const at = partIn(away.parts[i], g.stage);
                el.style.transformOrigin = '0 0';
                el.style.transform = `translate(${px(x + (s - 1) * at.x)}, ${px(y + (s - 1) * at.y)}) scale(${s})`;
            });
        }

        // Back to the whole picture, without a word: for another picture in the same place.
        _resetView() {
            this.view = { scale: 1, x: 0, y: 0 };
            this.middle = null;
            this.settledKey = null; // another picture is news, even at the same size
            this._writeView(null);
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
            const [p, q] = this._shown(g);
            const key = [p.x, p.y, q.x, q.y, g.scale].map((n) => Math.round(n * 1000)).join(' ');
            if (key === this.viewKey) return;
            this.viewKey = key;
            if (this._has('viewchange')) this._emit('viewchange', this._viewOf(g));
        }

        _armSettle() {
            clearTimeout(this.settleTimer);
            // Not while the view is held: a pause in a drag is not the end of it.
            if (this._panning()) return;
            this.settleTimer = this._later(() => this._settleView(), this.opts.settleDelay);
        }

        _settleView() {
            const view = this.getView();
            if (!view) return;
            // Only a view that would give another crop is worth the host's work.
            const key = [view.x, view.y, view.width, view.height].join(' ');
            if (key === this.settledKey) return;
            this.settledKey = key;
            this._emit('viewsettle', view);
        }

        // Zoom to `scale`, keeping what is under a point on screen where it is: the client point
        // (clientX, clientY), or else the middle of the viewport.
        _zoomAt(scale, g, clientX = g.left + (g.width * g.kx) / 2, clientY = g.top + (g.height * g.ky) / 2) {
            const v = this.view;
            const ax = (clientX - g.left) / g.kx;
            const ay = (clientY - g.top) / g.ky;
            return this._place(scale, (ax - v.x) / v.scale, (ay - v.y) / v.scale, ax, ay, g);
        }

        // Show the image rectangle (x1, y1)-(x2, y2) in the middle of the viewport, as large as it
        // fits `pad` screen pixels away from the edges.
        _show(x1, y1, x2, y2, pad) {
            const g = this._geometry();
            if (!g) return false;
            // Where the two corners lie in the viewport with the view at rest.
            const a = map(g.rest, x1, y1);
            const b = map(g.rest, x2, y2);
            const roomX = Math.max(g.width - (2 * pad) / g.kx, 1);
            const roomY = Math.max(g.height - (2 * pad) / g.ky, 1);
            // A rectangle without a size, a single keypoint, is shown as close as the view goes.
            const scale = Math.min(roomX / Math.abs(b.x - a.x), roomY / Math.abs(b.y - a.y));
            this._place(scale, (a.x + b.x) / 2, (a.y + b.y) / 2, g.width / 2, g.height / 2, g);
            return true;
        }

        // The part of the image the viewport shows, as the whole pixels that cover it.
        _viewOf(g) {
            const [p, q] = this._shown(g);
            const seen = extent([Object.values(p), Object.values(q)]);
            const im = g.image;
            const within = (v, from, length) => clamp(v, from, from + length);
            // A crop must hold everything that is visible, so it is rounded outward.
            const x = within(Math.floor(seen.x1 + 1e-6), im.x, im.w);
            const y = within(Math.floor(seen.y1 + 1e-6), im.y, im.h);
            const right = within(Math.ceil(seen.x2 - 1e-6), im.x, im.w);
            const bottom = within(Math.ceil(seen.y2 - 1e-6), im.y, im.h);
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
            const c = at ? map(g.m, at.x, at.y) : {};
            this._zoomAt(this.view.scale * factor, g, c.x, c.y);
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
            if (this.byId.has(String(ann.id))) this.zoomTo(ann.id);
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
            return m ? map(m, x, y) : { x, y };
        }

        // ---- zoom and pan by hand

        // True when the user may move the view.
        _pans() {
            return !this.dead && !!this.viewport && this.opts.zoomControls;
        }

        // A wheel or a trackpad. Pinching a trackpad also arrives here, as a wheel with Ctrl held
        // (Chrome, Firefox, Edge); WebKit sends gesture events instead.
        _onWheel(event) {
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
            let moved;
            if (zooms) {
                // A notch of a mouse wheel is about 100 and zooms by 15%. A pinch reports small
                // numbers, which Ctrl marks; a real Ctrl + wheel is kept from leaping.
                const power = clamp(-dy * 0.002 * (event.ctrlKey ? 10 : 1), -0.35, 0.35);
                moved = this._zoomAt(this.view.scale * Math.pow(2, power), g, event.clientX, event.clientY);
            } else {
                // Shift turns a wheel that only goes up and down sideways.
                if (event.shiftKey && dx === 0) [dx, dy] = [dy, 0];
                moved = this._panBy(-dx, -dy, g);
            }
            if (first && moved) run.ours = true;
            if (run.ours) event.preventDefault();
        }

        // A trackpad pinch in WebKit (Safari, and the web views built on it). `event.scale` is how
        // far the fingers have moved apart since the pinch began. Prevented, or the whole page zooms.
        _onPinch(event) {
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
            const g = this._geometry();
            if (g) this._zoomAt(p.scale * event.scale, g, at(event.clientX, p.x), at(event.clientY, p.y));
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
            if (this.gesture && EDITING_GESTURES.includes(this.gesture.kind)) this._finishGesture(true);
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
                this._follow();
                const vb = this._home().box;
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

        // ---- preview

        // Show one shape that is not an annotation: a suggestion the page may turn into one with
        // createAnnotation(). It takes the fields of an annotation, of which the bbox and the
        // polygon are drawn. It is no data: nothing is announced or recorded, it cannot be
        // touched, and load() and clear() leave it where it is. `null` takes it away.
        setPreview(shape) {
            if (this.dead) return false;
            let value = null;
            if (shape != null) {
                const result = parseAnnotation(shape);
                const drawn = !result.error && (hasBox(result.value) || hasPolygon(result.value));
                if (!drawn) {
                    this._problem(`setPreview: ${result.error || 'a preview needs a bbox or segments'}`);
                    return false;
                }
                value = result.value;
            }
            if (!value) {
                if (this.preview) this.preview.group.remove();
                this.preview = null;
                return true;
            }
            if (!this.preview) {
                // It lies above every annotation and takes no pointer events, so what is under it
                // is hovered and clicked as if it were not there.
                const d = (this.preview = {
                    shape: null,
                    group: this._el('g', { class: 'markin-preview', 'pointer-events': 'none', 'stroke-opacity': 0.9 }),
                    bbox: this._el('rect', { class: 'markin-bbox', 'fill-opacity': 0.06 }),
                    polygon: this._el('polygon', { class: 'markin-polygon', 'fill-opacity': 0.12 }),
                    segments: null // the points the polygon was last drawn from
                });
                d.group.append(d.bbox, d.polygon);
                this.layer.insertBefore(d.group, this.uiLayer);
            }
            this.preview.shape = value;
            this._renderPreview();
            return true;
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
            this._syncPointer();
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
            this._syncPointer();
        }

        // A disabled editor still hears the pointer for its view. Without a view it hears nothing.
        _hears() {
            return this.enabled || !!this.viewport;
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
            this._hearZoom();
            this.refresh(); // the limits of the view may be other ones now
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
            // An <svg> that is its own viewport has nothing around it.
            return this.stage ? this.viewport : null;
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
                polygon.setAttribute('points', pointsText(ann.segments));
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

        // The look of the preview is in attributes, which a page's CSS for `.markin-preview` overrides.
        _renderPreview() {
            const d = this.preview;
            if (!d) return;
            const shape = d.shape;
            const u = this.unit;
            const color = this._color(shape);
            setAttrs(d.group, {
                fill: color,
                stroke: color,
                'stroke-dasharray': `${3 * u} ${3 * u}`,
                'data-class-id': shape.class_id
            });
            // A part the shape does not have stays in the group, unseen, for the next shape.
            const box = hasBox(shape) ? shape.bbox : null;
            const [x, y, width, height] = box || [];
            setAttrs(d.bbox, { x, y, width, height, display: box ? null : 'none' });
            const segments = hasPolygon(shape) ? shape.segments : null;
            if (segments && d.segments !== segments) {
                d.polygon.setAttribute('points', pointsText(segments));
                d.segments = segments;
            }
            setAttrs(d.polygon, { display: segments ? null : 'none' });
        }

        _renderAll() {
            this.layer.setAttribute('stroke-width', this.opts.strokeWidth * this.unit);
            for (const ann of this.list) this._render(ann);
            this._reorder();
            this._renderPreview();
            this._renderUI();
        }

        // The on-screen scale changed. Outlines follow through the layer's stroke width; only
        // keypoints, skeletons, the selection and the dashes of the preview are sized one by one, so
        // nothing else is redrawn.
        _rescale() {
            this.layer.setAttribute('stroke-width', this.opts.strokeWidth * this.unit);
            const selected = this.sel ? this.byId.get(this.sel.key) : null;
            for (const ann of this.list) {
                if (ann === selected || keypointsOf(ann).length) this._render(ann);
            }
            this._renderPreview();
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
            // Nothing can be pointed at in an editor that does not edit.
            if (!this.enabled || !target || typeof target.closest !== 'function') return null;
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
            this.inside = true;
            // A disabled editor edits nothing, but its view still moves and a click is still reported.
            const editing = this.enabled;
            if (!this._hears()) return;
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
            const hit = grab ? null : this._hit(event.target);
            this._flushNudge();
            const m = this._matrix();
            this._remeasure(m);
            if (editing && !this.enabled) return; // a change listener may have run

            const gesture = {
                kind: grab ? 'pan' : 'canvas',
                pointerId: event.pointerId,
                button: event.button,
                clientX: event.clientX,
                clientY: event.clientY,
                // The same point in the image: it stays that point when the view moves under the press.
                origin: this._toLocal(event.clientX, event.clientY, m),
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
                const target = this._pressTarget(hit, gesture.origin);
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
            this._syncPointer();
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

        _panning() {
            return !!this.gesture && this.gesture.kind === 'pan';
        }

        // What the pointer can reach, and how it looks. It follows from three things: whether the
        // editor edits, whether Space is held, and whether the view is being dragged.
        _syncPointer() {
            const hand = this._panning() ? 'grabbing' : this.space ? 'grab' : '';
            if (this.viewport) this.viewport.style.cursor = hand || this.rest.cursor;
            // Under the hand the annotations stop taking the pointer, so it shows over them as well.
            this.layer.style.pointerEvents = hand || !this.enabled ? 'none' : '';
            // Over an image the overlay is ours, and it would still cover the image of a disabled editor.
            if (this.host) this.svg.style.pointerEvents = this.enabled ? '' : 'none';
            this.svg.style.touchAction = this.enabled ? 'none' : this.savedTouchAction;
        }

        _onOutside() {
            this.inside = false;
        }

        // The middle button must not start the browser's own scrolling, paste or open anything.
        _onMiddle(event) {
            if (event.button === 1 && this._pans()) event.preventDefault();
        }

        // A press that is being followed must not turn into the browser dragging the image away.
        _onNativeDrag(event) {
            if (this.gesture) event.preventDefault();
        }

        _onBlur() {
            if (!this.space) return;
            this.space = false;
            this._syncPointer();
        }

        // Space, held with the pointer over the editor, makes the next drag move the view.
        // It follows the pointer, not the editor that was used last. True when the key was taken.
        _onSpace(event, down) {
            if (event.code !== 'Space' && event.key !== ' ') return false;
            const modified = event.ctrlKey || event.metaKey || event.altKey;
            const starts = down && this.inside && this._pans() && !modified;
            if (!this.space && !starts) return false;
            // Also on the way up, and while it repeats: the page must not scroll or press a button.
            event.preventDefault();
            if (this.space !== down) {
                this.space = down;
                this._syncPointer();
            }
            return true;
        }

        // + and - zoom around the middle of the view, Shift+1 shows the whole image and Shift+0 its
        // real pixels. True when the view changed: a key that changes nothing is left to the page.
        _viewKey(event) {
            if (!this._pans() || event.ctrlKey || event.metaKey || event.altKey) return false;
            const g = this._geometry();
            if (!g) return false;
            const scale = this.view.scale;
            // The digits are read by where the keys are. With Shift they type other characters, and
            // which ones depends on the keyboard: Shift+0 is "=" on a German or a Turkish one.
            if (event.shiftKey && event.code === 'Digit1') return this._setView(1, 0, 0, g);
            // Real pixels: one pixel of the image on one of the screen.
            if (event.shiftKey && event.code === 'Digit0') return this._zoomAt(scale / g.scale, g);
            if (event.key === '+' || event.key === '=' || event.code === 'NumpadAdd')
                return this._zoomAt(scale * KEY_ZOOM, g);
            if (event.key === '-' || event.code === 'NumpadSubtract') return this._zoomAt(scale / KEY_ZOOM, g);
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
            if (this._hit(event.target)) event.stopPropagation();
        }

        // dragstart, drag and dragend. The payload carries a copy of the annotation, so it is only
        // built when somebody listens.
        // The box a drag across the empty canvas spans, [x, y, width, height] in image pixels, inside
        // the image when constrainToImage is on.
        _spanned(g) {
            const B = this._bounds();
            const clamp = (p) => [Math.min(Math.max(p.x, B.x1), B.x2), Math.min(Math.max(p.y, B.y1), B.y2)];
            const [x1, y1] = clamp(g.origin);
            const [x2, y2] = clamp(g.end);
            return [Math.min(x1, x2), Math.min(y1, y2), Math.abs(x2 - x1), Math.abs(y2 - y1)];
        }

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
                    this._syncPointer();
                }
            }
            if (g.kind === 'pan') {
                event.preventDefault();
                const geo = this._geometry();
                if (geo) this._panBy(event.clientX - g.lastX, event.clientY - g.lastY, geo);
                g.lastX = event.clientX;
                g.lastY = event.clientY;
                return;
            }
            if (g.kind === 'canvas') {
                // A drag across the empty canvas that does not move the view: the box it spans, for
                // a host's tool (e.g. a box to find an object in).
                g.end = this._toLocal(event.clientX, event.clientY);
                // Escape cancels it, when somebody is told of it. Otherwise Escape is not ours to take.
                g.live = this._has('canvasdrag') || this._has('canvasdragend');
                if (this._has('canvasdrag')) this._emit('canvasdrag', { box: this._spanned(g) });
                return;
            }
            if (g.kind === 'press') return;
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
                this._syncPointer();
                if (g.moved && event && !cancelled && g.button === 0) this._swallowClick();
                // The view was not allowed to settle while it was held.
                if (g.moved) this._viewChanged();
                return;
            }
            if (g.kind === 'canvas') {
                if (!g.moved && !cancelled) {
                    if (this.enabled) this.deselect();
                    this._emit('canvasclick', { position: this._toLocal(g.clientX, g.clientY) });
                } else if (g.moved && g.end) {
                    this._emit('canvasdragend', { box: this._spanned(g), cancelled });
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
            // Over something else the page put inside its viewport, the pointer is not over the editor.
            this.inside = this._onCanvas(event);
            if (!this.inside || this.gesture || !this._hears()) return;
            this.hoverEvent = { clientX: event.clientX, clientY: event.clientY, target: event.target };
            if (this.hoverFrame) return;
            this.hoverFrame = this._frame(() => {
                this.hoverFrame = 0;
                const last = this.hoverEvent;
                this.hoverEvent = null;
                if (!last) return;
                const hit = this._hit(last.target);
                const part = hit && hit.kind === 'part' ? hit : null;
                const m = this._matrix();
                this._remeasure(m);
                if (!this._has('hover')) return;
                this._emit('hover', {
                    position: this._toLocal(last.clientX, last.clientY, m),
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
            // A disabled editor reports a drag across the empty canvas too, so Escape cancels it there as well.
            if (event.key === 'Escape' && this.gesture && this.gesture.kind === 'canvas' && this.gesture.live) {
                event.preventDefault();
                this._finishGesture(true);
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
        'setPreview',
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
