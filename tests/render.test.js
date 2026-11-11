import { describe, it, expect } from 'vitest';
import { makeEditor, click, drag, bboxEl, polygonEl, keypointEl, handles, num } from './setup.js';

const POSE = {
    id: 'P',
    class_id: 1,
    bbox: [100, 100, 200, 200],
    segments: [
        [120, 120],
        [280, 120],
        [280, 280]
    ],
    keypoints: [
        { name: 'head', point: [150, 150], v: 2 },
        { name: 'neck', point: [200, 200], v: 1 },
        { name: 'hip', point: [250, 250] },
        { name: 'hidden', point: [0, 0], v: 0 }
    ]
};

const lines = (svg) =>
    Array.from(svg.querySelectorAll('.markin-skeleton line'), (l) => ['x1', 'y1', 'x2', 'y2'].map((a) => num(l, a)));

describe('what gets drawn', () => {
    it('one rect, one polygon and one circle per keypoint, with hooks for CSS', () => {
        const { svg } = makeEditor({ annotations: [POSE] });
        const rect = bboxEl(svg, 'P');
        expect(['x', 'y', 'width', 'height'].map((a) => num(rect, a))).toEqual([100, 100, 200, 200]);
        expect(rect.getAttribute('class')).toBe('markin-bbox');
        expect(polygonEl(svg, 'P').getAttribute('points')).toBe('120,120 280,120 280,280');
        expect(polygonEl(svg, 'P').getAttribute('class')).toBe('markin-polygon');
        const head = keypointEl(svg, 'P', 0);
        expect([num(head, 'cx'), num(head, 'cy')]).toEqual([150, 150]);
        expect(head.getAttribute('class')).toBe('markin-keypoint');
        expect(head.getAttribute('data-name')).toBe('head');
        expect(head.getAttribute('data-v')).toBe('2');
        expect(rect.parentNode.getAttribute('class')).toBe('markin-annotation');
        expect(rect.parentNode.getAttribute('data-class-id')).toBe('1');
    });

    it('colours by class_id, with a default for everything else', () => {
        const { editor, svg } = makeEditor({
            colors: { 1: '#ff0000', cat: 'rgb(0, 128, 0)' },
            color: '#123456',
            annotations: [
                { id: 'one', class_id: 1, bbox: [0, 0, 10, 10], keypoints: [{ point: [5, 5] }] },
                { id: 'cat', class_id: 'cat', bbox: [20, 0, 10, 10] },
                { id: 'other', class_id: 9, bbox: [40, 0, 10, 10] },
                { id: 'none', bbox: [60, 0, 10, 10] }
            ]
        });
        const stroke = (id) => bboxEl(svg, id).getAttribute('stroke');
        expect([stroke('one'), stroke('cat'), stroke('other'), stroke('none')]).toEqual([
            '#ff0000',
            'rgb(0, 128, 0)',
            '#123456',
            '#123456'
        ]);
        expect(bboxEl(svg, 'one').getAttribute('fill')).toBe('#ff0000');
        expect(keypointEl(svg, 'one', 0).getAttribute('stroke')).toBe('#ff0000');

        editor.setOptions({ colors: { 9: '#00ffff' } });
        expect([stroke('one'), stroke('other')]).toEqual(['#123456', '#00ffff']);
        editor.updateAnnotation('none', { class_id: 9 });
        expect(stroke('none')).toBe('#00ffff');
    });

    it('shows keypoint visibility: 2 solid, 1 dashed and hollow, 0 not drawn', () => {
        const { svg } = makeEditor({ annotations: [POSE] });
        const look = (i) => {
            const c = keypointEl(svg, 'P', i);
            return [c.getAttribute('fill-opacity'), c.hasAttribute('stroke-dasharray'), c.getAttribute('display')];
        };
        expect(look(0)).toEqual(['0.7', false, null]);
        expect(look(1)).toEqual(['0.15', true, null]);
        expect(look(2)).toEqual(['0.7', false, null]);
        expect(look(3)).toEqual(['0.7', false, 'none']);
    });

    it('updates in place when the data changes', () => {
        const { editor, svg } = makeEditor({ annotations: [POSE] });
        const rect = bboxEl(svg, 'P');
        editor.updateAnnotation('P', { bbox: [50, 60, 70, 80], keypoints: [POSE.keypoints[0]], segments: null });
        expect(bboxEl(svg, 'P')).toBe(rect);
        expect(['x', 'y', 'width', 'height'].map((a) => num(rect, a))).toEqual([50, 60, 70, 80]);
        expect(svg.querySelectorAll('[data-markin-part="keypoint"]').length).toBe(1);
        expect(polygonEl(svg, 'P')).toBe(null);
    });
});

describe('a polygon outline', () => {
    it('follows its points through an update, a drag and an undo', () => {
        const { editor, svg } = makeEditor({ annotations: [POSE], bindElements: false });
        const polygon = polygonEl(svg, 'P');
        expect(polygon.getAttribute('points')).toBe('120,120 280,120 280,280');

        editor.updateAnnotation('P', {
            segments: [
                [130, 130],
                [280, 120],
                [280, 280]
            ]
        });
        expect(polygon.getAttribute('points')).toBe('130,130 280,120 280,280');

        click(polygon, 260, 200);
        drag(polygon, [260, 200], [270, 220]);
        expect(polygon.getAttribute('points')).toBe('140,150 290,140 290,300');

        editor.undo();
        editor.undo();
        expect(polygon.getAttribute('points')).toBe('120,120 280,120 280,280');
    });
});

describe('selection chrome', () => {
    it('a selected box is dashed and gets four corner handles', () => {
        const { editor, svg } = makeEditor({ annotations: [POSE] });
        editor.select('P', 'bbox');
        expect(bboxEl(svg, 'P').getAttribute('stroke-dasharray')).toBe('5 5');
        expect(bboxEl(svg, 'P').getAttribute('data-selected')).toBe('true');
        expect(polygonEl(svg, 'P').hasAttribute('stroke-dasharray')).toBe(false);
        expect(handles(svg).map((h) => [h.getAttribute('data-markin-handle'), num(h, 'cx'), num(h, 'cy')])).toEqual([
            ['nw', 100, 100],
            ['ne', 300, 100],
            ['sw', 100, 300],
            ['se', 300, 300]
        ]);
    });

    it('a selected polygon gets one handle per vertex', () => {
        const { editor, svg } = makeEditor({ annotations: [POSE] });
        editor.select('P', 'polygon');
        expect(handles(svg).map((h) => [num(h, 'cx'), num(h, 'cy')])).toEqual(POSE.segments);
        expect(bboxEl(svg, 'P').hasAttribute('stroke-dasharray')).toBe(false);
    });

    it('a selected keypoint opens into a ring with a crosshair, and closes again', () => {
        const { editor, svg } = makeEditor({ annotations: [POSE] });
        const head = keypointEl(svg, 'P', 0);
        expect(num(head, 'r')).toBe(5);
        editor.select('P', 'keypoint', 0);
        expect(num(head, 'r')).toBe(15);
        expect(head.getAttribute('fill-opacity')).toBe('0.05');
        expect(svg.querySelectorAll('.markin-ui line').length).toBe(2);
        expect(handles(svg).length).toBe(0);
        editor.deselect();
        expect(num(head, 'r')).toBe(5);
        expect(head.getAttribute('fill-opacity')).toBe('0.7');
        expect(svg.querySelectorAll('.markin-ui *').length).toBe(0);
    });

    it('the ring does not change where a keypoint may go', () => {
        const { editor, svg } = makeEditor({ annotations: [POSE] });
        click(keypointEl(svg, 'P', 0), 150, 150);
        drag(keypointEl(svg, 'P', 0), [150, 150], [104, 104]); // closer to the edge than the ring is wide
        expect(editor.getAnnotation('P').keypoints[0].point).toEqual([104, 104]);
    });

    it('a whole annotation without a box gets an outline', () => {
        const { editor, svg } = makeEditor({
            annotations: [{ id: 'K', keypoints: [{ point: [50, 50] }, { point: [90, 70] }] }]
        });
        editor.select('K');
        const outline = Array.from(svg.querySelectorAll('.markin-ui line'));
        expect(outline.length).toBe(4);
        expect([num(outline[0], 'x1'), num(outline[0], 'y1'), num(outline[0], 'x2')]).toEqual([44, 44, 96]);
    });

    it('nothing in the selection layer takes part in the data', () => {
        const { editor } = makeEditor({ annotations: [POSE] });
        editor.select('P', 'polygon');
        expect(editor.getAnnotations()).toEqual([POSE]);
    });
});

describe('skeleton', () => {
    it('joins keypoints by name or index and skips what it cannot draw', () => {
        const { svg } = makeEditor({
            annotations: [POSE],
            skeleton: [
                ['head', 'neck'],
                [1, 2],
                ['hip', 'hidden'], // v = 0: not drawn
                ['head', 'elbow'], // no such keypoint
                [0, 9], // no such index
                [2, 2] // a point to itself
            ]
        });
        expect(lines(svg)).toEqual([
            [150, 150, 200, 200],
            [200, 200, 250, 250]
        ]);
    });

    it('is never a click target', () => {
        const { editor, svg } = makeEditor({ annotations: [POSE], skeleton: [['head', 'hip']] });
        const group = svg.querySelector('.markin-skeleton');
        expect(group.getAttribute('pointer-events')).toBe('none');
        expect(group.querySelector('[data-markin-part]')).toBe(null);
        // Even if a browser delivered the press, it is not one of the annotation's parts.
        click(group.firstChild, 200, 200);
        expect(editor.getSelection()).toBe(null);
    });

    it('follows its keypoints', () => {
        const { editor, svg } = makeEditor({ annotations: [POSE], skeleton: [['head', 'hip']] });
        click(keypointEl(svg, 'P', 0), 150, 150);
        drag(keypointEl(svg, 'P', 0), [150, 150], [180, 130]);
        expect(lines(svg)).toEqual([[180, 130, 250, 250]]);
        editor.select('P', 'bbox');
        drag(bboxEl(svg, 'P'), [110, 110], [120, 110]);
        expect(lines(svg)).toEqual([[190, 130, 260, 250]]);
    });

    it('applies skeletonStyle, including the dash pattern', () => {
        const { svg } = makeEditor({
            annotations: [POSE],
            skeleton: [[0, 1]],
            skeletonStyle: { stroke: '#00ff00', strokeWidth: 3, strokeOpacity: 0.5, strokeDasharray: '4 2' }
        });
        const line = svg.querySelector('.markin-skeleton line');
        expect(line.getAttribute('stroke')).toBe('#00ff00');
        expect(line.getAttribute('stroke-width')).toBe('3');
        expect(line.getAttribute('stroke-opacity')).toBe('0.5');
        expect(line.getAttribute('stroke-dasharray')).toBe('4 2');
    });

    it('can be changed or removed at run time, and is not part of the data', () => {
        const { editor, svg } = makeEditor({ annotations: [POSE], skeleton: [[0, 1]] });
        expect(lines(svg).length).toBe(1);
        editor.setOptions({
            skeleton: [
                [0, 1],
                [1, 2]
            ]
        });
        expect(lines(svg).length).toBe(2);
        editor.setOptions({ skeleton: null });
        expect(svg.querySelector('.markin-skeleton')).toBe(null);
        expect(editor.getAnnotations()).toEqual([POSE]);
    });
});
