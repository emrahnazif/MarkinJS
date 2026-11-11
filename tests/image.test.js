import { describe, it, expect, afterEach } from 'vitest';
import { MarkinJS, track, setBox, drag, bboxEl, BOX, SVG_NS } from './setup.js';

// An <img> whose natural size can be changed, as when `src` is swapped for the next image.
function makeImage({ width = 1280, height = 853 } = {}) {
    const holder = document.createElement('div');
    holder.id = 'holder';
    const before = document.createElement('span');
    const image = document.createElement('img');
    const after = document.createElement('span');
    image.id = 'photo';
    const size = { width, height };
    Object.defineProperty(image, 'naturalWidth', { get: () => size.width });
    Object.defineProperty(image, 'naturalHeight', { get: () => size.height });
    holder.append(before, image, after);
    document.body.appendChild(holder);
    const load = (w, h) => {
        size.width = w;
        size.height = h;
        image.dispatchEvent(new Event('load'));
    };
    return { holder, image, before, after, load };
}

describe('an editor over an <img>', () => {
    it('lays an SVG over the image, in image pixels', () => {
        const { image, holder } = makeImage();
        const editor = track(MarkinJS.create(image, { silent: true }));
        const svg = editor.getSVGElement();
        const container = editor.getContainerElement();

        expect(editor.getImageElement()).toBe(image);
        // A viewport that clips, and inside it a stage that is zoomed: the image and its overlay.
        const stage = container.firstChild;
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
        expect(Array.from(editor.getContainerElement().firstChild.children)).toEqual([picture, editor.getSVGElement()]);
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

    it('notices when wrapping changed the size of the image, and repairs or reports it', () => {
        // An image with a percentage width: 600px in its parent, but only 200px inside a
        // shrink-to-fit wrapper, unless that wrapper is given the full width.
        const sized = (fixable) => {
            const { image } = makeImage();
            Object.defineProperty(image, 'offsetHeight', { get: () => 100 });
            Object.defineProperty(image, 'offsetWidth', {
                get() {
                    const wrap = image.closest('.markin-container');
                    return !wrap || (fixable && wrap.style.width === '100%') ? 600 : 200;
                }
            });
            const log = [];
            const editor = track(MarkinJS.create(image, { logger: (level, message) => log.push(message) }));
            return { width: editor.getContainerElement().style.width, log };
        };
        expect(sized(true)).toEqual({ width: '100%', log: [] });
        const broken = sized(false);
        expect(broken.width).toBe('');
        expect(broken.log.length).toBe(1);
        expect(broken.log[0]).toMatch(/wrapping the image changed its size/);
    });

    describe('placing the overlay where the image is actually drawn', () => {
        // jsdom has no layout, so the image's box and computed style are supplied by the test:
        // a 200 x 100 image whose content box is 400 x 300, at 10, 20 inside its wrapper.
        const realComputedStyle = window.getComputedStyle;
        afterEach(() => {
            window.getComputedStyle = realComputedStyle;
        });

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
            window.getComputedStyle = (el) => (el === image ? computed : realComputedStyle(el));
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
    const collect = () => {
        const log = [];
        return { log, logger: (level, message) => log.push(`${level}: ${message}`) };
    };

    it('wraps the <svg> in a viewport and a stage, and destroy puts the page back', () => {
        const { holder, svg, html } = page('<b></b><svg viewBox="0 0 800 600"></svg><i></i>');
        const { log, logger } = collect();
        const editor = MarkinJS.create(svg, { logger, annotations: [BOX] });
        const viewport = editor.getContainerElement();

        expect(viewport.className).toBe('markin-container');
        expect(viewport.parentNode).toBe(holder);
        expect(viewport.previousSibling.localName).toBe('b');
        expect(viewport.firstChild.className).toBe('markin-stage');
        expect(Array.from(viewport.firstChild.children)).toEqual([svg]);
        // An <svg> is inline unless the page says otherwise, and so is what stands in for it.
        expect(viewport.style.display).toBe('inline-block');
        expect(log).toEqual([]);

        editor.destroy();
        expect(holder.innerHTML).toBe(html);
    });

    it('wraps a block-level <svg> in a block', () => {
        const { svg } = page('<svg viewBox="0 0 800 600" style="display: block"></svg>');
        const editor = track(MarkinJS.create(svg, { silent: true }));
        expect(editor.getContainerElement().style.display).toBe('block');
    });

    it('uses the stage the page marked, and leaves the markup alone', () => {
        const { holder, svg, html } = page(
            '<section><div data-markin-stage style="position: relative;"><img alt=""><svg viewBox="0 0 800 600"></svg></div></section>'
        );
        const { log, logger } = collect();
        const editor = MarkinJS.create(svg, { logger });
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
        const real = window.getComputedStyle;
        try {
            const { holder, svg } = page('<img alt=""><svg viewBox="0 0 800 600"></svg>');
            window.getComputedStyle = (el) => (el === svg ? { position: 'absolute', display: 'block' } : real(el));
            const { log, logger } = collect();
            const editor = track(MarkinJS.create(svg, { logger, annotations: [BOX] }));
            expect(svg.parentNode).toBe(holder);
            expect(holder.querySelector('.markin-container')).toBe(null);
            expect(editor.getContainerElement()).toBe(null);
            expect(log.length).toBe(1);
            expect(log[0]).toMatch(/^warn: zoom and pan are off: .*data-markin-stage/);
            // It still edits, as it did before there was zoom.
            expect(editor.getAnnotations()).toEqual([BOX]);
        } finally {
            window.getComputedStyle = real;
        }
    });

    it('undoes the wrapping when it would resize the <svg>', () => {
        // An <svg> sized by its parent: 600px wide there, 150px inside a wrapper, whatever the
        // wrapper is given.
        const { holder, svg } = page('<svg viewBox="0 0 800 600"></svg>');
        svg.getBoundingClientRect = () => {
            const width = svg.parentNode === holder ? 600 : 150;
            return { left: 0, top: 0, width, height: 450 };
        };
        const { log, logger } = collect();
        const editor = track(MarkinJS.create(svg, { logger }));
        expect(svg.parentNode).toBe(holder);
        expect(holder.querySelector('.markin-container')).toBe(null);
        expect(editor.getContainerElement()).toBe(null);
        expect(log.length).toBe(1);
        expect(log[0]).toMatch(/^warn: zoom and pan are off/);
    });

    it('gives the wrapper the full size when that is what keeps a percentage-sized <svg> as it was', () => {
        const { holder, svg } = page('<svg viewBox="0 0 800 600"></svg>');
        svg.getBoundingClientRect = () => {
            const viewport = svg.closest('.markin-container');
            const fits = !viewport || (viewport.style.width === '100%' && viewport.style.height === '100%');
            return { left: 0, top: 0, width: fits ? 600 : 150, height: fits ? 450 : 150 };
        };
        const { log, logger } = collect();
        const editor = track(MarkinJS.create(svg, { logger }));
        const viewport = editor.getContainerElement();
        expect(viewport.parentNode).toBe(holder);
        expect([viewport.style.width, viewport.style.height, viewport.firstChild.style.height]).toEqual([
            '100%',
            '100%',
            '100%'
        ]);
        expect(log).toEqual([]);
    });

    it('a second create on the same <svg> wraps it once', () => {
        const { holder, svg } = page('<svg viewBox="0 0 800 600"></svg>');
        track(MarkinJS.create(svg, { silent: true }));
        const second = track(MarkinJS.create(svg, { silent: true }));
        expect(holder.querySelectorAll('.markin-container').length).toBe(1);
        expect(second.getContainerElement().parentNode).toBe(holder);
    });
});
