import { describe, it, expect } from 'vitest';
import {
    MarkinJS,
    makeEditor,
    makeImage,
    track,
    setBox,
    setStyle,
    stageOf,
    drag,
    bboxEl,
    BOX,
    SVG_NS
} from './setup.js';

describe('an editor over an <img>', () => {
    it('lays an SVG over the image, in image pixels', () => {
        const { image, holder } = makeImage();
        const editor = track(MarkinJS.create(image, { silent: true }));
        const svg = editor.getSVGElement();
        const container = editor.getContainerElement();

        expect(editor.getImageElement()).toBe(image);
        // A viewport that clips, and inside it a stage that is zoomed: the image and its overlay.
        const stage = stageOf(editor);
        expect(container.parentNode).toBe(holder);
        expect(Array.from(container.children)).toEqual([stage]);
        expect(stage.className).toBe('markin-stage');
        expect(Array.from(stage.children)).toEqual([image, svg]);
        expect(container.style.position).toBe('relative');
        expect(stage.style.position).toBe('relative');
        expect(svg.style.position).toBe('absolute');
        expect(svg.getAttribute('viewBox')).toBe('0 0 1280 853');
        expect(svg.style.visibility).toBe('');
    });

    it('accepts the id of the image', () => {
        const { image } = makeImage();
        const editor = track(MarkinJS.create('photo', { silent: true }));
        expect(editor.getImageElement()).toBe(image);
    });

    it('waits for an image that has not loaded yet', () => {
        const { image, load } = makeImage({ width: 0, height: 0 });
        const editor = track(MarkinJS.create(image, { silent: true, annotations: [BOX] }));
        const svg = editor.getSVGElement();
        expect(svg.hasAttribute('viewBox')).toBe(false);
        expect(svg.style.visibility).toBe('hidden');
        expect(editor.getAnnotations()).toEqual([BOX]);

        load(640, 480);
        expect(svg.getAttribute('viewBox')).toBe('0 0 640 480');
        expect(svg.style.visibility).toBe('');
    });

    it('follows the image when its source is swapped for one of another size', () => {
        const { image, load } = makeImage({ width: 800, height: 600 });
        const editor = track(MarkinJS.create(image, { silent: true }));
        load(4000, 3000);
        expect(editor.getSVGElement().getAttribute('viewBox')).toBe('0 0 4000 3000');
    });

    it('keeps annotations inside the image and normalises by its size', () => {
        const { image } = makeImage({ width: 800, height: 600 });
        const editor = track(MarkinJS.create(image, { silent: true, annotations: [BOX] }));
        const svg = editor.getSVGElement();
        setBox(svg, { left: 0, top: 0, width: 800, height: 600 });
        editor.select('A');
        drag(bboxEl(svg, 'A'), [150, 150], [5000, 5000]);
        expect(editor.getAnnotation('A').bbox).toEqual([600, 500, 200, 100]);
        expect(editor.getAnnotations({ normalize: true })[0].bbox).toEqual([0.75, 500 / 600, 0.25, 100 / 600]);
    });

    it('a second create on the same image replaces the first overlay', () => {
        const { image, holder } = makeImage();
        const first = track(MarkinJS.create(image, { silent: true, annotations: [BOX] }));
        const second = track(MarkinJS.create(image, { silent: true }));

        expect(document.querySelectorAll('svg').length).toBe(1);
        expect(document.querySelectorAll('.markin-container').length).toBe(1);
        expect(second.getContainerElement().parentNode).toBe(holder);
        expect(first.getAnnotations()).toEqual([]);
        expect(second.createAnnotation(BOX)).toBe('A');
    });

    it('destroy puts the page back exactly as it was', () => {
        const { image, holder, before, after } = makeImage();
        const html = holder.innerHTML;
        const editor = MarkinJS.create(image, { silent: true, annotations: [BOX] });
        editor.destroy();
        editor.destroy();
        expect(holder.innerHTML).toBe(html);
        expect(Array.from(holder.children)).toEqual([before, image, after]);
        expect(document.querySelector('svg')).toBe(null);
        // No listener is left behind on the image.
        expect(() => image.dispatchEvent(new Event('load'))).not.toThrow();
        expect(document.querySelector('svg')).toBe(null);
    });

    it('puts the page back when construction fails', () => {
        const { image, holder } = makeImage();
        const html = holder.innerHTML;
        expect(() => MarkinJS.create(image, { strict: true, colour: 'red' })).toThrow(/unknown option "colour"/);
        expect(() => MarkinJS.create(image, { strict: true, annotations: [{}] })).toThrow(TypeError);
        expect(holder.innerHTML).toBe(html);
    });

    it('does not touch the page at all when the options are rejected', () => {
        const { image, holder } = makeImage();
        const observer = new MutationObserver(() => {});
        observer.observe(holder, { childList: true, subtree: true, attributes: true });
        expect(() => MarkinJS.create(image, { strict: true, colour: 'red' })).toThrow(/unknown option "colour"/);
        expect(observer.takeRecords()).toEqual([]);
        observer.disconnect();
    });

    it('needs the image to be in the page', () => {
        const loose = document.createElement('img');
        expect(() => MarkinJS.create(loose)).toThrow(/must be in the document/);
    });

    it('disable() gets the overlay itself out of the way of the image', () => {
        const { image } = makeImage();
        const editor = track(MarkinJS.create(image, { silent: true, annotations: [BOX] }));
        const svg = editor.getSVGElement();
        editor.disable();
        expect(svg.style.pointerEvents).toBe('none');
        editor.enable();
        expect(svg.style.pointerEvents).toBe('');
    });

    it('leaves an <img> inside its <picture>, so the browser keeps choosing among the sources', () => {
        const holder = document.createElement('div');
        holder.innerHTML =
            '<picture><source srcset="wide.jpg" media="(min-width: 800px)"><img id="pic" src="narrow.jpg"></picture>';
        document.body.appendChild(holder);
        const html = holder.innerHTML;
        const image = holder.querySelector('img');
        const log = [];
        const editor = MarkinJS.create(image, { logger: (level, message) => log.push(`${level}: ${message}`) });

        const picture = holder.querySelector('picture');
        expect(image.parentNode).toBe(picture);
        expect(Array.from(stageOf(editor).children)).toEqual([picture, editor.getSVGElement()]);
        expect(log.length).toBe(1);
        expect(log[0]).toMatch(/^warn: the image uses srcset or <picture>/);
        editor.destroy();
        expect(holder.innerHTML).toBe(html);
    });

    it('says so when the image uses srcset, because its natural size then depends on the screen', () => {
        const { image } = makeImage();
        image.setAttribute('srcset', 'photo@2x.jpg 2x');
        const log = [];
        track(MarkinJS.create(image, { logger: (level, message) => log.push(message) }));
        expect(log).toEqual([
            'the image uses srcset or <picture>: coordinates follow the size the browser reports for the chosen source.'
        ]);
    });

    it('wraps a block-level image in a block, so its own width and centring keep working', () => {
        const { image } = makeImage();
        image.style.display = 'block';
        const block = track(MarkinJS.create(image, { silent: true }));
        expect(block.getContainerElement().style.display).toBe('block');
        block.destroy();
        image.style.display = '';
        const inline = track(MarkinJS.create(image, { silent: true }));
        expect(inline.getContainerElement().style.display).toBe('inline-block');
    });

    describe('an image sized in percentages of the box around it', () => {
        // jsdom lays nothing out, so each test says how big the image comes out: at its size on the
        // page while it is not wrapped, and as `wrapped(viewport, stage)` says once it is.
        function sized(page, wrapped) {
            const { image } = makeImage();
            const size = () => {
                const viewport = image.closest('.markin-container');
                return viewport ? wrapped(viewport.style, viewport.firstChild.style) : page;
            };
            Object.defineProperty(image, 'offsetWidth', { get: () => size()[0] });
            Object.defineProperty(image, 'offsetHeight', { get: () => size()[1] });
            const log = [];
            const editor = track(MarkinJS.create(image, { logger: (level, message) => log.push(message) }));
            const viewport = editor.getContainerElement().style;
            return { given: [viewport.width, viewport.height, stageOf(editor).style.height], log };
        }

        it('keeps a percentage width by giving the viewport the full width', () => {
            // 600px wide in its parent, but only 200px inside a shrink-to-fit wrapper.
            const kept = sized([600, 100], (viewport) => [viewport.width === '100%' ? 600 : 200, 100]);
            expect(kept).toEqual({ given: ['100%', '', ''], log: [] });
        });

        it('keeps a percentage height by passing it on through the viewport and the stage', () => {
            // width: 100%; height: 100%; object-fit: contain, in a 600 x 300 box. Wrapped, the
            // height has nothing to be a percentage of, and the image takes its own shape: 600 x 400.
            const kept = sized([600, 300], (viewport, stage) => [
                600,
                viewport.height === '100%' && stage.height === '100%' ? 300 : 400
            ]);
            expect(kept).toEqual({ given: ['100%', '100%', '100%'], log: [] });
        });

        it('keeps both at once', () => {
            const kept = sized([600, 300], (viewport, stage) => [
                viewport.width === '100%' ? 600 : 200,
                viewport.height === '100%' && stage.height === '100%' ? 300 : 133
            ]);
            expect(kept).toEqual({ given: ['100%', '100%', '100%'], log: [] });
        });

        it('leaves no trace of the attempt, and says so, when nothing keeps the size', () => {
            const broken = sized([600, 300], () => [200, 133]);
            expect(broken.given).toEqual(['', '', '']);
            expect(broken.log.length).toBe(1);
            expect(broken.log[0]).toMatch(/wrapping the image changed its size/);
        });
    });

    describe('placing the overlay where the image is actually drawn', () => {
        // jsdom has no layout, so the image's box and computed style are supplied by the test:
        // a 200 x 100 image whose content box is 400 x 300, at 10, 20 inside its wrapper.
        function place(style, box = {}) {
            const { image } = makeImage({ width: 200, height: 100 });
            const layout = { clientWidth: 400, clientHeight: 300, offsetLeft: 10, offsetTop: 20, ...box };
            for (const [name, value] of Object.entries(layout))
                Object.defineProperty(image, name, { get: () => value });
            const computed = {
                display: 'inline',
                boxSizing: 'content-box',
                width: '400px',
                height: '300px',
                borderLeftWidth: '0px',
                borderRightWidth: '0px',
                borderTopWidth: '0px',
                borderBottomWidth: '0px',
                paddingLeft: '0px',
                paddingRight: '0px',
                paddingTop: '0px',
                paddingBottom: '0px',
                objectFit: 'fill',
                objectPosition: '50% 50%',
                ...style
            };
            setStyle(image, computed);
            const svg = track(MarkinJS.create(image, { silent: true })).getSVGElement();
            const n = (value) => parseFloat(value);
            return {
                rect: [n(svg.style.left), n(svg.style.top), n(svg.style.width), n(svg.style.height)],
                clip: svg.style.clipPath,
                ratio: svg.getAttribute('preserveAspectRatio')
            };
        }

        it('object-fit: fill stretches over the whole box', () => {
            expect(place({})).toEqual({ rect: [10, 20, 400, 300], clip: '', ratio: 'none' });
        });

        it('object-fit: contain is centred with its own proportions', () => {
            expect(place({ objectFit: 'contain' }).rect).toEqual([10, 70, 400, 200]);
        });

        it('object-fit: none and scale-down keep a small image at its natural size', () => {
            expect(place({ objectFit: 'none' }).rect).toEqual([110, 120, 200, 100]);
            expect(place({ objectFit: 'scale-down' }).rect).toEqual([110, 120, 200, 100]);
        });

        it('object-position moves the image inside its box', () => {
            expect(place({ objectFit: 'contain', objectPosition: '0% 0%' }).rect).toEqual([10, 20, 400, 200]);
            expect(place({ objectFit: 'contain', objectPosition: '100% 100%' }).rect).toEqual([10, 120, 400, 200]);
            expect(place({ objectFit: 'none', objectPosition: '15px 25px' }).rect).toEqual([25, 45, 200, 100]);
        });

        it('object-fit: cover is cropped by the box, and so is the overlay', () => {
            const cover = place({ objectFit: 'cover' });
            expect(cover.rect).toEqual([-90, 20, 600, 300]);
            expect(cover.clip).toBe('inset(0px 100px 0px 100px)');
        });

        it('borders and padding are not part of the picture', () => {
            const frame = { borderLeftWidth: '2px', borderTopWidth: '2px', paddingLeft: '8px', paddingTop: '4px' };
            expect(place(frame).rect).toEqual([20, 26, 400, 300]);
            const borderBox = {
                boxSizing: 'border-box',
                width: '420px',
                height: '312px',
                borderLeftWidth: '2px',
                borderRightWidth: '2px',
                paddingLeft: '8px',
                paddingRight: '8px',
                borderTopWidth: '2px',
                borderBottomWidth: '2px',
                paddingTop: '4px',
                paddingBottom: '4px'
            };
            expect(place(borderBox).rect).toEqual([20, 26, 400, 300]);
        });

        it('keeps sub-pixel sizes instead of rounding them', () => {
            expect(place({ width: '333.5px', height: '250.125px' }).rect).toEqual([10, 20, 333.5, 250.125]);
        });
    });

    it('an SVG target has no image', () => {
        const svg = document.createElementNS(SVG_NS, 'svg');
        document.body.appendChild(svg);
        const editor = track(MarkinJS.create(svg, { silent: true }));
        expect(editor.getImageElement()).toBe(null);
        expect(editor.getSVGElement()).toBe(svg);
    });
});

describe('an editor on an <svg>', () => {
    // A page with something before and after the canvas, to see that it is put back in place.
    function page(markup) {
        const holder = document.createElement('div');
        holder.innerHTML = markup;
        document.body.appendChild(holder);
        return { holder, svg: holder.querySelector('svg'), html: holder.innerHTML };
    }
    it('leaves the <svg> where it is: it is its own viewport, and only its viewBox changes', () => {
        const { holder, svg, html } = page(
            '<b></b><svg viewBox="0 0 800 600" preserveAspectRatio="xMinYMin"></svg><i></i>'
        );
        setBox(svg, { left: 0, top: 0, width: 800, height: 600 });
        const { editor, log } = makeEditor({ annotations: [BOX] }, svg);
        expect(svg.parentNode).toBe(holder);
        expect(holder.querySelector('.markin-container')).toBe(null);
        expect(editor.getContainerElement()).toBe(null);
        expect(log).toEqual([]);

        editor.zoomBy(2);
        expect(editor.getView()).toEqual({ x: 200, y: 150, width: 400, height: 300, scale: 2 });
        expect([svg.getAttribute('viewBox'), svg.getAttribute('preserveAspectRatio')]).toEqual([
            '200 150 400 300',
            'none'
        ]);
        expect(svg.style.overflow).toBe('hidden');
        expect(svg.style.transform).toBe('');
        // The image is still the whole of it: that is what annotations stay inside and are counted in.
        expect(editor.getAnnotations({ normalize: true })[0].bbox).toEqual([0.125, 100 / 600, 0.25, 100 / 600]);

        editor.destroy();
        expect(holder.innerHTML).toBe(html);
    });

    it('uses the stage the page marked, and leaves the markup alone', () => {
        const { holder, svg, html } = page(
            '<section><div data-markin-stage style="position: relative;"><img alt=""><svg viewBox="0 0 800 600"></svg></div></section>'
        );
        const { editor, log } = makeEditor({}, svg);
        const stage = holder.querySelector('[data-markin-stage]');
        expect(editor.getContainerElement()).toBe(holder.querySelector('section'));
        expect(svg.parentNode).toBe(stage);
        expect(stage.parentNode.localName).toBe('section');
        expect(holder.querySelector('.markin-container')).toBe(null);
        expect(log).toEqual([]);
        editor.destroy();
        expect(holder.innerHTML).toBe(html);
    });

    it('does not wrap an <svg> that is positioned over something else, and says how to get zoom', () => {
        const { holder, svg } = page('<img alt=""><svg viewBox="0 0 800 600"></svg>');
        setStyle(svg, { position: 'absolute', display: 'block' });
        const { editor, log } = makeEditor({ annotations: [BOX] }, svg);
        expect(svg.parentNode).toBe(holder);
        expect(holder.querySelector('.markin-container')).toBe(null);
        expect(editor.getContainerElement()).toBe(null);
        expect(log.length).toBe(1);
        expect(log[0]).toMatch(/^warn: zoom and pan are off: .*data-markin-stage/);
        // It still edits, as it did before there was zoom.
        expect(editor.getAnnotations()).toEqual([BOX]);
    });

    it('a second create on the same <svg> starts from the viewBox the page gave it', () => {
        const { editor: first, svg } = makeEditor();
        first.zoomBy(4);
        expect(svg.getAttribute('viewBox')).toBe('300 225 200 150');
        const second = makeEditor({}, svg).editor;
        expect(svg.getAttribute('viewBox')).toBe('0 0 800 600');
        expect(second.getView()).toEqual({ x: 0, y: 0, width: 800, height: 600, scale: 1 });
        expect(first.getView()).toBe(null);
    });

    it('takes another viewBox that the page puts on a zoomed <svg> as another picture', () => {
        const { svg } = page('<svg viewBox="0 0 800 600" preserveAspectRatio="xMaxYMax"></svg>');
        setBox(svg, { left: 0, top: 0, width: 800, height: 600 });
        const { editor } = makeEditor({ annotations: [BOX] }, svg);
        editor.zoomBy(4);
        // The page shows its next image, as it did before there was zoom.
        svg.setAttribute('viewBox', '0 0 1600 1200');
        expect(editor.getView()).toEqual({ x: 0, y: 0, width: 1600, height: 1200, scale: 0.5 });
        expect([svg.getAttribute('viewBox'), svg.getAttribute('preserveAspectRatio')]).toEqual([
            '0 0 1600 1200',
            'xMaxYMax'
        ]);
        expect(svg.style.overflow).toBe('');
        editor.zoomBy(2);
        expect(editor.getView()).toEqual({ x: 400, y: 300, width: 800, height: 600, scale: 1 });
    });
});
