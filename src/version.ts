/**
 * 版本号常量。
 *
 * 为什么不直接 `import pkg from '../package.json'`？
 * 在 ESM（NodeNext）下导入 JSON 需要 `with { type: 'json' }` 导入属性，
 * tsx / vitest / tsc 产物三边兼容性更麻烦；一个常量文件最简单直接。
 * 发版时记得与 package.json 的 version 保持同步。
 */
export const VERSION = '0.1.0';
