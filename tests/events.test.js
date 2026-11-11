import { describe, it, expect } from 'vitest';
import { makeEditor, drag, key, keyUp, bboxEl, BOX, OTHER } from './setup.js';

describe('change', () => {
    it('hands over the full list, ready to save', () => {
        const { editor } = makeEditor({ annotations: [BOX] });
        const saved = [];
        editor.on('change', (annotations) => saved.push(annotations));
        editor.createAnnotation(OTHER);
        expect(saved).toEqual([[BOX, OTHER]]);
        expect(saved[0]).toEqual(editor.getAnnotations());
    });

    it('gives each listener data it can keep or modify freely', () => {
        const { editor } = makeEditor({ annotations: [BOX] });
        editor.on('change', (annotations) => {
            annotations[0].bbox[0] = -1;
            annotations.push('junk');
        });
        editor.updateAnnotation('A', { class_id: 3 });
        expect(editor.getAnnotations()).toEqual([{ ...BOX, class_id: 3 }]);
    });

    it('fires once for every completed edit, whatever caused it', () => {
        const { editor, svg } = makeEditor();
        const reasons = [];
        editor.on('change', (annotations, info) => reasons.push(`${info.reason}:${info.ids.join(',')}`));

        editor.createAnnotation(BOX);
        editor.updateAnnotation('A', { class_id: 2 });
        editor.addKeypoint('A', { point: [150, 150] });
        drag(bboxEl(svg, 'A'), [110, 110], [130, 110]);
        key('ArrowRight');
        key('ArrowRight');
        keyUp('ArrowRight');
        editor.createAnnotation(OTHER);
        editor.deleteAnnotation('B');
        editor.undo();
        editor.redo();
        editor.select('A', 'keypoint', 0);
        editor.deleteSelected();
        editor.clear();

        expect(reasons).toEqual([
            'create:A',
            'update:A',
            'update:A',
            'update:A',
            'update:A',
            'create:B',
            'delete:B',
            'undo:B',
            'redo:B',
            'update:A',
            'clear:A'
        ]);
    });

    it('stays quiet for things that are not edits', () => {
        const { editor } = makeEditor({ annotations: [BOX] });
        let changes = 0;
        editor.on('change', () => changes++);
        editor.load([BOX, OTHER]);
        editor.select('A');
        editor.deselect();
        editor.setOptions({ color: '#ff0000' });
        editor.refresh();
        editor.disable();
        editor.enable();
        editor.createAnnotation({ bbox: 'invalid' });
        editor.updateAnnotation('A', { class_id: 1 });
        editor.deleteAnnotation('missing');
        editor.clearHistory();
        expect(changes).toBe(0);
    });
});

describe('on and off', () => {
    it('on() returns a function that removes the listener', () => {
        const { editor } = makeEditor();
        let calls = 0;
        const stop = editor.on('change', () => calls++);
        editor.createAnnotation(BOX);
        stop();
        stop();
        editor.createAnnotation(OTHER);
        expect(calls).toBe(1);
    });

    it('off() removes one listener, or all of them for an event', () => {
        const { editor } = makeEditor();
        const calls = [];
        const first = () => calls.push('first');
        const second = () => calls.push('second');
        editor.on('change', first);
        editor.on('change', second);
        editor.off('change', first);
        editor.createAnnotation(BOX);
        editor.off('change');
        editor.createAnnotation(OTHER);
        editor.off('change', second);
        editor.off('never-registered');
        expect(calls).toEqual(['second']);
    });

    it('a listener may add or remove listeners while the event is being delivered', () => {
        const { editor } = makeEditor();
        const calls = [];
        const stop = editor.on('change', () => {
            calls.push('once');
            stop();
            editor.on('change', () => calls.push('late'));
        });
        editor.on('change', () => calls.push('always'));
        editor.createAnnotation(BOX);
        editor.createAnnotation(OTHER);
        expect(calls).toEqual(['once', 'always', 'always', 'late']);
    });

    it('rejects unknown events, and names the replacement for 0.1 events', () => {
        const { editor, log } = makeEditor();
        let calls = 0;
        const stop = editor.on('annotationcreated', () => calls++);
        editor.on('chnage', () => calls++);
        editor.on('change', 'not a function');
        editor.createAnnotation(BOX);
        expect(calls).toBe(0);
        expect(typeof stop).toBe('function');
        expect(log[0]).toMatch(/unknown event "annotationcreated"\. It was replaced by "change"\./);
        expect(log[1]).toMatch(/unknown event "chnage"\. Events: change, select, deselect/);
        expect(log[2]).toMatch(/needs a function/);
    });

    it('throws for those mistakes in strict mode', () => {
        const { editor } = makeEditor({ strict: true });
        expect(() => editor.on('elementmoved', () => {})).toThrow(/replaced by "change"/);
        expect(() => editor.on('change')).toThrow(TypeError);
    });
});

describe('listeners that misbehave', () => {
    it('a throwing listener is reported and the others still run', () => {
        const { editor, log } = makeEditor();
        const calls = [];
        editor.on('change', () => {
            throw new Error('boom');
        });
        editor.on('change', () => calls.push('ok'));
        expect(editor.createAnnotation(BOX)).toBe('A');
        expect(calls).toEqual(['ok']);
        expect(log).toEqual(['error: a "change" listener threw: boom']);
        expect(editor.getAnnotations()).toEqual([BOX]);
    });

    it('a listener may destroy the editor', () => {
        const { editor, svg } = makeEditor({ annotations: [BOX] });
        editor.on('select', () => editor.destroy());
        expect(() => editor.select('A')).not.toThrow();
        expect(svg.querySelector('.markin-layer')).toBe(null);

        const second = makeEditor();
        second.editor.on('change', () => second.editor.destroy());
        expect(() => second.editor.createAnnotation(BOX)).not.toThrow();
        expect(second.editor.getAnnotations()).toEqual([]);
    });

    it('a listener may edit from inside change without looping forever', () => {
        const { editor } = makeEditor();
        let rounds = 0;
        editor.on('change', () => {
            rounds++;
            editor.updateAnnotation('A', { class_id: 7 });
        });
        editor.createAnnotation(BOX);
        expect(editor.getAnnotation('A').class_id).toBe(7);
        expect(rounds).toBe(2);
    });
});
