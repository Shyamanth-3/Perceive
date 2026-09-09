/** @type {import('jest').Config} */
module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  roots: ["<rootDir>/tests"],
  testMatch: ["**/*.test.ts"],
  moduleFileExtensions: ["ts", "js"],
  transform: {
    // Dev 2's vendored files (src/dev2-vendor/*.js) are real ES modules
    // (`export function ...`) — without allowJs + this pattern covering
    // .js too, Jest would try to `require()` them as plain CommonJS and
    // fail with "Unexpected token 'export'". They're transpiled by the
    // same ts-jest/TypeScript pipeline as everything else, unmodified.
    "^.+\\.[tj]s$": ["ts-jest", { tsconfig: { module: "CommonJS", moduleResolution: "Node", allowJs: true } }]
  },
  clearMocks: true
};