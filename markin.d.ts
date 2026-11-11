// Type definitions for MarkinJS 0.2

declare namespace MarkinJS {
    // ---------------------------------------------------------------- data

    /** A keypoint. Fields MarkinJS does not know are kept as they are. */
    interface Keypoint {
        /** Position in image pixels. */
        point: [number, number];
        name?: string | null;
        /** COCO visibility: 0 = not labelled (not drawn), 1 = occluded (drawn dashed), 2 = visible. */
        v?: 0 | 1 | 2 | null;
        [extra: string]: unknown;
    }

    /**
     * One object in the image, in image pixels. `bbox`, `segments` and `keypoints` are optional but at
     * least one is needed. This is the shape MarkinJS accepts and the shape it returns; fields it does
     * not know are carried through untouched.
     */
    interface Annotation {
        /** Stable identifier. Generated when missing. */
        id?: string | number;
        /** Identifier of the class. Used to pick a colour from `options.colors`. */
        class_id?: string | number | null;
        /** `[x, y, width, height]`. */
        bbox?: [number, number, number, number] | null;
        /** One polygon as `[x, y]` points, at least three. */
        segments?: [number, number][] | null;
        keypoints?: Keypoint[] | null;
        [extra: string]: unknown;
    }

    /** An annotation as returned by the editor: it always has an id. */
    type StoredAnnotation = Annotation & { id: string | number };

    type Part = 'bbox' | 'polygon' | 'keypoint';
    type Handle = 'nw' | 'ne' | 'sw' | 'se' | 'vertex';

    interface Point {
        x: number;
        y: number;
    }

    /** A rectangle in image pixels. */
    interface Rect {
        x: number;
        y: number;
        width: number;
        height: number;
    }

    /**
     * The part of the image that is visible, in whole image pixels: rounded outward and kept inside
     * the image, so it can be used as a crop.
     */
    interface View extends Rect {
        /** Screen pixels per image pixel. */
        scale: number;
    }

    // ---------------------------------------------------------------- options

    /** What else is deleted when a part is deleted with Delete or `deleteSelected()`. */
    interface DeletionRules {
        bbox?: (Part | 'annotation')[];
        polygon?: (Part | 'annotation')[];
        keypoint?: (Part | 'annotation')[];
    }

    interface SkeletonStyle {
        stroke?: string;
        /** Screen pixels. */
        strokeWidth?: number;
        strokeOpacity?: number;
        /** Dash pattern in screen pixels, e.g. `'4 2'`. */
        strokeDasharray?: string;
    }

    interface Options {
        /** Initial annotations. Same as calling `load()` right after `create()`. */
        annotations?: Annotation[] | null;
        /** Colour per `class_id`. */
        colors?: Record<string | number, string> | null;
        /** Colour for annotations whose class has none. Default `'#0000FF'`. */
        color?: string;
        /** Lines drawn between keypoints, as `[from, to]` pairs of keypoint names or indices. Display only. */
        skeleton?: [string | number, string | number][] | null;
        skeletonStyle?: SkeletonStyle | null;
        /** The polygon and keypoints follow their bbox when it moves and scale with it when it is resized. Default `true`. */
        bindElements?: boolean;
        /** Keep the polygon inside its bbox (needs `bindElements`). Default `true`. */
        bboxContainPolygon?: boolean;
        /** Keep keypoints inside their bbox (needs `bindElements`). Default `true`. */
        bboxContainKeypoints?: boolean;
        /** Keep everything inside the image (the SVG viewBox). Default `true`. */
        constrainToImage?: boolean;
        /** Give an annotation without a bbox one that encloses its other geometry. Default `false`. */
        requireBbox?: boolean;
        /** The first press selects, the next one drags. Default `true`. */
        requireSelectionToDrag?: boolean;
        /** Arrow keys, Delete, undo / redo and Escape. Default `true`. */
        keyboardControls?: boolean;
        /** Default `{ bbox: ['polygon', 'keypoint'], polygon: ['bbox'], keypoint: [] }`. Merged over the defaults. */
        deletionRules?: DeletionRules;
        /** Default `true`. */
        historyEnabled?: boolean;
        /** Number of states kept, including the current one. Default `50`. */
        historyMaxStates?: number;
        /** Outline width in screen pixels. Default `2`. */
        strokeWidth?: number;
        /** Keypoint radius in screen pixels. Default `5`. */
        keypointRadius?: number;
        /** Handle radius in screen pixels. Default `5`. */
        handleRadius?: number;
        /**
         * How far the view zooms in, in screen pixels per image pixel. Default `32`. Zoomed out, the view
         * stops at the image as the page lays it out.
         */
        maxScale?: number;
        /** Throw a `TypeError` on invalid input instead of logging it. Default `false`. */
        strict?: boolean;
        /** Log nothing. Default `false`. */
        silent?: boolean;
        /** Receives what would otherwise go to the console. */
        logger?: ((level: 'error' | 'warn', message: string) => void) | null;
    }

    // ---------------------------------------------------------------- events

    interface ChangeInfo {
        reason: 'create' | 'update' | 'delete' | 'clear' | 'undo' | 'redo';
        /** Ids of the annotations that changed. */
        ids: (string | number)[];
    }

    interface Selection {
        id: string | number;
        /** `null` when the annotation as a whole is selected. */
        part: Part | null;
        /** Index of the keypoint, otherwise `null`. */
        index: number | null;
        annotation: StoredAnnotation;
    }

    interface DeselectEvent {
        id: string | number;
        part: Part | null;
        index: number | null;
    }

    interface DragEvent {
        id: string | number;
        part: Part | null;
        index: number | null;
        /** The handle being dragged, or `null` when the part itself is moved. */
        handle: Handle | null;
        /** Pointer position in image pixels. */
        position: Point;
        /** The annotation as it is right now. */
        annotation: StoredAnnotation;
    }

    interface DragEndEvent extends DragEvent {
        changed: boolean;
        cancelled: boolean;
    }

    interface HoverEvent {
        position: Point;
        id: string | number | null;
        part: Part | null;
        index: number | null;
    }

    interface CanvasClickEvent {
        position: Point;
    }

    interface EventMap {
        /** After every completed edit, including undo and redo. Not after `load()`. */
        change: (annotations: StoredAnnotation[], info: ChangeInfo) => void;
        select: (event: Selection) => void;
        deselect: (event: DeselectEvent) => void;
        dragstart: (event: DragEvent) => void;
        drag: (event: DragEvent) => void;
        dragend: (event: DragEndEvent) => void;
        /** At most once per frame while the pointer moves over the canvas. */
        hover: (event: HoverEvent) => void;
        /** A click on the canvas that hit no annotation. */
        canvasclick: (event: CanvasClickEvent) => void;
    }

    // ---------------------------------------------------------------- editor

    interface Editor {
        /** Listen for an event. Returns a function that removes the listener. */
        on<K extends keyof EventMap>(type: K, listener: EventMap[K]): () => void;
        /** Remove one listener, or every listener of that event when `listener` is omitted. */
        off<K extends keyof EventMap>(type: K, listener?: EventMap[K]): void;

        /** Add an annotation and select it. Returns its id, or `null` when the data is invalid. */
        createAnnotation(annotation: Annotation, settings?: { select?: boolean }): string | number | null;
        /** Merge `patch` into an annotation. A field set to `null` is removed. */
        updateAnnotation(id: string | number, patch: Partial<Annotation>): boolean;
        deleteAnnotation(id: string | number): boolean;
        addKeypoint(id: string | number, keypoint: Keypoint): boolean;
        getAnnotation(id: string | number): StoredAnnotation | null;
        /** Copies of every annotation. With `normalize`, coordinates are fractions of the image size; `null` if that size is unknown. */
        getAnnotations(): StoredAnnotation[];
        getAnnotations(settings: { normalize?: boolean }): StoredAnnotation[] | null;
        /** Replace everything. Starts a fresh undo history and does not emit `change`. */
        load(annotations: Annotation[]): boolean;
        /** Remove everything, as one undoable step. */
        clear(): void;

        /** Select an annotation, or one part of it. `index` is the keypoint index. */
        select(id: string | number, part?: Part | null, index?: number): boolean;
        deselect(): boolean;
        getSelection(): Selection | null;
        /** Delete the selected part, following `deletionRules`. */
        deleteSelected(): boolean;

        undo(): boolean;
        redo(): boolean;
        canUndo(): boolean;
        canRedo(): boolean;
        clearHistory(): void;

        enable(): void;
        /** Stop reacting to pointer and keyboard; pointer events pass through to what is underneath. */
        disable(): void;
        isEnabled(): boolean;
        setOptions(options: Omit<Options, 'annotations'>): void;
        getOptions(): Required<Omit<Options, 'annotations'>>;
        /** Re-measure the canvas. Only needed after the page scaled or moved it in a way the editor cannot see. */
        refresh(): void;

        /** What is visible now, or `null` while the page is not laid out or the editor has no viewport. */
        getView(): View | null;
        /** Show at least this part of the image, as large as it fits, centred. `false` if it could not. */
        setView(rect: Rect): boolean;
        /** Zoom in (`factor` above 1) or out, around a point of the image or else the middle of the view. */
        zoomBy(factor: number, at?: Point | null): boolean;
        /** Show the whole image. */
        fit(): boolean;
        /** A point on screen (`clientX`, `clientY` of an event) as a point of the image. */
        toImage(clientX: number, clientY: number): Point | null;
        /** A point of the image as a point on screen, in the coordinates of `clientX` and `clientY`. */
        toClient(x: number, y: number): Point | null;

        getSVGElement(): SVGSVGElement;
        /** The image under the overlay, or `null` when the editor was created on an SVG. */
        getImageElement(): HTMLImageElement | null;
        /** The viewport: the element that clips the zoomed picture. `null` when the editor has none. */
        getContainerElement(): HTMLElement | null;
        /** Remove everything the editor added to the page. Every method is a no-op afterwards. */
        destroy(): void;
    }

    // ---------------------------------------------------------------- entry points

    const version: string;

    /**
     * Create an editor on an `<svg>`, or over an `<img>`.
     * @param target The element, its id, or a CSS selector for it.
     * @throws TypeError if the target is missing or is neither an `<svg>` nor an `<img>`.
     */
    function create(target: SVGSVGElement | HTMLImageElement | string, options?: Options): Editor;

    /** Pixel coordinates to fractions of the image size. Returns copies. */
    function normalize<T extends Annotation>(annotations: T[], width: number, height: number): T[];
    /** Fractions of the image size to pixel coordinates. Returns copies. */
    function denormalize<T extends Annotation>(annotations: T[], width: number, height: number): T[];
}

export = MarkinJS;
export as namespace MarkinJS;
