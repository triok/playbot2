import path from 'path';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
    const env = loadEnv(mode, '.', '');
    return {
      server: {
        port: 14882,
        host: '0.0.0.0',

        // 🔥 Вот это надо добавить!
        proxy: {
          '/api': {
            target: 'http://192.168.1.168:3001',
            changeOrigin: true,
            secure: false,
          }
        }
      },

      plugins: [react()],

      define: {
        'process.env.API_KEY': JSON.stringify(env.GEMINI_API_KEY),
        'process.env.GEMINI_API_KEY': JSON.stringify(env.GEMINI_API_KEY)
      },

      resolve: {
        alias: {
          '@': path.resolve(__dirname, '.'),
        }
      }
    };
});
