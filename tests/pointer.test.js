import { describe, it, expect } from 'vitest';
import {
    makeEditor,
    setBox,
    pointer,
    press,
    move,
    release,
    click,
    drag,
    key,
    bboxEl,
    polygonEl,
    keypointEl,
    handleEl,
    handles,
    num,
    nextFrame,
    BOX,
    OTHER
} from './setup.js';

// x 100..300, y 100..200 in an 800 x 600 image
const POSE = {
    id: 'P',
    bbox: [100, 100, 200, 200],
    segments: [
        [120, 120],
        [280, 120],
        [280, 280],
        [120, 280]
    ],
    keypoints: [
        { name: 'a', point: [150, 150] },
        { name: 'b', point: [250, 250] }
    ]
};

describe('selecting', () => {
    it('a click selects the part and says which annotation it belongs to', () => {
        const { editor, svg } = makeEditor({ annotations: [POSE] });
        const events = [];
        editor.on('select', (e) => events.push(e));

        click(keypointEl(svg, 'P', 1), 250, 250);

        expect(events.length).toBe(1);
        expect(events[0]).toEqual({ id: 'P', part: 'keypoint', index: 1, annotation: POSE });
        expect(editor.getSelection()).toEqual(events[0]);
    });

    it('clicking what is already selected emits nothing', () => {
        const { editor, svg } = makeEditor({ annotations: [BOX] });
        click(bboxEl(svg, 'A'), 150, 150);
        const events = [];
        editor.on('select', (e) => events.push(e));
        editor.on('deselect', (e) => events.push(e));
        click(bboxEl(svg, 'A'), 150, 150);
        click(bboxEl(svg, 'A'), 160, 150);
        expect(events).toEqual([]);
    });

    it('moving to another part emits deselect, then select', () => {
        const { editor, svg } = makeEditor({ annotations: [POSE] });
        click(bboxEl(svg, 'P'), 110, 110);
        const order = [];
        editor.on('deselect', (e) => order.push(['deselect', e.part]));
        editor.on('select', (e) => order.push(['select', e.part]));
        click(polygonEl(svg, 'P'), 200, 200);
        expect(order).toEqual([
            ['deselect', 'bbox'],
            ['select', 'polygon']
        ]);
    });

    it('a click on the empty canvas deselects and always emits canvasclick', () => {
        const { editor, svg } = makeEditor({ annotations: [BOX] });
        const clicks = [];
        editor.on('canvasclick', (e) => clicks.push(e));

        click(svg, 500, 400); // nothing selected yet
        editor.select('A');
        click(svg, 510, 410);

        expect(clicks).toEqual([{ position: { x: 500, y: 400 } }, { position: { x: 510, y: 410 } }]);
        expect(editor.getSelection()).toBe(null);
    });

    it('dragging across the empty canvas is not a click', () => {
        const { editor, svg } = makeEditor({ annotations: [BOX] });
        editor.select('A');
        const clicks = [];
        editor.on('canvasclick', (e) => clicks.push(e));
        drag(svg, [500, 400], [600, 450]); // e.g. the host panning the image
        expect(clicks).toEqual([]);
        expect(editor.getSelection().id).toBe('A');
    });

    it('select() works from code and validates the part', () => {
        const { editor, svg, log } = makeEditor({ annotations: [POSE, { id: 'K', keypoints: [{ point: [5, 5] }] }] });
        expect(editor.select('P')).toBe(true);
        expect(editor.getSelection().part).toBe('bbox');
        expect(handles(svg).length).toBe(4);
        expect(editor.select('P', 'keypoint', 1)).toBe(true);
        expect(editor.getSelection().index).toBe(1);
        expect(editor.select('K')).toBe(true);
        expect(editor.getSelection()).toMatchObject({ id: 'K', part: null, index: null });

        expect(editor.select('P', 'keypoint', 7)).toBe(false);
        expect(editor.select('K', 'bbox')).toBe(false);
        expect(editor.select('P', 'circle')).toBe(false);
        expect(editor.select('missing')).toBe(false);
        expect(log.length).toBe(4);
        expect(editor.getSelection().id).toBe('K');
    });

    it('createAnnotation selects the new annotation unless told not to', () => {
        const { editor } = makeEditor();
        editor.createAnnotation(BOX);
        expect(editor.getSelection()).toMatchObject({ id: 'A', part: 'bbox' });
        editor.createAnnotation({ id: 'B', bbox: [1, 2, 3, 4] }, { select: false });
        expect(editor.getSelection().id).toBe('A');
    });
});

describe('moving', () => {
    it('drags a selected box by exactly the pointer travel', () => {
        const { editor, svg } = makeEditor({ annotations: [BOX] });
        editor.select('A');
        drag(bboxEl(svg, 'A'), [150, 150], [200, 180]);
        expect(editor.getAnnotation('A').bbox).toEqual([150, 130, 200, 100]);
        expect(num(bboxEl(svg, 'A'), 'x')).toBe(150);
    });

    it('by default the first press selects and the next one drags', () => {
        const { editor, svg } = makeEditor({ annotations: [BOX] });
        drag(bboxEl(svg, 'A'), [150, 150], [250, 150]);
        expect(editor.getAnnotation('A')).toEqual(BOX);
        expect(editor.getSelection().id).toBe('A');
        drag(bboxEl(svg, 'A'), [150, 150], [250, 150]);
        expect(editor.getAnnotation('A').bbox).toEqual([200, 100, 200, 100]);
    });

    it('with requireSelectionToDrag off, the first press drags', () => {
        const { editor, svg } = makeEditor({ annotations: [BOX], requireSelectionToDrag: false });
        drag(bboxEl(svg, 'A'), [150, 150], [250, 150]);
        expect(editor.getAnnotation('A').bbox).toEqual([200, 100, 200, 100]);
    });

    it('a shaky click does not move anything or create an undo step', () => {
        const { editor, svg } = makeEditor({ annotations: [BOX] });
        editor.select('A');
        let changes = 0;
        editor.on('change', () => changes++);
        press(bboxEl(svg, 'A'), 150, 150);
        move(151, 151);
        move(152, 150);
        release(152, 150);
        expect(editor.getAnnotation('A')).toEqual(BOX);
        expect(changes).toBe(0);
        expect(editor.canUndo()).toBe(false);
    });

    it('a bound box carries its polygon and keypoints, once', () => {
        const { editor, svg } = makeEditor({ annotations: [POSE] });
        editor.select('P');
        drag(bboxEl(svg, 'P'), [110, 110], [160, 130]);
        const moved = editor.getAnnotation('P');
        expect(moved.bbox).toEqual([150, 120, 200, 200]);
        expect(moved.segments[0]).toEqual([170, 140]);
        expect(moved.keypoints.map((k) => k.point)).toEqual([
            [200, 170],
            [300, 270]
        ]);
    });

    it('with bindElements off, the box moves alone', () => {
        const { editor, svg } = makeEditor({ annotations: [POSE], bindElements: false });
        editor.select('P');
        drag(bboxEl(svg, 'P'), [110, 110], [160, 130]);
        const moved = editor.getAnnotation('P');
        expect(moved.bbox).toEqual([150, 120, 200, 200]);
        expect(moved.segments).toEqual(POSE.segments);
        expect(moved.keypoints).toEqual(POSE.keypoints);
    });

    it('cannot leave the image, and comes back with the pointer without drifting', () => {
        const { editor, svg } = makeEditor({ annotations: [BOX] });
        editor.select('A');
        press(bboxEl(svg, 'A'), 150, 150);
        move(-900, -900);
        expect(editor.getAnnotation('A').bbox).toEqual([0, 0, 200, 100]);
        move(2000, 2000);
        expect(editor.getAnnotation('A').bbox).toEqual([600, 500, 200, 100]);
        move(160, 150); // 10px right of where the press started
        expect(editor.getAnnotation('A').bbox).toEqual([110, 100, 200, 100]);
        release(160, 150);
    });

    it('can leave the image when constrainToImage is off', () => {
        const { editor, svg } = makeEditor({ annotations: [BOX], constrainToImage: false });
        editor.select('A');
        drag(bboxEl(svg, 'A'), [150, 150], [-350, 150]);
        expect(editor.getAnnotation('A').bbox).toEqual([-400, 100, 200, 100]);
    });

    it('moves a polygon inside its box and stops at the edge', () => {
        const { editor, svg } = makeEditor({ annotations: [POSE] });
        click(polygonEl(svg, 'P'), 200, 200);
        drag(polygonEl(svg, 'P'), [200, 200], [400, 190]);
        const moved = editor.getAnnotation('P');
        expect(moved.segments).toEqual([
            [140, 110],
            [300, 110],
            [300, 270],
            [140, 270]
        ]);
        expect(moved.bbox).toEqual(POSE.bbox);
        expect(moved.keypoints).toEqual(POSE.keypoints);
    });
});

describe('resizing', () => {
    it('moves one corner and keeps the opposite one fixed', () => {
        const { editor, svg } = makeEditor({ annotations: [BOX] });
        editor.select('A');
        drag(handleEl(svg, 'se'), [300, 200], [350, 260]);
        expect(editor.getAnnotation('A').bbox).toEqual([100, 100, 250, 160]);
        drag(handleEl(svg, 'nw'), [100, 100], [150, 120]);
        expect(editor.getAnnotation('A').bbox).toEqual([150, 120, 200, 140]);
        drag(handleEl(svg, 'ne'), [350, 120], [330, 100]);
        expect(editor.getAnnotation('A').bbox).toEqual([150, 100, 180, 160]);
        drag(handleEl(svg, 'sw'), [150, 260], [140, 280]);
        expect(editor.getAnnotation('A').bbox).toEqual([140, 100, 190, 180]);
    });

    it('never turns inside out, and follows the pointer back exactly', () => {
        const { editor, svg } = makeEditor({ annotations: [BOX] });
        editor.select('A');
        press(handleEl(svg, 'se'), 300, 200);
        move(40, 40); // far past the opposite corner
        expect(editor.getAnnotation('A').bbox).toEqual([100, 100, 1, 1]);
        move(300, 200); // back where it started
        expect(editor.getAnnotation('A').bbox).toEqual([100, 100, 200, 100]);
        move(320, 230);
        release(320, 230);
        expect(editor.getAnnotation('A').bbox).toEqual([100, 100, 220, 130]);

        // The same from the other side: the top-left corner dragged past the bottom-right one.
        press(handleEl(svg, 'nw'), 100, 100);
        move(700, 500);
        expect(editor.getAnnotation('A').bbox).toEqual([319, 229, 1, 1]);
        move(100, 100);
        release(100, 100);
        expect(editor.getAnnotation('A').bbox).toEqual([100, 100, 220, 130]);
    });

    it('keeps its handles on screen while one is dragged', () => {
        const { editor, svg } = makeEditor({ annotations: [BOX] });
        editor.select('A');
        press(handleEl(svg, 'se'), 300, 200);
        move(340, 240);
        expect(handles(svg).length).toBe(4);
        expect(num(handleEl(svg, 'se'), 'cx')).toBe(340);
        expect(num(handleEl(svg, 'se'), 'cy')).toBe(240);
        release(340, 240);
        expect(handles(svg).length).toBe(4);
    });

    it('keeps the same handle elements while dragging, so large polygons stay responsive', () => {
        const points = [];
        for (let i = 0; i < 400; i++) points.push([400 + 200 * Math.cos(i / 63.7), 300 + 200 * Math.sin(i / 63.7)]);
        const { editor, svg } = makeEditor({ annotations: [{ id: 'big', segments: points }] });
        editor.select('big');
        const before = handles(svg);
        expect(before.length).toBe(400);
        press(before[10], points[10][0], points[10][1]);
        move(points[10][0] + 30, points[10][1] + 10);
        move(points[10][0] + 40, points[10][1] + 20);
        const during = handles(svg);
        expect(during.every((node, i) => node === before[i])).toBe(true);
        expect(num(during[10], 'cx')).toBeCloseTo(points[10][0] + 40, 6);
        expect(num(during[11], 'cx')).toBe(points[11][0]);
        release(points[10][0] + 40, points[10][1] + 20);
    });

    it('stops at the image edge', () => {
        const { editor, svg } = makeEditor({ annotations: [BOX] });
        editor.select('A');
        drag(handleEl(svg, 'se'), [300, 200], [5000, 5000]);
        expect(editor.getAnnotation('A').bbox).toEqual([100, 100, 700, 500]);
    });

    it('scales bound children with the box, from the state at press time', () => {
        const { editor, svg } = makeEditor({
            annotations: [
                {
                    id: 'S',
                    bbox: [100, 100, 200, 100],
                    segments: [
                        [100, 100],
                        [300, 100],
                        [300, 200]
                    ],
                    keypoints: [{ point: [200, 150] }]
                }
            ]
        });
        editor.select('S');
        press(handleEl(svg, 'se'), 300, 200);
        for (let i = 0; i < 40; i++) move(300 + i * 7, 200 + i * 3); // many small steps must not accumulate error
        move(500, 300);
        release(500, 300);
        const out = editor.getAnnotation('S');
        expect(out.bbox).toEqual([100, 100, 400, 200]);
        expect(out.keypoints[0].point).toEqual([300, 200]);
        expect(out.segments).toEqual([
            [100, 100],
            [500, 100],
            [500, 300]
        ]);
    });

    it('leaves the children alone when bindElements is off', () => {
        const { editor, svg } = makeEditor({ annotations: [POSE], bindElements: false });
        editor.select('P');
        drag(handleEl(svg, 'se'), [300, 300], [400, 400]);
        const out = editor.getAnnotation('P');
        expect(out.bbox).toEqual([100, 100, 300, 300]);
        expect(out.keypoints).toEqual(POSE.keypoints);
        expect(out.segments).toEqual(POSE.segments);
    });
});

describe('keypoints and vertices', () => {
    it('a keypoint stops at the edge of its box and returns with the pointer', () => {
        const { editor, svg } = makeEditor({ annotations: [POSE] });
        click(keypointEl(svg, 'P', 0), 150, 150);
        press(keypointEl(svg, 'P', 0), 150, 150);
        move(900, 150);
        expect(editor.getAnnotation('P').keypoints[0].point).toEqual([300, 150]);
        move(200, 150);
        expect(editor.getAnnotation('P').keypoints[0].point).toEqual([200, 150]);
        release(200, 150);
        expect(editor.getAnnotation('P').keypoints[1]).toEqual(POSE.keypoints[1]);
    });

    it('keypoints in a small box keep their own positions', () => {
        const face = {
            id: 'face',
            bbox: [100, 100, 24, 24],
            keypoints: [
                { name: 'left_eye', point: [106, 108] },
                { name: 'right_eye', point: [118, 108] }
            ]
        };
        const { editor, svg } = makeEditor({ annotations: [face] });
        click(keypointEl(svg, 'face', 0), 106, 108);
        drag(keypointEl(svg, 'face', 0), [106, 108], [110, 108]);
        click(keypointEl(svg, 'face', 1), 118, 108);
        drag(keypointEl(svg, 'face', 1), [118, 108], [122, 108]);
        expect(editor.getAnnotation('face').keypoints.map((k) => k.point)).toEqual([
            [110, 108],
            [122, 108]
        ]);
    });

    it('a keypoint may sit exactly on the edge of its box', () => {
        const { editor, svg } = makeEditor({ annotations: [POSE] });
        click(keypointEl(svg, 'P', 0), 150, 150);
        drag(keypointEl(svg, 'P', 0), [150, 150], [100, 100]);
        expect(editor.getAnnotation('P').keypoints[0].point).toEqual([100, 100]);
    });

    it('bboxContainKeypoints: false frees keypoints but still contains the polygon', () => {
        const { editor, svg } = makeEditor({ annotations: [POSE], bboxContainKeypoints: false });
        click(keypointEl(svg, 'P', 0), 150, 150);
        drag(keypointEl(svg, 'P', 0), [150, 150], [50, 50]);
        expect(editor.getAnnotation('P').keypoints[0].point).toEqual([50, 50]);

        click(polygonEl(svg, 'P'), 200, 200);
        drag(handleEl(svg, 'vertex', 1), [280, 120], [500, 120]);
        expect(editor.getAnnotation('P').segments[1]).toEqual([300, 120]);
    });

    it('dragging one vertex moves only that vertex, clamped to the box', () => {
        const { editor, svg } = makeEditor({ annotations: [POSE] });
        click(polygonEl(svg, 'P'), 200, 200);
        expect(handles(svg).length).toBe(4);
        drag(handleEl(svg, 'vertex', 1), [280, 120], [380, 60]);
        expect(editor.getAnnotation('P').segments).toEqual([
            [120, 120],
            [300, 100],
            [280, 280],
            [120, 280]
        ]);
    });

    it('a polygon without a box is only limited by the image', () => {
        const free = {
            id: 'free',
            segments: [
                [100, 100],
                [200, 100],
                [150, 180]
            ]
        };
        const { editor, svg } = makeEditor({ annotations: [free] });
        editor.select('free');
        drag(handleEl(svg, 'vertex', 0), [100, 100], [-50, 700]);
        expect(editor.getAnnotation('free').segments[0]).toEqual([0, 600]);
    });

    it('an unlabelled keypoint (v = 0) is hidden and never moves with its annotation', () => {
        const ann = {
            id: 'V',
            bbox: [100, 100, 200, 100],
            keypoints: [
                { name: 'seen', point: [150, 150], v: 2 },
                { name: 'missing', point: [0, 0], v: 0 }
            ]
        };
        const { editor, svg } = makeEditor({ annotations: [ann] });
        expect(keypointEl(svg, 'V', 1).getAttribute('display')).toBe('none');
        editor.select('V');
        drag(bboxEl(svg, 'V'), [110, 110], [60, 60]); // would be blocked at 0,0 if the hidden point counted
        const out = editor.getAnnotation('V');
        expect(out.bbox).toEqual([50, 50, 200, 100]);
        expect(out.keypoints[0].point).toEqual([100, 100]);
        expect(out.keypoints[1]).toEqual(ann.keypoints[1]);
    });
});

describe('a drag always ends', () => {
    it('ignores the right mouse button and secondary pointers', () => {
        const { editor, svg } = makeEditor({ annotations: [BOX, OTHER] });
        editor.select('A');
        // A right press is left entirely to the page: no selection, nothing prevented.
        const right = press(bboxEl(svg, 'B'), 450, 350, { button: 2, buttons: 2 });
        release(450, 350);
        expect(right.defaultPrevented).toBe(false);
        expect(editor.getSelection().id).toBe('A');

        press(bboxEl(svg, 'A'), 150, 150, { button: 2, buttons: 2 });
        move(250, 150, { buttons: 2 });
        release(250, 150);
        press(bboxEl(svg, 'A'), 150, 150, { isPrimary: false, pointerId: 2 });
        move(250, 150, { pointerId: 2 });
        release(250, 150, { pointerId: 2 });
        expect(editor.getAnnotation('A')).toEqual(BOX);
    });

    it('ends when the mouse comes back with no button down (released outside the window)', () => {
        const { editor, svg } = makeEditor({ annotations: [BOX] });
        editor.select('A');
        const changes = [];
        editor.on('change', (list, info) => changes.push(info.reason));
        press(bboxEl(svg, 'A'), 150, 150);
        move(200, 150);
        move(400, 150, { buttons: 0 }); // the release never reached the page
        move(500, 150, { buttons: 0 });
        expect(editor.getAnnotation('A').bbox).toEqual([150, 100, 200, 100]);
        expect(changes).toEqual(['update']);
    });

    it('pointercancel puts the annotation back', () => {
        const { editor, svg } = makeEditor({ annotations: [BOX] });
        editor.select('A');
        const ends = [];
        let changes = 0;
        editor.on('dragend', (e) => ends.push([e.changed, e.cancelled]));
        editor.on('change', () => changes++);
        press(bboxEl(svg, 'A'), 150, 150);
        move(250, 190);
        pointer('pointercancel', window, 250, 190);
        move(300, 300);
        expect(editor.getAnnotation('A')).toEqual(BOX);
        expect(num(bboxEl(svg, 'A'), 'x')).toBe(100);
        expect(ends).toEqual([[false, true]]);
        expect(changes).toBe(0);
    });

    it('Escape cancels a drag in progress', () => {
        const { editor, svg } = makeEditor({ annotations: [BOX] });
        editor.select('A');
        press(bboxEl(svg, 'A'), 150, 150);
        move(250, 190);
        key('Escape');
        move(300, 300);
        release(300, 300);
        expect(editor.getAnnotation('A')).toEqual(BOX);
        expect(editor.getSelection().id).toBe('A');
        expect(editor.canUndo()).toBe(false);
    });

    it('a listener that throws cannot leave the drag stuck', () => {
        const { editor, svg, log } = makeEditor({ annotations: [BOX] });
        editor.select('A');
        const seen = [];
        for (const type of ['dragstart', 'drag', 'dragend', 'change']) {
            // The README of 0.1 told people to read data.position.x on an event that had no position.
            editor.on(type, (data) => Math.round(data.nothing.x));
            editor.on(type, () => seen.push(type));
        }
        drag(bboxEl(svg, 'A'), [150, 150], [200, 150]);
        move(400, 150, { buttons: 0 });

        expect(editor.getAnnotation('A').bbox).toEqual([150, 100, 200, 100]);
        expect(seen).toEqual(['dragstart', 'drag', 'drag', 'dragend', 'change']);
        expect(log.filter((line) => /listener threw/.test(line)).length).toBe(5);
    });

    it('a second press while dragging is ignored', () => {
        const { editor, svg } = makeEditor({ annotations: [BOX, OTHER] });
        editor.select('A');
        press(bboxEl(svg, 'A'), 150, 150);
        move(200, 150);
        press(bboxEl(svg, 'B'), 450, 350, { pointerId: 5 });
        move(210, 150);
        release(210, 150);
        expect(editor.getSelection().id).toBe('A');
        expect(editor.getAnnotation('A').bbox).toEqual([160, 100, 200, 100]);
    });

    it('an API change during a drag cancels the drag first', () => {
        const { editor, svg } = makeEditor({ annotations: [BOX] });
        editor.select('A');
        press(bboxEl(svg, 'A'), 150, 150);
        move(250, 150);
        editor.updateAnnotation('A', { class_id: 5 });
        move(350, 150);
        release(350, 150);
        expect(editor.getAnnotation('A')).toEqual({ ...BOX, class_id: 5 });
    });

    it('deleting the dragged annotation from a listener is safe', () => {
        const { editor, svg } = makeEditor({ annotations: [BOX] });
        editor.select('A');
        editor.on('drag', () => editor.deleteAnnotation('A'));
        drag(bboxEl(svg, 'A'), [150, 150], [250, 150]);
        expect(editor.getAnnotations()).toEqual([]);
        expect(editor.getSelection()).toBe(null);
    });
});

describe('drag events', () => {
    it('fire in order and end with one change', () => {
        const { editor, svg } = makeEditor({ annotations: [BOX] });
        editor.select('A');
        const order = [];
        editor.on('dragstart', (e) => order.push(['dragstart', e.id, e.part, e.handle, e.position]));
        editor.on('drag', (e) => order.push(['drag', e.annotation.bbox[0]]));
        editor.on('dragend', (e) => order.push(['dragend', e.changed, e.cancelled, e.annotation.bbox[0]]));
        editor.on('change', (list, info) => order.push(['change', info, list[0].bbox[0]]));

        drag(bboxEl(svg, 'A'), [150, 150], [250, 150]);

        expect(order).toEqual([
            ['dragstart', 'A', 'bbox', null, { x: 150, y: 150 }],
            ['drag', 150],
            ['drag', 200],
            ['dragend', true, false, 200],
            ['change', { reason: 'update', ids: ['A'] }, 200]
        ]);
    });

    it('report the handle being dragged', () => {
        const { editor, svg } = makeEditor({ annotations: [POSE] });
        editor.select('P');
        const seen = [];
        editor.on('dragstart', (e) => seen.push([e.part, e.handle, e.index]));
        drag(handleEl(svg, 'nw'), [100, 100], [110, 110]);
        click(polygonEl(svg, 'P'), 200, 200);
        drag(handleEl(svg, 'vertex', 2), [280, 280], [270, 270]);
        expect(seen).toEqual([
            ['bbox', 'nw', null],
            ['polygon', 'vertex', 2]
        ]);
    });

    it('a drag that ends where it began changes nothing', () => {
        const { editor, svg } = makeEditor({ annotations: [BOX] });
        editor.select('A');
        const ends = [];
        let changes = 0;
        editor.on('dragend', (e) => ends.push(e.changed));
        editor.on('change', () => changes++);
        press(bboxEl(svg, 'A'), 150, 150);
        move(250, 150);
        move(150, 150);
        release(150, 150);
        expect(ends).toEqual([false]);
        expect(changes).toBe(0);
        expect(editor.canUndo()).toBe(false);
    });

    it('hover reports the position and what is under the pointer, once per frame', async () => {
        const { editor, svg } = makeEditor({ annotations: [BOX] });
        const seen = [];
        editor.on('hover', (e) => seen.push(e));
        pointer('pointermove', bboxEl(svg, 'A'), 140, 150, { buttons: 0 });
        pointer('pointermove', bboxEl(svg, 'A'), 150, 150, { buttons: 0 });
        await nextFrame();
        pointer('pointermove', svg, 500, 400, { buttons: 0 });
        await nextFrame();
        expect(seen).toEqual([
            { position: { x: 150, y: 150 }, id: 'A', part: 'bbox', index: null },
            { position: { x: 500, y: 400 }, id: null, part: null, index: null }
        ]);
    });
});

describe('scale: image pixels are not screen pixels', () => {
    // A 1600 x 1200 image shown at 800 x 600, 20px from the top-left of the page.
    const half = { viewBox: '0 0 1600 1200', box: { left: 20, top: 20, width: 800, height: 600 } };
    const big = { id: 'big', bbox: [200, 200, 400, 200], keypoints: [{ point: [300, 300] }] };

    it('converts pointer positions to image coordinates', () => {
        const { editor, svg } = makeEditor({ annotations: [big] }, half);
        const clicks = [];
        editor.on('canvasclick', (e) => clicks.push(e.position));
        click(svg, 520, 420);
        expect(clicks).toEqual([{ x: 1000, y: 800 }]);

        editor.select('big');
        drag(bboxEl(svg, 'big'), [150, 150], [200, 170]); // 50 x 20 screen px
        expect(editor.getAnnotation('big').bbox).toEqual([300, 240, 400, 200]);
    });

    it('draws handles, keypoints and strokes at a constant size on screen', () => {
        const { editor, svg } = makeEditor({ annotations: [big] }, half);
        editor.select('big');
        const layer = svg.querySelector('.markin-layer');
        expect(num(layer, 'stroke-width')).toBe(4); // 2px on screen
        expect(num(svg.querySelector('.markin-handle'), 'r')).toBe(10); // 5px on screen
        expect(num(handleEl(svg, 'se'), 'r')).toBe(22); // 11px grab area
        expect(num(keypointEl(svg, 'big', 0), 'r')).toBe(10);

        // The host zooms in 4x: everything shrinks in image units to stay the same on screen.
        setBox(svg, { left: 20, top: 20, width: 3200, height: 2400 });
        editor.refresh();
        expect(num(layer, 'stroke-width')).toBe(1);
        expect(num(svg.querySelector('.markin-handle'), 'r')).toBe(2.5);
        expect(num(keypointEl(svg, 'big', 0), 'r')).toBe(2.5);
    });

    it('rescales what is sized on screen, whether it is selected or not', () => {
        const plain = { id: 'plain', bbox: [900, 700, 200, 200] };
        const { editor, svg } = makeEditor({ annotations: [big, plain] }, half);
        editor.select('plain');
        expect(num(keypointEl(svg, 'big', 0), 'r')).toBe(10);
        expect(bboxEl(svg, 'plain').getAttribute('stroke-dasharray')).toBe('10 10');

        setBox(svg, { left: 20, top: 20, width: 3200, height: 2400 });
        editor.refresh();
        // The keypoints of an annotation that is not selected ...
        expect(num(keypointEl(svg, 'big', 0), 'r')).toBe(2.5);
        // ... and the dashes of the selected one, which has no keypoints.
        expect(bboxEl(svg, 'plain').getAttribute('stroke-dasharray')).toBe('2.5 2.5');
    });

    it('picks up a new scale on the next press without being told', () => {
        const { editor, svg } = makeEditor({ annotations: [big] }, half);
        editor.select('big');
        setBox(svg, { left: 0, top: 0, width: 1600, height: 1200 });
        press(handleEl(svg, 'se'), 600, 400);
        expect(num(svg.querySelector('.markin-handle'), 'r')).toBe(5);
        move(700, 500);
        release(700, 500);
        expect(editor.getAnnotation('big').bbox).toEqual([200, 200, 500, 300]);
    });

    it('honours sizes given in the options', () => {
        const { editor, svg } = makeEditor({ annotations: [big], handleRadius: 8, keypointRadius: 3, strokeWidth: 1 });
        editor.select('big');
        expect(num(svg.querySelector('.markin-handle'), 'r')).toBe(8);
        expect(num(keypointEl(svg, 'big', 0), 'r')).toBe(3);
        expect(num(svg.querySelector('.markin-layer'), 'stroke-width')).toBe(1);
    });

    it('works before the SVG has a size, using its coordinates as they are', () => {
        const { editor, svg } = makeEditor({ annotations: [BOX] }, { viewBox: '0 0 800 600', box: null });
        editor.select('A');
        drag(bboxEl(svg, 'A'), [150, 150], [200, 150]);
        expect(editor.getAnnotation('A').bbox).toEqual([150, 100, 200, 100]);
    });
});

describe('stacking', () => {
    it('keeps a small annotation above a big one, whatever the creation order', () => {
        const { editor, svg } = makeEditor();
        editor.createAnnotation({ id: 'small', bbox: [100, 100, 50, 50] });
        editor.createAnnotation({ id: 'big', bbox: [0, 0, 500, 500] });
        editor.createAnnotation({ id: 'medium', bbox: [50, 50, 200, 200] });
        const order = () =>
            Array.from(svg.querySelectorAll('.markin-shapes > [data-markin-id]'), (g) =>
                g.getAttribute('data-markin-id')
            );
        expect(order()).toEqual(['big', 'medium', 'small']);
        expect(editor.getAnnotations().map((a) => a.id)).toEqual(['small', 'big', 'medium']);

        editor.updateAnnotation('small', { bbox: [0, 0, 700, 500] });
        expect(order()).toEqual(['small', 'big', 'medium']);
    });

    it('moves only what is out of place when the list changes', () => {
        const { editor, svg } = makeEditor({
            annotations: [
                { id: 'big', bbox: [0, 0, 500, 500] },
                { id: 'medium', bbox: [50, 50, 200, 200] },
                { id: 'small', bbox: [100, 100, 50, 50] }
            ]
        });
        const shapes = svg.querySelector('.markin-shapes');
        const order = () => Array.from(shapes.children, (g) => g.getAttribute('data-markin-id'));
        const observer = new MutationObserver(() => {});
        observer.observe(shapes, { childList: true });
        const moves = () =>
            observer.takeRecords().reduce((n, record) => n + record.addedNodes.length + record.removedNodes.length, 0);

        // The smallest one is added on top, where it belongs: nothing else is touched.
        editor.createAnnotation({ id: 'tiny', bbox: [110, 110, 10, 10] });
        expect(moves()).toBe(1);
        // Taking one out never changes the order of the rest.
        editor.deleteAnnotation('medium');
        expect(moves()).toBe(1);
        // One that belongs at the bottom is added, then put there: it is the only one that moves.
        editor.createAnnotation({ id: 'huge', bbox: [0, 0, 700, 550] });
        expect(moves()).toBe(3);
        expect(order()).toEqual(['huge', 'big', 'small', 'tiny']);
        observer.disconnect();
    });

    it('draws every keypoint above every shape, and handles above everything', () => {
        const { editor, svg } = makeEditor({ annotations: [POSE, BOX] });
        editor.select('A');
        const layers = Array.from(svg.querySelector('.markin-layer').children, (g) => g.getAttribute('class'));
        expect(layers).toEqual(['markin-shapes', 'markin-points', 'markin-ui']);
        expect(svg.querySelector('.markin-shapes [data-markin-part="keypoint"]')).toBe(null);
        expect(svg.querySelectorAll('.markin-points [data-markin-part="keypoint"]').length).toBe(2);
        expect(svg.querySelectorAll('.markin-shapes .markin-handle, .markin-points .markin-handle').length).toBe(0);
    });
});

describe('living with the page', () => {
    it('keeps a press on an annotation to itself, and leaves canvas presses to the host', () => {
        const { svg } = makeEditor({ annotations: [BOX] });
        const reached = [];
        document.body.addEventListener('pointerdown', () => reached.push('body'));

        const onShape = press(bboxEl(svg, 'A'), 150, 150);
        release(150, 150);
        const onCanvas = press(svg, 600, 500);
        release(600, 500);

        expect(onShape.defaultPrevented).toBe(true);
        expect(onCanvas.defaultPrevented).toBe(false);
        expect(reached).toEqual(['body']);
    });

    it('takes typing focus away from a text field when an annotation is pressed', () => {
        const { editor, svg } = makeEditor({ annotations: [BOX] });
        const input = document.createElement('input');
        document.body.appendChild(input);
        input.focus();
        expect(document.activeElement).toBe(input);
        click(bboxEl(svg, 'A'), 150, 150);
        expect(document.activeElement).not.toBe(input);
        key('Delete');
        expect(editor.getAnnotations()).toEqual([]);
    });

    it('works with touch and pen pointers', () => {
        const { editor, svg } = makeEditor({ annotations: [BOX] });
        expect(svg.style.touchAction).toBe('none');
        const touch = { pointerType: 'touch', pointerId: 9 };
        click(bboxEl(svg, 'A'), 150, 150, touch);
        drag(bboxEl(svg, 'A'), [150, 150], [200, 150], touch);
        expect(editor.getAnnotation('A').bbox).toEqual([150, 100, 200, 100]);

        const stopped = [];
        document.body.addEventListener('touchstart', () => stopped.push('host saw it'));
        bboxEl(svg, 'A').dispatchEvent(new Event('touchstart', { bubbles: true }));
        expect(stopped).toEqual([]);
        svg.dispatchEvent(new Event('touchstart', { bubbles: true }));
        expect(stopped).toEqual(['host saw it']);
    });

    it('disable() lets every pointer event through and enable() takes them back', () => {
        const { editor, svg } = makeEditor({ annotations: [BOX] });
        editor.select('A');
        editor.disable();
        expect(editor.isEnabled()).toBe(false);
        expect(editor.getSelection()).toBe(null);
        expect(svg.querySelector('.markin-layer').style.pointerEvents).toBe('none');
        expect(svg.style.touchAction).toBe('');

        const down = press(bboxEl(svg, 'A'), 150, 150);
        move(250, 150);
        release(250, 150);
        key('Delete');
        expect(down.defaultPrevented).toBe(false);
        expect(editor.getAnnotation('A')).toEqual(BOX);
        expect(editor.getSelection()).toBe(null);

        editor.enable();
        expect(svg.querySelector('.markin-layer').style.pointerEvents).toBe('');
        click(bboxEl(svg, 'A'), 150, 150);
        expect(editor.getSelection().id).toBe('A');
    });

    it('disable() during a drag puts the annotation back', () => {
        const { editor, svg } = makeEditor({ annotations: [BOX] });
        editor.select('A');
        press(bboxEl(svg, 'A'), 150, 150);
        move(250, 150);
        editor.disable();
        move(350, 150);
        release(350, 150);
        expect(editor.getAnnotation('A')).toEqual(BOX);
    });
});
