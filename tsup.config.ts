import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { index: 'src/index.ts', react: 'src/react.tsx', 'telescope/index': 'src/telescope/index.ts', 'docstore/index': 'src/docstore/index.ts', 'messaging/index': 'src/messaging/index.ts', 'push-auth/index': 'src/push-auth/index.ts' },
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  sourcemap: true,
  treeshake: true,
  external: ['react', 'socket.io-client'],
});
