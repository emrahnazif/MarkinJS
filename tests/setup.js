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

// jsdom does no layout and has no getScreenCTM(), which is how the library measures the SVG.
// This stand-in maps the viewBox onto the box a test supplied with setBox(), as a browser would.
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

export function setBox(svg, { left = 0, top = 0, width, height }) {
    svg.getScreenCTM = screenCTM; // also for an <svg> of another document, which has its own prototype
    svg.getBoundingClientRect = () => ({
        left,
        top,
        width,
        height,
        x: left,
        y: top,
        right: left + width,
        bottom: top + height
    });
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
