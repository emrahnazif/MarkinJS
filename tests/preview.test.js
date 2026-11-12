import { describe, it, expect } from 'vitest';
import {
    MarkinJS,
    makeEditor,
    makeImage,
    track,
    click,
    pointer,
    bboxEl,
    screenOf,
    nextFrame,
    boxOf,
    BOX,
    OTHER,
    HALF
} from './setup.js';

const BLOB = {
    class_id: 1,
    bbox: [300, 200, 200, 100],
    segments: [
        [300, 200],
        [500, 200],
        [400, 300]
    ]
};
const SMALL = { bbox: [10, 20, 30, 40] };

const group = (svg) => svg.querySelector('.markin-preview');
const rect = (svg) => group(svg).querySelector('rect');
const polygon = (svg) => group(svg).querySelector('polygon');
const seen = (el) => el.getAttribute('display') !== 'none';

describe('setPreview', () => {
    it('draws the bbox and the polygon of a shape, in image pixels and in the colour of its class', () => {
        const { editor, svg } = makeEditor({ colors: { 1: '#ff0000' } });
        expect(editor.setPreview(BLOB)).toBe(true);
        expect(boxOf(rect(svg))).toEqual([300, 200, 200, 100]);
        expect(polygon(svg).getAttribute('points')).toBe('300,200 500,200 400,300');
        expect(group(svg).getAttribute('stroke')).toBe('#ff0000');
        expect(group(svg).getAttribute('fill')).toBe('#ff0000');
        expect(group(svg).getAttribute('data-class-id')).toBe('1');
        // It is told from an annotation by its dashes, and lies in the layer the annotations are in.
        expect(group(svg).getAttribute('stroke-dasharray')).toBeTruthy();
        expect(group(svg).parentNode).toBe(svg.querySelector('.markin-layer'));
    });

    it('is no annotation: no data, no change, no undo step, nothing to select', () => {
        const { editor, svg } = makeEditor({ annotations: [BOX] });
        const before = editor.getAnnotations();
        const changes = [];
        editor.on('change', (...args) => changes.push(args));
        editor.setPreview(BLOB);
        editor.setPreview(SMALL);
        editor.setPreview(null);
        editor.setPreview(BLOB);
        expect(editor.getAnnotations()).toEqual(before);
        expect(changes).toEqual([]);
        expect(editor.canUndo()).toBe(false);
        expect(editor.getSelection()).toBe(null);
        expect(group(svg).querySelector('[data-markin-part], [data-markin-id]')).toBe(null);
    });

    it('shows one shape at a time, and null or nothing takes it away', () => {
        const { editor, svg } = makeEditor();
        editor.setPreview(BLOB);
        editor.setPreview(SMALL);
        expect(svg.querySelectorAll('.markin-preview').length).toBe(1);
        expect(boxOf(rect(svg))).toEqual([10, 20, 30, 40]);
        // The second shape has no polygon, so the one of the first is not shown any more.
        expect(seen(polygon(svg))).toBe(false);
        editor.setPreview({ segments: BLOB.segments });
        expect(seen(polygon(svg))).toBe(true);
        expect(seen(rect(svg))).toBe(false);
        expect(editor.setPreview(null)).toBe(true);
        expect(group(svg)).toBe(null);
        editor.setPreview(SMALL);
        expect(editor.setPreview()).toBe(true);
        expect(group(svg)).toBe(null);
    });

    it('reports a shape it cannot draw and keeps the one it shows', () => {
        const { editor, svg, log } = makeEditor();
        editor.setPreview(SMALL);
        expect(editor.setPreview({ bbox: [1, 2, 3] })).toBe(false);
        expect(editor.setPreview({ keypoints: [{ point: [5, 5] }] })).toBe(false);
        expect(editor.setPreview('blob')).toBe(false);
        expect(log.length).toBe(3);
        expect(log[0]).toMatch(/^error: setPreview: bbox must be/);
        expect(log[1]).toBe('error: setPreview: a preview needs a bbox or segments');
        expect(boxOf(rect(svg))).toEqual([10, 20, 30, 40]);
    });

    it('lets the pointer through: what is under it is still clicked and hovered', async () => {
        const { editor, svg } = makeEditor({ annotations: [BOX] });
        const clicks = [];
        editor.on('canvasclick', (e) => clicks.push(e.position));
        const hovers = [];
        editor.on('hover', (h) => hovers.push(h.id));
        // Over the whole of BOX, and over empty canvas beside it.
        editor.setPreview({ bbox: [50, 50, 600, 400] });
        expect(group(svg).getAttribute('pointer-events')).toBe('none');
        click(svg, 500, 400);
        expect(clicks).toEqual([{ x: 500, y: 400 }]);
        const [x, y] = screenOf(svg, 200, 150);
        click(bboxEl(svg, 'A'), x, y);
        expect(editor.getSelection().id).toBe('A');
        pointer('pointermove', bboxEl(svg, 'A'), x, y, { buttons: 0 });
        await nextFrame();
        expect(hovers).toEqual(['A']);
    });

    it('works in a disabled editor', () => {
        const { editor, svg } = makeEditor();
        editor.disable();
        expect(editor.setPreview(BLOB)).toBe(true);
        expect(seen(rect(svg))).toBe(true);
    });

    it('stays through load() and clear(), and goes with the editor', () => {
        const { editor, svg } = makeEditor({ annotations: [BOX] });
        editor.setPreview(SMALL);
        editor.load([OTHER]);
        editor.clear();
        editor.undo();
        expect(boxOf(rect(svg))).toEqual([10, 20, 30, 40]);
        editor.destroy();
        expect(group(svg)).toBe(null);
        expect(editor.setPreview(SMALL)).toBe(false);
        expect(group(svg)).toBe(null);
    });

    it('keeps its place in the image through zooms, with outlines and dashes as wide on screen', () => {
        const { editor, svg } = makeEditor({ strokeWidth: 2 }, HALF);
        editor.setPreview(BLOB);
        const dash = () => parseFloat(group(svg).getAttribute('stroke-dasharray'));
        // Half size on screen: 3 px of dash are 6 units of the image.
        expect(dash()).toBeCloseTo(6, 6);
        editor.zoomBy(4);
        expect(dash()).toBeCloseTo(1.5, 6);
        editor.setView({ x: 250, y: 150, width: 300, height: 200 });
        expect(boxOf(rect(svg))).toEqual([300, 200, 200, 100]);
        expect(polygon(svg).getAttribute('points')).toBe('300,200 500,200 400,300');
        editor.fit();
        expect(dash()).toBeCloseTo(6, 6);
    });

    it('takes the colour of new options', () => {
        const { editor, svg } = makeEditor({ colors: { 1: '#ff0000' } });
        editor.setPreview(BLOB);
        editor.setOptions({ colors: { 1: '#00ff00' } });
        expect(group(svg).getAttribute('stroke')).toBe('#00ff00');
    });

    it('goes when the <img> shows another picture, which its coordinates are not of', async () => {
        const { image, load } = makeImage({ width: 800, height: 600 });
        const editor = track(MarkinJS.create(image, { silent: true }));
        const svg = editor.getSVGElement();
        editor.setPreview(SMALL);
        // The same picture laid out again keeps it.
        editor.refresh();
        expect(boxOf(rect(svg))).toEqual([10, 20, 30, 40]);
        load(4000, 3000);
        await nextFrame();
        expect(group(svg)).toBe(null);
    });
});
