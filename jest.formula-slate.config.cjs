const base = require('./jest.config.cjs');
const slateTest = '<rootDir>/src/components/database/components/property/formula/__tests__/formula-slate.test.ts';

/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  ...base,
  testMatch: [slateTest],
  testPathIgnorePatterns: base.testPathIgnorePatterns.filter((pattern) => pattern !== slateTest),
  coverageDirectory: '<rootDir>/coverage/jest/formula-slate',
  // Load the actual public SDK entry without changing the other suites to ESM.
  extensionsToTreatAsEsm: ['.ts', '.tsx'],
  transform: {
    ...base.transform,
    '^.+\\.(j|t)sx?$': ['ts-jest', {
      useESM: true,
      tsconfig: {
        module: 'ESNext',
        esModuleInterop: true,
        allowSyntheticDefaultImports: true,
      },
    }],
  },
};
