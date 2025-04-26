import { visit } from 'unist-util-visit';
import { parse as acornParse } from 'acorn';
import * as acornWalk from 'acorn-walk';
import fs from 'fs';
import path from 'path';
import prettier from 'prettier';
import type { Root } from 'mdast';
import type { VFile } from 'vfile';

interface RemarkCodeSnippetsOptions {
    aliases?: Record<string, string>;
    extensions?: string[];
    prettierOptions?: prettier.Options;
}

const defaultOptions: RemarkCodeSnippetsOptions = {
    aliases: {
        '@code': path.resolve(process.cwd(), 'src/code-snippets')
    },
    extensions: ['.ts', '.tsx', '.js', '.jsx', '/index.ts', '/index.tsx', '/index.js', '/index.jsx'],
    prettierOptions: {
        printWidth: 80,
        tabWidth: 2,
        useTabs: false,
        semi: true,
        singleQuote: true,
        trailingComma: 'es5',
        bracketSpacing: true,
        arrowParens: 'avoid',
    }
};

export default function remarkCodeSnippets(options: RemarkCodeSnippetsOptions = {}) {
    const mergedOptions: RemarkCodeSnippetsOptions = {
        aliases: { ...defaultOptions.aliases, ...(options.aliases || {}) },
        extensions: [...(defaultOptions.extensions as []), ...(options.extensions || [])],
        prettierOptions: { ...defaultOptions.prettierOptions, ...(options.prettierOptions || {}) }
    };

    return async function transformer(tree: Root, file: VFile) {
        const importMap: Record<string, string> = {};

        visit(tree, 'mdxjsEsm', (node: any) => {
            const ast = acornParse(node.value, {
                sourceType: 'module',
                ecmaVersion: 'latest',
            });

            acornWalk.simple(ast, {
                ImportDeclaration(decl: any) {
                    for (const specifier of decl.specifiers) {
                        if (specifier.type === 'ImportSpecifier') {
                            importMap[specifier.local.name] = decl.source.value;
                        }
                    }
                },
            });
        });

        const promises: Promise<void>[] = [];

        visit(tree, 'code', (node: any) => {
            if (!node.meta || !node.meta.includes('code={')) return;

            const match = node.meta.match(/code=\{([a-zA-Z0-9_]+)\}/);
            if (!match) return;

            const varName = match[1];
            const importPath = importMap[varName];

            if (!importPath) {
                throw new Error(
                    `❌ 未找到变量 "${varName}" 的 import 路径。\n` +
                    `请确认你在 .mdx 文件中正确引入了该变量，例如：\n\n` +
                    `import {${varName}} from 'codeSnippetsPath'\n\n` +
                    `如果你使用 export default 导出，请修改为 export。`
                );
            }

            const resolveModulePath = (sourcePath: string): string => {
                // 处理别名路径
                let basePath = sourcePath;
                const aliases = mergedOptions.aliases || {};

                for (const [alias, aliasPath] of Object.entries(aliases)) {
                    if (sourcePath.startsWith(`${alias}/`)) {
                        basePath = path.resolve(aliasPath, sourcePath.replace(`${alias}/`, ''));
                        break;
                    }
                }

                // 如果不是别名路径，则相对于文件位置解析
                if (basePath === sourcePath) {
                    basePath = path.resolve(file.dirname as string, sourcePath);
                }

                // 尝试补全文件路径
                const tryExtensions = mergedOptions.extensions || [];

                for (const ext of tryExtensions) {
                    const fullPath = basePath + ext;
                    if (fs.existsSync(fullPath)) return fullPath;
                }

                throw new Error(
                    `❌ 无法解析路径 "${sourcePath}"，已尝试以下路径但均未找到：\n` +
                    tryExtensions.map(ext => `- ${basePath + ext}`).join('\n') +
                    `\n如果你修改了文件名或文件路径，请重新启动项目。`
                );
            };

            const absolutePath = resolveModulePath(importPath);
            const sourceCode = fs.readFileSync(absolutePath, 'utf8');
            const sourceAST = acornParse(sourceCode, {
                sourceType: 'module',
                ecmaVersion: 'latest',
            });

            let foundCode: string | null = null;

            acornWalk.simple(sourceAST, {
                VariableDeclaration(decl: any) {
                    for (const d of decl.declarations) {
                        if (
                            d.id.type === 'Identifier' &&
                            d.id.name === varName &&
                            d.init?.type === 'TemplateLiteral'
                        ) {
                            foundCode = d.init.quasis.map((q: any) => q.value.cooked).join('');
                        }
                    }
                },
            });

            if (!foundCode) {
                throw new Error(`在 ${absolutePath} 中未找到 export const ${varName}`);
            }

            // 确保 foundCode 是字符串类型
            const codeContent: string = foundCode;

            // 如果没有指定语言，则直接使用原始代码而不进行格式化
            if (!node.lang) {
                node.value = codeContent.trim();
            } else {
                // 创建一个异步处理格式化的Promise
                const formatPromise = (async () => {
                    try {
                        // 根据语言类型确定 parser 和格式化选项
                        const parser = getParserForLang(node.lang);
                        const prettierOptions = mergedOptions.prettierOptions || {};
                        const options = { ...prettierOptions, parser };

                        // 使用 Prettier 格式化代码，正确处理Promise
                        node.value = await prettier.format(codeContent.trim(), options);
                    } catch (error) {
                        console.warn(`格式化代码失败: ${(error as Error).message}. 使用原始代码.`);
                        node.value = codeContent.trim();
                    }
                })();

                // 将所有格式化任务收集起来
                promises.push(formatPromise);
            }

            node.meta = node.meta.replace(/code=\{[^}]+\}\s*/, '').trim();
        });

        // 等待所有格式化任务完成
        await Promise.all(promises);
    };
}

// 根据语言确定 Prettier parser
function getParserForLang(lang?: string): string {
    if (!lang) return 'babel';

    switch (lang.toLowerCase()) {
        case 'js':
        case 'jsx':
        case 'javascript':
            return 'babel';
        case 'ts':
        case 'tsx':
        case 'typescript':
            return 'typescript';
        case 'css':
            return 'css';
        case 'scss':
        case 'sass':
            return 'scss';
        case 'html':
        case 'xml':
        case 'svg':
            return 'html';
        case 'json':
            return 'json';
        case 'md':
        case 'markdown':
            return 'markdown';
        case 'yaml':
        case 'yml':
            return 'yaml';
        case 'graphql':
        case 'gql':
            return 'graphql';
        default:
            // 默认使用 babel 解析器
            return 'babel';
    }
}
