import { describe, it, expect } from 'vitest';
import {
    MarkinJS,
    makeEditor,
    track,
    setBox,
    screenOf,
    press,
    move,
    release,
    click,
    key,
    keyUp,
    bboxEl,
    polygonEl,
    keypointEl,
    handleEl,
    num,
    nextFrame,
    BOX,
    SVG_NS
} from './setup.js';

// A 1600 x 1200 image shown at 800 x 600, 20px from the top-left of the page:
// at rest one image pixel is half a pixel on screen.
const HALF = { viewBox: '0 0 1600 1200', box: { left: 20, top: 20, width: 800, height: 600 } };

const stageOf = (editor) => editor.getContainerElement().firstChild;
// What the library wrote on the page for the current view.
const written = (editor) => ({
    transform: stageOf(editor).style.transform,
    overflow: editor.getContainerElement().style.overflow
});

describe('the view at rest', () => {
    it('is the whole image, with nothing written on the page', () => {
        const { editor } = makeEditor({}, HALF);
        expect(editor.getView()).toEqual({ x: 0, y: 0, width: 1600, height: 1200, scale: 0.5 });
        expect(written(editor)).toEqual({ transform: '', overflow: '' });
    });

    it('cannot be zoomed out of, and fit() returns to it', () => {
        const { editor } = makeEditor({}, HALF);
        expect(editor.zoomBy(0.25)).toBe(true);
        expect(written(editor)).toEqual({ transform: '', overflow: '' });

        editor.zoomBy(3);
        expect(written(editor).overflow).toBe('hidden');
        expect(editor.fit()).toBe(true);
        expect(editor.getView()).toEqual({ x: 0, y: 0, width: 1600, height: 1200, scale: 0.5 });
        expect(written(editor)).toEqual({ transform: '', overflow: '' });
    });
});

describe('zoomBy', () => {
    it('zooms around the middle of the view', () => {
        const { editor } = makeEditor({}, HALF);
        editor.zoomBy(2);
        expect(editor.getView()).toEqual({ x: 400, y: 300, width: 800, height: 600, scale: 1 });
        expect(written(editor)).toEqual({ transform: 'translate(-400px, -300px) scale(2)', overflow: 'hidden' });
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
        expect(written(editor).transform).toBe('');
    });

    it('rejects a factor or a point that makes no sense', () => {
        const { editor, log } = makeEditor({}, HALF);
        expect(editor.zoomBy(0)).toBe(false);
        expect(editor.zoomBy('2')).toBe(false);
        expect(editor.zoomBy(2, { x: 1 })).toBe(false);
        expect(written(editor).transform).toBe('');
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
        expect(written(editor).transform).toBe('translate(-800px, -600px) scale(4)');
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
        expect(written(editor).transform).toBe('translate(12px, 12px) scale(2)');
        expect(editor.getView()).toEqual({ x: 0, y: 0, width: 788, height: 588, scale: 1 });
    });

    it('rejects anything but a rectangle with a size', () => {
        const { editor, log } = makeEditor({}, HALF);
        for (const bad of [null, {}, { x: 0, y: 0, width: 0, height: 10 }, { x: 0, y: 0, width: '5', height: 5 }]) {
            expect(editor.setView(bad)).toBe(false);
        }
        expect(log.length).toBe(4);
        expect(written(editor).transform).toBe('');
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
        expect(editor.toClient(800, 600)).toEqual({ x: 420, y: 320 });
        expect(editor.toClient(780, 590)).toEqual({ x: 60, y: 140 });
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
        expect(written(editor).transform).toBe('');
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
        expect(written(editor).transform).toBe('translate(-200px, -150px) scale(2)');
    });

    it('goes back to the whole image when the picture is replaced', () => {
        const image = document.createElement('img');
        const size = { width: 1600, height: 1200 };
        Object.defineProperty(image, 'naturalWidth', { get: () => size.width });
        Object.defineProperty(image, 'naturalHeight', { get: () => size.height });
        document.body.appendChild(image);
        const editor = track(MarkinJS.create(image, { silent: true }));
        setBox(editor.getSVGElement(), HALF.box);
        editor.zoomBy(2);
        expect(editor.getView()).toEqual({ x: 400, y: 300, width: 800, height: 600, scale: 1 });

        // The browser reports the load of an image it already had: the same picture, the same view.
        image.dispatchEvent(new Event('load'));
        expect(editor.getView()).toEqual({ x: 400, y: 300, width: 800, height: 600, scale: 1 });

        size.width = 800;
        size.height = 600;
        image.dispatchEvent(new Event('load'));
        expect(editor.getView()).toEqual({ x: 0, y: 0, width: 800, height: 600, scale: 1 });
        expect(written(editor)).toEqual({ transform: '', overflow: '' });
    });

    it('zooms an <svg> that has no viewBox, in its own pixels', () => {
        const real = window.getComputedStyle;
        try {
            const { editor, svg } = makeEditor({}, { viewBox: null });
            // Without a viewBox one unit is one CSS pixel, so the size CSS gives the <svg> matters.
            window.getComputedStyle = (el) => (el === svg ? { width: '800px', height: '600px' } : real(el));
            expect(editor.getView()).toEqual({ x: 0, y: 0, width: 800, height: 600, scale: 1 });
            editor.zoomBy(2);
            expect(editor.getView()).toEqual({ x: 200, y: 150, width: 400, height: 300, scale: 2 });
        } finally {
            window.getComputedStyle = real;
        }
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
    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    // An editor whose view events are collected from the start. The view settles after 30ms.
    function watched(options, svgOptions = HALF) {
        const made = makeEditor({ settleDelay: 30, ...options }, svgOptions);
        made.changes = [];
        made.settles = [];
        made.editor.on('viewchange', (view) => made.changes.push(view));
        made.editor.on('viewsettle', (view) => made.settles.push(view));
        return made;
    }
    const WHOLE = { x: 0, y: 0, width: 1600, height: 1200, scale: 0.5 };

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
        const image = document.createElement('img');
        let address = 'first.jpg';
        Object.defineProperty(image, 'naturalWidth', { get: () => 1600 });
        Object.defineProperty(image, 'naturalHeight', { get: () => 1200 });
        Object.defineProperty(image, 'currentSrc', { get: () => address });
        document.body.appendChild(image);
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
    function centred(prepare) {
        const viewport = document.createElement('section');
        const stage = document.createElement('div');
        stage.setAttribute('data-markin-stage', '');
        if (prepare) prepare(viewport, stage);
        const svg = document.createElementNS(SVG_NS, 'svg');
        svg.setAttribute('viewBox', '0 0 800 600');
        stage.appendChild(svg);
        viewport.appendChild(stage);
        document.body.appendChild(viewport);
        setBox(viewport, { left: 0, top: 0, width: 1000, height: 600 });
        setBox(stage, { left: 100, top: 0, width: 800, height: 600 });
        setBox(svg, { left: 100, top: 0, width: 800, height: 600 });
        const editor = track(MarkinJS.create(svg, { silent: true }));
        return { editor, viewport, stage };
    }

    it('grows a picture that is smaller than the viewport from where it stands', () => {
        const { editor, stage, viewport } = centred();
        expect(editor.getView()).toEqual({ x: 0, y: 0, width: 800, height: 600, scale: 1 });
        // 880 wide: still centred. 660 high: more than the viewport, so the middle is shown.
        editor.zoomBy(1.1);
        expect(stage.style.transform).toBe('translate(-40px, -30px) scale(1.1)');
        expect(viewport.style.overflow).toBe('hidden');
        const view = editor.getView();
        expect([view.x, view.width]).toEqual([0, 800]);

        // 1600 wide: now it can be moved, and the view is a part of it.
        editor.fit();
        editor.zoomBy(2);
        expect(editor.getView()).toEqual({ x: 150, y: 150, width: 500, height: 300, scale: 2 });
    });

    it('gives the page its own styles back', () => {
        const { editor, stage, viewport } = centred((v, s) => {
            s.style.transform = 'rotate(0deg)';
            v.style.overflow = 'auto';
        });
        editor.zoomBy(2);
        expect(viewport.style.overflow).toBe('hidden');
        expect(stage.style.transform).toBe('translate(-400px, -300px) scale(2)');
        editor.fit();
        expect(stage.style.transform).toBe('rotate(0deg)');
        expect(viewport.style.overflow).toBe('auto');
        editor.zoomBy(2);
        editor.destroy();
        expect(stage.style.transform).toBe('rotate(0deg)');
        expect(viewport.style.overflow).toBe('auto');
    });
});

describe('an editor that could not be given a viewport', () => {
    it('edits as before and has no view', () => {
        const real = window.getComputedStyle;
        try {
            const svg = document.createElementNS(SVG_NS, 'svg');
            svg.setAttribute('viewBox', '0 0 800 600');
            document.body.appendChild(svg);
            setBox(svg, { left: 0, top: 0, width: 800, height: 600 });
            window.getComputedStyle = (el) => (el === svg ? { position: 'absolute' } : real(el));
            const editor = track(MarkinJS.create(svg, { silent: true, annotations: [BOX] }));
            expect(editor.getView()).toBe(null);
            expect(editor.zoomBy(2)).toBe(false);
            expect(editor.fit()).toBe(false);
            expect(editor.toImage(100, 100)).toEqual({ x: 100, y: 100 });
        } finally {
            window.getComputedStyle = real;
        }
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
                made.pull = (target, from, to) => {
                    const a = screenOf(made.svg, from[0], from[1]);
                    const b = screenOf(made.svg, to[0], to[1]);
                    press(target, a[0], a[1]);
                    move((a[0] + b[0]) / 2, (a[1] + b[1]) / 2);
                    move(b[0], b[1]);
                    release(b[0], b[1]);
                };
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
