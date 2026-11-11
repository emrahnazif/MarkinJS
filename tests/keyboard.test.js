import { describe, it, expect, afterEach, vi } from 'vitest';
import { makeEditor, press, release, click, key, keyUp, bboxEl, BOX } from './setup.js';

afterEach(() => vi.useRealTimers());

const FULL = {
    id: 'F',
    bbox: [100, 100, 200, 200],
    segments: [
        [120, 120],
        [280, 120],
        [280, 280]
    ],
    keypoints: [
        { name: 'a', point: [150, 150] },
        { name: 'b', point: [250, 250] }
    ]
};

describe('arrow keys', () => {
    it('move the selection by 1, by 10 with Shift and by 0.2 with Ctrl or Cmd', () => {
        const { editor } = makeEditor({ annotations: [BOX] });
        editor.select('A');
        expect(key('ArrowRight').defaultPrevented).toBe(true);
        key('ArrowDown');
        expect(editor.getAnnotation('A').bbox).toEqual([101, 101, 200, 100]);
        key('ArrowLeft', { shiftKey: true });
        key('ArrowUp', { shiftKey: true });
        expect(editor.getAnnotation('A').bbox).toEqual([91, 91, 200, 100]);
        key('ArrowRight', { ctrlKey: true });
        key('ArrowRight', { metaKey: true });
        expect(editor.getAnnotation('A').bbox[0]).toBeCloseTo(91.4, 10);
    });

    it('do nothing without a selection and leave the key to the page', () => {
        const { editor } = makeEditor({ annotations: [BOX] });
        expect(key('ArrowRight').defaultPrevented).toBe(false);
        expect(editor.getAnnotation('A')).toEqual(BOX);
    });

    it('move bound children once, not twice', () => {
        const { editor } = makeEditor({ annotations: [FULL], skeleton: [['a', 'b']] });
        editor.select('F');
        for (let i = 0; i < 10; i++) key('ArrowRight');
        const out = editor.getAnnotation('F');
        expect(out.bbox).toEqual([110, 100, 200, 200]);
        expect(out.keypoints.map((k) => k.point)).toEqual([
            [160, 150],
            [260, 250]
        ]);
        expect(out.segments[0]).toEqual([130, 120]);
        const line = editor.getSVGElement().querySelector('.markin-skeleton line');
        expect([line.getAttribute('x1'), line.getAttribute('x2')]).toEqual(['160', '260']);
    });

    it('move a single keypoint, kept inside its box', () => {
        const { editor } = makeEditor({ annotations: [FULL] });
        editor.select('F', 'keypoint', 0);
        key('ArrowLeft', { shiftKey: true });
        expect(editor.getAnnotation('F').keypoints[0].point).toEqual([140, 150]);
        for (let i = 0; i < 9; i++) key('ArrowLeft', { shiftKey: true });
        expect(editor.getAnnotation('F').keypoints[0].point).toEqual([100, 150]);
        expect(editor.getAnnotation('F').bbox).toEqual(FULL.bbox);
    });

    it('move a whole annotation that has no box, and stop at the image edge', () => {
        const points = {
            id: 'K',
            keypoints: [{ point: [5, 300] }, { point: [50, 320] }]
        };
        const { editor } = makeEditor({ annotations: [points] });
        editor.select('K');
        expect(editor.getSelection().part).toBe(null);
        key('ArrowLeft', { shiftKey: true });
        expect(editor.getAnnotation('K').keypoints.map((k) => k.point)).toEqual([
            [0, 300],
            [45, 320]
        ]);
    });

    it('a held key becomes one undo step, and earlier steps survive', () => {
        const { editor } = makeEditor();
        editor.createAnnotation(BOX);
        editor.createAnnotation({ id: 'B', bbox: [10, 10, 20, 20] });
        editor.select('A');
        const changes = [];
        editor.on('change', (list, info) => changes.push(info));

        for (let i = 0; i < 60; i++) key('ArrowRight'); // two seconds of key repeat
        expect(changes).toEqual([]);
        expect(editor.canUndo()).toBe(true);
        keyUp('ArrowRight');

        expect(changes).toEqual([{ reason: 'update', ids: ['A'] }]);
        expect(editor.getAnnotation('A').bbox[0]).toBe(160);
        editor.undo();
        expect(editor.getAnnotation('A').bbox[0]).toBe(100);
        editor.undo();
        expect(editor.getAnnotations().map((a) => a.id)).toEqual(['A']);
        editor.undo();
        expect(editor.getAnnotations()).toEqual([]);
    });

    it('commits a run of nudges after a pause even if the key-up is never seen', () => {
        vi.useFakeTimers();
        const { editor } = makeEditor({ annotations: [BOX] });
        editor.select('A');
        let changes = 0;
        editor.on('change', () => changes++);
        key('ArrowRight');
        key('ArrowRight');
        vi.advanceTimersByTime(500);
        expect(changes).toBe(0);
        vi.advanceTimersByTime(400);
        expect(changes).toBe(1);
        editor.undo();
        expect(editor.getAnnotation('A')).toEqual(BOX);
    });

    it('undo right after nudging takes back the whole run', () => {
        const { editor } = makeEditor({ annotations: [BOX] });
        editor.select('A');
        key('ArrowRight');
        key('ArrowRight');
        key('z', { ctrlKey: true });
        expect(editor.getAnnotation('A')).toEqual(BOX);
        expect(editor.canRedo()).toBe(true);
    });
});

describe('typing elsewhere on the page', () => {
    const fields = {
        'an <input>': () => document.createElement('input'),
        'a <textarea>': () => document.createElement('textarea'),
        'a <select>': () => document.createElement('select'),
        'a contenteditable element': () => {
            const div = document.createElement('div');
            div.setAttribute('contenteditable', 'true');
            return div;
        },
        'a child of a contenteditable element': () => {
            const div = document.createElement('div');
            div.setAttribute('contenteditable', '');
            const span = document.createElement('span');
            div.appendChild(span);
            document.body.appendChild(div);
            return span;
        }
    };

    for (const [name, make] of Object.entries(fields)) {
        it(`keys typed into ${name} are left alone`, () => {
            const { editor } = makeEditor();
            editor.createAnnotation(BOX);
            editor.createAnnotation({ id: 'B', bbox: [10, 10, 20, 20] });
            editor.select('A');
            const field = make();
            if (!field.isConnected) document.body.appendChild(field);

            const sent = [
                key('Backspace', {}, field),
                key('Delete', {}, field),
                key('ArrowLeft', {}, field),
                key('z', { ctrlKey: true }, field),
                key('y', { ctrlKey: true }, field),
                key('Escape', {}, field)
            ];

            expect(sent.map((e) => e.defaultPrevented)).toEqual([false, false, false, false, false, false]);
            expect(editor.getAnnotations().length).toBe(2);
            expect(editor.getAnnotation('A')).toEqual(BOX);
            expect(editor.getSelection().id).toBe('A');
        });
    }

    it('keys from a button still work, so toolbar-driven flows keep the keyboard', () => {
        const { editor } = makeEditor({ annotations: [BOX] });
        const button = document.createElement('button');
        document.body.appendChild(button);
        editor.select('A');
        key('ArrowRight', {}, button);
        expect(editor.getAnnotation('A').bbox[0]).toBe(101);
    });

    it('keys typed inside a web component are left alone, whether its shadow root is open or closed', () => {
        const { editor } = makeEditor({ annotations: [BOX] });
        editor.select('A');

        const open = document.createElement('open-field');
        const inner = document.createElement('input');
        open.attachShadow({ mode: 'open' }).appendChild(inner);
        const closed = document.createElement('closed-field');
        closed.attachShadow({ mode: 'closed' }).appendChild(document.createElement('input'));
        document.body.append(open, closed);

        // From an open root the event's path leads to the real field; from a closed one only the
        // host element is visible, so a custom element is treated as something that may hold a field.
        expect(key('Backspace', {}, inner).defaultPrevented).toBe(false);
        expect(key('Backspace', {}, closed).defaultPrevented).toBe(false);
        expect(key('ArrowLeft', {}, closed).defaultPrevented).toBe(false);
        expect(editor.getAnnotation('A')).toEqual(BOX);
    });

    it('a key whose name is also a property of every object does nothing', () => {
        const { editor } = makeEditor({ annotations: [BOX] });
        editor.select('A');
        for (const name of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
            key(name);
            keyUp(name);
        }
        expect(editor.getAnnotation('A')).toEqual(BOX);
        expect(editor.canUndo()).toBe(false);
    });

    it('ignores keys another handler already used, keys during IME input and events with no key', () => {
        const { editor } = makeEditor({ annotations: [BOX] });
        editor.select('A');
        const used = (e) => e.preventDefault();
        document.body.addEventListener('keydown', used);
        key('Delete');
        document.body.removeEventListener('keydown', used);
        key('Delete', { isComposing: true });
        // Chrome's autofill sends keydown events that have no `key` at all.
        expect(() => document.body.dispatchEvent(new Event('keydown', { bubbles: true }))).not.toThrow();
        expect(editor.getAnnotation('A')).toEqual(BOX);
    });
});

describe('Delete and the deletion rules', () => {
    it('Delete and Backspace remove the selection', () => {
        const { editor } = makeEditor({ annotations: [BOX, { id: 'B', bbox: [10, 10, 20, 20] }] });
        editor.select('A');
        expect(key('Delete').defaultPrevented).toBe(true);
        editor.select('B');
        key('Backspace');
        expect(editor.getAnnotations()).toEqual([]);
    });

    it('by default deleting the box deletes the annotation', () => {
        const { editor } = makeEditor({ annotations: [FULL] });
        const changes = [];
        editor.on('change', (list, info) => changes.push(info));
        editor.select('F', 'bbox');
        expect(editor.deleteSelected()).toBe(true);
        expect(editor.getAnnotations()).toEqual([]);
        expect(editor.getSelection()).toBe(null);
        expect(changes).toEqual([{ reason: 'delete', ids: ['F'] }]);
    });

    it('by default deleting a keypoint removes only that keypoint', () => {
        const { editor } = makeEditor({ annotations: [FULL] });
        const changes = [];
        editor.on('change', (list, info) => changes.push(info));
        editor.select('F', 'keypoint', 0);
        editor.deleteSelected();
        expect(editor.getAnnotation('F')).toEqual({ ...FULL, keypoints: [FULL.keypoints[1]] });
        expect(editor.getSelection()).toBe(null);
        expect(changes).toEqual([{ reason: 'update', ids: ['F'] }]);
    });

    it('by default deleting the polygon also removes the box and keeps the keypoints', () => {
        const { editor, svg } = makeEditor({ annotations: [FULL] });
        editor.select('F', 'polygon');
        editor.deleteSelected();
        expect(editor.getAnnotation('F')).toEqual({ id: 'F', keypoints: FULL.keypoints });
        expect(svg.querySelectorAll('[data-markin-part="bbox"], [data-markin-part="polygon"]').length).toBe(0);
        expect(svg.querySelectorAll('[data-markin-part="keypoint"]').length).toBe(2);
    });

    it('honours exactly the roles a rule lists', () => {
        // "Remove the markers with the region" - the polygon must survive.
        const { editor } = makeEditor({ annotations: [FULL], deletionRules: { bbox: ['keypoint'] } });
        editor.select('F', 'bbox');
        editor.deleteSelected();
        expect(editor.getAnnotation('F')).toEqual({ id: 'F', segments: FULL.segments });
    });

    it('an empty rule deletes just the part', () => {
        const { editor } = makeEditor({ annotations: [FULL], deletionRules: { bbox: [], polygon: [] } });
        editor.select('F', 'bbox');
        editor.deleteSelected();
        expect(editor.getAnnotation('F')).toEqual({ id: 'F', segments: FULL.segments, keypoints: FULL.keypoints });
        editor.select('F', 'polygon');
        editor.deleteSelected();
        expect(editor.getAnnotation('F')).toEqual({ id: 'F', keypoints: FULL.keypoints });
    });

    it('"annotation" in a rule deletes the whole annotation', () => {
        const { editor } = makeEditor({ annotations: [FULL], deletionRules: { keypoint: ['annotation'] } });
        editor.select('F', 'keypoint', 1);
        editor.deleteSelected();
        expect(editor.getAnnotations()).toEqual([]);
    });

    it('an annotation left with no geometry is removed, never kept as an empty shell', () => {
        const { editor, svg } = makeEditor({
            annotations: [{ id: 'K', keypoints: [{ name: 'only', point: [10, 10] }] }],
            skeleton: [['only', 'gone']]
        });
        editor.select('K', 'keypoint', 0);
        editor.deleteSelected();
        expect(editor.getAnnotations()).toEqual([]);
        expect(svg.querySelectorAll('[data-markin-id]').length).toBe(0);
    });

    it('setOptions changes the rules for annotations that already exist', () => {
        const { editor } = makeEditor({ annotations: [FULL] });
        editor.setOptions({ deletionRules: { bbox: [] } });
        editor.select('F', 'bbox');
        editor.deleteSelected();
        expect(editor.getAnnotation('F').keypoints.length).toBe(2);
    });

    it('every deletion can be undone', () => {
        const { editor } = makeEditor({ annotations: [FULL] });
        editor.select('F', 'bbox');
        key('Delete');
        expect(editor.getAnnotations()).toEqual([]);
        key('z', { ctrlKey: true });
        expect(editor.getAnnotations()).toEqual([FULL]);
    });

    it('deleteSelected with nothing selected does nothing', () => {
        const { editor } = makeEditor({ annotations: [BOX] });
        expect(editor.deleteSelected()).toBe(false);
        expect(key('Delete').defaultPrevented).toBe(false);
        expect(editor.getAnnotations()).toEqual([BOX]);
    });
});

describe('undo and redo shortcuts', () => {
    it('Ctrl+Z undoes; Ctrl+Shift+Z and Ctrl+Y redo; Cmd works the same', () => {
        const { editor } = makeEditor();
        editor.createAnnotation(BOX);
        expect(key('z', { ctrlKey: true }).defaultPrevented).toBe(true);
        expect(editor.getAnnotations()).toEqual([]);
        // With Shift held the browser reports an upper-case "Z".
        key('Z', { ctrlKey: true, shiftKey: true });
        expect(editor.getAnnotations()).toEqual([BOX]);
        key('z', { metaKey: true });
        expect(editor.getAnnotations()).toEqual([]);
        key('y', { ctrlKey: true });
        expect(editor.getAnnotations()).toEqual([BOX]);
        key('Z', { ctrlKey: true }); // Caps Lock on
        expect(editor.getAnnotations()).toEqual([]);
        key('z', { metaKey: true, shiftKey: true });
        expect(editor.getAnnotations()).toEqual([BOX]);
    });

    it('leaves Ctrl+Z to the page when history is off', () => {
        const { editor } = makeEditor({ historyEnabled: false });
        editor.createAnnotation(BOX);
        expect(key('z', { ctrlKey: true }).defaultPrevented).toBe(false);
        expect(editor.getAnnotations()).toEqual([BOX]);
    });

    it('Escape deselects, and is still left for an open dialog or menu to see', () => {
        const { editor } = makeEditor({ annotations: [BOX] });
        editor.select('A');
        expect(key('Escape').defaultPrevented).toBe(false);
        expect(editor.getSelection()).toBe(null);
    });

    it('takes Ctrl+Z only when there is something to undo', () => {
        const { editor } = makeEditor({ annotations: [BOX] });
        expect(key('z', { ctrlKey: true }).defaultPrevented).toBe(false);
        expect(key('y', { ctrlKey: true }).defaultPrevented).toBe(false);
        editor.updateAnnotation('A', { class_id: 5 });
        expect(key('z', { ctrlKey: true }).defaultPrevented).toBe(true);
    });

    it('finds undo and redo on keyboard layouts without Latin letters', () => {
        const { editor } = makeEditor();
        editor.createAnnotation(BOX);
        key('я', { ctrlKey: true, code: 'KeyZ' }); // Russian layout
        expect(editor.getAnnotations()).toEqual([]);
        key('Я', { ctrlKey: true, shiftKey: true, code: 'KeyZ' });
        expect(editor.getAnnotations()).toEqual([BOX]);
        key('я', { ctrlKey: true, code: 'KeyZ' });
        key('н', { ctrlKey: true, code: 'KeyY' });
        expect(editor.getAnnotations()).toEqual([BOX]);
        // A Latin layout decides by the letter, not by where the key sits (AZERTY has W there).
        key('w', { ctrlKey: true, code: 'KeyZ' });
        expect(editor.getAnnotations()).toEqual([BOX]);
    });
});

describe('who owns the keyboard', () => {
    it('with two editors on a page, only the one the user last pressed on reacts', () => {
        const one = makeEditor({ annotations: [BOX] });
        const two = makeEditor({ annotations: [BOX] });
        one.editor.select('A');
        two.editor.select('A');

        click(bboxEl(two.svg, 'A'), 150, 150);
        key('Delete');
        expect(one.editor.getAnnotations()).toEqual([BOX]);
        expect(two.editor.getAnnotations()).toEqual([]);

        click(bboxEl(one.svg, 'A'), 150, 150);
        key('ArrowRight');
        key('z', { ctrlKey: true });
        expect(one.editor.getAnnotation('A')).toEqual(BOX);
        expect(two.editor.getAnnotations()).toEqual([]);
        expect(two.editor.canUndo()).toBe(true);
    });

    it('selecting or creating from code does not take the keyboard from the editor in use', () => {
        const one = makeEditor({ annotations: [BOX] });
        const two = makeEditor({ annotations: [BOX] });
        // Mirrored selection: whatever is selected on the left is selected on the right too.
        one.editor.on('select', (selection) => two.editor.select(selection.id));

        click(bboxEl(one.svg, 'A'), 150, 150);
        expect(two.editor.getSelection().id).toBe('A');
        two.editor.createAnnotation({ id: 'B', bbox: [1, 2, 3, 4] });
        key('Delete');

        expect(one.editor.getAnnotations()).toEqual([]);
        expect(two.editor.getAnnotations().length).toBe(2);
    });

    it('pressing on the canvas of an editor is enough to give it the keyboard', () => {
        const one = makeEditor();
        const two = makeEditor();
        one.editor.createAnnotation(BOX, { select: false });
        two.editor.createAnnotation(BOX, { select: false });
        press(one.svg, 600, 500);
        release(600, 500);
        key('z', { ctrlKey: true });
        expect(one.editor.getAnnotations()).toEqual([]);
        expect(two.editor.getAnnotations()).toEqual([BOX]);
    });

    it('an editor whose SVG left the page without destroy() no longer takes keys', () => {
        const { editor, svg } = makeEditor({ annotations: [BOX] });
        editor.createAnnotation({ id: 'B', bbox: [1, 2, 3, 4] });
        svg.remove(); // e.g. a route change in a single-page app
        const textarea = document.createElement('textarea');
        document.body.appendChild(textarea);
        expect(key('z', { ctrlKey: true }, textarea).defaultPrevented).toBe(false);
        expect(key('z', { ctrlKey: true }).defaultPrevented).toBe(false);
        expect(key('Delete').defaultPrevented).toBe(false);
        expect(editor.getAnnotations().length).toBe(2);
    });

    it('a new editor takes over from one that left the page', () => {
        const gone = makeEditor({ annotations: [BOX] });
        gone.svg.remove();
        const fresh = makeEditor();
        fresh.editor.createAnnotation(BOX, { select: false });
        key('z', { ctrlKey: true });
        expect(fresh.editor.getAnnotations()).toEqual([]);
    });

    it('keyboardControls: false turns all of it off, and can be switched back on', () => {
        const { editor } = makeEditor({ annotations: [BOX], keyboardControls: false });
        editor.select('A');
        expect(key('ArrowRight').defaultPrevented).toBe(false);
        expect(key('Delete').defaultPrevented).toBe(false);
        expect(editor.getAnnotation('A')).toEqual(BOX);
        editor.setOptions({ keyboardControls: true });
        key('ArrowRight');
        expect(editor.getAnnotation('A').bbox[0]).toBe(101);
    });

    it('destroy() stops listening', () => {
        const { editor } = makeEditor({ annotations: [BOX] });
        editor.select('A');
        editor.destroy();
        expect(key('Delete').defaultPrevented).toBe(false);
        expect(key('z', { ctrlKey: true }).defaultPrevented).toBe(false);
    });
});
