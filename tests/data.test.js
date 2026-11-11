import { describe, it, expect } from 'vitest';
import { MarkinJS, repoFile, makeEditor, makeSvg, track, bboxEl, key, click, BOX, SVG_NS } from './setup.js';

const FULL = {
    id: 'F',
    class_id: 2,
    bbox: [100, 100, 200, 200],
    segments: [
        [120, 120],
        [280, 120],
        [280, 280]
    ],
    keypoints: [
        { name: 'head', point: [150, 150], v: 2 },
        { name: 'tail', point: [250, 250], v: 1 }
    ]
};

describe('one data format, the same in and out', () => {
    it('returns exactly what it was given', () => {
        const { editor } = makeEditor();
        editor.createAnnotation(FULL);
        expect(editor.getAnnotations()).toEqual([FULL]);
        expect(editor.getAnnotation('F')).toEqual(FULL);
    });

    it('accepts its own output', () => {
        const { editor } = makeEditor({ annotations: [BOX, FULL] });
        const exported = editor.getAnnotations();
        const { editor: second } = makeEditor();
        expect(second.load(exported)).toBe(true);
        expect(second.getAnnotations()).toEqual(exported);
    });

    it('carries fields it does not know through untouched', () => {
        const { editor } = makeEditor();
        const input = { ...BOX, score: 0.93, source: 'model', meta: { tags: ['a', 'b'], reviewed: false } };
        editor.createAnnotation(input);
        expect(editor.getAnnotations()[0]).toEqual(input);
    });

    it('keeps unknown fields on keypoints', () => {
        const { editor } = makeEditor();
        const input = { id: 'K', keypoints: [{ name: 'nose', point: [10, 20], v: 2, confidence: 0.4 }] };
        editor.createAnnotation(input);
        expect(editor.getAnnotations()[0]).toEqual(input);
    });

    it('keeps empty arrays and nulls that a server model would send', () => {
        const { editor } = makeEditor();
        const input = { id: 'S', class_id: null, bbox: [1, 2, 3, 4], segments: [], keypoints: [] };
        editor.createAnnotation(input);
        expect(editor.getAnnotations()[0]).toEqual(input);
    });

    it('gives an id to an annotation that has none', () => {
        const { editor } = makeEditor();
        const id = editor.createAnnotation({ bbox: [1, 2, 3, 4] });
        expect(typeof id).toBe('string');
        expect(id.length).toBeGreaterThan(8);
        expect(editor.getAnnotations()[0].id).toBe(id);
    });

    it('keeps numeric ids numeric and finds them either way', () => {
        const { editor } = makeEditor();
        expect(editor.createAnnotation({ id: 7, bbox: [1, 2, 3, 4] })).toBe(7);
        expect(editor.getAnnotation(7).id).toBe(7);
        expect(editor.getAnnotation('7').id).toBe(7);
    });

    it('hands out copies, never its own objects', () => {
        const { editor } = makeEditor();
        const input = { id: 'A', bbox: [1, 2, 3, 4] };
        editor.createAnnotation(input);
        input.bbox[0] = 999;
        const out = editor.getAnnotations();
        out[0].bbox[0] = 555;
        expect(editor.getAnnotation('A').bbox).toEqual([1, 2, 3, 4]);
    });

    it('describes a box given from the opposite corner the normal way round', () => {
        const { editor } = makeEditor();
        editor.createAnnotation({ id: 'N', bbox: [300, 200, -200, -100] });
        expect(editor.getAnnotation('N').bbox).toEqual([100, 100, 200, 100]);
    });
});

describe('validation', () => {
    const invalid = {
        'not an object': 'nope',
        null: null,
        'an array': [1, 2, 3],
        'no geometry': { class_id: 1 },
        'only empty geometry': { segments: [], keypoints: [] },
        'bbox with 3 values': { bbox: [1, 2, 3] },
        'bbox with NaN': { bbox: [1, 2, NaN, 4] },
        'bbox with Infinity': { bbox: [1, 2, Infinity, 4] },
        'bbox as strings': { bbox: ['1', '2', '3', '4'] },
        'bbox as an object (0.1 export shape)': { bbox: { x: 1, y: 2, width: 3, height: 4 } },
        'segments with 2 points': {
            segments: [
                [1, 2],
                [3, 4]
            ]
        },
        'segments as a flat array (0.1 shape)': { segments: [1, 2, 3, 4, 5, 6] },
        'segments with a bad point': {
            segments: [
                [1, 2],
                [3, 4],
                [5, 'x']
            ]
        },
        'keypoints not an array': { keypoints: 'nose' },
        'a null keypoint': { keypoints: [null] },
        'a keypoint without a point': { keypoints: [{ name: 'nose' }] },
        'a keypoint with NaN': { keypoints: [{ point: [1, NaN] }] },
        'a keypoint with v = 3': { keypoints: [{ point: [1, 2], v: 3 }] },
        'a keypoint with a numeric name': { keypoints: [{ point: [1, 2], name: 5 }] },
        'an empty id': { id: '', bbox: [1, 2, 3, 4] },
        'an object id': { id: {}, bbox: [1, 2, 3, 4] },
        'an object class_id': { class_id: {}, bbox: [1, 2, 3, 4] }
    };

    for (const [name, input] of Object.entries(invalid)) {
        it(`rejects ${name}`, () => {
            const { editor, log } = makeEditor();
            expect(editor.createAnnotation(input)).toBe(null);
            expect(editor.getAnnotations()).toEqual([]);
            expect(log.length).toBe(1);
            expect(log[0]).toMatch(/^error: createAnnotation: /);
        });
    }

    it('rejects a second annotation with the same id', () => {
        const { editor, log } = makeEditor();
        editor.createAnnotation(BOX);
        expect(editor.createAnnotation({ ...BOX, bbox: [1, 2, 3, 4] })).toBe(null);
        expect(editor.getAnnotations()).toEqual([BOX]);
        expect(log[0]).toMatch(/already exists/);
    });

    it('rejects data that is not JSON', () => {
        const { editor } = makeEditor();
        const loop = { bbox: [1, 2, 3, 4] };
        loop.self = loop;
        expect(editor.createAnnotation(loop)).toBe(null);
    });

    it('throws instead of logging in strict mode', () => {
        const { editor } = makeEditor({ strict: true });
        expect(() => editor.createAnnotation({ bbox: [1, 2, 3] })).toThrow(TypeError);
        expect(() => editor.load([BOX, { bbox: 'x' }])).toThrow(/annotations\[1\]/);
        expect(() => editor.updateAnnotation('missing', {})).toThrow(TypeError);
        expect(editor.getAnnotations()).toEqual([]);
    });

    it('stays quiet when silent', () => {
        const calls = [];
        const svg = makeSvg();
        const editor = track(MarkinJS.create(svg, { silent: true, logger: (...args) => calls.push(args) }));
        expect(editor.createAnnotation(null)).toBe(null);
        expect(calls).toEqual([]);
    });

    it('survives a logger that throws', () => {
        const svg = makeSvg();
        const editor = track(
            MarkinJS.create(svg, {
                logger: () => {
                    throw new Error('logger down');
                }
            })
        );
        expect(editor.createAnnotation(null)).toBe(null);
        expect(editor.createAnnotation(BOX)).toBe('A');
    });

    it('warns once when a bbox reaches outside the image, the sign of an [x1, y1, x2, y2] box', () => {
        const { editor, log } = makeEditor();
        editor.createAnnotation({ id: 'old', bbox: [500, 400, 780, 590] });
        editor.createAnnotation({ id: 'old2', bbox: [500, 400, 780, 590] });
        expect(log.filter((line) => /\[x, y, width, height\]/.test(line)).length).toBe(1);
        expect(editor.getAnnotations().length).toBe(2);
    });
});

describe('updateAnnotation', () => {
    it('changes one field and keeps the rest', () => {
        const { editor } = makeEditor({ annotations: [FULL] });
        expect(editor.updateAnnotation('F', { class_id: 9 })).toBe(true);
        expect(editor.getAnnotation('F')).toEqual({ ...FULL, class_id: 9 });
    });

    it('leaves the annotation alone when the patch is invalid', () => {
        const { editor, log } = makeEditor({ annotations: [FULL] });
        expect(editor.updateAnnotation('F', { bbox: [1, 2, 3] })).toBe(false);
        expect(editor.getAnnotation('F')).toEqual(FULL);
        expect(log[0]).toMatch(/updateAnnotation: bbox must be/);
    });

    it('removes a part when it is set to null', () => {
        const { editor } = makeEditor({ annotations: [FULL] });
        editor.updateAnnotation('F', { segments: null });
        expect(editor.getAnnotation('F').segments).toBe(null);
        expect(editor.getSVGElement().querySelector('[data-markin-part="polygon"]')).toBe(null);
    });

    it('refuses to remove the last geometry', () => {
        const { editor } = makeEditor({ annotations: [BOX] });
        expect(editor.updateAnnotation('A', { bbox: null })).toBe(false);
        expect(editor.getAnnotation('A')).toEqual(BOX);
    });

    it('cannot change the id or update an unknown one', () => {
        const { editor } = makeEditor({ annotations: [BOX] });
        expect(editor.updateAnnotation('A', { id: 'B' })).toBe(false);
        expect(editor.updateAnnotation('nope', { class_id: 1 })).toBe(false);
        expect(editor.updateAnnotation('A', 'x')).toBe(false);
        expect(editor.getAnnotations()).toEqual([BOX]);
    });

    it('does nothing, and says nothing, when the patch changes nothing', () => {
        const { editor } = makeEditor({ annotations: [BOX] });
        let changes = 0;
        editor.on('change', () => changes++);
        expect(editor.updateAnnotation('A', { class_id: 1 })).toBe(true);
        expect(changes).toBe(0);
        expect(editor.canUndo()).toBe(false);
    });

    it('drops a selection whose part was removed', () => {
        const { editor } = makeEditor({ annotations: [FULL] });
        editor.select('F', 'keypoint', 1);
        const events = [];
        editor.on('deselect', (e) => events.push(e));
        editor.updateAnnotation('F', { keypoints: [FULL.keypoints[0]] });
        expect(editor.getSelection()).toBe(null);
        expect(events).toEqual([{ id: 'F', part: 'keypoint', index: 1 }]);
    });

    it('addKeypoint appends one keypoint', () => {
        const { editor } = makeEditor({ annotations: [BOX] });
        expect(editor.addKeypoint('A', { name: 'nose', point: [150, 150] })).toBe(true);
        expect(editor.getAnnotation('A').keypoints).toEqual([{ name: 'nose', point: [150, 150] }]);
        expect(editor.addKeypoint('A', { name: 'bad' })).toBe(false);
        expect(editor.addKeypoint('nope', { point: [1, 2] })).toBe(false);
        expect(editor.getAnnotation('A').keypoints.length).toBe(1);
    });
});

describe('load, clear and delete', () => {
    it('load replaces everything', () => {
        const { editor, svg } = makeEditor({ annotations: [BOX] });
        expect(editor.load([FULL])).toBe(true);
        expect(editor.getAnnotations()).toEqual([FULL]);
        expect(bboxEl(svg, 'A')).toBe(null);
        expect(bboxEl(svg, 'F')).not.toBe(null);
    });

    it('load changes nothing unless every annotation is valid', () => {
        const { editor, log } = makeEditor({ annotations: [BOX] });
        expect(editor.load([FULL, { bbox: [1, 2] }])).toBe(false);
        expect(editor.load([FULL, { ...FULL }])).toBe(false);
        expect(editor.load('nope')).toBe(false);
        expect(editor.getAnnotations()).toEqual([BOX]);
        expect(log[0]).toMatch(/load: annotations\[1\]: bbox must be/);
        expect(log[1]).toMatch(/duplicate id "F"/);
    });

    it('load starts a fresh history, so undo cannot unload the data', () => {
        const { editor } = makeEditor();
        editor.createAnnotation(BOX);
        editor.load([BOX, FULL]);
        expect(editor.canUndo()).toBe(false);
        expect(editor.undo()).toBe(false);
        key('z', { ctrlKey: true });
        expect(editor.getAnnotations().length).toBe(2);
    });

    it('the annotations option is the same as load', () => {
        const { editor } = makeEditor({ annotations: [BOX, FULL] });
        expect(editor.getAnnotations()).toEqual([BOX, FULL]);
        expect(editor.canUndo()).toBe(false);
        expect(editor.getSelection()).toBe(null);
    });

    it('loads a thousand annotations quickly and keeps the history small', () => {
        const many = [];
        for (let i = 0; i < 1000; i++) {
            many.push({
                id: i,
                bbox: [i % 700, i % 500, 50, 50],
                keypoints: [{ point: [(i % 700) + 10, (i % 500) + 10] }, { point: [(i % 700) + 20, (i % 500) + 20] }]
            });
        }
        const { editor, svg } = makeEditor();
        const started = performance.now();
        editor.load(many);
        expect(performance.now() - started).toBeLessThan(4000);
        expect(svg.querySelectorAll('[data-markin-part="bbox"]').length).toBe(1000);
        // The 0.1 library kept a clone of the whole scene per undo step. Nothing is detached here.
        expect(svg.querySelectorAll('.markin-ui *').length).toBe(0);
        expect(editor.canUndo()).toBe(false);
    });

    it('deleteAnnotation removes one and reports whether it existed', () => {
        const { editor, svg } = makeEditor({ annotations: [BOX, FULL] });
        expect(editor.deleteAnnotation('A')).toBe(true);
        expect(editor.deleteAnnotation('A')).toBe(false);
        expect(editor.getAnnotations()).toEqual([FULL]);
        expect(bboxEl(svg, 'A')).toBe(null);
    });

    it('clear removes everything and can be undone', () => {
        const { editor, svg } = makeEditor({ annotations: [BOX, FULL] });
        editor.select('A');
        editor.clear();
        expect(editor.getAnnotations()).toEqual([]);
        expect(editor.getSelection()).toBe(null);
        expect(svg.querySelectorAll('[data-markin-id]').length).toBe(0);
        editor.undo();
        expect(editor.getAnnotations()).toEqual([BOX, FULL]);
    });
});

describe('normalised coordinates', () => {
    it('getAnnotations({ normalize: true }) divides by the image size', () => {
        const { editor } = makeEditor({ annotations: [FULL] });
        const [out] = editor.getAnnotations({ normalize: true });
        expect(out.bbox).toEqual([0.125, 100 / 600, 0.25, 200 / 600]);
        expect(out.segments[0]).toEqual([0.15, 0.2]);
        expect(out.keypoints[0]).toEqual({ name: 'head', point: [150 / 800, 0.25], v: 2 });
        expect(editor.getAnnotation('F')).toEqual(FULL);
    });

    it('refuses to guess when the image size is unknown', () => {
        const { editor, log } = makeEditor({ annotations: [BOX] }, { viewBox: null });
        expect(editor.getAnnotations({ normalize: true })).toBe(null);
        expect(log[0]).toMatch(/cannot normalize/);
    });

    it('MarkinJS.normalize and denormalize are inverse helpers', () => {
        const normal = MarkinJS.normalize([FULL], 800, 600);
        expect(normal[0].bbox).toEqual([0.125, 100 / 600, 0.25, 200 / 600]);
        const back = MarkinJS.denormalize(normal, 800, 600);
        expect(back[0].bbox.map(Math.round)).toEqual(FULL.bbox);
        expect(back[0].keypoints[1].point.map(Math.round)).toEqual([250, 250]);
        expect(FULL.bbox).toEqual([100, 100, 200, 200]);
        expect(() => MarkinJS.normalize([FULL], 0, 600)).toThrow(TypeError);
        expect(() => MarkinJS.denormalize('x', 1, 1)).toThrow(TypeError);
    });
});

describe('options', () => {
    it('requireBbox derives a box from the other geometry', () => {
        const { editor } = makeEditor({ requireBbox: true });
        editor.createAnnotation({
            id: 'P',
            segments: [
                [10, 20],
                [110, 20],
                [60, 90]
            ],
            keypoints: [{ point: [150, 10] }]
        });
        expect(editor.getAnnotation('P').bbox).toEqual([10, 10, 140, 80]);
    });

    it('requireBbox still holds after the box itself is deleted', () => {
        const { editor } = makeEditor({ requireBbox: true, deletionRules: { bbox: [] } });
        editor.createAnnotation({
            id: 'P',
            bbox: [0, 0, 500, 500],
            segments: [
                [10, 20],
                [110, 20],
                [60, 90]
            ]
        });
        editor.select('P', 'bbox');
        editor.deleteSelected();
        expect(editor.getAnnotation('P').bbox).toEqual([10, 20, 100, 70]);
    });

    it('reports unknown, removed and wrongly typed options and keeps the defaults', () => {
        const { editor, log } = makeEditor({ zoom: 2, autoResizeBbox: true, colour: 'red', strokeWidth: -1 });
        expect(log).toEqual([
            'error: option "zoom" was removed: sizes now follow the on-screen scale automatically',
            'error: option "autoResizeBbox" was removed: it never had an effect',
            'error: unknown option "colour"',
            'error: option "strokeWidth" must be a positive number'
        ]);
        expect(editor.getOptions().strokeWidth).toBe(2);
    });

    it('merges deletion rules over the defaults', () => {
        const { editor } = makeEditor({ deletionRules: { polygon: [] } });
        expect(editor.getOptions().deletionRules).toEqual({ bbox: ['polygon', 'keypoint'], polygon: [], keypoint: [] });
    });

    it('rejects malformed deletion rules and skeletons', () => {
        const { editor, log } = makeEditor({ deletionRules: { bbox: ['group'] }, skeleton: [['a']] });
        expect(log.length).toBe(2);
        expect(editor.getOptions().deletionRules.bbox).toEqual(['polygon', 'keypoint']);
        expect(editor.getOptions().skeleton).toBe(null);
    });

    it('setOptions changes behaviour at run time and points at load() for data', () => {
        const { editor, log } = makeEditor({ annotations: [BOX] });
        editor.setOptions({ keyboardControls: false, annotations: [] });
        expect(editor.getOptions().keyboardControls).toBe(false);
        expect(editor.getAnnotations()).toEqual([BOX]);
        expect(log[0]).toMatch(/use load\(\)/);
    });
});

describe('create and destroy', () => {
    it('exposes the version from package.json', () => {
        const pkg = JSON.parse(repoFile('package.json'));
        expect(MarkinJS.version).toBe(pkg.version);
    });

    it('accepts an element, an id or a selector', () => {
        const svg = makeSvg();
        svg.id = 'canvas';
        svg.classList.add('stage');
        const byElement = track(MarkinJS.create(svg, { silent: true }));
        expect(byElement.getSVGElement()).toBe(svg);
        const byId = track(MarkinJS.create('canvas', { silent: true }));
        expect(byId.getSVGElement()).toBe(svg);
        const bySelector = track(MarkinJS.create('svg.stage', { silent: true }));
        expect(bySelector.getSVGElement()).toBe(svg);
    });

    it('throws for a target that is missing or of the wrong kind', () => {
        expect(() => MarkinJS.create('missing')).toThrow(/no <svg> or <img> found for "missing"/);
        expect(() => MarkinJS.create('::bad selector')).toThrow(TypeError);
        expect(() => MarkinJS.create(document.createElement('div'))).toThrow(/must be an <svg> or <img>/);
        expect(() => MarkinJS.create(null)).toThrow(TypeError);
    });

    it('a second create on the same element replaces the first editor', () => {
        const svg = makeSvg();
        const first = track(MarkinJS.create(svg, { silent: true, annotations: [BOX] }));
        const second = track(MarkinJS.create(svg, { silent: true }));
        expect(svg.querySelectorAll('.markin-layer').length).toBe(1);
        expect(first.getAnnotations()).toEqual([]);
        expect(first.createAnnotation(BOX)).toBe(null);
        expect(second.createAnnotation(BOX)).toBe('A');
    });

    it('cleans up after itself when construction fails', () => {
        const svg = makeSvg();
        expect(() => MarkinJS.create(svg, { strict: true, annotations: [{ bbox: 1 }] })).toThrow(TypeError);
        expect(svg.querySelector('.markin-layer')).toBe(null);
        expect(svg.style.touchAction).toBe('');
    });

    it('destroy removes what it added and turns every method into a no-op', () => {
        const svg = makeSvg();
        svg.style.touchAction = 'pan-y';
        const editor = MarkinJS.create(svg, { silent: true, annotations: [BOX] });
        expect(svg.style.touchAction).toBe('none');
        editor.destroy();
        editor.destroy();
        expect(svg.querySelector('.markin-layer')).toBe(null);
        expect(svg.style.touchAction).toBe('pan-y');
        expect(editor.getAnnotations()).toEqual([]);
        expect(editor.getAnnotation('A')).toBe(null);
        expect(editor.createAnnotation(BOX)).toBe(null);
        expect(editor.updateAnnotation('A', {})).toBe(false);
        expect(editor.load([BOX])).toBe(false);
        expect(editor.select('A')).toBe(false);
        expect(editor.undo()).toBe(false);
        expect(editor.isEnabled()).toBe(false);
        expect(typeof editor.on('change', () => {})).toBe('function');
    });

    it('only ever touches its own layer inside a host SVG', () => {
        const svg = makeSvg();
        const background = document.createElementNS(SVG_NS, 'rect');
        background.id = 'host-background';
        svg.appendChild(background);
        const { editor } = makeEditor({ annotations: [BOX] }, svg);
        const clicks = [];
        editor.on('canvasclick', (e) => clicks.push(e));

        click(background, 400, 300);
        key('Delete');
        editor.select('A');
        key('ArrowRight');

        expect(document.getElementById('host-background')).toBe(background);
        expect(background.attributes.length).toBe(1);
        expect(clicks.length).toBe(1);
        editor.destroy();
        expect(svg.children.length).toBe(1);
    });
});
