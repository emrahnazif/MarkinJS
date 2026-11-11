import { afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const repoFile = (name) => readFileSync(resolve(root, name), 'utf-8');

// markin.js is a classic script with one global. Evaluate it the way a <script> tag would.
export const MarkinJS = new Function(`${repoFile('markin.js')}\nreturn MarkinJS;`)();

// jsdom has no PointerEvent. The library only needs the event types and these three fields.
if (typeof window.PointerEvent !== 'function') {
    class PointerEvent extends MouseEvent {
        constructor(type, init = {}) {
            super(type, init);
            this.pointerId = init.pointerId ?? 1;
            this.pointerType = init.pointerType ?? 'mouse';
            this.isPrimary = init.isPrimary ?? true;
        }
    }
    window.PointerEvent = PointerEvent;
    globalThis.PointerEvent = PointerEvent;
}

// jsdom reports that the document never has focus and does not implement window.focus().
// Count the calls instead, so a test can check when the editor asks for focus.
export const focusCalls = { count: 0 };
window.focus = () => {
    focusCalls.count++;
};

export const SVG_NS = 'http://www.w3.org/2000/svg';

// The fixtures most tests start from.
export const BOX = { id: 'A', class_id: 1, bbox: [100, 100, 200, 100] };
export const OTHER = { id: 'B', bbox: [400, 300, 100, 100] };
// A 1600 x 1200 image shown at 800 x 600, 20px from the top-left of the page: at rest one image
// pixel is half a pixel on screen, and the view is the whole image.
export const HALF = { viewBox: '0 0 1600 1200', box: { left: 20, top: 20, width: 800, height: 600 } };
export const WHOLE = { x: 0, y: 0, width: 1600, height: 1200, scale: 0.5 };

// jsdom does no layout, so the tests supply it. A test gives an element its box with setBox(); the
// viewport and stage the library builds around an image, and the image itself, take the box of
// the <svg> laid over it. From there the page is modelled as a browser would lay it out: an <svg>
// the library gives a place and a size in pixels lies there inside its parent, and a CSS transform
// on an element moves and scales its box and those of everything inside it.
const boxes = new WeakMap();
const NO_BOX = { left: 0, top: 0, width: 0, height: 0, x: 0, y: 0, right: 0, bottom: 0 };
const pixels = (value) => (/px$/.test(value || '') ? parseFloat(value) : null);

function ownBox(el) {
    if (el.localName === 'svg' && el.parentNode && el.parentNode.nodeType === 1) {
        // Placed and sized in pixels: that is where it lies, counted from the corner of its parent.
        const [left, top, width, height] = ['left', 'top', 'width', 'height'].map((side) => pixels(el.style[side]));
        const placed = left !== null && top !== null && width !== null && height !== null;
        const parent = placed ? ownBox(el.parentNode) : null;
        if (parent) return { left: parent.left + left, top: parent.top + top, width, height };
    }
    if (boxes.has(el)) return boxes.get(el);
    const wrapper = el.closest ? el.closest('.markin-container') : null;
    if (wrapper && (el === wrapper || el.classList.contains('markin-stage') || el.localName === 'img')) {
        const svg = wrapper.querySelector('svg');
        return (svg && boxes.get(svg)) || null;
    }
    return null;
}

function transformOf(el) {
    const text = (el.style && el.style.transform) || '';
    const found = /translate\(\s*([-\d.e+]+)px,\s*([-\d.e+]+)px\)\s*scale\(\s*([-\d.e+]+)\s*\)/.exec(text);
    if (!found) return null;
    // CSS scales about the middle of an element unless transform-origin says otherwise.
    const corner = /^0(px)?\s+0(px)?$/.test((el.style.transformOrigin || '').trim());
    return { x: Number(found[1]), y: Number(found[2]), scale: Number(found[3]), about: corner ? 0 : 0.5 };
}

function layoutRect() {
    const box = ownBox(this);
    if (!box) return NO_BOX;
    let { left, top, width, height } = box;
    for (let el = this; el && el.nodeType === 1; el = el.parentNode) {
        const t = transformOf(el);
        const box = t && ownBox(el);
        if (!box) continue;
        const ox = box.left + box.width * t.about;
        const oy = box.top + box.height * t.about;
        left = ox + t.x + (left - ox) * t.scale;
        top = oy + t.y + (top - oy) * t.scale;
        width *= t.scale;
        height *= t.scale;
    }
    return { left, top, width, height, x: left, y: top, right: left + width, bottom: top + height };
}
window.Element.prototype.getBoundingClientRect = layoutRect;

// jsdom has no getScreenCTM() either. This stand-in maps the viewBox onto the box the <svg> has
// on screen, as Chrome and Firefox do.
function screenCTM() {
    const rect = this.getBoundingClientRect();
    if (!(rect.width > 0 && rect.height > 0)) return null;
    const vb = this.viewBox.baseVal;
    if (!(vb && vb.width > 0 && vb.height > 0)) return { a: 1, b: 0, c: 0, d: 1, e: rect.left, f: rect.top };
    let sx = rect.width / vb.width;
    let sy = rect.height / vb.height;
    let ox = 0;
    let oy = 0;
    if ((this.getAttribute('preserveAspectRatio') || '').trim() !== 'none') {
        const s = Math.min(sx, sy);
        ox = (rect.width - vb.width * s) / 2;
        oy = (rect.height - vb.height * s) / 2;
        sx = s;
        sy = s;
    }
    return { a: sx, b: 0, c: 0, d: sy, e: rect.left + ox - vb.x * sx, f: rect.top + oy - vb.y * sy };
}
window.SVGSVGElement.prototype.getScreenCTM = screenCTM;

// jsdom knows nothing of the size or position CSS gives an element either. A test says what the
// computed style of one element is, until the test ends.
const styles = new Map();
const computedStyle = window.getComputedStyle;
window.getComputedStyle = (el, ...rest) => styles.get(el) || computedStyle.call(window, el, ...rest);
export function setStyle(el, style) {
    styles.set(el, style);
}

// An <svg> in the page. The on-screen box is supplied here: by default one viewBox unit is one
// screen pixel, starting at the top-left of the viewport.
export function makeSvg({
    viewBox = '0 0 800 600',
    box = { left: 0, top: 0, width: 800, height: 600 },
    style = null
} = {}) {
    const svg = document.createElementNS(SVG_NS, 'svg');
    if (viewBox) svg.setAttribute('viewBox', viewBox);
    if (box) setBox(svg, box);
    if (style) setStyle(svg, style);
    document.body.appendChild(svg);
    return svg;
}

// An <svg> that the page positioned over something else: the library leaves it where it is, and
// its editor has no viewport.
export const LAID_OVER = { style: { position: 'absolute' } };

// An <img> in the page, between two other elements, whose natural size can be changed as when
// `src` is swapped for the next image: load(width, height).
export function makeImage({ width = 1280, height = 853 } = {}) {
    const holder = document.createElement('div');
    holder.id = 'holder';
    const before = document.createElement('span');
    const image = document.createElement('img');
    const after = document.createElement('span');
    image.id = 'photo';
    const size = { width, height };
    Object.defineProperty(image, 'naturalWidth', { get: () => size.width });
    Object.defineProperty(image, 'naturalHeight', { get: () => size.height });
    holder.append(before, image, after);
    document.body.appendChild(holder);
    const load = (w, h) => {
        size.width = w;
        size.height = h;
        image.dispatchEvent(new Event('load'));
    };
    return { holder, image, before, after, load };
}

// The page's own markup around an <svg>: a <section>, which is the viewport, holding a stage the
// page marked, and whatever `extra` the page puts next to it. In the stage are the picture, an
// <img>, and the <svg> over it. `viewport`, `stage` and `picture` are their boxes on screen; the
// stage is as large as the picture unless it is given a box of its own.
export function makeStage({
    viewBox = '0 0 800 600',
    viewport,
    picture,
    stage: around = picture,
    extra = '',
    prepare,
    options
} = {}) {
    const section = document.createElement('section');
    section.innerHTML = `<div data-markin-stage><img alt=""><svg viewBox="${viewBox}"></svg></div>${extra}`;
    const stage = section.firstChild;
    const [image, svg] = stage.children;
    if (prepare) prepare(section, stage, image);
    document.body.appendChild(section);
    setBox(section, viewport);
    setBox(stage, around);
    for (const el of [image, svg]) setBox(el, picture);
    const editor = track(MarkinJS.create(svg, { silent: true, ...options }));
    return { editor, viewport: section, stage, image, svg };
}

// The stage inside the viewport of an editor: what holds the picture and the <svg> over it.
export const stageOf = (editor) => editor.getContainerElement().firstChild;
// The window onto the image: the viewport around a picture, or else the <svg> itself.
export const windowOf = (editor) => editor.getContainerElement() || editor.getSVGElement();

// Give an element its box on screen, before any zoom.
export function setBox(el, { left = 0, top = 0, width, height }) {
    boxes.set(el, { left, top, width, height });
    // An element of another document has prototypes of its own.
    el.getBoundingClientRect = layoutRect;
    if (el.localName === 'svg') el.getScreenCTM = screenCTM;
}

const editors = [];

// Create an editor that the test harness destroys afterwards. Problems are collected in `log`.
export function makeEditor(options = {}, svgOptions) {
    const svg = svgOptions instanceof Element ? svgOptions : makeSvg(svgOptions);
    const log = [];
    const editor = MarkinJS.create(svg, { logger: (level, message) => log.push(`${level}: ${message}`), ...options });
    editors.push(editor);
    return { editor, svg, log };
}

export function track(editor) {
    editors.push(editor);
    return editor;
}

export function cleanup() {
    while (editors.length) editors.pop().destroy();
    document.body.innerHTML = '';
    styles.clear();
}
afterEach(cleanup);

// Where an image point is on screen, worked out from the layout above and not by the library.
export function screenOf(svg, x, y) {
    const m = svg.getScreenCTM();
    return [m.a * x + m.e, m.d * y + m.f];
}

// ---- pointer

export function pointer(type, target, x, y, init = {}) {
    const event = new PointerEvent(type, {
        bubbles: true,
        cancelable: true,
        composed: true,
        clientX: x,
        clientY: y,
        button: 0,
        buttons: type === 'pointerup' || type === 'pointercancel' ? 0 : 1,
        pointerId: 1,
        pointerType: 'mouse',
        isPrimary: true,
        ...init
    });
    target.dispatchEvent(event);
    return event;
}

export const press = (target, x, y, init) => pointer('pointerdown', target, x, y, init);
// Once a press is in progress the library follows the pointer on window, wherever it goes.
export const move = (x, y, init) => pointer('pointermove', window, x, y, init);
export const release = (x, y, init) => pointer('pointerup', window, x, y, init);

export function click(target, x, y, init) {
    press(target, x, y, init);
    release(x, y, init);
}

export function drag(target, from, to, init) {
    press(target, from[0], from[1], init);
    move((from[0] + to[0]) / 2, (from[1] + to[1]) / 2, init);
    move(to[0], to[1], init);
    release(to[0], to[1], init);
}

// ---- wheel

export function wheel(target, x, y, init = {}) {
    const event = new WheelEvent('wheel', {
        bubbles: true,
        cancelable: true,
        composed: true,
        clientX: x,
        clientY: y,
        deltaX: 0,
        deltaY: 0,
        deltaMode: 0,
        ...init
    });
    target.dispatchEvent(event);
    return event;
}

// A trackpad pinch as WebKit reports it: gesturestart, gesturechange and gestureend, with the
// distance between the fingers as a `scale` that starts at 1. jsdom has no GestureEvent.
export function gesture(type, target, x, y, scale) {
    const event = new Event(type, { bubbles: true, cancelable: true, composed: true });
    Object.assign(event, { clientX: x, clientY: y, scale });
    target.dispatchEvent(event);
    return event;
}

// ---- keyboard

export function key(name, init = {}, target = document.body) {
    const event = new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true, composed: true, ...init });
    target.dispatchEvent(event);
    return event;
}

export function keyUp(name, target = document.body) {
    target.dispatchEvent(new KeyboardEvent('keyup', { key: name, bubbles: true, composed: true }));
}

// ---- what the library drew

const group = (id) => `.markin-layer [data-markin-id="${id}"]`;
export const bboxEl = (svg, id) => svg.querySelector(`${group(id)} [data-markin-part="bbox"]`);
export const polygonEl = (svg, id) => svg.querySelector(`${group(id)} [data-markin-part="polygon"]`);
export const keypointEl = (svg, id, index) =>
    svg.querySelector(`${group(id)} [data-markin-part="keypoint"][data-index="${index}"]`);
export const handleEl = (svg, name, index) =>
    svg.querySelector(
        index === undefined
            ? `.markin-ui [data-markin-handle="${name}"]`
            : `.markin-ui [data-markin-handle="${name}"][data-index="${index}"]`
    );
export const handles = (svg) => Array.from(svg.querySelectorAll('.markin-ui [data-markin-handle]'));
export const num = (el, name) => parseFloat(el.getAttribute(name));
export const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export const nextFrame = () => wait(40);
