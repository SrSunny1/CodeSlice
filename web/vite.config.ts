import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    watch: {
      // WSL 挂载 Windows 盘时 inotify 不生效，必须轮询
      usePolling: true,
      interval: 300,
    },
    proxy: {
      "/api": "http://localhost:3001",
    },
  },
});
