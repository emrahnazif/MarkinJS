import globals from 'globals';
import eslintPluginPrettier from 'eslint-plugin-prettier';
import eslintConfigPrettier from 'eslint-config-prettier';

export default [
    {
        files: ['**/*.js'],
        languageOptions: {
            ecmaVersion: 'latest',
            sourceType: 'module',
            globals: {
                ...globals.browser
            }
        },
        plugins: {
            prettier: eslintPluginPrettier
        },
        rules: {
            ...eslintConfigPrettier.rules,
            'prettier/prettier': 'error',
            // markin.js is a classic script: `MarkinJS` is its global, and the build adds the export.
            'no-unused-vars': ['warn', { varsIgnorePattern: '^MarkinJS$' }],
            'no-console': 'warn'
        }
    }
];
