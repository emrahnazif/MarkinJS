import { describe, it, expect, vi, afterEach } from 'vitest';
import {
    MarkinJS,
    makeEditor,
    track,
    setBox,
    screenOf,
    wheel,
    gesture,
    press,
    move,
    release,
    bboxEl,
    SVG_NS
} from './setup.js';

// A 1600 x 1200 image shown at 800 x 600, 20px from the top-left of the page.
const HALF = { viewBox: '0 0 1600 1200', box: { left: 20, top: 20, width: 800, height: 600 } };
const WHOLE = { x: 0, y: 0, width: 1600, height: 1200, scale: 0.5 };

// A clock the test moves by hand: the library tells one wheel movement from the next by the time between events.
let now = 1000;
const later = (ms) => {
    now += ms;
};
function clocked(options, svgOptions = HALF) {
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    return makeEditor(options, svgOptions);
}
afterEach(() => {
    vi.restoreAllMocks();
    later(10000);
});

const near = (point, x, y) => {
    expect(point.x).toBeCloseTo(x, 2);
    expect(point.y).toBeCloseTo(y, 2);
};

describe('pinch and Ctrl / Cmd + wheel', () => {
    it('zoom towards the pointer: what is under it stays under it', () => {
        const { editor, svg } = clocked();
        for (const [x, y] of [
            [220, 170],
            [420, 320],
            [800, 600]
        ]) {
            editor.fit();
            later(1000);
            const under = editor.toImage(x, y);
            for (let i = 0; i < 8; i++) {
                const event = wheel(svg, x, y, { deltaY: -12, ctrlKey: true });
                expect(event.defaultPrevented).toBe(true);
                near(editor.toImage(x, y), under.x, under.y);
            }
            expect(editor.getView().scale).toBeGreaterThan(1);
            for (let i = 0; i < 4; i++) wheel(svg, x, y, { deltaY: 12, metaKey: true });
            near(editor.toImage(x, y), under.x, under.y);
        }
    });

    it('zoom by an amount that follows the fingers, and never leap', () => {
        const { editor, svg } = clocked();
        // A pinch reports small steps: 5 is a factor of 2^0.1.
        wheel(svg, 420, 320, { deltaY: -5, ctrlKey: true });
        expect(editor.getView().scale).toBeCloseTo(0.5 * Math.pow(2, 0.1), 5);
        // A notch of a real wheel with Ctrl held is 100: it is held back.
        editor.fit();
        wheel(svg, 420, 320, { deltaY: -100, ctrlKey: true });
        expect(editor.getView().scale).toBeCloseTo(0.5 * Math.pow(2, 0.35), 5);
        // Cmd + wheel is an ordinary wheel: a notch is 15%.
        editor.fit();
        wheel(svg, 420, 320, { deltaY: -100, metaKey: true });
        expect(editor.getView().scale).toBeCloseTo(0.5 * Math.pow(2, 0.2), 5);
    });

    it('are taken even where the view cannot go further, so the browser never zooms the page', () => {
        const { editor, svg } = clocked();
        const out = wheel(svg, 420, 320, { deltaY: 10, ctrlKey: true });
        expect(out.defaultPrevented).toBe(true);
        expect(editor.getView()).toEqual(WHOLE);

        editor.zoomBy(1e6);
        later(1000);
        const closest = editor.getView();
        const inward = wheel(svg, 420, 320, { deltaY: -10, ctrlKey: true });
        expect(inward.defaultPrevented).toBe(true);
        expect(editor.getView()).toEqual(closest);
    });

    it('keep a shape that is being dragged under the pointer', () => {
        const { editor, svg } = clocked({ annotations: [{ id: 'box', bbox: [700, 500, 200, 200] }] });
        editor.select('box');
        const [x, y] = screenOf(svg, 800, 600);
        press(bboxEl(svg, 'box'), x, y);
        move(x + 40, y + 20);
        expect(editor.getAnnotation('box').bbox).toEqual([780, 540, 200, 200]);
        for (let i = 0; i < 5; i++) wheel(svg, x + 40, y + 20, { deltaY: -15, ctrlKey: true });
        // The pointer has not moved, and neither has what it holds.
        move(x + 40, y + 20);
        const held = editor.getAnnotation('box').bbox;
        expect(held[0]).toBeCloseTo(780, 2);
        expect(held[1]).toBeCloseTo(540, 2);
        release(x + 40, y + 20);
    });
});

describe('a trackpad pinch in WebKit', () => {
    it('zooms towards the pointer by as much as the fingers moved apart', () => {
        const { editor, svg } = clocked();
        const under = editor.toImage(220, 170);
        expect(gesture('gesturestart', svg, 220, 170, 1).defaultPrevented).toBe(true);
        for (const scale of [1.2, 1.9, 3, 2.5]) {
            expect(gesture('gesturechange', svg, 220, 170, scale).defaultPrevented).toBe(true);
            // The scale counts from where the pinch began, not from the event before.
            expect(editor.getView().scale).toBeCloseTo(0.5 * scale, 5);
            near(editor.toImage(220, 170), under.x, under.y);
        }
        expect(gesture('gestureend', svg, 220, 170, 2.5).defaultPrevented).toBe(true);

        // The next pinch starts from the view as it is now.
        gesture('gesturestart', svg, 220, 170, 1);
        gesture('gesturechange', svg, 220, 170, 2);
        expect(editor.getView().scale).toBeCloseTo(2.5, 5);
        gesture('gestureend', svg, 220, 170, 2);
    });

    it('stops at the limits and is still taken there', () => {
        const { editor, svg } = clocked({ maxScale: 4 });
        gesture('gesturestart', svg, 420, 320, 1);
        expect(gesture('gesturechange', svg, 420, 320, 0.3).defaultPrevented).toBe(true);
        expect(editor.getView()).toEqual(WHOLE);
        gesture('gesturechange', svg, 420, 320, 500);
        expect(editor.getView().scale).toBe(4);
        gesture('gestureend', svg, 420, 320, 500);
    });

    it('copes with a pinch whose start was not seen, or that carries no position', () => {
        const { editor, svg } = clocked();
        const event = new Event('gesturechange', { bubbles: true, cancelable: true });
        event.scale = 2;
        svg.dispatchEvent(event);
        expect(editor.getView().scale).toBe(1);
        const broken = new Event('gesturechange', { bubbles: true, cancelable: true });
        expect(() => svg.dispatchEvent(broken)).not.toThrow();
        expect(editor.getView().scale).toBe(1);
    });

    it('is left alone with zoomControls: false', () => {
        const { editor, svg } = clocked({ zoomControls: false });
        expect(gesture('gesturestart', svg, 420, 320, 1).defaultPrevented).toBe(false);
        expect(gesture('gesturechange', svg, 420, 320, 2).defaultPrevented).toBe(false);
        expect(editor.getView()).toEqual(WHOLE);
    });
});

describe('a plain wheel', () => {
    it('moves the view when there is somewhere to go', () => {
        const { editor, svg } = clocked();
        editor.zoomBy(4);
        expect(editor.getView()).toEqual({ x: 600, y: 450, width: 400, height: 300, scale: 2 });

        // 40px down the page is 20 image pixels at this zoom.
        const down = wheel(svg, 420, 320, { deltaY: 40 });
        expect(down.defaultPrevented).toBe(true);
        expect(editor.getView()).toEqual({ x: 600, y: 470, width: 400, height: 300, scale: 2 });
        wheel(svg, 420, 320, { deltaX: -60, deltaY: -40 });
        expect(editor.getView()).toEqual({ x: 570, y: 450, width: 400, height: 300, scale: 2 });
    });

    it('goes sideways with Shift, and counts lines when the wheel reports lines', () => {
        const { editor, svg } = clocked();
        editor.zoomBy(4);
        wheel(svg, 420, 320, { deltaY: 40, shiftKey: true });
        expect(editor.getView()).toEqual({ x: 620, y: 450, width: 400, height: 300, scale: 2 });
        // Three lines are a notch: 99px, or 49.5 image pixels.
        wheel(svg, 420, 320, { deltaY: 3, deltaMode: 1 });
        expect(editor.getView()).toEqual({ x: 620, y: 499, width: 400, height: 301, scale: 2 });
    });

    it('is left to the page when the view is at rest', () => {
        const { editor, svg } = clocked();
        for (const delta of [{ deltaY: 100 }, { deltaY: -100 }, { deltaX: 50 }]) {
            later(1000);
            expect(wheel(svg, 420, 320, delta).defaultPrevented).toBe(false);
        }
        expect(editor.getView()).toEqual(WHOLE);
    });

    it('belongs to the page or to the view for the whole of one movement', () => {
        const { editor, svg } = clocked();
        // The bottom right corner of the image, as far as the view goes.
        editor.zoomBy(4, { x: 1600, y: 1200 });
        wheel(svg, 420, 320, { deltaY: 500 });
        const corner = editor.getView();

        // A scroll that starts where the view cannot follow is the page's, also when it turns back.
        later(1000);
        expect(wheel(svg, 420, 320, { deltaY: 50 }).defaultPrevented).toBe(false);
        later(50);
        expect(wheel(svg, 420, 320, { deltaY: -50 }).defaultPrevented).toBe(false);
        expect(editor.getView()).toEqual(corner);

        // A scroll that starts by moving the view stays the view's when it reaches the edge.
        later(1000);
        expect(wheel(svg, 420, 320, { deltaY: -50 }).defaultPrevented).toBe(true);
        later(50);
        expect(wheel(svg, 420, 320, { deltaY: 5000 }).defaultPrevented).toBe(true);
        later(50);
        expect(wheel(svg, 420, 320, { deltaY: 50 }).defaultPrevented).toBe(true);
        expect(editor.getView()).toEqual(corner);
    });

    it('zooms towards the pointer with wheel: "zoom"', () => {
        const { editor, svg } = clocked({ wheel: 'zoom' });
        const under = editor.toImage(220, 170);
        const event = wheel(svg, 220, 170, { deltaY: -100 });
        expect(event.defaultPrevented).toBe(true);
        expect(editor.getView().scale).toBeCloseTo(0.5 * Math.pow(2, 0.2), 5);
        near(editor.toImage(220, 170), under.x, under.y);

        // Scrolling out of a view that is already whole is the page's.
        editor.fit();
        later(1000);
        expect(wheel(svg, 220, 170, { deltaY: 100 }).defaultPrevented).toBe(false);
        expect(editor.getView()).toEqual(WHOLE);
    });

    it('can change its meaning while the editor runs', () => {
        const { editor, svg, log } = clocked();
        editor.setOptions({ wheel: 'zoom' });
        wheel(svg, 420, 320, { deltaY: -100 });
        expect(editor.getView().scale).toBeGreaterThan(0.5);
        editor.setOptions({ wheel: 'spin' });
        expect(log).toEqual(['error: option "wheel" must be "pan" or "zoom"']);
        expect(editor.getOptions().wheel).toBe('zoom');
    });
});

describe('zoomControls: false', () => {
    it('leaves the wheel and the pinch alone, and the methods still work', () => {
        const { editor, svg } = clocked({ zoomControls: false });
        expect(wheel(svg, 420, 320, { deltaY: -10, ctrlKey: true }).defaultPrevented).toBe(false);
        expect(editor.getView()).toEqual(WHOLE);
        editor.zoomBy(4);
        later(1000);
        expect(wheel(svg, 420, 320, { deltaY: 40 }).defaultPrevented).toBe(false);
        expect(editor.getView()).toEqual({ x: 600, y: 450, width: 400, height: 300, scale: 2 });

        editor.setOptions({ zoomControls: true });
        later(1000);
        expect(wheel(svg, 420, 320, { deltaY: 40 }).defaultPrevented).toBe(true);
        expect(editor.getView().y).toBe(470);
    });

    it('also keeps quiet about an <svg> that could not be given a viewport', () => {
        const real = window.getComputedStyle;
        try {
            const make = (options) => {
                const svg = document.createElementNS(SVG_NS, 'svg');
                document.body.appendChild(svg);
                setBox(svg, HALF.box);
                window.getComputedStyle = (el) => (el === svg ? { position: 'absolute' } : real(el));
                const log = [];
                const editor = track(
                    MarkinJS.create(svg, { logger: (level, message) => log.push(message), ...options })
                );
                return { editor, svg, log };
            };
            expect(make({ zoomControls: false }).log).toEqual([]);
            const loud = make({});
            expect(loud.log.length).toBe(1);
            // Nothing to zoom: the wheel is the page's.
            expect(wheel(loud.svg, 420, 320, { deltaY: -10, ctrlKey: true }).defaultPrevented).toBe(false);
        } finally {
            window.getComputedStyle = real;
        }
    });
});
