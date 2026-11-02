import { defineConfig } from "vite";

export default defineConfig({
  // GitHub Pages ではリポジトリ名の下に置かれるので、相対パスで参照する
  base: "./",
  server: {
    fs: {
      // 見本のデータ（../data）と試しの結果（../experiments）を、リポジトリの外に写さずに読むため
      allow: [".."],
    },
  },
  test: {
    environment: "node",
  },
});
