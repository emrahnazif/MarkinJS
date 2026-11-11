import { describe, it, expect, vi, afterEach } from 'vitest';
import {
    MarkinJS,
    makeEditor,
    makeImage,
    track,
    setBox,
    screenOf,
    wheel,
    gesture,
    pointer,
    press,
    move,
    release,
    click,
    key,
    keyUp,
    bboxEl,
    handleEl,
    wait,
    nextFrame,
    BOX,
    HALF,
    WHOLE,
    LAID_OVER
} from './setup.js';

// A box in the middle of the image.
const THING = { id: 'box', bbox: [700, 500, 200, 200] };

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
        const { editor, svg } = clocked({ annotations: [THING] });
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
        expect(clocked({ zoomControls: false }, LAID_OVER).log).toEqual([]);
        const loud = clocked({}, LAID_OVER);
        expect(loud.log.length).toBe(1);
        // Nothing to zoom: the wheel is the page's.
        expect(wheel(loud.svg, 420, 320, { deltaY: -10, ctrlKey: true }).defaultPrevented).toBe(false);
    });
});

describe('dragging the view', () => {
    const ZOOMED = { x: 600, y: 450, width: 400, height: 300, scale: 2 };
    // The editor zoomed in 4x on the box.
    function zoomed(options) {
        const made = clocked({ annotations: [THING], settleDelay: 30, ...options });
        made.editor.zoomBy(4);
        expect(made.editor.getView()).toEqual(ZOOMED);
        // Everything the host could hear about a selection or an edit.
        made.heard = [];
        for (const type of ['change', 'select', 'deselect', 'dragstart', 'drag', 'dragend', 'canvasclick']) {
            made.editor.on(type, () => made.heard.push(type));
        }
        return made;
    }
    // The window onto the image: the viewport around an image, or else the <svg> itself.
    const viewport = (editor) => editor.getContainerElement() || editor.getSVGElement();
    // Hold Space with the pointer over the editor.
    const holdSpace = (svg) => {
        pointer('pointermove', svg, 100, 100, { buttons: 0 });
        return key(' ', { code: 'Space' });
    };
    const MIDDLE = { button: 1, buttons: 4 };

    describe('from empty canvas', () => {
        it('moves the view with the pointer', () => {
            const { editor, svg, heard } = zoomed();
            press(svg, 100, 100);
            const first = move(60, 80);
            expect(first.defaultPrevented).toBe(true);
            // 40px left and 20px up on screen: 20 and 10 image pixels further right and down.
            expect(editor.getView()).toEqual({ x: 620, y: 460, width: 400, height: 300, scale: 2 });
            move(0, 0);
            release(0, 0);
            expect(editor.getView()).toEqual({ x: 650, y: 500, width: 400, height: 300, scale: 2 });
            expect(heard).toEqual([]);
        });

        it('leaves a click a click', () => {
            const { editor, svg, heard } = zoomed();
            editor.select('box');
            heard.length = 0;
            press(svg, 100, 100);
            move(101, 101);
            release(101, 101);
            expect(heard).toEqual(['deselect', 'canvasclick']);
            expect(editor.getView()).toEqual(ZOOMED);
        });

        it("stops a handle's width past the edge of the image", () => {
            const { editor, svg } = zoomed();
            press(svg, 100, 100);
            move(5000, 5000);
            expect(svg.getAttribute('viewBox')).toBe('-6 -6 400 300');
            expect(editor.getView()).toEqual({ x: 0, y: 0, width: 394, height: 294, scale: 2 });
            // Coming back, the view follows at once.
            move(4990, 4990);
            expect(svg.getAttribute('viewBox')).toBe('-1 -1 400 300');
            release(4990, 4990);
        });

        it('does nothing while the whole image is in view', () => {
            const { editor, svg } = clocked({ annotations: [THING] });
            press(svg, 100, 100);
            const event = move(60, 80);
            release(60, 80);
            expect(event.defaultPrevented).toBe(false);
            expect(editor.getView()).toEqual(WHOLE);
            expect(viewport(editor).style.cursor).toBe('');
        });

        it('can be switched off with panOnEmpty: false', () => {
            const { editor, svg, heard } = zoomed({ panOnEmpty: false });
            press(svg, 100, 100);
            move(60, 80);
            release(60, 80);
            expect(editor.getView()).toEqual(ZOOMED);
            click(svg, 100, 100);
            expect(heard).toEqual(['canvasclick']);
        });
    });

    describe('from an annotation', () => {
        it('selects or moves the annotation, not the view', () => {
            const { editor, svg } = zoomed();
            const [x, y] = screenOf(svg, 800, 600);
            press(bboxEl(svg, 'box'), x, y);
            move(x + 40, y);
            release(x + 40, y);
            expect(editor.getSelection().id).toBe('box');
            expect(editor.getAnnotation('box')).toEqual(THING);

            press(bboxEl(svg, 'box'), x, y);
            move(x + 40, y);
            release(x + 40, y);
            expect(editor.getAnnotation('box').bbox).toEqual([720, 500, 200, 200]);
            expect(editor.getView()).toEqual(ZOOMED);
        });
    });

    describe('with Space held', () => {
        it('moves the view from anywhere, and touches nothing', () => {
            const { editor, svg, heard } = zoomed();
            editor.select('box');
            heard.length = 0;
            expect(holdSpace(svg).defaultPrevented).toBe(true);
            expect(viewport(editor).style.cursor).toBe('grab');

            const [x, y] = screenOf(svg, 800, 600);
            const down = press(handleEl(svg, 'se'), x, y);
            expect(down.defaultPrevented).toBe(true);
            move(x - 40, y - 20);
            expect(viewport(editor).style.cursor).toBe('grabbing');
            release(x - 40, y - 20);
            expect(editor.getView()).toEqual({ x: 620, y: 460, width: 400, height: 300, scale: 2 });
            expect(editor.getAnnotation('box')).toEqual(THING);
            expect(editor.getSelection().id).toBe('box');
            expect(heard).toEqual([]);

            keyUp(' ');
            expect(viewport(editor).style.cursor).toBe('');
            // And the annotation takes the pointer again.
            press(bboxEl(svg, 'box'), x, y);
            move(x + 40, y);
            release(x + 40, y);
            expect(editor.getAnnotation('box').bbox).toEqual([720, 500, 200, 200]);
        });

        it('shows the hand over the annotations too, by taking the pointer off them', () => {
            const { svg } = zoomed();
            const layer = svg.querySelector('.markin-layer');
            holdSpace(svg);
            expect(layer.style.pointerEvents).toBe('none');
            key(' ', { code: 'Space', repeat: true });
            expect(layer.style.pointerEvents).toBe('none');
            keyUp(' ');
            expect(layer.style.pointerEvents).toBe('');
        });

        it('only counts while the pointer is over the editor', () => {
            const { editor, svg } = zoomed();
            // The pointer has not been over it yet.
            expect(key(' ', { code: 'Space' }).defaultPrevented).toBe(false);
            pointer('pointermove', svg, 100, 100, { buttons: 0 });
            pointer('pointerleave', viewport(editor), 900, 900, { buttons: 0 });
            expect(key(' ', { code: 'Space' }).defaultPrevented).toBe(false);
            expect(viewport(editor).style.cursor).toBe('');
        });

        it('is left alone while the user types', () => {
            const { svg } = zoomed();
            const field = document.createElement('input');
            document.body.appendChild(field);
            pointer('pointermove', svg, 100, 100, { buttons: 0 });
            expect(key(' ', { code: 'Space' }, field).defaultPrevented).toBe(false);
        });

        for (const off of [{ keyboardControls: false }, { zoomControls: false }]) {
            it(`is left alone with ${Object.keys(off)[0]}: false`, () => {
                const { editor, svg } = zoomed(off);
                expect(holdSpace(svg).defaultPrevented).toBe(false);
                expect(viewport(editor).style.cursor).toBe('');
            });
        }

        it('is let go when the window loses focus', () => {
            const { editor, svg } = zoomed();
            holdSpace(svg);
            window.dispatchEvent(new Event('blur'));
            expect(viewport(editor).style.cursor).toBe('');
            const [x, y] = screenOf(svg, 800, 600);
            press(bboxEl(svg, 'box'), x, y);
            release(x, y);
            expect(editor.getSelection().id).toBe('box');
        });
    });

    describe('with the middle button', () => {
        it('moves the view from anywhere', () => {
            const { editor, svg, heard } = zoomed();
            const [x, y] = screenOf(svg, 800, 600);
            const down = press(bboxEl(svg, 'box'), x, y, MIDDLE);
            expect(down.defaultPrevented).toBe(true);
            move(x - 40, y - 20, MIDDLE);
            release(x - 40, y - 20, { button: 1 });
            expect(editor.getView()).toEqual({ x: 620, y: 460, width: 400, height: 300, scale: 2 });
            expect(editor.getSelection()).toBe(null);
            expect(heard).toEqual([]);
        });

        it('keeps the browser from scrolling or pasting with it', () => {
            const { svg } = zoomed();
            const mouse = (type, button) => {
                const event = new MouseEvent(type, { bubbles: true, cancelable: true, button });
                svg.dispatchEvent(event);
                return event.defaultPrevented;
            };
            expect(mouse('mousedown', 1)).toBe(true);
            expect(mouse('auxclick', 1)).toBe(true);
            expect(mouse('mousedown', 0)).toBe(false);
            expect(mouse('mousedown', 2)).toBe(false);
        });

        it('ends when the button was let go where the editor could not see it', () => {
            const { editor, svg } = zoomed();
            press(svg, 100, 100, MIDDLE);
            move(60, 80, MIDDLE);
            move(0, 0, { buttons: 0 });
            move(-100, -100, { buttons: 0 });
            expect(editor.getView()).toEqual({ x: 620, y: 460, width: 400, height: 300, scale: 2 });
        });
    });

    it('does not let the view settle while it is held', async () => {
        vi.restoreAllMocks();
        const { editor, svg } = zoomed();
        await wait(80);
        const settles = [];
        editor.on('viewsettle', (view) => settles.push(view));
        press(svg, 100, 100);
        move(60, 80);
        await wait(80);
        expect(settles).toEqual([]);
        move(0, 0);
        release(0, 0);
        await wait(80);
        expect(settles).toEqual([{ x: 650, y: 500, width: 400, height: 300, scale: 2 }]);
    });

    it('swallows the click that ends a drag of the view, and only that one', async () => {
        const { svg } = zoomed();
        let clicks = 0;
        svg.addEventListener('click', () => clicks++);
        const send = () => svg.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        press(svg, 100, 100);
        move(60, 80);
        release(60, 80);
        send();
        expect(clicks).toBe(0);
        send();
        expect(clicks).toBe(1);

        // A drag that no click follows leaves the next real click alone.
        press(svg, 100, 100);
        move(60, 80);
        release(60, 80);
        await wait(5);
        send();
        expect(clicks).toBe(2);
    });

    it('goes on while the data changes under it, and Escape lets go', () => {
        const { editor, svg } = zoomed();
        press(svg, 100, 100);
        move(60, 80);
        editor.createAnnotation(BOX, { select: false });
        editor.updateAnnotation('box', { class_id: 3 });
        move(0, 0);
        expect(editor.getView()).toEqual({ x: 650, y: 500, width: 400, height: 300, scale: 2 });

        key('Escape');
        move(-100, -100);
        release(-100, -100);
        expect(editor.getView()).toEqual({ x: 650, y: 500, width: 400, height: 300, scale: 2 });
    });

    it('is off with zoomControls: false', () => {
        const { editor, svg } = zoomed({ zoomControls: false });
        press(svg, 100, 100);
        move(60, 80);
        release(60, 80);
        const [x, y] = screenOf(svg, 800, 600);
        press(bboxEl(svg, 'box'), x, y, MIDDLE);
        move(x - 40, y, MIDDLE);
        release(x - 40, y, { button: 1 });
        expect(editor.getView()).toEqual(ZOOMED);
    });

    it('ends with the editor', () => {
        const { editor, svg } = zoomed();
        press(svg, 100, 100);
        move(60, 80);
        editor.destroy();
        expect(() => {
            move(0, 0);
            release(0, 0);
        }).not.toThrow();
    });
});

describe('zooming with the keyboard', () => {
    const scaleOf = (editor) => editor.getView().scale;

    it('+ and - zoom around the middle of the view', () => {
        const { editor } = clocked();
        expect(key('+').defaultPrevented).toBe(true);
        expect(editor.getView()).toEqual({ x: 160, y: 120, width: 1280, height: 960, scale: 0.625 });
        key('=');
        expect(scaleOf(editor)).toBeCloseTo(0.5 * 1.25 * 1.25, 5);
        key('-');
        expect(editor.getView()).toEqual({ x: 160, y: 120, width: 1280, height: 960, scale: 0.625 });
        key('+', { code: 'NumpadAdd' });
        key('-', { code: 'NumpadSubtract' });
        key('-');
        expect(editor.getView()).toEqual(WHOLE);
    });

    it('Shift+1 shows the whole image and Shift+0 its real pixels', () => {
        const { editor } = clocked();
        expect(key(')', { code: 'Digit0', shiftKey: true }).defaultPrevented).toBe(true);
        expect(editor.getView()).toEqual({ x: 400, y: 300, width: 800, height: 600, scale: 1 });
        editor.zoomBy(7, { x: 100, y: 100 });
        key(')', { code: 'Digit0', shiftKey: true });
        expect(scaleOf(editor)).toBe(1);
        expect(key('!', { code: 'Digit1', shiftKey: true }).defaultPrevented).toBe(true);
        expect(editor.getView()).toEqual(WHOLE);
    });

    it('reads the digits by where the keys are, whatever they type', () => {
        const { editor } = clocked();
        // A German or Turkish keyboard: Shift+0 types "=". That is the real pixels, not a zoom in.
        key('=', { code: 'Digit0', shiftKey: true });
        expect(scaleOf(editor)).toBe(1);
        // A French one: the digits are typed with Shift.
        key('1', { code: 'Digit1', shiftKey: true });
        expect(editor.getView()).toEqual(WHOLE);
    });

    it('leaves a key that changes nothing to the page', () => {
        const { editor } = clocked({ maxScale: 0.5 });
        for (const [name, init] of [
            ['-', {}],
            ['+', {}],
            ['!', { code: 'Digit1', shiftKey: true }],
            [')', { code: 'Digit0', shiftKey: true }]
        ]) {
            expect(key(name, init).defaultPrevented).toBe(false);
        }
        expect(editor.getView()).toEqual(WHOLE);
    });

    it('leaves the bare digits and anything with Ctrl, Cmd or Alt alone', () => {
        const { editor } = clocked();
        const untouched = [
            ['0', { code: 'Digit0' }],
            ['1', { code: 'Digit1' }],
            ['+', { ctrlKey: true }],
            ['=', { metaKey: true }],
            ['-', { altKey: true }],
            ['0', { code: 'Digit0', shiftKey: true, ctrlKey: true }]
        ];
        editor.zoomBy(2);
        for (const [name, init] of untouched) expect(key(name, init).defaultPrevented).toBe(false);
        expect(scaleOf(editor)).toBe(1);
    });

    it('follows the rules of the other keys: not while typing, and only the editor used last', () => {
        const first = clocked();
        const second = clocked();
        const field = document.createElement('input');
        document.body.appendChild(field);
        expect(key('+', {}, field).defaultPrevented).toBe(false);

        key('+');
        expect([scaleOf(first.editor), scaleOf(second.editor)]).toEqual([0.625, 0.5]);
        click(second.svg, 100, 100);
        key('+');
        expect([scaleOf(first.editor), scaleOf(second.editor)]).toEqual([0.625, 0.625]);
    });

    it('is off with keyboardControls: false or zoomControls: false', () => {
        for (const off of [{ keyboardControls: false }, { zoomControls: false }]) {
            const { editor } = clocked(off);
            expect(key('+').defaultPrevented).toBe(false);
            expect(editor.getView()).toEqual(WHOLE);
            editor.destroy();
        }
    });
});

describe('stepping through the annotations', () => {
    // Small objects, far apart, in an order that is neither by size nor by position.
    const OBJECTS = [
        { id: 'c', bbox: [1400, 1000, 40, 20] },
        { id: 'a', bbox: [100, 100, 20, 40] },
        {
            id: 'b',
            segments: [
                [700, 500],
                [900, 500],
                [800, 700]
            ]
        }
    ];
    const start = (options) => clocked({ annotations: OBJECTS, ...options });
    const selected = (editor) => (editor.getSelection() || {}).id;

    it('step() goes through the list in its own order and stops at the ends', () => {
        const { editor } = start();
        const seen = [];
        // Bounded, so that a step() that never says "no further" fails the test instead of hanging it.
        for (let i = 0; i < 10 && editor.step(1); i++) seen.push(selected(editor));
        expect(seen).toEqual(['c', 'a', 'b']);
        expect(selected(editor)).toBe('b');
        expect(editor.step(1)).toBe(false);

        for (let i = 0; i < 10 && editor.step(-1); i++) seen.push(selected(editor));
        expect(seen).toEqual(['c', 'a', 'b', 'a', 'c']);
        expect(editor.step(-1)).toBe(false);
        expect(selected(editor)).toBe('c');
    });

    it('starts from the last annotation when it goes backwards with nothing selected', () => {
        const { editor } = start();
        expect(editor.step(-1)).toBe(true);
        expect(selected(editor)).toBe('b');
        expect(clocked().editor.step(1)).toBe(false);
    });

    it('frames each annotation, and says so with the usual events', () => {
        const { editor } = start();
        const heard = [];
        editor.on('select', (e) => heard.push(`select ${e.id} ${e.part}`));
        editor.on('deselect', (e) => heard.push(`deselect ${e.id}`));
        editor.step(1);
        // 40 x 20 image pixels in 720 x 520 on screen.
        expect(editor.getView().scale).toBe(18);
        const middle = editor.toClient(1420, 1010);
        expect(middle.x).toBeCloseTo(420, 6);
        expect(middle.y).toBeCloseTo(320, 6);
        editor.step(1);
        expect(editor.getView().scale).toBe(13);
        editor.step(1);
        expect(editor.getView()).toMatchObject({ scale: 2.6 });
        expect(heard).toEqual(['select c bbox', 'deselect c', 'select a bbox', 'deselect a', 'select b polygon']);
    });

    it('continues from whatever is selected, also when that is one part of an annotation', () => {
        const { editor } = start({
            annotations: [...OBJECTS, { id: 'd', keypoints: [{ point: [5, 5] }, { point: [9, 9] }] }]
        });
        editor.select('d', 'keypoint', 1);
        expect(editor.step(-1)).toBe(true);
        expect(selected(editor)).toBe('b');
        editor.select('a');
        editor.step(1);
        expect(selected(editor)).toBe('b');
    });

    it('needs a direction', () => {
        const { editor, log } = start();
        expect(editor.step()).toBe(false);
        expect(editor.step(2)).toBe(false);
        expect(log.length).toBe(2);
        expect(selected(editor)).toBe(undefined);
    });

    it('n and p do it from the keyboard, when stepKeys is on', () => {
        const { editor } = start({ stepKeys: true });
        expect(key('n').defaultPrevented).toBe(true);
        expect(selected(editor)).toBe('c');
        key('N'); // Caps Lock
        key('n');
        expect(selected(editor)).toBe('b');
        // At the end the key does nothing, and is not taken.
        expect(key('n').defaultPrevented).toBe(false);
        expect(selected(editor)).toBe('b');
        expect(key('p').defaultPrevented).toBe(true);
        expect(selected(editor)).toBe('a');
        expect(editor.getView().scale).toBe(13);
    });

    it('n and p are plain letters unless stepKeys is on', () => {
        const { editor } = start();
        expect(key('n').defaultPrevented).toBe(false);
        expect(key('p').defaultPrevented).toBe(false);
        expect(editor.getSelection()).toBe(null);
        expect(editor.getOptions().stepKeys).toBe(false);
    });

    it('the keys are left alone with a modifier, while typing, and during a drag', () => {
        const { editor, svg } = start({ stepKeys: true });
        const field = document.createElement('input');
        document.body.appendChild(field);
        for (const init of [{ ctrlKey: true }, { metaKey: true }, { altKey: true }, { shiftKey: true }]) {
            expect(key('n', init).defaultPrevented).toBe(false);
        }
        expect(key('n', {}, field).defaultPrevented).toBe(false);
        expect(editor.getSelection()).toBe(null);

        editor.select('b');
        const [x, y] = screenOf(svg, 800, 550);
        press(svg.querySelector('[data-markin-part="polygon"]'), x, y);
        move(x + 20, y);
        expect(key('n').defaultPrevented).toBe(false);
        release(x + 20, y);
        expect(selected(editor)).toBe('b');
        expect(editor.getAnnotation('b').segments[0]).toEqual([740, 500]);
    });
});

describe('a disabled editor', () => {
    function disabled(options) {
        const made = clocked({ annotations: [THING], ...options });
        made.editor.disable();
        made.heard = [];
        for (const type of ['change', 'select', 'deselect', 'dragstart', 'drag', 'dragend']) {
            made.editor.on(type, () => made.heard.push(type));
        }
        return made;
    }

    it('still zooms with the wheel, the pinch and the keys', () => {
        const { editor, svg } = disabled();
        expect(wheel(svg, 420, 320, { deltaY: -10, ctrlKey: true }).defaultPrevented).toBe(true);
        expect(editor.getView().scale).toBeCloseTo(0.5 * Math.pow(2, 0.2), 5);
        gesture('gesturestart', svg, 420, 320, 1);
        gesture('gesturechange', svg, 420, 320, 2);
        gesture('gestureend', svg, 420, 320, 2);
        expect(editor.getView().scale).toBeCloseTo(Math.pow(2, 0.2), 5);
        click(svg, 100, 100);
        expect(key('!', { code: 'Digit1', shiftKey: true }).defaultPrevented).toBe(true);
        expect(editor.getView()).toEqual(WHOLE);
        expect(key('+').defaultPrevented).toBe(true);
        later(1000);
        wheel(svg, 420, 320, { deltaY: 30 });
        expect(editor.getView().y).toBe(168);
    });

    it('can be dragged about from anywhere, since nothing in it takes the pointer', () => {
        const { editor, svg, heard } = disabled();
        editor.zoomBy(4);
        const [x, y] = screenOf(svg, 800, 600);
        const down = press(bboxEl(svg, 'box'), x, y);
        expect(down.defaultPrevented).toBe(false);
        move(x - 40, y - 20);
        release(x - 40, y - 20);
        expect(editor.getView()).toEqual({ x: 620, y: 460, width: 400, height: 300, scale: 2 });

        pointer('pointermove', svg, 100, 100, { buttons: 0 });
        expect(key(' ', { code: 'Space' }).defaultPrevented).toBe(true);
        press(svg, 100, 100);
        move(60, 80);
        release(60, 80);
        keyUp(' ');
        expect(editor.getView()).toEqual({ x: 640, y: 470, width: 400, height: 300, scale: 2 });
        expect(heard).toEqual([]);
        expect(editor.getSelection()).toBe(null);
        expect(editor.getAnnotation('box')).toEqual(THING);
    });

    it('edits nothing', () => {
        const { editor, svg, heard } = disabled({ stepKeys: true });
        const [x, y] = screenOf(svg, 800, 600);
        click(bboxEl(svg, 'box'), x, y);
        press(bboxEl(svg, 'box'), x, y);
        move(x + 40, y);
        release(x + 40, y);
        for (const name of ['Delete', 'ArrowRight', 'n', 'p']) expect(key(name).defaultPrevented).toBe(false);
        expect(key('z', { ctrlKey: true }).defaultPrevented).toBe(false);
        expect(heard).toEqual([]);
        expect(editor.getSelection()).toBe(null);
        expect(editor.getAnnotations()).toEqual([THING]);
        expect(svg.querySelector('.markin-layer').style.pointerEvents).toBe('none');
    });

    it('reports every click that is not a drag, with where it is in the image', () => {
        const { editor, svg } = disabled();
        const clicks = [];
        editor.on('canvasclick', (e) => clicks.push(e.position));
        // On an annotation: to a disabled editor that is canvas like any other.
        const [x, y] = screenOf(svg, 800, 600);
        click(bboxEl(svg, 'box'), x, y);
        expect(clicks).toEqual([{ x: 800, y: 600 }]);

        editor.zoomBy(4);
        const [zx, zy] = screenOf(svg, 750, 650);
        click(svg, zx, zy);
        expect(clicks[1].x).toBeCloseTo(750, 6);
        expect(clicks[1].y).toBeCloseTo(650, 6);
        // A drag of the view is not a click.
        press(svg, zx, zy);
        move(zx - 40, zy);
        release(zx - 40, zy);
        expect(clicks.length).toBe(2);
    });

    it('reports where the pointer is, without saying what is under it', async () => {
        const { editor, svg } = disabled();
        const seen = [];
        editor.on('hover', (e) => seen.push(e));
        const [x, y] = screenOf(svg, 800, 600);
        pointer('pointermove', bboxEl(svg, 'box'), x, y, { buttons: 0 });
        await nextFrame();
        expect(seen).toEqual([{ position: { x: 800, y: 600 }, id: null, part: null, index: null }]);
    });

    it('hears the pointer over the image itself, where its overlay lets everything through', async () => {
        const { image } = makeImage({ width: 1600, height: 1200 });
        vi.spyOn(Date, 'now').mockImplementation(() => now);
        const editor = track(MarkinJS.create(image, { silent: true, annotations: [THING] }));
        setBox(editor.getSVGElement(), HALF.box);
        editor.disable();
        expect(editor.getSVGElement().style.pointerEvents).toBe('none');
        const clicks = [];
        const hovers = [];
        editor.on('canvasclick', (e) => clicks.push(e.position));
        editor.on('hover', (e) => hovers.push(e.position));

        click(image, 420, 320);
        pointer('pointermove', image, 220, 170, { buttons: 0 });
        await nextFrame();
        expect(clicks).toEqual([{ x: 800, y: 600 }]);
        expect(hovers).toEqual([{ x: 400, y: 300 }]);

        expect(wheel(image, 420, 320, { deltaY: -10, ctrlKey: true }).defaultPrevented).toBe(true);
        expect(editor.getView().scale).toBeGreaterThan(0.5);
        editor.zoomBy(8);
        press(image, 420, 320);
        const dragged = move(380, 320);
        release(380, 320);
        expect(dragged.defaultPrevented).toBe(true);
        // The browser would drag the image away as a picture; that is stopped while a press is followed.
        press(image, 420, 320);
        const native = new Event('dragstart', { bubbles: true, cancelable: true });
        image.dispatchEvent(native);
        expect(native.defaultPrevented).toBe(true);
        release(420, 320);
    });

    it('keeps a drag of the view going when it is disabled or enabled in the middle of it', () => {
        const { editor, svg } = clocked({ annotations: [THING] });
        editor.zoomBy(4);
        press(svg, 100, 100);
        move(60, 80);
        editor.disable();
        move(20, 60);
        editor.enable();
        move(0, 0);
        release(0, 0);
        expect(editor.getView()).toEqual({ x: 650, y: 500, width: 400, height: 300, scale: 2 });
    });

    it('without a viewport it ignores the pointer altogether, as it always did', () => {
        const { editor, svg } = clocked({ annotations: [BOX] }, LAID_OVER);
        editor.disable();
        const clicks = [];
        editor.on('canvasclick', (e) => clicks.push(e));
        click(svg, 500, 500);
        expect(clicks).toEqual([]);
    });
});
