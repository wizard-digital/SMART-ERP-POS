import { fileURLToPath, URL } from 'node:url';

import { defineConfig } from 'vite';
import plugin from '@vitejs/plugin-react';
import fs from 'fs';
import path from 'path';
import child_process from 'child_process';
import { env } from 'process';
import { resilientApiProxyPlugin } from './vite.resilientApiProxy';

/** Chrome 62 parses the whole bundle. A leftover import() call is a syntax error even when unused. */
function sunmiStripDynamicImport() {
    return {
        name: 'sunmi-strip-dynamic-import',
        apply: 'build' as const,
        renderChunk(code: string) {
            if (!code.includes('import(')) return null;
            const next = code.replace(/\bimport\(/g, '__sunmiNoImport(');
            return {
                code: `function __sunmiNoImport(){return Promise.reject(new Error("dynamic import is not available"));}\n${next}`,
                map: null,
            };
        },
    };
}


const baseFolder =
    env.APPDATA !== undefined && env.APPDATA !== ''
        ? `${env.APPDATA}/ASP.NET/https`
        : `${env.HOME}/.aspnet/https`;

const certificateName = "samplepos.client";
const certFilePath = path.join(baseFolder, `${certificateName}.pem`);
const keyFilePath = path.join(baseFolder, `${certificateName}.key`);

// Only attempt certificate creation in development (not in Docker/CI)
if (env.NODE_ENV !== 'production') {
    if (!fs.existsSync(baseFolder)) {
        fs.mkdirSync(baseFolder, { recursive: true });
    }

    if (!fs.existsSync(certFilePath) || !fs.existsSync(keyFilePath)) {
        if (0 !== child_process.spawnSync('dotnet', [
            'dev-certs',
            'https',
            '--export-path',
            certFilePath,
            '--format',
            'Pem',
            '--no-password',
        ], { stdio: 'inherit', }).status) {
            throw new Error("Could not create certificate.");
        }
    }
}

const target = env.ASPNETCORE_HTTPS_PORT ? `https://localhost:${env.ASPNETCORE_HTTPS_PORT}` :
    env.ASPNETCORE_URLS ? env.ASPNETCORE_URLS.split(';')[0] : 'https://localhost:7040';

// https://vitejs.dev/config/
export default defineConfig({
    plugins: [
        plugin(),
        resilientApiProxyPlugin(),
        ...(env.SMART_ERP_LEGACY === '1' ? [sunmiStripDynamicImport()] : []),
    ],
    base: '/', // Absolute path so assets resolve from root on all routes
    resolve: {
        alias: {
            '@': fileURLToPath(new URL('./src', import.meta.url)),
            '@shared': fileURLToPath(new URL('../shared', import.meta.url)),
            // Ensure modules imported from shared can resolve to this app's node_modules
            'decimal.js': fileURLToPath(new URL('./node_modules/decimal.js', import.meta.url))
        }
    },
    build: env.SMART_ERP_LEGACY === '1'
        ? {
            rollupOptions: {
                output: {
                    // import() arrived in Chrome 63. One file keeps the old WebView script valid.
                    inlineDynamicImports: true,
                }
            },
            chunkSizeWarningLimit: 6000,
            target: 'chrome62',
            minify: 'esbuild',
        }
        : {
            rollupOptions: {
                output: {
                    manualChunks: {
                        'vendor': ['react', 'react-dom'],
                        'ui': [
                            '@radix-ui/react-dialog',
                            '@radix-ui/react-select',
                            '@radix-ui/react-tabs',
                            '@radix-ui/react-label',
                            '@radix-ui/react-slot',
                            '@radix-ui/react-checkbox',
                            '@radix-ui/react-popover',
                            '@radix-ui/react-switch',
                            '@radix-ui/react-tooltip',
                            '@radix-ui/react-alert-dialog',
                            '@radix-ui/react-radio-group',
                            '@radix-ui/react-scroll-area',
                            '@radix-ui/react-separator',
                            '@radix-ui/react-toggle',
                            '@radix-ui/react-navigation-menu',
                            '@radix-ui/react-visually-hidden',
                            '@radix-ui/react-aspect-ratio',
                            'lucide-react'
                        ],
                        'router': ['react-router-dom'],
                        'charts': ['chart.js', 'react-chartjs-2'],
                        'forms': ['react-hook-form', '@hookform/resolvers', 'zod'],
                        'query': ['@tanstack/react-query', 'axios', 'zustand'],
                        'utils': ['framer-motion', 'date-fns', 'decimal.js', 'clsx', 'tailwind-merge', 'class-variance-authority']
                    }
                }
            },
            // Chrome 80 has optional chaining, nullish, import(), and import.meta.
            // Newer engines run this script. Older ones receive the Chrome 62 build.
            chunkSizeWarningLimit: 2000,
            target: 'chrome80',
            minify: 'esbuild',
        },
    server: {
        proxy: {
            '^/weatherforecast': {
                target,
                secure: false
            },
            // /api is handled by resilientApiProxyPlugin (retries + JSON 503 while
            // the Node server restarts). Do not add a second Vite proxy for /api.
        },
        host: '127.0.0.1',  // Use IPv4 to avoid dual-stack issues
        port: 5173,
        strictPort: false,
        hmr: {
            overlay: true
        }
    }
})
