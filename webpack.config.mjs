import * as path from 'path'
import * as url from 'url'
import wp from 'webpack'
import { AngularWebpackPlugin } from '@ngtools/webpack'

const __dirname = url.fileURLToPath(new URL('.', import.meta.url))
const isDev = !!process.env.TABBY_DEV

export default {
    target: 'node',
    entry: './src/index.ts',
    context: __dirname,
    devtool: false,
    mode: isDev ? 'development' : 'production',
    optimization: {
        minimize: false,
    },
    output: {
        path: path.resolve(__dirname, 'dist'),
        filename: 'index.js',
        libraryTarget: 'umd',
        publicPath: 'auto',
    },
    resolve: {
        modules: ['src', 'node_modules'].map(x => path.join(__dirname, x)),
        extensions: ['.ts', '.js'],
        // The Kubernetes client is bundled into dist; its dependencies' "browser" entry points (isomorphic-ws
        // would hand over the browser WebSocket) can't do client certificates. Resolve the Node.js builds instead.
        mainFields: ['module', 'main'],
    },
    module: {
        rules: [
            { test: /\.ts$/, use: ['@ngtools/webpack'] },
            // Its index re-exports the generated clients of every API; let the unused ones be dropped
            { test: /[\\/]@kubernetes[\\/]client-node[\\/]/, sideEffects: false },
            // See shims/nodeRuntimeLoader.cjs
            {
                test: /[\\/]node_modules[\\/](socks|@kubernetes[\\/]client-node)[\\/].*\.js$/,
                use: [path.resolve(__dirname, 'shims/nodeRuntimeLoader.cjs')],
            },
            { test: /\.pug$/, use: ['apply-loader', { loader: 'pug-loader', options: { pretty: true } }] },
            { test: /\.scss$/, use: ['@tabby-gang/to-string-loader', 'css-loader', { loader: 'sass-loader', options: { api: 'modern' } }] },
        ],
    },
    // Provided by Tabby at runtime
    externals: [
        'keytar',
        'ngx-toastr',
        /^@angular/,
        /^@ng-bootstrap/,
        /^@ngx-translate/,
        /^rxjs/,
        /^tabby-/,
    ],
    plugins: [
        // Optional native speedups of ws: it falls back to JavaScript when requiring them throws
        new wp.IgnorePlugin({ resourceRegExp: /^(bufferutil|utf-8-validate)$/ }),
        new wp.SourceMapDevToolPlugin({
            filename: '[file].map',
            moduleFilenameTemplate: 'webpack-tabby-kube:///[resource-path]',
        }),
        new AngularWebpackPlugin({
            tsconfig: path.resolve(__dirname, 'tsconfig.json'),
            directTemplateLoading: false,
            jitMode: true,
        }),
    ],
}
