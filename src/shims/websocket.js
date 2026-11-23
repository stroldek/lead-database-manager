// GramJS imports the Node "websocket" package. Cloudflare Workers already provide a standard WebSocket client,
// so wrangler.jsonc aliases that package to this tiny shim.
export const w3cwebsocket = globalThis.WebSocket;
export default { w3cwebsocket: globalThis.WebSocket };
