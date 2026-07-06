export async function mcpCommand() {
  const { startMcpServer } = await import('../../mcp/server.js');
  await startMcpServer();
}
