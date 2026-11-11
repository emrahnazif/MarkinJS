import { readFileSync } from 'node:fs';
import terser from '@rollup/plugin-terser';

const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf-8'));
const banner = `/*! MarkinJS v${version} | MIT License | https://markinjs.com */`;

// markin.js stays a classic script so it can be used with a plain <script> tag and no build.
// The build turns that same file into a module by exporting its one global.
const exportGlobal = {
    name: 'export-global',
    transform(code, id) {
        if (!id.endsWith('markin.js')) return null;
        if (!code.includes(`const VERSION = '${version}'`)) {
            this.error(`VERSION in markin.js does not match package.json (${version})`);
        }
        return { code: `${code}\nexport default MarkinJS;\n`, map: null };
    }
};

const plugins = [exportGlobal];
const iife = { format: 'iife', name: 'MarkinJS', exports: 'default', banner };
const minified = { ...iife, sourcemap: true, plugins: [terser({ format: { comments: /^!/ } })] };

export default {
    input: 'markin.js',
    plugins,
    output: [
        // Browser builds: readable, minified, and minified with the version in the file name
        // (copy that one into an app so an update can never replace it silently).
        { ...iife, file: 'dist/markin.js' },
        { ...minified, file: 'dist/markin.min.js' },
        { ...minified, file: `dist/markin-${version}.min.js` },
        // .mjs so Node treats it as a module without "type": "module" in package.json.
        { format: 'es', file: 'dist/markin.esm.mjs', banner },
        { format: 'cjs', file: 'dist/markin.cjs.js', exports: 'default', banner }
    ]
};
