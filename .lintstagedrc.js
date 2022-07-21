const path = require('path');

const buildEslintCommand = (filenames) =>
  `npm run lint:fix --max-warnings=0 --file ${filenames.map((f) => path.relative(process.cwd(), f)).join(' --file ')}`;

module.exports = {
  'src/**/*.{js,jsx,ts,tsx}': [buildEslintCommand],
  '*.{json,css,scss,md}': ['npm run prettify'],
};
