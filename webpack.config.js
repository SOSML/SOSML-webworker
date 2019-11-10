var path = require('path');

module.exports = {
    entry: './src/worker.ts',
    output: {
        filename: 'webworker.js',
        path: path.resolve(__dirname, 'build')
    },
    mode: 'development',
    module: {
        rules: [
            {
                test: /\.tsx?$/,
                loader: 'ts-loader',
                exclude: /node_modules/,
            }
        ]
    },
    resolve: {
        extensions: [".tsx", ".ts", ".js"]
    }
};
