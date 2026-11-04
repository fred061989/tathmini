// Single serverless entry point; vercel.json rewrites /api/* here.

const { createRouter } = require('../lib/http');

module.exports = createRouter([
  ...require('../lib/routes/setup').routes,
  ...require('../lib/routes/curriculum').routes,
  ...require('../lib/routes/assessments').routes,
  ...require('../lib/routes/reports').routes,
  ...require('../lib/routes/google').routes,
  ...require('../lib/routes/billing').routes,
]);
