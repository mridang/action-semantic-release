/**
 * @file Knip configuration that lists the semantic-release dependencies it must not flag as unused.
 */
export default {
  ignoreDependencies: [/^@semantic-release\//u, 'semantic-release-major-tag'],
};
