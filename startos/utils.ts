// One Chama client per entry. Each gets its own nginx server block (uiPort)
// and its own chama-fedimint-bridge process on loopback (bridgePort) writing
// to its own wallet directory under /data — startos/nginx.conf and
// startos/entrypoint.sh derive the same three from these numbers.
export const clients = [
  { id: 'client-one', name: 'Client One', uiPort: 8080, bridgePort: 8787 },
  { id: 'client-two', name: 'Client Two', uiPort: 8081, bridgePort: 8788 },
  { id: 'client-three', name: 'Client Three', uiPort: 8082, bridgePort: 8789 },
] as const
