import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { viteSingleFile } from 'vite-plugin-singlefile';

// base:'./' + singlefile：产物是一个自包含的 HTML，双击就能打开（file:// 协议下也能跑），
// 这是为了保住你现在的使用方式——不需要起服务器，也能直接把文件发给别人。
export default defineConfig({
  base: './',
  plugins: [react(), viteSingleFile()],
  build: {
    outDir: 'dist',
    // 把所有资源内联进 HTML，不产出任何独立的 js/css 文件
    assetsInlineLimit: 100000000,
    cssCodeSplit: false,
    chunkSizeWarningLimit: 5000,
  },
});
