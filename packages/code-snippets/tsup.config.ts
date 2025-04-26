import { defineConfig } from 'tsup';

export default defineConfig([
    {
        entry: ['src/index.ts'],
        format: 'esm',
        outExtension: () => ({ js: '.mjs' }),
        dts: {
            entry: 'src/index.ts',
        },
        clean: true,
    },
    {
        entry: ['src/index.ts'],
        format: 'cjs',
        outExtension: () => ({ js: '.cjs' }),
        clean: false, // 不清除，避免把前面的删掉
    }
]);
