// StartOS exposes one ordinary Chama app. Keep the original Client One ids,
// ports and wallet directory stable across the 6.0.x → 6.1.0 topology change:
// changing any of them would create a new browser origin or orphan the primary
// native wallet. startos/nginx.conf and startos/entrypoint.sh hardcode the same
// ports because those files cannot import this TypeScript value.
export const clients = [
  { id: 'client-one', name: 'Chama', uiPort: 8080, bridgePort: 8787 },
] as const
