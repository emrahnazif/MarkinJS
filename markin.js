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

    const EVENTS = ['change', 'select', 'deselect', 'dragstart', 'drag', 'dragend', 'hover', 'canvasclick'];
    const PARTS = ['bbox', 'polygon', 'keypoint'];
    const ARROWS = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };

    const DRAG_THRESHOLD = 3; // screen px a press must travel before it becomes a drag
    const HANDLE_SLOP = 6; // extra screen px of grab area around a handle
    const NUDGE_COMMIT_MS = 800; // idle time after which a run of arrow-key nudges becomes one undo step

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
        zoom: 'removed: sizes now follow the on-screen scale automatically',
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
        stage.style.cssText = 'position:relative';
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

        const sync = () => {
            const nw = image.naturalWidth;
            const nh = image.naturalHeight;
            const loaded = nw > 0 && nh > 0;
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
            onChange();
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
            const teardown = () => {
                [marked.style.transform, marked.style.transformOrigin, viewport.style.overflow] = saved;
            };
            return { container: viewport, stage: marked, teardown };
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
            this.host = target.localName === 'img' ? mountOverImage(target, () => this.refresh(), warn) : null;
            this.svg = this.host ? this.host.svg : target;
            // What zoom and pan work on. An <svg> that could not be given a viewport has no view.
            this.frame = this.host || mountAroundSvg(target, warn);
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
            this.history = { states: [[]], index: 0 };
            this.nudged = null; // id with arrow-key moves that are not committed yet
            this.nudgeTimer = 0;
            this.hoverFrame = 0;
            this.hoverEvent = null;
            this.wheelFrame = 0;
            this.wheelTimers = [];
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
                on(svg, 'pointermove', '_onHover'),
                on(svg, 'wheel', '_onWheel', { passive: true }),
                on(svg, 'touchstart', '_onTouchStart', { passive: true }),
                weakListen(this.doc, 'keydown', this, '_onKeyDown'),
                weakListen(this.doc, 'keyup', this, '_onKeyUp'),
                weakListen(this.win, 'resize', this, '_onResize')
            ];
            // Over an image, the overlay is resized by the image's own observer, which also refreshes
            // the editor. A second observer here would only chase the first one.
            const Observer = this.win.ResizeObserver;
            if (!this.host && typeof Observer === 'function') {
                const observer = new Observer(() => this.refresh());
                observer.observe(svg);
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
            this._settle();
            this.dead = true;
            this.enabled = false;
            for (const stop of this.cleanup) stop();
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
            const px = (name) => (style && parseFloat(style[name])) || 0;
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
                f: rect.top + (top + oy) * ky
            };
        }

        _toLocal(clientX, clientY) {
            const m = this._matrix();
            if (!m) return { x: clientX, y: clientY };
            const det = m.a * m.d - m.b * m.c;
            const x = clientX - m.e;
            const y = clientY - m.f;
            return { x: (m.d * x - m.c * y) / det, y: (m.a * y - m.b * x) / det };
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

        refresh() {
            if (!this.dead && this._measure()) this._rescale();
        }

        _onResize() {
            if (this.host) this.host.sync();
            else this.refresh();
        }

        // A wheel over the canvas usually means the host is zooming, often with an animation.
        _onWheel() {
            if (!this.wheelFrame) {
                this.wheelFrame = this._frame(() => {
                    this.wheelFrame = 0;
                    this.refresh();
                });
            }
            for (const timer of this.wheelTimers) clearTimeout(timer);
            this.wheelTimers = [this._later(() => this.refresh(), 150), this._later(() => this.refresh(), 400)];
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
            if (this.gesture) this._finishGesture(true);
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
            if (this.host) this.svg.style.pointerEvents = '';
            this.svg.style.touchAction = 'none';
            this.refresh();
        }

        // Stop reacting to pointer and keyboard. Pointer events pass through to whatever is below.
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
            if (!this.enabled) return;
            claimKeyboard(this, true);
            if (event.isPrimary === false || event.button !== 0) return;
            if (this.gesture) {
                if (this.gesture.pointerId !== event.pointerId) return; // a second finger
                // The same pointer cannot go down twice, so the earlier release was missed.
                this._finishGesture(!this.gesture.live);
            }
            // Resolve the target first: the calls below may redraw the handles.
            const hit = this._hit(event.target);
            this._flushNudge();
            this.refresh();
            if (!this.enabled) return; // a change listener may have run

            const gesture = {
                kind: 'canvas',
                pointerId: event.pointerId,
                clientX: event.clientX,
                clientY: event.clientY,
                moved: false,
                live: false
            };
            if (hit) {
                // The press is ours: keep the page, and any pan/zoom library around us, out of it.
                event.preventDefault();
                event.stopPropagation();
                this._takeFocus();
                const target = this._pressTarget(hit, this._toLocal(event.clientX, event.clientY));
                if (!target) return;
                Object.assign(gesture, target);
                try {
                    this.svg.setPointerCapture(event.pointerId);
                    gesture.captured = true;
                } catch {
                    // Without capture the window listeners below still follow the pointer.
                }
            }
            this.gesture = gesture;
            // The rest of the press is followed on window, wherever the pointer goes.
            gesture.stops = [
                listen(this.win, 'pointermove', (e) => this._onGestureMove(e), true),
                listen(this.win, 'pointerup', (e) => this._onGestureEnd(e, false), true),
                listen(this.win, 'pointercancel', (e) => this._onGestureEnd(e, true), true)
            ];
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
            // A mouse move without the left button means the release happened where we could not see it.
            if (event.pointerType === 'mouse' && (event.buttons & 1) === 0) {
                this._finishGesture(false);
                return;
            }
            if (!g.moved) {
                if (Math.hypot(event.clientX - g.clientX, event.clientY - g.clientY) < DRAG_THRESHOLD) return;
                g.moved = true;
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
                    this.svg.releasePointerCapture(g.pointerId);
                } catch {
                    // Already released.
                }
            }
            if (g.kind === 'canvas') {
                if (!g.moved && !cancelled) {
                    this.deselect();
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
            if (!this.enabled || this.gesture) return;
            this.hoverEvent = { clientX: event.clientX, clientY: event.clientY, target: event.target };
            if (this.hoverFrame) return;
            this.hoverFrame = this._frame(() => {
                this.hoverFrame = 0;
                const last = this.hoverEvent;
                this.hoverEvent = null;
                if (!last) return;
                const hit = this._hit(last.target);
                const part = hit && hit.kind === 'part' ? hit : null;
                this.refresh();
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
            if (!this.enabled || !this.opts.keyboardControls || keyboardOwner() !== this) return;
            if (event.defaultPrevented || event.isComposing) return;
            if (typeof event.key !== 'string' || isTypingTarget(event)) return;

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
            if (typeof event.key === 'string' && own(ARROWS, event.key)) this._flushNudge();
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
