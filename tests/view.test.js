import { describe, it, expect } from 'vitest';
import { MarkinJS, makeEditor, track, setBox, handleEl, num, BOX, SVG_NS } from './setup.js';

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
