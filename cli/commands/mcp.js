export async function mcpCommand(opts) {
  const { startMcpServer } = await import('../../mcp/server.js');
  await startMcpServer({ projectDir: opts?.project });
}
