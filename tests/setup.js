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

// jsdom does no layout, so the tests supply it. A test gives an element its box with setBox();
// the viewport and stage the library builds around an <svg> take the box of that <svg>. A CSS
// transform the library writes on an element (translate and scale about its top-left corner)
// moves the boxes of everything inside it, as it would in a browser.
const boxes = new WeakMap();
const NO_BOX = { left: 0, top: 0, width: 0, height: 0, x: 0, y: 0, right: 0, bottom: 0 };

function ownBox(el) {
    if (boxes.has(el)) return boxes.get(el);
    if (el.classList && (el.classList.contains('markin-container') || el.classList.contains('markin-stage'))) {
        const svg = el.querySelector('svg');
        return (svg && boxes.get(svg)) || null;
    }
    return null;
}

function transformOf(el) {
    const text = (el.style && el.style.transform) || '';
    const found = /translate\(\s*([-\d.e+]+)px,\s*([-\d.e+]+)px\)\s*scale\(\s*([-\d.e+]+)\s*\)/.exec(text);
    return found ? { x: Number(found[1]), y: Number(found[2]), scale: Number(found[3]) } : null;
}

function layoutRect() {
    const box = ownBox(this);
    if (!box) return NO_BOX;
    let { left, top, width, height } = box;
    for (let el = this; el && el.nodeType === 1; el = el.parentNode) {
        const t = transformOf(el);
        const origin = t && ownBox(el);
        if (!origin) continue;
        left = origin.left + t.x + (left - origin.left) * t.scale;
        top = origin.top + t.y + (top - origin.top) * t.scale;
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

// An <svg> in the page. The on-screen box is supplied here: by default one viewBox unit is one
// screen pixel, starting at the top-left of the viewport.
export function makeSvg({ viewBox = '0 0 800 600', box = { left: 0, top: 0, width: 800, height: 600 } } = {}) {
    const svg = document.createElementNS(SVG_NS, 'svg');
    if (viewBox) svg.setAttribute('viewBox', viewBox);
    if (box) setBox(svg, box);
    document.body.appendChild(svg);
    return svg;
}

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
export const nextFrame = () => new Promise((resolve) => setTimeout(resolve, 40));
