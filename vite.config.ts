import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Local: base "/"
// GitHub Pages: VITE_BASE=/Month-End-Clearing/ (set in deploy workflow)
export default defineConfig({
  base: process.env.VITE_BASE || '/',
  plugins: [react()],
  server: { port: 5174 },
});
