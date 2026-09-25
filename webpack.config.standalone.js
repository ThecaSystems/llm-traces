// Standalone webpack config — no Grafana monorepo needed.
// Used by `npm run build:standalone` and the production Docker image.
const path = require('path');
const CopyWebpackPlugin = require('copy-webpack-plugin');

module.exports = (env = {}) => ({
  mode: env.production ? 'production' : 'development',
  devtool: env.production ? false : 'source-map',

  entry: { module: './module.tsx' },

  output: {
    clean: true,
    filename: '[name].js',
    path: path.resolve(__dirname, 'dist'),
    libraryTarget: 'amd',
    publicPath: 'public/plugins/llm-traces-app/',
  },

  // These are provided by Grafana at runtime via AMD — do NOT bundle them.
  externals: [
    'lodash',
    'react',
    'react-dom',
    '@emotion/css',
    '@grafana/data',
    '@grafana/runtime',
    '@grafana/ui',
    '@grafana/scenes',
    /^@grafana\/.*/,
    /^rxjs(\/.+)?$/,
  ],

  module: {
    rules: [
      {
        test: /\.[tj]sx?$/,
        exclude: /node_modules/,
        use: {
          loader: 'ts-loader',
          options: {
            // Skip type checking for speed; run `npm run typecheck` separately.
            transpileOnly: true,
            // Use standalone tsconfig that doesn't extend from the Grafana monorepo root.
            configFile: 'tsconfig.standalone.json',
          },
        },
      },
    ],
  },

  resolve: {
    extensions: ['.ts', '.tsx', '.js', '.jsx'],
  },

  plugins: [
    new CopyWebpackPlugin({
      patterns: [
        { from: 'plugin.json', to: '.' },
        { from: 'logo.svg', to: '.', noErrorOnMissing: true },
        { from: 'src/img', to: 'img', noErrorOnMissing: true },
        { from: 'CHANGELOG.md', to: '.', noErrorOnMissing: true },
        { from: 'LICENSE', to: '.', noErrorOnMissing: true },
        { from: 'NOTICE', to: '.', noErrorOnMissing: true },
      ],
    }),
  ],
});
