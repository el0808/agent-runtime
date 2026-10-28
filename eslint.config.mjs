import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["**/dist/**", "**/node_modules/**", "coverage/**", "**/renderer/models/**", "**/live2d-bundle.js"]
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.ts"],
    rules: {
      "@typescript-eslint/consistent-type-imports": "error"
    }
  },
  {
    // Node globals for sources and scripts.
    files: ["**/*.ts", "**/*.mjs"],
    languageOptions: {
      globals: {
        process: "readonly",
        console: "readonly",
        Buffer: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        setInterval: "readonly",
        clearInterval: "readonly",
        fetch: "readonly",
        URL: "readonly",
        URLSearchParams: "readonly",
        performance: "readonly",
        TextDecoder: "readonly",
        ReadableStream: "readonly"
      }
    }
  },
  {
    // Browser renderers run outside the Node environment.
    files: ["**/renderer/**/*.js"],
    languageOptions: {
      globals: {
        document: "readonly",
        window: "readonly",
        location: "readonly",
        fetch: "readonly",
        URL: "readonly",
        URLSearchParams: "readonly",
        EventSource: "readonly",
        requestAnimationFrame: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        setInterval: "readonly",
        clearInterval: "readonly",
        console: "readonly"
      }
    }
  }
);
