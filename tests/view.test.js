import { describe, it, expect } from 'vitest';
import {
    MarkinJS,
    makeEditor,
    makeImage,
    makeStage,
    track,
    setBox,
    stageOf,
    screenOf,
    pointer,
    press,
    move,
    release,
    click,
    drag,
    wheel,
    key,
    keyUp,
    bboxEl,
    polygonEl,
    keypointEl,
    handleEl,
    num,
    wait,
    nextFrame,
    BOX,
    HALF,
    WHOLE,
    LAID_OVER
} from './setup.js';

// What the library wrote on the page for the current view: the part of the image the <svg> draws,
// and whether the window onto it clips. The window is the viewport, or else the <svg> itself.
const written = (editor) => {
    const svg = editor.getSVGElement();
    return {
        viewBox: svg.getAttribute('viewBox'),
        clips: (editor.getContainerElement() || svg).style.overflow === 'hidden'
    };
};
const AT_REST = { viewBox: '0 0 1600 1200', clips: false };

describe('the view at rest', () => {
    it('is the whole image, with nothing written on the page', () => {
        const { editor } = makeEditor({}, HALF);
        expect(editor.getView()).toEqual(WHOLE);
        expect(written(editor)).toEqual(AT_REST);
    });

    it('cannot be zoomed out of, and fit() returns to it', () => {
        const { editor } = makeEditor({}, HALF);
        expect(editor.zoomBy(0.25)).toBe(true);
        expect(written(editor)).toEqual(AT_REST);

        editor.zoomBy(3);
        expect(written(editor).clips).toBe(true);
        expect(editor.fit()).toBe(true);
        expect(editor.getView()).toEqual(WHOLE);
        expect(written(editor)).toEqual(AT_REST);
    });
});

describe('zoomBy', () => {
    it('zooms around the middle of the view', () => {
        const { editor } = makeEditor({}, HALF);
        editor.zoomBy(2);
        expect(editor.getView()).toEqual({ x: 400, y: 300, width: 800, height: 600, scale: 1 });
        expect(written(editor)).toEqual({ viewBox: '400 300 800 600', clips: true });
        editor.zoomBy(2);
        expect(editor.getView()).toEqual({ x: 600, y: 450, width: 400, height: 300, scale: 2 });
    });

    it('zooms around a point of the image, which stays where it is on screen', () => {
        const { editor } = makeEditor({}, HALF);
        for (const at of [
            { x: 0, y: 0 },
            { x: 1000, y: 300 },
            { x: 1600, y: 1200 }
        ]) {
            editor.fit();
            const before = editor.toClient(at.x, at.y);
            editor.zoomBy(4, at);
            const after = editor.toClient(at.x, at.y);
            expect(after.x).toBeCloseTo(before.x, 6);
            expect(after.y).toBeCloseTo(before.y, 6);
            expect(editor.getView().scale).toBe(2);
        }
        editor.fit();
        editor.zoomBy(4, { x: 0, y: 0 });
        expect(editor.getView()).toEqual({ x: 0, y: 0, width: 400, height: 300, scale: 2 });
    });

    it('stops at maxScale, in screen pixels per image pixel', () => {
        const { editor } = makeEditor({}, HALF);
        editor.zoomBy(1e6);
        expect(editor.getView()).toEqual({ x: 787, y: 590, width: 26, height: 20, scale: 32 });

        const low = makeEditor({ maxScale: 4 }, HALF).editor;
        low.zoomBy(1e6);
        expect(low.getView().scale).toBe(4);
        // The limit can be changed while zoomed in: the view comes back inside it.
        low.setOptions({ maxScale: 1 });
        expect(low.getView()).toEqual({ x: 400, y: 300, width: 800, height: 600, scale: 1 });
    });

    it('a small image that the page already shows larger than maxScale stays as the page shows it', () => {
        const tiny = { viewBox: '0 0 100 100', box: { left: 0, top: 0, width: 800, height: 800 } };
        const { editor } = makeEditor({ maxScale: 4 }, tiny);
        editor.zoomBy(2);
        expect(editor.getView()).toEqual({ x: 0, y: 0, width: 100, height: 100, scale: 8 });
        expect(written(editor)).toEqual({ viewBox: '0 0 100 100', clips: false });
    });

    it('rejects a factor or a point that makes no sense', () => {
        const { editor, log } = makeEditor({}, HALF);
        expect(editor.zoomBy(0)).toBe(false);
        expect(editor.zoomBy('2')).toBe(false);
        expect(editor.zoomBy(2, { x: 1 })).toBe(false);
        expect(written(editor)).toEqual(AT_REST);
        expect(log.length).toBe(3);
        expect(log[0]).toMatch(/^error: zoomBy: the factor/);
        expect(() => makeEditor({ strict: true }).editor.zoomBy(-1)).toThrow(TypeError);
    });
});

describe('getView', () => {
    it('covers everything that is visible with whole pixels, and stays inside the image', () => {
        const { editor } = makeEditor({}, HALF);
        editor.zoomBy(3);
        // 533.33 x 400 image pixels are visible, from (533.33, 400).
        expect(editor.getView()).toEqual({ x: 533, y: 400, width: 534, height: 400, scale: 1.5 });

        for (const factor of [1.37, 2.9, 7.123, 31]) {
            for (const at of [undefined, { x: 3, y: 1190 }, { x: 1599, y: 2 }]) {
                editor.fit();
                editor.zoomBy(factor, at);
                const v = editor.getView();
                for (const n of [v.x, v.y, v.width, v.height]) expect(Number.isInteger(n)).toBe(true);
                expect(v.x).toBeGreaterThanOrEqual(0);
                expect(v.y).toBeGreaterThanOrEqual(0);
                expect(v.x + v.width).toBeLessThanOrEqual(1600);
                expect(v.y + v.height).toBeLessThanOrEqual(1200);
                // Outward: the corners of the viewport are inside the rectangle, or outside the image.
                const corner = editor.toImage(20, 20);
                expect(v.x).toBeLessThanOrEqual(Math.max(0, corner.x) + 1e-6);
                expect(v.y).toBeLessThanOrEqual(Math.max(0, corner.y) + 1e-6);
                const far = editor.toImage(820, 620);
                expect(v.x + v.width).toBeGreaterThanOrEqual(Math.min(1600, far.x) - 1e-6);
                expect(v.y + v.height).toBeGreaterThanOrEqual(Math.min(1200, far.y) - 1e-6);
            }
        }
    });
});

describe('setView', () => {
    it('shows exactly a rectangle that has the proportions of the viewport', () => {
        const { editor } = makeEditor({}, HALF);
        expect(editor.setView({ x: 400, y: 300, width: 400, height: 300 })).toBe(true);
        expect(editor.getView()).toEqual({ x: 400, y: 300, width: 400, height: 300, scale: 2 });
        expect(written(editor).viewBox).toBe('400 300 400 300');
    });

    it('shows at least a rectangle of other proportions, centred', () => {
        const { editor } = makeEditor({}, HALF);
        editor.setView({ x: 600, y: 500, width: 400, height: 100 });
        // As wide as the view; the spare height is shared above and below.
        expect(editor.getView()).toEqual({ x: 600, y: 400, width: 400, height: 300, scale: 2 });
        editor.setView({ x: 600, y: 500, width: 100, height: 300 });
        expect(editor.getView()).toEqual({ x: 450, y: 500, width: 400, height: 300, scale: 2 });
    });

    it('keeps to the limits: the scale, and the edges of the image', () => {
        const { editor } = makeEditor({ maxScale: 4 }, HALF);
        editor.setView({ x: 800, y: 600, width: 2, height: 2 });
        expect(editor.getView()).toEqual({ x: 701, y: 526, width: 200, height: 150, scale: 4 });

        // A rectangle that reaches outside the image: the view stops a handle's width past the edge.
        editor.setView({ x: -500, y: -500, width: 800, height: 600 });
        expect(written(editor).viewBox).toBe('-12 -12 800 600');
        expect(editor.getView()).toEqual({ x: 0, y: 0, width: 788, height: 588, scale: 1 });
    });

    it('rejects anything but a rectangle with a size', () => {
        const { editor, log } = makeEditor({}, HALF);
        for (const bad of [null, {}, { x: 0, y: 0, width: 0, height: 10 }, { x: 0, y: 0, width: '5', height: 5 }]) {
            expect(editor.setView(bad)).toBe(false);
        }
        expect(log.length).toBe(4);
        expect(written(editor)).toEqual(AT_REST);
    });
});

describe('zoomTo', () => {
    const things = [
        {
            id: 'box',
            bbox: [780, 590, 40, 20],
            segments: [
                [0, 0],
                [1600, 0],
                [1600, 1200]
            ]
        },
        {
            id: 'shape',
            segments: [
                [100, 100],
                [300, 100],
                [300, 200],
                [100, 200]
            ]
        },
        { id: 'dot', keypoints: [{ point: [400, 900] }, { point: [0, 0], v: 0 }] }
    ];
    const start = (options) => makeEditor({ annotations: things, ...options }, HALF);

    it('frames the bbox of an annotation, 40 screen pixels from the edges', () => {
        const { editor } = start();
        expect(editor.zoomTo('box')).toBe(true);
        // 40 x 20 image pixels in the 720 x 520 that the padding leaves: 18 screen pixels each.
        expect(editor.getView().scale).toBe(18);
        const middle = editor.toClient(800, 600);
        const corner = editor.toClient(780, 590);
        [middle.x, middle.y, corner.x, corner.y].forEach((n, i) => expect(n).toBeCloseTo([420, 320, 60, 140][i], 6));
    });

    it('takes the padding it is given', () => {
        const { editor } = start();
        editor.zoomTo('box', { padding: 0 });
        expect(editor.getView()).toEqual({ x: 780, y: 585, width: 40, height: 30, scale: 20 });
        editor.zoomTo('box', { padding: 200 });
        expect(editor.getView().scale).toBe(10);
    });

    it('frames the polygon or the labelled keypoints of an annotation without a bbox', () => {
        const { editor } = start();
        editor.zoomTo('shape', { padding: 0 });
        expect(editor.getView()).toEqual({ x: 100, y: 75, width: 200, height: 150, scale: 4 });
        // A single point has no size: as close as the view goes, with the point in the middle.
        editor.zoomTo('dot');
        expect(editor.getView().scale).toBe(32);
        expect(editor.toClient(400, 900)).toEqual({ x: 420, y: 320 });
    });

    it('does not go past maxScale, and leaves the selection alone', () => {
        const { editor } = start({ maxScale: 2 });
        editor.select('shape');
        editor.zoomTo('box');
        expect(editor.getView().scale).toBe(2);
        expect(editor.getSelection().id).toBe('shape');
    });

    it('needs an annotation that exists and a sensible padding', () => {
        const { editor, log } = start();
        expect(editor.zoomTo('nobody')).toBe(false);
        expect(editor.zoomTo('box', { padding: -1 })).toBe(false);
        expect(editor.zoomTo('box', { padding: '10' })).toBe(false);
        expect(log.length).toBe(3);
        expect(log[0]).toMatch(/zoomTo: no annotation with id "nobody"/);
        expect(written(editor)).toEqual(AT_REST);
    });
});

describe('toImage and toClient', () => {
    it('convert between the screen and the image at every zoom', () => {
        const { editor } = makeEditor({}, HALF);
        expect(editor.toImage(20, 20)).toEqual({ x: 0, y: 0 });
        expect(editor.toClient(1600, 1200)).toEqual({ x: 820, y: 620 });

        for (const factor of [1, 3, 7.5, 64]) {
            editor.fit();
            editor.zoomBy(factor, { x: 900, y: 700 });
            for (const [x, y] of [
                [0, 0],
                [900, 700],
                [1234.5, 17.25],
                [1600, 1200]
            ]) {
                const client = editor.toClient(x, y);
                const back = editor.toImage(client.x, client.y);
                expect(back.x).toBeCloseTo(x, 6);
                expect(back.y).toBeCloseTo(y, 6);
            }
            // One image pixel is `scale` pixels on screen.
            const step = editor.toClient(901, 700).x - editor.toClient(900, 700).x;
            expect(step).toBeCloseTo(editor.getView().scale, 6);
        }
    });

    it('need numbers', () => {
        const { editor, log } = makeEditor({}, HALF);
        expect(editor.toImage('1', 2)).toBe(null);
        expect(editor.toClient(1)).toBe(null);
        expect(log.length).toBe(2);
    });
});

describe('the view and the page', () => {
    it('keeps handles and outlines the same size on screen', () => {
        const { editor, svg } = makeEditor({ annotations: [{ id: 'big', bbox: [200, 200, 400, 200] }] }, HALF);
        editor.select('big');
        const sizes = () => [
            num(svg.querySelector('.markin-handle'), 'r'),
            num(handleEl(svg, 'se'), 'r'),
            num(svg.querySelector('.markin-layer'), 'stroke-width')
        ];
        expect(sizes()).toEqual([10, 22, 4]);
        editor.zoomBy(4);
        expect(sizes()).toEqual([2.5, 5.5, 1]);
        editor.fit();
        expect(sizes()).toEqual([10, 22, 4]);
    });

    it('shows the same part of the image when the canvas is resized', () => {
        const { editor, svg } = makeEditor({}, HALF);
        editor.zoomBy(2);
        setBox(svg, { left: 20, top: 20, width: 400, height: 300 });
        editor.refresh();
        expect(editor.getView()).toEqual({ x: 400, y: 300, width: 800, height: 600, scale: 0.5 });
        expect(written(editor).viewBox).toBe('400 300 800 600');
    });

    it('keeps the middle in place when a resize also brings the limit down', () => {
        const { editor, svg } = makeEditor({}, HALF);
        editor.zoomBy(1e6);
        expect(editor.getView()).toEqual({ x: 787, y: 590, width: 26, height: 20, scale: 32 });
        // Twice the size on the page: at rest one image pixel is now a whole pixel on screen, so
        // the closest view is half as many times the size at rest.
        setBox(svg, { left: 20, top: 20, width: 1600, height: 1200 });
        editor.refresh();
        expect(editor.getView()).toEqual({ x: 775, y: 581, width: 50, height: 38, scale: 32 });
    });

    it('goes back to the whole image when the picture is replaced', () => {
        const { image, load } = makeImage({ width: 1600, height: 1200 });
        const editor = track(MarkinJS.create(image, { silent: true }));
        setBox(editor.getSVGElement(), HALF.box);
        editor.zoomBy(2);
        expect(editor.getView()).toEqual({ x: 400, y: 300, width: 800, height: 600, scale: 1 });
        // The image is moved and scaled; the overlay is not, it draws the visible part at screen size.
        expect(image.style.transform).toBe('translate(-400px, -300px) scale(2)');
        expect(image.style.transformOrigin).toBe('0 0');
        expect(written(editor)).toEqual({ viewBox: '400 300 800 600', clips: true });
        expect(stageOf(editor).style.transform).toBe('');
        expect(editor.getSVGElement().style.transform).toBe('');

        // The browser reports the load of an image it already had: the same picture, the same view.
        load(1600, 1200);
        expect(editor.getView()).toEqual({ x: 400, y: 300, width: 800, height: 600, scale: 1 });

        load(800, 600);
        expect(editor.getView()).toEqual({ x: 0, y: 0, width: 800, height: 600, scale: 1 });
        expect(written(editor)).toEqual({ viewBox: '0 0 800 600', clips: false });
        expect(image.style.transform).toBe('');
    });

    it('zooms an <svg> that has no viewBox, in its own pixels', () => {
        // Without a viewBox one unit is one CSS pixel, so the size CSS gives the <svg> matters.
        const { editor } = makeEditor({}, { viewBox: null, style: { width: '800px', height: '600px' } });
        expect(editor.getView()).toEqual({ x: 0, y: 0, width: 800, height: 600, scale: 1 });
        editor.zoomBy(2);
        expect(editor.getView()).toEqual({ x: 200, y: 150, width: 400, height: 300, scale: 2 });
    });

    it('has no view of an image that has not arrived yet', () => {
        const { image, load } = makeImage({ width: 0, height: 0 });
        const editor = track(MarkinJS.create(image, { silent: true }));
        setBox(editor.getSVGElement(), HALF.box);
        expect(editor.getView()).toBe(null);
        expect(editor.zoomBy(2)).toBe(false);

        load(1600, 1200);
        expect(editor.getView()).toEqual(WHOLE);
    });

    it('has no view to speak of before the page is laid out', () => {
        const { editor } = makeEditor({}, { box: null });
        expect(editor.getView()).toBe(null);
        expect(editor.zoomBy(2)).toBe(false);
        expect(editor.fit()).toBe(false);
        expect(editor.setView({ x: 0, y: 0, width: 10, height: 10 })).toBe(false);
        expect(editor.toImage(5, 6)).toEqual({ x: 5, y: 6 });
        expect(editor.toClient(5, 6)).toEqual({ x: 5, y: 6 });
    });

    it('does nothing once the editor is destroyed', () => {
        const { editor } = makeEditor({}, HALF);
        editor.zoomBy(2);
        editor.destroy();
        expect(editor.getView()).toBe(null);
        expect(editor.zoomBy(2)).toBe(false);
        expect(editor.toImage(1, 1)).toBe(null);
    });
});

describe('viewchange and viewsettle', () => {
    // An editor whose view events are collected from the start. The view settles after 30ms.
    function watched(options, svgOptions = HALF) {
        const made = makeEditor({ settleDelay: 30, ...options }, svgOptions);
        made.changes = [];
        made.settles = [];
        made.editor.on('viewchange', (view) => made.changes.push(view));
        made.editor.on('viewsettle', (view) => made.settles.push(view));
        return made;
    }

    it('report the first view, once each', async () => {
        const { changes, settles } = watched();
        expect([changes, settles]).toEqual([[], []]);
        await wait(80);
        expect(changes).toEqual([WHOLE]);
        expect(settles).toEqual([WHOLE]);
    });

    it('viewchange comes at most once per frame, with the view as it is then', async () => {
        const { editor, changes } = watched();
        await wait(80);
        changes.length = 0;
        editor.zoomBy(2);
        editor.zoomBy(2);
        editor.zoomBy(1.5, { x: 100, y: 100 });
        expect(changes).toEqual([]);
        await nextFrame();
        expect(changes).toEqual([editor.getView()]);
        expect(changes[0].scale).toBe(3);
    });

    it('viewsettle comes once, after the view has stopped moving', async () => {
        const { editor, settles } = watched();
        await wait(80);
        settles.length = 0;
        editor.zoomBy(2);
        await wait(10);
        editor.zoomBy(2);
        await wait(10);
        editor.zoomBy(2);
        expect(settles).toEqual([]);
        await wait(80);
        expect(settles).toEqual([{ x: 700, y: 525, width: 200, height: 150, scale: 4 }]);
    });

    it('viewsettle stays quiet for a view that ends where it was', async () => {
        const { editor, changes, settles } = watched();
        await wait(80);
        changes.length = 0;
        settles.length = 0;
        editor.zoomBy(2);
        editor.fit();
        editor.zoomBy(1);
        editor.refresh();
        await wait(80);
        expect([changes, settles]).toEqual([[], []]);
    });

    it('a movement smaller than a pixel of the image is a viewchange but no new crop', async () => {
        const { editor, changes, settles } = watched();
        editor.zoomBy(60);
        await wait(80);
        const crop = editor.getView();
        changes.length = 0;
        settles.length = 0;
        editor.zoomBy(1.001);
        await wait(80);
        const { scale, ...rect } = editor.getView();
        expect(rect).toEqual({ x: crop.x, y: crop.y, width: crop.width, height: crop.height });
        expect(scale).toBeGreaterThan(crop.scale);
        expect(changes.length).toBe(1);
        expect(settles).toEqual([]);
    });

    it('a canvas that is resized is a viewchange, and a viewsettle when it shows another part', async () => {
        const { editor, svg, changes, settles } = watched();
        editor.zoomBy(2);
        await wait(80);
        changes.length = 0;
        settles.length = 0;
        // Half the size, the same proportions: the same part of the image, at half the scale.
        setBox(svg, { left: 20, top: 20, width: 400, height: 300 });
        editor.refresh();
        await wait(80);
        expect(changes).toEqual([{ x: 400, y: 300, width: 800, height: 600, scale: 0.5 }]);
        expect(settles).toEqual([]);

        // Other proportions: the viewport is a different window onto the image now.
        setBox(svg, { left: 20, top: 20, width: 400, height: 600 });
        editor.refresh();
        await wait(80);
        expect(changes.length).toBe(2);
        expect(settles).toEqual([changes[1]]);
        expect(settles[0]).not.toMatchObject({ x: 400, y: 300, width: 800, height: 600 });
    });

    it('viewsettle reports a new picture, even one of the same size', async () => {
        const { image } = makeImage({ width: 1600, height: 1200 });
        let address = 'first.jpg';
        Object.defineProperty(image, 'currentSrc', { get: () => address });
        const editor = track(MarkinJS.create(image, { silent: true, settleDelay: 30 }));
        setBox(editor.getSVGElement(), HALF.box);
        const settles = [];
        editor.on('viewsettle', (view) => settles.push(view));
        await wait(80);
        expect(settles).toEqual([WHOLE]);

        address = 'second.jpg';
        image.dispatchEvent(new Event('load'));
        await wait(80);
        expect(settles).toEqual([WHOLE, WHOLE]);
        // A late `load` for the picture that is already shown is not news.
        image.dispatchEvent(new Event('load'));
        await wait(80);
        expect(settles.length).toBe(2);
    });

    it('settleDelay can be 0, and must not be negative', async () => {
        const { editor, settles, log } = watched({ settleDelay: 0 });
        await wait(20);
        expect(settles).toEqual([WHOLE]);
        editor.zoomBy(2);
        await wait(20);
        expect(settles.length).toBe(2);
        editor.setOptions({ settleDelay: -5 });
        expect(log).toEqual(['error: option "settleDelay" must be a number of milliseconds, 0 or more']);
        expect(editor.getOptions().settleDelay).toBe(0);
    });

    it('nothing is reported once the editor is destroyed', async () => {
        const { editor, changes, settles } = watched();
        editor.zoomBy(2);
        editor.destroy();
        await wait(80);
        expect([changes, settles]).toEqual([[], []]);
    });

    it('an editor that is not laid out yet reports its first view when it is', async () => {
        const { editor, svg, changes, settles } = watched({}, { viewBox: '0 0 1600 1200', box: null });
        await wait(80);
        expect([changes, settles]).toEqual([[], []]);
        setBox(svg, HALF.box);
        editor.refresh();
        await wait(80);
        expect(changes).toEqual([WHOLE]);
        expect(settles).toEqual([WHOLE]);
    });
});

describe('a stage the page marked', () => {
    // A 1000 x 600 viewport with an 800 x 600 picture centred in it.
    const centred = (prepare) =>
        makeStage({
            viewport: { left: 0, top: 0, width: 1000, height: 600 },
            picture: { left: 100, top: 0, width: 800, height: 600 },
            prepare
        });

    it('grows a picture that is smaller than the viewport from where it stands', () => {
        const { editor, stage, image, svg, viewport } = centred();
        expect(editor.getView()).toEqual({ x: 0, y: 0, width: 800, height: 600, scale: 1 });
        // 880 wide: still centred. 660 high: more than the viewport, so the middle is shown.
        editor.zoomBy(1.1);
        // The picture is moved and scaled. The stage and the <svg> are not: the <svg> is laid
        // over all of the viewport and draws what is visible there.
        expect(image.style.transform).toBe('translate(-40px, -30px) scale(1.1)');
        expect(stage.style.transform).toBe('');
        expect([svg.style.left, svg.style.top, svg.style.width, svg.style.height]).toEqual([
            '-100px',
            '0px',
            '1000px',
            '600px'
        ]);
        expect(svg.getAttribute('preserveAspectRatio')).toBe('none');
        expect(viewport.style.overflow).toBe('hidden');
        const view = editor.getView();
        expect([view.x, view.width]).toEqual([0, 800]);
        // Both agree on where a point of the image is: 60px in, where the grown picture now starts.
        expect(editor.toClient(0, 300).x).toBeCloseTo(60, 6);

        // 1600 wide: now it can be moved, and the view is a part of it.
        editor.fit();
        editor.zoomBy(2);
        expect(editor.getView()).toEqual({ x: 150, y: 150, width: 500, height: 300, scale: 2 });
        expect(svg.getAttribute('viewBox')).toBe('150 150 500 300');

        // Zoomed again from there, the picture goes by where it stood at rest, not by where the
        // view before this one left it.
        editor.zoomBy(2);
        expect(image.style.transform).toBe('translate(-1200px, -900px) scale(4)');
        expect(svg.getAttribute('viewBox')).toBe('275 225 250 150');
    });

    it('keeps a picture that still fits against the side the page put it on', () => {
        const aligned = (left) =>
            makeStage({
                viewport: { left: 0, top: 0, width: 1000, height: 600 },
                picture: { left, top: 0, width: 800, height: 600 }
            });
        // 880 wide in a viewport of 1000: on the left it stays on the left, on the right on the right.
        const atLeft = aligned(0);
        atLeft.editor.zoomBy(1.1);
        expect(atLeft.image.style.transform).toBe('translate(0px, -30px) scale(1.1)');
        expect(atLeft.editor.toClient(0, 300).x).toBeCloseTo(0, 6);

        const atRight = aligned(200);
        atRight.editor.zoomBy(1.1);
        expect(atRight.image.style.transform).toBe('translate(-80px, -30px) scale(1.1)');
        expect(atRight.editor.toClient(800, 300).x).toBeCloseTo(1000, 6);
    });

    it('covers a viewport that changed size, also when the view itself could not follow', () => {
        const box = { left: 0, top: 0, width: 800, height: 600 };
        const { editor, svg, viewport } = makeStage({ viewport: box, picture: box });
        editor.zoomBy(2);
        // Moved as far as it goes: the corner of the picture is a handle's width inside the viewport.
        press(svg, 100, 100);
        move(5000, 5000);
        release(5000, 5000);
        expect(svg.getAttribute('viewBox')).toBe('-6 -6 400 300');

        // The page makes the viewport wider. The view is at its limit and stays as it is, but
        // there is more of the image to draw now.
        setBox(viewport, { ...box, width: 1000 });
        editor.refresh();
        expect(svg.style.width).toBe('1000px');
        expect(svg.getAttribute('viewBox')).toBe('-6 -6 500 300');
    });

    it('counts a border of the viewport out of what it shows', () => {
        // A 10px border around the 800 x 600 that the viewport shows.
        const { editor, svg } = makeStage({
            viewport: { left: 0, top: 0, width: 820, height: 620 },
            picture: { left: 10, top: 10, width: 800, height: 600 },
            prepare(viewport) {
                const sizes = { clientLeft: 10, clientTop: 10, clientWidth: 800, clientHeight: 600 };
                const all = { ...sizes, offsetWidth: 820, offsetHeight: 620 };
                for (const [name, value] of Object.entries(all)) Object.defineProperty(viewport, name, { value });
            }
        });
        editor.zoomBy(2);
        expect(svg.getAttribute('viewBox')).toBe('200 150 400 300');
        expect([svg.style.left, svg.style.top, svg.style.width, svg.style.height]).toEqual([
            '0px',
            '0px',
            '800px',
            '600px'
        ]);
        const middle = editor.toClient(400, 300);
        expect(middle.x).toBeCloseTo(410, 6);
        expect(middle.y).toBeCloseTo(310, 6);
    });

    it('gives the page its own styles and attributes back', () => {
        const { editor, image, svg, viewport } = centred((v, s, picture) => {
            picture.style.transform = 'rotate(0deg)';
            v.style.overflow = 'auto';
            s.querySelector('svg').setAttribute('preserveAspectRatio', 'xMinYMin');
            s.querySelector('svg').style.left = '0px';
        });
        const page = () => [
            image.style.transform,
            viewport.style.overflow,
            svg.getAttribute('viewBox'),
            svg.getAttribute('preserveAspectRatio'),
            svg.style.left,
            svg.style.width,
            svg.style.overflow
        ];
        const before = page();
        expect(before).toEqual(['rotate(0deg)', 'auto', '0 0 800 600', 'xMinYMin', '0px', '', '']);
        editor.zoomBy(2);
        expect(page()).toEqual([
            'translate(-400px, -300px) scale(2)',
            'hidden',
            '150 150 500 300',
            'none',
            '-100px',
            '1000px',
            'hidden'
        ]);
        editor.fit();
        expect(page()).toEqual(before);
        editor.zoomBy(2);
        editor.destroy();
        expect(page()).toEqual(before);
    });
});

describe('a picture that its own box crops', () => {
    it('is never shown beyond what the page shows of it at rest', () => {
        // An 800 x 300 picture in a 400 x 300 window that shows its middle, as object-fit: cover does.
        const { editor } = makeStage({
            viewBox: '0 0 800 300',
            viewport: { left: 0, top: 0, width: 400, height: 300 },
            picture: { left: -200, top: 0, width: 800, height: 300 }
        });
        expect(editor.getView()).toEqual({ x: 200, y: 0, width: 400, height: 300, scale: 1 });

        // Asked for the left end, which the window cuts off: the view stops where the window did,
        // a handle's width aside.
        editor.setView({ x: 0, y: 0, width: 200, height: 150 });
        expect(editor.getView()).toEqual({ x: 194, y: 0, width: 200, height: 150, scale: 2 });
        editor.setView({ x: 700, y: 150, width: 100, height: 75 });
        expect(editor.getView()).toEqual({ x: 503, y: 150, width: 100, height: 75, scale: 4 });
    });
});

describe('a viewport the page shares with other things', () => {
    // The page's own viewport, with a toolbar in it next to the stage.
    function shared() {
        const box = { left: 0, top: 0, width: 800, height: 600 };
        const made = makeStage({
            viewport: box,
            picture: box,
            extra: '<nav><button>tool</button></nav>',
            options: { annotations: [BOX] },
            // Styles of the page's own, which the editor borrows and has to give back.
            prepare(viewport, stage) {
                viewport.style.cursor = 'crosshair';
                stage.style.userSelect = 'text';
            }
        });
        return { ...made, button: made.viewport.querySelector('button') };
    }

    it('leaves what the page put there to the page', async () => {
        const { editor, svg, button } = shared();
        const heard = [];
        for (const type of ['canvasclick', 'deselect', 'hover']) editor.on(type, () => heard.push(type));
        editor.select('A');
        editor.zoomBy(2);
        const before = editor.getView();

        click(button, 400, 300);
        press(button, 400, 300);
        move(300, 250);
        release(300, 250);
        const turned = wheel(button, 400, 300, { deltaY: -10, ctrlKey: true });
        pointer('pointermove', button, 400, 300, { buttons: 0 });
        await nextFrame();
        expect(turned.defaultPrevented).toBe(false);
        expect(heard).toEqual([]);
        expect(editor.getView()).toEqual(before);
        expect(editor.getSelection().id).toBe('A');

        // Coming off the picture onto the toolbar, the pointer is no longer over the editor:
        // Space stays the page's.
        pointer('pointermove', svg, 700, 500, { buttons: 0 });
        pointer('pointermove', button, 400, 300, { buttons: 0 });
        expect(key(' ', { code: 'Space' }).defaultPrevented).toBe(false);
        await nextFrame();
        expect(heard).toEqual(['hover']);

        // The picture itself still answers.
        click(svg, 700, 500);
        expect(heard).toEqual(['hover', 'deselect', 'canvasclick']);
    });

    it('keeps a drag from selecting the page, and gives the styles it borrowed back', () => {
        const { editor, viewport, stage, svg } = shared();
        expect(stage.style.userSelect).toBe('none');
        editor.zoomBy(2);
        press(svg, 700, 500);
        move(600, 400);
        expect(viewport.style.cursor).toBe('grabbing');
        release(600, 400);
        expect(viewport.style.cursor).toBe('crosshair');
        editor.destroy();
        expect(stage.style.userSelect).toBe('text');
        expect(viewport.style.cursor).toBe('crosshair');
        expect(viewport.style.overflow).toBe('');
    });
});

describe('an editor that could not be given a viewport', () => {
    it('edits as before and has no view', () => {
        const { editor } = makeEditor({ annotations: [BOX] }, LAID_OVER);
        expect(editor.getContainerElement()).toBe(null);
        expect(editor.getView()).toBe(null);
        expect(editor.zoomBy(2)).toBe(false);
        expect(editor.fit()).toBe(false);
        expect(editor.toImage(100, 100)).toEqual({ x: 100, y: 100 });
        expect(editor.getAnnotations()).toEqual([BOX]);
    });
});

describe('editing while zoomed in', () => {
    // Small things around the middle of the image, so they stay in view at 16x.
    const THINGS = [
        { id: 'box', bbox: [780, 590, 40, 20] },
        {
            id: 'shape',
            segments: [
                [790, 560],
                [820, 560],
                [805, 580]
            ]
        },
        { id: 'dot', keypoints: [{ name: 'tip', point: [770, 620] }] }
    ];
    const near = (actual, expected) => actual.forEach((n, i) => expect(n).toBeCloseTo(expected[i], 6));

    for (const zoom of [1, 4, 16]) {
        describe(`at ${zoom}x`, () => {
            const start = () => {
                const made = makeEditor({ annotations: THINGS }, HALF);
                made.editor.zoomBy(zoom, { x: 800, y: 600 });
                expect(made.editor.getView().scale).toBe(zoom / 2);
                // Drag `target` from one image point to another, in two moves.
                made.pull = (target, from, to) => drag(target, screenOf(made.svg, ...from), screenOf(made.svg, ...to));
                return made;
            };

            it('moves a box by the distance the pointer travels in the image', () => {
                const { editor, svg, pull } = start();
                editor.select('box');
                pull(bboxEl(svg, 'box'), [800, 600], [812, 595]);
                near(editor.getAnnotation('box').bbox, [792, 585, 40, 20]);
            });

            it('resizes a box by its corner', () => {
                const { editor, svg, pull } = start();
                editor.select('box');
                pull(handleEl(svg, 'se'), [820, 610], [828, 616]);
                near(editor.getAnnotation('box').bbox, [780, 590, 48, 26]);
                pull(handleEl(svg, 'nw'), [780, 590], [772, 596]);
                near(editor.getAnnotation('box').bbox, [772, 596, 56, 20]);
            });

            it('moves one vertex of a polygon', () => {
                const { editor, svg, pull } = start();
                editor.select('shape', 'polygon');
                pull(handleEl(svg, 'vertex', 2), [805, 580], [800, 586]);
                const moved = editor.getAnnotation('shape').segments;
                near(moved[2], [800, 586]);
                expect(moved.slice(0, 2)).toEqual(THINGS[1].segments.slice(0, 2));
                pull(polygonEl(svg, 'shape'), [805, 565], [795, 570]);
                near(editor.getAnnotation('shape').segments[0], [780, 565]);
            });

            it('moves a keypoint', () => {
                const { editor, svg, pull } = start();
                const at = screenOf(svg, 770, 620);
                click(keypointEl(svg, 'dot', 0), at[0], at[1]);
                expect(editor.getSelection()).toMatchObject({ id: 'dot', part: 'keypoint', index: 0 });
                pull(keypointEl(svg, 'dot', 0), [770, 620], [775, 612]);
                near(editor.getAnnotation('dot').keypoints[0].point, [775, 612]);
            });

            it('still takes three pixels on screen to start a drag, and a click still selects', () => {
                const { editor, svg } = start();
                const [x, y] = screenOf(svg, 800, 600);
                click(bboxEl(svg, 'box'), x, y);
                expect(editor.getSelection().id).toBe('box');
                press(bboxEl(svg, 'box'), x, y);
                move(x + 2, y);
                release(x + 2, y);
                expect(editor.getAnnotation('box')).toEqual(THINGS[0]);
            });

            it('reports clicks on the canvas where they are in the image', () => {
                const { editor, svg } = start();
                const clicks = [];
                editor.on('canvasclick', (e) => clicks.push(e.position));
                const [x, y] = screenOf(svg, 815, 630);
                click(svg, x, y);
                near([clicks[0].x, clicks[0].y], [815, 630]);
            });

            it('nudges by one image pixel, whatever the zoom', () => {
                const { editor } = start();
                editor.select('box');
                key('ArrowRight');
                key('ArrowDown', { shiftKey: true });
                keyUp('ArrowDown');
                expect(editor.getAnnotation('box').bbox).toEqual([781, 600, 40, 20]);
            });

            it('keeps a handle five pixels on screen', () => {
                const { editor, svg } = start();
                editor.select('box');
                expect(num(svg.querySelector('.markin-handle'), 'r') * editor.getView().scale).toBeCloseTo(5, 6);
            });
        });
    }

    it('stops a drag at the edge of the image, also when the edge is out of view', () => {
        const { editor, svg } = makeEditor({ annotations: THINGS }, HALF);
        editor.zoomBy(4, { x: 800, y: 600 });
        editor.select('box');
        const a = screenOf(svg, 800, 600);
        press(bboxEl(svg, 'box'), a[0], a[1]);
        move(a[0] + 5000, a[1] + 5000);
        release(a[0] + 5000, a[1] + 5000);
        expect(editor.getAnnotation('box').bbox).toEqual([1560, 1180, 40, 20]);
    });
});
