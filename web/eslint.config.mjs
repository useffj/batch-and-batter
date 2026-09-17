import { FlatCompat } from '@eslint/eslintrc';
import prettier from 'eslint-config-prettier/flat';
import { fileURLToPath } from 'node:url';

const compat = new FlatCompat({
  baseDirectory: fileURLToPath(new URL('.', import.meta.url)),
});

const eslintConfig = [
  { ignores: ['.next/**', 'out/**', 'coverage/**', 'next-env.d.ts'] },
  ...compat.extends('next/core-web-vitals', 'next/typescript'),
  prettier,
];

export default eslintConfig;
