import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/executors/__tests__/*.test.ts"],
    exclude: ["src/executors/__tests__/parse-swarm-json.test.ts"],
    environment: "node",
  },
});
