// Stub do PWA para o build de demonstração (sem service worker).
export function registerSW(_opts?: unknown): () => Promise<void> {
  void _opts
  return async () => {}
}
