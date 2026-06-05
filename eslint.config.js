import tseslint from "typescript-eslint";

export default tseslint.config({
  files: ["src/**/*.ts", "tests/**/*.ts"],
  extends: [tseslint.configs.base],
  languageOptions: {
    parserOptions: {
      projectService: true,
      tsconfigRootDir: import.meta.dirname,
    },
  },
  rules: {
    "@typescript-eslint/no-floating-promises": "error",
    "@typescript-eslint/switch-exhaustiveness-check": "error",
  },
});
