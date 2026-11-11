// Cases that sit at the edges of the editor: unusual input, host code running at awkward
// moments, data that starts out of bounds, and pages where focus or the document is not the usual one.
import { describe, it, expect } from 'vitest';
import {
    MarkinJS,
    makeEditor,
    makeSvg,
    setBox,
    track,
    cleanup,
    focusCalls,
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
    num,
    BOX,
    OTHER,
    SVG_NS
} from './setup.js';

describe('input that is not what it seems', () => {
    it('validates the copy it stores, so sparse arrays cannot slip through', () => {
        const { editor, log } = makeEditor({ annotations: [BOX] });
        const holeInBox = [10, 10, 30, 40];
        delete holeInBox[2];

        expect(editor.createAnnotation({ id: 'h', bbox: holeInBox })).toBe(null);
        expect(() => editor.createAnnotation({ id: 's', segments: new Array(3) })).not.toThrow();
        expect(editor.createAnnotation({ id: 'k', keypoints: new Array(2) })).toBe(null);
        expect(editor.load([BOX, { id: 's', segments: new Array(3) }])).toBe(false);

        expect(editor.getAnnotations()).toEqual([BOX]);
        expect(log.length).toBe(4);
    });

    it('validates what toJSON produces, not the object it came from', () => {
        const { editor } = makeEditor();
        const sneaky = {
            bbox: [1, 2, 3, 4],
            toJSON: () => ({ bbox: [1, 2, 3, 4], segments: [1, 2, 3], keypoints: 'nope' })
        };
        expect(editor.createAnnotation(sneaky)).toBe(null);
        expect(editor.createAnnotation({ bbox: [1, 2, 3, 4], toJSON: () => 'text' })).toBe(null);
        expect(editor.getAnnotations()).toEqual([]);
    });

    it('treats undefined in a patch as "not given"; only null removes a field', () => {
        const full = { ...BOX, label: 'keep me', keypoints: [{ point: [150, 150] }] };
        const { editor } = makeEditor({ annotations: [full] });
        expect(editor.updateAnnotation('A', { class_id: 2, keypoints: undefined, label: undefined })).toBe(true);
        expect(editor.getAnnotation('A')).toEqual({ ...full, class_id: 2 });
        editor.updateAnnotation('A', { label: null });
        expect(editor.getAnnotation('A').label).toBe(null);
    });

    it('never throws for an id that could not be one', () => {
        const { editor } = makeEditor({ annotations: [BOX] });
        for (const odd of [Object.create(null), {}, [], null, undefined, NaN, Symbol('x'), () => {}]) {
            expect(editor.getAnnotation(odd)).toBe(null);
            expect(editor.updateAnnotation(odd, { class_id: 3 })).toBe(false);
            expect(editor.deleteAnnotation(odd)).toBe(false);
            expect(editor.select(odd)).toBe(false);
            expect(editor.addKeypoint(odd, { point: [1, 2] })).toBe(false);
        }
        expect(editor.updateAnnotation('A', { id: Object.create(null) })).toBe(false);
        expect(editor.getAnnotations()).toEqual([BOX]);
    });

    it('MarkinJS.normalize and denormalize reject bad items by position', () => {
        expect(() => MarkinJS.normalize([BOX, { bbox: [1, 2] }], 10, 10)).toThrow(
            /normalize: annotations\[1\]: bbox must be/
        );
        expect(() => MarkinJS.denormalize([null], 10, 10)).toThrow(/denormalize: annotations\[0\]/);
    });

    it('keeps its own copy of the options it was given', () => {
        const skeleton = [['a', 'b']];
        const colors = { 1: '#ff0000' };
        const rules = { bbox: ['keypoint'] };
        const { editor, svg } = makeEditor({
            skeleton,
            colors,
            deletionRules: rules,
            annotations: [
                {
                    ...BOX,
                    keypoints: [
                        { name: 'a', point: [120, 120] },
                        { name: 'b', point: [180, 180] }
                    ]
                }
            ]
        });
        skeleton.push(null);
        colors[1] = 'not-a-colour';
        rules.bbox.push('annotation');

        expect(() => editor.updateAnnotation('A', { class_id: 1 })).not.toThrow();
        expect(() => editor.setOptions({ strokeWidth: 3 })).not.toThrow();
        expect(bboxEl(svg, 'A').getAttribute('stroke')).toBe('#ff0000');
        expect(svg.querySelectorAll('.markin-skeleton line').length).toBe(1);

        const out = editor.getOptions();
        out.deletionRules.bbox.push('annotation');
        out.skeleton.length = 0;
        expect(editor.getOptions().deletionRules.bbox).toEqual(['keypoint']);
        expect(editor.getOptions().skeleton).toEqual([['a', 'b']]);
    });

    it('rejects options that are not plain data', () => {
        const loop = {};
        loop.self = loop;
        const { editor, log } = makeEditor({ colors: loop });
        expect(log).toEqual(['error: option "colors" must be plain JSON data']);
        expect(editor.getOptions().colors).toBe(null);
    });

    it('event and option names that are also properties of every object are just unknown names', () => {
        const { editor, log } = makeEditor({ constructor: 1 });
        expect(() => editor.off('constructor', () => {})).not.toThrow();
        expect(() => editor.off('toString')).not.toThrow();
        editor.on('constructor', () => {});
        expect(log).toEqual([
            'error: unknown option "constructor"',
            'error: unknown event "constructor". Events: change, select, deselect, dragstart, drag, dragend, hover, canvasclick'
        ]);
    });

    it('loads a polygon with more points than a function call can take as arguments', () => {
        const points = [];
        for (let i = 0; i < 150000; i++) points.push([400 + 300 * Math.cos(i / 1000), 300 + 200 * Math.sin(i / 1000)]);
        const { editor } = makeEditor();
        expect(editor.load([{ id: 'huge', segments: points }])).toBe(true);
        expect(editor.getAnnotation('huge').segments.length).toBe(150000);
    }, 20000);
});

describe('opening another document', () => {
    it('load() never carries the selection over, even when the new data reuses the id', () => {
        const { editor, svg } = makeEditor({ annotations: [{ id: 1, bbox: [10, 10, 50, 50] }] });
        editor.select(1);
        const events = [];
        editor.on('deselect', (e) => events.push(e));
        editor.on('select', (e) => events.push(e));

        editor.load([{ id: 1, bbox: [300, 300, 80, 80] }]); // the next image, numbered from 1 again
        key('Delete');

        expect(events).toEqual([{ id: 1, part: 'bbox', index: null }]);
        expect(editor.getSelection()).toBe(null);
        expect(svg.querySelectorAll('.markin-ui *').length).toBe(0);
        expect(editor.getAnnotations().length).toBe(1);
    });
});

describe('history at the edges', () => {
    it('edits made while history was off are not undone when it is switched back on', () => {
        const { editor } = makeEditor();
        editor.createAnnotation({ id: 'A', bbox: [10, 10, 50, 50] }, { select: false });
        editor.setOptions({ historyEnabled: false });
        editor.createAnnotation(OTHER, { select: false });
        editor.updateAnnotation('A', { bbox: [300, 300, 50, 50] });
        editor.setOptions({ historyEnabled: true });
        editor.createAnnotation({ id: 'C', bbox: [1, 1, 5, 5] }, { select: false });

        expect(editor.undo()).toBe(true);
        expect(editor.getAnnotations()).toEqual([{ id: 'A', bbox: [300, 300, 50, 50] }, OTHER]);
        expect(editor.undo()).toBe(false);
    });

    it('the same holds when the editor starts with history off', () => {
        const { editor } = makeEditor({ historyEnabled: false, annotations: [BOX] });
        editor.updateAnnotation('A', { class_id: 9 });
        editor.setOptions({ historyEnabled: true });
        editor.createAnnotation(OTHER);
        editor.undo();
        expect(editor.getAnnotations()).toEqual([{ ...BOX, class_id: 9 }]);
    });

    it('a nudge there and back is not an edit', () => {
        const { editor } = makeEditor({ annotations: [BOX] });
        editor.select('A');
        let changes = 0;
        editor.on('change', () => changes++);
        key('ArrowRight');
        key('ArrowLeft');
        expect(editor.undo()).toBe(false);
        expect(changes).toBe(0);
        expect(editor.canUndo()).toBe(false);
        expect(editor.getAnnotation('A')).toEqual(BOX);
    });

    it('an edit made from a dragend listener does not leave an empty undo step behind', () => {
        const { editor, svg } = makeEditor({ annotations: [BOX, OTHER] });
        editor.select('A');
        editor.on('dragend', () => editor.updateAnnotation('B', { class_id: 7 }));
        const reasons = [];
        editor.on('change', (list, info) => reasons.push(info.ids.join()));

        drag(bboxEl(svg, 'A'), [150, 150], [250, 150]);

        expect(reasons).toEqual(['B']); // that one change already carries the dragged box
        expect(editor.getAnnotation('A').bbox[0]).toBe(200);
        expect(editor.undo()).toBe(true);
        expect(editor.getAnnotations()).toEqual([BOX, OTHER]);
        expect(editor.undo()).toBe(false);
    });
});

describe('geometry at the edges', () => {
    it('resizing leaves the edge that was not dragged exactly where it was', () => {
        // A 4000 x 3000 image shown at 400 x 300: one screen pixel is 10 image pixels.
        const small = { viewBox: '0 0 4000 3000', box: { left: 0, top: 0, width: 400, height: 300 } };
        const { editor, svg } = makeEditor(
            {
                annotations: [
                    { id: 'thin', bbox: [1000, 1000, 3, 300] },
                    { id: 'edge', bbox: [3995, 100, 5, 500] }
                ]
            },
            small
        );
        editor.select('thin');
        drag(handleEl(svg, 'se'), [100.3, 130], [100.3, 150]); // straight down
        expect(editor.getAnnotation('thin').bbox).toEqual([1000, 1000, 3, 500]);

        editor.select('edge');
        drag(handleEl(svg, 'se'), [400, 60], [400, 70]);
        expect(editor.getAnnotation('edge').bbox).toEqual([3995, 100, 5, 600]);
    });

    it('the minimum size never pushes a box past the image edge', () => {
        const small = { viewBox: '0 0 4000 3000', box: { left: 0, top: 0, width: 400, height: 300 } };
        const { editor, svg } = makeEditor({ annotations: [{ id: 'edge', bbox: [3995, 100, 5, 500] }] }, small);
        editor.select('edge');
        drag(handleEl(svg, 'se'), [400, 60], [380, 70]); // towards the opposite edge
        const [x, , w] = editor.getAnnotation('edge').bbox;
        expect(x).toBe(3995);
        expect(x + w).toBeLessThanOrEqual(4000);
        expect(w).toBeGreaterThan(0);
    });

    it('children that start outside their box are not thrown out of the image by a resize', () => {
        const { editor, svg } = makeEditor({
            annotations: [{ id: 'K', bbox: [700, 100, 50, 50], keypoints: [{ point: [760, 120] }] }]
        });
        editor.select('K');
        drag(handleEl(svg, 'se'), [750, 150], [800, 150]);
        const out = editor.getAnnotation('K');
        expect(out.bbox).toEqual([700, 100, 100, 50]);
        expect(out.keypoints[0].point).toEqual([800, 120]); // inside the box, inside the image, y untouched
    });

    it('nor when they are bound to the box without being contained by it', () => {
        const { editor, svg } = makeEditor({
            bboxContainKeypoints: false,
            annotations: [
                { id: 'K', bbox: [700, 100, 50, 50], keypoints: [{ point: [760, 120] }, { point: [710, 120] }] }
            ]
        });
        editor.select('K');
        drag(handleEl(svg, 'se'), [750, 150], [800, 150]);
        // Scaled with the box (x doubles from its left edge), then stopped at the image edge.
        expect(editor.getAnnotation('K').keypoints.map((k) => k.point)).toEqual([
            [800, 120],
            [720, 120]
        ]);
    });

    it('a box that is almost a point does not fling its keypoints away when resized', () => {
        const { editor, svg } = makeEditor({
            annotations: [{ id: 'dot', bbox: [300, 300, 0.001, 0.001], keypoints: [{ point: [310, 310] }] }]
        });
        editor.select('dot');
        drag(handleEl(svg, 'se'), [300, 300], [320, 320]);
        const [x, y] = editor.getAnnotation('dot').keypoints[0].point;
        expect(x).toBeGreaterThanOrEqual(300);
        expect(x).toBeLessThanOrEqual(320.001);
        expect(y).toBeLessThanOrEqual(320.001);
    });

    it('moving along one axis does not rewrite the other, even for data that starts out of bounds', () => {
        const { editor } = makeEditor({ silent: true, annotations: [{ id: 'out', bbox: [-50, 100, 40, 40] }] });
        editor.select('out');
        key('ArrowUp');
        expect(editor.getAnnotation('out').bbox).toEqual([-50, 99, 40, 40]);
        key('ArrowRight'); // moving along x does pull it into the image
        expect(editor.getAnnotation('out').bbox).toEqual([0, 99, 40, 40]);

        editor.load([{ id: 'above', bbox: [100, -50, 40, 40] }]);
        editor.select('above');
        key('ArrowRight');
        expect(editor.getAnnotation('above').bbox).toEqual([101, -50, 40, 40]);
    });

    it('nor for a single keypoint or vertex that starts outside its box', () => {
        const { editor, svg } = makeEditor({
            annotations: [
                {
                    id: 'P',
                    bbox: [100, 100, 200, 200],
                    segments: [
                        [50, 150],
                        [250, 150],
                        [200, 250]
                    ],
                    keypoints: [{ point: [400, 150] }]
                }
            ]
        });
        editor.select('P', 'keypoint', 0);
        key('ArrowDown');
        expect(editor.getAnnotation('P').keypoints[0].point).toEqual([400, 151]);
        key('ArrowLeft'); // moving along x does bring it into the box
        expect(editor.getAnnotation('P').keypoints[0].point).toEqual([300, 151]);

        editor.select('P', 'polygon');
        press(handleEl(svg, 'vertex', 0), 50, 150);
        move(50, 160);
        move(50, 170);
        release(50, 170);
        expect(editor.getAnnotation('P').segments[0]).toEqual([50, 170]);
    });

    it('the same for a polygon that starts a hair outside its box', () => {
        const { editor, svg } = makeEditor({
            annotations: [
                {
                    id: 'P',
                    bbox: [100, 100, 200, 200],
                    segments: [
                        [99.996, 150],
                        [200, 150],
                        [150, 250]
                    ]
                }
            ]
        });
        click(polygonEl(svg, 'P'), 150, 180);
        press(polygonEl(svg, 'P'), 150, 180);
        move(150, 190);
        move(150, 200);
        release(150, 200);
        expect(editor.getAnnotation('P').segments.map((p) => p[0])).toEqual([99.996, 200, 150]);
        expect(editor.getAnnotation('P').segments[0][1]).toBe(170);
    });
});

describe('handles', () => {
    it('grab areas shrink on a small box so the box itself can still be pressed', () => {
        const { editor, svg } = makeEditor({
            annotations: [
                { id: 'small', bbox: [100, 100, 20, 20] },
                { id: 'large', bbox: [300, 300, 200, 100] }
            ]
        });
        editor.select('small');
        expect(num(handleEl(svg, 'se'), 'r')).toBe(5); // no wider than the visible handle
        editor.select('large');
        expect(num(handleEl(svg, 'se'), 'r')).toBe(11);
    });

    it('on a dense polygon the press takes the nearest vertex, not whichever handle is on top', () => {
        const dense = {
            id: 'D',
            segments: [
                [100, 100],
                [300, 100],
                [304, 104], // 5.7px from the previous vertex: their grab areas overlap
                [300, 300],
                [100, 300]
            ]
        };
        const { editor, svg } = makeEditor({ annotations: [dense] });
        editor.select('D');
        // The handle of vertex 2 is drawn above that of vertex 1 and receives the press,
        // but the press is right on vertex 1.
        drag(handleEl(svg, 'vertex', 2), [300, 100], [300, 60]);
        const out = editor.getAnnotation('D').segments;
        expect(out[1]).toEqual([300, 60]);
        expect(out[2]).toEqual([304, 104]);
    });
});

describe('host code running in the middle of a press', () => {
    it('a blur handler that deletes the pressed annotation', () => {
        const { editor, svg } = makeEditor({ annotations: [BOX] });
        const input = document.createElement('input');
        document.body.appendChild(input);
        input.focus();
        input.addEventListener('blur', () => editor.deleteAnnotation('A'));
        expect(() => drag(bboxEl(svg, 'A'), [150, 150], [250, 150])).not.toThrow();
        expect(editor.getAnnotations()).toEqual([]);
    });

    it('a change listener that reloads without the pressed annotation', () => {
        const { editor, svg } = makeEditor({ annotations: [BOX, OTHER] });
        editor.select('A');
        key('ArrowRight'); // an uncommitted nudge: the press below commits it and emits change
        editor.on('change', () => editor.load([OTHER]));
        const target = bboxEl(svg, 'A');
        expect(() => drag(target, [150, 150], [250, 150])).not.toThrow();
        expect(editor.getAnnotations()).toEqual([OTHER]);
    });

    it('a select listener that removes the pressed keypoint', () => {
        const pose = { id: 'P', bbox: [100, 100, 200, 200], keypoints: [{ point: [150, 150] }, { point: [250, 250] }] };
        const { editor, svg } = makeEditor({ annotations: [pose], requireSelectionToDrag: false });
        editor.on('select', () => editor.updateAnnotation('P', { keypoints: [pose.keypoints[0]] }));
        expect(() => drag(keypointEl(svg, 'P', 1), [250, 250], [200, 200])).not.toThrow();
        expect(editor.getAnnotation('P').keypoints).toEqual([pose.keypoints[0]]);
    });

    it('a select listener that deselects or disables: nothing is dragged', () => {
        for (const refuse of [(e) => e.deselect(), (e) => e.disable()]) {
            const { editor, svg } = makeEditor({ annotations: [BOX], requireSelectionToDrag: false });
            editor.on('select', () => refuse(editor)); // e.g. the annotation is locked
            drag(bboxEl(svg, 'A'), [150, 150], [250, 150]);
            expect(editor.getAnnotation('A')).toEqual(BOX);
            expect(editor.canUndo()).toBe(false);
            cleanup();
        }
    });

    it('addKeypoint during a drag puts the drag back first, then adds to consistent data', () => {
        const pose = { id: 'P', bbox: [100, 100, 100, 100], keypoints: [{ point: [150, 150] }] };
        const { editor, svg } = makeEditor({ annotations: [pose] });
        editor.select('P');
        press(bboxEl(svg, 'P'), 110, 110);
        move(310, 310);
        expect(editor.addKeypoint('P', { point: [120, 120] })).toBe(true);
        release(310, 310);
        expect(editor.getAnnotation('P')).toEqual({
            ...pose,
            keypoints: [{ point: [150, 150] }, { point: [120, 120] }]
        });
    });
});

describe('a press that never ended', () => {
    it('ends when the left button is released while another one is still held', () => {
        const { editor, svg } = makeEditor({ annotations: [BOX] });
        editor.select('A');
        press(bboxEl(svg, 'A'), 150, 150);
        move(200, 150);
        move(300, 150, { buttons: 2 }); // left released, right still down: the browser sends no pointerup
        move(400, 150, { buttons: 2 });
        expect(editor.getAnnotation('A').bbox).toEqual([150, 100, 200, 100]);
    });

    it('a new press with the same pointer finishes one whose release was missed', () => {
        const { editor, svg } = makeEditor({ annotations: [BOX] });
        const clicks = [];
        editor.on('canvasclick', (e) => clicks.push(e));
        press(svg, 600, 500); // released outside the window: no pointerup ever arrives
        click(bboxEl(svg, 'A'), 150, 150);
        expect(editor.getSelection().id).toBe('A');
        expect(clicks).toEqual([]);

        press(bboxEl(svg, 'A'), 150, 150);
        move(250, 150); // a drag whose release is missed keeps what was dragged
        drag(bboxEl(svg, 'A'), [260, 150], [270, 150]);
        expect(editor.getAnnotation('A').bbox[0]).toBe(210);
        expect(editor.undo()).toBe(true);
        expect(editor.getAnnotation('A').bbox[0]).toBe(200);
    });
});

describe('focus', () => {
    it('asks for window focus when the page did not have it, as inside an iframe', () => {
        const { svg } = makeEditor({ annotations: [BOX] });
        const before = focusCalls.count;
        click(bboxEl(svg, 'A'), 150, 150);
        expect(focusCalls.count).toBe(before + 1);
        click(svg, 600, 500); // a press on the canvas is not prevented, so the browser handles focus
        expect(focusCalls.count).toBe(before + 1);
    });

    it('takes typing focus out of a field inside a shadow root', () => {
        const { editor, svg } = makeEditor({ annotations: [BOX] });
        const host = document.createElement('label-field');
        const input = document.createElement('input');
        host.attachShadow({ mode: 'open' }).appendChild(input);
        document.body.appendChild(host);
        input.focus();
        expect(host.shadowRoot.activeElement).toBe(input);

        click(bboxEl(svg, 'A'), 150, 150);
        expect(host.shadowRoot.activeElement).toBe(null);
        key('Delete');
        expect(editor.getAnnotations()).toEqual([]);
    });

    it('takes focus back from another frame', () => {
        const { svg } = makeEditor({ annotations: [BOX] });
        const frame = document.createElement('iframe');
        document.body.appendChild(frame);
        frame.focus();
        expect(document.activeElement).toBe(frame);
        click(bboxEl(svg, 'A'), 150, 150);
        expect(document.activeElement).not.toBe(frame);
    });
});

describe('an SVG in another document than the script', () => {
    it('follows the pointer and the keyboard of the document the SVG is in', () => {
        const frame = document.createElement('iframe');
        document.body.appendChild(frame);
        const doc = frame.contentDocument;
        const win = frame.contentWindow;
        win.focus = () => {}; // not implemented in jsdom
        const svg = doc.createElementNS(SVG_NS, 'svg');
        svg.setAttribute('viewBox', '0 0 800 600');
        setBox(svg, { left: 0, top: 0, width: 800, height: 600 });
        doc.body.appendChild(svg);
        const editor = track(MarkinJS.create(svg, { silent: true, annotations: [BOX] }));
        const rect = svg.querySelector('[data-markin-part="bbox"]');
        expect(rect.ownerDocument).toBe(doc);

        // The first press must end, or nothing after it would work.
        pointer('pointerdown', rect, 150, 150);
        pointer('pointerup', win, 150, 150);
        pointer('pointerdown', rect, 150, 150);
        pointer('pointermove', win, 250, 150);
        pointer('pointerup', win, 250, 150);
        expect(editor.getAnnotation('A').bbox).toEqual([200, 100, 200, 100]);

        doc.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true, cancelable: true }));
        expect(editor.getAnnotations()).toEqual([]);
        expect(makeSvg()).toBeTruthy(); // the outer page is untouched and still usable
    });
});
