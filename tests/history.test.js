import { describe, it, expect } from 'vitest';
import {
    makeEditor,
    press,
    move,
    release,
    click,
    drag,
    bboxEl,
    keypointEl,
    handleEl,
    num,
    BOX,
    OTHER
} from './setup.js';

const POSE = {
    id: 'P',
    bbox: [100, 100, 200, 200],
    keypoints: [
        { name: 'a', point: [150, 150] },
        { name: 'b', point: [250, 250] }
    ]
};

describe('undo and redo', () => {
    it('step back and forward through create, update, drag, delete and clear', () => {
        const { editor, svg } = makeEditor();
        editor.createAnnotation(BOX);
        editor.updateAnnotation('A', { class_id: 2 });
        drag(bboxEl(svg, 'A'), [150, 150], [250, 150]);
        editor.createAnnotation(POSE);
        editor.deleteAnnotation('A');
        editor.clear();

        const states = [];
        while (editor.undo()) states.push(editor.getAnnotations());
        expect(states.map((list) => list.map((a) => `${a.id}:${a.class_id ?? '-'}:${a.bbox[0]}`))).toEqual([
            ['P:-:100'],
            ['A:2:200', 'P:-:100'],
            ['A:2:200'],
            ['A:2:100'],
            ['A:1:100'],
            []
        ]);
        expect(editor.canUndo()).toBe(false);

        let steps = 0;
        while (editor.redo()) steps++;
        expect(steps).toBe(6);
        expect(editor.getAnnotations()).toEqual([]);
        expect(editor.canRedo()).toBe(false);
    });

    it('report whether they did anything', () => {
        const { editor } = makeEditor();
        expect(editor.canUndo()).toBe(false);
        expect(editor.canRedo()).toBe(false);
        expect(editor.undo()).toBe(false);
        expect(editor.redo()).toBe(false);
        editor.createAnnotation(BOX);
        expect(editor.canUndo()).toBe(true);
        expect(editor.undo()).toBe(true);
        expect(editor.canRedo()).toBe(true);
    });

    it('a new change after an undo drops the redo steps', () => {
        const { editor } = makeEditor();
        editor.createAnnotation(BOX);
        editor.undo();
        editor.createAnnotation(POSE);
        expect(editor.canRedo()).toBe(false);
        expect(editor.redo()).toBe(false);
        expect(editor.getAnnotations().map((a) => a.id)).toEqual(['P']);
    });

    it('restore the drawing as well as the data', () => {
        const { editor, svg } = makeEditor();
        editor.createAnnotation(BOX);
        drag(bboxEl(svg, 'A'), [150, 150], [250, 180]);
        expect(num(bboxEl(svg, 'A'), 'x')).toBe(200);
        editor.undo();
        expect(num(bboxEl(svg, 'A'), 'x')).toBe(100);
        expect(num(bboxEl(svg, 'A'), 'y')).toBe(100);
        editor.undo();
        expect(bboxEl(svg, 'A')).toBe(null);
        editor.redo();
        editor.redo();
        expect(num(bboxEl(svg, 'A'), 'x')).toBe(200);
    });

    it('never bring back selection handles or selection styling', () => {
        const { editor, svg } = makeEditor();
        editor.createAnnotation(BOX); // selected, with handles, at the time the step is recorded
        editor.createAnnotation(OTHER);
        editor.deselect();
        editor.undo();

        expect(svg.querySelectorAll('.markin-ui *').length).toBe(0);
        expect(svg.querySelectorAll('[stroke-dasharray]').length).toBe(0);
        expect(svg.querySelectorAll('[data-selected]').length).toBe(0);
        expect(editor.getSelection()).toBe(null);
    });

    it('never leave a keypoint stuck in its selected look', () => {
        const { editor, svg } = makeEditor();
        editor.createAnnotation(POSE, { select: false });
        const normal = num(keypointEl(svg, 'P', 0), 'r');
        click(keypointEl(svg, 'P', 0), 150, 150);
        expect(num(keypointEl(svg, 'P', 0), 'r')).toBe(normal * 3);
        drag(keypointEl(svg, 'P', 0), [150, 150], [170, 150]); // recorded while selected
        editor.createAnnotation(BOX);
        editor.undo();
        editor.deselect();
        click(keypointEl(svg, 'P', 0), 170, 150);
        editor.deselect();

        expect(num(keypointEl(svg, 'P', 0), 'r')).toBe(normal);
        expect(keypointEl(svg, 'P', 0).getAttribute('fill-opacity')).toBe('0.7');
        expect(svg.querySelectorAll('.markin-ui *').length).toBe(0);
    });

    it('keep the selection when the selected part still exists', () => {
        const { editor, svg } = makeEditor({ annotations: [BOX] });
        editor.select('A');
        drag(bboxEl(svg, 'A'), [150, 150], [250, 150]);
        const events = [];
        editor.on('deselect', (e) => events.push(e));
        editor.undo();
        expect(editor.getSelection()).toMatchObject({ id: 'A', part: 'bbox' });
        expect(num(handleEl(svg, 'nw'), 'cx')).toBe(100);
        expect(events).toEqual([]);
    });

    it('drop the selection, with a deselect event, when its annotation is undone away', () => {
        const { editor, svg } = makeEditor();
        editor.createAnnotation(BOX);
        const events = [];
        editor.on('deselect', (e) => events.push(e));
        editor.undo();
        expect(editor.getSelection()).toBe(null);
        expect(events).toEqual([{ id: 'A', part: 'bbox', index: null }]);
        expect(svg.querySelectorAll('.markin-ui *').length).toBe(0);
    });

    it('tell the host through change, with the full list', () => {
        const { editor } = makeEditor();
        editor.createAnnotation(BOX);
        editor.createAnnotation(POSE);
        const seen = [];
        for (const type of ['change', 'select', 'deselect', 'dragstart', 'dragend']) {
            editor.on(type, (...args) => seen.push(type === 'change' ? [type, args[1], args[0].length] : [type]));
        }
        editor.undo();
        editor.redo();
        expect(seen).toEqual([
            ['deselect'],
            ['change', { reason: 'undo', ids: ['P'] }, 1],
            ['change', { reason: 'redo', ids: ['P'] }, 2]
        ]);
    });

    it('cancel a drag in progress before stepping back', () => {
        const { editor, svg } = makeEditor();
        editor.createAnnotation(BOX);
        press(bboxEl(svg, 'A'), 150, 150);
        move(250, 150);
        editor.undo();
        move(350, 150);
        release(350, 150);
        expect(editor.getAnnotations()).toEqual([]);
        editor.redo();
        expect(editor.getAnnotation('A')).toEqual(BOX);
    });
});

describe('history limits', () => {
    it('keeps at most historyMaxStates states', () => {
        const { editor } = makeEditor({ historyMaxStates: 4 });
        for (let i = 0; i < 10; i++) editor.createAnnotation({ id: i, bbox: [i, i, 10, 10] }, { select: false });
        let steps = 0;
        while (editor.undo()) steps++;
        expect(steps).toBe(3);
        expect(editor.getAnnotations().length).toBe(7);
    });

    it('historyEnabled: false records nothing but still reports changes', () => {
        const { editor } = makeEditor({ historyEnabled: false });
        let changes = 0;
        editor.on('change', () => changes++);
        editor.createAnnotation(BOX);
        expect(changes).toBe(1);
        expect(editor.canUndo()).toBe(false);
        expect(editor.undo()).toBe(false);
        expect(editor.getAnnotations()).toEqual([BOX]);
    });

    it('clearHistory keeps the data and forgets the steps', () => {
        const { editor } = makeEditor();
        editor.createAnnotation(BOX);
        editor.undo();
        editor.redo();
        editor.clearHistory();
        expect(editor.canUndo()).toBe(false);
        expect(editor.canRedo()).toBe(false);
        expect(editor.getAnnotations()).toEqual([BOX]);
    });

    it('lowering historyMaxStates trims the oldest steps and keeps the current state', () => {
        const { editor } = makeEditor();
        for (let i = 0; i < 6; i++) editor.createAnnotation({ id: i, bbox: [i, i, 10, 10] }, { select: false });
        editor.setOptions({ historyMaxStates: 2 });
        expect(editor.getAnnotations().length).toBe(6);
        expect(editor.undo()).toBe(true);
        expect(editor.undo()).toBe(false);
        expect(editor.getAnnotations().length).toBe(5);
    });

    it('turning history off at run time forgets the steps', () => {
        const { editor } = makeEditor();
        editor.createAnnotation(BOX);
        editor.setOptions({ historyEnabled: false });
        expect(editor.canUndo()).toBe(false);
        editor.setOptions({ historyEnabled: true });
        expect(editor.canUndo()).toBe(false);
        editor.updateAnnotation('A', { class_id: 4 });
        expect(editor.undo()).toBe(true);
        expect(editor.getAnnotation('A')).toEqual(BOX);
    });
});
